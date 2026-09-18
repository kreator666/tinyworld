import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'
import { config } from '../config'
import { loadPersona, type LoadedPersona } from '../chain/persona'
import type { AIProfile } from '../types'

// ============================================================
// Agent 核心:Mastra Agent + 人格化 system prompt + 内存会话历史
// M1 不持久化记忆,会话历史存内存 Map,进程重启即清空
// ============================================================

const openai = createOpenAI({
  baseURL: config.llmBaseUrl,
  apiKey: config.llmApiKey,
})

// 单字面量联合类型,兼容 Mastra generate 的 CoreMessage 入参
export type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string }

export interface ChatResult {
  reply: string
  refused: boolean // true = 人格开关拦截(emergency / autoReply=false),未调用 LLM
}

const HISTORY_LIMIT = 20 // 每个 Agent 只保留最近 20 轮对话

/** 把人格字段组织成中文 system prompt */
function buildInstructions(profile: AIProfile): string {
  const topics = profile.topics.length > 0 ? profile.topics.join('、') : '不限'
  const lines = [
    `你是主人在链上的 AI 分身(Agent),以第一人称与来访者聊天,就像主人本人在说话一样,不要暴露自己是程序或语言模型。`,
    `人设模板:${profile.template}`,
    profile.personality ? `性格:${profile.personality}` : '',
    `语气风格:${profile.tone}`,
    `偏好话题:${topics}(聊这些话题时更投入)`,
    profile.blacklist ? `绝对不要谈论以下话题:${profile.blacklist}。对方提起时礼貌地把话题岔开。` : '',
    `回复要符合语气风格,简短自然,像真人发消息,不要使用 markdown 格式。`,
  ]
  return lines.filter(Boolean).join('\n')
}

// 会话历史与 Agent 实例都按 tokenId 缓存;reload 人格时 Agent 实例一并失效
const histories = new Map<number, ChatMessage[]>()
const agents = new Map<number, Agent>()

function agentFor(persona: LoadedPersona): Agent {
  const cached = agents.get(persona.tokenId)
  if (cached) return cached
  const agent = new Agent({
    name: `agent-${persona.tokenId}`,
    instructions: buildInstructions(persona.profile),
    model: openai(config.llmModel),
  })
  agents.set(persona.tokenId, agent)
  return agent
}

/** 强制重载人格并丢弃旧 Agent 实例(保留会话历史) */
export async function reloadAgent(tokenId: number): Promise<LoadedPersona> {
  agents.delete(tokenId)
  return loadPersona(tokenId, true)
}

/** 与自己的 Agent 对话:人格开关拦截优先于 LLM 调用 */
export async function chatWithAgent(tokenId: number, message: string): Promise<ChatResult> {
  const persona = await loadPersona(tokenId)
  const { profile } = persona

  // 人格开关硬约束(见设计文档 §6.3)
  if (profile.emergency) {
    return { refused: true, reply: '主人已开启紧急接管,我现在不方便代回复,请稍后再来或等主人本人上线。' }
  }
  if (!profile.autoReply) {
    return { refused: true, reply: '主人关闭了自动回复,我暂时不能代为聊天,等主人本人来回复你吧。' }
  }

  const history = histories.get(tokenId) ?? []
  history.push({ role: 'user', content: message })

  const res = await agentFor(persona).generate(history)
  const reply = res.text?.trim() || '(一时语塞)'
  history.push({ role: 'assistant', content: reply })

  // 只保留最近 N 轮,防止上下文无限膨胀
  histories.set(tokenId, history.slice(-HISTORY_LIMIT * 2))
  return { refused: false, reply }
}
