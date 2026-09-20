import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getEquipment } from '../../chain/persona'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-quote(只读,无需链上权限):
// CoinGecko 查 AVAX 价格 + 读链概述自己的装备持有
// ============================================================

const getAvaxPrice = createTool({
  id: 'get_avax_price',
  description: '查询 AVAX 当前的美元价格(免费行情 API)',
  inputSchema: z.object({}),
  outputSchema: z.object({ usd: z.number(), source: z.string() }),
  execute: async () => {
    // 主源 CoinGecko;部分网络环境(如本机)直连超时,回退 Gate.io 现货行情
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd', {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { 'avalanche-2'?: { usd?: number } }
      const usd = data['avalanche-2']?.usd
      if (typeof usd !== 'number') throw new Error('返回数据缺少 AVAX 价格')
      return { usd, source: 'coingecko' }
    } catch {
      const res = await fetch('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=AVAX_USDT', {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`行情接口都不可用: Gate.io HTTP ${res.status}`)
      const data = (await res.json()) as { last?: string }[]
      const usd = Number(data?.[0]?.last)
      if (!Number.isFinite(usd) || usd <= 0) throw new Error('行情接口都不可用: Gate.io 返回数据异常')
      return { usd, source: 'gateio' }
    }
  },
})

/** get_my_equipment 闭包绑定 tokenId:读链 getEquipped + DIDParts balanceOf */
function makeGetMyEquipment(tokenId: number) {
  return createTool({
    id: 'get_my_equipment',
    description: '查看自己(当前 Agent)在链上装备了哪些部件、主人持有多少',
    inputSchema: z.object({}),
    outputSchema: z.object({
      items: z.array(z.object({ slot: z.number(), collection: z.string(), partId: z.number(), balance: z.number() })),
    }),
    execute: async () => {
      return { items: await getEquipment(tokenId) }
    },
  })
}

export const defiQuote: SkillDef = {
  manifest: {
    id: 'defi-quote',
    name: '行情查询',
    version: '0.1.0',
    description: '查 AVAX 价格、查自己的链上装备(只读)',
    tools: ['get_avax_price', 'get_my_equipment'],
    permissions: [],
  },
  makeTools: (tokenId) => ({
    get_avax_price: getAvaxPrice,
    get_my_equipment: makeGetMyEquipment(tokenId),
  }),
}
