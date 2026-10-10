'use strict'
// win32 占位实现:helius-laserstream 仅发布 darwin/linux 二进制,本仓库的 Drift 集成
// 只用 websocket/轮询订阅,从不加载 grpc/laserstream 路径;此处导出仅供 SDK 按需 require。
const NOT_SUPPORTED = 'helius-laserstream is stubbed on win32 (not used by this integration)'
function subscribe() {
  throw new Error(NOT_SUPPORTED)
}
const CommitmentLevel = { PROCESSED: 0, CONFIRMED: 1, FINALIZED: 2 }
const CompressionAlgorithms = { GZIP: 1, ZLIB: 2, NONE: 0 }
module.exports = { subscribe, CommitmentLevel, CompressionAlgorithms }
