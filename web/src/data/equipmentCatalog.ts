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
  'from-amber-400 to-orange-500',
  'from-violet-500 to-purple-700',
  'from-sky-300 to-cyan-500',
  'from-rose-400 to-pink-600',
  'from-teal-400 to-emerald-500',
  'from-fuchsia-400 to-rose-500',
  'from-blue-500 to-indigo-600',
  'from-lime-400 to-green-500',
  'from-red-400 to-orange-500',
  'from-slate-500 to-slate-700',
]

const CATEGORY_CONFIG: Record<NFTCategory, { slot: SlotIndex; prefix: string; names: Record<Rarity, string[]>; emojis: string[] }> = {
  head: {
    slot: 0,
    prefix: 'head',
    names: {
      普通: ['棉布贝雷帽', '白色兜帽', '棕色短发', '灰色布帽', '绿色头巾', '草帽', '学者软帽', '毛线帽', '铁盔', '皮帽', '红色发带', '蓝色头巾'],
      稀有: ['猫耳发箍', '星尘短发', '夜行者面罩', '羽毛礼帽', '精灵花冠', '冰霜兜帽', '牛仔帽', '狐狸面具', '海盗眼罩'],
      史诗: ['赛博机甲头盔', '龙角头饰', '虚空面具', '凤凰羽冠', '暗影兜帽', '水晶皇冠'],
      传说: ['永恒之冕', '天使光环', '魔王之角'],
    },
    emojis: ['🎩', '🧢', '💇', '🎓', '🧕', '👒', '🎀', '🪖', '🧣', '🥽', '👑', '🎭', '🐱', '⭐', '🦊', '🏴‍☠️', '🌸', '❄️', '🤠', '🦜', '🤖', '🐉', '👺', '🦅', '🌑', '💎', '🕊️', '😇', '😈', '✨'],
  },
  body: {
    slot: 1,
    prefix: 'body',
    names: {
      普通: ['亚麻布袍', '皮甲背心', '学徒长袍', '粗布衫', '旅行外套', '矿工服', '棉布裙', '锁子甲', '游侠短衣', '白色衬衫', '棕色长裤', '草编围裙'],
      稀有: ['紫晶魔导裙', '游侠皮甲', '暗夜忍者服', '圣职者长袍', '冰霜法袍', '烈焰战甲', '幻影斗篷', '风行者外套', '龙鳞护甲'],
      史诗: ['圣光骑士甲', '暗影刺客装', '星辰法袍', '龙血战甲', '精灵王礼服', '幽灵斗篷'],
      传说: ['创世神装', '虚空龙鳞甲', '炽天使羽翼'],
    },
    emojis: ['👘', '🦺', '🥋', '👕', '🧥', '⛑️', '👗', '⛓️', '🏹', '👔', '👖', '🧤', '🧙', '🏹', '🥷', '⛪', '❄️', '🔥', '👻', '🌪️', '🛡️', '🗡️', '🌟', '🐉', '🧝', '👻', '👼', '🐲', '🕊️', '🌌'],
  },
  accessory: {
    slot: 2,
    prefix: 'acc',
    names: {
      普通: ['麻布披风', '木制盾牌', '铜质徽章', '布腰带', '革制护腕', '棉围巾', '草绳手环', '铁戒指', '皮革背包', '木杖', '陶制护符', '骨制项链'],
      稀有: ['旅人披风', '秘法徽章', '银质护符', '冰霜之环', '火焰纹章', '风之羽饰', '光之护腕', '暗影斗篷', '龙牙项链'],
      史诗: ['手持光剑', '光翼', '龙鳞盾', '星辰权杖', '幻影披风', '圣光十字'],
      传说: ['世界树之枝', '时之沙漏', '空间戒指'],
    },
    emojis: ['🧣', '🛡️', '🎖️', '🎗️', '⚔️', '📿', '🪢', '💍', '🎒', '🪄', '🏺', '🦴', '🦇', '🔮', '🌙', '❄️', '🔥', '🪶', '💫', '🌑', '🗡️', '🪽', '🐲', '✨', '👻', '✝️', '🌳', '⏳', '💠', '🌀'],
  },
  pet: {
    slot: 3,
    prefix: 'pet',
    names: {
      普通: ['小橘猫', '柴犬', '小白兔', '麻雀', '仓鼠', '乌龟', '金鱼', '鹦鹉', '松鼠', '刺猬', '青蛙', '蝴蝶'],
      稀有: ['橘猫年糕', '柴犬阿福', '小火狐', '雪貂', '猫头鹰', '小熊猫', '黑猫露娜', '金毛犬', '玄凤鹦鹉'],
      史诗: ['小飞龙', '独角兽', '凤凰雏鸟', '幽灵狼', '机械鸟', '水精灵'],
      传说: ['星界幼龙', '混沌凤凰', '虚空之灵'],
    },
    emojis: ['🐈', '🐕', '🐇', '🐦', '🐹', '🐢', '🐠', '🦜', '🐿️', '🦔', '🐸', '🦋', '🍊', '🦊', '🔥', '🐾', '🦉', '🐼', '🐈‍⬛', '🐕‍🦺', '🐉', '🦄', '🦅', '🐺', '🤖', '🧜', '🌌', '🔥', '👻', '✨'],
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
  }))
}

export function getRarityMintAmount(rarity: Rarity): number {
  return RARITY_CONFIG[rarity].mintAmount
}

export function getRarityMaxSupply(rarity: Rarity): number {
  return RARITY_CONFIG[rarity].maxSupply
}
