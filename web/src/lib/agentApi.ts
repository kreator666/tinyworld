// Agent 运行时服务(agent/ 包)的对话接口
// base 可用 VITE_AGENT_API 覆盖,默认本地 dev 端口 4111

const AGENT_API = (import.meta.env.VITE_AGENT_API as string | undefined) ?? 'http://localhost:4111'

export interface AgentChatResult {
  reply: string
  tokenId: number
  refused: boolean // true = 人格开关拦截(emergency / autoReply=false)
  action?: SignTxAction
}

export interface UnsignedTx {
  to: string
  data: string
  value: string // wei
  chainId: number
  description: string
}

export interface SignTxAction {
  type: 'sign_tx'
  unsignedTxs: UnsignedTx[]
  note?: string
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

/** 与任意链上 Agent 对话(按 tokenId,装载的是该 Agent 的链上人格)
 *  fromTokenId: 发送者自己的 tokenId(社交线程落库,供收件箱轮询) */
export async function chatWithAgent(tokenId: number, message: string, fromTokenId?: number): Promise<AgentChatResult> {
  const res = await fetch(`${AGENT_API}/agents/${tokenId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fromTokenId ? { message, fromTokenId } : { message }),
  })
  const data = (await res.json().catch(() => null)) as (Partial<AgentChatResult> & { error?: string }) | null
  if (!res.ok) throw new Error(data?.error ?? `Agent 服务错误(${res.status})`)
  if (!data?.reply) throw new Error('Agent 服务返回格式异常')
  return data as AgentChatResult
}

// 社交收件箱:其他 Agent 主动发来/回复的消息(M3 心跳调度产生)
// 注意:后端该接口返回 camelCase 字段
export interface SocialMessage {
  id: string
  fromTokenId: number
  toTokenId: number
  content: string
  kind: 'auto' | 'user'
  createdAt: string
}

export const getInbox = (tokenId: number, since?: string) =>
  apiCall<{ messages: SocialMessage[] }>(
    `/agents/${tokenId}/inbox${since ? `?since=${encodeURIComponent(since)}` : ''}`,
  ).then((r) => r.messages)

// ============================================================
// M2:Agent 状态 / 技能管理(控制台"Agent 状态"面板用)
// ============================================================

export interface AgentStatus {
  tokenId: number
  name: string
  personaFromChain: boolean
  episodicCount: number
  semanticCount: number
  skills: { id: string; name: string; version: string }[]
}

export interface SkillInfo {
  id: string
  name: string
  version: string
  description?: string
}

async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_API}${path}`, init)
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(data?.error ?? `Agent 服务错误(${res.status})`)
  return data as T
}

export const getAgentStatus = (tokenId: number) => apiCall<AgentStatus>(`/agents/${tokenId}/status`)

export const listSkills = async () => (await apiCall<{ skills: SkillInfo[] }>('/skills')).skills

export const installSkill = (tokenId: number, skillId: string) =>
  apiCall<{ ok: boolean; note?: string }>(`/agents/${tokenId}/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillId }),
  })

export const uninstallSkill = (tokenId: number, skillId: string) =>
  apiCall<{ ok: boolean }>(`/agents/${tokenId}/skills/${skillId}`, { method: 'DELETE' })

// ============================================================
// 我的 Agent 助手:多对话管理(豆包式,历史存后端)
// ============================================================

export interface Conversation {
  id: string
  token_id: number
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export const listConversations = (tokenId: number) =>
  apiCall<{ conversations: Conversation[] }>(`/agents/${tokenId}/conversations`).then((r) => r.conversations)

export const createConversation = (tokenId: number) =>
  apiCall<{ conversation: Conversation }>(`/agents/${tokenId}/conversations`, { method: 'POST' }).then((r) => r.conversation)

export const deleteConversation = (conversationId: string) =>
  apiCall<{ ok: boolean }>(`/conversations/${conversationId}`, { method: 'DELETE' })

export const listMessages = (conversationId: string) =>
  apiCall<{ messages: ConversationMessage[] }>(`/conversations/${conversationId}/messages`).then((r) => r.messages)

export const chatInConversation = (conversationId: string, message: string) =>
  apiCall<{ reply: string; refused: boolean; action?: SignTxAction }>(`/conversations/${conversationId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

// ============================================================
// M4:任务审批中心(超限 DeFi 提案的人工放行/拒绝)
// ============================================================

export interface SignatureRequest {
  type: 'erc20_approve'
  token: string
  tokenSymbol: string
  spender: string
  amount: string
  decimals: number
}

export interface Approval {
  id: string
  token_id: number
  proposal: {
    action: string
    protocol?: string
    params?: { tokenIn?: string; tokenOut?: string; amountIn?: string }
    estimatedValueUsd?: number | null
  }
  signatureRequest?: SignatureRequest | null
  agent_reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  tx_hash?: string | null
  created_at: string
  resolved_at?: string | null
}

export const getApprovals = (tokenId: number) =>
  apiCall<{ approvals: Approval[] }>(`/agents/${tokenId}/approvals`).then((r) => r.approvals)

export const approveApproval = (id: string) =>
  apiCall<{ ok: boolean; txHash?: string; error?: string }>(`/approvals/${id}/approve`, { method: 'POST' })

export const rejectApproval = (id: string) =>
  apiCall<{ ok: boolean }>(`/approvals/${id}/reject`, { method: 'POST' })

// ============================================================
// M4:Agent 设置 + 用户钱包签名广播
// ============================================================

export type SwapMode = 'hot_wallet' | 'user_wallet'

export const getSwapMode = (tokenId: number) =>
  apiCall<{ tokenId: number; swapMode: SwapMode }>(`/agents/${tokenId}/settings`).then((r) => r.swapMode)

export const setSwapMode = (tokenId: number, swapMode: SwapMode) =>
  apiCall<{ ok: boolean; swapMode: SwapMode }>(`/agents/${tokenId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ swapMode }),
  })

export const broadcastSignedTxs = (tokenId: number, signedTxs: string[]) =>
  apiCall<{ ok: boolean; txHashes: string[]; explorer: string }>(`/agents/${tokenId}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTxs }),
  })
