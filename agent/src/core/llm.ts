import { config } from '../config'

// 轻量 LLM 补全:记忆蒸馏、打招呼草稿等内部调用,不走 Mastra Agent(不带人格/工具)

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export async function complete(system: string, user: string, temperature = 0.7): Promise<string> {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
    }),
  })
  if (!res.ok) throw new Error(`LLM 网关错误: HTTP ${res.status}`)
  const data = (await res.json()) as ChatCompletionResponse
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}
