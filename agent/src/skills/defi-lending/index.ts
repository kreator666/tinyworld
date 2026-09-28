import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from 'viem'
import { config } from '../../config'
import { getDb } from '../../db'
import {
  getATokenBalance,
  getLendingWalletAddress,
  getReserveInfo,
  getTokenAllowance,
  supplyErc20,
  supplyNative,
  withdrawErc20,
  withdrawNative,
  type ReserveInfo,
} from '../../chain/aave'
import { getNativeBalance, getTokenBalance, hasAgentKey } from '../../chain/defi'
import { getAvaxPriceUsd } from '../../core/price'
import { createApproval } from '../../core/approvals'
import { evaluateProposal, type Proposal } from '../../policy/engine'
import { recordDefiTask } from '../defi-swap'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-lending(M4+):Aave v3 借贷理财
// - supply: 热钱包资金存入 Aave 赚供给收益(Supply APY),AVAX 走 Gateway、ERC20 直接 supply
// - withdraw: 连本带息取回(利息由 aToken 余额自动累积)
// - position: 只读查询当前存款仓位与实时 APY
// 权限:manifest 声明 ['defi'],同 defi-swap,链上模块注册表未启用、由策略引擎兜底
// ============================================================

const USDC_DECIMALS = 6

/** 代币符号 → 地址/USDC/WAVAX/AVAX(原生);无法识别返回 null */
function resolveToken(symbolOrAddress: string): { address: Address; isNative: boolean } | null {
  const s = symbolOrAddress.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { address: s as Address, isNative: false }
  const { wNative, usdc } = config.chain.defi
  if (['AVAX', 'ETH', 'NATIVE'].includes(s.toUpperCase())) return { address: wNative, isNative: true }
  if (s.toUpperCase() === 'USDC') return { address: usdc, isNative: false }
  if (['WAVAX', 'WETH', 'WNATIVE'].includes(s.toUpperCase())) return { address: wNative, isNative: false }
  return null
}

function symbolOf(token: { isNative: boolean; address: Address }): string {
  if (token.isNative) return config.chain.defi.nativeSymbol
  return token.address.toLowerCase() === config.chain.defi.usdc.toLowerCase() ? 'USDC' : 'WAVAX'
}

/** 估值:USDC 按 $1;AVAX/WAVAX 按行情价。价格源失败返回 null(熔断信号) */
async function estimateValueUsd(amount: bigint, isNative: boolean, isUsdc: boolean): Promise<number | null> {
  if (isUsdc) return Number(formatUnits(amount, USDC_DECIMALS))
  if (!isNative) return null // WAVAX 理论上可按 AVAX 价估,首期只支持 AVAX 原生与 USDC,防御
  try {
    const { usd } = await getAvaxPriceUsd()
    return Number(formatEther(amount)) * usd
  } catch {
    return null
  }
}

/** 已执行的借贷操作落 tasks 表(审计 + 策略引擎日累计/冷却的数据源) */
async function recordLendingTask(
  tokenId: number,
  proposal: Proposal,
  result: { txHash: string; amount: string; usdValue: number | null },
) {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6)', [
    randomUUID(),
    tokenId,
    'defi',
    'done',
    JSON.stringify({ action: proposal.action, params: proposal.params, reason: proposal.reason }),
    JSON.stringify(result),
  ])
}

/** supply 提案 */
async function buildSupplyProposal(
  token: { address: Address; isNative: boolean },
  amountInHuman: string,
  reason: string,
): Promise<Proposal> {
  const decimals = token.isNative ? 18 : USDC_DECIMALS
  const amount = token.isNative ? parseEther(amountInHuman) : parseUnits(amountInHuman, decimals)
  if (amount <= 0n) throw new Error('amountIn 必须大于 0')
  const isUsdc = !token.isNative && token.address.toLowerCase() === config.chain.defi.usdc.toLowerCase()
  return {
    action: 'supply',
    protocol: config.chain.aave.pool,
    chainId: config.chain.chainId,
    executionMode: 'hot_wallet',
    params: {
      tokenIn: token.isNative ? 'native' : token.address,
      tokenOut: config.chain.defi.nativeSymbol === 'AVAX' ? 'aToken(WAVAX)' : 'aToken',
      amountIn: amount.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(amount, token.isNative, isUsdc),
    reason,
  }
}

/** withdraw 提案 */
async function buildWithdrawProposal(
  token: { address: Address; isNative: boolean },
  amountInHuman: string,
  reason: string,
): Promise<Proposal> {
  const decimals = token.isNative ? 18 : USDC_DECIMALS
  const amount = token.isNative ? parseEther(amountInHuman) : parseUnits(amountInHuman, decimals)
  if (amount <= 0n) throw new Error('amountIn 必须大于 0')
  const isUsdc = !token.isNative && token.address.toLowerCase() === config.chain.defi.usdc.toLowerCase()
  return {
    action: 'withdraw',
    protocol: config.chain.aave.pool,
    chainId: config.chain.chainId,
    executionMode: 'hot_wallet',
    params: {
      tokenIn: token.isNative ? 'native' : token.address,
      tokenOut: token.isNative ? 'native' : token.address,
      amountIn: amount.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(amount, token.isNative, isUsdc),
    reason,
  }
}

/** 执行已放行的借贷提案(工具 execute 分支和审批 approve 端点共用) */
export async function executeLendingProposal(
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
  const isNative = proposal.params.tokenIn === 'native'
  const asset = (isNative ? config.chain.defi.wNative : proposal.params.tokenIn) as Address
  const amount = BigInt(proposal.params.amountIn)
  const result = isNative
    ? proposal.action === 'supply'
      ? await supplyNative(amount)
      : await withdrawNative(amount)
    : proposal.action === 'supply'
      ? await supplyErc20(asset, amount)
      : await withdrawErc20(asset, amount)
  await recordLendingTask(tokenId, proposal, {
    txHash: result.txHash,
    amount: result.delta.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash: result.txHash, amountOut: result.delta.toString() }
}

/** propose_supply 工具(存入赚收益) */
function makeProposeSupply(tokenId: number) {
  return createTool({
    id: 'propose_supply',
    description:
      '把热钱包资金存入 Aave 赚供给收益(类似银行活期理财)。支持 AVAX 和 USDC。限额/冷却/熔断由策略引擎把关,超限会转审批中心由主人放行。',
    inputSchema: z.object({
      tokenIn: z.string().describe('存入币种:AVAX 或 USDC'),
      amountIn: z.string().describe('存入数量(人类单位,如 "0.05")'),
      reason: z.string().describe('这笔存款的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      amountOut: z.string().optional(),
      apy: z.number().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const token = resolveToken(context.tokenIn)
      if (!token) return { verdict: 'rejected', error: `无法识别的币种: ${context.tokenIn}(支持 AVAX/USDC)` }

      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行存款' }
      }
      const wallet = getLendingWalletAddress()!

      // 余额预检(链上只读)
      const decimals = token.isNative ? 18 : USDC_DECIMALS
      const amount = token.isNative ? parseEther(context.amountIn) : parseUnits(context.amountIn, decimals)
      const balance = token.isNative ? await getNativeBalance(wallet) : await getTokenBalance(token.address, wallet)
      if (token.isNative) {
        // 原生币要预留 gas(按 0.01 估算)
        if (balance < amount + parseEther('0.01')) {
          return { verdict: 'rejected', error: `热钱包 AVAX 不足(需 ${context.amountIn} + gas,当前 ${formatEther(balance)})` }
        }
      } else if (balance < amount) {
        return { verdict: 'rejected', error: `热钱包 ${symbolOf(token)} 不足(需 ${context.amountIn},当前 ${formatUnits(balance, decimals)})` }
      }

      // 实时 APY 报价(链上只读)
      let reserve: ReserveInfo
      try {
        reserve = await getReserveInfo(token.address)
      } catch (err) {
        return { verdict: 'rejected', error: `读取 Aave 储备数据失败: ${err instanceof Error ? err.message : String(err)}` }
      }

      const proposal = await buildSupplyProposal(token, context.amountIn, context.reason)
      const { verdict, reasons } = await evaluateProposal(proposal)
      const note = `当前 ${symbolOf(token)} 供给 APY ≈ ${(reserve.supplyApy * 100).toFixed(2)}%,估值 $${proposal.estimatedValueUsd?.toFixed(4) ?? '未知'}`
      if (verdict === 'rejected') return { verdict, reasons, note }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash } = await executeLendingProposal(tokenId, proposal)
      return {
        verdict,
        txHash,
        apy: reserve.supplyApy,
        note: `${note};已存入: ${config.chain.explorer}/tx/${txHash}`,
      }
    },
  })
}

/** propose_withdraw 工具(取出) */
function makeProposeWithdraw(tokenId: number) {
  return createTool({
    id: 'propose_withdraw',
    description:
      '从 Aave 取回存款(连本带息,利息已按 aToken 余额自动累积)。支持 AVAX 和 USDC。限额/冷却由策略引擎把关,超限会转审批中心。',
    inputSchema: z.object({
      tokenOut: z.string().describe('取回币种:AVAX 或 USDC'),
      amountOut: z.string().describe('取回数量(人类单位,如 "0.05");输入 "all" 取回全部'),
      reason: z.string().describe('取出的理由(会写进审计记录)'),
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
      const token = resolveToken(context.tokenOut)
      if (!token) return { verdict: 'rejected', error: `无法识别的币种: ${context.tokenOut}(支持 AVAX/USDC)` }

      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行取出' }
      }
      const wallet = getLendingWalletAddress()!

      const reserve = await getReserveInfo(token.address)
      const decimals = token.isNative ? 18 : USDC_DECIMALS
      const supplied = await getATokenBalance(reserve.aToken, wallet)
      if (supplied === 0n) {
        return { verdict: 'rejected', error: `热钱包没有 ${symbolOf(token)} 存款` }
      }

      // 全部取出 or 指定数量
      let amount: bigint
      if (context.amountOut.trim().toLowerCase() === 'all') {
        amount = supplied
      } else {
        amount = token.isNative ? parseEther(context.amountOut) : parseUnits(context.amountOut, decimals)
        if (amount <= 0n) return { verdict: 'rejected', error: 'amountOut 必须大于 0' }
        if (amount > supplied) {
          return { verdict: 'rejected', error: `存款不足(持有 ${formatUnits(supplied, decimals)},要取 ${context.amountOut})` }
        }
      }
      const amountHuman = formatUnits(amount, decimals)

      const proposal = await buildWithdrawProposal(token, amountHuman, context.reason)
      const { verdict, reasons } = await evaluateProposal(proposal)
      const note = `将取回 ≈${amountHuman} ${symbolOf(token)}(含已累积利息)`
      if (verdict === 'rejected') return { verdict, reasons, note }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash } = await executeLendingProposal(tokenId, proposal)
      return { verdict, txHash, amountOut: amountHuman, note: `${note};已取回: ${config.chain.explorer}/tx/${txHash}` }
    },
  })
}

/** get_lending_position 只读查询:当前存款 + 实时 APY(不经过策略引擎) */
function makeGetPosition(tokenId: number) {
  return createTool({
    id: 'get_lending_position',
    description: '查询热钱包在 Aave 的存款仓位:各币种的存款数量与实时供给 APY。只读,不产生交易。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      positions: z.array(
        z.object({
          symbol: z.string(),
          supplied: z.string(),
          suppliedRaw: z.string(),
          supplyApy: z.number(),
        }),
      ),
      total: z.number(),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const wallet = getLendingWalletAddress()
        if (!wallet) return { positions: [], total: 0, error: '未配置执行密钥(AGENT_PRIVATE_KEY)' }
        const targets = [
          { symbol: config.chain.defi.nativeSymbol, address: config.chain.defi.wNative, decimals: 18 },
          { symbol: 'USDC', address: config.chain.defi.usdc, decimals: USDC_DECIMALS },
        ].filter((t) => t.address !== '0x0000000000000000000000000000000000000000')
        const positions = []
        for (const t of targets) {
          const reserve = await getReserveInfo(t.address)
          const supplied = await getATokenBalance(reserve.aToken, wallet)
          positions.push({
            symbol: t.symbol,
            supplied: formatUnits(supplied, t.decimals),
            suppliedRaw: supplied.toString(),
            supplyApy: reserve.supplyApy,
          })
        }
        return { positions, total: positions.length }
      } catch (err) {
        return { positions: [], total: 0, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

export const defiLending: SkillDef = {
  manifest: {
    id: 'defi-lending',
    name: '借贷理财',
    version: '0.1.0',
    description:
      'Aave v3 借贷理财(热钱包资金)。存入 AVAX/USDC 赚供给收益,随时连本带息取回,支持只读仓位查询。执行前经策略引擎限额/冷却/熔断把关。',
    tools: ['propose_supply', 'propose_withdraw', 'get_lending_position'],
    permissions: ['defi'],
  },
  makeTools: (tokenId) => ({
    propose_supply: makeProposeSupply(tokenId),
    propose_withdraw: makeProposeWithdraw(tokenId),
    get_lending_position: makeGetPosition(tokenId),
  }),
}
