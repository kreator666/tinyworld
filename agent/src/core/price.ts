import { config } from '../config'
import { getChainContext } from '../chain/registry'

// AVAX 美元价格:CoinGecko 主源 + Gate.io 回退(部分网络环境直连 CoinGecko 超时)
// 两个源的 URL 都可用环境变量覆盖(PRICE_COINGECKO_URL / PRICE_GATE_URL),熔断测试时改错即可
// 两源都失败时抛错,由调用方决定(策略引擎:估值失败一律转人工)
//
// 多链:查链原生币价格用 getNativePriceUsd(chainKey)(报价技能);
// getAvaxPriceUsd 保留给 EVM 策略引擎估值(默认链),行为不变

export async function getAvaxPriceUsd(): Promise<{ usd: number; source: string }> {
  try {
    const res = await fetch(config.priceCoingeckoUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { 'avalanche-2'?: { usd?: number } }
    const usd = data['avalanche-2']?.usd
    if (typeof usd !== 'number') throw new Error('返回数据缺少 AVAX 价格')
    return { usd, source: 'coingecko' }
  } catch {
    const res = await fetch(config.priceGateUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`行情接口都不可用: Gate.io HTTP ${res.status}`)
    const data = (await res.json()) as { last?: string }[]
    const usd = Number(data?.[0]?.last)
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('行情接口都不可用: Gate.io 返回数据异常')
    return { usd, source: 'gateio' }
  }
}

/** 指定链原生币的美元价格(CoinGecko 主源 + Gate.io 回退);链未配置价格源时回落默认链(AVAX) */
export async function getNativePriceUsd(chainKey: string): Promise<{ usd: number; source: string }> {
  const cfg = getChainContext(chainKey).cfg
  if (!cfg.nativePriceId) return getAvaxPriceUsd()
  const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cfg.nativePriceId}&vs_currencies=usd`
  const gateUrl = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${cfg.nativeGatePair ?? 'AVAX_USDT'}`
  try {
    const res = await fetch(cgUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, { usd?: number }>
    const usd = data[cfg.nativePriceId!]?.usd
    if (typeof usd !== 'number') throw new Error(`返回数据缺少 ${cfg.nativePriceId} 价格`)
    return { usd, source: 'coingecko' }
  } catch {
    const res = await fetch(gateUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`行情接口都不可用: Gate.io HTTP ${res.status}`)
    const data = (await res.json()) as { last?: string }[]
    const usd = Number(data?.[0]?.last)
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('行情接口都不可用: Gate.io 返回数据异常')
    return { usd, source: 'gateio' }
  }
}

const MAJOR_IDS = 'bitcoin,ethereum,avalanche-2'
const MAJOR_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  'avalanche-2': 'AVAX',
}

/** 主流资产 USD 价格与 24h 涨跌幅(BTC/ETH/AVAX);失败时返回空对象,不阻塞调用方 */
export async function getMajorPricesUsd(): Promise<Record<string, { usd: number; change24h: number | null }>> {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${MAJOR_IDS}&vs_currencies=usd&include_24hr_change=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>
    const out: Record<string, { usd: number; change24h: number | null }> = {}
    for (const [id, symbol] of Object.entries(MAJOR_SYMBOLS)) {
      const p = data[id]
      if (typeof p?.usd === 'number') {
        out[symbol] = { usd: p.usd, change24h: typeof p.usd_24h_change === 'number' ? p.usd_24h_change : null }
      }
    }
    return out
  } catch (err) {
    console.error('[price] 主流资产行情获取失败:', err instanceof Error ? err.message : err)
    return {}
  }
}

// defaultChainKey 引用保持模块依赖方向(price → registry → config)
