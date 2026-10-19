import { type Address, type Hex, getContract } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from '../config'
import { getChainContext } from './registry'
import { getPublicClient, getWalletClient } from './clients'

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
