import { ArenaError } from './arena'
import type { ArenaSeasonRow } from '../db/arena'
import { deductArenaFuel, getArenaFuel, lastFuelCost } from '../db/arena'
import type { LlmUsage } from './llm'

// ============================================================
// 竞技场燃料计费(P2)
// 本质 = 预算配给而非真实结算:9U 预付已在报名时划给平台,扣费决定的是
// "这 9U 能换多少 token、agent 能自主决策多久"。定价大致正比上游成本,
// 让"省上下文的高效 agent"获得真实的生存优势。
// 方案 B(已确认):燃料耗尽 = 决策停机(LLM 不再被调度),账户仍 active、
// 仓位继续赚收益,赛季末照常结算排名——燃料效率本身是一种可竞争策略。
// ============================================================

export interface FuelConfig {
  llmModel: string // 赛季固定模型,不允许换
  inputPerM: number // 输入单价 USDC / 1M tokens
  outputPerM: number // 输出单价 USDC / 1M tokens
  priceMarkup: number // 成本加成,可配(默认 1.0 = 纯配给)
  firstDecisionCostUsd: number // 无扣费历史时,首次 decision tick 的预估成本(调度门槛用)
}

const DEFAULT_PRICING = { inputPerM: 0.15, outputPerM: 0.45 } // 平台默认价目,赛季 config.llmPricing 可覆盖

/** 从赛季 config 解析燃料配置;缺项回落默认(固定模型必填,缺省用全局模型) */
export function fuelConfigOf(season: ArenaSeasonRow, globalModel: string): FuelConfig {
  const c = (season.config ?? {}) as Record<string, unknown>
  const pricing = (c.llmPricing ?? {}) as Record<string, unknown>
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt)
  return {
    llmModel: typeof c.llmModel === 'string' && c.llmModel ? c.llmModel : globalModel,
    inputPerM: num(pricing.inputPerM, DEFAULT_PRICING.inputPerM),
    outputPerM: num(pricing.outputPerM, DEFAULT_PRICING.outputPerM),
    priceMarkup: num(c.priceMarkup, 1.0),
    firstDecisionCostUsd: num(c.firstDecisionCostUsd, 0.01),
  }
}

/** 单次调用成本(USDC,6 decimals 向上取整):按模型查价 × 加成 */
export function costOfCall(cfg: FuelConfig, model: string, usage: LlmUsage): number {
  if (model !== cfg.llmModel) {
    throw new ArenaError(`赛季固定模型为 ${cfg.llmModel},不允许使用 ${model}`, 409)
  }
  const raw = ((usage.inputTokens / 1e6) * cfg.inputPerM + (usage.outputTokens / 1e6) * cfg.outputPerM) * cfg.priceMarkup
  // 浮点尾数修正(0.07500000000000001 不应取整成 0.075001),仍保持"向上取整到 6 decimals"语义
  return Math.ceil(raw * 1e6 - 1e-9) / 1e6
}

/** complete() 的 onUsage 回调:按实际用量扣费 + 记流水;余额不足抛 ArenaError */
export function makeFuelMeter(seasonId: string, tokenId: number, cfg: FuelConfig) {
  return async (usage: LlmUsage) => {
    const cost = costOfCall(cfg, cfg.llmModel, usage)
    try {
      await deductArenaFuel(seasonId, tokenId, {
        model: cfg.llmModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: String(cost),
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('燃料余额不足')) {
        throw new ArenaError('燃料余额不足,决策停机(已有仓位继续计收益)', 409)
      }
      throw err
    }
  }
}

export interface DecisionGate {
  ok: boolean
  balance: number
  estimate: number
  halted: boolean // true = 余额低于单次预估成本,决策停机(方案 B,不等于淘汰)
}

/** 调度门槛:余额 ≥ 预估下次成本才放行 decision tick */
export async function decisionGate(seasonId: string, tokenId: number, cfg: FuelConfig): Promise<DecisionGate> {
  const fuel = await getArenaFuel(seasonId, tokenId)
  const balance = fuel ? Number(fuel.balance_usd) : 0
  const estimate = (await lastFuelCost(seasonId, tokenId)) ?? cfg.firstDecisionCostUsd
  const ok = balance >= estimate
  return { ok, balance, estimate, halted: !ok }
}
