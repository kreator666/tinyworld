import 'dotenv/config'

// 服务配置:全部从 .env 读取,给出开发默认值
function env(key: string, fallback = ''): string {
  const v = process.env[key]
  return v && v.length > 0 ? v : fallback
}

// ============================================================
// 链配置:与前端 web/src/lib/contracts.ts 的 CONTRACTS_BY_CHAIN 对应
// TARGET_CHAIN 环境变量选择:sepolia(默认) | fuji
// ============================================================
interface ChainConfig {
  name: string
  chainId: number
  rpc: string
  explorer: string
  identityAddress: `0x${string}`
  partsAddress: `0x${string}`
}

const CHAINS: Record<string, ChainConfig> = {
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    identityAddress: '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1',
    partsAddress: '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959',
  },
  fuji: {
    name: 'Fuji',
    chainId: 43113,
    rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorer: 'https://testnet.snowtrace.io',
    identityAddress: '0x15dC02b5678b8454C75EeA0208C1C027b1903d9c',
    partsAddress: '0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2',
  },
}

const targetKey = env('TARGET_CHAIN', 'sepolia').toLowerCase()
const target = CHAINS[targetKey]
if (!target) throw new Error(`未知的 TARGET_CHAIN: ${targetKey}(可选: ${Object.keys(CHAINS).join('/')})`)

// 允许用环境变量覆盖单条链的 RPC/地址(比如换私有 RPC 节点)
target.rpc = env('CHAIN_RPC', target.rpc)
target.identityAddress = env('DID_IDENTITY_ADDRESS', target.identityAddress) as `0x${string}`

/** 全部链配置(chains 表种子数据用) */
export const ALL_CHAINS = CHAINS

export const config = {
  llmBaseUrl: env('LLM_BASE_URL', 'https://aiping.cn/api/v1'),
  llmApiKey: env('LLM_API_KEY'),
  llmModel: env('LLM_MODEL', 'gpt-4o-mini'),
  port: Number(env('PORT', '4111')),
  chain: target,
  // Agent 服务热钱包地址,安装需要权限的技能时查链上 agentPermissions;
  // 未配置(空串)则跳过链上校验并在安装响应中注明
  agentServiceAddress: env('AGENT_SERVICE_ADDRESS'),
} as const
