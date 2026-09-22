import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, formatUnits, parseEther, type Address } from 'viem'
import { config } from '../../config'
import { getDb } from '../../db'
import { executeSwap, getAgentWalletAddress, hasAgentKey, quoteSwap } from '../../chain/defi'
import { getAvaxPriceUsd } from '../../core/price'
import { createApproval } from '../../core/approvals'
import { evaluateProposal, type Proposal } from '../../policy/engine'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-swap(M4):原生币 → 白名单代币兑换
// 权限:manifest 声明 ['defi']——链上模块注册表(registerModule)本期未启用,
// 安装时在注册表里跳过该项校验(见 registry.ts 注释);资金安全由策略引擎兜底
// 范围:M4 只支持 原生币 → 代币(反向需要 ERC20 approve,后续里程碑再加)
// ============================================================

const SLIPPAGE_BPS = 9950n // 滑点 0.5%:amountOutMin = 报价 × 9950/10000
const BPS_BASE = 10000n

/** 代币符号 → 地址(USDC / WAVAX / WETH / 0x 地址原样) */
function resolveToken(symbolOrAddress: string): Address | null {
  const s = symbolOrAddress.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s as Address
  const { wNative, usdc } = config.chain.defi
  if (s.toUpperCase() === 'USDC') return usdc
  if (['WAVAX', 'WETH', 'WNATIVE'].includes(s.toUpperCase())) return wNative
  return null
}

/** 估值:amountInWei 原生币 × 美元单价;价格源失败返回 null(熔断信号) */
async function estimateValueUsd(amountInWei: bigint): Promise<number | null> {
  try {
    const { usd } = await getAvaxPriceUsd()
    return Number(formatEther(amountInWei)) * usd
  } catch {
    return null
  }
}

/** 已执行的 defi 交易落 tasks 表(审计 + 策略引擎日累计/冷却的数据源) */
async function recordDefiTask(
  tokenId: number,
  proposal: Proposal,
  result: { txHash: string; amountOut: string; usdValue: number | null },
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

/**
 * 执行已放行的提案(defi-swap 工具的 execute 分支和审批 approve 端点共用):
 * 发交易 → 等回执 → 余额核实 → 写 tasks 表
 */
export async function executeProposal(
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
  const { amountInWei, amountOutMin, tokenOut } = proposal.params
  const { txHash, amountOut } = await executeSwap(BigInt(amountInWei), BigInt(amountOutMin), tokenOut as Address)
  await recordDefiTask(tokenId, proposal, {
    txHash,
    amountOut: amountOut.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash, amountOut: amountOut.toString() }
}

/** 构造提案:报价 → 滑点换算 → 估值;报价失败(无流动性等)直接抛错 */
async function buildProposal(amountIn: string, tokenOut: Address, reason: string): Promise<Proposal> {
  const amountInWei = parseEther(amountIn)
  if (amountInWei <= 0n) throw new Error('amountIn 必须大于 0')
  const quoted = await quoteSwap(amountInWei, tokenOut)
  const amountOutMin = (quoted * SLIPPAGE_BPS) / BPS_BASE
  return {
    action: 'swap',
    protocol: config.chain.defi.router,
    chainId: config.chain.chainId,
    params: {
      tokenIn: 'native',
      tokenOut,
      amountInWei: amountInWei.toString(),
      amountOutMin: amountOutMin.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(amountInWei),
    reason,
  }
}

/** propose_swap 闭包绑定 tokenId:提案 → 策略引擎 → 执行 / 转审批 / 拒绝 */
function makeProposeSwap(tokenId: number) {
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔兑换:把指定数量的原生币(AVAX)换成 USDC 等白名单代币。限额内自动执行上链,超限或无法估值时生成审批单等主人确认。只支持原生币换代币。',
    inputSchema: z.object({
      tokenIn: z.string().describe('支付币种,目前只支持 AVAX(原生币)'),
      tokenOut: z.string().describe('目标币种符号(如 USDC)或合约地址'),
      amountIn: z.string().describe('支付数量,原生币单位,如 "0.002"'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
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
      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法发起兑换' }
      }
      const tokenIn = context.tokenIn.trim().toUpperCase()
      if (!['AVAX', 'ETH', 'NATIVE'].includes(tokenIn)) {
        return { verdict: 'rejected', error: `M4 仅支持原生币换代币,tokenIn=${context.tokenIn} 暂不支持` }
      }
      const tokenOut = resolveToken(context.tokenOut)
      if (!tokenOut) return { verdict: 'rejected', error: `无法识别的 tokenOut: ${context.tokenOut}` }

      const proposal = await buildProposal(context.amountIn, tokenOut, context.reason)
      const { verdict, reasons } = await evaluateProposal(proposal)
      const quotedOut = formatUnits(BigInt(proposal.params.amountOutMin), 6) // USDC 6 位小数(滑点后的最小到账)
      const note = `约可换得 ≥${quotedOut} USDC(估值 $${proposal.estimatedValueUsd?.toFixed(4) ?? '未知'})`

      if (verdict === 'rejected') {
        return { verdict, reasons, note }
      }
      if (verdict === 'needsApproval') {
        const approval = await createApproval(tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }
      // execute:限额内直接执行
      const { txHash, amountOut } = await executeProposal(tokenId, proposal)
      return {
        verdict,
        txHash,
        amountOut,
        note: `${note};已执行: ${config.chain.explorer}/tx/${txHash}`,
      }
    },
  })
}

export const defiSwap: SkillDef = {
  manifest: {
    id: 'defi-swap',
    name: '兑换执行',
    version: '0.1.0',
    description: 'AVAX → USDC 等白名单代币兑换(限额内自动执行,超限转审批)',
    tools: ['propose_swap'],
    permissions: ['defi'],
  },
  makeTools: (tokenId) => ({
    propose_swap: makeProposeSwap(tokenId),
  }),
}

// 供状态/调试端点展示热钱包地址(不暴露私钥)
export { getAgentWalletAddress }
