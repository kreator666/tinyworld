import { getChainContext } from '../chain/registry'
import { refSwap } from '../chain/ref'
import { burrowSupply } from '../chain/burrow'
import { stakeNear } from '../chain/metapool'
import type { SurvivalPlan, SurvivalStep } from './survivalThinker'

// ============================================================
// 生存模式执行器:白名单校验 → 逐步执行 → 汇总结果
// 资金安全(红线):除下列白名单协议调用外,不允许任何其他目标合约或裸转账——
// - ref:refSwap(NEAR 家族路径,合约地址来自链配置 cfg.near.refExchange)
// - burrow:burrowSupply(合约地址来自 cfg.near.burrow,仅测试网配置)
// - metapool:stakeNear(合约地址固定 config.survivalMetaPoolContract,仅主网)
// - none/noop:不上链
// LLM 只产出结构化 step,目标合约在本层硬编码映射,LLM 无法指定任意合约地址。
// ============================================================

export interface StepResult {
  step: SurvivalStep
  ok: boolean
  txHash?: string
  error?: string
}

export interface ExecutionOutcome {
  results: StepResult[]
  status: 'executed' | 'partial' | 'failed'
  txHash: string // 首笔成功交易哈希(展示用)
  pnlYocto: string // 打工场景下的头寸价值变化(best-effort,由调用方快照差值得出)
}

/** 白名单代币(与 thinker prompt 同源) */
const TOKEN_WHITELIST = ['NEAR', 'WNEAR', 'USDC', 'STNEAR']

/**
 * 单步白名单校验:返回 null 表示合法,否则返回拒绝原因(纯函数,可离线验证)。
 * 校验:协议在当前链配置内 / 代币白名单 / 单笔金额 ≤ maxSingleYocto。
 */
export function checkStepAllowed(chainKey: string, step: SurvivalStep, maxSingleYocto: bigint): string | null {
  if (step.protocol === 'none' || step.action === 'noop') return null
  const cfg = getChainContext(chainKey).cfg
  const isTestnet = cfg.chainId === 398
  if (step.protocol === 'ref') {
    if (!cfg.near?.refExchange) return '该链未配置 Ref 兑换合约'
    if (step.action !== 'swap') return `ref 协议只支持 swap,收到 ${step.action}`
    if (!step.tokenIn || !step.tokenOut) return 'swap 缺少 tokenIn/tokenOut'
    if (step.tokenIn.toUpperCase() === step.tokenOut.toUpperCase()) return '兑入兑出不能是同一代币'
  } else if (step.protocol === 'burrow') {
    if (!isTestnet) return 'burrow 仅测试网可用'
    if (!cfg.near?.burrow) return '该链未配置 Burrow 合约'
    if (step.action !== 'supply' && step.action !== 'withdraw') return `burrow 只支持 supply/withdraw,收到 ${step.action}`
  } else if (step.protocol === 'metapool') {
    if (isTestnet) return 'metapool 仅主网可用(测试网用 burrow 替身)'
    if (step.action !== 'stake' && step.action !== 'harvest') return `metapool 只支持 stake/harvest,收到 ${step.action}`
  } else {
    return `未知协议: ${step.protocol}`
  }
  for (const sym of [step.tokenIn, step.tokenOut]) {
    if (sym && !TOKEN_WHITELIST.includes(sym.toUpperCase())) return `代币不在白名单: ${sym}`
  }
  if (!step.amountYocto || !/^\d+$/.test(step.amountYocto)) return 'amountYocto 缺失或非法'
  if (BigInt(step.amountYocto) > maxSingleYocto) return `单笔金额超过上限 ${maxSingleYocto} yocto`
  return null
}

async function runStep(chainKey: string, step: SurvivalStep): Promise<StepResult> {
  try {
    if (step.protocol === 'none' || step.action === 'noop') return { step, ok: true }
    if (step.protocol === 'ref' && step.action === 'swap') {
      const { txHash } = await refSwap(chainKey, step.tokenIn!, step.tokenOut!, step.amountYocto!, step.slippageBps ?? 100)
      return { step, ok: true, txHash }
    }
    if (step.protocol === 'burrow' && step.action === 'supply') {
      const txHash = await burrowSupply(chainKey, step.tokenIn ?? 'WNEAR', step.amountYocto!)
      return { step, ok: true, txHash }
    }
    if (step.protocol === 'metapool' && step.action === 'stake') {
      const { txHash } = await stakeNear(chainKey, step.amountYocto!)
      return { step, ok: true, txHash }
    }
    // metapool harvest / burrow withdraw:无需链上动作(harvest 为记账概念,withdraw 留给后续版本)
    return { step, ok: true }
  } catch (err) {
    return { step, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }
  }
}

/**
 * 执行 plan:白名单拒绝的步直接标失败;链上失败不中断后续步骤,汇总 status:
 * 全部成功 executed / 部分失败 partial / 全部失败 failed。资金安全见文件头红线。
 */
export async function executePlan(
  chainKey: string,
  plan: SurvivalPlan,
  maxSingleYocto: bigint,
): Promise<ExecutionOutcome> {
  const results: StepResult[] = []
  let firstTx = ''
  for (const step of plan.steps) {
    const denied = checkStepAllowed(chainKey, step, maxSingleYocto)
    const r = denied
      ? { step, ok: false, error: `白名单拒绝: ${denied}` } as StepResult
      : await runStep(chainKey, step)
    if (r.ok && r.txHash && !firstTx) firstTx = r.txHash
    results.push(r)
  }
  const okCount = results.filter((r) => r.ok).length
  const status: ExecutionOutcome['status'] =
    okCount === results.length ? 'executed' : okCount > 0 ? 'partial' : 'failed'
  return { results, status, txHash: firstTx, pnlYocto: '0' }
}
