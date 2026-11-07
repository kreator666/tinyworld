import { config, ALL_CHAINS } from '../config'
import { listPets, sumPrincipalYocto, updatePet, insertLedger } from '../db/survival'
import type { SurvivalPetRow } from '../db/survival'
import { applyDecay } from './survival'
import { estimateDecisionCostUsd } from './survivalCredits'
import { nearAgentAccountId } from '../chain/nearWrite'
import { totalStakedValueYocto } from '../chain/metapool'

// ============================================================
// 生存模式调度器(轻量版,仿 arenaScheduler 的两层思路但无 LLM):
// 每 survivalTickSeconds 扫所有 NEAR 链的 alive/weak 宠物:
// 1) applyDecay 物化衰减(可能触发 weak/dead)
// 2) 收益快照(每小时一次):热钱包质押总价值 - Σ本金 = 池子收益,按本金比例分摊 yield_yocto
// 3) dormant 判定:credits < 单次决策估算 → dormant(纯代码,不烧 credits)
// 崩溃恢复要求不高:收益分摊以 settings.lastYieldAt 为游标,重复扫描幂等。
// ============================================================

const YIELD_SNAPSHOT_INTERVAL_SEC = 3600 // 每小时快照一次(每分钟记太频繁)

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

function settingsOf(pet: SurvivalPetRow): Record<string, unknown> {
  return (pet.settings ?? {}) as Record<string, unknown>
}

/** 收益快照:池子收益 = 热钱包总质押价值 - Σ本金;按各宠物 principal 比例分摊记账 */
async function accrueYield(chainKey: string, pets: SurvivalPetRow[], nowSec: number): Promise<void> {
  const eligible = pets.filter((p) => p.status === 'alive' || p.status === 'weak' || p.status === 'dormant')
  if (eligible.length === 0) return
  const due = eligible.filter((p) => {
    const last = Number(settingsOf(p).lastYieldAt ?? 0)
    return nowSec - last >= YIELD_SNAPSHOT_INTERVAL_SEC
  })
  if (due.length === 0) return
  let totalStaked: bigint
  try {
    totalStaked = await totalStakedValueYocto(chainKey, nearAgentAccountId())
  } catch (err) {
    console.error(`[survival:${chainKey}] 收益快照读取质押价值失败:`, err instanceof Error ? err.message : err)
    return
  }
  const totalPrincipal = await sumPrincipalYocto(chainKey)
  const poolYield = totalStaked - totalPrincipal
  if (poolYield <= 0n) {
    // 无正收益也推进游标,避免每轮重复读链
    for (const p of due) {
      await updatePet(chainKey, Number(p.token_id), { settings: { ...settingsOf(p), lastYieldAt: nowSec } }).catch(() => {})
    }
    return
  }
  const sumPrincipalDue = due.reduce((acc, p) => acc + BigInt(p.principal_yocto), 0n)
  if (sumPrincipalDue <= 0n) return
  // 池子收益在"参与本轮快照的宠物"间按本金比例分摊(本金为 0 的不分)
  for (const p of due) {
    const delta = (poolYield * BigInt(p.principal_yocto)) / sumPrincipalDue
    if (delta <= 0n) continue
    await updatePet(chainKey, Number(p.token_id), {
      yield_yocto: (BigInt(p.yield_yocto) + delta).toString(),
      settings: { ...settingsOf(p), lastYieldAt: nowSec },
    })
    await insertLedger({
      chain_key: chainKey, token_id: p.token_id, kind: 'yield', amount_yocto: delta.toString(),
      credits_delta: '0', tx_hash: '', note: 'yield snapshot: 池子质押收益按本金比例分摊', ts: nowSec,
    }).catch(() => {})
  }
}

/** dormant 判定:活/弱状态且 credits 低于单次决策估算 → dormant(不烧 credits) */
async function markDormantIfBroke(pets: SurvivalPetRow[], estimateUsd: number, nowSec: number): Promise<void> {
  for (const p of pets) {
    if (p.status !== 'alive' && p.status !== 'weak') continue
    if (Number(p.credits_usd) >= estimateUsd) continue
    // 只标 dormant,不动四维;heal 折算收益或 admin 充值后可复活
    await updatePet(p.chain_key, Number(p.token_id), { status: 'dormant', last_decay_at: nowSec }).catch(() => {})
  }
}

async function tickSurvival(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const estimate = await estimateDecisionCostUsd()
    const nearChains = Object.entries(ALL_CHAINS)
      .filter(([, c]) => c.family === 'near')
      .map(([key]) => key)
    for (const chainKey of nearChains) {
      try {
        const pets = await listPets(chainKey, ['alive', 'weak', 'dormant'])
        // 1) 衰减物化(weak 可能转 dead)
        for (const p of pets) {
          await applyDecay(chainKey, Number(p.token_id)).catch((err) =>
            console.error(`[survival:${chainKey}] 衰减结算失败(token=${p.token_id}):`, err instanceof Error ? err.message : err),
          )
        }
        // 2) 收益快照(每小时;settings.lastYieldAt 游标)
        const fresh = await listPets(chainKey, ['alive', 'weak', 'dormant'])
        await accrueYield(chainKey, fresh, nowSec)
        // 3) dormant 判定
        await markDormantIfBroke(await listPets(chainKey, ['alive', 'weak']), estimate, nowSec)
      } catch (err) {
        console.error(`[survival:${chainKey}] 调度轮失败:`, err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    console.error('[survival] 调度轮失败:', err instanceof Error ? err.message : err)
  } finally {
    ticking = false
  }
}

export function startSurvivalScheduler(): void {
  if (!config.survivalEnabled) {
    console.log('生存模式已禁用(SURVIVAL_ENABLED=false),调度器不启动')
    return
  }
  const seconds = config.survivalTickSeconds
  console.log(`生存模式调度器已启动:每 ${seconds}s 扫描一轮`)
  tickSurvival().catch((err) => console.error('[survival] 首轮失败:', err))
  timer = setInterval(() => {
    tickSurvival().catch((err) => console.error('[survival] 调度轮失败:', err))
  }, seconds * 1000)
}

export function stopSurvivalScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
