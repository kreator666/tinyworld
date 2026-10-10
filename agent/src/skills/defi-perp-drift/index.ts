import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { parseUnits } from 'viem'
import { getDb } from '../../db'
import { getChainContext } from '../../chain/registry'
import {
  driftCalcBaseAmount,
  driftClosePosition,
  driftDeposit,
  driftFaucetUsdc,
  driftHandle,
  driftOpenPosition,
  driftPerpMarkets,
  driftQuoteTokenBalance,
  driftStatus,
  driftWithdraw,
  isDriftConfigured,
  resolvePerpMarketIndex,
} from '../../chain/drift'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-perp-drift:Solana 家族真实永续交易(Drift Protocol,devnet)。
// 经 Drift 官方程序 dRiftyHA39... 开多/开空/平仓(默认 SOL-PERP),
// 保证金为 Drift devnet USDC(SDK SpotMarkets 配置,余额不足时工具内自动经
// Drift 官方 token faucet 领取,见 chain/drift.ts)。仅限主人对话(scope=owner),
// 每笔成交落 tasks 表审计。可用前提:配置 AGENT_SOLANA_PRIVATE_KEY(不满足时
// isSkillAvailable 之外的 execute 兜底返回提示)。
// ============================================================

// USDC 6 位小数;名义额换算(USD→base)用 Drift 预言机价格在 chain/drift.ts 内完成
const USDC_DECIMALS = 6
/** 保证金不足时自动领取的 devnet USDC 数量(凑够单次操作 + 余量) */
const FAUCET_TOP_UP_USDC = 50n

/** 已执行的 defi 交易落 tasks 表(审计;字段约定与 defi-swap-meteora 的 recordDefiTask 一致) */
async function recordDefiTask(
  chainKey: string,
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string; detail?: string },
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

/** 浏览器交易链接(solana explorer 带 ?cluster=devnet,路径要拼在 query 之前) */
function txUrl(chainKey: string, signature: string): string {
  const explorer = getChainContext(chainKey).cfg.explorer
  return explorer.includes('?')
    ? `${explorer.split('?')[0]}/tx/${signature}?${explorer.split('?')[1]}`
    : `${explorer}/tx/${signature}`
}

/** 保证金余额不足时自动经 Drift devnet faucet 领取(仅在 devnet 生效) */
async function topUpIfNeeded(chainKey: string, neededAtomic: bigint): Promise<string | null> {
  const balance = await driftQuoteTokenBalance(chainKey)
  if (balance >= neededAtomic) return null
  const { signature } = await driftFaucetUsdc(chainKey, FAUCET_TOP_UP_USDC * 10n ** BigInt(USDC_DECIMALS))
  return signature
}

function makeDriftDeposit(chainKey: string, tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_deposit',
    description: '向 Drift 存入 USDC 作为永续保证金(热钱包执行,devnet 上真实到账)',
    inputSchema: z.object({
      amount: z.string().describe('存入数量(USDC 人类单位,如 "5")'),
      reason: z.string().describe('这笔存入的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const amount = parseUnits(context.amount, USDC_DECIMALS)
        if (amount <= 0n) return { result: '执行失败:amount 必须大于 0' }
        const faucetSig = await topUpIfNeeded(chainKey, amount)
        const signature = await driftDeposit(chainKey, amount)
        await recordDefiTask(
          chainKey,
          tokenId,
          { action: 'perp_deposit', params: { amount: amount.toString() }, reason: context.reason },
          { txHash: signature, detail: faucetSig ? `faucet:${faucetSig}` : undefined },
        )
        return { result: `已向 Drift 存入 ${context.amount} USDC 保证金。交易签名 ${signature},浏览器明细:${txUrl(chainKey, signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftWithdraw(chainKey: string, tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_withdraw',
    description: '从 Drift 提取 USDC 保证金回热钱包(热钱包执行,devnet 上真实到账)',
    inputSchema: z.object({
      amount: z.string().describe('提取数量(USDC 人类单位,如 "5")'),
      reason: z.string().describe('这笔提取的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const amount = parseUnits(context.amount, USDC_DECIMALS)
        if (amount <= 0n) return { result: '执行失败:amount 必须大于 0' }
        const signature = await driftWithdraw(chainKey, amount)
        await recordDefiTask(
          chainKey,
          tokenId,
          { action: 'perp_withdraw', params: { amount: amount.toString() }, reason: context.reason },
          { txHash: signature },
        )
        return { result: `已从 Drift 提取 ${context.amount} USDC 回热钱包。交易签名 ${signature},浏览器明细:${txUrl(chainKey, signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftOpen(chainKey: string, tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_open',
    description: '在 Drift 市价开永续仓位(如 SOL-PERP 开多/开空,名义额以 USD 计价)',
    inputSchema: z.object({
      market: z.string().describe('永续市场,如 "SOL-PERP"(可用市场列表见 drift_status)'),
      side: z.enum(['long', 'short']).describe('开多(long)或开空(short)'),
      usdSize: z.string().describe('名义额(美元,如 "10",按预言机价格换算为 base 数量)'),
      reason: z.string().describe('这笔开仓的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const usd = Number(context.usdSize)
        if (!Number.isFinite(usd) || usd <= 0) return { result: '执行失败:usdSize 必须大于 0' }
        const handle = await driftHandle(chainKey)
        const marketIndex = resolvePerpMarketIndex(handle.env, context.market)
        const baseAmount = await driftCalcBaseAmount(chainKey, marketIndex, usd)
        const faucetSig = await topUpIfNeeded(chainKey, 5n * 10n ** BigInt(USDC_DECIMALS)) // 保证金不足 5 USDC 时自动领取一笔,保证能开仓
        const signature = await driftOpenPosition(chainKey, marketIndex, context.side, baseAmount)
        await recordDefiTask(
          chainKey,
          tokenId,
          {
            action: 'perp_open',
            params: { market: context.market.toUpperCase(), side: context.side, usdSize: context.usdSize, baseAmount: baseAmount.toString() },
            reason: context.reason,
          },
          { txHash: signature, detail: faucetSig ? `faucet:${faucetSig}` : undefined },
        )
        return {
          result: `已在 Drift 市价${context.side === 'long' ? '开多' : '开空'} ${context.market.toUpperCase()},名义额约 ${context.usdSize} USD。交易签名 ${signature},浏览器明细:${txUrl(chainKey, signature)}`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftClose(chainKey: string, tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_close',
    description: '在 Drift 市价平掉指定永续市场的全部持仓(reduce-only)',
    inputSchema: z.object({
      market: z.string().describe('永续市场,如 "SOL-PERP"'),
      reason: z.string().describe('这笔平仓的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const handle = await driftHandle(chainKey)
        const marketIndex = resolvePerpMarketIndex(handle.env, context.market)
        const signature = await driftClosePosition(chainKey, marketIndex)
        await recordDefiTask(
          chainKey,
          tokenId,
          { action: 'perp_close', params: { market: context.market.toUpperCase() }, reason: context.reason },
          { txHash: signature },
        )
        return { result: `已在 Drift 市价平掉 ${context.market.toUpperCase()} 全部持仓。交易签名 ${signature},浏览器明细:${txUrl(chainKey, signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftStatus(chainKey: string, _tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_status',
    description: '查询 Drift 账户状态:保证金、可用保证金、购买力与未平永续持仓',
    inputSchema: z.object({}),
    outputSchema: z.object({ result: z.string() }),
    execute: async () => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const handle = await driftHandle(chainKey)
        const status = await driftStatus(chainKey)
        const markets = driftPerpMarkets(handle.env)
        const lines = [
          `保证金 ${status.collateral} USDC,可用 ${status.freeCollateral} USDC,SOL-PERP 购买力 ${status.buyingPower} SOL`,
          status.positions.length > 0
            ? `持仓:${status.positions
                .map((p) => `${p.market} ${p.side} ${p.base} @ ${p.entryPrice} USD(未实现盈亏 ${p.pnl} USDC)`)
                .join(';')}`
            : '当前无未平持仓',
          `可用永续市场:${markets.map((m) => m.symbol).join(', ')}`,
        ]
        return { result: lines.join('\n') }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiPerpDrift: SkillDef = {
  manifest: {
    id: 'defi-perp-drift',
    name: 'Drift 永续',
    version: '1.0.0',
    description:
      '经 Drift Protocol 在 Solana devnet 上真实交易永续合约(默认 SOL-PERP,支持开多/开空/平仓):存入 USDC 作为保证金,余额不足时自动经 Drift 官方 devnet 水龙头领取测试 USDC',
    tools: ['drift_deposit', 'drift_withdraw', 'drift_open', 'drift_close', 'drift_status'],
    permissions: [],
    scope: 'owner', // 资产操作,仅限主人对话
    solanaOnly: true, // 依赖 Solana + Drift 程序,EVM 下不可安装
  },
  makeTools: (chainKey, tokenId) => ({
    drift_deposit: makeDriftDeposit(chainKey, tokenId),
    drift_withdraw: makeDriftWithdraw(chainKey, tokenId),
    drift_open: makeDriftOpen(chainKey, tokenId),
    drift_close: makeDriftClose(chainKey, tokenId),
    drift_status: makeDriftStatus(chainKey, tokenId),
  }),
}
