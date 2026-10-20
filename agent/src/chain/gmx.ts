import { type Address, type Hex, getContract, formatUnits, parseUnits, encodeFunctionData, encodeAbiParameters, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from '../config'
import { getChainContext } from './registry'
import { getPublicClient, getWalletClient } from './clients'
import { getAssetPriceUsd } from './aave'

// ============================================================
// GMX V2 链交互(多链 EVM adapter)
// 只做链无关封装:所有地址从 cfg.gmx 读取;Avalanche/Arbitrum 已配置,其他链加配置即可。
// 参考:https://docs.gmx.io/docs/api/contracts/addresses/
// ============================================================

export interface GmxConfig {
  exchangeRouter: Address
  orderVault: Address
  reader: Address
  dataStore: Address
  router: Address
}

/** 链的 GMX 配置;未配置直接抛错 */
export function gmxCfg(chainKey: string): GmxConfig {
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.gmx) throw new Error(`链 ${cfg.name} 未配置 GMX V2`)
  return {
    exchangeRouter: cfg.gmx.exchangeRouter as Address,
    orderVault: cfg.gmx.orderVault as Address,
    reader: cfg.gmx.reader as Address,
    dataStore: cfg.gmx.dataStore as Address,
    router: cfg.gmx.router as Address,
  }
}

/** 热钱包客户端;未配置返回 null */
function hotWallet(chainKey: string) {
  if (!config.agentPrivateKey) return null
  return getWalletClient(chainKey, config.agentPrivateKey as Hex)
}

export function getGmxWalletAddress(): Address | null {
  if (!config.agentPrivateKey) return null
  return privateKeyToAccount(config.agentPrivateKey as Hex).address
}

// ============================================================
// ERC20 元数据 ABI
// ============================================================

const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const

// ============================================================
// Reader ABI(只读)
// ============================================================

const readerAbi = [
  {
    type: 'function',
    name: 'getMarkets',
    stateMutability: 'view',
    inputs: [
      { name: 'dataStore', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'end', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'marketToken', type: 'address' },
          { name: 'indexToken', type: 'address' },
          { name: 'longToken', type: 'address' },
          { name: 'shortToken', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getAccountPositions',
    stateMutability: 'view',
    inputs: [
      { name: 'dataStore', type: 'address' },
      { name: 'account', type: 'address' },
      { name: 'start', type: 'uint256' },
      { name: 'end', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          {
            name: 'addresses',
            type: 'tuple',
            components: [
              { name: 'account', type: 'address' },
              { name: 'market', type: 'address' },
              { name: 'collateralToken', type: 'address' },
            ],
          },
          {
            name: 'numbers',
            type: 'tuple',
            components: [
              { name: 'sizeInUsd', type: 'uint256' },
              { name: 'sizeInTokens', type: 'uint256' },
              { name: 'collateralAmount', type: 'uint256' },
              { name: 'pendingImpactAmount', type: 'int256' },
              { name: 'borrowingFactor', type: 'uint256' },
              { name: 'fundingFeeAmountPerSize', type: 'uint256' },
              { name: 'longTokenClaimableFundingAmountPerSize', type: 'uint256' },
              { name: 'shortTokenClaimableFundingAmountPerSize', type: 'uint256' },
              { name: 'increasedAtTime', type: 'uint256' },
              { name: 'decreasedAtTime', type: 'uint256' },
            ],
          },
          {
            name: 'flags',
            type: 'tuple',
            components: [{ name: 'isLong', type: 'bool' }],
          },
        ],
      },
    ],
  },
] as const

// ============================================================
// 类型
// ============================================================

export interface GmxMarket {
  marketToken: Address
  indexToken: Address
  longToken: Address
  shortToken: Address
}

export interface GmxMarketWithMeta extends GmxMarket {
  indexSymbol: string
  longSymbol: string
  shortSymbol: string
}

export interface GmxPosition {
  account: Address
  market: Address
  collateralToken: Address
  sizeInUsd: bigint
  sizeInTokens: bigint
  collateralAmount: bigint
  pendingImpactAmount: bigint
  borrowingFactor: bigint
  fundingFeeAmountPerSize: bigint
  longTokenClaimableFundingAmountPerSize: bigint
  shortTokenClaimableFundingAmountPerSize: bigint
  increasedAtTime: bigint
  decreasedAtTime: bigint
  isLong: boolean
}

// ============================================================
// 只读函数
// ============================================================

/** 读取单个 ERC20 符号(缓存友好:同 token 不建议重复读) */
export async function getTokenSymbol(chainKey: string, token: Address): Promise<string> {
  const client = getPublicClient(chainKey)
  return (await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })) as string
}

/** 读取该链所有 GMX V2 市场 */
export async function getMarkets(chainKey: string): Promise<GmxMarket[]> {
  const cfg = gmxCfg(chainKey)
  const client = getPublicClient(chainKey)
  const reader = getContract({ address: cfg.reader, abi: readerAbi, client })
  const markets = (await reader.read.getMarkets([cfg.dataStore, 0n, 1000n])) as {
    marketToken: Address
    indexToken: Address
    longToken: Address
    shortToken: Address
  }[]
  return markets
}

async function safeSymbol(client: ReturnType<typeof getPublicClient>, token: Address): Promise<string> {
  try {
    return (await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })) as string
  } catch {
    return `Unknown(${token.slice(0, 6)})`
  }
}

/** 读取市场并附带 token 符号,方便 LLM/用户识别 */
export async function getMarketsWithMeta(chainKey: string): Promise<GmxMarketWithMeta[]> {
  const markets = await getMarkets(chainKey)
  const client = getPublicClient(chainKey)
  const results: GmxMarketWithMeta[] = []
  for (const m of markets) {
    const [indexSymbol, longSymbol, shortSymbol] = await Promise.all([
      safeSymbol(client, m.indexToken),
      safeSymbol(client, m.longToken),
      safeSymbol(client, m.shortToken),
    ])
    results.push({ ...m, indexSymbol, longSymbol, shortSymbol })
  }
  return results
}

/** 按 indexToken 符号查找市场(不区分大小写,支持常见别名如 AVAX→WAVAX、BTC→BTC.b、ETH→WETH.e) */
export async function findMarketByIndexSymbol(
  chainKey: string,
  symbol: string,
): Promise<GmxMarketWithMeta | null> {
  const markets = await getMarketsWithMeta(chainKey)
  const s = symbol.toUpperCase()
  // 优先精确匹配
  let match = markets.find((m) => m.indexSymbol.toUpperCase() === s)
  if (match) return match
  // 别名匹配(统一大写,避免 BTC.b→BTC.B 不匹配)
  const aliases: Record<string, string[]> = {
    AVAX: ['WAVAX'],
    BTC: ['BTC.b', 'BTCB'],
    ETH: ['WETH.e', 'WETH'],
    SOL: ['SOL'],
    XAU: ['XAUt0', 'XAUT'],
  }
  const candidates = (aliases[s] ?? []).map((c) => c.toUpperCase())
  match = markets.find((m) => candidates.includes(m.indexSymbol.toUpperCase()))
  return match ?? null
}

/** 读取 GMX 市场 indexToken 的 USD 价格;复用 Aave Oracle(底层同为 Chainlink 喂价) */
export async function getGmxIndexPriceUsd(chainKey: string, indexToken: Address): Promise<number> {
  return getAssetPriceUsd(chainKey, indexToken)
}

/** 读取用户所有 GMX V2 仓位 */
export async function getAccountPositions(chainKey: string, account: Address): Promise<GmxPosition[]> {
  const cfg = gmxCfg(chainKey)
  const client = getPublicClient(chainKey)
  const reader = getContract({ address: cfg.reader, abi: readerAbi, client })
  const positions = (await reader.read.getAccountPositions([cfg.dataStore, account, 0n, 1000n])) as {
    addresses: { account: Address; market: Address; collateralToken: Address }
    numbers: {
      sizeInUsd: bigint
      sizeInTokens: bigint
      collateralAmount: bigint
      pendingImpactAmount: bigint
      borrowingFactor: bigint
      fundingFeeAmountPerSize: bigint
      longTokenClaimableFundingAmountPerSize: bigint
      shortTokenClaimableFundingAmountPerSize: bigint
      increasedAtTime: bigint
      decreasedAtTime: bigint
    }
    flags: { isLong: boolean }
  }[]
  return positions.map((p) => ({
    account: p.addresses.account,
    market: p.addresses.market,
    collateralToken: p.addresses.collateralToken,
    sizeInUsd: p.numbers.sizeInUsd,
    sizeInTokens: p.numbers.sizeInTokens,
    collateralAmount: p.numbers.collateralAmount,
    pendingImpactAmount: p.numbers.pendingImpactAmount,
    borrowingFactor: p.numbers.borrowingFactor,
    fundingFeeAmountPerSize: p.numbers.fundingFeeAmountPerSize,
    longTokenClaimableFundingAmountPerSize: p.numbers.longTokenClaimableFundingAmountPerSize,
    shortTokenClaimableFundingAmountPerSize: p.numbers.shortTokenClaimableFundingAmountPerSize,
    increasedAtTime: p.numbers.increasedAtTime,
    decreasedAtTime: p.numbers.decreasedAtTime,
    isLong: p.flags.isLong,
  }))
}

/** 按 marketToken 筛选用户在某市场的仓位 */
export async function getPositionsByMarket(
  chainKey: string,
  account: Address,
  marketToken: Address,
): Promise<GmxPosition[]> {
  const positions = await getAccountPositions(chainKey, account)
  return positions.filter((p) => p.market.toLowerCase() === marketToken.toLowerCase())
}

// ============================================================
// ExchangeRouter ABI(交易)
// ============================================================

export const exchangeRouterAbi = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'sendWnt',
    stateMutability: 'payable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sendTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'createOrder',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            name: 'addresses',
            components: [
              { name: 'receiver', type: 'address' },
              { name: 'cancellationReceiver', type: 'address' },
              { name: 'callbackContract', type: 'address' },
              { name: 'uiFeeReceiver', type: 'address' },
              { name: 'market', type: 'address' },
              { name: 'initialCollateralToken', type: 'address' },
              { name: 'swapPath', type: 'address[]' },
            ],
          },
          {
            type: 'tuple',
            name: 'numbers',
            components: [
              { name: 'sizeDeltaUsd', type: 'uint256' },
              { name: 'initialCollateralDeltaAmount', type: 'uint256' },
              { name: 'triggerPrice', type: 'uint256' },
              { name: 'acceptablePrice', type: 'uint256' },
              { name: 'executionFee', type: 'uint256' },
              { name: 'callbackGasLimit', type: 'uint256' },
              { name: 'minOutputAmount', type: 'uint256' },
              { name: 'validFromTime', type: 'uint256' },
            ],
          },
          { name: 'orderType', type: 'uint8' },
          { name: 'decreasePositionSwapType', type: 'uint8' },
          { name: 'isLong', type: 'bool' },
          { name: 'shouldUnwrapNativeToken', type: 'bool' },
          { name: 'referralCode', type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/** GMX V2 OrderType:MarketIncrease=2, MarketDecrease=4 */
export const GmxOrderType = {
  MarketSwap: 0,
  LimitSwap: 1,
  MarketIncrease: 2,
  LimitIncrease: 3,
  MarketDecrease: 4,
  LimitDecrease: 5,
  StopLossDecrease: 6,
  Liquidation: 7,
} as const

export interface CreateGmxOrderArgs {
  market: Address
  initialCollateralToken: Address
  isLong: boolean
  orderType: number
  sizeDeltaUsd: bigint
  initialCollateralDeltaAmount: bigint
  acceptablePrice: bigint
  executionFee: bigint
  receiver?: Address
  cancellationReceiver?: Address
  callbackContract?: Address
  uiFeeReceiver?: Address
  swapPath?: Address[]
  callbackGasLimit?: bigint
  minOutputAmount?: bigint
  validFromTime?: bigint
  decreasePositionSwapType?: number
  shouldUnwrapNativeToken?: boolean
  referralCode?: Hex
}

/** GMX V2 精度:USD 值用 30 位小数,sizeInTokens 用 token decimals */
export const GMX_PRECISION = 30n
export const GMX_USD_DECIMALS = 30

/** 把人类单位 USD 转成 GMX 内部精度(30 位小数) */
export function parseGmxUsd(value: string): bigint {
  return parseUnits(value, 30)
}

const dataStoreGetUintAbi = [
  { type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

function dataStoreKey(s: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [s]))
}

const GMX_FEE_FACTOR_PRECISION = 10n ** 30n

/**
 * 估算 GMX V2 订单 keeper 执行费。
 * 公式与合约 GasUtils.validateExecutionFee 同源:
 *   minExecutionFee = (ESTIMATED_GAS_FEE_BASE + ESTIMATED_GAS_FEE_PER_ORACLE_PRICE * (3+swaps)
 *                      + INCREASE/DECREASE_ORDER_GAS_LIMIT * ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR / 1e30)
 *                     * gasPrice
 * 返回原生币 wei。
 *
 * 注意: keeper 执行时用的 gasPrice 可能高于下单时的 gasPrice,因此 gasPrice 先用 2x 缓冲,
 * 最终结果再加 20% 缓冲。多余执行费会退回给用户,宁多勿少。
 */
export async function estimateGmxExecutionFee(
  chainKey: string,
  orderType: 'increase' | 'decrease',
  swapCount = 0,
): Promise<bigint> {
  const cfg = gmxCfg(chainKey)
  const client = getPublicClient(chainKey)
  const get = (key: string) =>
    client.readContract({
      address: cfg.dataStore,
      abi: dataStoreGetUintAbi,
      functionName: 'getUint',
      args: [dataStoreKey(key)],
    }) as Promise<bigint>

  const [base, perOracle, multiplier, orderGasLimit, singleSwapGasLimit] = await Promise.all([
    get('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1'),
    get('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE'),
    get('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'),
    orderType === 'increase' ? get('INCREASE_ORDER_GAS_LIMIT') : get('DECREASE_ORDER_GAS_LIMIT'),
    get('SINGLE_SWAP_GAS_LIMIT'),
  ])

  const oraclePriceCount = 3n + BigInt(swapCount)
  const estimatedGasLimit = orderGasLimit + singleSwapGasLimit * BigInt(swapCount)
  const adjustedGasLimit = base + perOracle * oraclePriceCount + (estimatedGasLimit * multiplier) / GMX_FEE_FACTOR_PRECISION
  const gasPrice = await client.getGasPrice()
  // keeper 执行时的 gasPrice 通常高于下单时,用 2x 预估;最终再留 20% 余量
  const fee = adjustedGasLimit * gasPrice * 2n
  return (fee * 120n) / 100n
}

/** 读取 ERC20 授权额度 */
export async function getGmxTokenAllowance(
  chainKey: string,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  const client = getPublicClient(chainKey)
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
}

/** 热钱包/签名账户创建 GMX V2 订单。
 *  流程:approve(如不足)→ multicall(sendWnt+sendTokens+createOrder)
 *  返回 txHash;orderKey 可通过 getAccountOrders 查询(解析 event 较繁琐,首期暂不解析)。
 */
export async function createGmxOrder(
  chainKey: string,
  args: CreateGmxOrderArgs,
): Promise<{ txHash: Hex }> {
  const cfg = gmxCfg(chainKey)
  const wallet = hotWallet(chainKey)
  if (!wallet) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY)')
  const account = wallet.account!.address
  const client = getPublicClient(chainKey)

  // 1. approve GMX Router 使用抵押品(不足才发)
  // 注意:sendTokens 内部调用 router.pluginTransfer,因此 spender 必须是 Router 合约,不是 ExchangeRouter
  const allowance = await getGmxTokenAllowance(chainKey, args.initialCollateralToken, account, cfg.router)
  if (allowance < args.initialCollateralDeltaAmount) {
    const t0 = await wallet.writeContract({
      address: args.initialCollateralToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [cfg.router, args.initialCollateralDeltaAmount],
    })
    const r0 = await client.waitForTransactionReceipt({ hash: t0, timeout: 120_000 })
    if (r0.status !== 'success') throw new Error(`approve(Router) 失败: ${t0}`)
  }

  // 2. 组装 multicall: sendWnt(executionFee) + sendTokens(collateral) + createOrder
  const orderParams = [
    {
      addresses: {
        receiver: args.receiver ?? account,
        cancellationReceiver: args.cancellationReceiver ?? '0x0000000000000000000000000000000000000000',
        callbackContract: args.callbackContract ?? '0x0000000000000000000000000000000000000000',
        uiFeeReceiver: args.uiFeeReceiver ?? '0x0000000000000000000000000000000000000000',
        market: args.market,
        initialCollateralToken: args.initialCollateralToken,
        swapPath: args.swapPath ?? [],
      },
      numbers: {
        sizeDeltaUsd: args.sizeDeltaUsd,
        initialCollateralDeltaAmount: args.initialCollateralDeltaAmount,
        triggerPrice: 0n,
        acceptablePrice: args.acceptablePrice,
        executionFee: args.executionFee,
        callbackGasLimit: args.callbackGasLimit ?? 0n,
        minOutputAmount: args.minOutputAmount ?? 0n,
        validFromTime: args.validFromTime ?? 0n,
      },
      orderType: args.orderType,
      decreasePositionSwapType: args.decreasePositionSwapType ?? 0,
      isLong: args.isLong,
      shouldUnwrapNativeToken: args.shouldUnwrapNativeToken ?? false,
      referralCode: args.referralCode ?? ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex),
    },
  ] as const

  const sendWntData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'sendWnt',
    args: [cfg.orderVault, args.executionFee],
  })
  const sendTokensData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'sendTokens',
    args: [args.initialCollateralToken, cfg.orderVault, args.initialCollateralDeltaAmount],
  })
  const createOrderData = encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName: 'createOrder',
    args: orderParams,
  })

  const tx = await wallet.writeContract({
    address: cfg.exchangeRouter,
    abi: exchangeRouterAbi,
    functionName: 'multicall',
    args: [[sendWntData, sendTokensData, createOrderData]],
    value: args.executionFee,
  })
  const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`createOrder 执行失败(revert): ${tx}`)

  return { txHash: tx }
}
