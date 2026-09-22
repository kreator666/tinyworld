import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { loadPersona } from '../chain/persona'
import { buildInstructions } from './agent'
import { complete } from './llm'
import type { AIProfile } from '../types'

// ============================================================
// 社交消息层(M3,设计文档 §6):Agent 间/真人对 Agent 的消息落库与生成
// 生成走 core/llm.ts 轻量补全,system prompt 复用对话同款人格指令
// ============================================================

export type SocialKind = 'auto' | 'user' // auto=Agent 自主产生, user=真人发出

export interface SocialMessage {
  id: string
  fromTokenId: number
  toTokenId: number
  content: string
  kind: SocialKind
  createdAt: string
}

// ---- 行为边界判断(纯函数,方便独立验证) ----

/** 是否可以主动发起社交(打招呼) */
export function canGreet(profile: AIProfile): boolean {
  return profile.autoGreet && profile.socialMode !== 'passive' && !profile.emergency
}

/** 是否可以自动回复社交消息 */
export function canReply(profile: AIProfile): boolean {
  return profile.autoReply && !profile.emergency
}

// ---- 落库与查询 ----

export async function recordSocialMessage(
  fromTokenId: number,
  toTokenId: number,
  content: string,
  kind: SocialKind,
): Promise<void> {
  const db = await getDb()
  await db.query('INSERT INTO social_messages (id, from_token_id, to_token_id, content, kind) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    fromTokenId,
    toTokenId,
    content,
    kind,
  ])
}

/** 收件箱:该 Agent 收到的消息,按时间正序;since(ISO 时间)可选 */
export async function getInbox(tokenId: number, since?: string): Promise<SocialMessage[]> {
  const db = await getDb()
  const res = await db.query<{
    id: string
    from_token_id: number
    to_token_id: number
    content: string
    kind: SocialKind
    created_at: string
  }>(
    `SELECT * FROM social_messages
     WHERE to_token_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2)
     ORDER BY created_at`,
    [tokenId, since ?? null],
  )
  return res.rows.map((r) => ({
    id: r.id,
    fromTokenId: r.from_token_id,
    toTokenId: r.to_token_id,
    content: r.content,
    kind: r.kind,
    createdAt: r.created_at,
  }))
}

/** X 是否已经给 Y 发过消息(打过招呼就不再重复发起) */
export async function hasGreeted(fromTokenId: number, toTokenId: number): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('SELECT 1 FROM social_messages WHERE from_token_id = $1 AND to_token_id = $2 LIMIT 1', [
    fromTokenId,
    toTokenId,
  ])
  return res.rows.length > 0
}

/** 同一对 Agent 间的 auto 消息总数(乒乓上限判断) */
export async function pairAutoCount(a: number, b: number): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM social_messages
     WHERE kind = 'auto'
       AND ((from_token_id = $1 AND to_token_id = $2) OR (from_token_id = $2 AND to_token_id = $1))`,
    [a, b],
  )
  return res.rows[0].n
}

export interface PairMessage {
  fromTokenId: number
  toTokenId: number
  content: string
  kind: SocialKind
}

/** 两个 Agent 之间最新的一条消息(判断该谁回复) */
export async function latestPairMessage(a: number, b: number): Promise<PairMessage | null> {
  const db = await getDb()
  const res = await db.query<{ from_token_id: number; to_token_id: number; content: string; kind: SocialKind }>(
    `SELECT * FROM social_messages
     WHERE (from_token_id = $1 AND to_token_id = $2) OR (from_token_id = $2 AND to_token_id = $1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [a, b],
  )
  const r = res.rows[0]
  return r ? { fromTokenId: r.from_token_id, toTokenId: r.to_token_id, content: r.content, kind: r.kind } : null
}

// ---- LLM 生成 ----

/** 取 LLM 输出的第一行并去掉首尾引号(小模型偶发加引号/换行) */
function cleanOneLiner(text: string): string {
  return (text.split('\n')[0] ?? '').replace(/^["'「『]+|["'」』]+$/g, '').trim()
}

/** 用 from 的人格生成一句给 to 的打招呼 */
export async function generateGreeting(fromTokenId: number, toName: string): Promise<string> {
  const persona = await loadPersona(fromTokenId)
  const text = await complete(
    buildInstructions(persona.profile, persona.name, { owner: persona.owner, tokenId: persona.tokenId }),
    `你在广场上注意到一个叫「${toName}」的 Agent,以你的人设主动跟他打个招呼。一两句话,简短自然,提到他的名字。`,
    0.9,
  )
  return cleanOneLiner(text) || `你好,「${toName}」,很高兴认识你!`
}

/** 用 tokenId 的人格回复 fromName 发来的一句话 */
export async function generateReply(tokenId: number, fromName: string, content: string): Promise<string> {
  const persona = await loadPersona(tokenId)
  const text = await complete(
    buildInstructions(persona.profile, persona.name, { owner: persona.owner, tokenId: persona.tokenId }),
    `「${fromName}」对你说:"${content}"。以你的人设回复他,一两句话,简短自然。`,
    0.9,
  )
  return cleanOneLiner(text) || '哈哈,有意思,回头再聊~'
}
