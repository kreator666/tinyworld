// 类型占位:与 @triton-one/yellowstone-grpc 公共签名对齐(仅供 @drift-labs/sdk 的 grpc 声明引用)
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
export default class Client {
  constructor(...args: unknown[])
  subscribe(): AsyncIterable<SubscribeUpdate>
  close(): void
}
