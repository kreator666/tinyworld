import { randomUUID } from 'node:crypto'
import { getDb } from '../db'

// ============================================================
// 主人画像(M5 调教):Agent 与主人聊天中学习的事实与偏好
// 隐私分级:sensitivity 写库时由工具入参强制声明,写入侧再做一层硬校验:
// - general:可对外(如"喜欢猫")
// - coarse :对外只能用概略形态(如"住在上海"、"王先生");写入时拒绝精确地址
// - private:仅限主人对话(精确住址、电话、财务等),不进社交 prompt
// 社交 prompt 注入走 buildShareableProfile(只含 general/coarse)
// ============================================================

export type FactSensitivity = 'general' | 'coarse' | 'private'

export interface OwnerFact {
  id: string
  token_id: number
  category: string
  fact: string
  sensitivity: FactSensitivity
  created_at: string
}

export const FACT_CATEGORIES = ['喜好', '习惯', '个人信息', '位置', '职业', '其他'] as const

/** 精确住址特征:门牌号/楼栋/单元/室 + 小区/大厦类冠名。coarse/general 级别一律拒写 */
const PRECISE_ADDRESS_RE = /(\d+\s*(号|栋|幢|单元|室|楼|层))|((路|街|巷|弄|大道|道)\s*\d+\s*号?)|(小区|花园|公寓|大厦|广场)/

export interface AddFactInput {
  category: string
  fact: string
  sensitivity: FactSensitivity
}

/** 写入一条主人事实;违反隐私硬规则时抛错(由工具转成 rejected 反馈给 Agent 重写) */
export async function addOwnerFact(tokenId: number, input: AddFactInput): Promise<OwnerFact> {
  const fact = input.fact.trim()
  if (fact.length < 2 || fact.length > 300) throw new Error('fact 长度需在 2~300 字之间')
  if (!FACT_CATEGORIES.includes(input.category as (typeof FACT_CATEGORIES)[number])) {
    throw new Error(`未知分类: ${input.category}(可选:${FACT_CATEGORIES.join('/')})`)
  }
  // 硬规则:非 private 的位置信息不允许精确到门牌/小区
  if (input.category === '位置' && input.sensitivity !== 'private' && PRECISE_ADDRESS_RE.test(fact)) {
    throw new Error('位置信息过于精确(含门牌号/小区名等);general/coarse 级别只记到城市或区县,更细的信息请主人确认后标 private')
  }
  const id = randomUUID()
  const db = await getDb()
  await db.query('INSERT INTO owner_facts (id, token_id, category, fact, sensitivity) VALUES ($1, $2, $3, $4, $5)', [
    id,
    tokenId,
    input.category,
    fact,
    input.sensitivity,
  ])
  return { id, token_id: tokenId, category: input.category, fact, sensitivity: input.sensitivity, created_at: new Date().toISOString() }
}

/** 列出主人事实;maxSensitivity 控制最高可见级别(social 注入只用 general/coarse) */
export async function listOwnerFacts(
  tokenId: number,
  maxSensitivity: FactSensitivity = 'private',
): Promise<OwnerFact[]> {
  const rank: Record<FactSensitivity, number> = { general: 0, coarse: 1, private: 2 }
  const db = await getDb()
  const res = await db.query<OwnerFact>('SELECT * FROM owner_facts WHERE token_id = $1 ORDER BY created_at', [tokenId])
  return res.rows.filter((r) => rank[r.sensitivity] <= rank[maxSensitivity])
}

/** 按 id 前缀或文本模糊匹配删除(主人说"忘掉xxx");返回删除条数 */
export async function removeOwnerFact(tokenId: number, keyword: string): Promise<number> {
  const db = await getDb()
  const res = await db.query('DELETE FROM owner_facts WHERE token_id = $1 AND (id LIKE $2 OR fact LIKE $3) RETURNING id', [
    tokenId,
    `${keyword}%`,
    `%${keyword}%`,
  ])
  return res.rows.length
}

/** 社交 prompt 用的主人公开画像(仅 general/coarse);无内容时返回空串 */
export async function buildShareableProfile(tokenId: number): Promise<string> {
  const facts = await listOwnerFacts(tokenId, 'coarse')
  if (facts.length === 0) return ''
  return facts.map((f) => `- [${f.category}] ${f.fact}`).join('\n')
}
