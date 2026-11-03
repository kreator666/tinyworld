import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getDb } from '../../../src/db'
import { getChainContext } from '../../../src/chain/registry'
import { REF_TESTNET_TOKENS, refQuote, refSwap, refTokenDecimals } from '../../../src/chain/ref'
import { isNearWriteReady } from '../../../src/chain/nearWrite'
import { getSwapMode } from '../../../src/core/settings'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-swap-ref:NEAR 家族兑换(WNEAR↔USDC/USDT/DAI/WETH),经 Ref Finance AMM。
// 仅 hot_wallet 模式:Agent NEAR 热钱包(AGENT_NEAR_PRIVATE_KEY)直接签名广播;
// user_wallet 模式暂不支持(NEAR 签名链路待接入,切换时会提示改回 hot_wallet)。
// 前置:NEP-145 storage deposit 由 chain/ref.ts 幂等注册;wNEAR 不足自动 near_deposit 包裹。
// 测试网简化版:不走策略引擎与人工审批,每笔成交落 tasks 表审计(与 Solana 侧同表同 type)。
// ============================================================

const SLIPPAGE_BPS = 100 // 滑点 1%(测试网流动性浅,给宽一点)
const TOKEN_SYMBOLS = Object.keys(REF_TESTNET_TOKENS) as [string, ...string[]]

/** 已执行的 defi 交易落 tasks 表(审计;字段约定与 EVM/Solana 侧 recordDefiTask 一致) */
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

/** propose_swap 闭包绑定 chainKey + tokenId:报价 → hot_wallet 执行 → 落审计 */
function makeProposeSwap(chainKey: string, tokenId: number) {
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔 NEAR 链上兑换(WNEAR↔USDC/USDT/DAI/WETH),由 Ref Finance AMM 路由。Agent 热钱包直接签名执行,成交后返回交易哈希与浏览器链接。',
    inputSchema: z.object({
      tokenIn: z.enum(TOKEN_SYMBOLS).describe(`支付币种:${TOKEN_SYMBOLS.join(' / ')}`),
      tokenOut: z.enum(TOKEN_SYMBOLS).describe(`目标币种:${TOKEN_SYMBOLS.join(' / ')}`),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.1")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      result: z.string().optional(),
      verdict: z.string().optional(),
      note: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      if (!isNearWriteReady()) {
        return { result: '执行失败:未配置 AGENT_NEAR_PRIVATE_KEY(NEAR 热钱包),无法执行兑换' }
      }
      if (context.tokenIn === context.tokenOut) {
        return { result: '执行失败:tokenIn 与 tokenOut 不能相同' }
      }
      try {
        const tokenIn = context.tokenIn.toUpperCase()
        const tokenOut = context.tokenOut.toUpperCase()
        const decimalsIn = await refTokenDecimals(chainKey, REF_TESTNET_TOKENS[tokenIn].contractId)
        const decimalsOut = await refTokenDecimals(chainKey, REF_TESTNET_TOKENS[tokenOut].contractId)
        const amountAtomic = BigInt(Math.round(parseFloat(context.amountIn) * 10 ** decimalsIn)).toString()
        if (BigInt(amountAtomic) <= 0n) return { result: '执行失败:amountIn 必须大于 0' }

        const quote = await refQuote(chainKey, tokenIn, tokenOut, amountAtomic)
        const amountOutHuman = (Number(quote.amountOut) / 10 ** decimalsOut).toFixed(6)

        const executionMode = await getSwapMode(chainKey, tokenId)
        if (executionMode === 'user_wallet') {
          return {
            result: `报价成功(约 ${amountOutHuman} ${tokenOut}),但 NEAR 兑换当前仅支持 hot_wallet 执行模式,请先在设置中切换执行模式`,
          }
        }

        const { txHash, amountOut } = await refSwap(chainKey, tokenIn, tokenOut, amountAtomic, SLIPPAGE_BPS)
        await recordDefiTask(
          chainKey,
          tokenId,
          {
            action: 'swap',
            params: { tokenIn, tokenOut, amountIn: amountAtomic, protocol: 'ref-finance' },
            reason: context.reason,
          },
          { txHash, amountOut },
        )
        const explorer = getChainContext(chainKey).cfg.explorer // nearblocks 用 /txns 路径
        const txUrl = explorer.includes('nearblocks') ? `${explorer}/txns/${txHash}` : `${explorer}/tx/${txHash}`
        return {
          result: `已确认兑换成交:${context.amountIn} ${tokenIn} 经 Ref Finance 换得约 ${(Number(amountOut) / 10 ** decimalsOut).toFixed(6)} ${tokenOut}。交易哈希 ${txHash},浏览器明细:${txUrl}`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiSwapRef: SkillDef = {
  manifest: {
    id: 'defi-swap-ref',
    name: 'NEAR 兑换',
    version: '1.0.0',
    description: '经 Ref Finance 在 NEAR 上兑换 WNEAR↔USDC/USDT/DAI/WETH。hot_wallet 模式:Agent NEAR 热钱包签名执行(需 AGENT_NEAR_PRIVATE_KEY);user_wallet 暂不支持',
    tools: ['propose_swap'],
    permissions: [],
    scope: 'owner', // 资产操作,仅限主人对话
    nearOnly: true, // 仅 NEAR 家族链
    protocol: 'ref-swap', // chain_protocols 表 gating(由 cfg.near.refExchange seeding)
    protocolRequired: true, // 无协议行且无老逻辑可兜底 = 隐藏
  },
  makeTools: (chainKey, tokenId) => ({
    propose_swap: makeProposeSwap(chainKey, tokenId),
  }),
}
