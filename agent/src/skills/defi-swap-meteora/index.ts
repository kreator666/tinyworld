import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatUnits, parseUnits } from 'viem'
import { getDb } from '../../db'
import { config } from '../../config'
import { SOL_MINT } from '../../chain/jupiter'
import { buildMeteoraSwap, executeMeteoraSwap, isMeteoraPoolConfigured, quoteMeteoraSwap } from '../../chain/meteora'
import { EXEC_CHAIN_KEY, MAINNET_USDC_MINT, MAX_SWAP_SOL_IN, MAX_SWAP_USDC_IN, mainnetTxUrl } from '../../chain/solanaExec'
import { loadPersona } from '../../chain/persona'
import { getSwapMode } from '../../core/settings'
import { setPendingSignAction } from '../../core/agent'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-swap-meteora:Solana 主网真实兑换(SOL↔USDC),经 Meteora DLMM 执行。
// split-brain:身份链(solana-devnet)只读,兑换在主网执行(小金额,见 chain/solanaExec.ts)。
// 执行模式遵循 Agent 设置(swap_mode):
// - hot_wallet:Agent 主网热钱包签名执行(需 AGENT_SOLANA_PRIVATE_KEY)
// - user_wallet(默认):Agent 只组装以主人 Phantom 公钥为 feePayer 的未签名交易,
//   返回 sign_tx action,由前端 Phantom 签名并自广播,结果经 /sign-confirm 回写
// 可用前提:池地址可解析(默认池或 METEORA_POOL_ADDRESS);hot_wallet 另需
// AGENT_SOLANA_PRIVATE_KEY;不满足时工具 execute 兜底返回提示。每笔成交落 tasks 表审计。
// ============================================================

const SLIPPAGE_BPS = 100 // 滑点 1%
// SOL 9 位小数(lamports),USDC 6 位小数
const DECIMALS: Record<'SOL' | 'USDC', number> = { SOL: 9, USDC: 6 }

type TokenSymbol = keyof typeof DECIMALS

/** 代币符号 → mint(USDC 固定主网 Circle USDC,与执行层一致) */
function mintOf(symbol: TokenSymbol): string {
  return symbol === 'SOL' ? SOL_MINT : MAINNET_USDC_MINT
}

/** 金额硬顶校验(真钱护栏):按输入币种限制单笔规模 */
function checkCap(tokenIn: TokenSymbol, amountHuman: number): string | null {
  if (tokenIn === 'SOL' && amountHuman > MAX_SWAP_SOL_IN) {
    return `单笔兑换输入上限 ${MAX_SWAP_SOL_IN} SOL(SOLANA_MAX_SWAP_SOL_IN 可调),请拆小金额`
  }
  if (tokenIn === 'USDC' && amountHuman > MAX_SWAP_USDC_IN) {
    return `单笔兑换输入上限 ${MAX_SWAP_USDC_IN} USDC(SOLANA_MAX_SWAP_USDC_IN 可调),请拆小金额`
  }
  return null
}

/** 已执行的 defi 交易落 tasks 表(审计;执行链记 solana-mainnet,与身份链区分) */
async function recordDefiTask(
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string; amountOut: string },
): Promise<void> {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    randomUUID(),
    EXEC_CHAIN_KEY,
    tokenId,
    'defi',
    'done',
    JSON.stringify(payload),
    JSON.stringify(result),
  ])
}

/** propose_swap 闭包绑定 chainKey + tokenId:报价 → 按 swap_mode 热钱包执行 / 组装待签名交易 → 落审计 */
function makeProposeSwap(chainKey: string, tokenId: number) {
  const poolReady = isMeteoraPoolConfigured()
  const enabled = poolReady && Boolean(config.agentSolanaKey)
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔 Solana 主网兑换(SOL↔USDC),由 Meteora DLMM 路由。执行模式分两种:hot_wallet(Agent 热钱包自动执行);user_wallet(默认,Agent 只组装交易,由主人 Phantom 钱包签名,前端直接广播)。兑换完成后会返回交易签名与浏览器链接。',
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
      if (!poolReady) {
        return { result: 'Meteora 兑换未配置(需要 METEORA_POOL_ADDRESS 或默认主网池)' }
      }
      try {
        if (context.tokenIn === context.tokenOut) {
          return { result: '执行失败:tokenIn 与 tokenOut 不能相同(SOL↔USDC 两个方向)' }
        }
        const tokenIn = context.tokenIn as TokenSymbol
        const tokenOut = context.tokenOut as TokenSymbol
        const amountHuman = Number(context.amountIn)
        if (!Number.isFinite(amountHuman) || amountHuman <= 0) return { result: '执行失败:amountIn 必须大于 0' }
        const capErr = checkCap(tokenIn, amountHuman)
        if (capErr) return { result: `执行失败:${capErr}` }
        const amountIn = parseUnits(context.amountIn, DECIMALS[tokenIn])

        const quote = await quoteMeteoraSwap(chainKey, mintOf(tokenIn), mintOf(tokenOut), amountIn, SLIPPAGE_BPS)
        const amountOut = formatUnits(BigInt(quote.outAmount), DECIMALS[tokenOut])
        const executionMode = await getSwapMode(chainKey, tokenId)

        if (executionMode === 'user_wallet') {
          // Agent 只组装交易:主人 Phantom 地址即链上人格 owner(与 EVM 侧 owner 机制一致)
          const owner = (await loadPersona(chainKey, tokenId)).owner
          const unsignedTx = await buildMeteoraSwap(chainKey, mintOf(tokenIn), mintOf(tokenOut), amountIn, SLIPPAGE_BPS, owner)
          const note = `约可换得 ≥${amountOut} ${tokenOut}(Meteora DLMM 主网报价,含 1% 滑点保护);请点击聊天区下方的【签名并发送】按钮,在 Phantom 中确认(主网)`
          const action = {
            type: 'sign_tx' as const,
            unsignedTxs: [unsignedTx],
            note,
            proposal: {
              action: 'swap' as const,
              protocol: 'meteora',
              chainId: 0, // Solana 无 EVM chainId,协议名即路由标识
              params: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOutMin: quote.outAmount, owner },
              executionMode,
              estimatedValueUsd: null,
              reason: context.reason,
            },
          }
          setPendingSignAction(chainKey, tokenId, action)
          return { verdict: 'sign', ...action }
        }

        // hot_wallet 模式:Agent 热钱包签名执行(落审计在下方)
        if (!enabled) {
          return { result: '执行失败:热钱包模式需要 AGENT_SOLANA_PRIVATE_KEY,当前未配置(可切换为 user_wallet 模式由主人钱包签名)' }
        }
        const signature = await executeMeteoraSwap(chainKey, mintOf(tokenIn), mintOf(tokenOut), amountIn, SLIPPAGE_BPS)
        await recordDefiTask(
          tokenId,
          {
            action: 'swap',
            params: { tokenIn, tokenOut, amountIn: amountIn.toString() },
            reason: context.reason,
          },
          { txHash: signature, amountOut },
        )
        return {
          result: `已确认兑换成交:${context.amountIn} ${tokenIn} 经 Meteora DLMM(主网)换得约 ${amountOut} ${tokenOut}。交易签名 ${signature},浏览器明细:${mainnetTxUrl(signature)}`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiSwapMeteora: SkillDef = {
  manifest: {
    id: 'defi-swap-meteora',
    name: 'Meteora 兑换',
    version: '1.2.0',
    description: '经 Meteora DLMM 在 Solana 主网真实兑换 SOL↔USDC(小金额)。执行模式遵循 Agent 设置:hot_wallet(agent 主网热钱包执行)/ user_wallet(默认,主人 Phantom 签名,前端广播)',
    tools: ['propose_swap'],
    permissions: [],
    scope: 'owner', // 资产操作,仅限主人对话
    solanaOnly: true, // 依赖 Solana + Meteora DLMM 池,EVM 下不可安装
    chainFeature: 'meteoraPool',
  },
  makeTools: (chainKey, tokenId) => ({
    propose_swap: makeProposeSwap(chainKey, tokenId),
  }),
}
