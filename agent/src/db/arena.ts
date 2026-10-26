import { randomUUID } from 'node:crypto'
import { getDb } from './index'

// ============================================================
// 竞技场(Arena)数据层:赛季 / 账户 / 燃料 / 策略 / 调度队列
// 表结构 DDL 在 db/index.ts 的 initSchema() 中统一创建(幂等,随服务启动迁移)
// token_id 约定与全库一致:NUMERIC(20,0),JS 侧 number 往返
// ============================================================

export interface ArenaSeasonRow {
  id: string
  chain_key: string
  season_address: string // 链上 ArenaSeason 代理地址('' = 未部署)
  account_impl_address: string // ArenaAccount 实现地址(克隆模板)
  usdc_address: string
  principal_usd: string // NUMERIC 以字符串往返
  fuel_usd: string
  start_ts: number // BIGINT 以 number 往返
  end_ts: number
  status: string // created | open | active | settling | settled(与链上时间派生态并用)
  config: Record<string, unknown>
  created_by: string
  created_at: string
}

export interface ArenaAccountRow {
  season_id: string
  chain_key: string
  token_id: string
  owner: string
  account_address: string
  phase: string // active | frozen | settled | eliminated
  nav_usd: string | null
  eliminated_reason: string | null
  register_tx: string
  settled_tx: string | null
  created_at: string
  updated_at: string
}

export interface ArenaPlaybookRow {
  season_id: string
  token_id: string
  version: number
  config: Record<string, unknown>
  updated_by: string
  updated_at: string
}

// ------------------------------------------------------------------
// 赛季
// ------------------------------------------------------------------

export async function insertArenaSeason(row: Omit<ArenaSeasonRow, 'created_at'>): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_seasons (id, chain_key, season_address, account_impl_address, usdc_address,
       principal_usd, fuel_usd, start_ts, end_ts, status, config, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.id, row.chain_key, row.season_address, row.account_impl_address, row.usdc_address,
      row.principal_usd, row.fuel_usd, row.start_ts, row.end_ts, row.status,
      JSON.stringify(row.config ?? {}), row.created_by],
  )
}

export async function getArenaSeason(id: string): Promise<ArenaSeasonRow | null> {
  const db = await getDb()
  const res = await db.query<ArenaSeasonRow>('SELECT * FROM arena_seasons WHERE id = $1', [id])
  return res.rows[0] ?? null
}

export async function listArenaSeasons(chainKey?: string): Promise<ArenaSeasonRow[]> {
  const db = await getDb()
  const res = chainKey
    ? await db.query<ArenaSeasonRow>('SELECT * FROM arena_seasons WHERE chain_key = $1 ORDER BY start_ts DESC', [chainKey])
    : await db.query<ArenaSeasonRow>('SELECT * FROM arena_seasons ORDER BY start_ts DESC')
  return res.rows
}

/** admin 更新赛季(部署回填/状态推进);仅更新给定键 */
export async function updateArenaSeason(id: string, patch: Partial<Pick<ArenaSeasonRow, 'season_address' | 'account_impl_address' | 'usdc_address' | 'principal_usd' | 'fuel_usd' | 'start_ts' | 'end_ts' | 'status' | 'config'>>): Promise<boolean> {
  const db = await getDb()
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'config' ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return false
  vals.push(id)
  const res = await db.query(`UPDATE arena_seasons SET ${sets.join(', ')} WHERE id = $${i}`, vals)
  return (res.affectedRows ?? 0) > 0
}

// ------------------------------------------------------------------
// 参赛账户
// ------------------------------------------------------------------

export async function insertArenaAccount(row: Omit<ArenaAccountRow, 'created_at' | 'updated_at' | 'nav_usd' | 'eliminated_reason' | 'settled_tx'> & { nav_usd?: string | null; eliminated_reason?: string | null; settled_tx?: string | null }): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_accounts (season_id, chain_key, token_id, owner, account_address, phase, nav_usd, eliminated_reason, register_tx, settled_tx)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.season_id, row.chain_key, row.token_id, row.owner, row.account_address, row.phase,
      row.nav_usd ?? null, row.eliminated_reason ?? null, row.register_tx, row.settled_tx ?? null],
  )
}

export async function getArenaAccount(seasonId: string, tokenId: number): Promise<ArenaAccountRow | null> {
  const db = await getDb()
  const res = await db.query<ArenaAccountRow>(
    'SELECT * FROM arena_accounts WHERE season_id = $1 AND token_id = $2',
    [seasonId, tokenId],
  )
  return res.rows[0] ?? null
}

export async function getArenaAccountByAddress(accountAddress: string): Promise<ArenaAccountRow | null> {
  const db = await getDb()
  const res = await db.query<ArenaAccountRow>(
    'SELECT * FROM arena_accounts WHERE account_address = $1',
    [accountAddress.toLowerCase()],
  )
  return res.rows[0] ?? null
}

export async function listArenaAccounts(seasonId: string): Promise<ArenaAccountRow[]> {
  const db = await getDb()
  const res = await db.query<ArenaAccountRow>(
    'SELECT * FROM arena_accounts WHERE season_id = $1 ORDER BY created_at',
    [seasonId],
  )
  return res.rows
}

export async function updateArenaAccountPhase(
  seasonId: string,
  tokenId: number,
  phase: string,
  extra?: { nav_usd?: string; settled_tx?: string; eliminated_reason?: string },
): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE arena_accounts SET phase = $3, nav_usd = COALESCE($4, nav_usd),
       settled_tx = COALESCE($5, settled_tx), eliminated_reason = COALESCE($6, eliminated_reason),
       updated_at = now()
     WHERE season_id = $1 AND token_id = $2`,
    [seasonId, tokenId, phase, extra?.nav_usd ?? null, extra?.settled_tx ?? null, extra?.eliminated_reason ?? null],
  )
}

// ------------------------------------------------------------------
// 策略(Playbook,owner 可改,版本化保留历史)
// ------------------------------------------------------------------

export async function getArenaPlaybook(seasonId: string, tokenId: number): Promise<ArenaPlaybookRow | null> {
  const db = await getDb()
  const res = await db.query<ArenaPlaybookRow>(
    `SELECT * FROM arena_playbooks
     WHERE season_id = $1 AND token_id = $2
     ORDER BY version DESC LIMIT 1`,
    [seasonId, tokenId],
  )
  return res.rows[0] ?? null
}

export async function insertArenaPlaybook(seasonId: string, tokenId: number, config: Record<string, unknown>, updatedBy: string): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ version: string }>(
    `INSERT INTO arena_playbooks (season_id, token_id, version, config, updated_by)
     VALUES ($1, $2, COALESCE((SELECT MAX(version) FROM arena_playbooks WHERE season_id = $1 AND token_id = $2), 0) + 1, $3, $4)
     RETURNING version`,
    [seasonId, tokenId, JSON.stringify(config), updatedBy],
  )
  return Number(res.rows[0].version)
}

// ------------------------------------------------------------------
// 燃料账本(链下精确记账;P2 起由 LLM 计费消费)
// ------------------------------------------------------------------

export async function initArenaFuel(seasonId: string, tokenId: number, balanceUsd: string): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_fuel (season_id, token_id, balance_usd, total_spent_usd)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (season_id, token_id) DO NOTHING`,
    [seasonId, tokenId, balanceUsd],
  )
}

export async function getArenaFuel(seasonId: string, tokenId: number): Promise<{ balance_usd: string; total_spent_usd: string } | null> {
  const db = await getDb()
  const res = await db.query<{ balance_usd: string; total_spent_usd: string }>(
    'SELECT balance_usd, total_spent_usd FROM arena_fuel WHERE season_id = $1 AND token_id = $2',
    [seasonId, tokenId],
  )
  return res.rows[0] ?? null
}

export async function newArenaTradeId(): Promise<string> {
  return randomUUID()
}

// ------------------------------------------------------------------
// 竞技场交易流水(P3 起写入;盈亏归因到策略,供复盘与排行榜曲线)
// ------------------------------------------------------------------

export async function insertArenaTrade(row: {
  season_id: string
  token_id: number
  strategy_type: string
  action: string
  tx_hash?: string | null
  pnl_usd?: number | null
  payload?: Record<string, unknown>
}): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_trades (id, season_id, token_id, strategy_type, action, tx_hash, pnl_usd, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), row.season_id, row.token_id, row.strategy_type, row.action,
      row.tx_hash ?? null, row.pnl_usd ?? null, JSON.stringify(row.payload ?? {})],
  )
}

export interface ArenaTradeRow {
  id: string
  season_id: string
  token_id: string
  strategy_type: string
  action: string
  tx_hash: string | null
  pnl_usd: string | null
  payload: Record<string, unknown>
  created_at: string
}

/** 动作记录:某 agent 在某赛季的全部动作(时间倒序) */
export async function listArenaTrades(seasonId: string, tokenId: number, limit = 100): Promise<ArenaTradeRow[]> {
  const db = await getDb()
  const res = await db.query<ArenaTradeRow>(
    `SELECT * FROM arena_trades WHERE season_id = $1 AND token_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [seasonId, tokenId, limit],
  )
  return res.rows
}

/** 该账户当日已实现盈亏(USD,arena_trades 表归因) */
export async function arenaDailyPnl(seasonId: string, tokenId: number): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(pnl_usd), 0)::text AS total FROM arena_trades
     WHERE season_id = $1 AND token_id = $2 AND created_at::date = CURRENT_DATE`,
    [seasonId, tokenId],
  )
  return Number(res.rows[0]?.total ?? 0)
}

/** 该账户最近快照净值(无快照回落到注册本金) */
export async function latestSnapshotNav(seasonId: string, tokenId: number, fallbackUsd: number): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ nav_usd: string }>(
    `SELECT nav_usd::text AS nav_usd FROM arena_snapshots
     WHERE season_id = $1 AND token_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [seasonId, tokenId],
  )
  return res.rows[0] ? Number(res.rows[0].nav_usd) : fallbackUsd
}

// ------------------------------------------------------------------
// 燃料计费(P2):原子扣费 + 流水;余额不足整笔拒绝,不允许透支
// ------------------------------------------------------------------

export interface ArenaFuelLedgerRow {
  id: string
  season_id: string
  token_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: string
  balance_after_usd: string
  created_at: string
}

/** 原子扣费:余额充足才扣(UPDATE ... WHERE balance_usd >= cost),并写一条流水;余额不足抛 ArenaError(409) */
export async function deductArenaFuel(
  seasonId: string,
  tokenId: number,
  entry: { model: string; inputTokens: number; outputTokens: number; costUsd: string },
): Promise<{ balanceAfter: string }> {
  const db = await getDb()
  const res = await db.query<{ balance_usd: string }>(
    `UPDATE arena_fuel
       SET balance_usd = balance_usd - $3::numeric,
           total_spent_usd = total_spent_usd + $3::numeric,
           last_deduction_ts = now()
     WHERE season_id = $1 AND token_id = $2 AND balance_usd >= $3::numeric
     RETURNING balance_usd::text AS balance_usd`,
    [seasonId, tokenId, entry.costUsd],
  )
  const row = res.rows[0]
  if (!row) throw new Error(`燃料余额不足(season=${seasonId}, token=${tokenId}, cost=${entry.costUsd})`)
  await db.query(
    `INSERT INTO arena_fuel_ledger (id, season_id, token_id, model, input_tokens, output_tokens, cost_usd, balance_after_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), seasonId, tokenId, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd, row.balance_usd],
  )
  return { balanceAfter: row.balance_usd }
}

/** 结算/测试用余额调整(正常赛季流程无充值入口,燃料耗尽即停机到赛季末) */
export async function setArenaFuelBalance(seasonId: string, tokenId: number, balanceUsd: string): Promise<void> {
  const db = await getDb()
  await db.query('UPDATE arena_fuel SET balance_usd = $3::numeric WHERE season_id = $1 AND token_id = $2', [
    seasonId,
    tokenId,
    balanceUsd,
  ])
}

export async function lastFuelCost(seasonId: string, tokenId: number): Promise<number | null> {
  const db = await getDb()
  const res = await db.query<{ cost_usd: string }>(
    `SELECT cost_usd::text AS cost_usd FROM arena_fuel_ledger
     WHERE season_id = $1 AND token_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [seasonId, tokenId],
  )
  return res.rows[0] ? Number(res.rows[0].cost_usd) : null
}

export async function listFuelLedger(seasonId: string, tokenId: number, limit = 50): Promise<ArenaFuelLedgerRow[]> {
  const db = await getDb()
  const res = await db.query<ArenaFuelLedgerRow>(
    `SELECT * FROM arena_fuel_ledger WHERE season_id = $1 AND token_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [seasonId, tokenId, limit],
  )
  return res.rows
}

/** 按账户地址查参赛记录 */
export async function accountByAddress(accountAddress: string) {
  return getArenaAccountByAddress(accountAddress)
}

/** 该 agent 当前 active 赛季的参赛记录(一个 agent 同一时刻最多一个 active 赛季) */
export async function getActiveArenaAccount(chainKey: string, tokenId: number): Promise<ArenaAccountRow | null> {
  const db = await getDb()
  const res = await db.query<ArenaAccountRow>(
    `SELECT a.* FROM arena_accounts a
     JOIN arena_seasons s ON s.id = a.season_id
     WHERE a.chain_key = $1 AND a.token_id = $2 AND a.phase = 'active'
     ORDER BY s.start_ts DESC LIMIT 1`,
    [chainKey, tokenId],
  )
  return res.rows[0] ?? null
}

// ------------------------------------------------------------------
// 调度队列与净值快照(P4)
// ------------------------------------------------------------------

export interface ArenaDueRow {
  season_id: string
  token_id: string
  due_ts: number
  kind: string // cheap | decision
  priority: number
  status: string
  updated_at: string
}

/** 幂等登记参赛账户的调度行(每账户 cheap + decision 各一行) */
export async function ensureArenaDue(seasonId: string, tokenId: number, cheapDueTs: number, decisionDueTs: number): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_due (season_id, token_id, due_ts, kind) VALUES ($1, $2, $3, 'cheap'), ($1, $2, $4, 'decision')
     ON CONFLICT (season_id, token_id, kind) DO NOTHING`,
    [seasonId, tokenId, cheapDueTs, decisionDueTs],
  )
}

/** 到期待执行队列(优先级高在前,先到期的在前) */
export async function listDueEntries(nowSec: number, limit: number): Promise<ArenaDueRow[]> {
  const db = await getDb()
  const res = await db.query<ArenaDueRow>(
    `SELECT * FROM arena_due WHERE status = 'pending' AND due_ts <= $1
     ORDER BY priority DESC, due_ts ASC LIMIT $2`,
    [nowSec, limit],
  )
  return res.rows
}

/** 执行完成:写下次到期时间,清空优先级 */
export async function markDueDone(seasonId: string, tokenId: number, kind: string, nextDueTs: number): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE arena_due SET due_ts = $4, priority = 0, status = 'pending', updated_at = now()
     WHERE season_id = $1 AND token_id = $2 AND kind = $3`,
    [seasonId, tokenId, kind, nextDueTs],
  )
}

/** 提升优先级(护栏触发用:下一次扫描优先执行) */
export async function bumpDuePriority(seasonId: string, tokenId: number, kind: string, priority: number, dueTs?: number): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE arena_due SET priority = GREATEST(priority, $4), due_ts = LEAST(due_ts, $5), updated_at = now()
     WHERE season_id = $1 AND token_id = $2 AND kind = $3`,
    [seasonId, tokenId, kind, priority, dueTs ?? Math.floor(Date.now() / 1000)],
  )
}

/** 该账户 decision tick 上次执行时间(最小间隔地板用):以实际落库的 LLM 决策记录为准,
 *  排除 cooldown/daily_halt/fuel_halt 等系统跳过记录,避免它们自刷新导致永远过不了间隔 */
export async function lastDecisionAt(seasonId: string, tokenId: number): Promise<number | null> {
  const db = await getDb()
  const res = await db.query<{ created_at: string }>(
    `SELECT created_at FROM arena_trades
     WHERE season_id = $1 AND token_id = $2 AND strategy_type = 'decision'
       AND action NOT IN ('cooldown', 'daily_halt', 'fuel_halt')
     ORDER BY created_at DESC LIMIT 1`,
    [seasonId, tokenId],
  )
  return res.rows[0] ? Math.floor(new Date(res.rows[0].created_at).getTime() / 1000) : null
}

export async function insertSnapshot(seasonId: string, tokenId: number, navUsd: number, breakdown: Record<string, unknown>): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO arena_snapshots (id, season_id, token_id, nav_usd, breakdown) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), seasonId, tokenId, String(navUsd), JSON.stringify(breakdown)],
  )
}

/** 最近一次快照时间(epoch 秒;无快照返回 null) */
export async function lastSnapshotAt(seasonId: string, tokenId: number): Promise<number | null> {
  const db = await getDb()
  const res = await db.query<{ created_at: string }>(
    `SELECT created_at FROM arena_snapshots WHERE season_id = $1 AND token_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [seasonId, tokenId],
  )
  return res.rows[0] ? Math.floor(new Date(res.rows[0].created_at).getTime() / 1000) : null
}
