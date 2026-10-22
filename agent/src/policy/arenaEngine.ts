import { checkProposalHardRules, type Proposal, type Verdict } from './engine'

// ============================================================
// 竞技场策略引擎变体(P3,设计文档 §6):
// 与主人模式 evaluateProposal 共用同一套硬规则(链/协议/代币白名单,engine.ts 导出),
// 差异 = 砍掉所有软规则(单笔/日累计限额、冷却、人工审批)——自主竞技模式下
// 这些约束由燃料经济 + Playbook 护栏 + 链上白名单承担。
// 估值失败(no human to approve)= 拒绝执行(主人模式是转人工)。
// ============================================================

export async function evaluateArenaProposal(chainKey: string, p: Proposal): Promise<Verdict> {
  const hardFail = await checkProposalHardRules(chainKey, p)
  if (hardFail.length > 0) return { verdict: 'rejected', reasons: hardFail }
  if (p.estimatedValueUsd === null) {
    return { verdict: 'rejected', reasons: ['价格源不可用(熔断),自主模式无人工审批,拒绝执行'] }
  }
  return { verdict: 'execute', reasons: [] }
}
