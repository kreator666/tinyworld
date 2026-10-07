import { z } from 'zod'
import { createTool } from '@mastra/core/tools'
import { getEquipment, getWalletAssets, loadPersona, isValidAddress } from '../../chain/persona'
import { getNativePriceUsd } from '../../core/price'
import { getChainContext } from '../../chain/registry'
import type { SkillDef } from '../registry'

// ============================================================
// 内置技能 defi-quote(只读,无需链上权限):
// 查原生币价格(按链:AVAX/SOL/ETH)+ 读链上资产与装备持有
// ============================================================

/** get_native_price 闭包绑定 chainKey:查该链原生币的美元价格 */
function makeGetNativePrice(chainKey: string) {
  const symbol = getChainContext(chainKey).cfg.defi?.nativeSymbol ?? 'SOL'
  return createTool({
    id: 'get_native_price',
    description: `查询 ${symbol} 当前的美元价格(免费行情 API)`,
    inputSchema: z.object({}),
    outputSchema: z.object({ usd: z.number(), source: z.string() }),
    execute: async () => getNativePriceUsd(chainKey),
  })
}

/** get_my_equipment 闭包绑定 chainKey + tokenId:读链 getEquipped + DIDParts balanceOf */
function makeGetMyEquipment(chainKey: string, tokenId: number) {
  return createTool({
    id: 'get_my_equipment',
    description: '查看自己(当前 Agent)在链上装备了哪些部件、主人持有多少',
    inputSchema: z.object({}),
    outputSchema: z.object({
      items: z.array(z.object({ slot: z.number(), collection: z.string(), partId: z.number(), balance: z.number() })),
    }),
    execute: async () => {
      return { items: await getEquipment(chainKey, tokenId) }
    },
  })
}

/** get_wallet_assets:查钱包在当前链上的资产;不传地址时默认查主人(ownerOf)的钱包 */
function makeGetWalletAssets(chainKey: string, tokenId: number) {
  const isSolana = getChainContext(chainKey).family === 'solana'
  const desc = isSolana
    ? '查询某个钱包地址在当前链上的资产:原生币 SOL 余额、USDC 余额(Solana 测试网)、DID 装备。不填地址时默认查主人的钱包。'
    : '查询某个钱包地址在当前链上的资产:原生币(EVM)余额、USDC 余额、USDT 余额(Fuji 为 TraderJoe 测试 USDT)、DID 装备。不填地址时默认查主人的钱包。'
  return createTool({
    id: 'get_wallet_assets',
    description: desc,
    inputSchema: z.object({
      address: z.string().optional().describe('要查询的钱包地址(EVM 为 0x 开头,Solana 为 base58);不填默认查主人钱包'),
    }),
    outputSchema: z.object({
      address: z.string(),
      nativeBalance: z.string(),
      nativeSymbol: z.string(),
      usdcBalance: z.string(),
      usdtBalance: z.string(),
      equipment: z.array(z.object({ slot: z.number(), collection: z.string(), partId: z.number(), balance: z.number() })),
    }),
    execute: async ({ context }) => {
      let addr = context.address?.trim()
      if (!addr) {
        addr = (await loadPersona(chainKey, tokenId)).owner // 默认主人钱包
      }
      if (!isValidAddress(addr)) return Promise.reject(new Error(`地址不合法: ${addr}`))
      return getWalletAssets(chainKey, addr, tokenId)
    },
  })
}

export const defiQuote: SkillDef = {
  manifest: {
    id: 'defi-quote',
    name: '行情查询',
    version: '0.2.0',
    description: '查链上资产、查自己的装备、查原生币美元价格(只读)',
    tools: ['get_native_price', 'get_my_equipment', 'get_wallet_assets'],
    permissions: [],
    scope: 'owner', // 涉及钱包/资产/行情,仅限主人对话
  },
  makeTools: (chainKey, tokenId) => ({
    get_native_price: makeGetNativePrice(chainKey),
    get_my_equipment: makeGetMyEquipment(chainKey, tokenId),
    get_wallet_assets: makeGetWalletAssets(chainKey, tokenId),
  }),
}
