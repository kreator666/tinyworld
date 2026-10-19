import { defiLending } from '../runtime-skills/builtins/defi-lending'
import { getChainContext } from '../src/chain/registry'

process.env.TARGET_CHAIN = 'avalanche'

async function main() {
  const chainKey = 'avalanche'
  const tokenId = 1
  const tools = defiLending.makeTools(chainKey, tokenId)

  // 验证 tool description 已动态化
  console.log('propose_supply description includes symbols:', tools.propose_supply.description)

  // 只读查询仓位(需要 AGENT_PRIVATE_KEY)
  const result = await tools.get_lending_position.execute({ context: {} } as any)
  console.log('get_lending_position result:', JSON.stringify(result, null, 2))

  // 验证配置读取
  const cfg = getChainContext(chainKey).cfg
  console.log('aave assets:', cfg.aave?.assets?.map((a) => a.symbol).join('/'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
