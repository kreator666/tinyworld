import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getDb } from '../../../src/db'
import { getChainContext } from '../../../src/chain/registry'
import { loadPersona } from '../../../src/chain/persona'
import { refTokens, refQuote, refSwap, refTokenDecimals, buildRefSwapTxs } from '../../../src/chain/ref'
import { isNearWriteReady } from '../../../src/chain/nearWrite'
import { getSwapMode } from '../../../src/core/settings'
import { getNativePriceUsd } from '../../../src/core/price'
import { setPendingSignAction, type SignTxAction } from '../../../src/core/agent'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-swap-ref:NEAR 家族兑换(WNEAR↔USDC/USDT/DAI/WETH),经 Ref Finance AMM。
// 两种执行模式(与 EVM 侧对齐,读 Agent 设置的 swap_mode):
// - user_wallet(默认):Agent 只组装交易(storage_deposit/near_deposit/ft_transfer_call 1~3 笔),
//   由主人钱包逐笔签名;首次使用需付可退的 NEP-145 storage 押金(0.25N/笔)
// - hot_wallet:Agent NEAR 热钱包(AGENT_NEAR_PRIVATE_KEY)直接签名广播
// 测试网简化版:不走策略引擎与人工审批,每笔成交落 tasks 表审计(与 Solana 侧同表同 type)。
// ============================================================

const SLIPPAGE_BPS = 100 // 滑点 1%(测试网流动性浅,给宽一点)
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

/** 估值:WNEAR 按链原生币价,稳定币按 $1,其余(WETH 等)无可靠价给 null(与 EVM estimateValueUsd 同思路) */
async function estimateRefValueUsd(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<number | null> {
  const amount = parseFloat(amountHuman)
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (['USDC', 'USDT', 'DAI'].includes(tokenSymbol)) return amount
  if (tokenSymbol === 'WNEAR') {
    try {
      const { usd } = await getNativePriceUsd(chainKey)
      return amount * usd
    } catch {
      return null
    }
  }
  return null
}

/** propose_swap 闭包绑定 chainKey + tokenId:报价 → user_wallet 组装签名 / hot_wallet 执行 → 落审计 */
function makeProposeSwap(chainKey: string, tokenId: number) {
  const TOKEN_SYMBOLS = Object.keys(refTokens(chainKey)) as [string, ...string[]]
  return createTool({
    id: 'propose_swap',
    description:
      '发起一笔 NEAR 链上兑换(WNEAR↔USDC/USDT/DAI/WETH),由 Ref Finance AMM 路由。user_wallet 模式:Agent 组装交易、主人钱包签名;hot_wallet 模式:Agent 热钱包直接签名执行,成交后返回交易哈希与浏览器链接。',
    inputSchema: z.object({
      tokenIn: z.enum(TOKEN_SYMBOLS).describe(`支付币种:${TOKEN_SYMBOLS.join(' / ')}`),
      tokenOut: z.enum(TOKEN_SYMBOLS).describe(`目标币种:${TOKEN_SYMBOLS.join(' / ')}`),
      amountIn: z.string().describe('支付数量(人类单位,如 "0.1")'),
      reason: z.string().describe('这笔兑换的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string().optional(),
      unsignedTxs: z.array(z.any()).optional(),
      note: z.string().optional(),
      result: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      if (context.tokenIn === context.tokenOut) {
        return { result: '执行失败:tokenIn 与 tokenOut 不能相同' }
      }
      try {
        const tokenIn = context.tokenIn.toUpperCase()
        const tokenOut = context.tokenOut.toUpperCase()
        const decimalsIn = await refTokenDecimals(chainKey, refTokens(chainKey)[tokenIn].contractId)
        const decimalsOut = await refTokenDecimals(chainKey, refTokens(chainKey)[tokenOut].contractId)
        const amountAtomic = BigInt(Math.round(parseFloat(context.amountIn) * 10 ** decimalsIn)).toString()
        if (BigInt(amountAtomic) <= 0n) return { result: '执行失败:amountIn 必须大于 0' }

        const quote = await refQuote(chainKey, tokenIn, tokenOut, amountAtomic)
        const amountOutHuman = (Number(quote.amountOut) / 10 ** decimalsOut).toFixed(6)
        const executionMode = await getSwapMode(chainKey, tokenId)

        if (executionMode === 'user_wallet') {
          // 只组装不发交易:storage_deposit(按需)→ near_deposit(按需)→ ft_transfer_call,主人钱包逐笔签名
          const persona = await loadPersona(chainKey, tokenId)
          const owner = persona.owner
          const { txs, amountOut } = await buildRefSwapTxs(chainKey, owner, tokenIn, tokenOut, context.amountIn, SLIPPAGE_BPS)
          const amountOutMin = (BigInt(amountOut) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n
          const estimatedValueUsd = await estimateRefValueUsd(chainKey, tokenIn, context.amountIn)
          const note = `约可换得 ≥${amountOutHuman} ${tokenOut}(估值 $${estimatedValueUsd?.toFixed(4) ?? '未知'});请点击聊天区下方的【签名并发送】按钮,在钱包里完成签名(${txs.length} 笔交易)。首次使用 Ref 需支付可退还的存储押金(每笔 0.25N)`
          const action: SignTxAction = {
            type: 'sign_tx',
            unsignedTxs: txs,
            note,
            proposal: {
              action: 'swap',
              protocol: 'ref-finance',
              chainId: getChainContext(chainKey).cfg.chainId,
              params: { tokenIn, tokenOut, amountIn: amountAtomic, amountOutMin: amountOutMin.toString(), owner },
              executionMode: 'user_wallet',
              estimatedValueUsd,
              reason: context.reason,
            },
          }
          setPendingSignAction(chainKey, tokenId, action)
          return { verdict: 'sign', unsignedTxs: txs, note, proposal: action.proposal }
        }

        if (!isNearWriteReady()) {
          return { result: '执行失败:未配置 AGENT_NEAR_PRIVATE_KEY(NEAR 热钱包),无法执行兑换;也可在设置中切换为用户钱包签名模式' }
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
    description: '经 Ref Finance 在 NEAR 上兑换 WNEAR↔USDC/USDT/DAI/WETH。user_wallet 模式:Agent 组装交易、主人钱包签名(默认);hot_wallet 模式:Agent NEAR 热钱包签名执行(需 AGENT_NEAR_PRIVATE_KEY)',
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
