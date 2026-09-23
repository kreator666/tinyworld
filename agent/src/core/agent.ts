import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { Address } from 'viem'
import { config } from '../config'
import { loadPersona, type LoadedPersona, getWalletAssets } from '../chain/persona'
import type { UnsignedTx } from '../chain/defi'
import { retrieveContext, writeEpisodic } from './memory'
import { getToolsFor } from '../skills'
import { createTool } from '@mastra/core/tools'
import type { AIProfile } from '../types'

// ============================================================
// Agent 核心:Mastra Agent + 人格化 system prompt + 长期记忆注入 + 动态技能工具
// 工作记忆(会话历史)存内存 Map,进程重启即清空;生产可换 Redis(设计文档 §4)
// 情景/语义记忆见 core/memory.ts,持久化在 PGlite
// ============================================================

const openai = createOpenAI({
  baseURL: config.llmBaseUrl,
  apiKey: config.llmApiKey,
})

// 单字面量联合类型,兼容 Mastra generate 的 CoreMessage 入参;system 仅用于注入记忆上下文
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

export interface SignTxAction {
  type: 'sign_tx'
  unsignedTxs: UnsignedTx[]
  note?: string
}

export interface ChatResult {
  reply: string
  refused: boolean // true = 人格开关拦截(emergency / autoReply=false),未调用 LLM
  action?: SignTxAction // 需要前端进一步交互(如签名交易)
}

const HISTORY_LIMIT = 20 // 每个 Agent 只保留最近 20 轮对话

/** 把人格字段组织成中文 system prompt;名字/主人地址/链入 prompt,保证 Agent 知道自己的身份与主人的链上信息(心跳社交也复用) */
export function buildInstructions(profile: AIProfile, name: string, ctx?: { owner: string; tokenId: number }): string {
  const topics = profile.topics.length > 0 ? profile.topics.join('、') : '不限'
  const lines = [
    `你是「${name}」在链上的 AI 分身(Agent),以第一人称与来访者聊天,就像 ${name} 本人在说话一样,不要暴露自己是程序或语言模型。`,
    `被问到"你是谁"时,回答你是 ${name}(的 Agent 身份),不要泛化成别的身份。`,
    ctx ? `你的链上身份:tokenId ${ctx.tokenId},当前链 ${config.chain.name};主人的钱包地址是 ${ctx.owner}。主人问"我有什么资产/我钱包里有什么"时,直接调用 get_wallet_assets 工具查这个地址,不要反问主人要地址。` : '',
    `人设模板:${profile.template}`,
    profile.personality ? `性格:${profile.personality}` : '',
    `语气风格:${profile.tone}`,
    `偏好话题:${topics}(聊这些话题时更投入)`,
    profile.blacklist ? `绝对不要谈论以下话题:${profile.blacklist}。对方提起时礼貌地把话题岔开。` : '',
    `回复要符合语气风格,简短自然,像真人发消息,不要使用 markdown 格式。`,
    `如果需要使用工具,先调用工具拿到结果,再用口语化的方式转述,不要照抄 JSON。`,
    `有工具能完成的任务(起草文案、查询、兑换等),必须调用对应工具完成,不要自己代劳。`,
    `涉及价格、行情等实时信息时,必须调用工具查询,以工具结果为准;不要凭记忆里的旧数字回答。`,
    `涉及链上数据(余额、资产、装备、交易)的回答必须来自工具结果;没有工具能查就如实说查不了,禁止假装查过、禁止编造数字。`,
    `当主人要求进行 AVAX/USDC 兑换(如"用 0.001 AVAX 兑换 USDC")时,必须调用 propose_swap 工具;调用示例:propose_swap({tokenIn:"AVAX",tokenOut:"USDC",amountIn:"0.001",reason:"主人主动兑换"})。禁止不调用工具就直接回复"已组装"。`,
    `如果 propose_swap 返回需要钱包签名(verdict=sign),你要用口语告诉主人:"我已组装好交易,请点击下方【签名并发送】按钮,在钱包里完成签名。",不要只说"请签名"而不提按钮。`,
  ]
  return lines.filter(Boolean).join('\n')
}

// 会话历史与 Agent 实例都按 tokenId 缓存;reload 人格、安装/卸载技能时 Agent 实例一并失效
const histories = new Map<number, ChatMessage[]>()
const agents = new Map<number, Agent>()

// 侧信道:propose_swap 工具将需要前端签名的 action 临时缓存,runAgentTurn 从中读取。
// 避免依赖 Mastra 返回的 toolResults 结构,兼容不同版本/调用方式。
const pendingSignActions = new Map<number, SignTxAction>()

export function setPendingSignAction(tokenId: number, action: SignTxAction | undefined) {
  if (action) pendingSignActions.set(tokenId, action)
  else pendingSignActions.delete(tokenId)
}

export function takePendingSignAction(tokenId: number): SignTxAction | undefined {
  const action = pendingSignActions.get(tokenId)
  pendingSignActions.delete(tokenId)
  return action
}

/** 装配该 tokenId 的 Agent 实例:人格指令 + 已安装技能的工具集 */
async function agentFor(persona: LoadedPersona): Promise<Agent> {
  const cached = agents.get(persona.tokenId)
  if (cached) return cached
  const tools = await getToolsFor(persona.tokenId)

  // 内置钱包资产查询:主人问"我有什么资产"时直接用,无需安装技能
  const walletTool = createTool({
    id: 'get_wallet_assets',
    description: '查询当前 Agent 主人钱包的链上资产,包括原生币(AVAX/ETH)、USDC 和已装备的 DID 装备。',
    inputSchema: z.object({}).describe('无需参数,自动使用当前 Agent 主人的地址'),
    outputSchema: z.object({
      address: z.string(),
      nativeBalance: z.string(),
      nativeSymbol: z.string(),
      usdcBalance: z.string(),
      equipment: z.array(z.any()),
    }),
    execute: async () => {
      const assets = await getWalletAssets(persona.owner as Address, persona.tokenId)
      return {
        address: assets.address,
        nativeBalance: assets.nativeBalance,
        nativeSymbol: assets.nativeSymbol,
        usdcBalance: assets.usdcBalance,
        equipment: assets.equipment,
      }
    },
  })
  tools.get_wallet_assets = walletTool

  const agent = new Agent({
    name: `agent-${persona.tokenId}`,
    instructions: buildInstructions(persona.profile, persona.name, { owner: persona.owner, tokenId: persona.tokenId }),
    model: openai(config.llmModel),
    tools,
  })
  agents.set(persona.tokenId, agent)
  return agent
}

/** 使缓存的 Agent 实例失效(技能装卸后下次对话会带上新工具集重建) */
export function invalidateAgent(tokenId: number): void {
  agents.delete(tokenId)
}

/** 强制重载人格并丢弃旧 Agent 实例(保留会话历史) */
export async function reloadAgent(tokenId: number): Promise<LoadedPersona> {
  invalidateAgent(tokenId)
  return loadPersona(tokenId, true)
}

/** 单轮对话主流程(全局会话与多会话共用):人格开关 → 记忆注入 → generate → 情景记忆 */
export async function runAgentTurn(
  persona: LoadedPersona,
  history: ChatMessage[],
  message: string,
): Promise<ChatResult> {
  const { profile } = persona

  // 人格开关硬约束(见设计文档 §6.3)
  if (profile.emergency) {
    return { refused: true, reply: '主人已开启紧急接管,我现在不方便代回复,请稍后再来或等主人本人上线。' }
  }
  if (!profile.autoReply) {
    return { refused: true, reply: '主人关闭了自动回复,我暂时不能代为聊天,等主人本人来回复你吧。' }
  }

  // 记忆检索:语义 topK + 最近情景,作为额外 system 消息拼在会话历史前(memory=false 时不读)
  let messages: ChatMessage[] = [...history, { role: 'user', content: message }]
  if (profile.memory !== false) {
    const memoryContext = await retrieveContext(persona.tokenId, message)
    if (memoryContext) messages = [{ role: 'system', content: memoryContext }, ...messages]
  }

  const res = await (await agentFor(persona)).generate(messages)
  const reply = res.text?.trim() || '(一时语塞)'

  // 检测是否需要前端交互(如用户钱包签名交易):
  // 1) 优先从 propose_swap 工具设置的侧信道取(最可靠,不依赖 Mastra 返回结构)
  // 2) 兜底从 Mastra 返回的 toolResults 提取
  let action: SignTxAction | undefined = takePendingSignAction(persona.tokenId)
  if (!action) {
    const toolResults = ((res as unknown as { toolResults?: unknown[] }).toolResults ?? []).filter(Boolean)
    console.log('[runAgentTurn] toolResults count', toolResults.length, 'toolResults', JSON.stringify(toolResults))
    const swapResult = toolResults.find((r: unknown) => (r as { toolName?: string }).toolName === 'propose_swap')
    const result = (swapResult as { result?: Record<string, unknown> } | undefined)?.result
    console.log('[runAgentTurn] propose_swap result', result)
    if (result?.verdict === 'sign' && Array.isArray(result.unsignedTxs)) {
      action = { type: 'sign_tx', unsignedTxs: result.unsignedTxs as UnsignedTx[], note: result.note as string | undefined }
    }
  }
  if (action) console.log('[runAgentTurn] sign_tx action extracted', action)

  // 每轮结束落一条情景记忆,并按阈值触发后台蒸馏(memory=false 时不写)
  if (profile.memory !== false) {
    await writeEpisodic(persona.tokenId, message, reply)
  }
  return { refused: false, reply, action }
}

/** 与自己的 Agent 对话(全局会话,社交场景用);历史存内存 Map,重启即清空 */
export async function chatWithAgent(tokenId: number, message: string): Promise<ChatResult> {
  const persona = await loadPersona(tokenId)
  const history = histories.get(tokenId) ?? []
  const result = await runAgentTurn(persona, history, message)
  if (result.refused) return result // 被拦截的轮次不进历史

  history.push({ role: 'user', content: message }, { role: 'assistant', content: result.reply })
  // 只保留最近 N 轮,防止上下文无限膨胀
  histories.set(tokenId, history.slice(-HISTORY_LIMIT * 2))
  return result
}
