import { PublicKey } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import log from 'loglevel'

import { useContract } from '../provider/ContractProvider'

export default (mint: string | undefined) => {
  const { contract } = useContract()

  const [hasInject, setHasInject] = useState(false)
  const [checkLoading, setCheckLoading] = useState(true)
  const [injectData, setInjectData] = useState<any | null>(null)

  useEffect(() => {
    ;(async () => {
      if (!mint) {
        return
      }
      setCheckLoading(true)
      const mintKey = new PublicKey(mint)
      //   const result = await contract.checkValidNFT(mintKey)
      const inject = await contract.getInjectV1(mintKey)
      log.info('checkHasInject', inject)

      if (!inject || !inject.childrenMetadata) {
        setHasInject(false)
        setCheckLoading(false)
        return
      }
      const { childrenMetadata, childrenMeta } = inject
      setHasInject(true)
      // setInjectMode(childrenMeta.reversible === true ? InjectMode.Reversible : InjectMode.Irreversible)
      log.info(`${mint} hasInject`, inject)
      // 只可能注入 sol
      if (childrenMeta?.childType.sol) {
        setInjectData({
          injectType: 'sol',
          lamports: childrenMetadata.lamports,
        })
      }
      setCheckLoading(false)
    })()
  }, [mint])

  return { hasInject, injectData, checkLoading }
}