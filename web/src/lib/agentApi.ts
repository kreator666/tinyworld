// Agent 运行时服务(agent/ 包)的对话接口
// base 可用 VITE_AGENT_API 覆盖,默认本地 dev 端口 4111

const AGENT_API = (import.meta.env.VITE_AGENT_API as string | undefined) ?? 'http://localhost:4111'

export interface AgentChatResult {
  reply: string
  tokenId: number
  refused: boolean // true = 人格开关拦截(emergency / autoReply=false)
}

/** 与自己的 Agent 对话;服务不可达时抛错,由调用方降级提示 */
export async function chatWithMyAgent(address: string, message: string): Promise<AgentChatResult> {
  const res = await fetch(`${AGENT_API}/agents/by-owner/${address}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const data = (await res.json().catch(() => null)) as (Partial<AgentChatResult> & { error?: string }) | null
  if (!res.ok) throw new Error(data?.error ?? `Agent 服务错误(${res.status})`)
  if (!data?.reply) throw new Error('Agent 服务返回格式异常')
  return data as AgentChatResult
}
