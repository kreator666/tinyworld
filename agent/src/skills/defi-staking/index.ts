import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, parseEther, type Address } from 'viem'
import { getChainContext, chainKeyByChainId } from '../../chain/registry'
import { getNativeBalance, getTokenBalance, hasAgentKey, type UnsignedTx } from '../../chain/defi'
import { benqiCfg, buildUnsignedStake, executeStake, fetchStakingInfo, getStakingWalletAddress, quoteStake } from '../../chain/benqi'
import { getNativePriceUsd } from '../../core/price'
import { getSwapMode } from '../../core/settings'
import { createApproval } from '../../core/approvals'
import { evaluateProposal, type Proposal } from '../../policy/engine'
import { setPendingSignAction } from '../../core/agent'
import { loadPersona } from '../../chain/persona'
import { recordDefiTask } from '../defi-swap'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-staking:BENQI Liquid Staking(AVAX → sAVAX,仅 Avalanche 主网)
// - propose_stake:质押 AVAX 得 sAVAX(报价 → 策略引擎 → hot_wallet 自动 / user_wallet 签名)
// - staking_status:汇率 + sAVAX 余额(折 AVAX)+ 赎回冷却说明(只读)
// unstake/claim 不在 v1 开放:赎回是 ticket+claim 两段式(15 天冷却 + 2 天领取窗口),
// 交互复杂度高,留给 v2;staking_status 里向主人说明规则
// 权限:manifest 声明 ['defi'],同 defi-swap/lending,链上模块注册表未启用、由策略引擎兜底
// ============================================================

/** 估值:AVAX 数量 × 行情价 = USD(价格源失败返回 null = 熔断信号,策略引擎转人工) */
async function estimateValueUsd(chainKey: string, amount: bigint): Promise<number | null> {
  try {
    const { usd } = await getNativePriceUsd(chainKey)
    return Number(formatEther(amount)) * usd
  } catch {
    return null
  }
}

function formatSavax(v: bigint): string {
  return formatEther(v)
}

/** 质押提案 */
async function buildStakeProposal(
  chainKey: string,
  amountInHuman: string,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  const amount = parseEther(amountInHuman)
  if (amount <= 0n) throw new Error('amountAvax 必须大于 0')
  return {
    action: 'staking',
    protocol: cfg.benqi!.staking,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: 'native',
      tokenOut: cfg.benqi!.sAvax,
      amountIn: amount.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(chainKey, amount),
    reason,
  }
}

/** 执行已放行的质押提案(propose_stake 工具与审批 approve 端点共用) */
export async function executeStakingProposal(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
  // 多链重构:执行链按 proposal.chainId 路由(与请求链解耦)
  const execChainKey = chainKeyByChainId(proposal.chainId) ?? chainKey
  const amount = BigInt(proposal.params.amountIn)
  const result = await executeStake(execChainKey, amount)
  await recordDefiTask(execChainKey, tokenId, proposal, {
    txHash: result.txHash,
    amountOut: result.sAvaxOut.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash: result.txHash, amountOut: result.sAvaxOut.toString() }
}

/** 把完整 Proposal 中需要回传后端记 tasks 表的字段抽出来,附加到 sign_tx action */
function recordingProposal(p: Proposal) {
  return {
    action: p.action,
    protocol: p.protocol,
    chainId: p.chainId,
    params: p.params,
    executionMode: p.executionMode,
    estimatedValueUsd: p.estimatedValueUsd,
    reason: p.reason,
  }
}

/** propose_stake 工具(质押 AVAX 赚验证者奖励) */
function makeProposeStake(chainKey: string, tokenId: number) {
  return createTool({
    id: 'propose_stake',
    description:
      '把 AVAX 质押为 sAVAX(BENQI 流动性质押,仅 Avalanche 主网)。质押后持续累积验证者奖励,1 sAVAX 可兑换的 AVAX 随时间增长;sAVAX 可自由转让或作为 DeFi 抵押品。赎回需 15 天冷却 + 2 天领取窗口(v1 不开放赎回,主人问起时如实说明)。执行模式跟随「兑换执行模式」设置:热钱包自动执行,或主人钱包签名(返回 verdict=sign 时需主人点【签名并发送】)。限额/冷却/熔断由策略引擎把关,超限转审批中心。',
    inputSchema: z.object({
      amountAvax: z.string().describe('质押数量(人类单位,如 "0.5")'),
      reason: z.string().describe('这笔质押的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      amountOut: z.string().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      if (!cfg.benqi) return { verdict: 'rejected', error: `链 ${cfg.name} 未部署 BENQI Liquid Staking(仅 Avalanche 主网)` }
      let amount: bigint
      try {
        amount = parseEther(context.amountAvax)
      } catch {
        return { verdict: 'rejected', error: `数量不合法: ${context.amountAvax}` }
      }
      if (amount <= 0n) return { verdict: 'rejected', error: 'amountAvax 必须大于 0' }

      // 实时汇率报价(链上只读)
      let expectShares: bigint
      let info
      try {
        ;[expectShares, info] = await Promise.all([quoteStake(chainKey, amount), fetchStakingInfo(chainKey, getStakingWalletAddress() ?? '0x0000000000000000000000000000000000000000')])
      } catch (err) {
        return { verdict: 'rejected', error: `读取 BENQI 质押数据失败: ${err instanceof Error ? err.message : String(err)}` }
      }

      const executionMode = await getSwapMode(chainKey, tokenId)
      const proposal = await buildStakeProposal(chainKey, context.amountAvax, context.reason, executionMode)
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)
      const note = `这笔质押:\n- 质押 ${context.amountAvax} AVAX\n- 预计得 ≈${formatSavax(expectShares)} sAVAX(按当前汇率 1 sAVAX ≈ ${info.avaxPerSavax} AVAX,实际以成交时汇率为准)\n- 奖励持续累积,1 sAVAX 可兑换的 AVAX 会随时间变多\n- 赎回规则:15 天冷却 + 2 天领取窗口(v1 暂不支持赎回)`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式:组装交易,前端弹钱包签名 ----
      if (executionMode === 'user_wallet') {
        const persona = await loadPersona(chainKey, tokenId)
        const user = persona.owner as Address
        const userBalance = await getNativeBalance(chainKey, user)
        if (userBalance < amount + parseEther('0.01')) {
          return { verdict: 'rejected', error: `你的 AVAX 不足(需 ${context.amountAvax} + gas,当前 ${formatEther(userBalance)})` }
        }
        const unsignedTxs: UnsignedTx[] = [buildUnsignedStake(chainKey, amount)]
        proposal.unsignedTxs = unsignedTxs
        const action = {
          type: 'sign_tx' as const,
          unsignedTxs,
          note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认(1 笔交易)`,
          proposal: recordingProposal(proposal),
        }
        setPendingSignAction(chainKey, tokenId, action)
        return { verdict: 'sign', ...action }
      }

      // ---- 热钱包自动模式 ----
      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行质押' }
      }
      const wallet = getStakingWalletAddress()!
      const balance = await getNativeBalance(chainKey, wallet)
      if (balance < amount + parseEther('0.01')) {
        return { verdict: 'rejected', error: `热钱包 AVAX 不足(需 ${context.amountAvax} + gas,当前 ${formatEther(balance)})` }
      }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash, amountOut } = await executeStakingProposal(chainKey, tokenId, proposal)
      return {
        verdict,
        txHash,
        amountOut,
        note: `${note};已质押: ${cfg.explorer}/tx/${txHash}`,
      }
    },
  })
}

/** staking_status 只读查询:汇率 + sAVAX 余额(折 AVAX)+ 赎回规则说明(不经过策略引擎) */
function makeStakingStatus(chainKey: string, tokenId: number) {
  return createTool({
    id: 'staking_status',
    description:
      '查询 BENQI 流动性质押状态:当前汇率(1 sAVAX 可兑多少 AVAX)、本钱包 sAVAX 余额及折 AVAX、赎回冷却期说明。只读,不产生交易。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      rate: z.string(),
      sAvaxBalance: z.string(),
      sAvaxBalanceInAvax: z.string(),
      cooldownDays: z.number(),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.benqi) return { rate: '', sAvaxBalance: '0', sAvaxBalanceInAvax: '0', cooldownDays: 0, error: `链 ${cfg.name} 未部署 BENQI Liquid Staking(仅 Avalanche 主网)` }
        // 跟随兑换执行模式:user_wallet 查主人钱包,hot_wallet 查热钱包
        const mode = await getSwapMode(chainKey, tokenId)
        const wallet =
          mode === 'user_wallet' ? ((await loadPersona(chainKey, tokenId)).owner as Address) : getStakingWalletAddress()
        if (!wallet) return { rate: '', sAvaxBalance: '0', sAvaxBalanceInAvax: '0', cooldownDays: 0, error: '未配置执行密钥(AGENT_PRIVATE_KEY)' }
        const info = await fetchStakingInfo(chainKey, wallet)
        return {
          rate: info.avaxPerSavax,
          sAvaxBalance: formatSavax(info.sAvaxBalance),
          sAvaxBalanceInAvax: info.sAvaxBalanceInAvax,
          cooldownDays: Math.round(info.cooldownDays),
        }
      } catch (err) {
        return { rate: '', sAvaxBalance: '0', sAvaxBalanceInAvax: '0', cooldownDays: 0, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

export const defiStaking: SkillDef = {
  manifest: {
    id: 'defi-staking',
    name: 'AVAX 流动性质押',
    version: '0.1.0',
    description:
      'BENQI Liquid Staking:质押 AVAX 得 sAVAX,持续累积验证者奖励且可随时转让/抵押。sAVAX 汇率随奖励增长。执行模式跟随「兑换执行模式」设置。赎回(15 天冷却 + 2 天领取窗口)v1 不开放,仅支持质押与只读查询。',
    tools: ['propose_stake', 'staking_status'],
    permissions: ['defi'],
    scope: 'owner', // 资产操作,仅限主人对话
    evmOnly: true, // BENQI Liquid Staking 仅 EVM 主网部署
    protocol: 'benqi-staking', // chain_protocols 表 gating(fuji 不注册即隐藏;config 形如 {staking, sAvax})
    protocolRequired: true, // 主网专属:协议表无行即隐藏(fuji/sepolia 无 BENQI,无老配置可兜底)
  },
  makeTools: (chainKey, tokenId) => ({
    propose_stake: makeProposeStake(chainKey, tokenId),
    staking_status: makeStakingStatus(chainKey, tokenId),
  }),
}
