// 类型占位:与 helius-laserstream 公共签名对齐(仅供 @drift-labs/sdk 的 grpc 声明引用)
export interface LaserstreamConfig {
  endpoint?: string
  commitment?: string
  [key: string]: unknown
}
export interface SubscribeRequest {
  [key: string]: unknown
}
export interface SubscribeUpdate {
  [key: string]: unknown
}
export declare const CommitmentLevel: {
  PROCESSED: 0
  CONFIRMED: 1
  FINALIZED: 2
}
export declare const CompressionAlgorithms: {
  GZIP: 1
  ZLIB: 2
  NONE: 0
}
export declare function subscribe(config: LaserstreamConfig): AsyncIterable<SubscribeUpdate>
