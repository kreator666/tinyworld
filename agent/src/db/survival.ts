import { randomUUID } from 'node:crypto'
import { getDb } from './index'

// ============================================================
// 生存模式(Survival)数据层:宠物 / 动作记录 / 账本
// 表结构 DDL 在 db/index.ts 的 initSchema() 中统一创建(幂等,随服务启动迁移)
// token_id 约定与全库一致:NUMERIC(20,0),JS 侧 number 往返;yocto 金额 NUMERIC(39,0) 以字符串往返
// ============================================================

export interface SurvivalPetRow {
  chain_key: string
  token_id: string // 十进制字符串;JS 侧往返转 number(与全库 token_id 约定一致)
  owner: string
  status: string // alive | weak | dormant | dead
  satiety: number
  cleanliness: number
  mood: number
  vitality: number
  weak_since: number | null
  principal_yocto: string
  earnings_yocto: string
  yield_yocto: string
  credits_usd: string
  credits_burned_usd: string
  death_count: number
  revive_count: number
  revive_fee_yocto: string
  born_at: number
  last_action_at: number | null
  last_decay_at: number
  stake_tx: string
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SurvivalActionRow {
  id: string
  chain_key: string
  token_id: string
  kind: string // feed | clean | work | heal
  status: string // planned | executed | partial | rejected | failed
  plan: Record<string, unknown>
  result: Record<string, unknown>
  tx_hash: string | null
  credit_cost_usd: string
  pnl_yocto: string | null
  created_at: string
}

export interface SurvivalLedgerRow {
  id: string
  chain_key: string
  token_id: string
  kind: string // stake | yield | topup | credit_burn | revive_fee | defi | alloc
  amount_yocto: string
  credits_delta: string
  tx_hash: string
  note: string
  ts: number
}

export interface SurvivalPositionRow {
  id: string
  chain_key: string
  token_id: string
  kind: string // usdc_reserve | lending | nearai_farm
  token: string // 头寸代币符号(如 wNEAR/USDC);空串 = 失败/未确定
  amount_atomic: string // 原子单位字符串
  tx_hash: string
  note: string
  created_at: string
}

// ------------------------------------------------------------------
// 宠物
// ------------------------------------------------------------------

export async function getPet(chainKey: string, tokenId: number): Promise<SurvivalPetRow | null> {
  const db = await getDb()
  const res = await db.query<SurvivalPetRow>(
    'SELECT * FROM survival_pets WHERE chain_key = $1 AND token_id = $2',
    [chainKey, tokenId],
  )
  return res.rows[0] ?? null
}

export async function insertPet(row: Omit<SurvivalPetRow, 'created_at' | 'updated_at'>): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO survival_pets (chain_key, token_id, owner, status, satiety, cleanliness, mood, vitality,
       weak_since, principal_yocto, earnings_yocto, yield_yocto, credits_usd, credits_burned_usd,
       death_count, revive_count, revive_fee_yocto, born_at, last_action_at, last_decay_at, stake_tx, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [row.chain_key, row.token_id, row.owner, row.status, row.satiety, row.cleanliness, row.mood, row.vitality,
      row.weak_since, row.principal_yocto, row.earnings_yocto, row.yield_yocto, row.credits_usd, row.credits_burned_usd,
      row.death_count, row.revive_count, row.revive_fee_yocto, row.born_at, row.last_action_at, row.last_decay_at,
      row.stake_tx, JSON.stringify(row.settings ?? {})],
  )
}

/** patch 式更新(仅更新给定键;settings 传对象整体覆盖) */
export async function updatePet(
  chainKey: string,
  tokenId: number,
  patch: Partial<Pick<SurvivalPetRow,
    'owner' | 'status' | 'satiety' | 'cleanliness' | 'mood' | 'vitality' | 'weak_since' |
    'principal_yocto' | 'earnings_yocto' | 'yield_yocto' | 'credits_usd' | 'credits_burned_usd' |
    'death_count' | 'revive_count' | 'revive_fee_yocto' | 'last_action_at' | 'last_decay_at' |
    'stake_tx' | 'settings'>>,
): Promise<boolean> {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'settings' ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return false
  sets.push('updated_at = now()')
  vals.push(chainKey, tokenId)
  const res = await db.query(
    `UPDATE survival_pets SET ${sets.join(', ')} WHERE chain_key = $${i} AND token_id = $${i + 1}`,
    vals,
  )
  return (res.affectedRows ?? 0) > 0
}

/** 某链全部宠物(调度器/排行榜用);status 过滤可选 */
export async function listPets(chainKey?: string, statuses?: string[]): Promise<SurvivalPetRow[]> {
  const db = await getDb()
  if (chainKey) {
    if (statuses?.length) {
      const res = await db.query<SurvivalPetRow>(
        'SELECT * FROM survival_pets WHERE chain_key = $1 AND status = ANY($2) ORDER BY born_at',
        [chainKey, statuses],
      )
      return res.rows
    }
    const res = await db.query<SurvivalPetRow>('SELECT * FROM survival_pets WHERE chain_key = $1 ORDER BY born_at', [chainKey])
    return res.rows
  }
  const res = await db.query<SurvivalPetRow>('SELECT * FROM survival_pets ORDER BY born_at')
  return res.rows
}

/** 该链本金合计(收益快照:热钱包总质押价值 - Σ本金 = 池子收益) */
export async function sumPrincipalYocto(chainKey: string): Promise<bigint> {
  const db = await getDb()
  const res = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(principal_yocto), 0)::text AS total FROM survival_pets WHERE chain_key = $1`,
    [chainKey],
  )
  return BigInt(res.rows[0]?.total ?? '0')
}

// ------------------------------------------------------------------
// 动作记录
// ------------------------------------------------------------------

export async function insertAction(row: Omit<SurvivalActionRow, 'id' | 'created_at'>): Promise<string> {
  const db = await getDb()
  const id = randomUUID()
  await db.query(
    `INSERT INTO survival_actions (id, chain_key, token_id, kind, status, plan, result, tx_hash, credit_cost_usd, pnl_yocto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, row.chain_key, row.token_id, row.kind, row.status, JSON.stringify(row.plan ?? {}),
      JSON.stringify(row.result ?? {}), row.tx_hash ?? null, row.credit_cost_usd, row.pnl_yocto ?? null],
  )
  return id
}

export async function updateAction(id: string, patch: Partial<Pick<SurvivalActionRow, 'status' | 'plan' | 'result' | 'tx_hash' | 'credit_cost_usd' | 'pnl_yocto'>>): Promise<boolean> {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'plan' || k === 'result' ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return false
  vals.push(id)
  const res = await db.query(`UPDATE survival_actions SET ${sets.join(', ')} WHERE id = $${i}`, vals)
  return (res.affectedRows ?? 0) > 0
}

export async function getAction(id: string): Promise<SurvivalActionRow | null> {
  const db = await getDb()
  const res = await db.query<SurvivalActionRow>('SELECT * FROM survival_actions WHERE id = $1', [id])
  return res.rows[0] ?? null
}

export async function listRecentActions(chainKey: string, tokenId: number, limit = 50): Promise<SurvivalActionRow[]> {
  const db = await getDb()
  const res = await db.query<SurvivalActionRow>(
    `SELECT * FROM survival_actions WHERE chain_key = $1 AND token_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [chainKey, tokenId, limit],
  )
  return res.rows
}

// ------------------------------------------------------------------
// 账本
// ------------------------------------------------------------------

export async function insertLedger(row: Omit<SurvivalLedgerRow, 'id'>): Promise<string> {
  const db = await getDb()
  const id = randomUUID()
  await db.query(
    `INSERT INTO survival_ledger (id, chain_key, token_id, kind, amount_yocto, credits_delta, tx_hash, note, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, row.chain_key, row.token_id, row.kind, row.amount_yocto, row.credits_delta, row.tx_hash, row.note, row.ts],
  )
  return id
}

export async function listLedger(chainKey: string, tokenId: number, limit = 100): Promise<SurvivalLedgerRow[]> {
  const db = await getDb()
  const res = await db.query<SurvivalLedgerRow>(
    `SELECT * FROM survival_ledger WHERE chain_key = $1 AND token_id = $2 ORDER BY ts DESC LIMIT $3`,
    [chainKey, tokenId, limit],
  )
  return res.rows
}

/** 按 tx_hash 反查账本(feed/revive 支付防重放:同一笔链上交易不可重复使用) */
export async function findLedgerByTxHash(chainKey: string, txHash: string): Promise<SurvivalLedgerRow | null> {
  const db = await getDb()
  const res = await db.query<SurvivalLedgerRow>(
    'SELECT * FROM survival_ledger WHERE chain_key = $1 AND tx_hash = $2 LIMIT 1',
    [chainKey, txHash],
  )
  return res.rows[0] ?? null
}

/**
 * 原子提取收益(clean):earnings += yield、yield 清零,RETURNING 返回提取额(yocto 字符串)。
 * CTE 取 UPDATE 前的 yield_yocto,并发下只会有一个调用方拿到正数;宠物不存在返回 null。
 */
export async function claimYieldYocto(chainKey: string, tokenId: number): Promise<string | null> {
  const db = await getDb()
  const res = await db.query<{ claimed: string }>(
    `WITH old AS (SELECT yield_yocto FROM survival_pets WHERE chain_key = $1 AND token_id = $2)
     UPDATE survival_pets
        SET earnings_yocto = earnings_yocto + yield_yocto,
            yield_yocto = 0,
            updated_at = now()
      WHERE chain_key = $1 AND token_id = $2
      RETURNING (SELECT yield_yocto FROM old)::text AS claimed`,
    [chainKey, tokenId],
  )
  return res.rows[0]?.claimed ?? null
}

/** 累计收益合计(排行榜排序键:earnings + yield) */
export async function sumEarningsPlusYield(chainKey: string): Promise<Array<{ token_id: string; total: string }>> {
  const db = await getDb()
  const res = await db.query<{ token_id: string; total: string }>(
    `SELECT token_id::text AS token_id, (earnings_yocto + yield_yocto)::text AS total
     FROM survival_pets WHERE chain_key = $1`,
    [chainKey],
  )
  return res.rows
}

// ------------------------------------------------------------------
// 经济模型 v2 头寸(领养费 30/50/20 分配结果)
// ------------------------------------------------------------------

export async function insertPosition(row: Omit<SurvivalPositionRow, 'id' | 'created_at'>): Promise<string> {
  const db = await getDb()
  const id = randomUUID()
  await db.query(
    `INSERT INTO survival_positions (id, chain_key, token_id, kind, token, amount_atomic, tx_hash, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, row.chain_key, row.token_id, row.kind, row.token, row.amount_atomic, row.tx_hash, row.note],
  )
  return id
}

/** 更新该宠物某 kind 的最新一条 position(重试分配时用;同 kind 历史行保留) */
export async function updatePosition(
  chainKey: string,
  tokenId: string,
  kind: string,
  patch: Partial<Pick<SurvivalPositionRow, 'token' | 'amount_atomic' | 'tx_hash' | 'note'>>,
): Promise<boolean> {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    sets.push(`${k} = $${i++}`)
    vals.push(v)
  }
  if (sets.length === 0) return false
  vals.push(chainKey, tokenId, kind)
  const res = await db.query(
    `UPDATE survival_positions SET ${sets.join(', ')}
      WHERE id = (SELECT id FROM survival_positions WHERE chain_key = $${i++} AND token_id = $${i++} AND kind = $${i++} ORDER BY created_at DESC LIMIT 1)`,
    vals,
  )
  return (res.affectedRows ?? 0) > 0
}

export async function listPositions(chainKey: string, tokenId: number): Promise<SurvivalPositionRow[]> {
  const db = await getDb()
  const res = await db.query<SurvivalPositionRow>(
    'SELECT * FROM survival_positions WHERE chain_key = $1 AND token_id = $2 ORDER BY created_at',
    [chainKey, tokenId],
  )
  return res.rows
}

/** 按 stake_tx 反查宠物(领养费支付交易防重放:同一笔交易不可领养第二只) */
export async function findPetByStakeTx(chainKey: string, stakeTx: string): Promise<SurvivalPetRow | null> {
  const db = await getDb()
  const res = await db.query<SurvivalPetRow>(
    'SELECT * FROM survival_pets WHERE chain_key = $1 AND stake_tx = $2 LIMIT 1',
    [chainKey, stakeTx],
  )
  return res.rows[0] ?? null
}
