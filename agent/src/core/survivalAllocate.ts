import { config } from '../config'
import { getChainContext } from '../chain/registry'
import {
  nearAgentAccountId,
  nearCall,
  nearStorageBalance,
  nearView,
  type NearTxDetail,
} from '../chain/nearWrite'
import { refToken, refSwap } from '../chain/ref'
import { burrowSupply, burrowWithdraw, burrowToHuman } from '../chain/burrow'
import { stNearPrice } from '../chain/metapool'
import { insertPosition, listPositions, insertLedger, type SurvivalPositionRow } from '../db/survival'

// ============================================================
// 生存模式经济模型 v2:用户自费领养 + 领养费 30/50/20 分配
// - 领养费(1/2/5 NEAR,用户自付、不返还)由热钱包代收后按配置比例分配:
//   30% usdc_reserve(主网经 Ref 换 USDC 作 NEAR AI credits 储备;测试网 Burrow 存 wNEAR 暂存生息)
//   50% lending(测试网 Burrow supply wNEAR / 主网 Meta Pool 流动质押)
//   20% nearai_farm(House of Stake farm 占位,接入前同 lending 路径暂存生息)
// - 资金安全:wrap/ref/burrow/metapool 目标合约全部硬编码映射(refToken/burrowContract/
//   config.survivalMetaPoolContract),不允许 LLM/外部传入地址
// - 每个头寸独立 try/catch:失败记 failures + position note('分配失败: xxx'),不中断其余头寸
// - 动作语义 v2:喂食(feed)= 用户新存入借贷协议加金(supplyFeedPrincipal);
//   打扫(clean)= 提取收益、本金不可动(withdrawYieldFromLending,主网 80% 滑点重试)
// - 包裹 helper(wrapNearVisible)供领养分配与喂食加金共用:幂等注册 + 差额包裹 + 视图可见轮询
// ============================================================

const YOCTO_PER_NEAR = 10n ** 24n
/** wNEAR NEP-145 注册费 0.00125N(与 chain/metapool.ts stakeNear 一致) */
const WNEAR_STORAGE_DEPOSIT = 1250000000000000000000n

export type PositionKind = 'usdc_reserve' | 'lending' | 'nearai_farm'

export interface PositionDto {
  id: string
  kind: PositionKind
  token: string
  amountAtomic: string
  txHash: string
  note: string
  createdAt: string
}

export function positionToDto(row: SurvivalPositionRow): PositionDto {
  return {
    id: row.id,
    kind: row.kind as PositionDto['kind'],
    token: row.token,
    amountAtomic: row.amount_atomic,
    txHash: row.tx_hash,
    note: row.note,
    createdAt: row.created_at,
  }
}

/** 领养费接收账户:显式配置优先;缺省按链解析热钱包(mainnet 用主网专用账户,若已配置) */
export function adoptionReceiver(chainKey: string): string {
  if (config.survivalAdoptionReceiver) return config.survivalAdoptionReceiver
  return nearAgentAccountId(chainKey)
}

/**
 * 领养费拆分(纯函数,verify 用):usdc/nearai 向下取整,舍入余数归入 lending(防溢出);
 * 恒等式 usdc + lending + nearai == total。
 */
export function splitAllocation(totalYocto: string, pctUsdc: number, pctLending: number, pctNearai: number): { usdc: string; lending: string; nearai: string } {
  const total = BigInt(totalYocto)
  if (total < 0n) throw new Error('分配总额不能为负')
  const usdc = (total * BigInt(pctUsdc)) / 100n
  const nearai = (total * BigInt(pctNearai)) / 100n
  const lending = total - usdc - nearai // 余数归 lending(pctLending 仅作配置校验,不参与取整)
  return { usdc: usdc.toString(), lending: lending.toString(), nearai: nearai.toString() }
}

/** 从 'tx' RPC 结果取首个动作的 Transfer deposit(yocto 字符串);非 Transfer/缺失返回 null */
export function transferDepositOf(tx: NearTxDetail): string | null {
  const actions = tx.transaction?.actions
  const first = Array.isArray(actions) ? actions[0] : undefined
  const deposit = first && typeof first === 'object' ? (first as { Transfer?: { deposit?: unknown } }).Transfer?.deposit : undefined
  return typeof deposit === 'string' && /^\d+$/.test(deposit) ? deposit : null
}

/**
 * 领养费支付核验(纯函数,verify 用):signer == 主人、receiver == 领养费接收账户、
 * 恰好一笔 Transfer 且 deposit == 期望 yocto、交易成功。返回错误信息或 null(通过)。
 */
export function verifyAdoptionPayment(tx: NearTxDetail, signer: string, receiver: string, expectedYocto: string): string | null {
  if (tx.status && 'Failure' in tx.status) return '交易执行失败(链上状态 Failure)'
  if (tx.transaction?.signer_id !== signer) return `交易签名人与宠物主人不符(${tx.transaction?.signer_id ?? '未知'} ≠ ${signer})`
  if (tx.transaction?.receiver_id !== receiver) return `交易接收人不是领养费接收账户(${tx.transaction?.receiver_id ?? '未知'} ≠ ${receiver})`
  const actions = tx.transaction?.actions
  if (!Array.isArray(actions) || actions.length !== 1) return '交易必须恰好包含一笔动作'
  const deposit = transferDepositOf(tx)
  if (deposit === null) return '交易动作必须是原生 NEAR 转账(Transfer)'
  if (deposit !== BigInt(expectedYocto).toString()) return `转账金额不符(链上 ${deposit} ≠ 期望 ${expectedYocto})`
  return null
}

/** 防重放(纯函数):宠物已存在或该支付交易已被使用 → 错误信息;否则 null */
export function checkAdoptionDuplicate(petExists: boolean, stakeTxTaken: boolean): string | null {
  if (petExists) return '该 Agent 已领养,不可重复领养'
  if (stakeTxTaken) return '该支付交易已被用于领养(防重放拒绝)'
  return null
}

/** NEAR 数(可含小数,如 0.1)→ yocto 十进制字符串;字符串移位实现,避免浮点与 BigInt(0.1) 崩溃 */
export function nearToYocto(amount: number | string): string {
  const s = (typeof amount === 'number' ? amount.toString() : amount).trim()
  const neg = s.startsWith('-') ? '-' : ''
  const [i = '0', d = ''] = s.replace('-', '').split('.')
  const frac = (d + '0'.repeat(24)).slice(0, 24)
  const digits = (i + frac).replace(/^0+(?=\d)/, '')
  return neg + digits
}

/** 链上档位反推:deposit yocto 必须精确等于配置的领养档位之一,返回 NEAR 数;不符返回 null */
export function principalOfDeposit(depositYocto: string): number | null {
  const deposit = BigInt(depositYocto)
  for (const n of config.survivalPrincipalChoices) {
    if (deposit === BigInt(nearToYocto(n))) return n
  }
  return null
}

/** 喂食金额档位(NEAR):用户新存入借贷协议的小额加金档(env 可配,默认 0.1/0.2/0.5) */
export const FEED_CHOICES: readonly number[] = config.survivalFeedChoices

/** 喂食档位反推(纯函数,verify 用):deposit yocto 必须精确等于配置档位之一 */
export function feedAmountOfDeposit(depositYocto: string): number | null {
  const deposit = BigInt(depositYocto)
  for (const n of FEED_CHOICES) {
    if (deposit === BigInt(nearToYocto(n))) return n
  }
  return null
}

function isTestnet(chainKey: string): boolean {
  return getChainContext(chainKey).cfg.chainId === 398
}

interface PositionOutcome {
  kind: PositionKind
  token: string
  amountAtomic: string
  txHash: string
  note: string
}

/** 单头寸执行包装:成功返回结果,失败抛错由调用方记 failures */
async function executePosition(chainKey: string, kind: PositionKind, amountYocto: string, testnet: boolean): Promise<PositionOutcome> {
  if (kind === 'usdc_reserve') {
    if (testnet) {
      // 测试网无 USDC 池流动性,暂存 Burrow 生息;主网将真实兑换 USDC
      const txHash = await burrowSupply(chainKey, 'WNEAR', amountYocto)
      return { kind, token: 'wNEAR', amountAtomic: amountYocto, txHash, note: '测试网无 USDC 池流动性,暂存生息;主网将真实兑换 USDC' }
    }
    // 主网:储备头寸以 stNEAR 持有(生息)。原生 USDC 池少且薄(实测 28 个、多在 4000+ 号段、深度差),
    // 而 NEAR AI credits 本来就要法币在仪表盘购买 —— 届时把 stNEAR 手工兑成 USDC 即可
    const { txHash, amountOut } = await refSwap(chainKey, 'WNEAR', 'STNEAR', amountYocto)
    return { kind, token: 'stNEAR', amountAtomic: amountOut, txHash, note: '算力储备以 stNEAR 持有(生息);购 NEAR AI credits 时手工兑 USDC' }
  }
  if (testnet) {
    const txHash = await burrowSupply(chainKey, 'WNEAR', amountYocto)
    return { kind, token: 'wNEAR', amountAtomic: amountYocto, txHash, note: '' }
  }
  // 主网 lending / nearai_farm:Ref 买 stNEAR。Meta Pool deposit_and_stake 有 1 NEAR 最低额
  // (实测 0.5/0.2 份均报 minimum deposit),DEX 买入无门槛,收益同为质押息
  const { txHash, amountOut } = await refSwap(chainKey, 'WNEAR', 'STNEAR', amountYocto)
  return { kind, token: 'stNEAR', amountAtomic: amountOut, txHash, note: kind === 'nearai_farm' ? 'House of Stake farm 占位:接入前以 stNEAR 生息' : '' }
}

/**
 * 包裹原生 NEAR → wNEAR(幂等:storage 未注册先注册,只包裹差额),
 * 并轮询等 wrap 视图可见(视图有数秒滞后,曾导致后续读不到 wNEAR 余额)。
 * 资金安全:wrap 合约固定取自 refToken(chainKey,'WNEAR'),不允许外部传入地址。
 */
async function wrapNearVisible(chainKey: string, yocto: string): Promise<void> {
  const wrap = refToken(chainKey, 'WNEAR').contractId
  const me = nearAgentAccountId(chainKey)
  const storage = await nearStorageBalance(chainKey, wrap, me)
  if (!storage || BigInt(storage.total) === 0n) {
    await nearCall(chainKey, wrap, 'storage_deposit', {}, WNEAR_STORAGE_DEPOSIT)
  }
  const bal = BigInt(((await nearView<string>(chainKey, wrap, 'ft_balance_of', { account_id: me }).catch(() => null)) ?? '0'))
  if (bal < BigInt(yocto)) await nearCall(chainKey, wrap, 'near_deposit', {}, BigInt(yocto) - bal)
  for (let i = 0; i < 10; i++) {
    const wb = await nearView<string>(chainKey, wrap, 'ft_balance_of', { account_id: me }).catch(() => null)
    if (wb !== null && BigInt(wb) >= BigInt(yocto)) return
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/**
 * 喂食加金的链上执行:先包裹 wNEAR,再存入借贷协议(增加生息本金)。
 * 测试网 Burrow supply wNEAR;主网 Ref 换 stNEAR(质押息,同 lending 头寸路径)。
 * 目标合约全部硬编码(refToken/burrow 链配置),LLM/外部传参无法引入新地址。
 */
export async function supplyFeedPrincipal(
  chainKey: string,
  yocto: string,
): Promise<{ txHash: string; token: string; amountAtomic: string }> {
  await wrapNearVisible(chainKey, yocto)
  if (isTestnet(chainKey)) {
    const txHash = await burrowSupply(chainKey, 'WNEAR', yocto)
    return { txHash, token: 'wNEAR', amountAtomic: yocto }
  }
  const { txHash, amountOut } = await refSwap(chainKey, 'WNEAR', 'STNEAR', yocto)
  return { txHash, token: 'stNEAR', amountAtomic: amountOut }
}

/**
 * 打扫(clean)的链上提取:只动收益,本金(principal)永不触碰。
 * 测试网 Burrow withdraw wNEAR(人类单位);主网按 stNEAR 现价折算数量后经 Ref 换回 wNEAR,
 * 失败按 80% 重试一次(滑点缓冲)。返回交易哈希。
 */
export async function withdrawYieldFromLending(chainKey: string, claimableYocto: string): Promise<string> {
  if (isTestnet(chainKey)) {
    const human = await burrowToHuman(chainKey, 'WNEAR', claimableYocto)
    return burrowWithdraw(chainKey, 'WNEAR', human)
  }
  const price = await stNearPrice(chainKey) // 每 1 stNEAR 值多少 yocto NEAR(1e24 定点)
  const amountStNear = (BigInt(claimableYocto) * (10n ** 24n)) / BigInt(price)
  if (amountStNear <= 0n) throw new Error('收益折算 stNEAR 数量为 0(价格异常)')
  try {
    const { txHash } = await refSwap(chainKey, 'STNEAR', 'WNEAR', amountStNear.toString())
    return txHash
  } catch {
    // 滑点缓冲:按 80% 重试一次
    const retried = (amountStNear * 80n) / 100n
    if (retried <= 0n) throw new Error('80% 滑点缓冲后数量仍为 0')
    const { txHash } = await refSwap(chainKey, 'STNEAR', 'WNEAR', retried.toString())
    return txHash
  }
}

/**
 * 执行领养费分配(热钱包签名):全量包裹 wNEAR → 30% usdc_reserve / 50% lending / 20% nearai_farm。
 * 每个头寸独立 try/catch,结果全部落 survival_positions + survival_ledger(kind='alloc');
 * 失败头寸记 failures + position note,不阻塞其余头寸。
 */
export async function allocateAdoptionFunds(chainKey: string, tokenId: number, totalYocto: string): Promise<{ positions: SurvivalPositionRow[]; failures: string[] }> {
  const testnet = isTestnet(chainKey)
  const { usdc, lending, nearai } = splitAllocation(totalYocto, config.survivalAllocUsdcPct, config.survivalAllocLendingPct, config.survivalAllocNearaiPct)
  const portions: Array<{ kind: PositionKind; amount: string }> = [
    { kind: 'usdc_reserve', amount: usdc },
    { kind: 'lending', amount: lending },
    { kind: 'nearai_farm', amount: nearai },
  ]
  const failures: string[] = []
  const nowSec = Math.floor(Date.now() / 1000)

  // 0) 全量包裹:native NEAR → wNEAR(payable near_deposit);顺带幂等注册 wNEAR storage,
  //    并等 wrap 视图可见再往下走(视图有数秒滞后,曾导致后续头寸读不到 wNEAR 余额)
  try {
    await wrapNearVisible(chainKey, totalYocto)
  } catch (err) {
    // 包裹失败则三个头寸全部失败(资金未动,热钱包仍持原生 NEAR)
    const msg = err instanceof Error ? err.message : String(err)
    for (const p of portions) {
      const note = `分配失败: 包裹 wNEAR 前置步骤失败(${msg.slice(0, 120)})`
      await insertPosition({ chain_key: chainKey, token_id: String(tokenId), kind: p.kind, token: '', amount_atomic: '0', tx_hash: '', note }).catch(() => {})
      await insertLedger({ chain_key: chainKey, token_id: String(tokenId), kind: 'alloc', amount_yocto: p.amount, credits_delta: '0', tx_hash: '', note, ts: nowSec }).catch(() => {})
      failures.push(`${p.kind}: 包裹 wNEAR 失败(${msg.slice(0, 80)})`)
    }
    return { positions: await listPositions(chainKey, tokenId), failures }
  }

  // 1~3) 逐头寸执行,互不影响
  for (const p of portions) {
    if (BigInt(p.amount) <= 0n) continue
    let outcome: PositionOutcome
    try {
      outcome = await executePosition(chainKey, p.kind, p.amount, testnet)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const note = `分配失败: ${msg.slice(0, 200)}`
      await insertPosition({ chain_key: chainKey, token_id: String(tokenId), kind: p.kind, token: '', amount_atomic: '0', tx_hash: '', note }).catch(() => {})
      await insertLedger({ chain_key: chainKey, token_id: String(tokenId), kind: 'alloc', amount_yocto: p.amount, credits_delta: '0', tx_hash: '', note, ts: nowSec }).catch(() => {})
      failures.push(`${p.kind}: ${msg.slice(0, 120)}`)
      continue
    }
    await insertPosition({
      chain_key: chainKey, token_id: String(tokenId), kind: outcome.kind, token: outcome.token,
      amount_atomic: outcome.amountAtomic, tx_hash: outcome.txHash, note: outcome.note,
    }).catch(() => {})
    await insertLedger({
      chain_key: chainKey, token_id: String(tokenId), kind: 'alloc', amount_yocto: p.amount, credits_delta: '0',
      tx_hash: outcome.txHash, note: `${outcome.kind}: ${outcome.note || '分配成功'}`, ts: nowSec,
    }).catch(() => {})
  }
  return { positions: await listPositions(chainKey, tokenId), failures }
}

/**
 * 重试失败头寸(领养后分配部分失败时,主人可自助重试;也可由 admin 触发):
 * 只重跑 note 以「分配失败」开头或缺失的头寸;wNEAR 不足时只包裹差额。
 */
export async function retryAllocation(chainKey: string, tokenId: number): Promise<{ positions: SurvivalPositionRow[]; retried: string[]; failures: string[] }> {
  const { getPet } = await import('../db/survival')
  const pet = await getPet(chainKey, tokenId)
  if (!pet) throw new Error(`宠物不存在(chain=${chainKey}, token=${tokenId})`)
  const testnet = isTestnet(chainKey)
  const { usdc, lending, nearai } = splitAllocation(pet.principal_yocto, config.survivalAllocUsdcPct, config.survivalAllocLendingPct, config.survivalAllocNearaiPct)
  const portions: Array<{ kind: PositionKind; amount: string }> = [
    { kind: 'usdc_reserve', amount: usdc },
    { kind: 'lending', amount: lending },
    { kind: 'nearai_farm', amount: nearai },
  ]
  const existing = await listPositions(chainKey, tokenId)
  const isFailed = (kind: PositionKind) => {
    const rows = existing.filter((x) => x.kind === kind)
    if (rows.length === 0) return true
    const last = rows[rows.length - 1]
    return (last.note ?? '').startsWith('分配失败') || last.amount_atomic === '0'
  }
  const todo = portions.filter((p) => BigInt(p.amount) > 0n && isFailed(p.kind))
  if (todo.length === 0) return { positions: existing, retried: [], failures: [] }

  const wrap = refToken(chainKey, 'WNEAR').contractId
  const me = nearAgentAccountId(chainKey)
  const need = todo.reduce((a, p) => a + BigInt(p.amount), 0n)
  const bal = BigInt(((await nearView<string>(chainKey, wrap, 'ft_balance_of', { account_id: me }).catch(() => null)) ?? '0'))
  if (bal < need) {
    await nearCall(chainKey, wrap, 'near_deposit', {}, need - bal)
    for (let i = 0; i < 10; i++) {
      const wb = await nearView<string>(chainKey, wrap, 'ft_balance_of', { account_id: me }).catch(() => null)
      if (wb !== null && BigInt(wb) >= need) break
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  const retried: string[] = []
  const failures: string[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  const { updatePosition } = await import('../db/survival')
  for (const p of todo) {
    try {
      const outcome = await executePosition(chainKey, p.kind, p.amount, testnet)
      await updatePosition(chainKey, String(tokenId), p.kind, {
        token: outcome.token, amount_atomic: outcome.amountAtomic, tx_hash: outcome.txHash, note: outcome.note,
      })
      await insertLedger({
        chain_key: chainKey, token_id: String(tokenId), kind: 'alloc', amount_yocto: p.amount, credits_delta: '0',
        tx_hash: outcome.txHash, note: `retry ${outcome.kind}: ${outcome.note || '成功'}`, ts: nowSec,
      }).catch(() => {})
      retried.push(p.kind)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await updatePosition(chainKey, String(tokenId), p.kind, { note: `分配失败: ${msg.slice(0, 200)}` }).catch(() => {})
      failures.push(`${p.kind}: ${msg.slice(0, 120)}`)
    }
  }
  return { positions: await listPositions(chainKey, tokenId), retried, failures }
}
