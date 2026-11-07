import { config } from '../config'

// 轻量 LLM 补全:记忆蒸馏、打招呼草稿、竞技场决策 tick 等内部调用,不走 Mastra Agent(不带人格/工具)

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export interface CompleteOptions {
  model?: string // 覆盖默认模型(竞技场赛季固定模型 / 生存模式专用模型用)
  temperature?: number
  /** 覆盖默认网关地址(生存模式走独立 LLM 源);缺省回落 config.llmBaseUrl */
  baseUrl?: string
  /** 覆盖默认 API Key;缺省回落 config.llmApiKey */
  apiKey?: string
  /** 调用成功后回传实际 token 用量(竞技场燃料计费消费);抛错则向上传播,不允许静默跳过计费 */
  onUsage?: (usage: LlmUsage) => void | Promise<void>
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function complete(
  system: string,
  user: string,
  temperatureOrOptions: number | CompleteOptions = 0.7,
): Promise<string> {
  const opts: CompleteOptions = typeof temperatureOrOptions === 'number' ? { temperature: temperatureOrOptions } : temperatureOrOptions
  const baseUrl = opts.baseUrl ?? config.llmBaseUrl
  const apiKey = opts.apiKey ?? config.llmApiKey
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? config.llmModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature ?? 0.7,
    }),
  })
  if (!res.ok) throw new Error(`LLM 网关错误: HTTP ${res.status}`)
  const data = (await res.json()) as ChatCompletionResponse
  if (opts.onUsage) {
    await opts.onUsage({
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    })
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}
