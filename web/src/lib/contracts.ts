import { sepolia, avalancheFuji, avalanche, type Chain } from 'viem/chains'
import DIDIdentityJson from '../abi/DIDIdentity.json'
import DIDPartsJson from '../abi/DIDParts.json'
import StarterPartClaimJson from '../abi/StarterPartClaim.json'
import PartsMarketJson from '../abi/PartsMarket.json'
import { toChainParts, type ChainPart } from '../data/equipmentCatalog'
import type { ChainType } from '../types'

// ============================================================
// 链配置(纯数据,本地兜底副本):
// 运行时以 agent 服务 GET /chains 返回的 chains 表为准,服务不可达时用这份兜底。
// 当前激活链由 store/chainConfigStore.ts 管理(导航栏按钮切换)。
// ============================================================

export type ChainKey = 'sepolia' | 'fuji' | 'solana-devnet' | 'avalanche'

export interface ChainContracts {
  key: ChainKey
  name: ChainType // 短链名,用于 UI 展示与 NFT 卡的链标
  chainId: number
  chain: Chain // viem 链定义(切链参数/原生币种都从这里取)
  identity: `0x${string}` // EVM: DIDIdentity 合约地址;Solana: 复用该字段存 tinyworld 程序地址(base58,运行时按族解释)
  parts: `0x${string}` // EVM: DIDParts 合约地址;Solana: 同程序地址(占位)
  rpc: string // 无钱包时的只读回退 RPC
  explorer: string // 区块浏览器地址(用于拼接 tx/address 链接)
  /** 链族:缺省视为 'evm';solana 链的读写走 lib/chainSolana.ts */
  family?: 'evm' | 'solana'
  /** 新手装备免费领养合约(EVM;未部署的链不填) */
  partsClaim?: `0x${string}`
  /** 装备铸造直售市场合约(EVM;未部署的链不填。价格一律链上 listPriceOf 为准) */
  market?: `0x${string}`
}

// Solana devnet 的 viem 链定义:仅作占位(solana 不走 viem client),
// chain_id 103 为哨兵值,与登录态 WalletLogin.chainId 对齐
const solanaDevnetChain = {
  id: 103,
  name: 'Solana Devnet',
  nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
  rpcUrls: { default: { http: ['https://api.devnet.solana.com'] } },
} satisfies Chain

// 素材(角色库/装备目录)全链共用一套,与链无关;这里只放合约地址等链上信息
export const CONTRACTS_BY_KEY: Record<ChainKey, ChainContracts> = {
  // Sepolia 测试网(2026-07 部署)
  sepolia: {
    key: 'sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    chain: sepolia,
    identity: '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1',
    parts: '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
  },
  // Avalanche Fuji 测试网(2026-10 UUPS 代理重部署)
  fuji: {
    key: 'fuji',
    name: 'Fuji',
    chainId: 43113,
    chain: avalancheFuji,
    identity: '0xd6eB40E8D9e333f2b721bBd419c6CB40B55325Dd',
    parts: '0x0E14D4227D7775F4f4Ee9f4493826D5c4eb81a4b',
    partsClaim: '0x940d4F7edaCB067f780Da2e59177772D73Aa751B',
    market: '0x16140ee819539639f434FC32DfdEf392103B0703',
    rpc: 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    explorer: 'https://testnet.snowtrace.io',
  },
  // Avalanche C-Chain 主网(2026-10 UUPS 代理重部署,chainId 43114)
  avalanche: {
    key: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    chain: avalanche,
    identity: '0x72A1Ae8dD45f87c597d2C2450f7f200c81fc463c',
    parts: '0xb21652D0E6B3225d83B3aEB86f2185b8A6519976',
    partsClaim: '0x827350934d7632a9f7b14BeB2fB6716b61D1bD7b',
    market: '0x57720BEb1Bf1fe0Fa896CBdb2f683098d4fDaB61',
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    explorer: 'https://subnets.avax.network/c-chain',
  },
  // Solana devnet(程序 tinyworld 已部署,Token-2022;IDL 副本在 src/idl/tinyworld.json)
  'solana-devnet': {
    key: 'solana-devnet',
    name: 'Solana Devnet',
    chainId: 103,
    chain: solanaDevnetChain,
    identity: '4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH' as `0x${string}`,
    parts: '4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH' as `0x${string}`,
    rpc: 'https://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com?cluster=devnet',
    family: 'solana',
  },
}

export const identityAbi = DIDIdentityJson.abi
export const partsAbi = DIDPartsJson.abi
export const starterClaimAbi = StarterPartClaimJson.abi
export const partsMarketAbi = PartsMarketJson.abi

// ============================================================
// 链上配件注册表:链上 uint256 id ↔ 本地 SVG 部件 id
// 由 equipmentCatalog 自动生成;slot: 0头 1身 2配饰 3宠物
// ============================================================

export type { ChainPart }

export const chainParts: ChainPart[] = toChainParts()

export const SLOT_TO_CATEGORY = ['head', 'body', 'accessory', 'pet'] as const

export const partByChainId = (id: number | bigint) => chainParts.find((p) => p.id === Number(id))

export const partByLocalId = (localId: string) => chainParts.find((p) => p.localId === localId)
