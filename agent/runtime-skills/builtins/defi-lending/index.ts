import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatUnits, parseUnits, type Address } from 'viem'
import { getDb } from '../../../src/db'
import {
  getATokenBalance,
  getLendingWalletAddress,
  getReserveInfo,
  getTokenAllowance,
  getAssetPriceUsd,
  buildUnsignedNativeSupply,
  buildUnsignedSupply,
  buildUnsignedNativeWithdraw,
  buildUnsignedWithdraw,
  supplyErc20,
  supplyNative,
  withdrawErc20,
  withdrawNative,
  nativeGateway,
  type ReserveInfo,
} from '../../../src/chain/aave'
import { buildUnsignedErc20Approve } from '../../../src/chain/defi'
import { getNativeBalance, getTokenBalance, hasAgentKey } from '../../../src/chain/defi'
import { getChainContext, chainKeyByChainId } from '../../../src/chain/registry'
import { getSwapMode } from '../../../src/core/settings'
import { createApproval } from '../../../src/core/approvals'
import { evaluateProposal, type Proposal } from '../../../src/policy/engine'
import { setPendingSignAction } from '../../../src/core/agent'
import { loadPersona } from '../../../src/chain/persona'
import { recordDefiTask } from '../defi-swap'
import type { UnsignedTx } from '../../../src/chain/defi'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-lending(M4+):Aave v3 借贷理财
// - supply: 热钱包资金存入 Aave 赚供给收益(Supply APY),AVAX 走 Gateway、ERC20 直接 supply
// - withdraw: 连本带息取回(利息由 aToken 余额自动累积)
// - position: 只读查询当前存款仓位与实时 APY
// 权限:manifest 声明 ['defi'],同 defi-swap,链上模块注册表未启用、由策略引擎兜底
// ============================================================

/** 获取该链 Aave 资产列表;未在 config 配置时回落到 [wNative(标记 isNative), usdc] 以保持向后兼容 */
function getAaveAssets(chainKey: string) {
  const cfg = getChainContext(chainKey).cfg
  return (
    cfg.aave?.assets ?? [
      { symbol: cfg.defi!.nativeSymbol, address: cfg.defi!.wNative, decimals: 18, isNative: true },
      { symbol: 'USDC', address: cfg.defi!.usdc, decimals: 6 },
    ]
  ).filter((a) => a.address !== '0x0000000000000000000000000000000000000000')
}

function normalizeAsset(a: ReturnType<typeof getAaveAssets>[number]): { address: Address; decimals: number; isNative: boolean; symbol: string } {
  return { ...a, address: a.address as Address, isNative: a.isNative ?? false }
}

function resolveToken(
  chainKey: string,
  symbolOrAddress: string,
): { address: Address; decimals: number; isNative: boolean; symbol: string } | null {
  const s = symbolOrAddress.trim()
  const cfg = getChainContext(chainKey).cfg
  const assets = getAaveAssets(chainKey)

  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    const match = assets.find((a) => a.address.toLowerCase() === s.toLowerCase())
    return match ? normalizeAsset(match) : null
  }

  const upper = s.toUpperCase()
  // 先精确匹配 symbol
  let match = assets.find((a) => a.symbol.toUpperCase() === upper)
  if (match) return normalizeAsset(match)

  // 兼容原生币常见别名:AVAX/WAVAX/ETH/WETH/NATIVE
  const nativeAliases = ['NATIVE', cfg.defi!.nativeSymbol.toUpperCase(), `W${cfg.defi!.nativeSymbol.toUpperCase()}`]
  if (cfg.defi!.nativeSymbol === 'AVAX') nativeAliases.push('AVAX', 'WAVAX')
  if (cfg.defi!.nativeSymbol === 'ETH') nativeAliases.push('ETH', 'WETH')
  if (nativeAliases.includes(upper)) {
    match = assets.find((a) => a.isNative)
    if (match) return normalizeAsset(match)
  }

  return null
}

function symbolOf(token: { isNative: boolean; symbol: string; address: Address }): string {
  return token.symbol
}

/** 估值:通过 Aave 官方 Oracle 读取 asset 的 USD 价格,乘以数量。价格源失败返回 null(熔断信号) */
async function estimateValueUsd(
  chainKey: string,
  token: { address: Address; decimals: number },
  amount: bigint,
): Promise<number | null> {
  try {
    const price = await getAssetPriceUsd(chainKey, token.address)
    return Number(formatUnits(amount, token.decimals)) * price
  } catch {
    return null
  }
}

/** 已执行的借贷操作落 tasks 表(审计 + 策略引擎日累计/冷却的数据源) */
async function recordLendingTask(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
  result: { txHash: string; amount: string; usdValue: number | null },
) {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    randomUUID(),
    chainKey,
    tokenId,
    'defi',
    'done',
    JSON.stringify({ action: proposal.action, params: proposal.params, reason: proposal.reason }),
    JSON.stringify(result),
  ])
}

/** 把完整 Proposal 中需要回传后端记 tasks 表的字段抽出来,附加到 sign_tx action */
function recordingProposal(p: Proposal) {
  return {
    action: p.action,
    protocol: p.protocol,
    chainId: p.chainId,
    params: p.params,
    executionMode: p.executionMode,
    estimatedValueUsd: p.estimatedValueUsd,
    reason: p.reason,
  }
}

/** supply 提案 */
async function buildSupplyProposal(
  chainKey: string,
  token: { address: Address; decimals: number; isNative: boolean; symbol: string },
  amountInHuman: string,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  const amount = parseUnits(amountInHuman, token.decimals)
  if (amount <= 0n) throw new Error('amountIn 必须大于 0')
  return {
    action: 'supply',
    protocol: cfg.aave!.pool,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: token.isNative ? 'native' : token.address,
      tokenOut: `aToken(${token.symbol})`,
      amountIn: amount.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(chainKey, token, amount),
    reason,
  }
}

/** withdraw 提案 */
async function buildWithdrawProposal(
  chainKey: string,
  token: { address: Address; decimals: number; isNative: boolean; symbol: string },
  amountInHuman: string,
  reason: string,
  executionMode: Proposal['executionMode'],
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  const amount = parseUnits(amountInHuman, token.decimals)
  if (amount <= 0n) throw new Error('amountIn 必须大于 0')
  return {
    action: 'withdraw',
    protocol: cfg.aave!.pool,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: token.isNative ? 'native' : token.address,
      tokenOut: token.isNative ? 'native' : token.address,
      amountIn: amount.toString(),
    },
    estimatedValueUsd: await estimateValueUsd(chainKey, token, amount),
    reason,
  }
}

/** 执行已放行的借贷提案(工具 execute 分支和审批 approve 端点共用) */
export async function executeLendingProposal(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
): Promise<{ txHash: string; amountOut: string }> {
  // 多链重构:执行链按 proposal.chainId 路由(与请求链解耦)
  const execChainKey = chainKeyByChainId(proposal.chainId) ?? chainKey
  const cfg = getChainContext(execChainKey).cfg
  const isNative = proposal.params.tokenIn === 'native'
  const asset = (isNative ? cfg.defi!.wNative : proposal.params.tokenIn) as Address
  const amount = BigInt(proposal.params.amountIn)
  const result = isNative
    ? proposal.action === 'supply'
      ? await supplyNative(execChainKey, amount)
      : await withdrawNative(execChainKey, amount)
    : proposal.action === 'supply'
      ? await supplyErc20(execChainKey, asset, amount)
      : await withdrawErc20(execChainKey, asset, amount)
  await recordLendingTask(execChainKey, tokenId, proposal, {
    txHash: result.txHash,
    amount: result.delta.toString(),
    usdValue: proposal.estimatedValueUsd,
  })
  return { txHash: result.txHash, amountOut: result.delta.toString() }
}

/** propose_supply 工具(存入赚收益) */
function makeProposeSupply(chainKey: string, tokenId: number) {
  const symbols = getAaveAssets(chainKey)
    .map((a) => a.symbol)
    .join('/')
  return createTool({
    id: 'propose_supply',
    description: `把资金存入 Aave 赚供给收益(类似银行活期理财)。当前链支持: ${symbols}。执行模式跟随「兑换执行模式」设置:热钱包自动执行,或主人钱包签名(返回 verdict=sign 时需主人点【签名并发送】)。限额/冷却/熔断由策略引擎把关,超限转审批中心。`,
    inputSchema: z.object({
      tokenIn: z.string().describe(`存入币种,支持: ${symbols}`),
      amountIn: z.string().describe('存入数量(人类单位,如 "0.05")'),
      reason: z.string().describe('这笔存款的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      amountOut: z.string().optional(),
      apy: z.number().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      const token = resolveToken(chainKey, context.tokenIn)
      if (!token) return { verdict: 'rejected', error: `无法识别的币种: ${context.tokenIn}(支持 ${symbols})` }

      const executionMode = await getSwapMode(chainKey, tokenId)
      const isNative = token.isNative

      // 实时 APY 报价(链上只读)
      let reserve: ReserveInfo
      try {
        reserve = await getReserveInfo(chainKey, token.address)
      } catch (err) {
        return { verdict: 'rejected', error: `读取 Aave 储备数据失败: ${err instanceof Error ? err.message : String(err)}` }
      }
      const symbol = symbolOf(token)
      const amount = parseUnits(context.amountIn, token.decimals)

      const proposal = await buildSupplyProposal(chainKey, token, context.amountIn, context.reason, executionMode)
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)
      const note = `这笔存款:\n- 存入 ${context.amountIn} ${symbol}\n- 当前 APY 约 ${(reserve.supplyApy * 100).toFixed(2)}%\n- 利息按秒累积,随时可取`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式:组装交易,前端弹钱包签名 ----
      if (executionMode === 'user_wallet') {
        const persona = await loadPersona(chainKey, tokenId)
        const user = persona.owner as Address

        // 用户余额预检(链上只读,提前给出口径一致的报错)
        const userBalance = isNative ? await getNativeBalance(chainKey, user) : await getTokenBalance(chainKey, token.address, user)
        if (isNative) {
          if (userBalance < amount + parseUnits('0.01', token.decimals)) {
            return { verdict: 'rejected', error: `你的 ${symbol} 不足(需 ${context.amountIn} + gas,当前 ${formatUnits(userBalance, token.decimals)})` }
          }
        } else if (userBalance < amount) {
          return { verdict: 'rejected', error: `你的 ${symbol} 不足(需 ${context.amountIn},当前 ${formatUnits(userBalance, token.decimals)})` }
        }

        const unsignedTxs: UnsignedTx[] = []
        if (isNative) {
          unsignedTxs.push(buildUnsignedNativeSupply(chainKey, amount, user))
        } else {
          const allowance = await getTokenAllowance(chainKey, token.address, user, cfg.aave!.pool)
          if (allowance < amount) {
            unsignedTxs.push(buildUnsignedErc20Approve(chainKey, token.address, cfg.aave!.pool, amount))
          }
          unsignedTxs.push(buildUnsignedSupply(chainKey, token.address, amount, user))
        }
        proposal.unsignedTxs = unsignedTxs
        const action = {
          type: 'sign_tx' as const,
          unsignedTxs,
          note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认(${unsignedTxs.length} 笔交易)`,
          proposal: recordingProposal(proposal),
        }
        setPendingSignAction(chainKey, tokenId, action)
        return { verdict: 'sign', ...action }
      }

      // ---- 热钱包自动模式 ----
      if (!hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行存款' }
      }
      const wallet = getLendingWalletAddress()!

      // 余额预检(链上只读)
      const balance = isNative ? await getNativeBalance(chainKey, wallet) : await getTokenBalance(chainKey, token.address, wallet)
      if (isNative) {
        // 原生币要预留 gas(按 0.01 估算)
        if (balance < amount + parseUnits('0.01', token.decimals)) {
          return { verdict: 'rejected', error: `热钱包 ${symbol} 不足(需 ${context.amountIn} + gas,当前 ${formatUnits(balance, token.decimals)})` }
        }
      } else if (balance < amount) {
        return { verdict: 'rejected', error: `热钱包 ${symbol} 不足(需 ${context.amountIn},当前 ${formatUnits(balance, token.decimals)})` }
      }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash } = await executeLendingProposal(chainKey, tokenId, proposal)
      return {
        verdict,
        txHash,
        apy: reserve.supplyApy,
        note: `${note};已存入: ${cfg.explorer}/tx/${txHash}`,
      }
    },
  })
}

/** propose_withdraw 工具(取出) */
function makeProposeWithdraw(chainKey: string, tokenId: number) {
  const symbols = getAaveAssets(chainKey)
    .map((a) => a.symbol)
    .join('/')
  return createTool({
    id: 'propose_withdraw',
    description: `从 Aave 取回存款(连本带息,利息已按 aToken 余额自动累积)。当前链支持: ${symbols}。限额/冷却由策略引擎把关,超限会转审批中心。`,
    inputSchema: z.object({
      tokenOut: z.string().describe(`取回币种,支持: ${symbols}`),
      amountOut: z.string().describe('取回数量(人类单位,如 "0.05");输入 "all" 取回全部'),
      reason: z.string().describe('取出的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      amountOut: z.string().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      const token = resolveToken(chainKey, context.tokenOut)
      if (!token) return { verdict: 'rejected', error: `无法识别的币种: ${context.tokenOut}(支持 ${symbols})` }

      const executionMode = await getSwapMode(chainKey, tokenId)
      // 用户钱包模式下查用户(owner)的 aToken 余额;热钱包模式查热钱包
      const reserve = await getReserveInfo(chainKey, token.address)
      const isNative = token.isNative
      const symbol = symbolOf(token)
      const actor =
        executionMode === 'user_wallet' ? ((await loadPersona(chainKey, tokenId)).owner as Address) : getLendingWalletAddress()

      if (executionMode !== 'user_wallet' && !hasAgentKey()) {
        return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行取出' }
      }
      if (!actor) return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY)' }

      const supplied = await getATokenBalance(chainKey, reserve.aToken, actor)
      if (supplied === 0n) {
        return { verdict: 'rejected', error: `${executionMode === 'user_wallet' ? '你' : '热钱包'}没有 ${symbol} 存款` }
      }

      // 全部取出 or 指定数量
      let amount: bigint
      if (context.amountOut.trim().toLowerCase() === 'all') {
        amount = supplied
      } else {
        amount = parseUnits(context.amountOut, token.decimals)
        if (amount <= 0n) return { verdict: 'rejected', error: 'amountOut 必须大于 0' }
        if (amount > supplied) {
          return { verdict: 'rejected', error: `存款不足(持有 ${formatUnits(supplied, token.decimals)},要取 ${context.amountOut})` }
        }
      }
      const amountHuman = formatUnits(amount, token.decimals)

      const proposal = await buildWithdrawProposal(chainKey, token, amountHuman, context.reason, executionMode)
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)
      const note = `将取回 ≈${amountHuman} ${symbol}(含已累积利息)`
      if (verdict === 'rejected') return { verdict, reasons, note }

      // ---- 用户钱包签名模式 ----
      if (executionMode === 'user_wallet') {
        const unsignedTxs: UnsignedTx[] = []
        if (isNative) {
          // 网关 withdrawETH 会 transferFrom 用户的 aToken,需先 approve aToken→网关
          const allowance = await getTokenAllowance(chainKey, reserve.aToken, actor, nativeGateway(chainKey))
          if (allowance < amount) {
            unsignedTxs.push(buildUnsignedErc20Approve(chainKey, reserve.aToken, nativeGateway(chainKey), amount))
          }
          unsignedTxs.push(buildUnsignedNativeWithdraw(chainKey, amount, actor))
        } else {
          // ERC20 直接 pool.withdraw,烧的是调用者的 aToken,无需授权
          unsignedTxs.push(buildUnsignedWithdraw(chainKey, token.address, amount, actor))
        }
        proposal.unsignedTxs = unsignedTxs
        const action = {
          type: 'sign_tx' as const,
          unsignedTxs,
          note: `${note};请点击聊天区下方的【签名并发送】按钮,在钱包中确认(${unsignedTxs.length} 笔交易)`,
          proposal: recordingProposal(proposal),
        }
        setPendingSignAction(chainKey, tokenId, action)
        return { verdict: 'sign', ...action }
      }

      // ---- 热钱包自动模式 ----
      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      const { txHash } = await executeLendingProposal(chainKey, tokenId, proposal)
      return { verdict, txHash, amountOut: amountHuman, note: `${note};已取回: ${cfg.explorer}/tx/${txHash}` }
    },
  })
}

/** get_lending_position 只读查询:当前存款 + 实时 APY(不经过策略引擎) */
function makeGetPosition(chainKey: string, tokenId: number) {
  return createTool({
    id: 'get_lending_position',
    description: '查询热钱包在 Aave 的存款仓位:各币种的存款数量与实时供给 APY。只读,不产生交易。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      positions: z.array(
        z.object({
          symbol: z.string(),
          supplied: z.string(),
          suppliedRaw: z.string(),
          supplyApy: z.number(),
        }),
      ),
      total: z.number(),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const cfg = getChainContext(chainKey).cfg
        // 跟随兑换执行模式:user_wallet 查主人钱包仓位,hot_wallet 查热钱包
        const mode = await getSwapMode(chainKey, tokenId)
        const wallet =
          mode === 'user_wallet' ? ((await loadPersona(chainKey, tokenId)).owner as Address) : getLendingWalletAddress()
        if (!wallet) return { positions: [], total: 0, error: '未配置执行密钥(AGENT_PRIVATE_KEY)' }
        const targets = getAaveAssets(chainKey)
        const positions = []
        for (const t of targets) {
          const reserve = await getReserveInfo(chainKey, t.address)
          const supplied = await getATokenBalance(chainKey, reserve.aToken, wallet)
          positions.push({
            symbol: t.symbol,
            supplied: formatUnits(supplied, t.decimals),
            suppliedRaw: supplied.toString(),
            supplyApy: reserve.supplyApy,
          })
        }
        return { positions, total: positions.length }
      } catch (err) {
        return { positions: [], total: 0, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

export const defiLending: SkillDef = {
  manifest: {
    id: 'defi-lending',
    name: '借贷理财',
    version: '0.1.0',
    description:
      'Aave v3 借贷理财。存入链上配置的资产赚供给收益,随时连本带息取回,支持只读仓位查询。支持两种执行模式:热钱包自动执行;或主人钱包签名(Agent 只组装交易,前端弹钱包确认)。执行前经策略引擎限额/冷却/熔断把关。',
    tools: ['propose_supply', 'propose_withdraw', 'get_lending_position'],
    permissions: ['defi'],
    scope: 'owner', // 资产操作,仅限主人对话
    evmOnly: true, // 依赖 Aave v3(EVM),Solana 下不可安装
    protocol: 'lending', // chain_protocols 表 gating(config 形如 {pool,gateway?})
  },
  makeTools: (chainKey, tokenId) => ({
    propose_supply: makeProposeSupply(chainKey, tokenId),
    propose_withdraw: makeProposeWithdraw(chainKey, tokenId),
    get_lending_position: makeGetPosition(chainKey, tokenId),
  }),
}
