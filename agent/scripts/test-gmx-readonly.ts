import { defiPerpGmx } from '../runtime-skills/builtins/defi-perp-gmx'

process.env.TARGET_CHAIN = 'avalanche'

async function main() {
  const chainKey = 'avalanche'
  const tokenId = 1
  const tools = defiPerpGmx.makeTools(chainKey, tokenId)

  console.log('=== gmx_markets ===')
  const markets = await tools.gmx_markets.execute({ context: {} } as any)
  console.log(JSON.stringify(markets, null, 2))

  console.log('\n=== gmx_price AVAX ===')
  const price = await tools.gmx_price.execute({ context: { symbol: 'AVAX' } } as any)
  console.log(JSON.stringify(price, null, 2))

  console.log('\n=== gmx_price BTC ===')
  const btcPrice = await tools.gmx_price.execute({ context: { symbol: 'BTC' } } as any)
  console.log(JSON.stringify(btcPrice, null, 2))

  console.log('\n=== gmx_position AVAX ===')
  const position = await tools.gmx_position.execute({ context: { symbol: 'AVAX' } } as any)
  console.log(JSON.stringify(position, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
