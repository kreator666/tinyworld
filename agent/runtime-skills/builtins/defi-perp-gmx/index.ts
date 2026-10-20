import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { formatEther, formatUnits, parseUnits, encodeFunctionData, type Address, type Hex } from 'viem'
import { getChainContext } from '../../../src/chain/registry'
import {
  getGmxWalletAddress,
  getMarketsWithMeta,
  findMarketByIndexSymbol,
  getAccountPositions,
  getPositionsByMarket,
  getGmxIndexPriceUsd,
  getGmxTokenAllowance,
  createGmxOrder,
  parseGmxUsd,
  estimateGmxExecutionFee,
  GmxOrderType,
  GMX_USD_DECIMALS,
  exchangeRouterAbi,
  type GmxPosition,
  type GmxMarketWithMeta,
} from '../../../src/chain/gmx'
import { getSwapMode } from '../../../src/core/settings'
import { loadPersona } from '../../../src/chain/persona'
import { evaluateProposal, type Proposal } from '../../../src/policy/engine'
import { createApproval } from '../../../src/core/approvals'
import { setPendingSignAction } from '../../../src/core/agent'
import { recordDefiTask } from '../defi-swap'
import { getDb } from '../../../src/db'
import { randomUUID } from 'node:crypto'
import type { UnsignedTx } from '../../../src/chain/defi'
import type { SkillDef } from '../../../src/skills/registry'

// ============================================================
// 内置技能 defi-perp-gmx:GMX V2 永续/现货(只读)
// - gmx_markets:列出该链所有 GMX 市场
// - gmx_position:查询用户在某市场的仓位
// - gmx_price:查询某市场的标记价格(目前用 CoinGecko 行情估算)
// v0.1 只读;v0.2 计划开放 propose_gmx_order 下单
// ============================================================

function fmtAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function fmtUsd(v: bigint, decimals = 30): string {
  // GMX V2 内部 USD 精度为 30
  const s = v.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '')
}

/** gmx_markets:列出所有市场 */
function makeGmxMarkets(chainKey: string) {
  return createTool({
    id: 'gmx_markets',
    description: '查询当前链上所有 GMX V2 市场,返回市场代币、指数代币、多空抵押代币地址与符号。只读。',
    inputSchema: z.object({}),
    outputSchema: z.object({
      summary: z.string(),
      markets: z.array(
        z.object({
          marketToken: z.string(),
          indexToken: z.string(),
          indexSymbol: z.string(),
          longToken: z.string(),
          longSymbol: z.string(),
          shortToken: z.string(),
          shortSymbol: z.string(),
        }),
      ),
      error: z.string().optional(),
    }),
    execute: async () => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.gmx) return { summary: '', markets: [], error: `链 ${cfg.name} 未配置 GMX V2` }
        const markets = await getMarketsWithMeta(chainKey)
        const summary = `链 ${cfg.name} 共有 ${markets.length} 个 GMX V2 市场`
        return {
          summary,
          markets: markets.map((m) => ({
            marketToken: m.marketToken,
            indexToken: m.indexToken,
            indexSymbol: m.indexSymbol,
            longToken: m.longToken,
            longSymbol: m.longSymbol,
            shortToken: m.shortToken,
            shortSymbol: m.shortSymbol,
          })),
        }
      } catch (err) {
        return { summary: '', markets: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

/** gmx_position:查询用户在某市场的仓位 */
function makeGmxPosition(chainKey: string, tokenId: number) {
  return createTool({
    id: 'gmx_position',
    description:
      '查询用户在 GMX V2 某市场的永续仓位。可指定 marketToken(完整地址)或 symbol(如 "AVAX","ETH","BTC");不指定则返回所有市场仓位。只读。',
    inputSchema: z.object({
      marketToken: z.string().optional().describe('GMX 市场代币地址(完整 0x 地址);与 symbol 二选一'),
      symbol: z.string().optional().describe('指数代币符号,如 "AVAX","ETH","BTC";与 marketToken 二选一'),
    }),
    outputSchema: z.object({
      summary: z.string(),
      positions: z.array(
        z.object({
          market: z.string(),
          side: z.string(),
          sizeUsd: z.string(),
          collateralToken: z.string(),
          collateralAmount: z.string(),
          increasedAt: z.string(),
        }),
      ),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const cfg = getChainContext(chainKey).cfg
        if (!cfg.gmx) return { summary: '', positions: [], error: `链 ${cfg.name} 未配置 GMX V2` }

        const mode = await getSwapMode(chainKey, tokenId)
        const account =
          mode === 'user_wallet'
            ? ((await loadPersona(chainKey, tokenId)).owner as Address)
            : (getGmxWalletAddress() ?? '0x0000000000000000000000000000000000000000')
        if (!account || account === '0x0000000000000000000000000000000000000000') {
          return { summary: '', positions: [], error: '未配置执行密钥或无法确定 owner' }
        }

        let positions: GmxPosition[]
        let matchedMarket: GmxMarketWithMeta | null = null
        if (context.marketToken) {
          positions = await getPositionsByMarket(chainKey, account, context.marketToken as Address)
        } else {
          positions = await getAccountPositions(chainKey, account)
          if (context.symbol) {
            matchedMarket = await findMarketByIndexSymbol(chainKey, context.symbol)
            if (!matchedMarket) {
              return { summary: '', positions: [], error: `未找到指数代币为 ${context.symbol} 的 GMX 市场` }
            }
            positions = positions.filter((p) => p.market.toLowerCase() === matchedMarket!.marketToken.toLowerCase())
          }
        }

        const summary = `共 ${positions.length} 个仓位`
        return {
          summary,
          positions: positions.map((p) => ({
            market: p.market,
            side: p.isLong ? 'LONG' : 'SHORT',
            sizeUsd: fmtUsd(p.sizeInUsd),
            collateralToken: p.collateralToken,
            collateralAmount: p.collateralAmount.toString(),
            increasedAt: new Date(Number(p.increasedAtTime) * 1000).toISOString(),
          })),
        }
      } catch (err) {
        return { summary: '', positions: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}

/** gmx_price:查询某市场 indexToken 的当前 USD 价格(复用 Aave/Chainlink Oracle) */
function makeGmxPrice(chainKey: string) {
  return createTool({
    id: 'gmx_price',
    description: '查询 GMX V2 某市场的指数代币当前 USD 价格。价格来自 Aave/Chainlink Oracle,与 GMX 清算同源。只读。',
    inputSchema: z.object({
      symbol: z.string().describe('指数代币符号,如 "AVAX","ETH","BTC","BTC.b"'),
    }),
    outputSchema: z.object({
      symbol: z.string(),
      priceUsd: z.number(),
      source: z.string(),
      note: z.string(),
      error: z.string().optional(),
    }),
    execute: async ({ context }) => {
      try {
        const market = await findMarketByIndexSymbol(chainKey, context.symbol)
        if (!market) {
          return {
            symbol: context.symbol.toUpperCase(),
            priceUsd: 0,
            source: 'none',
            note: '',
            error: `未找到指数代币为 ${context.symbol} 的 GMX 市场`,
          }
        }
        const price = await getGmxIndexPriceUsd(chainKey, market.indexToken)
        return {
          symbol: market.indexSymbol,
          priceUsd: price,
          source: 'Aave/Chainlink Oracle',
          note: `${market.indexSymbol}/USD 价格,由 GMX 同源的 Chainlink 喂价提供`,
        }
      } catch (err) {
        return {
          symbol: context.symbol.toUpperCase(),
          priceUsd: 0,
          source: 'error',
          note: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })
}

/** 已执行的 GMX 订单落 tasks 表(审计 + 策略引擎日累计/冷却的数据源) */
async function recordGmxTask(
  chainKey: string,
  tokenId: number,
  proposal: Proposal,
  result: { txHash: string; orderType: string; marketSymbol: string; usdValue: number | null },
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

/** 把 Proposal 附加到 sign_tx action 的精简字段 */
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

/** 解析抵押品符号到 token 地址;LONG 默认 longToken,SHORT 默认 shortToken */
function resolveCollateral(
  market: GmxMarketWithMeta,
  collateralSymbol: string,
): { address: Address; decimals: number; symbol: string } | null {
  const s = collateralSymbol.toUpperCase()
  const candidates = [
    { address: market.longToken, symbol: market.longSymbol, decimals: 18 },
    { address: market.shortToken, symbol: market.shortSymbol, decimals: 6 },
  ]
  const match = candidates.find((c) => c.symbol.toUpperCase() === s)
  if (match) return { address: match.address as Address, symbol: match.symbol, decimals: match.decimals }
  return null
}

/** 计算 acceptablePrice(滑点保护) */
function calcAcceptablePrice(currentPrice: number, side: 'LONG' | 'SHORT', orderType: 'increase' | 'decrease', slippage: number): bigint {
  const factor = side === 'LONG' ? (orderType === 'increase' ? 1 + slippage : 1 - slippage) : orderType === 'increase' ? 1 - slippage : 1 + slippage
  return parseGmxUsd((currentPrice * factor).toFixed(10))
}

/** 构建 gmx_order 提案(导出供测试直接组装) */
export async function buildGmxOrderProposal(
  chainKey: string,
  market: GmxMarketWithMeta,
  side: 'LONG' | 'SHORT',
  orderType: 'increase' | 'decrease',
  sizeUsdHuman: string,
  collateralToken: Address,
  collateralAmount: bigint,
  executionMode: Proposal['executionMode'],
  reason: string,
): Promise<Proposal> {
  const cfg = getChainContext(chainKey).cfg
  const sizeDeltaUsd = parseGmxUsd(sizeUsdHuman)
  const currentPrice = await getGmxIndexPriceUsd(chainKey, market.indexToken)
  const acceptablePrice = calcAcceptablePrice(currentPrice, side, orderType, 0.005) // 默认 0.5% 滑点
  return {
    action: 'gmx_order',
    protocol: cfg.gmx!.exchangeRouter,
    chainId: cfg.chainId,
    executionMode,
    params: {
      tokenIn: collateralToken,
      tokenOut: market.indexSymbol,
      amountIn: collateralAmount.toString(),
      amountOutMin: sizeDeltaUsd.toString(),
      owner: undefined,
    },
    estimatedValueUsd: Number(sizeUsdHuman),
    reason,
  }
}

/** 组装用户钱包签名模式的 unsigned txs(approve + ExchangeRouter.multicall)(导出供测试) */
export async function buildUnsignedGmxOrder(
  chainKey: string,
  market: GmxMarketWithMeta,
  side: 'LONG' | 'SHORT',
  orderType: 'increase' | 'decrease',
  sizeUsdHuman: string,
  collateralToken: Address,
  collateralAmount: bigint,
  user: Address,
  executionFee: bigint,
): Promise<UnsignedTx[]> {
  const cfg = getChainContext(chainKey).cfg
  const exchangeRouter = cfg.gmx!.exchangeRouter as Address
  const router = cfg.gmx!.router as Address
  const orderVault = cfg.gmx!.orderVault as Address
  const sizeDeltaUsd = parseGmxUsd(sizeUsdHuman)
  const currentPrice = await getGmxIndexPriceUsd(chainKey, market.indexToken)
  const acceptablePrice = calcAcceptablePrice(currentPrice, side, orderType, 0.005)

  const unsignedTxs: UnsignedTx[] = []
  // sendTokens 内部调用 router.pluginTransfer,因此 spender 是 Router 合约
  const allowance = await getGmxTokenAllowance(chainKey, collateralToken, user, router)
  if (allowance < collateralAmount) {
    unsignedTxs.push({
      to: collateralToken,
      data: encodeFunctionData({
        abi: [
          { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
        ],
        functionName: 'approve',
        args: [router, collateralAmount],
      }),
      value: '0',
      chainId: cfg.chainId,
      description: `授权 GMX Router 使用 ${fmtAddr(collateralToken)}`,
    })
  }

  const orderParams = [
    {
      addresses: {
        receiver: user,
        cancellationReceiver: '0x0000000000000000000000000000000000000000',
        callbackContract: '0x0000000000000000000000000000000000000000',
        uiFeeReceiver: '0x0000000000000000000000000000000000000000',
        market: market.marketToken,
        initialCollateralToken: collateralToken,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd,
        initialCollateralDeltaAmount: collateralAmount,
        triggerPrice: 0n,
        acceptablePrice,
        executionFee,
        callbackGasLimit: 0n,
        minOutputAmount: 0n,
        validFromTime: 0n,
      },
      orderType: orderType === 'increase' ? GmxOrderType.MarketIncrease : GmxOrderType.MarketDecrease,
      decreasePositionSwapType: 0,
      isLong: side === 'LONG',
      shouldUnwrapNativeToken: false,
      referralCode: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    },
  ] as const

  const sendWntData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'sendWnt',
    args: [orderVault, executionFee],
  })
  const sendTokensData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'sendTokens',
    args: [collateralToken, orderVault, collateralAmount],
  })
  const createOrderData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'createOrder',
    args: orderParams,
  })

  unsignedTxs.push({
    to: exchangeRouter,
    data: encodeFunctionData({
      abi: exchangeRouterAbi,
      functionName: 'multicall',
      args: [[sendWntData, sendTokensData, createOrderData]],
    }),
    value: executionFee.toString(),
    chainId: cfg.chainId,
    description: `在 GMX ${market.indexSymbol} 市场下${side === 'LONG' ? '多' : '空'}单(${orderType === 'increase' ? '开仓' : '平仓'}),名义 ${sizeUsdHuman} USD`,
  })

  return unsignedTxs
}

/** propose_gmx_order:GMX V2 下单工具(开仓/平仓) */
function makeProposeGmxOrder(chainKey: string, tokenId: number) {
  return createTool({
    id: 'propose_gmx_order',
    description:
      '在 GMX V2 下永续订单(开仓/平仓)。支持 MarketIncrease 开仓、MarketDecrease 平仓。执行模式跟随「兑换执行模式」设置:热钱包自动执行,或主人钱包签名(返回 verdict=sign 时需点【签名并发送】)。限额/冷却/熔断由策略引擎把关,超限转审批中心。',
    inputSchema: z.object({
      marketSymbol: z.string().describe('市场指数代币符号,如 "AVAX","BTC","ETH"'),
      side: z.enum(['LONG', 'SHORT']).describe('仓位方向'),
      orderType: z.enum(['market_increase', 'market_decrease']).describe('订单类型:market_increase=开仓,market_decrease=平仓'),
      sizeUsd: z.string().describe('名义仓位大小(USD,如 "100")'),
      collateralSymbol: z.string().describe('抵押品符号,如 "AVAX","WAVAX","USDC","USDt"'),
      collateralAmount: z.string().describe('抵押品数量(人类单位,如 "0.5")'),
      reason: z.string().describe('这笔订单的理由(会写进审计记录)'),
    }),
    outputSchema: z.object({
      verdict: z.string(),
      reasons: z.array(z.string()).optional(),
      txHash: z.string().optional(),
      approvalId: z.string().optional(),
      error: z.string().optional(),
      note: z.string().optional(),
      // 用户钱包签名模式:前端签名按钮需要的字段
      type: z.literal('sign_tx').optional(),
      unsignedTxs: z.array(z.any()).optional(),
      proposal: z.record(z.any()).optional(),
    }),
    execute: async ({ context }) => {
      const cfg = getChainContext(chainKey).cfg
      if (!cfg.gmx) return { verdict: 'rejected', error: `链 ${cfg.name} 未配置 GMX V2` }

      const market = await findMarketByIndexSymbol(chainKey, context.marketSymbol)
      if (!market) return { verdict: 'rejected', error: `未找到指数代币为 ${context.marketSymbol} 的 GMX 市场` }
      if (market.indexToken.toLowerCase() === '0x0000000000000000000000000000000000000000') {
        return { verdict: 'rejected', error: `${context.marketSymbol} 是 GMX 现货兑换市场,暂不支持下单` }
      }

      const collateral = resolveCollateral(market, context.collateralSymbol)
      if (!collateral) {
        return { verdict: 'rejected', error: `抵押品 ${context.collateralSymbol} 不在 ${market.indexSymbol} 市场支持列表(支持 ${market.longSymbol}/${market.shortSymbol})` }
      }

      const executionMode = await getSwapMode(chainKey, tokenId)
      const side = context.side
      const orderType = context.orderType === 'market_increase' ? 'increase' : 'decrease'
      const collateralAmount = parseUnits(context.collateralAmount, collateral.decimals)
      if (collateralAmount <= 0n) return { verdict: 'rejected', error: 'collateralAmount 必须大于 0' }

      const sizeUsdNum = Number(context.sizeUsd)
      if (!Number.isFinite(sizeUsdNum) || sizeUsdNum <= 0) return { verdict: 'rejected', error: 'sizeUsd 必须大于 0' }

      const proposal = await buildGmxOrderProposal(
        chainKey,
        market,
        side,
        orderType,
        context.sizeUsd,
        collateral.address,
        collateralAmount,
        executionMode,
        context.reason,
      )
      const { verdict, reasons } = await evaluateProposal(chainKey, proposal)

      const note = `GMX 订单:\n- 市场: ${market.indexSymbol}\n- 方向: ${side}\n- 类型: ${orderType === 'increase' ? '开仓' : '平仓'}\n- 名义仓位: $${context.sizeUsd}\n- 抵押品: ${context.collateralAmount} ${collateral.symbol}`

      if (verdict === 'rejected') return { verdict, reasons, note }

      // 按 GMX V2 GasUtils 公式动态估算 keeper 执行费(含 10% 缓冲)
      const executionFee = await estimateGmxExecutionFee(chainKey, orderType)

      // ---- 用户钱包签名模式 ----
      if (executionMode === 'user_wallet') {
        const persona = await loadPersona(chainKey, tokenId)
        const user = persona.owner as Address

        // 余额预检
        const client = (await import('../../../src/chain/clients')).getPublicClient(chainKey)
        const balance = (await client.readContract({ address: collateral.address, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'balanceOf', args: [user] })) as bigint
        if (balance < collateralAmount) {
          return { verdict: 'rejected', error: `你的 ${collateral.symbol} 不足(需 ${context.collateralAmount},当前 ${formatUnits(balance, collateral.decimals)})` }
        }
        const nativeBalance = await client.getBalance({ address: user })
        if (nativeBalance < executionFee) {
          return { verdict: 'rejected', error: `你的 ${cfg.defi!.nativeSymbol} 不足支付 keeper 执行费(需 ${formatEther(executionFee)})` }
        }

        const unsignedTxs = await buildUnsignedGmxOrder(
          chainKey,
          market,
          side,
          orderType,
          context.sizeUsd,
          collateral.address,
          collateralAmount,
          user,
          executionFee,
        )
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
      const wallet = getGmxWalletAddress()
      if (!wallet) return { verdict: 'rejected', error: '未配置执行密钥(AGENT_PRIVATE_KEY),无法执行 GMX 订单' }

      const client = (await import('../../../src/chain/clients')).getPublicClient(chainKey)
      const balance = (await client.readContract({ address: collateral.address, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'balanceOf', args: [wallet] })) as bigint
      if (balance < collateralAmount) {
        return { verdict: 'rejected', error: `热钱包 ${collateral.symbol} 不足(需 ${context.collateralAmount},当前 ${formatUnits(balance, collateral.decimals)})` }
      }
      const nativeBalance = await client.getBalance({ address: wallet })
      if (nativeBalance < executionFee) {
        return { verdict: 'rejected', error: `热钱包 ${cfg.defi!.nativeSymbol} 不足支付 keeper 执行费(需 ${formatEther(executionFee)})` }
      }

      if (verdict === 'needsApproval') {
        const approval = await createApproval(chainKey, tokenId, proposal, context.reason)
        return { verdict, reasons, approvalId: approval.id, note: `${note};已生成审批单,等主人确认` }
      }

      try {
        const { txHash } = await createGmxOrder(chainKey, {
          market: market.marketToken,
          initialCollateralToken: collateral.address,
          isLong: side === 'LONG',
          orderType: orderType === 'increase' ? GmxOrderType.MarketIncrease : GmxOrderType.MarketDecrease,
          sizeDeltaUsd: parseGmxUsd(context.sizeUsd),
          initialCollateralDeltaAmount: collateralAmount,
          acceptablePrice: calcAcceptablePrice(await getGmxIndexPriceUsd(chainKey, market.indexToken), side, orderType, 0.005),
          executionFee,
        })
        await recordGmxTask(chainKey, tokenId, proposal, {
          txHash,
          orderType: context.orderType,
          marketSymbol: market.indexSymbol,
          usdValue: proposal.estimatedValueUsd,
        })
        return { verdict, txHash, note: `${note};已提交订单: ${cfg.explorer}/tx/${txHash}` }
      } catch (err) {
        return { verdict: 'rejected', error: err instanceof Error ? err.message : String(err), note }
      }
    },
  })
}

export const defiPerpGmx: SkillDef = {
  manifest: {
    id: 'defi-perp-gmx',
    name: 'GMX V2 永续交易',
    version: '0.1.0',
    description:
      'GMX V2 去中心化永续/现货交易:查询市场、查询仓位、标记价格,以及提交 MarketIncrease/MarketDecrease 订单(开仓/平仓)。支持多链,当前已配置 Avalanche/Arbitrum。',
    tools: ['gmx_markets', 'gmx_position', 'gmx_price', 'propose_gmx_order'],
    permissions: ['defi'],
    scope: 'owner',
    evmOnly: true,
    protocol: 'gmx-perp',
    protocolRequired: true,
  },
  makeTools: (chainKey, tokenId) => ({
    gmx_markets: makeGmxMarkets(chainKey),
    gmx_position: makeGmxPosition(chainKey, tokenId),
    gmx_price: makeGmxPrice(chainKey),
    propose_gmx_order: makeProposeGmxOrder(chainKey, tokenId),
  }),
}
