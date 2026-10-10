import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatUnits, parseUnits } from 'viem'
import { getDb } from '../../db'
import { config } from '../../config'
import { getChainContext } from '../../chain/registry'
import { loadPersona } from '../../chain/persona'
import { SOL_MINT, buildUnsignedSwap, executeSwap, quoteSwap, usdcMintOf } from '../../chain/jupiter'
import { getSwapMode } from '../../core/settings'
import { setPendingSignAction } from '../../core/agent'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-swap-sol:Solana 家族兑换(SOL↔USDC),经 Jupiter 路由。
// 执行模式遵循 Agent 设置(swap_mode):
// - hot_wallet:Agent Solana 热钱包直接签名执行(需 AGENT_SOLANA_PRIVATE_KEY)
// - user_wallet(默认):Agent 只组装以主人 Phantom 公钥为 feePayer 的未签名交易,
//   返回 sign_tx action,由前端 Phantom 签名并自广播,结果经 /sign-confirm 回写
// 测试网简化版:不走策略引擎与人工审批,但每笔成交都落 tasks 表审计
// (与 EVM 侧 recordDefiTask 同表同 type)。
// 可用前提:cfg.solana.jupiterApiUrl 非空(自托管 Jupiter API);hot_wallet 另需
// config.agentSolanaKey;不满足时 isSkillAvailable 隐藏本技能,工具 execute 兜底返回提示。
// ============================================================

const SLIPPAGE_BPS = 100 // 滑点 1%(测试网流动性浅,给宽一点)
// SOL 9 位小数(lamports),USDC 6 位小数
const DECIMALS: Record<'SOL' | 'USDC', number> = { SOL: 9, USDC: 6 }

type TokenSymbol = keyof typeof DECIMALS

/** 代币符号 → mint(USDC 取链配置;未配置会抛,被 execute 的 catch 兜成"执行失败:…") */
function mintOf(chainKey: string, symbol: TokenSymbol): string {
  return symbol === 'SOL' ? SOL_MINT : usdcMintOf(chainKey)
}

/** 已执行的 defi 交易落 tasks 表(审计;字段约定与 EVM 侧 recordDefiTask 一致) */
async function recordDefiTask(
  chainKey: string,
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string; amountOut: string },
): Promise<void> {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    randomUUID(),
    chainKey,
    tokenId,
    'defi',
    'done',
    JSON.stringify(payload),
    JSON.stringify(result),
  ])
}

/** propose_swap 闭包绑定 chainKey + tokenId:报价 → 按 swap_mode 热钱包执行 / 组装待签名交易 → 落审计 */
function makeProposeSwap(chainKey: string, tokenId: number) {
  const jupiterReady = Boolean(getChainContext(chainKey).cfg.solana?.jupiterApiUrl)
  const hotReady = jupiterReady && Boolean(config.agentSolanaKey)
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔 Solana 兑换(SOL↔USDC),由 Jupiter 路由。执行模式分两种:hot_wallet(Agent 热钱包自动执行);user_wallet(默认,Agent 只组装交易,由主人 Phantom 钱包签名,前端直接广播)。兑换完成后会返回交易签名与浏览器链接。',
    inputSchema: z.object({
      tokenIn: z.enum(['SOL', 'USDC']).describe('支付币种:SOL 或 USDC'),
      tokenOut: z.enum(['SOL', 'USDC']).describe('目标币种:SOL 或 USDC'),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.1")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      result: z.string().optional(),
      verdict: z.string().optional(),
      unsignedTxs: z.array(z.any()).optional(),
      note: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      if (!jupiterReady) {
        return { result: '该链未配置 Jupiter 兑换(需要 JUPITER_API_URL)' }
      }
      try {
        if (context.tokenIn === context.tokenOut) {
          return { result: '执行失败:tokenIn 与 tokenOut 不能相同(SOL↔USDC 两个方向)' }
        }
        const tokenIn = context.tokenIn as TokenSymbol
        const tokenOut = context.tokenOut as TokenSymbol
        const amountIn = parseUnits(context.amountIn, DECIMALS[tokenIn])
        if (amountIn <= 0n) return { result: '执行失败:amountIn 必须大于 0' }

        const quote = await quoteSwap(chainKey, mintOf(chainKey, tokenIn), mintOf(chainKey, tokenOut), amountIn, SLIPPAGE_BPS)
        const amountOut = formatUnits(BigInt(quote.outAmount as string), DECIMALS[tokenOut])
        const executionMode = await getSwapMode(chainKey, tokenId)

        if (executionMode === 'user_wallet') {
          // Agent 只组装交易:主人 Phantom 地址即链上人格 owner(与 EVM 侧 owner 机制一致)
          const owner = (await loadPersona(chainKey, tokenId)).owner
          const unsignedTx = await buildUnsignedSwap(chainKey, quote, owner)
          const note = `约可换得 ≥${amountOut} ${tokenOut}(Jupiter 报价,含 1% 滑点保护);请点击聊天区下方的【签名并发送】按钮,在 Phantom 中确认`
          const action = {
            type: 'sign_tx' as const,
            unsignedTxs: [unsignedTx],
            note,
            proposal: {
              action: 'swap' as const,
              protocol: 'jupiter',
              chainId: 0, // Solana 无 EVM chainId,协议名即路由标识
              params: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOutMin: quote.outAmount as string, owner },
              executionMode,
              estimatedValueUsd: null,
              reason: context.reason,
            },
          }
          setPendingSignAction(chainKey, tokenId, action)
          return { verdict: 'sign', ...action }
        }

        // hot_wallet 模式:Agent 热钱包签名执行(落审计在下方)
        if (!hotReady) {
          return { result: '执行失败:热钱包模式需要 AGENT_SOLANA_PRIVATE_KEY,当前未配置(可切换为 user_wallet 模式由主人钱包签名)' }
        }
        const signature = await executeSwap(chainKey, quote)
        await recordDefiTask(
          chainKey,
          tokenId,
          {
            action: 'swap',
            params: { tokenIn, tokenOut, amountIn: amountIn.toString() },
            reason: context.reason,
          },
          { txHash: signature, amountOut },
        )
        const explorer = getChainContext(chainKey).cfg.explorer
        // solana 的 explorer 带 query(?cluster=testnet),路径要拼在 query 之前
        const txUrl = explorer.includes('?')
          ? `${explorer.split('?')[0]}/tx/${signature}?${explorer.split('?')[1]}`
          : `${explorer}/tx/${signature}`
        return {
          result: `已确认兑换成交:${context.amountIn} ${tokenIn} 经 Jupiter 换得约 ${amountOut} ${tokenOut}。交易签名 ${signature},浏览器明细:${txUrl}`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiSwapSol: SkillDef = {
  manifest: {
    id: 'defi-swap-sol',
    name: 'Solana 兑换',
    version: '1.1.0',
    description: '经 Jupiter 在 Solana 上兑换 SOL↔USDC。执行模式遵循 Agent 设置:hot_wallet(agent 热钱包执行)/ user_wallet(默认,主人 Phantom 签名,前端广播)',
    tools: ['propose_swap'],
    permissions: [],
    scope: 'owner', // 资产操作,仅限主人对话
    solanaOnly: true, // 依赖 Solana + Jupiter API,EVM 下不可安装
    chainFeature: 'jupiterApi', // 需要 cfg.solana.jupiterApiUrl 非空(自托管 Jupiter API)
  },
  makeTools: (chainKey, tokenId) => ({
    propose_swap: makeProposeSwap(chainKey, tokenId),
  }),
}
