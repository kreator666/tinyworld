import { FlagEmbedding, EmbeddingModel } from 'fastembed'

// ============================================================
// 本地向量嵌入:fastembed 在进程内跑 ONNX 模型,不依赖外部 API
// (aiping 网关没有 embeddings 接口,不能用远程嵌入)
// 选 bge-small-zh-v1.5:体积小(~48MB)、中文效果好;首次运行自动下载模型并缓存
// ============================================================

export const EMBEDDING_DIM = 512 // bge-small-zh-v1.5 输出维度,建表 vector(N) 与之对应

let modelPromise: Promise<FlagEmbedding> | null = null

function getModel(): Promise<FlagEmbedding> {
  if (!modelPromise) {
    modelPromise = FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH })
  }
  return modelPromise
}

/** 文本 → 512 维向量(模型懒加载,首次调用需等初始化) */
export async function embed(text: string): Promise<number[]> {
  const model = await getModel()
  const stream = model.embed([text])
  for await (const batch of stream) {
    return Array.from(batch[0])
  }
  throw new Error('fastembed 未返回嵌入结果')
}
