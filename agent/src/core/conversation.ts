import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { loadPersona } from '../chain/persona'
import { runAgentTurn, type ChatMessage, type ChatResult } from './agent'
import { complete } from './llm'

// ============================================================
// 多对话管理(我的 Agent 助手页):一个用户对自己的 Agent 可开多个独立对话
// 对话历史按会话隔离(messages 表);事实/偏好记忆走 memory.ts,跨会话共享
// ============================================================

const HISTORY_LIMIT = 20 // 每轮取该会话最近 20 轮历史喂给模型
const DEFAULT_TITLE = '新对话'
const TITLE_MAX_LEN = 15

export interface ConversationRow {
  id: string
  token_id: number
  title: string
  created_at: string
  updated_at: string
}

export interface Conversation {
  id: string
  tokenId: number
  title: string
  createdAt: string
  updatedAt: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, tokenId: Number(r.token_id), title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } // NUMERIC 返回字符串,收敛回 number
}

/** 会话列表,按最近活跃倒序 */
export async function listConversations(chainKey: string, tokenId: number): Promise<Conversation[]> {
  const db = await getDb()
  const res = await db.query<ConversationRow>(
    'SELECT * FROM conversations WHERE chain_key = $1 AND token_id = $2 ORDER BY updated_at DESC',
    [chainKey, tokenId],
  )
  return res.rows.map(toConversation)
}

/** 新建会话(标题默认"新对话",首轮对话后自动生成) */
export async function createConversation(chainKey: string, tokenId: number): Promise<Conversation> {
  const db = await getDb()
  const id = randomUUID()
  const res = await db.query<ConversationRow>(
    'INSERT INTO conversations (id, chain_key, token_id) VALUES ($1, $2, $3) RETURNING *',
    [id, chainKey, tokenId],
  )
  return toConversation(res.rows[0])
}

/** 删除会话,消息级联删除;返回会话是否确实存在 */
export async function deleteConversation(chainKey: string, id: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM conversations WHERE chain_key = $1 AND id = $2 RETURNING id', [chainKey, id])
  return res.rows.length > 0
}

async function getConversation(chainKey: string, id: string): Promise<ConversationRow | undefined> {
  const db = await getDb()
  const res = await db.query<ConversationRow>('SELECT * FROM conversations WHERE chain_key = $1 AND id = $2', [chainKey, id])
  return res.rows[0]
}

/** 按 id 查会话(路由层解析 tokenId / 404 用) */
export async function getConversationById(chainKey: string, id: string): Promise<Conversation | undefined> {
  const row = await getConversation(chainKey, id)
  return row ? toConversation(row) : undefined
}

/** 会话消息,按时间正序 */
export async function listMessages(chainKey: string, conversationId: string): Promise<ConversationMessage[] | null> {
  if (!(await getConversation(chainKey, conversationId))) return null
  const db = await getDb()
  const res = await db.query<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string }>(
    'SELECT * FROM messages WHERE chain_key = $1 AND conversation_id = $2 ORDER BY created_at',
    [chainKey, conversationId],
  )
  return res.rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at }))
}

/** 追加一条 assistant 消息(不经过 LLM),用于链上事件确认后的主动告知;会话不存在则忽略 */
export async function appendAssistantMessage(chainKey: string, conversationId: string, content: string): Promise<void> {
  const db = await getDb()
  if (!(await getConversation(chainKey, conversationId))) return
  await db.query('INSERT INTO messages (id, chain_key, conversation_id, role, content) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    chainKey,
    conversationId,
    'assistant',
    content,
  ])
  await db.query('UPDATE conversations SET updated_at = now() WHERE chain_key = $1 AND id = $2', [chainKey, conversationId])
}

/** 用 LLM 给会话起标题(≤15 字);失败/超时就用首条消息截断兜底 */
async function generateTitle(firstMessage: string): Promise<string> {
  const fallback = firstMessage.replace(/\s+/g, ' ').slice(0, TITLE_MAX_LEN)
  try {
    const title = await complete(
      `为对话起标题。要求:不超过${TITLE_MAX_LEN}个字,概括主题,只输出标题本身,不要标点不要引号不要解释。`,
      firstMessage,
      0.5,
    )
    const clean = title.split('\n')[0].replace(/^["'「『]+|["'」』。.,]+$/g, '').trim()
    return clean.length > 0 ? clean.slice(0, TITLE_MAX_LEN) : fallback
  } catch {
    return fallback
  }
}

/**
 * 在指定会话里对话:历史从 messages 表读最近 N 轮,问答都落库;
 * 首轮对话后自动生成标题;会话不存在返回 null(由路由层转 404)
 */
export async function chatInConversation(
  chainKey: string,
  tokenId: number,
  conversationId: string,
  message: string,
): Promise<ChatResult | null> {
  const conv = await getConversation(chainKey, conversationId)
  if (!conv || Number(conv.token_id) !== tokenId) return null // NUMERIC 返回字符串,收敛回 number

  const db = await getDb()
  const recent = await db.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM messages
     WHERE chain_key = $1 AND conversation_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [chainKey, conversationId, HISTORY_LIMIT * 2],
  )
  const history: ChatMessage[] = recent.rows.reverse()

  const persona = await loadPersona(chainKey, tokenId)
  const result = await runAgentTurn(chainKey, persona, history, message, 'owner')

  // 问答(含被拦截的轮次)都落 messages 表,并刷新 updated_at
  // 注意:chain_key 必须显式写入——列默认值是迁移基线(默认链),缺省会把消息记到错误的链上,
  // 导致 listMessages(按链过滤)查不到,表现为"回复在会话列表可见、聊天区空白"
  await db.query('INSERT INTO messages (id, chain_key, conversation_id, role, content) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    chainKey,
    conversationId,
    'user',
    message,
  ])
  await db.query('INSERT INTO messages (id, chain_key, conversation_id, role, content) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    chainKey,
    conversationId,
    'assistant',
    result.reply,
  ])
  await db.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId])

  // 首轮对话完成后自动生成标题(仍是默认标题才生成)
  if (conv.title === DEFAULT_TITLE) {
    const title = await generateTitle(message)
    await db.query('UPDATE conversations SET title = $1 WHERE id = $2', [title, conversationId])
  }
  return result
}
