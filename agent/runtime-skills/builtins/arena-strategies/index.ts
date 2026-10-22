import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { encodeFunctionData, formatUnits, parseUnits, type Address } from 'viem'
import {
  getActiveArenaAccount,
  getArenaSeason,
  insertArenaTrade,
  type ArenaAccountRow,
  type ArenaSeasonRow,
} from '../../../src/db/arena'
import { resolvePlaybook, type EffectivePlaybook } from '../../../src/core/arenaPlaybook'
import { getPlaybook } from '../../../src/core/arena'
import { computeNav } from '../../../src/core/arenaNav'
import { getChainContext } from '../../../src/chain/registry'
import {
  arenaCallFrom,
  buildArenaApproveCall,
  executeArenaCalls,
  type ArenaCall,
} from '../../../src/chain/arenaExec'
import { buildUnsignedNativeSupply, buildUnsignedNativeWithdraw, buildUnsignedSupply, buildUnsignedWithdraw, getATokenBalance, getReserveInfo } from '../../../src/chain/aave'
import { findMarketByIndexSymbol, estimateGmxExecutionFee, getAccountPositions } from '../../../src/chain/gmx'
import { buildUnsignedGmxOrder } from '../defi-perp-gmx/index'
import { getNativePriceUsd } from '../../../src/core/price'
import { getTokenBalance, quoteSwap } from '../../../src/chain/defi'
import { evaluateArenaProposal } from '../../../src/policy/arenaEngine'
import type { Proposal } from '../../../src/policy/engine'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 竞技场策略技能(P3/P4):固定收益 / 现货 / 永续 三个策略类型的执行工具。
// 结构:每个动作 = 一个导出的纯函数(arenaXxxAction),工具层只是 zod 包装;
//       调度器(P4)按 LLM 输出的动作名直接分发到同一份纯函数,不经过 Mastra 工具 API。
// 高内聚:所有动作共享一条流水线 —— 取参赛上下文 → 组提案 → 竞技场引擎(无审批)
//        → 链上白名单兜底执行(ArenaAccount.execute)→ arena_trades 落库归因。
// 复用(不复制):calldata 组装全部用现有 buildUnsigned*(aave/gmx),引擎硬规则
//        与主人模式共用 engine.ts 导出,估值用现有行情链路,净值用 core/arenaNav。
// 工具级护栏:即便 LLM 幻觉超大参数,playbook 的 maxOrderPct/maxLeverage
//        在执行前硬卡一道(调度器另有同款护栏检查,双保险)。
// ============================================================

const ZERO = '0x0000000000000000000000000000000000000000'
const SLIPPAGE_BPS = 9950n

/** V2 Router 代币→代币兑换(现有 routerAbi 只覆盖含原生币的两个方向) */
const routerTokenSwapAbi = [
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

class ArenaToolError extends Error {}

// ------------------------------------------------------------------
// 共享上下文
// ------------------------------------------------------------------

interface ArenaContext {
  season: ArenaSeasonRow
  account: ArenaAccountRow
  accountAddr: Address
  playbook: EffectivePlaybook
}

async function arenaContext(chainKey: string, tokenId: number): Promise<ArenaContext> {
  const account = await getActiveArenaAccount(chainKey, tokenId)
  if (!account) throw new ArenaToolError('该 Agent 当前没有 active 赛季的参赛账户')
  const season = await getArenaSeason(account.season_id)
  if (!season) throw new ArenaToolError('参赛记录指向的赛季不存在')
  const pbRow = await getPlaybook(season.id, tokenId)
  return { season, account, accountAddr: account.account_address as Address, playbook: resolvePlaybook(pbRow?.config) }
}

/** 工具级护栏:单笔名义 ≤ maxOrderPct × NAV(开新仓方向用) */
function assertOrderWithinLimit(playbook: EffectivePlaybook, notionalUsd: number, navUsd: number): void {
  const cap = (playbook.defaults.maxOrderPct / 100) * navUsd
  if (notionalUsd > cap) {
    throw new ArenaToolError(`单笔 $${notionalUsd.toFixed(2)} 超过 playbook 上限 $${cap.toFixed(2)}(maxOrderPct=${playbook.defaults.maxOrderPct})`)
  }
}

/** 统一执行落库:提案过竞技场引擎 → ArenaAccount 顺序执行 → arena_trades 归因 */
async function runProposal(
  ctx: ArenaContext,
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
  calls: ArenaCall[],
  strategyType: string,
): Promise<{ txHashes: string[] }> {
  const verdict = await evaluateArenaProposal(chainKey, proposal)
  if (verdict.verdict !== 'execute') {
    throw new ArenaToolError(`提案被竞技场引擎拒绝: ${verdict.reasons.join('; ')}`)
  }
  const { txHashes } = await executeArenaCalls(chainKey, ctx.accountAddr, calls)
  await insertArenaTrade({
    season_id: ctx.season.id,
    token_id: tokenId,
    strategy_type: strategyType,
    action: proposal.action,
    tx_hash: txHashes[txHashes.length - 1],
    pnl_usd: null,
    payload: { params: proposal.params, estimatedValueUsd: proposal.estimatedValueUsd, reason: proposal.reason, txHashes },
  })
  return { txHashes }
}

// ------------------------------------------------------------------
// 动作实现(纯函数,工具与调度器共用)
// ------------------------------------------------------------------

export async function arenaStatusAction(chainKey: string, tokenId: number) {
  const ctx = await arenaContext(chainKey, tokenId)
  const nav = await computeNav(chainKey, ctx.accountAddr)
  const principal = Number(ctx.season.principal_usd)
  return {
    navUsd: nav.navUsd.toFixed(2),
    pnlUsd: (nav.navUsd - principal).toFixed(2),
    pnlPct: (((nav.navUsd - principal) / principal) * 100).toFixed(2),
    breakdown: { USDC: nav.usdcUsd, [getChainContext(chainKey).cfg.defi!.nativeSymbol]: nav.nativeUsd, aave: nav.aaveUsd, gmx: nav.gmxUsd },
    guardrails: ctx.playbook.guardrails,
    riskProfile: ctx.playbook.riskProfile,
    account: ctx.accountAddr,
  }
}

export async function arenaSupplyAction(chainKey: string, tokenId: number, args: { asset: string; amountUsd: number }) {
  const ctx = await arenaContext(chainKey, tokenId)
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.aave) throw new ArenaToolError('该链未配置 Aave')
  const isNative = args.asset.toUpperCase() === cfg.defi!.nativeSymbol
  const assetCfg = isNative ? null : (cfg.aave.assets ?? []).find((a) => a.symbol.toUpperCase() === args.asset.toUpperCase())
  if (!isNative && !assetCfg) throw new ArenaToolError(`Aave 不支持该资产: ${args.asset}`)
  const nav = await computeNav(chainKey, ctx.accountAddr)
  assertOrderWithinLimit(ctx.playbook, args.amountUsd, nav.navUsd)
  // 现金缓冲护栏:存入后 USDC 现金不得低于 minCashBufferPct(仅对 USDC 存款精确检查)
  if (!isNative) {
    const usdcBal = cfg.defi!.usdc === ZERO ? 0n : await getTokenBalance(chainKey, cfg.defi!.usdc as Address, ctx.accountAddr)
    const cashUsd = Number(formatUnits(usdcBal, 6))
    if (cashUsd - args.amountUsd < (ctx.playbook.guardrails.minCashBufferPct / 100) * nav.navUsd) {
      throw new ArenaToolError(`存入后现金缓冲低于 ${ctx.playbook.guardrails.minCashBufferPct}% 下限,拒绝`)
    }
  }
  let amountUnits: bigint
  let calls: ArenaCall[]
  if (isNative) {
    const nativeUsd = (await getNativePriceUsd(chainKey)).usd
    amountUnits = parseUnits((args.amountUsd / nativeUsd).toFixed(6), 18)
    calls = [arenaCallFrom(buildUnsignedNativeSupply(chainKey, amountUnits, ctx.accountAddr))]
  } else {
    amountUnits = parseUnits(args.amountUsd.toFixed(6), assetCfg!.decimals)
    calls = [
      buildArenaApproveCall(assetCfg!.address as Address, cfg.aave!.pool as Address, amountUnits),
      arenaCallFrom(buildUnsignedSupply(chainKey, assetCfg!.address as Address, amountUnits, ctx.accountAddr)),
    ]
  }
  const proposal: Proposal = {
    action: 'supply',
    protocol: cfg.aave!.pool,
    chainId: cfg.chainId,
    params: { tokenIn: isNative ? 'native' : assetCfg!.address, tokenOut: 'aToken', amountIn: amountUnits.toString() },
    executionMode: 'hot_wallet',
    estimatedValueUsd: args.amountUsd,
    reason: `arena 固收:存入 ${args.asset} $${args.amountUsd}`,
  }
  return runProposal(ctx, chainKey, tokenId, proposal, calls, 'fixed_yield')
}

export async function arenaWithdrawAction(chainKey: string, tokenId: number, args: { asset: string; amountUsd?: number }) {
  const ctx = await arenaContext(chainKey, tokenId)
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.aave) throw new ArenaToolError('该链未配置 Aave')
  const isNative = args.asset.toUpperCase() === cfg.defi!.nativeSymbol
  const assetCfg = isNative ? null : (cfg.aave.assets ?? []).find((a) => a.symbol.toUpperCase() === args.asset.toUpperCase())
  if (!isNative && !assetCfg) throw new ArenaToolError(`Aave 不支持该资产: ${args.asset}`)
  let amountUnits: bigint
  if (isNative) {
    const nativeAsset = (cfg.aave.assets ?? []).find((a) => a.isNative)
    amountUnits = args.amountUsd
      ? parseUnits(args.amountUsd.toFixed(6), 18)
      : await getATokenBalance(chainKey, (await getReserveInfo(chainKey, nativeAsset!.address as Address)).aToken, ctx.accountAddr)
  } else {
    const info = await getReserveInfo(chainKey, assetCfg!.address as Address)
    const aBal = await getATokenBalance(chainKey, info.aToken, ctx.accountAddr)
    amountUnits = args.amountUsd ? parseUnits(args.amountUsd.toFixed(6), assetCfg!.decimals) : aBal
    if (amountUnits > aBal) amountUnits = aBal
  }
  if (amountUnits <= 0n) throw new ArenaToolError('Aave 无该资产存款')
  const calls: ArenaCall[] = [
    isNative
      ? arenaCallFrom(buildUnsignedNativeWithdraw(chainKey, amountUnits, ctx.accountAddr))
      : arenaCallFrom(buildUnsignedWithdraw(chainKey, assetCfg!.address as Address, amountUnits, ctx.accountAddr)),
  ]
  const proposal: Proposal = {
    action: 'withdraw',
    protocol: cfg.aave!.pool,
    chainId: cfg.chainId,
    params: { tokenIn: 'aToken', tokenOut: isNative ? 'native' : assetCfg!.address, amountIn: amountUnits.toString() },
    executionMode: 'hot_wallet',
    estimatedValueUsd: args.amountUsd ?? null,
    reason: `arena 固收:取出 ${args.asset}`,
  }
  return runProposal(ctx, chainKey, tokenId, proposal, calls, 'fixed_yield')
}

export async function arenaSwapAction(chainKey: string, tokenId: number, args: { tokenIn: string; tokenOut: string; amountUsd: number }) {
  const ctx = await arenaContext(chainKey, tokenId)
  const cfg = getChainContext(chainKey).cfg
  const cfgD = cfg.defi!
  const resolve = (s: string): { addr: Address; decimals: number; isNative: boolean } => {
    if (s.toUpperCase() === cfgD.nativeSymbol || ['AVAX', 'ETH', 'NATIVE'].includes(s.toUpperCase())) {
      return { addr: cfgD.wNative as Address, decimals: 18, isNative: true }
    }
    if (s.toUpperCase() === 'USDC') return { addr: cfgD.usdc as Address, decimals: 6, isNative: false }
    if (s.toUpperCase() === 'USDT' && cfgD.usdt !== ZERO) return { addr: cfgD.usdt as Address, decimals: 6, isNative: false }
    if (['WAVAX', 'WETH', 'WNATIVE'].includes(s.toUpperCase())) return { addr: cfgD.wNative as Address, decimals: 18, isNative: false }
    throw new ArenaToolError(`不支持的代币: ${s}`)
  }
  const tIn = resolve(args.tokenIn)
  const tOut = resolve(args.tokenOut)
  if (tIn.addr === tOut.addr) throw new ArenaToolError('兑换双方相同')
  const nav = await computeNav(chainKey, ctx.accountAddr)
  assertOrderWithinLimit(ctx.playbook, args.amountUsd, nav.navUsd)
  const amountUnits = parseUnits(args.amountUsd.toFixed(6), tIn.decimals)
  const amountOutMin = (await quoteSwap(chainKey, amountUnits, tIn.addr)) * SLIPPAGE_BPS / 10000n
  const swapData = encodeFunctionData({
    abi: routerTokenSwapAbi,
    functionName: 'swapExactTokensForTokens',
    args: [amountUnits, amountOutMin, [tIn.addr, tOut.addr], ctx.accountAddr, BigInt(Math.floor(Date.now() / 1000) + 600)],
  })
  const calls: ArenaCall[] = [
    ...(tIn.isNative ? [] : [buildArenaApproveCall(tIn.addr, cfgD.router as Address, amountUnits)]),
    { target: cfgD.router as Address, value: 0n, data: swapData },
  ]
  const proposal: Proposal = {
    action: 'swap',
    protocol: cfgD.router,
    chainId: cfg.chainId,
    params: { tokenIn: tIn.isNative ? 'native' : tIn.addr, tokenOut: tOut.isNative ? 'native' : tOut.addr, amountIn: amountUnits.toString(), amountOutMin: amountOutMin.toString() },
    executionMode: 'hot_wallet',
    estimatedValueUsd: args.amountUsd,
    reason: `arena 现货:${args.tokenIn} → ${args.tokenOut} $${args.amountUsd}`,
  }
  return runProposal(ctx, chainKey, tokenId, proposal, calls, 'spot')
}

export async function arenaPerpOpenAction(
  chainKey: string,
  tokenId: number,
  args: { indexSymbol: string; side: 'LONG' | 'SHORT'; sizeUsd: number; collateralUsd: number },
) {
  const ctx = await arenaContext(chainKey, tokenId)
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.gmx) throw new ArenaToolError('该链未配置 GMX')
  const nav = await computeNav(chainKey, ctx.accountAddr)
  assertOrderWithinLimit(ctx.playbook, args.sizeUsd, nav.navUsd)
  const leverage = args.sizeUsd / args.collateralUsd
  if (leverage > ctx.playbook.defaults.maxLeverage) {
    throw new ArenaToolError(`杠杆 ${leverage.toFixed(2)}x 超过 playbook 上限 ${ctx.playbook.defaults.maxLeverage}x`)
  }
  const usdcBal = await getTokenBalance(chainKey, cfg.defi!.usdc as Address, ctx.accountAddr)
  const collateralUnits = parseUnits(args.collateralUsd.toFixed(6), 6)
  if (usdcBal < collateralUnits) throw new ArenaToolError('USDC 余额不足')
  const market = await findMarketByIndexSymbol(chainKey, args.indexSymbol)
  if (!market) throw new ArenaToolError(`GMX 无该市场: ${args.indexSymbol}`)
  const executionFee = await estimateGmxExecutionFee(chainKey, 'increase')
  // calldata 组装复用 buildUnsignedGmxOrder(user = 托管账户,仓位归属账户)
  const unsigned = await buildUnsignedGmxOrder(
    chainKey, market, args.side, 'increase',
    String(args.sizeUsd), cfg.defi!.usdc as Address, collateralUnits,
    ctx.accountAddr, executionFee,
  )
  const calls = unsigned.map((u) => arenaCallFrom(u))
  const proposal: Proposal = {
    action: 'gmx_order',
    protocol: cfg.gmx.exchangeRouter,
    chainId: cfg.chainId,
    params: { tokenIn: cfg.defi!.usdc, tokenOut: market.indexSymbol, amountIn: collateralUnits.toString(), amountOutMin: String(args.sizeUsd) },
    executionMode: 'hot_wallet',
    estimatedValueUsd: args.sizeUsd,
    reason: `arena 永续:${args.side} ${args.indexSymbol} $${args.sizeUsd} @${leverage.toFixed(1)}x`,
  }
  return runProposal(ctx, chainKey, tokenId, proposal, calls, 'perp')
}

export async function arenaPerpCloseAction(chainKey: string, tokenId: number, args: { indexSymbol: string }) {
  const ctx = await arenaContext(chainKey, tokenId)
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.gmx) throw new ArenaToolError('该链未配置 GMX')
  const market = await findMarketByIndexSymbol(chainKey, args.indexSymbol)
  if (!market) throw new ArenaToolError(`GMX 无该市场: ${args.indexSymbol}`)
  const positions = await getAccountPositions(chainKey, ctx.accountAddr)
  const pos = positions.find((p) => p.market.toLowerCase() === market.marketToken.toLowerCase())
  if (!pos) throw new ArenaToolError('该市场无持仓')
  const side = pos.isLong ? 'LONG' : 'SHORT'
  const sizeUsd = Number(formatUnits(pos.sizeInUsd, 30))
  const executionFee = await estimateGmxExecutionFee(chainKey, 'decrease')
  const unsigned = await buildUnsignedGmxOrder(
    chainKey, market, side, 'decrease',
    String(sizeUsd), cfg.defi!.usdc as Address, pos.collateralAmount,
    ctx.accountAddr, executionFee,
  )
  const calls = unsigned.map((u) => arenaCallFrom(u))
  const proposal: Proposal = {
    action: 'gmx_order',
    protocol: cfg.gmx.exchangeRouter,
    chainId: cfg.chainId,
    params: { tokenIn: cfg.defi!.usdc, tokenOut: market.indexSymbol, amountIn: pos.collateralAmount.toString(), amountOutMin: String(sizeUsd) },
    executionMode: 'hot_wallet',
    estimatedValueUsd: sizeUsd,
    reason: `arena 永续:平 ${args.indexSymbol} 仓位`,
  }
  return runProposal(ctx, chainKey, tokenId, proposal, calls, 'perp')
}

/** 动作名 → 纯函数(调度器按 LLM 输出分发;新增动作在此登记) */
export const ARENA_ACTIONS: Record<string, (chainKey: string, tokenId: number, args: never) => Promise<unknown>> = {
  arena_status: arenaStatusAction as never,
  arena_supply: arenaSupplyAction as never,
  arena_withdraw: arenaWithdrawAction as never,
  arena_swap: arenaSwapAction as never,
  arena_perp_open: arenaPerpOpenAction as never,
  arena_perp_close: arenaPerpCloseAction as never,
}

// ------------------------------------------------------------------
// 工具层(zod 包装,仅服务 LLM 对话路径)
// ------------------------------------------------------------------

function makeArenaStatus(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_status',
    description: '查询竞技场账户状态:净值构成、持仓、护栏与燃料(只读,不消耗燃料)',
    inputSchema: z.object({}),
    execute: async () => arenaStatusAction(chainKey, tokenId),
  })
}

function makeArenaSupply(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_supply',
    description: '固定收益:向 Aave 存入资产(USDC/AVAX),收益自动累计到托管账户',
    inputSchema: z.object({
      asset: z.string().describe('USDC 或 AVAX'),
      amountUsd: z.number().positive().describe('存入金额(USD 计价)'),
    }),
    execute: async ({ context }) => arenaSupplyAction(chainKey, tokenId, context),
  })
}

function makeArenaWithdraw(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_withdraw',
    description: '固定收益:从 Aave 取出资产(支持全部取出)',
    inputSchema: z.object({
      asset: z.string().describe('USDC 或 AVAX'),
      amountUsd: z.number().positive().optional().describe('取出金额;不传 = 全部'),
    }),
    execute: async ({ context }) => arenaWithdrawAction(chainKey, tokenId, context),
  })
}

function makeArenaSwap(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_swap',
    description: '现货:在 DEX 做代币间兑换(白名单币对,0.5% 滑点保护)',
    inputSchema: z.object({
      tokenIn: z.string().describe('如 USDC / AVAX'),
      tokenOut: z.string().describe('如 AVAX / USDC'),
      amountUsd: z.number().positive().describe('卖出金额(USD 计价)'),
    }),
    execute: async ({ context }) => arenaSwapAction(chainKey, tokenId, context),
  })
}

function makeArenaPerpOpen(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_perp_open',
    description: '永续:GMX 开多/开空(indexSymbol 如 BTC/ETH/AVAX,抵押 USDC)',
    inputSchema: z.object({
      indexSymbol: z.string().describe('指数符号,如 BTC'),
      side: z.enum(['LONG', 'SHORT']),
      sizeUsd: z.number().positive().describe('名义仓位(USD)'),
      collateralUsd: z.number().positive().describe('抵押金额(USD,来自 USDC 余额)'),
    }),
    execute: async ({ context }) => arenaPerpOpenAction(chainKey, tokenId, context),
  })
}

function makeArenaPerpClose(chainKey: string, tokenId: number) {
  return createTool({
    id: 'arena_perp_close',
    description: '永续:平掉某市场的全部仓位',
    inputSchema: z.object({
      indexSymbol: z.string().describe('指数符号,如 BTC'),
    }),
    execute: async ({ context }) => arenaPerpCloseAction(chainKey, tokenId, context),
  })
}

export const arenaStrategies: SkillDef = {
  manifest: {
    id: 'arena-strategies',
    name: '竞技场策略',
    version: '0.2.0',
    description: '竞技场自主交易(固收/现货/永续),资金出口链上白名单约束',
    tools: ['arena_status', 'arena_supply', 'arena_withdraw', 'arena_swap', 'arena_perp_open', 'arena_perp_close'],
    permissions: [],
    scope: 'owner',
    evmOnly: true,
  },
  makeTools: (chainKey: string, tokenId: number) => ({
    arena_status: makeArenaStatus(chainKey, tokenId),
    arena_supply: makeArenaSupply(chainKey, tokenId),
    arena_withdraw: makeArenaWithdraw(chainKey, tokenId),
    arena_swap: makeArenaSwap(chainKey, tokenId),
    arena_perp_open: makeArenaPerpOpen(chainKey, tokenId),
    arena_perp_close: makeArenaPerpClose(chainKey, tokenId),
  }),
}
