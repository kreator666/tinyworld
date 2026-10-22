// ============================================================
// Playbook 风险预设(P3,设计文档 §3.3):
// riskProfile 一键映射护栏与策略参数默认值;custom = owner 逐项手改。
// resolvePlaybook 输出"生效配置"(owner 给的值优先,缺的用预设补),
// 调度器(P4)与策略技能都消费这一个函数,保证全链路口径一致。
// ============================================================

export interface Guardrails {
  maxDailyLossPct: number // 日内净值回撤超阈值 → 当日停止交易
  maxDrawdownPct: number // 赛季累计回撤超阈值 → 策略降级/清盘转固收
  minCashBufferPct: number // 最低现金缓冲,低于则停止开仓
}

export interface StrategyDefaults {
  maxPositionPct: number // 单策略最大仓位(占净值)
  maxLeverage: number // 永续最大杠杆
  maxOrderPct: number // 单笔名义上限(占净值)
  takeProfitPct: number // 永续止盈
  stopLossPct: number // 永续止损
}

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'custom'

export const RISK_PRESETS: Record<Exclude<RiskProfile, 'custom'>, Guardrails & StrategyDefaults> = {
  conservative: {
    maxPositionPct: 20, maxLeverage: 2, maxOrderPct: 10, takeProfitPct: 8, stopLossPct: 4,
    maxDailyLossPct: 2, maxDrawdownPct: 15, minCashBufferPct: 40,
  },
  balanced: {
    maxPositionPct: 40, maxLeverage: 3, maxOrderPct: 15, takeProfitPct: 15, stopLossPct: 8,
    maxDailyLossPct: 5, maxDrawdownPct: 30, minCashBufferPct: 20,
  },
  aggressive: {
    maxPositionPct: 70, maxLeverage: 5, maxOrderPct: 25, takeProfitPct: 30, stopLossPct: 15,
    maxDailyLossPct: 10, maxDrawdownPct: 50, minCashBufferPct: 10,
  },
}

export interface EffectivePlaybook {
  riskProfile: RiskProfile
  allocation: Partial<Record<'fixed_yield' | 'perp' | 'spot', number>>
  strategies: Record<string, unknown>[]
  guardrails: Guardrails
  defaults: StrategyDefaults
}

/** owner 配置 + 预设默认值 → 生效配置(owner 显式给的值永远优先) */
export function resolvePlaybook(config: Record<string, unknown> | null | undefined): EffectivePlaybook {
  const c = (config ?? {}) as Record<string, unknown>
  const profile: RiskProfile = (c.riskProfile as RiskProfile) ?? 'balanced'
  const preset = RISK_PRESETS[profile as Exclude<RiskProfile, 'custom'>] ?? RISK_PRESETS.balanced
  const g = (c.guardrails ?? {}) as Record<string, unknown>
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt)
  return {
    riskProfile: profile,
    allocation: (c.allocation ?? {}) as EffectivePlaybook['allocation'],
    strategies: Array.isArray(c.strategies) ? (c.strategies as Record<string, unknown>[]) : [],
    guardrails: {
      maxDailyLossPct: num(g.maxDailyLossPct, preset.maxDailyLossPct),
      maxDrawdownPct: num(g.maxDrawdownPct, preset.maxDrawdownPct),
      minCashBufferPct: num(g.minCashBufferPct, preset.minCashBufferPct),
    },
    defaults: { ...preset },
  }
}
