import { computeNav, type NavBreakdown } from './arenaNav'
import { arenaDailyPnl, latestSnapshotNav } from '../db/arena'
import type { EffectivePlaybook } from './arenaPlaybook'

// ============================================================
// 竞技场护栏评估(P4):调度器(decision 闸门)与技能(执行前检查)共用同一口径。
// 三类护栏(设计文档 §3.2):
//   maxDailyLossPct   日内已实现+浮动回撤 → 当日停止新开仓
//   maxDrawdownPct    赛季累计回撤(对本金)→ 强制降风险(只许降仓/转固收)
//   minCashBufferPct  现金缓冲下限(技能层在单个动作内检查,此处给出现金占比)
// ============================================================

export interface GuardState {
  navUsd: number
  nav: NavBreakdown
  dailyPnlUsd: number
  dailyLossPct: number // 当日回撤(已实现+浮动),正数 = 亏
  drawdownPct: number // 赛季累计回撤(对本金),正数 = 亏
  cashPct: number // 现金占比
  haltNewPositions: boolean // 日回撤触限:今日停止新开仓
  forceDeRisk: boolean // 累计回撤触限:只许降仓
  principalUsd: number
}

export async function evaluateGuardrails(
  chainKey: string,
  seasonId: string,
  tokenId: number,
  accountAddr: `0x${string}`,
  playbook: EffectivePlaybook,
  principalUsd: number,
): Promise<GuardState> {
  const nav = await computeNav(chainKey, accountAddr)
  const navUsd = nav.navUsd
  // 日内回撤 = 当日已实现盈亏 + (最新快照净值 − 当前净值)的当日浮动部分
  const dayStartNav = await latestSnapshotNav(seasonId, tokenId, principalUsd)
  const dailyPnlUsd = await arenaDailyPnl(seasonId, tokenId)
  const dailyLossPct = dayStartNav > 0 ? Math.max(0, ((dayStartNav + dailyPnlUsd - navUsd) / dayStartNav) * 100) : 0
  const drawdownPct = principalUsd > 0 ? Math.max(0, ((principalUsd - navUsd) / principalUsd) * 100) : 0
  const g = playbook.guardrails
  return {
    navUsd,
    nav,
    dailyPnlUsd,
    dailyLossPct,
    drawdownPct,
    cashPct: navUsd > 0 ? (nav.usdcUsd / navUsd) * 100 : 0,
    haltNewPositions: dailyLossPct >= g.maxDailyLossPct,
    forceDeRisk: drawdownPct >= g.maxDrawdownPct,
    principalUsd,
  }
}
