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
  defi: {
    router: `0x${string}` // V2 风格 Router(Fuji=TraderJoe,Sepolia=Uniswap)
    wNative: `0x${string}` // WAVAX / WETH
    usdc: `0x${string}`
    nativeSymbol: string // AVAX / ETH
    nativePriceId: 'avax' // 估值用的行情币(M4 只支持 AVAX 计价;Sepolia ETH 无真实价格,仅备用)
  }
}

const CHAINS: Record<string, ChainConfig> = {
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    identityAddress: '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1',
    partsAddress: '0xACa57ACa9F8FF68Dbf74E2baAB65f88Ec2515959',
    defi: {
      router: '0xb26b2de65d07ebb5e54c7f6282424d3be670e1f0',
      wNative: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
      usdc: '0x0000000000000000000000000000000000000000', // Sepolia 无已核实 USDC,备用链暂不支持 swap 估值
      nativeSymbol: 'ETH',
      nativePriceId: 'avax', // 占位:Sepolia 上 swap 只做流程验证
    },
  },
  fuji: {
    name: 'Fuji',
    chainId: 43113,
    rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorer: 'https://testnet.snowtrace.io',
    identityAddress: '0x15dC02b5678b8454C75EeA0208C1C027b1903d9c',
    partsAddress: '0xdac819D6B834E26B23EE30Edc9C13eA0a4b834f2',
    defi: {
      router: '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901',
      wNative: '0xd00ae08403B9bbb9124bB305C09058E32C39A48c',
      usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
      nativeSymbol: 'AVAX',
      nativePriceId: 'avax',
    },
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
  // 心跳调度器周期(秒),M3 自主社交用;验证时可调小(如 15)
  heartbeatSeconds: Number(env('HEARTBEAT_SECONDS', '300')),
  // Agent 热钱包私钥(M4 DeFi 执行用;未配置时 defi-swap 工具只报价不执行)。永远不要打印/提交
  agentPrivateKey: env('AGENT_PRIVATE_KEY'),
  // 价格源 URL(可用 env 覆盖;策略引擎熔断验证时故意改错)
  priceCoingeckoUrl: env('PRICE_COINGECKO_URL', 'https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd'),
  priceGateUrl: env('PRICE_GATE_URL', 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=AVAX_USDT'),
  // 策略引擎阈值(默认:单笔 $25 / 日累计 $125 / 同 action 冷却 600s)
  policyMaxTxUsd: Number(env('POLICY_MAX_TX_USD', '25')),
  policyDailyLimitUsd: Number(env('POLICY_DAILY_LIMIT_USD', '125')),
  policyCooldownSeconds: Number(env('POLICY_COOLDOWN_SECONDS', '600')),
} as const
