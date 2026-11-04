import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getDb } from '../../../src/db'
import { getChainContext } from '../../../src/chain/registry'
import {
  burrowGetAccount,
  burrowSupply,
  burrowBorrow,
  burrowRepay,
  burrowWithdraw,
  burrowToHuman,
  burrowToAtomic,
} from '../../../src/chain/burrow'
import { refTokens } from '../../../src/chain/ref'
import { isNearWriteReady } from '../../../src/chain/nearWrite'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-lending-burrow:NEAR 家族借贷(存款生息/抵押借款),经 Burrow。
// 仅 hot_wallet 模式:Agent NEAR 热钱包直接签名广播;user_wallet 暂不支持。
// 每笔成交落 tasks 表审计;仓位查询 get_position 为只读工具,不触发交易。
// ============================================================

async function recordDefiTask(
  chainKey: string,
  tokenId: number,
  payload: { action: string; params: Record<string, string>; reason: string },
  result: { txHash: string },
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

function txUrl(chainKey: string, hash: string): string {
  const explorer = getChainContext(chainKey).cfg.explorer
  return explorer.includes('nearblocks') ? `${explorer}/txns/${hash}` : `${explorer}/tx/${hash}`
}

/** 只读仓位查询 */
function makeGetPosition(chainKey: string, tokenId: number) {
  const TOKEN_SYMBOLS = Object.keys(refTokens(chainKey)) as [string, ...string[]]
  return createTool({
    id: 'get_position',
    description: '查询 Agent 热钱包在 Burrow 上的借贷仓位(存款/抵押/借款/健康因子),只读不产生交易',
    inputSchema: z.object({}),
    outputSchema: z.object({ result: z.string().optional(), error: z.string().optional() }),
    execute: async () => {
      try {
        const acc = await burrowGetAccount(chainKey)
        if (!acc) return { result: '该账户尚未在 Burrow 注册(首次存款会自动注册)' }
        const fmt = (list: { token_id: string; balance?: string }[]) =>
          list.length === 0
            ? '无'
            : list
                .map(async (a) => {
                  const sym = Object.values(refTokens(chainKey)).find((t) => t.contractId === a.token_id)?.symbol ?? a.token_id
                  const human = a.balance ? await burrowToHuman(chainKey, sym, a.balance).catch(() => a.balance) : '?'
                  return `${sym} ${human}`
                })
        const parts = await Promise.all([
          Promise.all(fmt(acc.supplied ?? [])),
          Promise.all(fmt(acc.borrowed ?? [])),
        ])
        return {
          result:
            `Burrow 仓位\n存款: ${(await parts[0]).join(', ')}\n借款: ${(await parts[1]).join(', ')}` +
            (acc.health_factor ? `\n健康因子: ${acc.health_factor}` : '') +
            (acc.borrow_power ? `\n可借额度: ${acc.borrow_power}` : ''),
        }
      } catch (e) {
        return { error: `查询失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

function makeTxTool(opts: {
  chainKey: string
  tokenId: number
  id: string
  description: string
  run: (token: string, amountHuman: string) => Promise<string>
  paramsOf: (token: string, amountHuman: string) => Record<string, string>
  reasonOf: (ctx: { reason?: string }) => string
}) {
  const TOKEN_SYMBOLS = Object.keys(refTokens(opts.chainKey)) as [string, ...string[]]
  return createTool({
    id: opts.id,
    description: opts.description,
    inputSchema: z.object({
      token: z.enum(TOKEN_SYMBOLS).describe(`代币:${TOKEN_SYMBOLS.join(' / ')}`),
      amount: z.string().describe('数量(人类单位,如 "10.5";withdraw 传 "all" 表示全部取回)'),
      reason: z.string().optional().describe('操作理由(写进审计记录)'),
    }),
    outputSchema: z.object({ result: z.string().optional(), error: z.string().optional() }),
    execute: async ({ context }) => {
      if (!isNearWriteReady()) {
        return { result: '执行失败:未配置 AGENT_NEAR_PRIVATE_KEY(NEAR 热钱包)' }
      }
      try {
        const txHash = await opts.run(context.token.toUpperCase(), context.amount)
        await recordDefiTask(
          opts.chainKey,
          opts.tokenId,
          { action: opts.id, params: opts.paramsOf(context.token.toUpperCase(), context.amount), reason: opts.reasonOf(context) },
          { txHash },
        )
        return { result: `已确认上链,交易哈希 ${txHash},浏览器明细:${txUrl(opts.chainKey, txHash)}` }
      } catch (e) {
        return { result: `执行失败:${e instanceof Error ? e.message : String(e)}` }
      }
    },
  })
}

export const defiLendingBurrow: SkillDef = {
  manifest: {
    id: 'defi-lending-burrow',
    name: 'NEAR 借贷',
    version: '1.0.0',
    description: '经 Burrow 在 NEAR 上存款生息/抵押借款/还款/取回(hot_wallet:Agent NEAR 热钱包签名执行)。资产:WNEAR/USDC/USDT/DAI/WETH(testnet fakes)。含只读仓位查询',
    tools: ['get_position', 'propose_supply', 'propose_borrow', 'propose_repay', 'propose_withdraw'],
    permissions: [],
    scope: 'owner',
    nearOnly: true,
    protocol: 'burrow',
    protocolRequired: true,
  },
  makeTools: (chainKey, tokenId) => ({
    get_position: makeGetPosition(chainKey, tokenId),
    propose_supply: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_supply',
      description: '向 Burrow 存入代币(生息并计入抵押),原子单位换算自动完成',
      run: async (token, amountHuman) => burrowSupply(chainKey, token, await burrowToAtomic(chainKey, token, amountHuman)),
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_borrow: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_borrow',
      description: '从 Burrow 借出代币(需已有存款抵押,健康因子不足会失败)',
      run: (token, amount) => burrowBorrow(chainKey, token, amount),
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_repay: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_repay',
      description: '偿还 Burrow 借款(从存款余额中扣)',
      run: (token, amount) => burrowRepay(chainKey, token, amount),
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_withdraw: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_withdraw',
      description: '从 Burrow 取回存款(amount 传 "all" 表示全部)',
      run: (token, amount) => burrowWithdraw(chainKey, token, amount.toLowerCase() === 'all' ? null : amount),
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
  }),
}
