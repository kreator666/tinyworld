import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatUnits, parseUnits } from 'viem'
import { getDb } from '../../db'
import { getChainContext } from '../../chain/registry'
import { SOL_MINT, usdcMintOf } from '../../chain/jupiter'
import { executeMeteoraSwap, isMeteoraSwapConfigured, quoteMeteoraSwap } from '../../chain/meteora'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-swap-meteora:Solana 家族真实兑换(SOL↔USDC),经 Meteora DLMM 执行。
// devnet 定期清理后 Raydium/Orca/Jupiter 程序均不存在,Meteora DLMM 是 devnet 上唯一真实 DEX;
// 本技能是 devnet 上真正能成交的兑换技能(agent 热钱包直接执行,池见 chain/meteora.ts)。
// 可用前提:配置 AGENT_SOLANA_PRIVATE_KEY + 池地址(chain/meteora.ts 默认值或 METEORA_POOL_ADDRESS);
// 不满足时 isSkillAvailable 隐藏本技能,工具 execute 兜底返回提示。每笔成交落 tasks 表审计。
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

/** propose_swap 闭包绑定 chainKey + tokenId:报价 → 热钱包执行 → 落审计 */
function makeProposeSwap(chainKey: string, tokenId: number) {
  const enabled = isMeteoraSwapConfigured()
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔 Solana 兑换(SOL↔USDC),由 Meteora DLMM 路由、Agent 热钱包自动执行。兑换完成后会返回交易签名与浏览器链接。',
    inputSchema: z.object({
      tokenIn: z.enum(['SOL', 'USDC']).describe('支付币种:SOL 或 USDC'),
      tokenOut: z.enum(['SOL', 'USDC']).describe('目标币种:SOL 或 USDC'),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.1")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) {
        return { result: 'Meteora 兑换未配置(需要 AGENT_SOLANA_PRIVATE_KEY 与 METEORA_POOL_ADDRESS)' }
      }
      try {
        if (context.tokenIn === context.tokenOut) {
          return { result: '执行失败:tokenIn 与 tokenOut 不能相同(SOL↔USDC 两个方向)' }
        }
        const tokenIn = context.tokenIn as TokenSymbol
        const tokenOut = context.tokenOut as TokenSymbol
        const amountIn = parseUnits(context.amountIn, DECIMALS[tokenIn])
        if (amountIn <= 0n) return { result: '执行失败:amountIn 必须大于 0' }

        const quote = await quoteMeteoraSwap(chainKey, mintOf(chainKey, tokenIn), mintOf(chainKey, tokenOut), amountIn, SLIPPAGE_BPS)
        const amountOut = formatUnits(BigInt(quote.outAmount), DECIMALS[tokenOut])

        const signature = await executeMeteoraSwap(chainKey, mintOf(chainKey, tokenIn), mintOf(chainKey, tokenOut), amountIn, SLIPPAGE_BPS)
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
        // solana 的 explorer 带 query(?cluster=devnet),路径要拼在 query 之前
        const txUrl = explorer.includes('?')
          ? `${explorer.split('?')[0]}/tx/${signature}?${explorer.split('?')[1]}`
          : `${explorer}/tx/${signature}`
        return {
          result: `已确认兑换成交:${context.amountIn} ${tokenIn} 经 Meteora DLMM 换得约 ${amountOut} ${tokenOut}。交易签名 ${signature},浏览器明细:${txUrl}`,
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
    version: '1.0.0',
    description: '经 Meteora DLMM 在 Solana devnet 上真实兑换 SOL↔USDC(agent 热钱包执行,devnet 上唯一可用的兑换)',
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
