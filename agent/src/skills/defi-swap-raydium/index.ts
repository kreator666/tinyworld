import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { parseUnits } from 'viem'
import { getDb } from '../../db'
import { config } from '../../config'
import { getChainContext } from '../../chain/registry'
import { SOL_MINT, usdcMintOf } from '../../chain/jupiter'
import { quoteRaydiumSwap } from '../../chain/raydium'
import type { SkillDef } from '../registry'

const SLIPPAGE_BPS = 100
const DECIMALS: Record<'SOL' | 'USDC', number> = { SOL: 9, USDC: 6 }
type TokenSymbol = keyof typeof DECIMALS

function mintOf(chainKey: string, symbol: TokenSymbol): string {
  return symbol === 'SOL' ? SOL_MINT : usdcMintOf(chainKey)
}

async function recordDefiTask(
  chainKey: string,
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string; amountOut: string },
): Promise<void> {
  const db = await getDb()
  await db.query(
    'INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [randomUUID(), chainKey, tokenId, 'defi', 'done', JSON.stringify(payload), JSON.stringify(result)],
  )
}

function makeProposeSwap(chainKey: string, tokenId: number) {
  const enabled = Boolean(getChainContext(chainKey).cfg.solana?.usdcMint) && Boolean(config.agentSolanaKey)
  return createTool({
    id: 'propose_swap',
    description: '发起一笔 Raydium CPMM 兑换(SOL↔USDC)。devnet 上若找不到对应池子会提示暂不可兑换。',
    inputSchema: z.object({
      tokenIn: z.enum(['SOL', 'USDC']).describe('支付币种:SOL 或 USDC'),
      tokenOut: z.enum(['SOL', 'USDC']).describe('目标币种:SOL 或 USDC'),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.1")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) {
        return { result: '该链未配置 Raydium 兑换前置条件(USDC mint / AGENT_SOLANA_PRIVATE_KEY)' }
      }
      try {
        if (context.tokenIn === context.tokenOut) {
          return { result: '执行失败:tokenIn 与 tokenOut 不能相同(SOL↔USDC 两个方向)' }
        }
        const tokenIn = context.tokenIn as TokenSymbol
        const tokenOut = context.tokenOut as TokenSymbol
        const amountIn = parseUnits(context.amountIn, DECIMALS[tokenIn])
        if (amountIn <= 0n) return { result: '执行失败:amountIn 必须大于 0' }

        const quote = await quoteRaydiumSwap(
          chainKey,
          mintOf(chainKey, tokenIn),
          mintOf(chainKey, tokenOut),
          amountIn,
          SLIPPAGE_BPS,
        )
        const amountOut = (BigInt(quote.outAmount) / BigInt(10 ** (DECIMALS[tokenOut] - DECIMALS[tokenIn] || 0))).toString()

        await recordDefiTask(
          chainKey,
          tokenId,
          { action: 'swap', params: { tokenIn, tokenOut, amountIn: amountIn.toString() }, reason: context.reason },
          { txHash: 'raydium-devnet-stub', amountOut },
        )
        return {
          result: `Raydium devnet 报价成功:${context.amountIn} ${tokenIn} → 约 ${amountOut} ${tokenOut}(池子 ${quote.poolId ?? 'unknown'})。注意:devnet 流动性有限,真实执行功能待完善。`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiSwapRaydium: SkillDef = {
  manifest: {
    id: 'defi-swap-raydium',
    name: 'Raydium 兑换',
    version: '1.0.0',
    description: '经 Raydium CPMM 在 Solana devnet 上兑换 SOL↔USDC(当前为报价/审计 stub)',
    tools: ['propose_swap'],
    permissions: [],
    scope: 'owner',
    solanaOnly: true,
  },
  makeTools: (chainKey, tokenId) => ({
    propose_swap: makeProposeSwap(chainKey, tokenId),
  }),
}
