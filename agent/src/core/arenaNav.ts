import { formatUnits, type Address } from 'viem'
import { getChainContext } from '../chain/registry'
import { getNativeBalance, getTokenBalance } from '../chain/defi'
import { getNativePriceUsd } from '../core/price'
import { getReserveInfo, getATokenBalance } from '../chain/aave'
import { getAccountPositions } from '../chain/gmx'

// ============================================================
// 竞技场净值(NAV)计算(P4):技能与调度器共用的唯一口径。
// NAV = 现金(USDC + 原生币按行情折算) + Aave 存款(aToken 1:1) + GMX 仓位抵押(USDC 1:1)
// 行情源沿用现有链路(CoinGecko/Gate + Aave Oracle);读失败按 0 计并交由上层熔断语义处理。
// ============================================================

export interface NavBreakdown {
  navUsd: number
  usdcUsd: number
  nativeUsd: number
  aaveUsd: number
  gmxUsd: number
}

const ZERO = '0x0000000000000000000000000000000000000000'

export async function computeNav(chainKey: string, accountAddr: Address): Promise<NavBreakdown> {
  const cfg = getChainContext(chainKey).cfg
  const usdcUsd =
    cfg.defi!.usdc === ZERO ? 0 : Number(formatUnits(await getTokenBalance(chainKey, cfg.defi!.usdc as Address, accountAddr), 6))
  const nativeUsd =
    Number(formatUnits(await getNativeBalance(chainKey, accountAddr), 18)) * (await getNativePriceUsd(chainKey)).usd
  let aaveUsd = 0
  if (cfg.aave) {
    for (const asset of cfg.aave.assets ?? []) {
      const info = await getReserveInfo(chainKey, asset.address as Address)
      const bal = await getATokenBalance(chainKey, info.aToken, accountAddr)
      aaveUsd += Number(formatUnits(bal, asset.decimals))
    }
  }
  let gmxUsd = 0
  if (cfg.gmx) {
    // 抵押品为 USDC(6 decimals),按 1:1 计
    const positions = await getAccountPositions(chainKey, accountAddr)
    for (const p of positions) gmxUsd += Number(formatUnits(p.collateralAmount, 6))
  }
  return { navUsd: usdcUsd + nativeUsd + aaveUsd + gmxUsd, usdcUsd, nativeUsd, aaveUsd, gmxUsd }
}
