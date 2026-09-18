import 'dotenv/config'

// 服务配置:全部从 .env 读取,给出开发默认值
function env(key: string, fallback = ''): string {
  const v = process.env[key]
  return v && v.length > 0 ? v : fallback
}

export const config = {
  llmBaseUrl: env('LLM_BASE_URL', 'https://aiping.cn/api/v1'),
  llmApiKey: env('LLM_API_KEY'),
  llmModel: env('LLM_MODEL', 'gpt-4o-mini'),
  port: Number(env('PORT', '4111')),
  sepoliaRpc: env('SEPOLIA_RPC', 'https://ethereum-sepolia-rpc.publicnode.com'),
  identityAddress: env('DID_IDENTITY_ADDRESS', '0x363AF72fC15af43BfEA47C1ED09128Cd994946c1') as `0x${string}`,
} as const
