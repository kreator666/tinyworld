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
  return { id: r.id, tokenId: r.token_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }
}

/** 会话列表,按最近活跃倒序 */
export async function listConversations(tokenId: number): Promise<Conversation[]> {
  const db = await getDb()
  const res = await db.query<ConversationRow>(
    'SELECT * FROM conversations WHERE token_id = $1 ORDER BY updated_at DESC',
    [tokenId],
  )
  return res.rows.map(toConversation)
}

/** 新建会话(标题默认"新对话",首轮对话后自动生成) */
export async function createConversation(tokenId: number): Promise<Conversation> {
  const db = await getDb()
  const id = randomUUID()
  const res = await db.query<ConversationRow>(
    'INSERT INTO conversations (id, token_id) VALUES ($1, $2) RETURNING *',
    [id, tokenId],
  )
  return toConversation(res.rows[0])
}

/** 删除会话,消息级联删除;返回会话是否确实存在 */
export async function deleteConversation(id: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id])
  return res.rows.length > 0
}

async function getConversation(id: string): Promise<ConversationRow | undefined> {
  const db = await getDb()
  const res = await db.query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id])
  return res.rows[0]
}

/** 按 id 查会话(路由层解析 tokenId / 404 用) */
export async function getConversationById(id: string): Promise<Conversation | undefined> {
  const row = await getConversation(id)
  return row ? toConversation(row) : undefined
}

/** 会话消息,按时间正序 */
export async function listMessages(conversationId: string): Promise<ConversationMessage[] | null> {
  if (!(await getConversation(conversationId))) return null
  const db = await getDb()
  const res = await db.query<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string }>(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at',
    [conversationId],
  )
  return res.rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at }))
}

/** 追加一条 assistant 消息(不经过 LLM),用于链上事件确认后的主动告知;会话不存在则忽略 */
export async function appendAssistantMessage(conversationId: string, content: string): Promise<void> {
  const db = await getDb()
  if (!(await getConversation(conversationId))) return
  await db.query('INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
    conversationId,
    'assistant',
    content,
  ])
  await db.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId])
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
  tokenId: number,
  conversationId: string,
  message: string,
): Promise<ChatResult | null> {
  const conv = await getConversation(conversationId)
  if (!conv || conv.token_id !== tokenId) return null

  const db = await getDb()
  const recent = await db.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, HISTORY_LIMIT * 2],
  )
  const history: ChatMessage[] = recent.rows.reverse()

  const persona = await loadPersona(tokenId)
  const result = await runAgentTurn(persona, history, message)

  // 问答(含被拦截的轮次)都落 messages 表,并刷新 updated_at
  await db.query('INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
    conversationId,
    'user',
    message,
  ])
  await db.query('INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, $3, $4)', [
    randomUUID(),
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
