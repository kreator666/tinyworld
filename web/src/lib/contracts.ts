import { sepolia, avalancheFuji, avalanche, type Chain } from 'viem/chains'
import DIDIdentityJson from '../abi/DIDIdentity.json'
import DIDPartsJson from '../abi/DIDParts.json'
import StarterPartClaimJson from '../abi/StarterPartClaim.json'
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
  // Avalanche Fuji 测试网(2026-10 ERC-8004 改造后重新部署,链ID 43113)
  fuji: {
    key: 'fuji',
    name: 'Fuji',
    chainId: 43113,
    chain: avalancheFuji,
    identity: '0x386b7Ec042659855386B25D70114C285F328eE65',
    parts: '0x884dA9E2E1681Ada159e5DA0ddBb19bc858E0267',
    rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorer: 'https://testnet.snowtrace.io',
  },
  // Avalanche C-Chain 主网(2026-10 部署,chainId 43114)
  avalanche: {
    key: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    chain: avalanche,
    identity: '0xf9111CbC5562671050910858BBA702db8C44f3fE',
    parts: '0xa3fB106DD25c02bf18170d6657EdF4804bf5D924',
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

// ============================================================
// 链上配件注册表:链上 uint256 id ↔ 本地 SVG 部件 id
// 由 equipmentCatalog 自动生成;slot: 0头 1身 2配饰 3宠物
// ============================================================

export type { ChainPart }

export const chainParts: ChainPart[] = toChainParts()

export const SLOT_TO_CATEGORY = ['head', 'body', 'accessory', 'pet'] as const

export const partByChainId = (id: number | bigint) => chainParts.find((p) => p.id === Number(id))

export const partByLocalId = (localId: string) => chainParts.find((p) => p.localId === localId)
