/* eslint-disable lines-between-class-members */
/* eslint-disable no-underscore-dangle */

import { PublicKey, Connection, AccountInfo, SystemProgram, Transaction } from '@solana/web3.js'
import { Metadata } from '@metaplex-foundation/mpl-token-metadata'
import { BN, Program, Provider, web3 } from '@project-serum/anchor'
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token'
import { WalletContextState } from '@solana/wallet-adapter-react'
import axios from 'axios'
import log from 'loglevel'

import idl, { Synft } from './v2'
import type { Node, MetaInfo, BelongTo, ChildMeta, InjectInfoV1 } from './v2/types'

const PROGRAM_ID = new PublicKey(idl.metadata.address)
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const MPL_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

// eslint-disable-next-line no-shadow
enum SynftSeed {
  SOL = 'sol-seed',
  CHILDREN_OF = 'children-of',
  METADATA = 'metadata',
  ACCOUNT_SEED = 'synthetic-nft-account-seed',
  MINT_SEED = 'synthetic-nft-mint-seed',
}

const PARENT_OFFSET = 40 // 8(anchor) + 32(pubkey)
const CHILD_OFFSET = 8 // 8(anchor)

export default class Contract {
  private static _instance: Contract = new Contract()

  private _wallet: WalletContextState | null = null
  private _connection: Connection | null = null
  private _program: Program<Synft> | null = null

  constructor() {
    if (Contract._instance) {
      throw new Error('Error: Instantiation failed: Use SingletonClass.getInstance() instead of new.')
    }
    Contract._instance = this
  }

  public static getInstance(): Contract {
    return Contract._instance
  }

  private initProgram(connection: Connection) {
    log.info('Contract initProgram')
    const provider = new Provider(connection, (window as any).solana, Provider.defaultOptions())
    const program = new Program(idl as any, PROGRAM_ID, provider) as Program<Synft>
    this._program = program
  }

  public setWallet(wallet: WalletContextState) {
    this._wallet = wallet
  }

  public setConnection(conn: Connection) {
    this._connection = conn
    this.initProgram(conn)
  }

  /**
   * 检查 mint 是不是一个有效的 NFT
   * @param mintKey
   * @returns
   */
  public async checkValidNFT(mintKey: PublicKey): Promise<boolean> {
    log.info('checkValidNFT')

    if (!this._connection) {
      log.error('Contract connect invalid')
      return false
    }
    try {
      // 获取有效的 tokenAccount
      const tokenAccountBalancePair = await this._connection.getTokenLargestAccounts(mintKey)
      // 满足该条件，才是有效的 NFT
      const valid = tokenAccountBalancePair.value[0].uiAmount === 1 && tokenAccountBalancePair.value[0].decimals === 0
      return valid
    } catch (error) {
      log.warn('checkValidNFT', error)
      return false
    }
  }

  /**
   * 检查 mint 的所属关系
   * @param mintKey
   * @returns
   */
  public async checkBelongTo(mintKey: PublicKey): Promise<BelongTo> {
    log.info('checkBelongTo')

    const result: BelongTo = { me: false, program: false, parent: null }
    if (!this._connection) {
      log.error('Contract connect invalid')
      return result
    }
    const program = this._program
    if (!program) return result
    try {
      // 获取有效的 tokenAccount
      let tokenAccountBalancePair = await this._connection.getTokenLargestAccounts(mintKey)
      let lastTokenAccountBalancePair = tokenAccountBalancePair.value[0]
      if (lastTokenAccountBalancePair.uiAmount !== 1) return result

      let rootMintKey = lastTokenAccountBalancePair.address
      const parentNFT = await this.getParentNFT(mintKey)
      if (parentNFT) {
        const { rootPDA } = parentNFT
        const rootMeta = await program.account.childrenMetadataV2.fetch(rootPDA)
        rootMintKey = rootMeta.parent
        result.parent = { ...parentNFT, rootMint: rootMintKey.toString() }

        tokenAccountBalancePair = await this._connection.getTokenLargestAccounts(rootMintKey)
        // eslint-disable-next-line prefer-destructuring
        lastTokenAccountBalancePair = tokenAccountBalancePair.value[0]
      }

      const mintTokenAccount = await getAccount(this._connection, lastTokenAccountBalancePair.address)
      const belongToSelf = mintTokenAccount.owner.toString() === this._wallet?.publicKey?.toString()
      result.me = belongToSelf

      if (!result.me) {
        const [nftMintPDA, nftMintBump] = await PublicKey.findProgramAddress(
          [Buffer.from(SynftSeed.MINT_SEED), mintKey.toBuffer()],
          PROGRAM_ID,
        )
        const accountAndCtx: AccountInfo<Buffer> | null = await this._connection.getAccountInfo(nftMintPDA)
        result.program = !!accountAndCtx
      }
      return result
    } catch (error) {
      log.warn(error, { mintKey: mintKey.toString() })
      return result
    }
  }

  /**
   * 获取 mint 的上注入的 nft-tree
   * @param mintKey
   * @param withParent 是否获取 parent，默认值 true，只在初始调用为 true，
   * @returns
   */
  public async getInjectTree(mintKey: PublicKey, withParent: boolean = true): Promise<any | null> {
    if (!this._connection || !this._program) {
      log.error('Contract connect invalid')
      return null
    }
    const treeObj: Node = {
      curr: {
        mint: mintKey.toString(),
        sol: null,
        children: [],
      },
      parent: null,
    }
    try {
      const [solPDA] = await PublicKey.findProgramAddress([Buffer.from(SynftSeed.SOL), mintKey.toBuffer()], PROGRAM_ID)
      const solChildrenMetadata = await this._connection.getAccountInfo(solPDA)
      // log.info('inject solChildrenMetadata', solChildrenMetadata)
      if (solChildrenMetadata) {
        treeObj.curr.sol = {
          lamports: solChildrenMetadata.lamports,
          // owner: solChildrenMetadata.owner.toString(),
        }
      }

      // 只需要第一次的时候获取 parent
      if (withParent) {
        const parentNFT = await this.getParentNFT(mintKey)
        // if parentNFT 证明当前是个子节点，有父节点
        if (parentNFT) {
          treeObj.parent = parentNFT
        }
      }

      const filter = [
        {
          memcmp: {
            offset: PARENT_OFFSET,
            bytes: mintKey.toBase58(),
          },
        },
      ]

      const childrenNFT = await this._program.account.childrenMetadataV2.all(filter)
      const children = await Promise.all(
        childrenNFT.map(async (item) => {
          const childMint = item.account.child
          const tree = await this.getInjectTree(childMint, false)
          return tree
        }),
      )
      treeObj.curr.children = children
      return treeObj
    } catch (error) {
      log.warn(error)
      return null
    }
  }

  /**
   * 获取 mint 的 parent，由我们合约提供
   * @param mintKey
   * @returns
   */
  private async getParentNFT(mintKey: PublicKey) {
    if (!this._program) {
      log.error('Contract connect invalid')
      return null
    }
    const parentNFT = await this._program.account.childrenMetadataV2.all([
      {
        memcmp: {
          offset: CHILD_OFFSET,
          bytes: mintKey.toBase58(),
        },
      },
    ])

    if (parentNFT && parentNFT[0]) {
      return {
        mint: parentNFT[0].account.parent.toString(),
        rootPDA: parentNFT[0].account.root.toString(),
      }
    }
    return null
  }

  /**
   * 获取用户有效的 NFT
   * @param owner
   * @returns
   */
  public async getValidNFTokensWithOwner(owner: PublicKey) {
    if (!this._connection) {
      return []
    }
    const tokens = await this._connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    })

    // initial filter - only tokens with 0 decimals & of which 1 is present in the wallet
    const filteredToken = tokens.value
      .filter((t) => {
        const amount = t.account.data.parsed.info.tokenAmount
        return amount.decimals === 0 && amount.uiAmount === 1
      })
      .map((t) => ({
        address: new PublicKey(t.pubkey),
        mint: new PublicKey(t.account.data.parsed.info.mint),
      }))
    return filteredToken
  }

  /**
   * 获取 metaplex 的 metadata
   * @param mintKey
   * @returns
   */
  public async getMetadataFromMint(mintKey: PublicKey) {
    if (!this._connection) {
      log.error('Contract connect invalid')
      return null
    }
    const pubkey = await Metadata.getPDA(mintKey)
    const metadata = await Metadata.load(this._connection, pubkey)
    return metadata
  }

  /**
   * 获取 metadata 信息
   * @param mintKey
   * @returns
   */
  public async getMetadataInfoWithMint(mintKey: PublicKey): Promise<MetaInfo | null> {
    if (!this._connection || !this._program) {
      log.error('Contract connect invalid')
      return null
    }
    try {
      const tmp = await this.getMetadataFromMint(mintKey)
      if (!tmp) return null
      const metadata = tmp.data
      const externalMetadata = (await axios.get(metadata.data.uri)).data
      return {
        mint: mintKey,
        metadata,
        externalMetadata,
      }
    } catch (error) {
      return null
    }
  }

  /**
   * 给 NFT 注入 sol
   * @param mintKey
   * @param solAmount
   * @returns
   */
  public async injectSOL(mintKey: PublicKey, solAmount: number): Promise<void> {
    log.info('injectSOL')
    if (!this._connection || !this._program || !this._wallet?.publicKey) {
      log.error('Contract connect invalid')
      return
    }
    const injectSolAmount = new BN(solAmount)
    const mintTokenAccount = await this._connection.getTokenLargestAccounts(mintKey)
    const mintTokenAccountAddress = mintTokenAccount.value[0].address

    const [solPDA, solBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.SOL), mintKey.toBuffer()],
      PROGRAM_ID,
    )
    const initTx = await this._program.transaction.injectToSolV2(solBump, injectSolAmount, {
      accounts: {
        currentOwner: this._wallet.publicKey,
        parentTokenAccount: mintTokenAccountAddress,
        parentMintAccount: mintKey,
        solAccount: solPDA,
        systemProgram: SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [],
    })
    const signature = await this._wallet.sendTransaction(initTx, this._connection)
    const result = await this._connection.confirmTransaction(signature, 'processed')
    // { "context": { "slot": 121298588 }, "value": { "err": null} }
    log.info('injectSol result', result)
  }

  /**
   * 将一个 NFT 注入到另一个 NFT
   * @param rootMintKey 被注入的 NFT
   * @param children 注入的 NFT，数组。协议支持一下子注入多个
   * @returns
   */
  public async injectNFTToRoot(rootMintKey: PublicKey, children: PublicKey[]) {
    log.info('injectNFTToRoot: ', rootMintKey.toString())
    if (!this._connection || !this._program || !this._wallet?.publicKey) {
      log.error('Contract connect invalid')
      return
    }
    if (children.length === 0) {
      return
    }
    const program = this._program
    const walletPubKey = this._wallet.publicKey
    const connection = this._connection

    const parentMintTokenAccounts = await connection.getTokenLargestAccounts(rootMintKey)
    const parentMintTokenAccountAddr = parentMintTokenAccounts.value[0].address

    const instructions = children.map(async (item) => {
      const [metadataPDA, metadataBump] = await PublicKey.findProgramAddress(
        [Buffer.from(SynftSeed.CHILDREN_OF), rootMintKey.toBuffer(), item.toBuffer()],
        PROGRAM_ID,
      )

      // 获取 NFT 有效的 tokenAccount
      const childMintTokenAccounts = await connection.getTokenLargestAccounts(item)
      const childMintTokenAccountsAddr = childMintTokenAccounts.value[0].address

      const instruction = await program.instruction.injectToRootV2(true, metadataBump, {
        accounts: {
          currentOwner: walletPubKey,
          childTokenAccount: childMintTokenAccountsAddr,
          childMintAccount: item,
          parentTokenAccount: parentMintTokenAccountAddr,
          parentMintAccount: rootMintKey,
          childrenMeta: metadataPDA,

          systemProgram: SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [],
      })
      return instruction
    })
    const instructionTx = await Promise.all(instructions)

    const tx = new Transaction().add(...instructionTx)
    const signature = await this._wallet.sendTransaction(tx, connection)
    const result = await connection.confirmTransaction(signature, 'processed')
    log.info('injectNFTToRoot result', result)
  }

  /**
   * 将 children NFT 注入到 mint NFT
   * @param mintKey 被注入的 NFT 的 mint
   * @param childrenMint 注入的 NFT，数组。协议支持一下注入多个
   * @param { parentMintKey, rootPDA } 注入非 root NFT需要提供被注入的 root 信息
   * @returns
   */
  public async injectNFTToNonRoot(
    mintKey: PublicKey, // mint4
    childrenMint: PublicKey[], // mint5
    {
      parentMintKey, // mint3
      rootPDA,
    }: {
      parentMintKey: PublicKey
      rootPDA: PublicKey
    },
  ) {
    log.info('injectNFTToNonRoot: ', {
      mintKey: mintKey.toString(),
      parentMintKey: parentMintKey.toString(),
    })
    if (!this._connection || !this._program || !this._wallet?.publicKey) {
      log.error('Contract connect invalid')
      return
    }
    if (childrenMint.length === 0) {
      return
    }
    const program = this._program
    const walletPubKey = this._wallet.publicKey
    const connection = this._connection

    const rootMeta = await program.account.childrenMetadataV2.fetch(rootPDA)
    const rootMintKey = rootMeta.parent
    const rootMintTokenAccounts = await connection.getTokenLargestAccounts(rootMintKey)
    const rootMintTokenAccountAddr = rootMintTokenAccounts.value[0].address

    const [rootMetadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.CHILDREN_OF), rootMintKey.toBuffer(), mintKey.toBuffer()],
      PROGRAM_ID,
    )
    log.info({ rootMint: rootMintKey.toString(), rootMetadataPDA: rootMetadataPDA.toString() })

    // const parentMintTokenAccounts = await connection.getTokenLargestAccounts(parentMintKey)
    // const parentMintTokenAccountAddr = parentMintTokenAccounts.value[0].address
    const [parentMetadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.CHILDREN_OF), parentMintKey.toBuffer(), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const mintTokenAccounts = await connection.getTokenLargestAccounts(mintKey)
    const mintTokenAccountAddr = mintTokenAccounts.value[0].address

    const instructions = childrenMint.map(async (item) => {
      const [childMetadataPDA, childMetadataBump] = await PublicKey.findProgramAddress(
        [Buffer.from(SynftSeed.CHILDREN_OF), mintKey.toBuffer(), item.toBuffer()],
        PROGRAM_ID,
      )

      const childMintTokenAccounts = await connection.getTokenLargestAccounts(item)
      const childMintTokenAccountAddr = childMintTokenAccounts.value[0].address

      log.info('childMintTokenAccounts', childMintTokenAccounts, childMintTokenAccountAddr)
      log.info({
        currentOwner: walletPubKey.toString(),
        childTokenAccount: childMintTokenAccountAddr.toString(),
        childMintAccount: item.toString(),
        parentTokenAccount: mintTokenAccountAddr.toString(),
        parentMintAccount: mintKey.toString(),
        rootTokenAccount: rootMintTokenAccountAddr.toString(),
        rootMintAccount: rootMintKey.toString(),
        childrenMeta: childMetadataPDA.toString(),
        parentMeta: parentMetadataPDA.toString(),
        rootMeta: rootPDA.toString(),
      })

      const instruction = await program.instruction.injectToNonRootV2(true, false, childMetadataBump, {
        accounts: {
          currentOwner: walletPubKey,
          childTokenAccount: childMintTokenAccountAddr,
          childMintAccount: item,
          parentTokenAccount: mintTokenAccountAddr,
          parentMintAccount: mintKey,
          rootTokenAccount: rootMintTokenAccountAddr,
          rootMintAccount: rootMintKey,
          childrenMeta: childMetadataPDA,
          parentMeta: parentMetadataPDA,
          rootMeta: rootPDA,

          systemProgram: SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [],
      })
      return instruction
    })
    const instructionTx = await Promise.all(instructions)
    const tx = new Transaction().add(...instructionTx)
    const signature = await this._wallet.sendTransaction(tx, connection)
    const result = await connection.confirmTransaction(signature, 'processed')
    log.info('injectNFTToNonRoot result', result)
  }

  /**
   * copy 出来一个新的 NFT
   * @param mintKey 被 copy 的 mint，被 copy 过不能再不被 copy
   * @param solAmount 将要注入的 sol 的数量，lamports 单位
   * @param { name, symbol, uri } 成 NFT 的要素
   * @returns
   */
  public async copyWithInjectSOL(
    mintKey: PublicKey,
    solAmount: number,
    { name, symbol, uri }: { name: string; symbol: string; uri: string },
  ): Promise<string> {
    log.info('copyWithInjectSOL')
    if (!this._connection || !this._program || !this._wallet?.publicKey) {
      log.error('Contract connect invalid')
      return ''
    }
    const program = this._program
    const walletPubKey = this._wallet.publicKey
    const connection = this._connection

    // 1. 使用 mint 进行 copy
    const [nftMintPDA, nftMintBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.MINT_SEED), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const [nftTokenAccountPDA, nftTokenAccountBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.ACCOUNT_SEED), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const [nftMetadataPDA, nftMetadataBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.METADATA), METADATA_PROGRAM_ID.toBuffer(), nftMintPDA.toBuffer()],
      METADATA_PROGRAM_ID,
    )

    const instructionCopy = program.instruction.nftCopy(...[name, symbol, uri], {
      accounts: {
        currentOwner: walletPubKey,
        fromNftMint: mintKey,
        nftMetaDataAccount: nftMetadataPDA,
        nftMintAccount: nftMintPDA,
        nftTokenAccount: nftTokenAccountPDA,
        systemProgram: SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        mplProgram: MPL_PROGRAM_ID,
      },
    })

    // 2. 使用 1 中的数据进行注入
    const injectSolAmount = new BN(solAmount)
    const [solPDA, solBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.SOL), nftMintPDA.toBuffer()],
      PROGRAM_ID,
    )

    const instructionInject = await this._program.transaction.injectToSolV2(solBump, injectSolAmount, {
      accounts: {
        currentOwner: this._wallet.publicKey,
        parentTokenAccount: nftTokenAccountPDA,
        parentMintAccount: nftMintPDA,
        solAccount: solPDA,
        systemProgram: SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [],
    })

    // 打包交易
    const tx = new Transaction().add(instructionCopy, instructionInject)

    const signature = await this._wallet.sendTransaction(tx, connection)
    const result = await connection.confirmTransaction(signature, 'processed')
    log.info('copyWithInjectSOL', result, {
      nftMintPDA: nftMintPDA.toString(),
      nftTokenAccountPDA: nftTokenAccountPDA.toString(),
    })

    return nftMintPDA.toString()
  }

  /**
   * 获取 mint 的 AccountInfo
   * @param mintKey
   * @returns
   */
  public async getMintAccountInfo(mintKey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    if (!this._connection) {
      log.error('Contract connect invalid')
      return null
    }
    const [nftMintPDA, nftMintBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.MINT_SEED), mintKey.toBuffer()],
      PROGRAM_ID,
    )
    const info = await this._connection.getAccountInfo(nftMintPDA)
    return info
  }

  // v1 --------------------------------------
  public async getInjectV1(mintKey: PublicKey): Promise<InjectInfoV1 | null> {
    if (!this._connection || !this._program) {
      log.error('Contract connect invalid')
      return null
    }
    try {
      const [metadataPDA, metadataBump] = await PublicKey.findProgramAddress(
        [Buffer.from('children-of'), mintKey.toBuffer()],
        PROGRAM_ID,
      )

      const childrenMetadata = await this._connection.getAccountInfo(metadataPDA)
      if (!childrenMetadata) {
        return null
      }
      let childrenMeta = null
      if (childrenMetadata) {
        childrenMeta = (await this._program.account.childrenMetadata.fetch(metadataPDA)) as ChildMeta
      }

      log.debug('getInject', { childrenMetadata, childrenMeta })

      return { childrenMetadata, childrenMeta }
    } catch (error) {
      log.warn(error)
      return null
    }
  }

  public async copyWithInjectSOLv1(
    mintKey: PublicKey,
    lamportAmount: number,
    { name, symbol, uri }: { name: string; symbol: string; uri: string },
  ): Promise<string> {
    log.info('copyWithInjectSOLv1')
    if (!this._connection || !this._program || !this._wallet?.publicKey) {
      log.error('Contract connect invalid')
      return ''
    }
    const program = this._program
    const walletPubKey = this._wallet.publicKey
    const connection = this._connection

    // 1. 使用 mint 进行 copy
    const [nftMintPDA, nftMintBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.MINT_SEED), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const [nftTokenAccountPDA, nftTokenAccountBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.ACCOUNT_SEED), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const [nftMetadataPDA, nftMetadataBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.METADATA), METADATA_PROGRAM_ID.toBuffer(), nftMintPDA.toBuffer()],
      METADATA_PROGRAM_ID,
    )

    const instructionCopy = program.instruction.nftCopy(...[name, symbol, uri], {
      accounts: {
        currentOwner: walletPubKey,
        fromNftMint: mintKey,
        nftMetaDataAccount: nftMetadataPDA,
        nftMintAccount: nftMintPDA,
        nftTokenAccount: nftTokenAccountPDA,
        systemProgram: SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        mplProgram: MPL_PROGRAM_ID,
      },
    })

    // 2. 使用 1 中的数据进行注入
    const injectAmount = new BN(lamportAmount)
    const [metadataPDA, metadataBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.CHILDREN_OF), nftMintPDA.toBuffer()],
      PROGRAM_ID,
    )

    const instructionInject = await this._program.transaction.initializeSolInject(
      ...[true, metadataBump, injectAmount],
      {
        accounts: {
          currentOwner: walletPubKey,
          parentTokenAccount: nftTokenAccountPDA,
          parentMintAccount: nftMintPDA,
          childrenMeta: metadataPDA,
          systemProgram: SystemProgram.programId,
          rent: web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [],
      },
    )

    const tx = new Transaction().add(instructionCopy, instructionInject)

    const signature = await this._wallet.sendTransaction(tx, connection)
    const result = await connection.confirmTransaction(signature, 'processed')
    log.info('copyWithInjectSOLv1', result, {
      nftMintPDA: nftMintPDA.toString(),
      nftTokenAccountPDA: nftTokenAccountPDA.toString(),
    })

    return nftMintPDA.toString()
  }

  public async extractSolV1(mintKey: PublicKey) {
    if (!this._connection || !this._wallet || !this._program) {
      log.error('Contract invalid')
      return
    }
    log.info('begin extractSol')

    const connection = this._connection
    const walletPubKey = this._wallet.publicKey
    const program = this._program

    if (!walletPubKey) {
      log.error('walletPubKey invalid: ', { walletPubKey })
      return
    }

    const mintTokenAccount = await connection.getTokenLargestAccounts(mintKey)
    const mintTokenAccountAddress = mintTokenAccount.value[0].address

    const [metadataPDA, metadataBump] = await PublicKey.findProgramAddress(
      [Buffer.from(SynftSeed.CHILDREN_OF), mintKey.toBuffer()],
      PROGRAM_ID,
    )

    const extractTx = await program.transaction.extractSol(metadataBump, {
      accounts: {
        currentOwner: walletPubKey,
        parentTokenAccount: mintTokenAccountAddress,
        parentMintAccount: mintKey,
        childrenMeta: metadataPDA,

        systemProgram: SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [],
    })
    const signature = await this._wallet.sendTransaction(extractTx, connection)
    const result = await connection.confirmTransaction(signature, 'processed')
    log.debug('extractSol result', result)
  }

  public async checkHasInjectV1(mintKey: PublicKey) {
    if (!this._connection) {
      log.error('Contract connect invalid')
      return null
    }
    const [metadataPDA, metadataBump] = await PublicKey.findProgramAddress(
      [Buffer.from('children-of'), mintKey.toBuffer()],
      PROGRAM_ID,
    )
    const hasInjected = await this._connection.getAccountInfo(metadataPDA)
    return !!hasInjected
  }
  // v1 end ----------------------------------
}
