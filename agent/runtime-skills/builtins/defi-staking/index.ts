import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, parseEther, type Address, type Hex } from 'viem'
import { getChainContext, chainKeyByChainId } from '../../../src/chain/registry'
import { getNativeBalance, getTokenBalance, hasAgentKey, type UnsignedTx } from '../../../src/chain/defi'
import {
  benqiCfg,
  buildUnsignedStake,
  buildUnsignedRequestUnlock,
  buildUnsignedRedeem,
  buildUnsignedRedeemOverdueShares,
  executeStake,
  executeRequestUnlock,
  executeRedeem,
  executeRedeemOverdueShares,
  fetchStakingInfo,
  fetchUnlockRequests,
  classifyUnlockRequests,
  getStakingWalletAddress,
  quoteStake,
  type UnlockRequestWithStatus,
} from '../../../src/chain/benqi'
import { getNativePriceUsd } from '../../../src/core/price'
import { getSwapMode } from '../../../src/core/settings'
import { createApproval } from '../../../src/core/approvals'
import { evaluateProposal, type Proposal } from '../../../src/policy/engine'
import { setPendingSignAction } from '../../../src/core/agent'
import { loadPersona } from '../../../src/chain/persona'
import { recordDefiTask } from '../defi-swap'
import { getDb } from '../../../src/db'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-staking:BENQI Liquid Staking(AVAX ↔ sAVAX,仅 Avalanche 主网)
// - propose_stake:质押 AVAX 得 sAVAX
// - propose_unstake:发起赎回(requestUnlock),sAVAX 进入 15 天冷却
// - check_unstake:查询所有 unlock 请求状态(冷却中/可领取/已过期)
// - claim_unstake:领取可领 AVAX,或退回过期的 sAVAX
// - staking_status:汇率 + sAVAX 余额(折 AVAX)+ 赎回规则说明(只读)
// 执行模式跟随「兑换执行模式」设置:hot_wallet 自动 / user_wallet 签名
// 权限:manifest 声明 ['defi'],链上模块注册表未启用、由策略引擎兜底
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

function walletAddressFor(chainKey: string, tokenId: number, mode: Proposal['executionMode']): Address | null {
  if (mode === 'user_wallet') {
    return null // 需异步 loadPersona
  }
  return getStakingWalletAddress()
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

/** 发起赎回提案 */
async function buildUnstakeProposal(
  chainKey: string,
  amountSavaxHuman: string,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  const amount = parseEther(amountSavaxHuman)
  if (amount <= 0n) throw new Error('amountSavax 必须大于 0')
  // 赎回的价值按当前 sAVAX 折 AVAX 估算
  const estimatedValueUsd = await estimateValueUsd(chainKey, amount)
  return {
    action: 'unstake',
    protocol: cfg.benqi!.staking,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: cfg.benqi!.sAvax,
      tokenOut: 'native',
      amountIn: amount.toString(),
    },
    estimatedValueUsd,
    reason,
  }
}

/** 领取/退回赎回提案 */
async function buildClaimStakeProposal(
  chainKey: string,
  reason: string,
  executionMode: Proposal['executionMode'],
  claimAvaxShares: bigint,
  overdueShares: bigint,
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  // claim_unstake 的估值取两者中较大者作为风控参考(实际领取金额以链上为准)
  const totalShares = claimAvaxShares + overdueShares
  const estimatedValueUsd = totalShares > 0n ? await estimateValueUsd(chainKey, totalShares) : 0
  return {
    action: 'claim_stake',
    protocol: cfg.benqi!.staking,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: 'native',
      tokenOut: 'native',
      amountIn: totalShares.toString(),
    },
    estimatedValueUsd,
    reason,
  }
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

// ============================================================
// 执行已放行的提案
// ============================================================

/** 执行已放行的质押提案 */
export async function executeStakingProposal(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
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

/** 执行已放行的发起赎回提案,并把 ticket 写入 DB */
export async function executeUnstakeProposal(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
  owner: Address,
): Promise<{ txHash: string; sharesLocked: string }> {
  const execChainKey = chainKeyByChainId(proposal.chainId) ?? chainKey
  const shares = BigInt(proposal.params.amountIn)
  const result = await executeRequestUnlock(execChainKey, shares)

  // 计算 claimable_at / expires_at(从链上读,避免配置漂移)
  const requests = await fetchUnlockRequests(execChainKey, owner)
  const latest = requests
    .filter((r) => r.startedAt === BigInt(Math.floor(Date.now() / 1000)) || r.shareAmount === shares)
    .pop()
  const claimableAt = latest?.claimableAt ?? new Date(Date.now() + 15 * 86400 * 1000)
  const expiresAt = latest?.expiresAt ?? new Date(Date.now() + 17 * 86400 * 1000)

  const db = await getDb()
  await db.query(
    `INSERT INTO benqi_unlock_requests
       (id, chain_key, token_id, owner, request_tx_hash, shares, requested_at, claimable_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, 'cooling')`,
    [result.txHash, execChainKey, tokenId, owner.toLowerCase(), result.txHash, shares.toString(), claimableAt, expiresAt],
  )

  await recordDefiTask(execChainKey, tokenId, proposal, {
    txHash: result.txHash,
    amountOut: '0',
    sharesLocked: shares.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash: result.txHash, sharesLocked: shares.toString() }
}

/** 执行已放行的领取/退回赎回提案 */
export async function executeClaimStakeProposal(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
  owner: Address,
): Promise<{ txHash: string; avaxOut: string; sharesReturned: string }> {
  const execChainKey = chainKeyByChainId(proposal.chainId) ?? chainKey
  const requests = await fetchUnlockRequests(execChainKey, owner)
  const { claimableShares, expiredShares } = classifyUnlockRequests(requests)

  let avaxTxHash: Hex | undefined
  let overdueTxHash: Hex | undefined

  if (claimableShares > 0n) {
    const r = await executeRedeem(execChainKey)
    avaxTxHash = r.txHash
  }
  if (expiredShares > 0n) {
    const r = await executeRedeemOverdueShares(execChainKey)
    overdueTxHash = r.txHash
  }

  // 刷新 DB 状态:把该 owner 下所有 claimable/expired 行更新
  const db = await getDb()
  if (claimableShares > 0n && avaxTxHash) {
    await db.query(
      `UPDATE benqi_unlock_requests
       SET status = 'claimed', claimed_at = now(), claim_tx_hash = $1
       WHERE chain_key = $2 AND token_id = $3 AND owner = $4 AND status = 'claimable'`,
      [avaxTxHash, execChainKey, tokenId, owner.toLowerCase()],
    )
  }
  if (expiredShares > 0n && overdueTxHash) {
    await db.query(
      `UPDATE benqi_unlock_requests
       SET status = 'expired_returned', overdue_returned_at = now(), overdue_tx_hash = $1
       WHERE chain_key = $2 AND token_id = $3 AND owner = $4 AND status = 'expired'`,
      [overdueTxHash, execChainKey, tokenId, owner.toLowerCase()],
    )
  }

  // 用 claim_stake 的 txHash 取前者(优先 AVAX 领取)
  const txHash = avaxTxHash ?? overdueTxHash!
  await recordDefiTask(execChainKey, tokenId, proposal, {
    txHash,
    amountOut: '0',
    avaxOut: '0', // 前端/查询时再读链上
    sharesReturned: expiredShares.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash, avaxOut: '0', sharesReturned: expiredShares.toString() }
}

// ============================================================
// 工具
// ============================================================

/** propose_stake 工具(质押 AVAX 赚验证者奖励) */
function makeProposeStake(chainKey: string, tokenId: number) {
  return createTool({
    id: 'propose_stake',
    description:
      '把 AVAX 质押为 sAVAX(BENQI 流动性质押,仅 Avalanche 主网)。质押后持续累积验证者奖励,1 sAVAX 可兑换的 AVAX 随时间增长;sAVAX 可自由转让或作为 DeFi 抵押品。赎回需先 propose_unstake 发起,15 天冷却 + 2 天领取窗口。执行模式跟随「兑换执行模式」设置:热钱包自动执行,或主人钱包签名(返回 verdict=sign 时需主人点【签名并发送】)。限额/冷却/熔断由策略引擎把关,超限转审批中心。',
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
      const note = `这笔质押:\n- 质押 ${context.amountAvax} AVAX\n- 预计得 ≈${formatSavax(expectShares)} sAVAX(按当前汇率 1 sAVAX ≈ ${info.avaxPerSavax} AVAX,实际以成交时汇率为准)\n- 奖励持续累积,1 sAVAX 可兑换的 AVAX 会随时间变多\n- 赎回规则:先 propose_unstake 发起,15 天冷却 + 2 天领取窗口`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式 ----
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

/** propose_unstake 工具:发起赎回,把 sAVAX 锁进合约进入 15 天冷却 */
function makeProposeUnstake(chainKey: string, tokenId: number) {
  return createTool({
    id: 'propose_unstake',
    description:
      '发起 BENQI sAVAX 赎回。会把指定数量的 sAVAX 转入合约托管,进入 15 天冷却期;冷却结束后有 2 天领取窗口,可用 claim_unstake 取回 AVAX。若错过窗口,sAVAX 会退回钱包,需重新发起。执行模式跟随「兑换执行模式」设置。',
    inputSchema: z.object({
      amountSavax: z.string().describe('赎回数量(人类单位,如 "0.5")'),
      reason: z.string().describe('这笔赎回的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      sharesLocked: z.string().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      if (!cfg.benqi) return { verdict: 'rejected', error: `链 ${cfg.name} 未部署 BENQI Liquid Staking(仅 Avalanche 主网)` }
      let amount: bigint
      try {
        amount = parseEther(context.amountSavax)
      } catch {
        return { verdict: 'rejected', error: `数量不合法: ${context.amountSavax}` }
      }
      if (amount <= 0n) return { verdict: 'rejected', error: 'amountSavax 必须大于 0' }

      const executionMode = await getSwapMode(chainKey, tokenId)
      const owner =
        executionMode === 'user_wallet'
          ? ((await loadPersona(chainKey, tokenId)).owner as Address)
          : (getStakingWalletAddress() ?? '0x0000000000000000000000000000000000000000')

      const balance = await getTokenBalance(chainKey, cfg.benqi.sAvax as Address, owner as Address)
      if (balance < amount) {
        return { verdict: 'rejected', error: `sAVAX 余额不足:需 ${context.amountSavax},当前 ${formatEther(balance)}` }
      }

      const proposal = await buildUnstakeProposal(chainKey, context.amountSavax, context.reason, executionMode)
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)
      const note = `这笔赎回:\n- 发起赎回 ${context.amountSavax} sAVAX\n- 进入 15 天冷却期\n- 冷却结束后 2 天内可用 claim_unstake 领取 AVAX\n- 错过窗口将退回 sAVAX,需重新发起`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式 ----
      if (executionMode === 'user_wallet') {
        const unsignedTxs: UnsignedTx[] = [buildUnsignedRequestUnlock(chainKey, amount)]
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
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行赎回' }
      }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash, sharesLocked } = await executeUnstakeProposal(chainKey, tokenId, proposal, owner as Address)
      return {
        verdict,
        txHash,
        sharesLocked,
        note: `${note};已发起赎回: ${cfg.explorer}/tx/${txHash}`,
      }
    },
  })
}

/** check_unstake 工具:只读查询所有 unlock 请求状态 */
function makeCheckUnstake(chainKey: string, tokenId: number) {
  return createTool({
    id: 'check_unstake',
    description:
      '查询 BENQI 流动性质押的赎回 ticket 状态:冷却中(cooling)、可领取(claimable)、已过期(expired)。只读,不产生交易。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      summary: z.string(),
      requests: z.array(z.object({
        index: z.number(),
        shareAmount: z.string(),
        status: z.string(),
        claimableAt: z.string(),
        expiresAt: z.string(),
      })),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.benqi) return { summary: '', requests: [], error: `链 ${cfg.name} 未部署 BENQI Liquid Staking` }
        const mode = await getSwapMode(chainKey, tokenId)
        const owner =
          mode === 'user_wallet'
            ? ((await loadPersona(chainKey, tokenId)).owner as Address)
            : (getStakingWalletAddress() ?? '0x0000000000000000000000000000000000000000')
        if (!owner || owner === '0x0000000000000000000000000000000000000000') {
          return { summary: '', requests: [], error: '未配置执行密钥或无法确定 owner' }
        }
        const requests = await fetchUnlockRequests(chainKey, owner as Address)
        const { claimable, expired, cooling, claimableShares, expiredShares } = classifyUnlockRequests(requests)
        const summary =
          `共 ${requests.length} 笔赎回:冷却中 ${cooling.length} 笔,可领取 ${claimable.length} 笔(` +
          `${formatEther(claimableShares)} sAVAX),已过期 ${expired.length} 笔(${formatEther(expiredShares)} sAVAX)`
        return {
          summary,
          requests: requests.map((r) => ({
            index: r.index,
            shareAmount: formatEther(r.shareAmount),
            status: r.status,
            claimableAt: r.claimableAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
          })),
        }
      } catch (err) {
        return { summary: '', requests: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

/** claim_unstake 工具:领取可领 AVAX,或退回过期 sAVAX */
function makeClaimUnstake(chainKey: string, tokenId: number) {
  return createTool({
    id: 'claim_unstake',
    description:
      '执行 BENQI 赎回的第二阶段:若有可领取(claimable)的 ticket,领取 AVAX;若有过期(expired)的 ticket,退回 sAVAX。执行模式跟随「兑换执行模式」设置。',
    inputSchema: z.object({
      reason: z.string().describe('这次领取/退回的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      avaxOut: z.string().optional(),
      sharesReturned: z.string().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      if (!cfg.benqi) return { verdict: 'rejected', error: `链 ${cfg.name} 未部署 BENQI Liquid Staking(仅 Avalanche 主网)` }

      const executionMode = await getSwapMode(chainKey, tokenId)
      const owner =
        executionMode === 'user_wallet'
          ? ((await loadPersona(chainKey, tokenId)).owner as Address)
          : (getStakingWalletAddress() ?? '0x0000000000000000000000000000000000000000')
      if (!owner || owner === '0x0000000000000000000000000000000000000000') {
        return { verdict: 'rejected', error: '未配置执行密钥或无法确定 owner' }
      }

      const requests = await fetchUnlockRequests(chainKey, owner as Address)
      const { claimable, expired, claimableShares, expiredShares } = classifyUnlockRequests(requests)
      if (claimableShares === 0n && expiredShares === 0n) {
        return { verdict: 'rejected', error: '当前没有可领取或可退回的 BENQI 赎回' }
      }

      const proposal = await buildClaimStakeProposal(
        chainKey,
        context.reason,
        executionMode,
        claimableShares,
        expiredShares,
      )
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)

      const parts: string[] = []
      if (claimableShares > 0n) parts.push(`可领取 AVAX: ${formatEther(claimableShares)} sAVAX 份额`)
      if (expiredShares > 0n) parts.push(`已过期退回: ${formatEther(expiredShares)} sAVAX 份额`)
      const note = `这次操作:\n${parts.join('\n')}`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式 ----
      if (executionMode === 'user_wallet') {
        const unsignedTxs: UnsignedTx[] = []
        if (claimableShares > 0n) unsignedTxs.push(buildUnsignedRedeem(chainKey))
        if (expiredShares > 0n) unsignedTxs.push(buildUnsignedRedeemOverdueShares(chainKey))
        proposal.unsignedTxs = unsignedTxs
        const action = {
          type: 'sign_tx' as const,
          unsignedTxs,
          note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认(${unsignedTxs.length} 笔交易)`,
          proposal: recordingProposal(proposal),
        }
        setPendingSignAction(chainKey, tokenId, action)
        return { verdict: 'sign', ...action }
      }

      // ---- 热钱包自动模式 ----
      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行领取' }
      }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash, avaxOut, sharesReturned } = await executeClaimStakeProposal(
        chainKey,
        tokenId,
        proposal,
        owner as Address,
      )
      return {
        verdict,
        txHash,
        avaxOut,
        sharesReturned,
        note: `${note};已执行: ${cfg.explorer}/tx/${txHash}`,
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
    name: 'AVAX 流动性质押与赎回',
    version: '0.2.0',
    description:
      'BENQI Liquid Staking:质押 AVAX 得 sAVAX,持续累积验证者奖励;支持完整赎回闭环:propose_unstake 发起赎回(15 天冷却)、check_unstake 查询状态、claim_unstake 领取 AVAX 或退回过期 sAVAX。执行模式跟随「兑换执行模式」设置。',
    tools: ['propose_stake', 'propose_unstake', 'check_unstake', 'claim_unstake', 'staking_status'],
    permissions: ['defi'],
    scope: 'owner', // 资产操作,仅限主人对话
    evmOnly: true, // BENQI Liquid Staking 仅 EVM 主网部署
    protocol: 'benqi-staking', // chain_protocols 表 gating(fuji 不注册即隐藏)
    protocolRequired: true, // 主网专属:协议表无行即隐藏
  },
  makeTools: (chainKey, tokenId) => ({
    propose_stake: makeProposeStake(chainKey, tokenId),
    propose_unstake: makeProposeUnstake(chainKey, tokenId),
    check_unstake: makeCheckUnstake(chainKey, tokenId),
    claim_unstake: makeClaimUnstake(chainKey, tokenId),
    staking_status: makeStakingStatus(chainKey, tokenId),
  }),
}
