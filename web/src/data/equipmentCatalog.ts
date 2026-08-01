import type { NFTCategory, NFTItem, Rarity } from '../types'

// ============================================================
// 链上装备总目录
// 4 个插槽 × 30 件 = 120 件
// chainId 规则: 1xxx = head, 2xxx = body, 3xxx = accessory, 4xxx = pet
// localId 规则: head-1 .. head-30, body-1 .. body-30, acc-1 .. acc-30, pet-1 .. pet-30
// ============================================================

export type ChainRarity = 0 | 1 | 2 | 3
export type SlotIndex = 0 | 1 | 2 | 3

export interface CatalogItem {
  localId: string
  chainId: number
  name: string
  category: NFTCategory
  slot: SlotIndex
  rarity: Rarity
  rarityChain: ChainRarity
  maxSupply: number
  mintAmount: number
  price: number
  emoji: string
  gradient: string
  imageUrl: string
}

export interface ChainPart {
  id: number
  localId: string
  slot: number
  name: string
  rarity: Rarity
}

const RARITY_ORDER: Rarity[] = ['普通', '稀有', '史诗', '传说']
const RARITY_CHAIN: Record<Rarity, ChainRarity> = { 普通: 0, 稀有: 1, 史诗: 2, 传说: 3 }

const RARITY_CONFIG: Record<Rarity, { maxSupply: number; mintAmount: number; price: number }> = {
  普通: { maxSupply: 10000, mintAmount: 200, price: 0.005 },
  稀有: { maxSupply: 2000, mintAmount: 50, price: 0.02 },
  史诗: { maxSupply: 500, mintAmount: 20, price: 0.08 },
  传说: { maxSupply: 100, mintAmount: 5, price: 0.25 },
}

// 每个类别 30 件: 普通 12 + 稀有 9 + 史诗 6 + 传说 3
const DISTRIBUTION: Record<Rarity, number> = { 普通: 12, 稀有: 9, 史诗: 6, 传说: 3 }

const GRADIENT_POOL = [
  'from-violet-500 to-fuchsia-500',
  'from-indigo-500 to-cyan-400',
  'from-amber-300 to-rose-400',
  'from-purple-600 to-indigo-600',
  'from-emerald-500 to-lime-600',
  'from-gray-700 to-purple-700',
  'from-slate-300 to-amber-300',
  'from-cyan-300 to-blue-600',
  'from-cyan-200 to-sky-400',
  'from-orange-300 to-amber-500',
]

interface CategoryDef {
  slot: SlotIndex
  prefix: string
  names: Record<Rarity, string[]>
  emojis: string[]
}

const CATEGORY_CONFIG: Record<NFTCategory, CategoryDef> = {
  head: {
    slot: 0,
    prefix: 'head',
    names: {
      普通: ['遮阳帽', '泳镜帽', '蝴蝶结', '蓝羽发饰', '贝壳发冠', '珍珠发箍', '头巾', '骷髅帽', '潜水面镜', '护目镜', '彩虹帽', '贝壳耳环'],
      稀有: ['海星发夹', '海浪发箍', '海盗帽', '小水母', '白羽毛', '珍珠皇冠', '贝雷帽', '水手帽', '棒球帽'],
      史诗: ['花环帽', '水滴', '护耳帽', '船长帽', '贝壳发箍', '小发夹'],
      传说: ['星星帽', '粉色发箍', '水手头巾'],
    },
    emojis: ['👒', '🏊', '🎀', '🪶', '🐚', '📿', '🧣', '💀', '🤿', '🥽', '🌈', '🦪', '⭐', '🌊', '🏴‍☠️', '🪼', '🪽', '👑', '🎨', '⚓', '🧢', '💐', '💧', '⛑️', '🧑‍✈️', '🐚', '✨', '🌟', '🎀', '⛵'],
  },
  body: {
    slot: 1,
    prefix: 'body',
    names: {
      普通: ['素色T恤', '水手服', '薄纱披风', '连帽斗篷', '贝壳T恤', '海魂衫', '领结上衣', '白背心', '贝壳胸衣', '浪花T恤', '浅蓝斗篷', '水手衫'],
      稀有: ['小花T恤', '贝壳泳装', '绳结腰带', '沙滩套装', '贝壳项链', '贝壳短衫', '浪花衬衫', '围巾T恤', '素色T恤'],
      史诗: ['水手服', '薄纱披风', '连帽斗篷', '贝壳T恤', '海魂衫', '领结上衣'],
      传说: ['白背心', '贝壳胸衣', '浪花T恤'],
    },
    emojis: ['👕', '⚓', '🧣', '🧥', '🐚', '👕', '🎀', '🎽', '🐚', '🌊', '🧥', '⚓', '🌸', '👙', '🪢', '🏖️', '📿', '🐚', '🌊', '🧣', '👕', '⚓', '🧣', '🧥', '🐚', '👕', '🎀', '🎽', '🐚', '🌊'],
  },
  accessory: {
    slot: 2,
    prefix: 'acc',
    names: {
      普通: ['船桨', '珍珠贝', '鱼骨', '三叉戟', '灯笼', '水晶剑', '木槌', '鱼竿', '水枪', '海盗旗', '船桨', '珍珠贝'],
      稀有: ['鱼骨', '三叉戟', '灯笼', '水晶剑', '木槌', '鱼竿', '水枪', '海盗旗', '船桨'],
      史诗: ['珍珠贝', '鱼骨', '三叉戟', '灯笼', '水晶剑', '木槌'],
      传说: ['鱼竿', '水枪', '海盗旗'],
    },
    emojis: ['🚣', '🦪', '🐟', '🔱', '🏮', '🗡️', '🔨', '🎣', '🔫', '🏴‍☠️', '🚣', '🦪', '🐟', '🔱', '🏮', '🗡️', '🔨', '🎣', '🔫', '🏴‍☠️', '🚣', '🦪', '🐟', '🔱', '🏮', '🗡️', '🔨', '🎣', '🔫', '🏴‍☠️'],
  },
  pet: {
    slot: 3,
    prefix: 'pet',
    names: {
      普通: ['小海龟', '小鹦鹉', '水母', '白狐', '机械蟹', '海豚', '粉章鱼', '贝壳灵', '海马', '小白兔', '橘猫', '小狗'],
      稀有: ['小蝴蝶', '蘑菇仔', '机器人', '小粉雀', '小灰狼', '小熊猫', '小幽灵', '小冰龙', '粉水母'],
      史诗: ['小蝙蝠', '小树人', '小鲸鱼', '机械鸟', '大耳狐', '水獭'],
      传说: ['机械水母', '小水晶', '小海龟'],
    },
    emojis: ['🐢', '🦜', '🪼', '🦊', '🦀', '🐬', '🐙', '🐚', '🐴', '🐰', '🐱', '🐶', '🦋', '🍄', '🤖', '🐦', '🐺', '🐼', '👻', '🐉', '🪼', '🦇', '🌳', '🐳', '🐦', '🦊', '🦦', '🪼', '💎', '🐢'],
  },
}

function generateCatalog(): CatalogItem[] {
  const items: CatalogItem[] = []
  ;(Object.keys(CATEGORY_CONFIG) as NFTCategory[]).forEach((category) => {
    const cfg = CATEGORY_CONFIG[category]
    let index = 1
    RARITY_ORDER.forEach((rarity) => {
      const count = DISTRIBUTION[rarity]
      const names = cfg.names[rarity]
      for (let i = 0; i < count; i++) {
        const localId = `${cfg.prefix}-${index}`
        const chainId = (cfg.slot + 1) * 1000 + index
        const name = names[i] ?? `${category}-${index}`
        const rarityCfg = RARITY_CONFIG[rarity]
        items.push({
          localId,
          chainId,
          name,
          category,
          slot: cfg.slot,
          rarity,
          rarityChain: RARITY_CHAIN[rarity],
          maxSupply: rarityCfg.maxSupply,
          mintAmount: rarityCfg.mintAmount,
          price: rarityCfg.price,
          emoji: cfg.emojis[(index - 1) % cfg.emojis.length],
          gradient: GRADIENT_POOL[(index - 1) % GRADIENT_POOL.length],
          imageUrl: `/assets/equipment/${cfg.prefix}/${index}.png`,
        })
        index++
      }
    })
  })
  return items
}

export const EQUIPMENT_CATALOG: CatalogItem[] = generateCatalog()

export const ALL_CHAIN_IDS: number[] = EQUIPMENT_CATALOG.map((i) => i.chainId)

export function getPartsByCategory(category: NFTCategory): CatalogItem[] {
  return EQUIPMENT_CATALOG.filter((i) => i.category === category)
}

export function getPartsByRarity(category: NFTCategory, rarity: Rarity): CatalogItem[] {
  return EQUIPMENT_CATALOG.filter((i) => i.category === category && i.rarity === rarity)
}

export function getPartByChainId(chainId: number | bigint): CatalogItem | undefined {
  return EQUIPMENT_CATALOG.find((i) => i.chainId === Number(chainId))
}

export function getPartByLocalId(localId: string): CatalogItem | undefined {
  return EQUIPMENT_CATALOG.find((i) => i.localId === localId)
}

export function toChainParts(): ChainPart[] {
  return EQUIPMENT_CATALOG.map((i) => ({
    id: i.chainId,
    localId: i.localId,
    slot: i.slot,
    name: i.name,
    rarity: i.rarity,
  }))
}

export function toNftLibrary(): NFTItem[] {
  const h = (n: number) => '0x' + n.toString(16).padStart(40, 'ab12cd34ef56').slice(0, 42)
  return EQUIPMENT_CATALOG.map((i) => ({
    id: i.localId,
    name: i.name,
    category: i.category,
    rarity: i.rarity,
    price: i.price,
    emoji: i.emoji,
    gradient: i.gradient,
    owned: false,
    hash: h(i.chainId),
    chain: 'ETH',
    imageUrl: i.imageUrl,
  }))
}

export function getRarityMintAmount(rarity: Rarity): number {
  return RARITY_CONFIG[rarity].mintAmount
}

export function getRarityMaxSupply(rarity: Rarity): number {
  return RARITY_CONFIG[rarity].maxSupply
}
