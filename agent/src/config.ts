import 'dotenv/config'

// 服务配置:全部从 .env 读取,给出开发默认值
function env(key: string, fallback = ''): string {
  const v = process.env[key]
  return v && v.length > 0 ? v : fallback
}

// ============================================================
// 链配置:与前端 web/src/lib/contracts.ts 的 CONTRACTS_BY_CHAIN 对应
// TARGET_CHAIN 环境变量选择:sepolia(默认) | fuji | solana-devnet
// family 区分链家族:evm(EVM 链,defi/aave 可用)/ solana(身份/人格/装备读+DeFi 兑换)
// ============================================================
interface ChainConfig {
  family: 'evm' | 'solana'
  name: string
  chainId: number // Solana 家族为哨兵值(103=devnet,与 solana-cli 的 cluster 约定一致)
  rpc: string
  rpcFallbacks?: string[] // 备用 RPC:主端点网络故障时自动切换(Solana 官方域名间歇性不可达,必须配)
  explorer: string
  identityAddress: string // EVM 为 0x 合约地址;Solana 为程序地址(base58)
  partsAddress: string
  partsClaim?: string // 新手装备免费领养合约地址(EVM);未部署的链不填,运行时经 /admin/chains/:key/config 写入 chains.config
  market?: { address: string } // 装备铸造直售市场合约地址(EVM);价格一律链上为准,这里只存地址
  benqi?: { staking: string; sAvax: string } // BENQI Liquid Staking(仅 Avalanche 主网部署,无 Fuji);staking 与 sAVAX 为同一双用途合约
  gmx?: {
    // GMX V2 永续/现货;参考 https://docs.gmx.io/docs/api/contracts/addresses/
    exchangeRouter: string
    orderVault: string
    reader: string
    dataStore: string
    router: string
  }
  nativePriceId?: string // 原生币 CoinGecko id(defi-quote 技能用;缺省回落 AVAX)
  nativeGatePair?: string // 原生币 Gate.io 交易对(回退行情源)
  defi?: {
    router: `0x${string}` // V2 风格 Router(Fuji=TraderJoe,Sepolia=Uniswap)
    wNative: `0x${string}` // WAVAX / WETH
    usdc: `0x${string}`
    usdt: `0x${string}` // Fuji 为 TraderJoe 官方测试 USDT;无可靠部署的链填零地址
    nativeSymbol: string // AVAX / ETH
    nativePriceId: 'avax' // 估值用的行情币(M4 只支持 AVAX 计价;Sepolia ETH 无真实价格,仅备用)
  }
  aave?: {
    pool: `0x${string}` // Aave v3 Pool(地址来自 Aave 官方 address book)
    gateway?: `0x${string}` // WrappedTokenGateway(原生币存取;Aave address book WETH_GATEWAY,按链不同)
    /** 该链 Aave Pool 支持的资产列表;defi-lending skill 与策略引擎白名单均从这里推导。
     *  isNative=true 表示该资产走 gateway depositETH/withdrawETH( symbol 通常显示为原生币如 AVAX/ETH)。
     *  未配置时 lending skill 会回落到 [wNative, usdc] 以保持向后兼容。 */
    assets?: Array<{
      symbol: string
      address: `0x${string}`
      decimals: number
      isNative?: boolean
    }>
  }
  // Solana 家族专属:稳定币 mint 与 Jupiter 兑换 API(测试网需自托管 quote API,见运维手册)
  solana?: {
    usdcMint?: string // 测试 USDC mint(devnet 通用 4zMMC9...);可用 SOLANA_USDC_MINT 覆盖
    usdtMint?: string // 测试 USDT mint;未配置则余额恒为 0
    jupiterApiUrl?: string // Jupiter v6 API 地址;空 = 本链不支持兑换(技能隐藏)
  }
}
export type { ChainConfig }

const CHAINS: Record<string, ChainConfig> = {
  sepolia: {
    family: 'evm',
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
      usdt: '0x0000000000000000000000000000000000000000', // Sepolia 无已核实 USDT
      nativeSymbol: 'ETH',
      nativePriceId: 'avax', // 占位:Sepolia 上 swap 只做流程验证
    },
    aave: {
      // Sepolia 也部署了 Aave v3 测试池(Aave 官方 address book AaveV3Sepolia.POOL / WETH_GATEWAY)
      pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
      gateway: '0x387d311e47e80b498169e6fb51d3193167d89F7D',
    },
  },
  fuji: {
    family: 'evm',
    name: 'Fuji',
    chainId: 43113,
    rpc: 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    explorer: 'https://testnet.snowtrace.io',
    identityAddress: '0xd6eB40E8D9e333f2b721bBd419c6CB40B55325Dd', // 2026-10 UUPS 代理
    partsAddress: '0x0E14D4227D7775F4f4Ee9f4493826D5c4eb81a4b',
    partsClaim: '0x940d4F7edaCB067f780Da2e59177772D73Aa751B',
    market: { address: '0x16140ee819539639f434FC32DfdEf392103B0703' }, // 2026-10 UUPS 代理
    nativePriceId: 'avalanche-2', // defi-quote 行情技能:原生币 CoinGecko id
    nativeGatePair: 'AVAX_USDT', // Gate.io 回退源交易对
    defi: {
      router: '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901',
      wNative: '0xd00ae08403B9bbb9124bB305C09058E32C39A48c',
      usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
      usdt: '0xAb231A5744C8E6c45481754928cCfFFFD4aa0732', // TraderJoe 官方测试 USDT(LFJ 文档收录,配 WAVAX/USDT V1 池)
      nativeSymbol: 'AVAX',
      nativePriceId: 'avax',
    },
    aave: {
      // Aave 官方 address book: https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Fuji.sol
      pool: '0x8B9b2AF4afB389b4a70A474dfD4AdCD4a302bb40',
      gateway: '0x3d2ee1AB8C3a597cDf80273C684dE0036481bE3a',
    },
  },
  // Avalanche C-Chain 主网(2026-10 部署,chainId 43114;defi/aave 地址均经官方来源+主网 RPC 自证)
  avalanche: {
    family: 'evm',
    name: 'Avalanche',
    chainId: 43114,
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    rpcFallbacks: ['https://1rpc.io/avax/c'],
    explorer: 'https://subnets.avax.network/c-chain',
    identityAddress: '0x72A1Ae8dD45f87c597d2C2450f7f200c81fc463c', // 2026-10 UUPS 代理
    partsAddress: '0xb21652D0E6B3225d83B3aEB86f2185b8A6519976',
    partsClaim: '0x827350934d7632a9f7b14BeB2fB6716b61D1bD7b',
    // BENQI Liquid Staking:官方文档 docs.benqi.fi/resources/contracts/liquid-staking + 主网 RPC 双源核实(2026-10)
    // 质押合约与 sAVAX 代币是同一双用途合约(submit() payable 铸 sAVAX;redeem 进 15 天冷却)
    benqi: { staking: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', sAvax: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE' },
    // GMX V2:官方文档 contract addresses,2026-10 核实
    gmx: {
      exchangeRouter: '0xc002Db96E682FFF6675966F959677285a0C45Efa',
      orderVault: '0xD3D60D22d415aD43b7e64b510D86A30f19B1B12C',
      reader: '0xa34320a507493C71Fe35E982e496F7C5d1a7fa02',
      dataStore: '0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6',
      router: '0x820F5FfC5b525cD4d88Cd91aCf2c28F16530Cc68',
    },
    market: { address: '0x57720BEb1Bf1fe0Fa896CBdb2f683098d4fDaB61' }, // 2026-10 UUPS 代理
    nativePriceId: 'avalanche-2',
    nativeGatePair: 'AVAX_USDT',
    defi: {
      // LFJ(TraderJoe) V1 Router(官方文档 developers.lfj.gg 核实的 Avalanche 部署地址)
      router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
      wNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Circle 原生 USDC(曾记错过尾号,以 Aave address book 为准)
      usdt: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      nativeSymbol: 'AVAX',
      nativePriceId: 'avax',
    },
    aave: {
      // Aave 官方 address book AaveV3Avalanche:POOL / WETH_GATEWAY
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      gateway: '0x2825cE5921538d17cc15Ae00a8B24fF759C6CDaE',
      // Avalanche Aave v3 流动性 Top 5 reserve assets(地址+精度均经主网 RPC 核实)
      assets: [
        { symbol: 'AVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18, isNative: true }, // WAVAX,存取走 gateway
        { symbol: 'BTC.b', address: '0x152b9d0FdC40C096757F570A51E494bd4b943E50', decimals: 8 },
        { symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
        { symbol: 'sAVAX', address: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', decimals: 18 },
        { symbol: 'USDt', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
      ],
    },
  },
  // Solana devnet:Anchor 程序 tinyworld(Soulbound DID + 装备,Token-2022)
  // DeFi 技能(兑换/借贷)在 devnet 可用;Jupiter 需自托管 quote API 填入 solana.jupiterApiUrl
  'solana-devnet': {
    family: 'solana',
    name: 'Solana Devnet',
    chainId: 103,
    rpc: 'https://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com?cluster=devnet',
    identityAddress: '4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH',
    partsAddress: '4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH',
    nativePriceId: 'solana',
    nativeGatePair: 'SOL_USDT',
    solana: {
      usdcMint: env('SOLANA_USDC_MINT', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), // Circle 官方 devnet USDC(SPL token, faucet 限量)
      usdtMint: env('SOLANA_USDT_MINT', ''), // devnet 无公认 USDT 时留空 = 余额恒 0
      jupiterApiUrl: env('JUPITER_API_URL', ''), // 官方 api.jup.ag 仅主网;devnet 需自托管 jupiter-quote-api
    },
  },
}

const targetKey = env('TARGET_CHAIN', 'sepolia').toLowerCase()
const target = CHAINS[targetKey]
if (!target) throw new Error(`未知的 TARGET_CHAIN: ${targetKey}(可选: ${Object.keys(CHAINS).join('/')})`)
// 允许用环境变量覆盖单条链的 RPC/地址(比如换私有 RPC 节点)
target.rpc = env('CHAIN_RPC', target.rpc)
// 备用 RPC:逗号分隔;显式配置时覆盖内置默认
const fallbackEnv = env('CHAIN_RPC_FALLBACKS')
if (fallbackEnv) target.rpcFallbacks = fallbackEnv.split(',').map((s) => s.trim()).filter(Boolean)
target.identityAddress = env('DID_IDENTITY_ADDRESS', target.identityAddress)

/** 全部链配置(chains 表种子数据用) */
export const ALL_CHAINS = CHAINS

export const config = {
  llmBaseUrl: env('LLM_BASE_URL', 'https://aiping.cn/api/v1'),
  llmApiKey: env('LLM_API_KEY'),
  llmModel: env('LLM_MODEL', 'gpt-4o-mini'),
  port: Number(env('PORT', '4111')),
  chain: target,
  chainKey: targetKey, // chains 表主键/镜像表 chain_key;镜像按链隔离
  // Agent 服务热钱包地址,安装需要权限的技能时查链上 agentPermissions;
  // 未配置(空串)则跳过链上校验并在安装响应中注明
  agentServiceAddress: env('AGENT_SERVICE_ADDRESS'),
  // 心跳调度器周期(秒),M3 自主社交用;验证时可调小(如 15)
  heartbeatSeconds: Number(env('HEARTBEAT_SECONDS', '300')),
  arenaSchedulerSeconds: Number(env('ARENA_SCHEDULER_SECONDS', '30')),
  // Agent 热钱包私钥(M4 DeFi 执行用;未配置时 defi-swap 工具只报价不执行)。永远不要打印/提交
  agentPrivateKey: env('AGENT_PRIVATE_KEY'),
  arenaAdminPrivateKey: env('ARENA_ADMIN_PRIVATE_KEY') || env('AGENT_PRIVATE_KEY'),
  // Agent Solana 热钱包私钥(base58 编码的 64 字节 secret key,defi-swap-sol 经 Jupiter 执行兑换时签名用)。
  // 永远不要打印/提交真实值
  agentSolanaKey: env('AGENT_SOLANA_PRIVATE_KEY', ''),
  // 价格源 URL(可用 env 覆盖;策略引擎熔断验证时故意改错)
  priceCoingeckoUrl: env('PRICE_COINGECKO_URL', 'https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd'),
  priceGateUrl: env('PRICE_GATE_URL', 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=AVAX_USDT'),
  // 策略引擎阈值(默认:单笔 $25 / 日累计 $125 / 同 action 冷却 600s)
  policyMaxTxUsd: Number(env('POLICY_MAX_TX_USD', '25')),
  policyDailyLimitUsd: Number(env('POLICY_DAILY_LIMIT_USD', '125')),
  policyCooldownSeconds: Number(env('POLICY_COOLDOWN_SECONDS', '600')),
  // JWT 认证:SIWE 签名登录后签发会话 token(生产环境必须设置强随机字符串)
  jwtSecret: env('JWT_SECRET', 'dev-secret-change-me-in-production'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '24h'),
  // 引导管理员地址(公钥地址,非秘密):admin_whitelist 为空时启动自动写入白名单;
  // 之后增删管理员走 /admin/admins 接口(需签名登录 JWT)
  adminAddress: env('ADMIN_ADDRESS'),
} as const
