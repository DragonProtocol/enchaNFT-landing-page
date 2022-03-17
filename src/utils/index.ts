import log from 'loglevel'

log.info({ env: process.env.NODE_ENV })

// TODO: 上生产接主网后改正
export const isProd = false // process.env.NODE_ENV === 'production'
export const logIsProd = process.env.NODE_ENV === 'production'

// explore 数据源
export const collections = isProd
  ? []
  : [
      'D6ZQMLTJAa14XhzCFBJ2uuPjYDbYfewrVDVSyFZSuBYe',
      '7YNKWyPW5iqu1QHqnQ5Csj9yWpEEnqAzLcuzudMMHqbk',
      'U1nbABQKyPmrrgsqAPiDG2yxwGCkSV9TYRLW8gCDaiA',
      'AhY7v1fSv4c7P9ouhkfWHDzv7okRNo2TUfwDxwxHZXfb',
    ]

export default {}
