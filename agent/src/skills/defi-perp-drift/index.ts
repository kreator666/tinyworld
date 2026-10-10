import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { parseUnits } from 'viem'
import { getDb } from '../../db'
import {
  driftCalcBaseAmount,
  driftClosePosition,
  driftDeposit,
  driftHandle,
  driftOpenPosition,
  driftPerpMarkets,
  driftStatus,
  driftWithdraw,
  isDriftConfigured,
  resolvePerpMarketIndex,
} from '../../chain/drift'
import { EXEC_CHAIN_KEY, MAX_PERP_DEPOSIT_USDC, MAX_PERP_NOTIONAL_USD, mainnetTxUrl } from '../../chain/solanaExec'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-perp-drift:Solana 主网真实永续交易(Drift Protocol)。
// split-brain:身份链(solana-devnet)只读,永续交易在主网执行(小金额,见
// chain/solanaExec.ts);devnet 官方 Drift 部署已损坏且其应用已下线,不再使用。
// 保证金 = 主网 Circle USDC(无水龙头,入金前校验热钱包真实余额,不足时报错提示
// 先经 Meteora 兑换);开多/开空/平仓为市价单。安全护栏:单笔入金 ≤
// MAX_PERP_DEPOSIT_USDC、单笔名义额 ≤ MAX_PERP_NOTIONAL_USD(env 可调)。
// 仅限主人对话(scope=owner),每笔成交落 tasks 表审计(执行链 = solana-mainnet)。
// 可用前提:配置 AGENT_SOLANA_PRIVATE_KEY(主网热钱包)。
// ⚠ 链侧现状(2026-10):dRiftyHA39... 主网部署已事实下线(自 2026-09-25 起拒绝
// 所有用户交易,Drift 已迁移至闭源的 Velocity 新程序),写操作会稳定报
// InstructionFallbackNotFound(101);读操作(drift_status)仍可用。详见 chain/drift.ts。
// ============================================================

// USDC 6 位小数;名义额换算(USD→base)用 Drift 预言机价格在 chain/drift.ts 内完成
const USDC_DECIMALS = 6

/** 名义额硬顶校验(真钱护栏):单笔仓位名义价值上限 */
function checkNotionalCap(usdSize: number): string | null {
  if (usdSize > MAX_PERP_NOTIONAL_USD) {
    return `单笔永续仓位名义额上限 ${MAX_PERP_NOTIONAL_USD} USD(SOLANA_MAX_PERP_NOTIONAL_USD 可调),请拆小仓位`
  }
  return null
}

/** 已执行的 defi 交易落 tasks 表(审计;执行链记 solana-mainnet,与身份链区分) */
async function recordDefiTask(
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string },
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

function makeDriftDeposit(tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_deposit',
    description: `向 Drift(主网)存入 USDC 作为永续保证金,热钱包执行;单笔上限 ${MAX_PERP_DEPOSIT_USDC} USDC,余额不足时需先经 Meteora 兑换`,
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
        const signature = await driftDeposit(amount)
        await recordDefiTask(tokenId, { action: 'perp_deposit', params: { amount: amount.toString() }, reason: context.reason }, { txHash: signature })
        return { result: `已在主网向 Drift 存入 ${context.amount} USDC 保证金。交易签名 ${signature},浏览器明细:${mainnetTxUrl(signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftWithdraw(tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_withdraw',
    description: '从 Drift(主网)提取 USDC 保证金回热钱包,热钱包执行',
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
        const signature = await driftWithdraw(amount)
        await recordDefiTask(tokenId, { action: 'perp_withdraw', params: { amount: amount.toString() }, reason: context.reason }, { txHash: signature })
        return { result: `已从主网 Drift 提取 ${context.amount} USDC 回热钱包。交易签名 ${signature},浏览器明细:${mainnetTxUrl(signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftOpen(tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_open',
    description: `在 Drift(主网)市价开永续仓位(如 SOL-PERP 开多/开空,名义额以 USD 计价),单笔名义额上限 ${MAX_PERP_NOTIONAL_USD} USD`,
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
        const capErr = checkNotionalCap(usd)
        if (capErr) return { result: `执行失败:${capErr}` }
        const handle = await driftHandle()
        const marketIndex = resolvePerpMarketIndex(handle.env, context.market)
        const baseAmount = await driftCalcBaseAmount(marketIndex, usd)
        const signature = await driftOpenPosition(marketIndex, context.side, baseAmount)
        await recordDefiTask(
          tokenId,
          {
            action: 'perp_open',
            params: { market: context.market.toUpperCase(), side: context.side, usdSize: context.usdSize, baseAmount: baseAmount.toString() },
            reason: context.reason,
          },
          { txHash: signature },
        )
        return {
          result: `已在主网 Drift 市价${context.side === 'long' ? '开多' : '开空'} ${context.market.toUpperCase()},名义额约 ${context.usdSize} USD。交易签名 ${signature},浏览器明细:${mainnetTxUrl(signature)}`,
        }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftClose(tokenId: number) {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_close',
    description: '在 Drift(主网)市价平掉指定永续市场的全部持仓(reduce-only)',
    inputSchema: z.object({
      market: z.string().describe('永续市场,如 "SOL-PERP"'),
      reason: z.string().describe('这笔平仓的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async ({ context }) => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const handle = await driftHandle()
        const marketIndex = resolvePerpMarketIndex(handle.env, context.market)
        const signature = await driftClosePosition(marketIndex)
        await recordDefiTask(tokenId, { action: 'perp_close', params: { market: context.market.toUpperCase() }, reason: context.reason }, { txHash: signature })
        return { result: `已在主网 Drift 市价平掉 ${context.market.toUpperCase()} 全部持仓。交易签名 ${signature},浏览器明细:${mainnetTxUrl(signature)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeDriftStatus() {
  const enabled = isDriftConfigured()
  return createTool({
    id: 'drift_status',
    description: '查询 Drift(主网)账户状态:保证金、可用保证金、购买力与未平永续持仓',
    inputSchema: z.object({}),
    outputSchema: z.object({ result: z.string() }),
    execute: async () => {
      if (!enabled) return { result: 'Drift 永续未配置(需要 AGENT_SOLANA_PRIVATE_KEY)' }
      try {
        const handle = await driftHandle()
        const status = await driftStatus()
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
    version: '1.1.0',
    description:
      '⚠️ 暂停服务:Drift 官方部署(devnet 与主网)已事实下线(最近数百笔交易全部被程序拒绝,Drift 已迁移至 Velocity 新程序),入金/开仓/平仓会失败;仅 drift_status 市场查询可用。待接入 Velocity 或 Drift 恢复后自动恢复。原本功能:主网永续交易,Circle USDC 保证金,单笔入金/名义额有硬顶',
    tools: ['drift_deposit', 'drift_withdraw', 'drift_open', 'drift_close', 'drift_status'],
    permissions: [],
    scope: 'owner', // 资产操作,仅限主人对话
    solanaOnly: true, // 依赖 Solana + Drift 程序,EVM 下不可安装
  },
  makeTools: (chainKey, tokenId) => ({
    drift_deposit: makeDriftDeposit(tokenId),
    drift_withdraw: makeDriftWithdraw(tokenId),
    drift_open: makeDriftOpen(tokenId),
    drift_close: makeDriftClose(tokenId),
    drift_status: makeDriftStatus(),
  }),
}
