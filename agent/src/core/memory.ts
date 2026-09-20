import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { embed } from './embedding'
import { complete } from './llm'

// ============================================================
// 记忆层(设计文档 §4):情景记忆(交互流水)+ 语义记忆(蒸馏出的事实/偏好,向量检索)
// 工作记忆(会话历史)仍在 core/agent.ts 的内存 Map,生产可换 Redis
// 人格开关 profile.memory === false 时由调用方跳过本层,不写不读
// ============================================================

const RECENT_EPISODIC = 3 // 每轮拼进 prompt 的最近情景条数
const DISTILL_BATCH = 20 // 每次蒸馏读取的最近情景条数
const DISTILL_THRESHOLD = 10 // 每积累 N 条新情景自动蒸馏一次
const DEDUP_SIMILARITY = 0.92 // 语义记忆去重阈值(余弦相似度)

// 自上次蒸馏后新写入的情景计数(进程内计数即可,重启后从 0 重新积累)
const pendingDistill = new Map<number, number>()

/** number[] → pgvector 字面量 '[0.1,0.2,...]' */
function toVectorLiteral(v: number[]): string {
  return `[${v.map((n) => n.toFixed(6)).join(',')}]`
}

/** 一轮对话结束落一条情景记忆;每积累 DISTILL_THRESHOLD 条自动触发一次后台蒸馏 */
export async function writeEpisodic(tokenId: number, userMessage: string, reply: string): Promise<void> {
  const db = await getDb()
  const content = `来访者说:${userMessage}\n我回复:${reply}`
  const vec = toVectorLiteral(await embed(content))
  await db.query(
    'INSERT INTO memories (id, token_id, kind, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
    [randomUUID(), tokenId, 'episodic', content, vec],
  )

  const n = (pendingDistill.get(tokenId) ?? 0) + 1
  if (n >= DISTILL_THRESHOLD) {
    pendingDistill.set(tokenId, 0)
    // 后台蒸馏,失败不影响当前对话
    distill(tokenId).catch((err) => console.error('[memory] 自动蒸馏失败:', err))
  } else {
    pendingDistill.set(tokenId, n)
  }
}

/** 检索注入 prompt 的记忆:语义 topK(向量余弦)+ 最近几条情景(按时间);无记忆返回空串 */
export async function retrieveContext(tokenId: number, query: string, k = 5): Promise<string> {
  const db = await getDb()
  const vec = toVectorLiteral(await embed(query))
  const semantic = await db.query<{ content: string }>(
    `SELECT content FROM memories
     WHERE token_id = $2 AND kind = 'semantic' AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vec, tokenId, k],
  )
  const episodic = await db.query<{ content: string }>(
    `SELECT content FROM memories
     WHERE token_id = $1 AND kind = 'episodic'
     ORDER BY created_at DESC
     LIMIT $2`,
    [tokenId, RECENT_EPISODIC],
  )

  const sections: string[] = []
  if (semantic.rows.length > 0) {
    sections.push('你记得的事实与偏好:\n' + semantic.rows.map((r) => '- ' + r.content).join('\n'))
  }
  if (episodic.rows.length > 0) {
    sections.push('最近的互动记录(新→旧):\n' + episodic.rows.map((r) => '- ' + r.content.replace(/\n/g, ' / ')).join('\n'))
  }
  if (sections.length === 0) return ''
  return '以下是你记得的事(来自你的长期记忆,自然地融入对话,不要逐字背诵):\n' + sections.join('\n\n')
}

export interface DistillResult {
  created: number // 新写入的语义记忆条数
  skipped: number // 与已有语义记忆重复(相似度 > 阈值)跳过的条数
}

/** 解析蒸馏输出为条目列表(去前导符号/编号,滤掉"无") */
function parseFacts(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[-*·\d.、\s]+/, '').trim())
    .filter((l) => l.length > 0 && l !== '无')
}

/** 反思蒸馏:用 LLM 把最近 N 条情景记忆提炼成事实/偏好,去重后写入语义记忆 */
export async function distill(tokenId: number): Promise<DistillResult> {
  const db = await getDb()
  const episodic = await db.query<{ content: string }>(
    `SELECT content FROM memories
     WHERE token_id = $1 AND kind = 'episodic'
     ORDER BY created_at DESC
     LIMIT $2`,
    [tokenId, DISTILL_BATCH],
  )
  if (episodic.rows.length === 0) return { created: 0, skipped: 0 }

  const transcript = episodic.rows.map((r) => r.content).reverse().join('\n')
  // few-shot 示例锚定输出格式:实测小模型(Qwen2.5-7B)对纯指令蒸馏极不稳定,会整段输出"无"
  const system = `你是记忆蒸馏器。从对话流水中提炼值得长期记住的事实与偏好(来访者的身份、喜好、计划等)。
输出格式:简短中文条目,每行一条,不要编号不要解释。确实没有值得记住的内容时才输出"无"。
示例:
来访者叫小明
来访者喜欢猫,养了一只橘猫
来访者住在杭州,周末喜欢跑步`
  const user = `对话流水:\n${transcript}\n\n请输出条目:`
  let text = await complete(system, user, 0.5)
  let facts = parseFacts(text)
  if (facts.length === 0) {
    // 小模型偶发空输出,重试一次
    text = await complete(system, user, 0.7)
    facts = parseFacts(text)
  }
  let created = 0
  let skipped = 0
  for (const fact of facts) {
    const lit = toVectorLiteral(await embed(fact))
    // 与现有语义记忆去重:最近邻余弦相似度超过阈值视为同一条
    const dup = await db.query<{ sim: number }>(
      `SELECT 1 - (embedding <=> $1::vector) AS sim FROM memories
       WHERE token_id = $2 AND kind = 'semantic' AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [lit, tokenId],
    )
    if (dup.rows.length > 0 && Number(dup.rows[0].sim) > DEDUP_SIMILARITY) {
      skipped++
      continue
    }
    await db.query(
      'INSERT INTO memories (id, token_id, kind, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
      [randomUUID(), tokenId, 'semantic', fact, lit],
    )
    created++
  }
  return { created, skipped }
}

export interface MemoryCounts {
  episodicCount: number
  semanticCount: number
}

export async function getMemoryCounts(tokenId: number): Promise<MemoryCounts> {
  const db = await getDb()
  const res = await db.query<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*)::int AS n FROM memories WHERE token_id = $1 GROUP BY kind',
    [tokenId],
  )
  const counts: MemoryCounts = { episodicCount: 0, semanticCount: 0 }
  for (const row of res.rows) {
    if (row.kind === 'episodic') counts.episodicCount = row.n
    if (row.kind === 'semantic') counts.semanticCount = row.n
  }
  return counts
}

export interface MemoryRow {
  id: string
  kind: string
  content: string
  created_at: string
}

/** 记忆浏览(控制台用);kind 为空则两种都返回 */
export async function listMemories(tokenId: number, kind?: string, limit = 50): Promise<MemoryRow[]> {
  const db = await getDb()
  const res = await db.query<MemoryRow>(
    `SELECT id, kind, content, created_at FROM memories
     WHERE token_id = $1 AND ($2::text IS NULL OR kind = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [tokenId, kind ?? null, limit],
  )
  return res.rows
}

/** 清空该 Agent 的全部记忆(记忆主权,设计文档 §4.4) */
export async function clearMemories(tokenId: number): Promise<number> {
  const db = await getDb()
  const res = await db.query('DELETE FROM memories WHERE token_id = $1 RETURNING id', [tokenId])
  pendingDistill.delete(tokenId)
  return res.rows.length
}
