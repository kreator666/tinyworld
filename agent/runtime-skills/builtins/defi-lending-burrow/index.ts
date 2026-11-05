import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getDb } from '../../../src/db'
import { getChainContext } from '../../../src/chain/registry'
import { loadPersona } from '../../../src/chain/persona'
import {
  burrowGetAccount,
  burrowSupply,
  burrowBorrow,
  burrowRepay,
  burrowWithdraw,
  burrowToHuman,
  burrowToAtomic,
  buildBurrowSupplyTxs,
  buildBurrowBorrowTxs,
  buildBurrowRepayTxs,
  buildBurrowWithdrawTxs,
} from '../../../src/chain/burrow'
import { refTokens } from '../../../src/chain/ref'
import { isNearWriteReady, type NearUnsignedTx } from '../../../src/chain/nearWrite'
import { getSwapMode } from '../../../src/core/settings'
import { getNativePriceUsd } from '../../../src/core/price'
import { setPendingSignAction, type SignTxAction } from '../../../src/core/agent'
import type { ProposalAction } from '../../../src/policy/engine'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-lending-burrow:NEAR 家族借贷(存款生息/抵押借款),经 Burrow。
// 两种执行模式(与 EVM 侧对齐,读 Agent 设置的 swap_mode):
// - user_wallet(默认):Agent 只组装交易,由主人钱包逐笔签名;首次使用需付可退 storage 押金(0.25N)
// - hot_wallet:Agent NEAR 热钱包直接签名广播
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

/** 估值:WNEAR 按链原生币价,稳定币(USDC/USDT/DAI)按 $1,其余无可靠价给 null */
async function estimateBurrowValueUsd(chainKey: string, tokenSymbol: string, amountHuman: string): Promise<number | null> {
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

/**
 * 存/借/还/取共用工具壳:读 swap_mode → user_wallet 组装交易转签名 / hot_wallet 热钱包直发 → 落审计。
 * build 只组装不发交易;deposit(存款/借款)首次需 storage 押金,note 里提示可退。
 */
function makeTxTool(opts: {
  chainKey: string
  tokenId: number
  id: string
  description: string
  action: ProposalAction
  needsStorage: boolean
  run: (token: string, amountHuman: string) => Promise<string>
  build: (owner: string, token: string, amountHuman: string | null) => Promise<NearUnsignedTx[]>
  amountOf: (ctx: { amount: string }) => string | null // withdraw 'all' → null
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
    outputSchema: z.object({ verdict: z.string().optional(), unsignedTxs: z.array(z.any()).optional(), note: z.string().optional(), result: z.string().optional(), error: z.string().optional() }),
    execute: async ({ context }) => {
      try {
        const token = context.token.toUpperCase()
        const amountHuman = opts.amountOf(context) // withdraw 'all' → null
        const executionMode = await getSwapMode(opts.chainKey, opts.tokenId)

        if (executionMode === 'user_wallet') {
          const persona = await loadPersona(opts.chainKey, opts.tokenId)
          const owner = persona.owner
          const txs = await opts.build(owner, token, amountHuman)
          const amountForEstimate = amountHuman ?? '0'
          const estimatedValueUsd = amountHuman !== null ? await estimateBurrowValueUsd(opts.chainKey, token, amountForEstimate) : null
          const storageNote = opts.needsStorage ? ';首次使用 Burrow 需支付可退还的存储押金(0.25N)' : ''
          const note = `请点击聊天区下方的【签名并发送】按钮,在钱包里完成签名(${txs.length} 笔交易)${storageNote}`
          const action: SignTxAction = {
            type: 'sign_tx',
            unsignedTxs: txs,
            note,
            proposal: {
              action: opts.action,
              protocol: 'burrow',
              chainId: getChainContext(opts.chainKey).cfg.chainId,
              params: { tokenIn: token, tokenOut: token, amountIn: amountHuman ?? context.amount, owner },
              executionMode: 'user_wallet',
              estimatedValueUsd,
              reason: opts.reasonOf(context),
            },
          }
          setPendingSignAction(opts.chainKey, opts.tokenId, action)
          return { verdict: 'sign', unsignedTxs: txs, note, proposal: action.proposal }
        }

        if (!isNearWriteReady()) {
          return { result: '执行失败:未配置 AGENT_NEAR_PRIVATE_KEY(NEAR 热钱包);也可在设置中切换为用户钱包签名模式' }
        }
        const txHash = await opts.run(token, context.amount)
        await recordDefiTask(
          opts.chainKey,
          opts.tokenId,
          { action: opts.id, params: opts.paramsOf(token, context.amount), reason: opts.reasonOf(context) },
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
    description: '经 Burrow 在 NEAR 上存款生息/抵押借款/还款/取回。user_wallet 模式:Agent 组装交易、主人钱包签名(默认);hot_wallet 模式:Agent NEAR 热钱包签名执行。资产:WNEAR/USDC/USDT/DAI/WETH(testnet fakes)。含只读仓位查询',
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
      action: 'supply',
      needsStorage: true,
      run: async (token, amountHuman) => burrowSupply(chainKey, token, await burrowToAtomic(chainKey, token, amountHuman)),
      build: (owner, token, amountHuman) => buildBurrowSupplyTxs(chainKey, owner, token, amountHuman!),
      amountOf: (ctx) => ctx.amount,
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_borrow: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_borrow',
      description: '从 Burrow 借出代币(需已有存款抵押,健康因子不足会失败)',
      action: 'borrow',
      needsStorage: true,
      run: (token, amount) => burrowBorrow(chainKey, token, amount),
      build: (owner, token, amountHuman) => buildBurrowBorrowTxs(chainKey, owner, token, amountHuman!),
      amountOf: (ctx) => ctx.amount,
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_repay: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_repay',
      description: '偿还 Burrow 借款(从存款余额中扣)',
      action: 'repay',
      needsStorage: false,
      run: (token, amount) => burrowRepay(chainKey, token, amount),
      build: (owner, token, amountHuman) => buildBurrowRepayTxs(chainKey, owner, token, amountHuman!),
      amountOf: (ctx) => ctx.amount,
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
    propose_withdraw: makeTxTool({
      chainKey,
      tokenId,
      id: 'propose_withdraw',
      description: '从 Burrow 取回存款(amount 传 "all" 表示全部)',
      action: 'withdraw',
      needsStorage: false,
      run: (token, amount) => burrowWithdraw(chainKey, token, amount.toLowerCase() === 'all' ? null : amount),
      build: (owner, token, amountHuman) => buildBurrowWithdrawTxs(chainKey, owner, token, amountHuman),
      amountOf: (ctx) => (ctx.amount.toLowerCase() === 'all' ? null : ctx.amount),
      paramsOf: (token, amount) => ({ token, amount }),
      reasonOf: (ctx) => ctx.reason ?? '',
    }),
  }),
}
