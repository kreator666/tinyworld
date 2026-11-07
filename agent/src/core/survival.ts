import { config } from '../config'
import { getChainContext } from '../chain/registry'
import { nearNativeBalance } from '../chain/nearWrite'
import { stakeNear, totalStakedValueYocto } from '../chain/metapool'
import { getPet, insertPet, updatePet, insertAction, updateAction, getAction, insertLedger, listRecentActions, listPets } from '../db/survival'
import { listChainIdentities } from '../db'
import type { SurvivalPetRow, SurvivalActionRow } from '../db/survival'
import { burnCredits, estimateDecisionCostUsd, healConvert, nearPriceUsd } from './survivalCredits'
import { thinkSurvival } from './survivalThinker'
import { executePlan } from './survivalExecutor'

// ============================================================
// 生存模式服务层:领养(平台垫资质押)/ 惰性衰减结算 / 动作( LLM 决策 + 链上执行)/
// 复活 / 状态 DTO / 排行榜。仿竞技场服务层的错误风格(SurvivalError 带 HTTP status)
// ============================================================

export class SurvivalError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 500 | 502 = 400,
  ) {
    super(message)
  }
}

const YOCTO_PER_NEAR = 10n ** 24n
const COOLDOWN_SEC: Record<string, number> = {
  feed: config.survivalCooldownFeedSec,
  clean: config.survivalCooldownCleanSec,
  work: config.survivalCooldownWorkSec,
}

export const PRINCIPAL_CHOICES: readonly number[] = config.survivalPrincipalChoices

/** 领养本金档位校验(纯函数,verify 用) */
export function validatePrincipal(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && (PRINCIPAL_CHOICES as readonly number[]).includes(p)
}

// ------------------------------------------------------------------
// 惰性衰减(纯函数,可离线验证):读时 + tick 时物化,按时间差 × 衰减率结算
// ------------------------------------------------------------------

export interface DecayInput {
  status: string
  satiety: number
  cleanliness: number
  mood: number
  vitality: number
  weak_since: number | null
  last_decay_at: number
}

export interface DecayOutput {
  satiety: number
  cleanliness: number
  mood: number
  vitality: number
  status: string
  weak_since: number | null
  deathCountDelta: number // 本次结算新增的死亡次数(0 或 1)
}

/**
 * 衰减结算:饱食 48h 归零、清洁 72h 归零(0-100 刻度,速率=100/时长);
 * vitality=0 时衰减 ×1.5(虚弱加速);饱食 0 → weak(记 weak_since),
 * weak 持续 24h → dead;mood = (饱食+清洁)/2,弱/死状态封顶 50。
 */
export function computeDecay(pet: DecayInput, nowSec: number): DecayOutput {
  const dt = Math.max(0, nowSec - pet.last_decay_at)
  const satietyHalfLifeSec = config.survivalSatietyDecayHours * 3600
  const cleanHalfLifeSec = config.survivalCleanDecayHours * 3600
  const weakDeathSec = config.survivalWeakDeathHours * 3600
  const speedup = pet.vitality <= 0 ? 1.5 : 1
  let satiety = Math.max(0, pet.satiety - (dt * 100 * speedup) / satietyHalfLifeSec)
  let cleanliness = Math.max(0, pet.cleanliness - (dt * 100 * speedup) / cleanHalfLifeSec)
  let status = pet.status
  let weakSince = pet.weak_since
  let deathCountDelta = 0
  if (status === 'alive' && satiety <= 0) {
    status = 'weak'
    weakSince = nowSec
  }
  if (status === 'weak') {
    if (weakSince !== null && nowSec - weakSince >= weakDeathSec) {
      status = 'dead'
      deathCountDelta = 1
    } else if (satiety > 0) {
      // 治疗/喂食把饱食拉回 0 以上:脱离虚弱
      status = 'alive'
      weakSince = null
    }
  }
  if (status !== 'weak' && status !== 'dead' && satiety <= 0) {
    // dormant 状态同样会因挨饿死亡
    status = 'weak'
    weakSince = weakSince ?? nowSec
  }
  let mood = Math.round((satiety + cleanliness) / 2)
  if (status === 'weak' || status === 'dead') mood = Math.min(mood, 50)
  satiety = Math.round(satiety * 100) / 100
  cleanliness = Math.round(cleanliness * 100) / 100
  return { satiety, cleanliness, mood, vitality: pet.vitality, status, weak_since: weakSince, deathCountDelta }
}

/** 物化衰减:算完写回;死亡发生记 death_count + 账本留痕 */
export async function applyDecay(chainKey: string, tokenId: number): Promise<SurvivalPetRow> {
  const pet = await getPet(chainKey, tokenId)
  if (!pet) throw new SurvivalError(`宠物不存在(chain=${chainKey}, token=${tokenId})`, 404)
  const nowSec = Math.floor(Date.now() / 1000)
  if (pet.status === 'dead') return pet // 死亡不再衰减
  const d = computeDecay(pet, nowSec)
  const patch: Parameters<typeof updatePet>[2] = {
    satiety: Math.round(d.satiety),
    cleanliness: Math.round(d.cleanliness),
    mood: d.mood,
    status: d.status,
    weak_since: d.weak_since,
    last_decay_at: nowSec,
  }
  if (d.deathCountDelta > 0) patch.death_count = pet.death_count + d.deathCountDelta
  await updatePet(chainKey, tokenId, patch)
  if (d.deathCountDelta > 0) {
    await insertLedger({
      chain_key: chainKey, token_id: String(tokenId), kind: 'defi', amount_yocto: '0', credits_delta: '0',
      tx_hash: '', note: 'starved-death: 饿虚持续超时限,宠物死亡', ts: nowSec,
    }).catch(() => {}) // 留痕失败不影响主流程
  }
  return (await getPet(chainKey, tokenId))!
}

// ------------------------------------------------------------------
// 查询
// ------------------------------------------------------------------

export async function getOrThrowPet(chainKey: string, tokenId: number): Promise<SurvivalPetRow> {
  const pet = await getPet(chainKey, tokenId)
  if (!pet) throw new SurvivalError(`宠物不存在(chain=${chainKey}, token=${tokenId}),请先领养`, 404)
  return pet
}

function settingsOf(pet: SurvivalPetRow): Record<string, unknown> {
  return (pet.settings ?? {}) as Record<string, unknown>
}

function lastActionAtOf(pet: SurvivalPetRow): Record<string, number> {
  return (settingsOf(pet).lastActionAt ?? {}) as Record<string, number>
}

/** maxSinglePct(默认 10,即本金的 10%)→ 单笔上限 yocto */
export function maxSingleYoctoOf(pet: SurvivalPetRow): bigint {
  const pct = Number(settingsOf(pet).maxSinglePct ?? 10)
  const safePct = Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : 10
  return (BigInt(pet.principal_yocto) * BigInt(Math.round(safePct * 100))) / 1000n
}

/** 下次可执行时间(ms epoch;已可执行返回 0) */
export function cooldownNextAt(pet: SurvivalPetRow, kind: string, nowMs: number): number {
  const cd = COOLDOWN_SEC[kind]
  if (!cd) return 0
  const lastAt = lastActionAtOf(pet)[kind] ?? 0
  const nextMs = (lastAt + cd) * 1000
  return nextMs > nowMs ? nextMs : 0
}

export interface SurvivalPetDto {
  chainKey: string
  tokenId: number
  status: 'alive' | 'weak' | 'dormant' | 'dead'
  stats: { satiety: number; cleanliness: number; mood: number; vitality: number }
  weakSince: number | null
  principalYocto: string
  earningsYocto: string
  yieldYocto: string
  credits: { balanceUsd: string; burnedUsd: string }
  deathCount: number
  reviveCount: number
  bornAt: number
  lastActionAt: number | null
  cooldowns: { feed: number; clean: number; work: number }
  stakeTx: string
  settings: Record<string, unknown>
}

export async function getState(chainKey: string, tokenId: number): Promise<SurvivalPetDto | null> {
  const pet = await getPet(chainKey, tokenId)
  if (!pet) return null
  const fresh = pet.status === 'dead' ? pet : await applyDecay(chainKey, tokenId)
  return toDto(fresh)
}

export function toDto(pet: SurvivalPetRow): SurvivalPetDto {
  const nowMs = Date.now()
  return {
    chainKey: pet.chain_key,
    tokenId: Number(pet.token_id),
    status: pet.status as SurvivalPetDto['status'],
    stats: { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality },
    weakSince: pet.weak_since,
    principalYocto: pet.principal_yocto,
    earningsYocto: pet.earnings_yocto,
    yieldYocto: pet.yield_yocto,
    credits: { balanceUsd: pet.credits_usd, burnedUsd: pet.credits_burned_usd },
    deathCount: pet.death_count,
    reviveCount: pet.revive_count,
    bornAt: pet.born_at,
    lastActionAt: pet.last_action_at,
    cooldowns: {
      feed: cooldownNextAt(pet, 'feed', nowMs),
      clean: cooldownNextAt(pet, 'clean', nowMs),
      work: cooldownNextAt(pet, 'work', nowMs),
    },
    stakeTx: pet.stake_tx,
    settings: settingsOf(pet),
  }
}

export interface SurvivalActionDto {
  id: string
  kind: string
  status: string
  plan: Record<string, unknown>
  result: Record<string, unknown>
  txHash: string | null
  creditCostUsd: string
  pnlYocto: string | null
  createdAt: string
}

export function actionToDto(row: SurvivalActionRow): SurvivalActionDto {
  return {
    id: row.id, kind: row.kind, status: row.status, plan: row.plan, result: row.result,
    txHash: row.tx_hash, creditCostUsd: row.credit_cost_usd, pnlYocto: row.pnl_yocto, createdAt: row.created_at,
  }
}

// ------------------------------------------------------------------
// 领养:平台热钱包垫资质押(Meta Pool stNEAR;测试网 Burrow 替身)
// ------------------------------------------------------------------

export async function adoptPet(chainKey: string, tokenId: number, owner: string, principalNear: number): Promise<SurvivalPetDto> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  if (!validatePrincipal(principalNear)) {
    throw new SurvivalError(`本金档位必须是 ${PRINCIPAL_CHOICES.join('/')} NEAR`, 400)
  }
  if (await getPet(chainKey, tokenId)) throw new SurvivalError('该 Agent 已领养,不可重复领养', 409)
  const yocto = (YOCTO_PER_NEAR * BigInt(principalNear)).toString()
  // 热钱包余额预检:本金 + ~0.05N gas/storage 余量,不足给明确报错(不等到链上才失败)
  const native = BigInt(await nearNativeBalance(chainKey))
  const buffer = YOCTO_PER_NEAR / 20n
  if (native < BigInt(yocto) + buffer) {
    throw new SurvivalError(`平台热钱包 NEAR 不足(需 ${principalNear}N + gas),请联系管理员充值`, 502)
  }
  const { txHash } = await stakeNear(chainKey, yocto)
  const nowSec = Math.floor(Date.now() / 1000)
  await insertPet({
    chain_key: chainKey, token_id: String(tokenId), owner, status: 'alive',
    satiety: 80, cleanliness: 80, mood: 80, vitality: 100,
    weak_since: null, principal_yocto: yocto, earnings_yocto: '0', yield_yocto: '0',
    credits_usd: '0', credits_burned_usd: '0', death_count: 0, revive_count: 0, revive_fee_yocto: '0',
    born_at: nowSec, last_action_at: null, last_decay_at: nowSec, stake_tx: txHash, settings: {},
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'stake', amount_yocto: yocto,
    credits_delta: '0', tx_hash: txHash, note: `adopt: 平台垫资 ${principalNear} NEAR 流动质押`, ts: nowSec,
  })
  return toDto((await getPet(chainKey, tokenId))!)
}

// ------------------------------------------------------------------
// 动作:冷却检查 → 衰减结算 → LLM 决策(按实际用量烧 credits)→ 白名单执行 → 状态加成
// ------------------------------------------------------------------

const STAT_EFFECTS: Record<string, (s: { satiety: number; cleanliness: number; mood: number; vitality: number }) => void> = {
  feed: (s) => { s.satiety = Math.min(100, s.satiety + 25); s.mood = Math.min(100, s.mood + 5) },
  clean: (s) => { s.cleanliness = Math.min(100, s.cleanliness + 25); s.mood = Math.min(100, s.mood + 5) },
  work: (s) => { s.vitality = Math.max(0, s.vitality - 5); s.mood = Math.min(100, s.mood + 10) },
  heal: (s) => { s.vitality = Math.min(100, s.vitality + 20); s.satiety = Math.min(100, s.satiety + 15) },
}

export async function doAction(chainKey: string, tokenId: number, kind: string): Promise<SurvivalActionDto> {
  if (!['feed', 'clean', 'work', 'heal'].includes(kind)) throw new SurvivalError(`未知动作: ${kind}`, 400)
  let pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status === 'dead') throw new SurvivalError('宠物已死亡,请先复活', 409)
  const nowSec = Math.floor(Date.now() / 1000)
  const nowMs = Date.now()
  // 冷却:读 settings.lastActionAt(分动作),未到点返回 409 并给出下次可执行时间
  const nextAt = cooldownNextAt(pet, kind, nowMs)
  if (nextAt > 0) throw new SurvivalError(`动作冷却中,${new Date(nextAt).toISOString()} 后可执行`, 409)
  // dormant:只允许 heal(把收益折算成 credits 自救),其余动作拒绝
  if (pet.status === 'dormant' && kind !== 'heal') {
    throw new SurvivalError('宠物处于 dormant(credits 不足),请先治疗(heal)折算收益或请管理员充值', 409)
  }
  // 衰减结算(物化;可能刚死亡)
  pet = await applyDecay(chainKey, tokenId)
  if (pet.status === 'dead') throw new SurvivalError('宠物已死亡,请先复活', 409)

  const nowSec2 = Math.floor(Date.now() / 1000)
  if (kind === 'heal') return runHeal(chainKey, pet)

  // feed/clean/work:LLM 决策 + 链上执行,按实际用量烧 credits
  const estimate = await estimateDecisionCostUsd()
  if (Number(pet.credits_usd) < estimate) {
    await updatePet(chainKey, tokenId, { status: 'dormant' })
    throw new SurvivalError(`credits 余额 $${pet.credits_usd} 不足以支付本次决策估算 $${estimate.toFixed(6)},宠物进入 dormant`, 409)
  }
  const recent = (await listRecentActions(chainKey, tokenId, 5)).map((a) => ({
    kind: a.kind, status: a.status,
    summary: `${a.tx_hash ? `tx=${a.tx_hash.slice(0, 12)}… ` : ''}cost=$${a.credit_cost_usd}`,
  }))
  const actionId = await insertAction({
    chain_key: chainKey, token_id: String(tokenId), kind, status: 'planned',
    plan: {}, result: {}, tx_hash: null, credit_cost_usd: '0', pnl_yocto: null,
  })
  const maxSingle = maxSingleYoctoOf(pet)
  let plan: Record<string, unknown>
  let result: Record<string, unknown>
  let txHash: string | null = null
  let creditCost = 0
  let pnlYocto = 0n
  let execStatus: SurvivalActionRow['status'] = 'executed'
  try {
    const thought = await thinkSurvival({
      chainKey, tokenId, kind,
      stats: { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality },
      status: pet.status,
      principalYocto: pet.principal_yocto, earningsYocto: pet.earnings_yocto, yieldYocto: pet.yield_yocto,
      maxSingleYocto: maxSingle.toString(),
      nearPriceUsd: await nearPriceUsd(),
      recentActions: recent,
      isTestnet: getChainContext(chainKey).cfg.chainId === 398,
      meter: async (_usage, costUsd) => {
        const ok = await burnCredits(chainKey, tokenId, costUsd, `decision:${kind}`)
        if (!ok) throw new SurvivalError(`credits 余额不足以支付 LLM 实际成本 $${costUsd.toFixed(6)}`, 409)
        creditCost = costUsd
      },
    })
    plan = thought.plan as unknown as Record<string, unknown>
    // 打工:执行前后头寸价值快照差值记 pnl(允许为负);其余动作 pnl 记 0
    let before: bigint | null = null
    if (kind === 'work') before = await totalStakedValueYocto(chainKey).catch(() => null)
    const outcome = await executePlan(chainKey, thought.plan, maxSingle)
    if (kind === 'work' && before !== null) {
      const after = await totalStakedValueYocto(chainKey).catch(() => null)
      if (after !== null) pnlYocto = after - before
    }
    result = { steps: outcome.results, moodNote: (thought.plan as { moodNote?: string }).moodNote ?? '' }
    txHash = outcome.txHash || null
    execStatus = outcome.status === 'executed' ? 'executed' : outcome.status
  } catch (err) {
    // LLM 失败 / 扣费失败 → dormant(credits 不足已是事实),动作记 failed
    await updatePet(chainKey, tokenId, { status: 'dormant' }).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    await updateAction(actionId, { status: 'failed', result: { error: msg.slice(0, 300) } })
    throw err instanceof SurvivalError ? err : new SurvivalError(`决策执行失败: ${msg.slice(0, 200)}`, 502)
  }
  // 状态加成 + 时间戳(分动作 cooldown 记 settings.lastActionAt)
  const stats = { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality }
  STAT_EFFECTS[kind](stats)
  const lastActionAt = { ...lastActionAtOf(pet), [kind]: nowSec2 }
  const patch: Parameters<typeof updatePet>[2] = {
    ...stats,
    earnings_yocto: (BigInt(pet.earnings_yocto) + pnlYocto).toString(),
    last_action_at: nowSec2,
    settings: { ...settingsOf(pet), lastActionAt },
  }
  // 打工掉 vitality 到 0 不致死;喂食/打扫若把饱食拉回 0 以上,weak 自动恢复(下次 applyDecay)
  await updatePet(chainKey, tokenId, patch)
  await updateAction(actionId, {
    status: execStatus, plan, result, tx_hash: txHash,
    credit_cost_usd: creditCost.toFixed(6), pnl_yocto: kind === 'work' ? pnlYocto.toString() : null,
  })
  return actionToDto((await getAction(actionId))!)
}

/** 治疗:收益折算 credits + 状态恢复;折算后 credits 够决策费则脱离 dormant */
async function runHeal(chainKey: string, pet: SurvivalPetRow): Promise<SurvivalActionDto> {
  const actionId = await insertAction({
    chain_key: chainKey, token_id: pet.token_id, kind: 'heal', status: 'planned',
    plan: {}, result: {}, tx_hash: null, credit_cost_usd: '0', pnl_yocto: null,
  })
  const { convertedUsd } = await healConvert(chainKey, Number(pet.token_id))
  const stats = { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality }
  STAT_EFFECTS.heal(stats)
  const fresh = await getPet(chainKey, Number(pet.token_id))
  let status = pet.status
  if (status === 'weak' && stats.satiety > 0) status = 'alive'
  if (status === 'dormant' && Number(fresh?.credits_usd ?? 0) >= (await estimateDecisionCostUsd())) status = 'alive'
  await updatePet(chainKey, Number(pet.token_id), {
    ...stats, status,
    last_action_at: Math.floor(Date.now() / 1000),
    settings: { ...settingsOf(pet), lastActionAt: { ...lastActionAtOf(pet), heal: Math.floor(Date.now() / 1000) } },
  })
  await updateAction(actionId, {
    status: 'executed',
    result: { convertedUsd: convertedUsd.toFixed(6), note: '收益折算 credits,恢复精力/饱食' },
  })
  return actionToDto((await getAction(actionId))!)
}

// ------------------------------------------------------------------
// 复活:dead 才可;0.5 NEAR 从收益扣(不足则 demo 豁免),四维重置 60,死亡记录保留
// ------------------------------------------------------------------

export async function revivePet(chainKey: string, tokenId: number): Promise<SurvivalPetDto> {
  const pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status !== 'dead') throw new SurvivalError(`当前状态(${pet.status})不可复活`, 409)
  const nowSec = Math.floor(Date.now() / 1000)
  const feeYocto = BigInt(Math.round(Number(config.survivalReviveFeeNear) * 1e24))
  const earnings = BigInt(pet.earnings_yocto)
  let fee = feeYocto
  let note = 'revive fee'
  if (earnings < feeYocto) {
    fee = 0n
    note = 'revive fee (demo-waived: 收益不足,免费复活)'
  }
  await updatePet(chainKey, tokenId, {
    status: 'alive', satiety: 60, cleanliness: 60, mood: 60, vitality: 60,
    weak_since: null, last_decay_at: nowSec,
    earnings_yocto: (earnings - fee).toString(),
    revive_count: pet.revive_count + 1,
    revive_fee_yocto: (BigInt(pet.revive_fee_yocto) + fee).toString(),
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'revive_fee', amount_yocto: fee.toString(),
    credits_delta: '0', tx_hash: '', note, ts: nowSec,
  })
  return toDto((await getPet(chainKey, tokenId))!)
}

// ------------------------------------------------------------------
// 排行榜:按 earnings + yield 降序;名字从链上身份镜像取,取不到给 #tokenId
// ------------------------------------------------------------------

export interface LeaderboardEntry {
  tokenId: number
  name: string
  status: string
  earningsYocto: string
  yieldYocto: string
  deathCount: number
  ageHours: number
}

/** 排序纯函数(verify 用):按 earnings+yield(yocto bigint)降序 */
export function sortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    const diff = BigInt(b.earningsYocto) + BigInt(b.yieldYocto) - (BigInt(a.earningsYocto) + BigInt(a.yieldYocto))
    return diff > 0n ? 1 : diff < 0n ? -1 : 0
  })
}

export async function leaderboard(chainKey: string, limit = 50): Promise<{ entries: LeaderboardEntry[] }> {
  const pets = await listPets(chainKey)
  const identities = await listChainIdentities(chainKey).catch(() => [] as Awaited<ReturnType<typeof listChainIdentities>>)
  const nameOf = new Map(identities.map((i) => [String(i.token_id), i.name]))
  const nowSec = Math.floor(Date.now() / 1000)
  const entries = pets.map((p) => ({
    tokenId: Number(p.token_id),
    name: nameOf.get(String(p.token_id)) || `#${p.token_id}`,
    status: p.status,
    earningsYocto: p.earnings_yocto,
    yieldYocto: p.yield_yocto,
    deathCount: p.death_count,
    ageHours: Math.round(((nowSec - p.born_at) / 3600) * 10) / 10,
  }))
  return { entries: sortLeaderboard(entries).slice(0, Math.min(limit, 200)) }
}

export { listRecentActions }
