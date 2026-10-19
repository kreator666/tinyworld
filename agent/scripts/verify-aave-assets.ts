import { getChainContext } from '../src/chain/registry'
import { getPublicClient } from '../src/chain/clients'
import { getReserveInfo, getAssetPriceUsd, getATokenBalance, getLendingWalletAddress } from '../src/chain/aave'
import { formatUnits, type Address } from 'viem'

async function main() {
  const chainKey = 'avalanche'
  const ctx = getChainContext(chainKey)
  if (!ctx.cfg.aave?.assets) {
    console.error('avalanche 未配置 Aave 资产')
    process.exit(1)
  }

  const wallet = getLendingWalletAddress()
  console.log('configured assets:', ctx.cfg.aave.assets.map((a) => a.symbol).join('/'))
  console.log('wallet:', wallet ?? 'no AGENT_PRIVATE_KEY')

  for (const asset of ctx.cfg.aave.assets) {
    try {
      const reserve = await getReserveInfo(chainKey, asset.address as Address)
      const price = await getAssetPriceUsd(chainKey, asset.address as Address)
      let balance = 'n/a'
      if (wallet) {
        const bal = await getATokenBalance(chainKey, reserve.aToken, wallet)
        balance = formatUnits(bal, asset.decimals)
      }
      console.log(
        `${asset.symbol.padEnd(6)} | price $${price.toFixed(4)} | supplyAPY ${(reserve.supplyApy * 100).toFixed(2)}% | aToken ${reserve.aToken} | supplied ${balance}`,
      )
    } catch (err) {
      console.warn(`${asset.symbol} failed:`, err instanceof Error ? err.message : String(err))
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
