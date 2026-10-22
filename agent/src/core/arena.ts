import { encodeFunctionData, decodeEventLog, type Address, type Hex } from 'viem'
import { getPublicClient } from '../chain/clients'
import { waitForTxReceipt } from '../chain/defi'
import { getChainContext } from '../chain/registry'
import type { UnsignedTx } from '../chain/defi'
import {
  type ArenaSeasonRow,
  type ArenaAccountRow,
  getArenaSeason,
  listArenaAccounts,
  insertArenaAccount,
  getArenaAccount,
  getArenaAccountByAddress,
  updateArenaAccountPhase,
  initArenaFuel,
  getArenaPlaybook,
  insertArenaPlaybook,
  type ArenaPlaybookRow,
} from '../db/arena'

// ============================================================
// 竞技场(Arena)核心业务(P1):
//   报名注册(owner 钱包签名,后端组装 unsigned tx + 回执确认回写)
//   紧急冻结 / Playbook 配置(版本化)/ 排行榜读取
// 链上裁决在合约(ArenaAccount 白名单出口),本层只做组装、解析与落库
// ============================================================

export class ArenaError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 500 = 400,
  ) {
    super(message)
  }
}

// 链上合约 ABI 片段(与 contract/src 保持一致,内联避免跨包引用)
const seasonAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentTokenId', type: 'uint256' }],
    outputs: [{ name: 'account', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'agentTokenId', type: 'uint256', indexed: true },
      { name: 'principal', type: 'uint256' },
      { name: 'fuel', type: 'uint256' },
    ],
  },
] as const

const accountAbi = [
  { type: 'function', name: 'freeze', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'event',
    name: 'Frozen',
    inputs: [],
  },
] as const

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** NUMERIC(20,6) 字符串(如 "60.000000") → 6 decimals bigint */
function usdToUnits(usd: string): bigint {
  const n = Number(usd)
  if (!Number.isFinite(n) || n < 0) throw new ArenaError(`非法金额: ${usd}`)
  return BigInt(Math.round(n * 1e6))
}

/** 赛季派生状态:链上地址未回填=created;未开赛=open;赛季中=active;到期未结算=settling;已结算=settled */
export function deriveSeasonStatus(row: ArenaSeasonRow, nowSec = Math.floor(Date.now() / 1000)): string {
  if (row.status === 'settled') return 'settled'
  if (!row.season_address) return 'created'
  if (nowSec < row.start_ts) return 'open'
  if (nowSec < row.end_ts) return 'active'
  return 'settling'
}

export async function loadSeasonOrThrow(id: string): Promise<ArenaSeasonRow> {
  const row = await getArenaSeason(id)
  if (!row) throw new ArenaError('赛季不存在', 404)
  return row
}

// ------------------------------------------------------------------
// 报名注册:approve(USDC→Season) + register(tokenId),owner 钱包逐笔签名
// ------------------------------------------------------------------

export function buildRegisterTxs(season: ArenaSeasonRow, tokenId: number, owner: Address): UnsignedTx[] {
  if (!season.season_address) throw new ArenaError('赛季合约尚未部署,无法报名', 409)
  const { cfg } = getChainContext(season.chain_key)
  const principalPlusFuel = usdToUnits(season.principal_usd) + usdToUnits(season.fuel_usd)
  const approve: UnsignedTx = {
    to: season.usdc_address as Address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [season.season_address as Address, principalPlusFuel],
    }),
    value: '0',
    chainId: cfg.chainId,
    description: `授权竞技场合约划扣 ${(Number(principalPlusFuel) / 1e6).toFixed(2)} USDC`,
  }
  const register: UnsignedTx = {
    to: season.season_address as Address,
    data: encodeFunctionData({ abi: seasonAbi, functionName: 'register', args: [BigInt(tokenId)] }),
    value: '0',
    chainId: cfg.chainId,
    description: `报名参赛(agent #${tokenId}),本金进入专属托管账户`,
  }
  return [approve, register]
}

/** 注册确认:解析 register 回执的 Registered 事件(不信任客户端给定的账户地址),落库 + 初始化燃料账本 */
export async function confirmRegister(seasonId: string, tokenId: number, owner: string, txHash: string): Promise<ArenaAccountRow> {
  const season = await loadSeasonOrThrow(seasonId)
  const existing = await getArenaAccount(seasonId, tokenId)
  if (existing) throw new ArenaError('该 Agent 已报名本赛季', 409)
  // 等待回执(钱包广播后立即确认存在竞态:Fuji 出块前 receipt 查不到)
  const receipt = await waitForTxReceipt(season.chain_key, txHash as Hex)
  if (receipt.status !== 'success') throw new ArenaError('注册交易未成功执行', 400)
  const log = receipt.logs.find((l) => l.address.toLowerCase() === season.season_address.toLowerCase())
  if (!log) throw new ArenaError('回执中找不到赛季合约事件', 400)
  const evt = decodeEventLog({ abi: seasonAbi, eventName: 'Registered', topics: log.topics as [Hex, ...Hex[]], data: log.data })
  if (evt.args.owner.toLowerCase() !== owner.toLowerCase()) throw new ArenaError('报名人与登录地址不一致', 403)
  if (Number(evt.args.agentTokenId) !== tokenId) throw new ArenaError('报名 tokenId 与交易不一致', 400)
  const accountAddress = evt.args.account as string

  await insertArenaAccount({
    season_id: seasonId,
    chain_key: season.chain_key,
    token_id: String(tokenId),
    owner: owner.toLowerCase(),
    account_address: accountAddress.toLowerCase(),
    phase: 'active',
    register_tx: txHash,
  })
  await initArenaFuel(seasonId, tokenId, trimNum(season.fuel_usd))
  return (await getArenaAccount(seasonId, tokenId))!
}

// ------------------------------------------------------------------
// 紧急冻结(owner 一笔签名,账户立即停止执行,进入退赛结算流程)
// ------------------------------------------------------------------

export function buildFreezeTx(season: ArenaSeasonRow, account: ArenaAccountRow): UnsignedTx {
  const { cfg } = getChainContext(season.chain_key)
  return {
    to: account.account_address as Address,
    data: encodeFunctionData({ abi: accountAbi, functionName: 'freeze' }),
    value: '0',
    chainId: cfg.chainId,
    description: '紧急停止:冻结托管账户,停止一切执行',
  }
}

export async function confirmFreeze(seasonId: string, tokenId: number, txHash: string): Promise<void> {
  const season = await loadSeasonOrThrow(seasonId)
  const account = await getArenaAccount(seasonId, tokenId)
  if (!account) throw new ArenaError('未报名本赛季', 404)
  if (account.phase !== 'active') throw new ArenaError(`当前状态(${account.phase})不可冻结`, 409)
  const receipt = await waitForTxReceipt(season.chain_key, txHash as Hex)
  if (receipt.status !== 'success') throw new ArenaError('冻结交易未成功执行', 400)
  const frozen = receipt.logs.some(
    (l) => l.address.toLowerCase() === account.account_address.toLowerCase(),
  )
  if (!frozen) throw new ArenaError('回执中找不到账户合约事件', 400)
  await updateArenaAccountPhase(seasonId, tokenId, 'frozen')
}

// ------------------------------------------------------------------
// 结算后提取(P6):owner 签名取回托管账户剩余(USDC + 原生币)
// ------------------------------------------------------------------

const withdrawAbi = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  { type: 'function', name: 'withdrawNative', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export function buildWithdrawTxs(season: ArenaSeasonRow, account: ArenaAccountRow): UnsignedTx[] {
  const { cfg } = getChainContext(season.chain_key)
  return [
    {
      to: account.account_address as Address,
      data: encodeFunctionData({ abi: withdrawAbi, functionName: 'withdraw', args: [season.usdc_address as Address] }),
      value: '0',
      chainId: cfg.chainId,
      description: '取回托管账户剩余 USDC',
    },
    {
      to: account.account_address as Address,
      data: encodeFunctionData({ abi: withdrawAbi, functionName: 'withdrawNative' }),
      value: '0',
      chainId: cfg.chainId,
      description: '取回托管账户剩余原生币',
    },
  ]
}

export async function confirmWithdraw(seasonId: string, tokenId: number, txHash: string): Promise<void> {
  const season = await loadSeasonOrThrow(seasonId)
  const account = await getArenaAccount(seasonId, tokenId)
  if (!account) throw new ArenaError('未报名本赛季', 404)
  if (account.phase !== 'settled') throw new ArenaError('账户尚未结算,无法提取', 409)
  const receipt = await waitForTxReceipt(season.chain_key, txHash as Hex)
  if (receipt.status !== 'success') throw new ArenaError('提取交易未成功执行', 400)
  const fromAccount = receipt.logs.some((l) => l.address.toLowerCase() === account.account_address.toLowerCase())
  if (!fromAccount) throw new ArenaError('回执中找不到账户合约事件', 400)
}

// ------------------------------------------------------------------
// Playbook(策略配置,owner 赛季中可改,版本化)
// ---------------------------------------------------------------------------

export const RISK_PROFILES = ['conservative', 'balanced', 'aggressive', 'custom'] as const
export const STRATEGY_TYPES = ['fixed_yield', 'perp', 'spot'] as const

/** 轻量结构校验:字段在、类型对、数值在合理域;具体执行语义由策略引擎消费时把关 */
export function validatePlaybook(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null) throw new ArenaError('配置必须是对象')
  const c = config as Record<string, unknown>
  if (c.riskProfile !== undefined && !RISK_PROFILES.includes(c.riskProfile as (typeof RISK_PROFILES)[number])) {
    throw new ArenaError(`riskProfile 必须是 ${RISK_PROFILES.join('/')}`)
  }
  if (c.allocation !== undefined) {
    const a = c.allocation as Record<string, unknown>
    let sum = 0
    for (const [k, v] of Object.entries(a)) {
      if (!(STRATEGY_TYPES as readonly string[]).includes(k)) throw new ArenaError(`allocation 含未知策略类型: ${k}`)
      if (typeof v !== 'number' || v < 0 || v > 100) throw new ArenaError(`allocation.${k} 必须是 0~100 的数字`)
      sum += v
    }
    if (sum > 100) throw new ArenaError(`allocation 总和不能超过 100(当前 ${sum})`)
  }
  if (c.strategies !== undefined) {
    if (!Array.isArray(c.strategies) || c.strategies.length === 0) throw new ArenaError('strategies 必须是非空数组')
    for (const s of c.strategies as Record<string, unknown>[]) {
      if (!s || typeof s !== 'object') throw new ArenaError('strategies 元素必须是对象')
      if (!(STRATEGY_TYPES as readonly string[]).includes(s.type as string)) {
        throw new ArenaError(`未知策略类型: ${String(s.type)}`)
      }
    }
  }
  if (c.guardrails !== undefined) {
    const g = c.guardrails as Record<string, unknown>
    for (const k of ['maxDailyLossPct', 'maxDrawdownPct', 'minCashBufferPct']) {
      if (g[k] !== undefined && (typeof g[k] !== 'number' || (g[k] as number) < 0)) {
        throw new ArenaError(`guardrails.${k} 必须是非负数字`)
      }
    }
  }
  return c
}

export async function getPlaybook(seasonId: string, tokenId: number): Promise<ArenaPlaybookRow | null> {
  return getArenaPlaybook(seasonId, tokenId)
}

export async function savePlaybook(seasonId: string, tokenId: number, config: Record<string, unknown>, updatedBy: string): Promise<number> {
  return insertArenaPlaybook(seasonId, tokenId, config, updatedBy)
}

// ------------------------------------------------------------------
// 排行榜(荣誉榜):按最新净值排序,前端展示;链上结算值(nav_usd)优先
// ------------------------------------------------------------------

export interface LeaderboardEntry extends ArenaAccountRow {
  name: string | null
}

/** 排行榜:已结算按结算净值,未结算按最近快照净值(无快照按本金),并附带链上身份名 */
export async function leaderboardOf(seasonId: string): Promise<LeaderboardEntry[]> {
  const rows = await listArenaAccounts(seasonId)
  const season = await getArenaSeason(seasonId)
  const principal = Number(season?.principal_usd ?? 0)
  const db = await (await import('../db')).getDb()
  const identities = await db.query<{ token_id: string; name: string }>(
    'SELECT token_id, name FROM chain_identities WHERE chain_key = $1',
    [rows[0]?.chain_key ?? ''],
  )
  const nameOf = new Map(identities.rows.map((r) => [String(r.token_id), r.name]))
  const withNav: LeaderboardEntry[] = await Promise.all(
    rows.map(async (r) => {
      const nav = r.nav_usd ?? String(await latestSnapshotNavFor(seasonId, Number(r.token_id), principal))
      return { ...r, nav_usd: nav, name: nameOf.get(String(r.token_id)) ?? null }
    }),
  )
  return withNav.sort((a, b) => Number(b.nav_usd ?? 0) - Number(a.nav_usd ?? 0))
}

/** 未结算账户的"当前净值"= 最近快照(无快照回落注册本金) */
async function latestSnapshotNavFor(seasonId: string, tokenId: number, fallbackUsd: number): Promise<number> {
  const { latestSnapshotNav } = await import('../db/arena')
  return latestSnapshotNav(seasonId, tokenId, fallbackUsd)
}

function trimNum(s: string): string {
  return String(Number(s))
}

/** 供 P4 调度器使用:按账户地址查参赛记录 */
export async function accountByAddress(accountAddress: string) {
  return getArenaAccountByAddress(accountAddress)
}
