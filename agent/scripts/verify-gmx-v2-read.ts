import { getChainContext } from '../src/chain/registry'
import { getMarkets, getAccountPositions } from '../src/chain/gmx'

// 只读验证:GMX V2 市场列表 + 仓位查询
async function main() {
  const chainKey = 'avalanche'
  const ctx = getChainContext(chainKey)
  if (!ctx.cfg.gmx) {
    console.error('avalanche 未配置 GMX V2')
    process.exit(1)
  }

  console.log('GMX ExchangeRouter:', ctx.cfg.gmx.exchangeRouter)
  console.log('GMX Reader:', ctx.cfg.gmx.reader)

  const markets = await getMarkets(chainKey)
  console.log(`\nmarkets count: ${markets.length}`)
  for (const m of markets.slice(0, 5)) {
    console.log('  market:', m.marketToken, '| index:', m.indexToken, '| long:', m.longToken, '| short:', m.shortToken)
  }

  const zero = '0x0000000000000000000000000000000000000000' as `0x${string}`
  const positions = await getAccountPositions(chainKey, zero)
  console.log(`\nzero address positions: ${positions.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
