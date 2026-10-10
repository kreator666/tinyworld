'use strict'
// win32 占位实现:yellowstone-grpc 的 napi 原生绑定只发布 darwin/linux,
// 本仓库的 Drift 集成只用 websocket/轮询订阅,从不加载 gRPC 路径;
// 此处导出仅供 SDK 的 isomorphic/grpc 在模块加载时 require。
const NOT_SUPPORTED = '@triton-one/yellowstone-grpc is stubbed on win32 (not used by this integration)'
class Client {
  constructor() {
    throw new Error(NOT_SUPPORTED)
  }
}
const CommitmentLevel = { PROCESSED: 0, CONFIRMED: 1, FINALIZED: 2 }
module.exports = { Client, CommitmentLevel, default: Client }
