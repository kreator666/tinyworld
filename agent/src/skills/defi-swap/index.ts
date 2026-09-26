import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from 'viem'
import { config } from '../../config'
import { getDb } from '../../db'
import {
  broadcastSignedTx,
  buildUnsignedErc20Approve,
  buildUnsignedNativeToTokenSwap,
  buildUnsignedTokenToNativeSwap,
  executeSwap,
  executeUserSwap,
  getAgentWalletAddress,
  getAllowance,
  hasAgentKey,
  quoteSwap,
  type UnsignedTx,
} from '../../chain/defi'
import { getAvaxPriceUsd } from '../../core/price'
import { createApproval } from '../../core/approvals'
import { evaluateProposal, type Proposal } from '../../policy/engine'
import { getSwapMode } from '../../core/settings'
import { setPendingSignAction } from '../../core/agent'
import { loadPersona } from '../../chain/persona'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-swap(M4+):两个方向
// - 原生币 → 代币(AVAX→USDC):热钱包自有资金,限额内自动执行
// - 代币 → 原生币(USDC→AVAX):用户(主人)资金,热钱包代执行付 gas;
//   用户对热钱包的 ERC20 approve 额度不足时,生成带 signatureRequest 的审批单,
//   前端弹钱包签名后走 /approvals/:id/approve 放行
// 权限:manifest 声明 ['defi']——链上模块注册表(registerModule)本期未启用,
// 安装时在注册表里跳过该项校验(见 registry.ts 注释);资金安全由策略引擎兜底
// ============================================================

const SLIPPAGE_BPS = 9950n // 滑点 0.5%:amountOutMin = 报价 × 9950/10000
const BPS_BASE = 10000n
const USDC_DECIMALS = 6

function isNativeSymbol(s: string): boolean {
  return ['AVAX', 'ETH', 'NATIVE'].includes(s.trim().toUpperCase())
}

/** 代币符号 → 地址(USDC / WAVAX / WETH / 0x 地址原样) */
function resolveToken(symbolOrAddress: string): Address | null {
  const s = symbolOrAddress.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s as Address
  const { wNative, usdc } = config.chain.defi
  if (s.toUpperCase() === 'USDC') return usdc
  if (['WAVAX', 'WETH', 'WNATIVE'].includes(s.toUpperCase())) return wNative
  return null
}

/** 估值:native 路径按行情价;USDC 路径按 $1 计。价格源失败返回 null(熔断信号) */
async function estimateValueUsd(amountIn: bigint, nativeIn: boolean): Promise<number | null> {
  if (!nativeIn) return Number(formatUnits(amountIn, USDC_DECIMALS)) // USDC 稳定币按 $1
  try {
    const { usd } = await getAvaxPriceUsd()
    return Number(formatEther(amountIn)) * usd
  } catch {
    return null
  }
}

/** 已执行的 defi 交易落 tasks 表(审计 + 策略引擎日累计/冷却的数据源);status 支持 done/failed */
export async function recordDefiTask(
  tokenId: number,
  proposal: Proposal,
  result: { txHash: string; amountOut: string; usdValue: number | null },
  status: 'done' | 'failed' = 'done',
) {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6)', [
    randomUUID(),
    tokenId,
    'defi',
    status,
    JSON.stringify({ action: proposal.action, params: proposal.params, reason: proposal.reason }),
    JSON.stringify(result),
  ])
}

/** 人类可读的兑换结果描述(签名确认后主动告知主人用) */
export function describeSwapResult(
  proposal: Proposal,
  r: { confirmed: boolean; reverted: boolean; amountOut: bigint | null },
): string {
  const { tokenIn, tokenOut } = proposal.params
  const inIsNative = tokenIn === 'native'
  const outSymbol = inIsNative ? 'USDC' : config.chain.defi.nativeSymbol
  const inSymbol = inIsNative ? config.chain.defi.nativeSymbol : 'USDC'
  const inDecimals = inIsNative ? 18 : USDC_DECIMALS
  const outDecimals = inIsNative ? USDC_DECIMALS : 18
  const amountInHuman = formatUnits(BigInt(proposal.params.amountIn), inDecimals)
  if (r.reverted) {
    return `刚才那笔兑换没能成交:${amountInHuman} ${inSymbol} → ${outSymbol} 的交易在链上执行失败(revert)。资金还在你的钱包里,没有动。要我重新组装一笔吗?`
  }
  if (!r.confirmed || r.amountOut == null) {
    return `你的签名交易已广播,但链上还没确认到账,我把哈希记下了,稍后帮你盯一下。`
  }
  const amountOutHuman = formatUnits(r.amountOut, outDecimals)
  return `已确认你的兑换成交:${amountInHuman} ${inSymbol} 换得 ${amountOutHuman} ${outSymbol}。交易哈希和明细都在任务记录里,要我帮你看看接下来怎么安排这笔 ${outSymbol} 吗?`
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

/**
 * 执行已放行的提案(defi-swap 工具的 execute 分支和审批 approve 端点共用):
 * 发交易 → 等回执 → 余额核实 → 写 tasks 表
 */
export async function executeProposal(
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
  const { tokenIn, tokenOut, amountIn, amountOutMin, owner } = proposal.params
  let result: { txHash: string; amountOut: bigint }
  if (tokenIn === 'native') {
    // 热钱包自有资金:原生币 → 代币
    const r = await executeSwap(BigInt(amountIn), BigInt(amountOutMin), tokenOut as Address)
    result = { txHash: r.txHash, amountOut: r.amountOut }
  } else {
    // 用户资金:代币 → 原生币(transferFrom + approve + swap,热钱包代执行)
    if (!owner) throw new Error('提案缺少 owner(用户资金路径)')
    const r = await executeUserSwap(owner as Address, tokenIn as Address, BigInt(amountIn), BigInt(amountOutMin))
    result = { txHash: r.txHash, amountOut: r.amountOut }
  }
  await recordDefiTask(tokenId, proposal, {
    txHash: result.txHash,
    amountOut: result.amountOut.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash: result.txHash, amountOut: result.amountOut.toString() }
}

/** 原生币 → 代币提案 */
async function buildNativeProposal(
  amountInHuman: string,
  tokenOut: Address,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const amountIn = parseEther(amountInHuman)
  if (amountIn <= 0n) throw new Error('amountIn 必须大于 0')
  const quoted = await quoteSwap(amountIn, tokenOut) // path: [wNative, tokenOut]
  return {
    action: 'swap',
    protocol: config.chain.defi.router,
    chainId: config.chain.chainId,
    executionMode,
    params: {
      tokenIn: 'native',
      tokenOut,
      amountIn: amountIn.toString(),
      amountOutMin: ((quoted * SLIPPAGE_BPS) / BPS_BASE).toString(),
    },
    estimatedValueUsd: await estimateValueUsd(amountIn, true),
    reason,
  }
}

/** 代币(USDC)→ 原生币提案;owner 为主人地址 */
async function buildUserProposal(
  amountInHuman: string,
  tokenIn: Address,
  owner: Address,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const amountIn = parseUnits(amountInHuman, USDC_DECIMALS)
  if (amountIn <= 0n) throw new Error('amountIn 必须大于 0')
  const quoted = await quoteSwap(amountIn, tokenIn, true) // path: [tokenIn, wNative]
  return {
    action: 'swap',
    protocol: config.chain.defi.router,
    chainId: config.chain.chainId,
    executionMode,
    params: {
      tokenIn,
      tokenOut: 'native',
      amountIn: amountIn.toString(),
      amountOutMin: ((quoted * SLIPPAGE_BPS) / BPS_BASE).toString(),
      owner,
    },
    estimatedValueUsd: await estimateValueUsd(amountIn, false),
    reason,
  }
}

/** propose_swap 闭包绑定 tokenId:提案 → 策略引擎 → 执行 / 转审批 / 签名 / 拒绝 */
function makeProposeSwap(tokenId: number) {
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔兑换。支持两个方向:AVAX↔USDC。执行模式分两种:hot_wallet(Agent 热钱包自动执行,默认);user_wallet(Agent 只组装交易,由主人钱包签名,Agent 广播)。限额/冷却/熔断由策略引擎把关。',
    inputSchema: z.object({
      tokenIn: z.string().describe('支付币种:AVAX 或 USDC'),
      tokenOut: z.string().describe('目标币种:USDC 或 AVAX'),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.002")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
      executionMode: z
        .enum(['hot_wallet', 'user_wallet'])
        .optional()
        .describe('执行模式:hot_wallet(Agent 热钱包执行)或 user_wallet(主人钱包签名,Agent 广播);默认使用 Agent 设置'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      amountOut: z.string().optional(),
      approvalId: z.string().optional(),
      unsignedTxs: z.array(z.any()).optional(),
      signatureRequest: z
        .object({
          type: z.string(),
          token: z.string(),
          tokenSymbol: z.string(),
          spender: z.string(),
          amount: z.string(),
          decimals: z.number(),
        })
        .optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const nativeIn = isNativeSymbol(context.tokenIn)
      const nativeOut = isNativeSymbol(context.tokenOut)
      if (nativeIn === nativeOut) {
        return { verdict: 'rejected', error: '只支持 原生币↔代币 的兑换(AVAX→USDC 或 USDC→AVAX)' }
      }

      const executionMode = context.executionMode ?? (await getSwapMode(tokenId))

      if (nativeIn) {
        // ---- 原生币 → 代币(AVAX → USDC) ----
        const tokenOut = resolveToken(context.tokenOut)
        if (!tokenOut) return { verdict: 'rejected', error: `无法识别的 tokenOut: ${context.tokenOut}` }
        const proposal = await buildNativeProposal(context.amountIn, tokenOut, context.reason, executionMode)
        const { verdict, reasons } = await evaluateProposal(proposal)
        const quotedOut = formatUnits(BigInt(proposal.params.amountOutMin), USDC_DECIMALS)
        const note = `约可换得 ≥${quotedOut} USDC(估值 $${proposal.estimatedValueUsd?.toFixed(4) ?? '未知'})`
        if (verdict === 'rejected') return { verdict, reasons, note }

        if (executionMode === 'user_wallet') {
          const user = proposal.params.owner ? (proposal.params.owner as Address) : ((await loadPersona(tokenId)).owner as Address)
          const unsignedTx = buildUnsignedNativeToTokenSwap(
            user,
            BigInt(proposal.params.amountIn),
            BigInt(proposal.params.amountOutMin),
            tokenOut,
          )
          proposal.unsignedTxs = [unsignedTx]
          const action = {
            type: 'sign_tx' as const,
            unsignedTxs: proposal.unsignedTxs,
            note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认`,
            proposal: recordingProposal(proposal),
          }
          setPendingSignAction(tokenId, action)
          return { verdict: 'sign', ...action }
        }

        // hot_wallet 模式
        if (!hasAgentKey()) {
          return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法使用热钱包模式执行兑换' }
        }
        if (verdict === 'needsApproval') {
          const approval = await createApproval(tokenId, proposal, context.reason)
          return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
        }
        const { txHash, amountOut } = await executeProposal(tokenId, proposal)
        return { verdict, txHash, amountOut, note: `${note};已执行: ${config.chain.explorer}/tx/${txHash}` }
      }

      // ---- 代币 → 原生币(USDC → AVAX) ----
      const tokenIn = resolveToken(context.tokenIn)
      if (!tokenIn) return { verdict: 'rejected', error: `无法识别的 tokenIn: ${context.tokenIn}` }
      const persona = await loadPersona(tokenId)
      const owner = persona.owner as Address
      const proposal = await buildUserProposal(context.amountIn, tokenIn, owner, context.reason, executionMode)
      const { verdict, reasons } = await evaluateProposal(proposal)
      const quotedOut = formatEther(BigInt(proposal.params.amountOutMin))
      const note = `约可换得 ≥${quotedOut} AVAX(估值 $${proposal.estimatedValueUsd?.toFixed(4) ?? '未知'})`
      if (verdict === 'rejected') return { verdict, reasons, note }

      if (executionMode === 'user_wallet') {
        const unsignedTxs: UnsignedTx[] = []
        const router = config.chain.defi.router
        // 用户钱包模式下,用户直接授权 router,不需要先 approve 热钱包
        const allowanceToRouter = await getAllowance(tokenIn, owner, router)
        if (allowanceToRouter < BigInt(proposal.params.amountIn)) {
          unsignedTxs.push(buildUnsignedErc20Approve(tokenIn, router, BigInt(proposal.params.amountIn)))
        }
        unsignedTxs.push(
          buildUnsignedTokenToNativeSwap(owner, tokenIn, BigInt(proposal.params.amountIn), BigInt(proposal.params.amountOutMin)),
        )
        proposal.unsignedTxs = unsignedTxs
        const action = {
          type: 'sign_tx' as const,
          unsignedTxs,
          note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认(${unsignedTxs.length} 笔交易)`,
          proposal: recordingProposal(proposal),
        }
        setPendingSignAction(tokenId, action)
        return { verdict: 'sign', ...action }
      }

      // hot_wallet 模式(保持原有逻辑:用户先 approve 热钱包,热钱包代执行)
      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法使用热钱包模式执行兑换' }
      }
      const hotWallet = getAgentWalletAddress()
      const allowance = await getAllowance(tokenIn, owner, hotWallet as Address)
      if (allowance < BigInt(proposal.params.amountIn)) {
        proposal.signatureRequest = {
          type: 'erc20_approve',
          token: tokenIn,
          tokenSymbol: 'USDC',
          spender: hotWallet as string,
          amount: proposal.params.amountIn,
          decimals: USDC_DECIMALS,
        }
        const approval = await createApproval(tokenId, proposal, context.reason)
        return {
          verdict: 'needsApproval',
          reasons: [...reasons, '用户对热钱包的 USDC 授权额度不足,需主人钱包完成 approve 签名'],
          approvalId: approval.id,
          signatureRequest: proposal.signatureRequest,
          note: `${note};等主人完成 USDC approve 签名后,审批通过即可执行`,
        }
      }
      if (verdict === 'needsApproval') {
        const approval = await createApproval(tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }
      const { txHash, amountOut } = await executeProposal(tokenId, proposal)
      return { verdict, txHash, amountOut, note: `${note};已执行: ${config.chain.explorer}/tx/${txHash}` }
    },
  })
}

export const defiSwap: SkillDef = {
  manifest: {
    id: 'defi-swap',
    name: '兑换执行',
    version: '0.3.0',
    description: 'AVAX↔USDC 白名单兑换。支持两种执行模式:hot_wallet(Agent 热钱包自动执行);user_wallet(Agent 组装交易,主人钱包签名,Agent 广播)。',
    tools: ['propose_swap'],
    permissions: ['defi'],
  },
  makeTools: (tokenId) => ({
    propose_swap: makeProposeSwap(tokenId),
  }),
}

// 供状态/调试端点展示热钱包地址(不暴露私钥)
export { getAgentWalletAddress }
