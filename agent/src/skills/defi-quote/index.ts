import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getEquipment, getWalletAssets, loadPersona } from '../../chain/persona'
import { getAvaxPriceUsd } from '../../core/price'
import { isAddress, type Address } from 'viem'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-quote(只读,无需链上权限):
// 查 AVAX 价格(取价逻辑在 core/price.ts,与 defi-swap 共用)+ 读链概述装备持有
// ============================================================

const getAvaxPrice = createTool({
  id: 'get_avax_price',
  description: '查询 AVAX 当前的美元价格(免费行情 API)',
  inputSchema: z.object({}),
  outputSchema: z.object({ usd: z.number(), source: z.string() }),
  execute: async () => getAvaxPriceUsd(),
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

/** get_wallet_assets:查钱包在当前链上的资产;不传地址时默认查主人(ownerOf)的钱包 */
function makeGetWalletAssets(tokenId: number) {
  return createTool({
    id: 'get_wallet_assets',
    description:
      '查询某个钱包地址在当前链上的资产:原生币(AVAX/ETH)余额、USDC 余额、DID 装备。不填地址时默认查主人的钱包。',
    inputSchema: z.object({
      address: z.string().optional().describe('要查询的钱包地址,0x 开头;不填默认查主人钱包'),
    }),
    outputSchema: z.object({
      address: z.string(),
      nativeBalance: z.string(),
      nativeSymbol: z.string(),
      usdcBalance: z.string(),
      equipment: z.array(z.object({ slot: z.number(), collection: z.string(), partId: z.number(), balance: z.number() })),
    }),
    execute: async ({ context }) => {
      let addr = context.address?.trim()
      if (!addr) {
        addr = (await loadPersona(tokenId)).owner // 默认主人钱包
      }
      if (!isAddress(addr)) return Promise.reject(new Error(`地址不合法: ${addr}`))
      return getWalletAssets(addr as Address, tokenId)
    },
  })
}

export const defiQuote: SkillDef = {
  manifest: {
    id: 'defi-quote',
    name: '行情查询',
    version: '0.1.0',
    description: '查 AVAX 价格、查钱包资产、查自己的链上装备(只读)',
    tools: ['get_avax_price', 'get_my_equipment', 'get_wallet_assets'],
    permissions: [],
  },
  makeTools: (tokenId) => ({
    get_avax_price: getAvaxPrice,
    get_my_equipment: makeGetMyEquipment(tokenId),
    get_wallet_assets: makeGetWalletAssets(tokenId),
  }),
}
