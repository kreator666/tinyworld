import { config } from '../config'
import { getChainContext } from '../chain/registry'
import { nearNativeBalance, nearWaitTxFinal, type NearTxDetail, type NearUnsignedTx } from '../chain/nearWrite'
import { stakeNear, totalStakedValueYocto } from '../chain/metapool'
import { getPet, insertPet, updatePet, insertAction, updateAction, getAction, insertLedger, insertPosition, listRecentActions, listPets, findPetByStakeTx, findLedgerByTxHash, claimYieldYocto } from '../db/survival'
import { listChainIdentities } from '../db'
import type { SurvivalPetRow, SurvivalActionRow } from '../db/survival'
import { burnCredits, estimateDecisionCostUsd, healConvert, nearAiLivePricing, nearPriceUsd } from './survivalCredits'
import { thinkSurvival } from './survivalThinker'
import { executePlan } from './survivalExecutor'
import {
  allocateAdoptionFunds,
  adoptionReceiver,
  checkAdoptionDuplicate,
  positionToDto,
  principalOfDeposit,
  transferDepositOf,
  verifyAdoptionPayment,
  feedAmountOfDeposit,
  FEED_CHOICES,
  supplyFeedPrincipal,
  withdrawYieldFromLending,
  type PositionDto,
} from './survivalAllocate'

// ============================================================
// 生存模式服务层:领养(平台垫资质押)/ 领养 v2(用户自费两段式)/ 惰性衰减结算 /
// 动作(动作语义 v2:feed=用户新存入借贷加金、clean=提取收益、work=LLM 高风险方向性策略(唯一烧 credits)、
// heal=收益折算 NEAR AI 算力、revive=用户钱包付 0.5N 两段式)/ 状态 DTO / 排行榜。
// 仿竞技场服务层的错误风格(SurvivalError 带 HTTP status)
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

/** 喂食金额档位校验(纯函数,verify 用):0.1/0.2/0.5 NEAR */
export function validateFeedAmount(a: unknown): a is number {
  return typeof a === 'number' && (FEED_CHOICES as readonly number[]).includes(a)
}

/** 喂食金额 → yocto(纯函数):仅 0.1/0.2/0.5 档,精确十分位 */
export function feedYoctoOf(amount: number): string {
  return (YOCTO_PER_NEAR * BigInt(Math.round(amount * 10)) / 10n).toString()
}

/** 复活费固定 0.5 NEAR(纯常量,verify 用) */
export const REVIVE_FEE_YOCTO: string = (YOCTO_PER_NEAR * 5n / 10n).toString()

/** 复活费档位校验(纯函数,verify 用):deposit 必须精确等于 0.5 NEAR */
export function reviveFeeOfDeposit(depositYocto: string): boolean {
  return BigInt(depositYocto) === BigInt(REVIVE_FEE_YOCTO)
}

/**
 * clean 可提取额(纯函数,本金保护,verify 用):恒等于 max(0, yield),即提取额 ≤ yield、
 * 本金(principal)永远不参与提取;非正收益返回 0(不可提取)。
 */
export function cleanClaimableYocto(yieldYocto: string): bigint {
  const y = BigInt(yieldYocto || '0')
  return y > 0n ? y : 0n
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
// 领养(legacy):平台热钱包垫资质押(Meta Pool stNEAR;测试网 Burrow 替身)。
// 经济模型 v2 起新领养走两段式(buildAdoptionTxs/confirmAdoption,用户自费),
// 本函数保留供测试/存量,仅由 POST /admin/survival/adopt-fund(admin)调用。
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
  let native: bigint
  try {
    native = BigInt(await nearNativeBalance(chainKey))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SurvivalError(
      `平台热钱包余额查询失败(${chainKey}): ${msg.slice(0, 120)} — 请检查服务器 AGENT_NEAR_ACCOUNT_ID / AGENT_NEAR_PRIVATE_KEY 是否为该网络的账户`,
      502,
    )
  }
  const buffer = YOCTO_PER_NEAR / 20n
  if (native < BigInt(yocto) + buffer) {
    throw new SurvivalError(`平台热钱包 NEAR 不足(需 ${principalNear}N + gas),请联系管理员充值`, 502)
  }
  let txHash: string
  try {
    ;({ txHash } = await stakeNear(chainKey, yocto))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SurvivalError(`质押交易执行失败(${chainKey}): ${msg.slice(0, 200)}`, 502)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const starterUsd = config.survivalStarterCreditsUsd
  await insertPet({
    chain_key: chainKey, token_id: String(tokenId), owner, status: 'alive',
    satiety: 80, cleanliness: 80, mood: 80, vitality: 100,
    weak_since: null, principal_yocto: yocto, earnings_yocto: '0', yield_yocto: '0',
    credits_usd: starterUsd, credits_burned_usd: '0', death_count: 0, revive_count: 0, revive_fee_yocto: '0',
    born_at: nowSec, last_action_at: null, last_decay_at: nowSec, stake_tx: txHash, settings: {},
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'stake', amount_yocto: yocto,
    credits_delta: '0', tx_hash: txHash, note: `adopt: 平台垫资 ${principalNear} NEAR 流动质押`, ts: nowSec,
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'topup', amount_yocto: '0',
    credits_delta: starterUsd, tx_hash: '', note: '领养启动算力赠送', ts: nowSec,
  })
  return toDto((await getPet(chainKey, tokenId))!)
}

// ------------------------------------------------------------------
// 领养 v2(经济模型 v2,用户自费两段式):
// adopt-txs 只组装待签名转账(无状态、不建 intent,防重放靠链上核验);
// adopt-confirm 核验链上交易后确权建宠物,并同步执行 30/50/20 资金分配。
// ------------------------------------------------------------------

/** 领养费支付交易组(user_wallet 模式):一笔原生 NEAR 转账,用户钱包签名广播 */
export async function buildAdoptionTxs(chainKey: string, tokenId: number, principalNear: number): Promise<NearUnsignedTx[]> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  if (!validatePrincipal(principalNear)) {
    throw new SurvivalError(`领养费档位必须是 ${PRINCIPAL_CHOICES.join('/')} NEAR`, 400)
  }
  // 与 adopt-confirm 的核验口径一致:未领养才可发起支付(避免用户白付)
  if (await getPet(chainKey, tokenId)) throw new SurvivalError('该 Agent 已领养,不可重复领养', 409)
  const yocto = (YOCTO_PER_NEAR * BigInt(principalNear)).toString()
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`领养费接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  return [{
    kind: 'near',
    receiverId: receiver,
    actions: [{ type: 'transfer', amount: yocto }],
    description: `支付领养费 ${principalNear} NEAR(不返还,30% 购算力储备 / 50% 借贷生息 / 20% NEAR AI 质押)`,
  }]
}

export interface AdoptionConfirmResult {
  pet: SurvivalPetDto
  positions: PositionDto[]
  failures: string[]
}

/**
 * 领养确权:核验链上支付交易(signer=主人、receiver=领养费接收账户、单笔 Transfer、
 * 金额精确等于 1/2/5 NEAR 档位)→ 建宠物 → 热钱包代收并按 30/50/20 分配。
 * 防重放:宠物已存在(重复 confirm)或该交易已用于其他领养均拒绝。
 */
export async function confirmAdoption(chainKey: string, tokenId: number, owner: string, txHash: string): Promise<AdoptionConfirmResult> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  const dupErr = checkAdoptionDuplicate(Boolean(await getPet(chainKey, tokenId)), Boolean(await findPetByStakeTx(chainKey, txHash)))
  if (dupErr) throw new SurvivalError(dupErr, 409)
  let exec: NearTxDetail
  try {
    exec = await nearWaitTxFinal(chainKey, txHash, owner)
  } catch (err) {
    throw new SurvivalError(`领养费交易确认失败: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  const deposit = transferDepositOf(exec)
  const principalNear = deposit !== null ? principalOfDeposit(deposit) : null
  if (deposit === null || principalNear === null) {
    throw new SurvivalError('领养费金额不符:链上转账必须精确等于 1/2/5 NEAR 档位', 400)
  }
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`领养费接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  const payErr = verifyAdoptionPayment(exec, owner, receiver, deposit)
  if (payErr) throw new SurvivalError(`领养费支付核验失败: ${payErr}`, 400)

  const nowSec = Math.floor(Date.now() / 1000)
  const starterUsd = config.survivalStarterCreditsUsd
  try {
    await insertPet({
      chain_key: chainKey, token_id: String(tokenId), owner, status: 'alive',
      satiety: 80, cleanliness: 80, mood: 80, vitality: 100,
      weak_since: null, principal_yocto: deposit, earnings_yocto: '0', yield_yocto: '0',
      credits_usd: starterUsd, credits_burned_usd: '0', death_count: 0, revive_count: 0, revive_fee_yocto: '0',
      born_at: nowSec, last_action_at: null, last_decay_at: nowSec, stake_tx: txHash,
      settings: { alloc: 'v2' },
    })
  } catch {
    // 并发重复 confirm:主键 (chain_key, token_id) 冲突 → 409
    throw new SurvivalError('该 Agent 已领养,不可重复领养', 409)
  }
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'stake', amount_yocto: deposit,
    credits_delta: '0', tx_hash: txHash, note: `adopt(v2): 用户自费领养费 ${principalNear} NEAR(不返还)`, ts: nowSec,
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'topup', amount_yocto: '0',
    credits_delta: starterUsd, tx_hash: '', note: '领养启动算力赠送', ts: nowSec,
  })
  // 同步执行 30/50/20 分配;失败头寸已在 note/failures 记录,不阻塞确权
  const { positions, failures } = await allocateAdoptionFunds(chainKey, tokenId, deposit)
  return { pet: toDto((await getPet(chainKey, tokenId))!), positions: positions.map(positionToDto), failures }
}

// ------------------------------------------------------------------
// 动作(语义 v2):
// - feed  喂食 = 用户新存入借贷协议(确定性金融操作,两段式 feed-txs/feed-confirm,不走 LLM、不烧 credits)
// - clean 打扫 = 提取收益含利息(确定性,本金不可动,不走 LLM、不烧 credits)
// - work  打工 = 高风险方向性策略(唯一保留 LLM 决策 + 按实际用量烧 credits 的动作)
// - heal  治疗 = 收益折算 NEAR AI 算力(确定性折算,不烧 credits;折算前探测 NEAR AI 实时价)
// ------------------------------------------------------------------

const STAT_EFFECTS: Record<string, (s: { satiety: number; cleanliness: number; mood: number; vitality: number }) => void> = {
  feed: (s) => { s.satiety = Math.min(100, s.satiety + 25); s.mood = Math.min(100, s.mood + 5) },
  clean: (s) => { s.cleanliness = Math.min(100, s.cleanliness + 25); s.mood = Math.min(100, s.mood + 5) },
  work: (s) => { s.vitality = Math.max(0, s.vitality - 5); s.mood = Math.min(100, s.mood + 10) },
  heal: (s) => { s.vitality = Math.min(100, s.vitality + 20); s.satiety = Math.min(100, s.satiety + 15) },
}

/**
 * 点动作(语义 v2):work 走 LLM 决策(烧 credits),heal 走确定性折算;
 * feed/clean 已改为独立确定性路径,请走 feed-txs/feed-confirm/clean 路由。
 */
export async function doAction(chainKey: string, tokenId: number, kind: string): Promise<SurvivalActionDto> {
  if (kind === 'feed' || kind === 'clean') {
    throw new SurvivalError(`「${kind}」已改为独立确定性路径,请使用 /survival/pet/:tokenId/${kind === 'feed' ? 'feed-txs|feed-confirm' : 'clean'}`, 400)
  }
  if (!['work', 'heal'].includes(kind)) throw new SurvivalError(`未知动作: ${kind}`, 400)
  let pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status === 'dead') throw new SurvivalError('宠物已死亡,请先复活', 409)
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

  // work:LLM 决策 + 链上执行,按实际用量烧 credits
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
    // 打工:执行前后头寸价值快照差值记 pnl(允许为负)
    const before = await totalStakedValueYocto(chainKey).catch(() => null)
    const outcome = await executePlan(chainKey, thought.plan, maxSingle)
    if (before !== null) {
      const after = await totalStakedValueYocto(chainKey).catch(() => null)
      if (after !== null) pnlYocto = after - before
    }
    result = { steps: outcome.results, moodNote: (thought.plan as { moodNote?: string }).moodNote ?? '' }
    txHash = outcome.txHash || null
    execStatus = outcome.status === 'executed' ? 'executed' : outcome.status
  } catch (err) {
    // credits 类失败(余额不足/扣费失败)→ dormant 是事实,置状态;
    // 其余失败(LLM 网关故障/链上错误等)只是本次动作没成,不能把宠物打进 dormant(否则一次故障就锁死)
    const msg = err instanceof Error ? err.message : String(err)
    if (/credits/i.test(msg)) await updatePet(chainKey, tokenId, { status: 'dormant' }).catch(() => {})
    await updateAction(actionId, { status: 'failed', result: { error: msg.slice(0, 300) } })
    throw err instanceof SurvivalError ? err : new SurvivalError(`决策执行失败: ${msg.slice(0, 200)}`, 502)
  }
  // 状态加成 + 时间戳(分动作 cooldown 记 settings.lastActionAt)
  const stats = { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality }
  STAT_EFFECTS.work(stats)
  const lastActionAt = { ...lastActionAtOf(pet), work: nowSec2 }
  const patch: Parameters<typeof updatePet>[2] = {
    ...stats,
    earnings_yocto: (BigInt(pet.earnings_yocto) + pnlYocto).toString(),
    last_action_at: nowSec2,
    settings: { ...settingsOf(pet), lastActionAt },
  }
  // 打工掉 vitality 到 0 不致死
  await updatePet(chainKey, tokenId, patch)
  await updateAction(actionId, {
    status: execStatus, plan, result, tx_hash: txHash,
    credit_cost_usd: creditCost.toFixed(6), pnl_yocto: pnlYocto.toString(),
  })
  return actionToDto((await getAction(actionId))!)
}

// ------------------------------------------------------------------
// 喂食(feed,语义 v2):用户钱包新存入借贷协议,增加生息本金。
// 两段式:feed-txs 只组装转账(无状态);feed-confirm 核验链上交易后记账并存入。
// 确定性金融操作:不走 LLM、不烧 credits。
// ------------------------------------------------------------------

/** 喂食支付交易组(user_wallet 模式):一笔原生 NEAR 转账,用户钱包签名广播 */
export async function buildFeedTxs(chainKey: string, tokenId: number, amount: number): Promise<NearUnsignedTx[]> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  const pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status !== 'alive' && pet.status !== 'weak') {
    throw new SurvivalError(`当前状态(${pet.status})不可喂食:dead 请先复活,dormant 请先治疗`, 409)
  }
  if (!validateFeedAmount(amount)) {
    throw new SurvivalError(`喂食金额必须是 ${FEED_CHOICES.join('/')} NEAR`, 400)
  }
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`喂食金接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  return [{
    kind: 'near',
    receiverId: receiver,
    actions: [{ type: 'transfer', amount: feedYoctoOf(amount) }],
    description: `喂食加金 ${amount} NEAR(存入借贷协议,增加生息本金)`,
  }]
}

export interface FeedConfirmResult {
  pet: SurvivalPetDto
  position: PositionDto | null
  failures: string[]
}

/**
 * 喂食确权:核验链上支付(signer=主人、receiver=接收账户、单笔 Transfer、金额精确等于
 * 0.1/0.2/0.5 NEAR 档)→ 存入借贷协议(增加生息本金)→ 记账。
 * 防重放:该交易哈希已出现在账本(adopt/feed/revive 任一支付)即拒绝。
 * 链上存入失败不阻塞记账(资金语义上本金已增加),失败记 failures + position note。
 */
export async function confirmFeed(chainKey: string, tokenId: number, owner: string, txHash: string): Promise<FeedConfirmResult> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  let pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status !== 'alive' && pet.status !== 'weak') {
    throw new SurvivalError(`当前状态(${pet.status})不可喂食:dead 请先复活,dormant 请先治疗`, 409)
  }
  const nowMs = Date.now()
  const nextAt = cooldownNextAt(pet, 'feed', nowMs)
  if (nextAt > 0) throw new SurvivalError(`动作冷却中,${new Date(nextAt).toISOString()} 后可执行`, 409)
  if (await findLedgerByTxHash(chainKey, txHash)) {
    throw new SurvivalError('该交易已被使用(防重放拒绝)', 409)
  }
  let exec: NearTxDetail
  try {
    exec = await nearWaitTxFinal(chainKey, txHash, owner)
  } catch (err) {
    throw new SurvivalError(`喂食金交易确认失败: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  const deposit = transferDepositOf(exec)
  const amount = deposit !== null ? feedAmountOfDeposit(deposit) : null
  if (deposit === null || amount === null) {
    throw new SurvivalError('喂食金额不符:链上转账必须精确等于 0.1/0.2/0.5 NEAR 档位', 400)
  }
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`喂食金接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  const payErr = verifyAdoptionPayment(exec, owner, receiver, deposit)
  if (payErr) throw new SurvivalError(`喂食金支付核验失败: ${payErr}`, 400)

  const nowSec = Math.floor(Date.now() / 1000)
  const failures: string[] = []
  // 链上存入借贷协议(增加生息本金);失败不阻塞记账,记 failures + 失败头寸
  let position: PositionDto | null = null
  try {
    const out = await supplyFeedPrincipal(chainKey, deposit)
    const id = await insertPosition({
      chain_key: chainKey, token_id: String(tokenId), kind: 'lending', token: out.token,
      amount_atomic: out.amountAtomic, tx_hash: out.txHash, note: '喂食加金:生息本金增加',
    })
    position = { id, kind: 'lending', token: out.token, amountAtomic: out.amountAtomic, txHash: out.txHash, note: '喂食加金:生息本金增加', createdAt: new Date().toISOString() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const note = `喂食加金: 链上存入失败(${msg.slice(0, 200)})`
    const id = await insertPosition({
      chain_key: chainKey, token_id: String(tokenId), kind: 'lending', token: '',
      amount_atomic: '0', tx_hash: '', note,
    }).catch(() => '')
    if (id) position = { id, kind: 'lending', token: '', amountAtomic: '0', txHash: '', note, createdAt: new Date().toISOString() }
    failures.push(`feed: ${msg.slice(0, 120)}`)
  }
  // 记账:principal 增加 + 状态加成 + 冷却;账本留痕(tx_hash 供防重放)
  pet = await getOrThrowPet(chainKey, tokenId) // 链上等待期间可能已发生衰减结算
  const stats = { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality }
  STAT_EFFECTS.feed(stats)
  await updatePet(chainKey, tokenId, {
    ...stats,
    principal_yocto: (BigInt(pet.principal_yocto) + BigInt(deposit)).toString(),
    last_action_at: nowSec,
    settings: { ...settingsOf(pet), lastActionAt: { ...lastActionAtOf(pet), feed: nowSec } },
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'stake', amount_yocto: deposit,
    credits_delta: '0', tx_hash: txHash, note: `feed: 喂食加金 ${amount} NEAR`, ts: nowSec,
  }).catch(() => {}) // 账本失败不影响主流程
  return { pet: toDto((await getPet(chainKey, tokenId))!), position, failures }
}

// ------------------------------------------------------------------
// 打扫(clean,语义 v2):提取收益(含利息),本金不可动。
// 确定性金融操作:不走 LLM、不烧 credits。
// ------------------------------------------------------------------

export interface CleanResult {
  action: SurvivalActionDto
  claimedYocto: string
}

/**
 * 打扫:提取 yield(含利息)入 earnings,本金(principal)永不触碰。
 * 链上提取成功才记账(原子 UPDATE RETURNING 防并发);收益每小时快照一次,无可提取额给 409。
 */
export async function cleanPet(chainKey: string, tokenId: number): Promise<CleanResult> {
  let pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status === 'dead') throw new SurvivalError('宠物已死亡,请先复活', 409)
  if (pet.status === 'dormant') {
    throw new SurvivalError('宠物处于 dormant(credits 不足),请先治疗(heal)折算收益或请管理员充值', 409)
  }
  let claimable = cleanClaimableYocto(pet.yield_yocto)
  if (claimable <= 0n) {
    throw new SurvivalError('暂无可提取的收益(收益每小时快照一次,可先喂食/等待)', 409)
  }
  const nowMs = Date.now()
  const nextAt = cooldownNextAt(pet, 'clean', nowMs)
  if (nextAt > 0) throw new SurvivalError(`动作冷却中,${new Date(nextAt).toISOString()} 后可执行`, 409)
  pet = await applyDecay(chainKey, tokenId)
  if (pet.status === 'dead') throw new SurvivalError('宠物已死亡,请先复活', 409)
  claimable = cleanClaimableYocto(pet.yield_yocto)
  if (claimable <= 0n) throw new SurvivalError('暂无可提取的收益(收益每小时快照一次,可先喂食/等待)', 409)

  // 链上提取(本金保护:提取额 ≤ claimable ≤ yield,principal 不动);失败给 502 不记账
  let txHash: string
  try {
    txHash = await withdrawYieldFromLending(chainKey, claimable.toString())
  } catch (err) {
    throw new SurvivalError(`收益提取失败: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, 502)
  }
  // 原子记账:earnings += yield、yield 清零(RETURNING 防并发;快照期间新增的 yield 一并入账)
  const claimed = await claimYieldYocto(chainKey, tokenId)
  if (claimed === null) throw new SurvivalError(`宠物不存在(chain=${chainKey}, token=${tokenId})`, 404)
  const claimedBig = BigInt(claimed || '0')
  if (claimedBig <= 0n) throw new SurvivalError('收益已被并发提取,请刷新后重试', 409)

  const nowSec = Math.floor(Date.now() / 1000)
  const claimedNear = Number(claimedBig) / 1e24
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'yield', amount_yocto: claimedBig.toString(),
    credits_delta: '0', tx_hash: txHash, note: `clean: 提取收益 ${claimedNear} NEAR(含利息)`, ts: nowSec,
  }).catch(() => {})
  const stats = { satiety: pet.satiety, cleanliness: pet.cleanliness, mood: pet.mood, vitality: pet.vitality }
  STAT_EFFECTS.clean(stats)
  await updatePet(chainKey, tokenId, {
    ...stats,
    last_action_at: nowSec,
    settings: { ...settingsOf(pet), lastActionAt: { ...lastActionAtOf(pet), clean: nowSec } },
  })
  const actionId = await insertAction({
    chain_key: chainKey, token_id: String(tokenId), kind: 'clean', status: 'executed',
    plan: { claimableYocto: claimable.toString() },
    result: { claimedYocto: claimedBig.toString(), txHash },
    tx_hash: txHash, credit_cost_usd: '0', pnl_yocto: null,
  })
  return { action: actionToDto((await getAction(actionId))!), claimedYocto: claimedBig.toString() }
}

/** 治疗:收益折算 credits + 状态恢复;折算后 credits 够决策费则脱离 dormant。不烧 credits。 */
async function runHeal(chainKey: string, pet: SurvivalPetRow): Promise<SurvivalActionDto> {
  const actionId = await insertAction({
    chain_key: chainKey, token_id: pet.token_id, kind: 'heal', status: 'planned',
    plan: {}, result: {}, tx_hash: null, credit_cost_usd: '0', pnl_yocto: null,
  })
  // 折算前探测 NEAR AI 在线与实时价:可达则 note 带实时价,不可达不阻塞(按回落价折算)
  const pricing = await nearAiLivePricing().catch(() => null)
  const nearAiNote = pricing
    ? `NEAR AI 实时价 $${(pricing.promptPerToken * 1e6).toFixed(4)}/1M prompt、$${(pricing.completionPerToken * 1e6).toFixed(4)}/1M completion`
    : 'NEAR AI 报价不可用,按回落价折算'
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
    result: {
      convertedUsd: convertedUsd.toFixed(6),
      nearAi: nearAiNote,
      note: convertedUsd > 0 ? '收益折算 credits,恢复精力/饱食' : '暂无收益可折算(质押收益每小时快照一次,先打点工攒收益;本次仅恢复精力/饱食)',
    },
  })
  return actionToDto((await getAction(actionId))!)
}

// ------------------------------------------------------------------
// 复活(revive,语义 v2):用户钱包支付 0.5 NEAR 充值 NEAR AI 算力(两段式)。
// dead 才可;不再从 earnings 扣款;四维重置 60,死亡记录保留。
// ------------------------------------------------------------------

/** 复活费支付交易组(user_wallet 模式):一笔 0.5 NEAR 原生转账,用户钱包签名广播 */
export async function buildReviveTxs(chainKey: string, tokenId: number): Promise<NearUnsignedTx[]> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  const pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status !== 'dead') throw new SurvivalError(`当前状态(${pet.status})不可复活`, 409)
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`复活费接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  return [{
    kind: 'near',
    receiverId: receiver,
    actions: [{ type: 'transfer', amount: REVIVE_FEE_YOCTO }],
    description: '复活费 0.5 NEAR(用于为宠物充值 NEAR AI 算力)',
  }]
}

/**
 * 复活确权:核验链上支付(同领养核验口径,金额必须精确 0.5 NEAR)→ 复活。
 * 防重放:该交易哈希已出现在账本即拒绝;不再扣 earnings。
 */
export async function confirmRevive(chainKey: string, tokenId: number, owner: string, txHash: string): Promise<SurvivalPetDto> {
  const ctx = getChainContext(chainKey)
  if (ctx.family !== 'near') throw new SurvivalError('生存模式仅支持 NEAR 链', 400)
  const pet = await getOrThrowPet(chainKey, tokenId)
  if (pet.status !== 'dead') throw new SurvivalError(`当前状态(${pet.status})不可复活`, 409)
  if (await findLedgerByTxHash(chainKey, txHash)) {
    throw new SurvivalError('该交易已被使用(防重放拒绝)', 409)
  }
  let exec: NearTxDetail
  try {
    exec = await nearWaitTxFinal(chainKey, txHash, owner)
  } catch (err) {
    throw new SurvivalError(`复活费交易确认失败: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
  const deposit = transferDepositOf(exec)
  if (deposit === null || !reviveFeeOfDeposit(deposit)) {
    throw new SurvivalError('复活费金额不符:链上转账必须精确等于 0.5 NEAR', 400)
  }
  let receiver: string
  try {
    receiver = adoptionReceiver(chainKey)
  } catch (err) {
    throw new SurvivalError(`复活费接收账户不可用: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
  const payErr = verifyAdoptionPayment(exec, owner, receiver, deposit)
  if (payErr) throw new SurvivalError(`复活费支付核验失败: ${payErr}`, 400)

  const nowSec = Math.floor(Date.now() / 1000)
  await updatePet(chainKey, tokenId, {
    status: 'alive', satiety: 60, cleanliness: 60, mood: 60, vitality: 60,
    weak_since: null, last_decay_at: nowSec, last_action_at: nowSec,
    revive_count: pet.revive_count + 1,
    revive_fee_yocto: (BigInt(pet.revive_fee_yocto) + BigInt(deposit)).toString(),
  })
  await insertLedger({
    chain_key: chainKey, token_id: String(tokenId), kind: 'revive_fee', amount_yocto: deposit,
    credits_delta: '0', tx_hash: txHash, note: '用户支付:充值 NEAR AI 算力', ts: nowSec,
  }).catch(() => {}) // 账本失败不影响主流程
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
