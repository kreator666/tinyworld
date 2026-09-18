import type { NFTCategory, NFTItem, Rarity } from '../types'
import { getCharacterById } from './characterCatalog'

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
      普通: ['羽毛草帽', '飞行护目镜帽', '海盗头巾', '花环冠', '花环冠', '皮革发带', '白羽王冠', '独眼夜行兜帽', '狐耳发箍', '海浪发带', '珊瑚王冠', '探险家帽'],
      稀有: ['藤蔓花环', '齿轮发饰', '齿轮发饰', '巫师尖帽', '冰晶王冠', '狼头兜帽', '鲜花草帽', '黑曜王冠', '火焰羽冠'],
      史诗: ['潜水头盔', '星月发饰', '图腾发带', '绵羊绒帽', '骑士头盔', '水母帽'],
      传说: ['十字白帽', '雷电发带', '珍珠发箍'],
    },
    emojis: ['👒', '🥽', '🏴‍☠️', '🌸', '🌸', '🪢', '👑', '🥷', '🦊', '🌊', '🪸', '🧭', '🌿', '⚙️', '⚙️', '🧙', '❄️', '🐺', '💐', '🖤', '🔥', '🤿', '🌙', '🪶', '🐑', '🪖', '🪼', '✝️', '⚡', '📿'],
  },
  body: {
    slot: 1,
    prefix: 'body',
    names: {
      普通: ['探险马甲', '水手服', '浪花白袍', '猎手皮甲', '绿林猎装', '兽皮战衣', '星蓝法袍', '海盗装', '冰晶铠甲', '部落图腾', '机芯战甲', '银骑士甲'],
      稀有: ['花叶草裙', '潜水服', '暗影魔甲', '旅人布衣', '白金圣袍', '熔岩战甲', '夜行劲装', '贝壳泳装', '雪原皮裘'],
      史诗: ['遗迹工装', '云朵套装', '雷霆战衣', '蓝汐束衣', '荒岛破衣', '珊瑚甲'],
      传说: ['猎弓装', '星辰法袍', '战术背心'],
    },
    emojis: ['🧭', '⚓', '🌊', '🗡️', '🌿', '🦬', '🔮', '🏴‍☠️', '❄️', '🗿', '⚙️', '🛡️', '🌺', '🤿', '🌑', '👕', '✝️', '🌋', '🥷', '🐚', '🐺', '🏺', '☁️', '⚡', '🎀', '🏝️', '🪸', '🏹', '✨', '🪖'],
  },
  accessory: {
    slot: 2,
    prefix: 'acc',
    names: {
      普通: ['码头帆船', '珊瑚贝礁', '星图罗盘', '海盗船甲板', '遗迹金币', '椰林吊床', '沉船残骸', '海盗酒馆门', '熔岩火山', '冰川水晶', '溪边木桥', '灯塔浮岛'],
      稀有: ['蒸汽齿轮坊', '幽灵船灯', '水果市集', '海底石柱', '骷髅墓地', '花藤瀑布', '极光冰湖', '船舱藏宝室', '沙漠沙漏'],
      史诗: ['贝壳舞台', '暴风雨浪', '热气球港', '环形竞技场', '糖果彩虹岛', '海港栈桥'],
      传说: ['月光水晶坛', '蜜蜂树屋', '黄金宝藏窟'],
    },
    emojis: ['⛵', '🐚', '🧭', '🏴‍☠️', '🏛️', '🌴', '⚓', '🍺', '🌋', '❄️', '🐸', '🕊️', '⚙️', '👻', '🍎', '🪸', '💀', '🌺', '🌌', '🕯️', '⏳', '🎪', '🌊', '🎈', '🏟️', '🍭', '🚢', '🔮', '🐝', '💰'],
  },
  pet: {
    slot: 3,
    prefix: 'pet',
    names: {
      普通: ['彩羽雀', '奶油猫', '小呆狗', '小蛾精', '蘑菇宝', '圆机器人', '火绒雀', '小灰狼', '小熊猫', '小幽灵', '冰晶龙', '小水母'],
      稀有: ['泡泡章鱼', '小蝙蝠', '小树人', '小白鲸', '小白鸽', '大耳狐', '小水獭', '机械水母', '冰晶灵'],
      史诗: ['雪狐', '小螃蟹', '小海豚', '粉章鱼', '贝壳精', '小海马'],
      传说: ['垂耳兔', '小海龟', '彩虹雀'],
    },
    emojis: ['🐦', '🐱', '🐶', '🦋', '🍄', '🤖', '🐥', '🐺', '🐻', '👻', '🐉', '🪼', '🫧', '🦇', '🌱', '🐳', '🕊️', '🦊', '🦦', '⚙️', '💎', '🦊', '🦀', '🐬', '🐙', '🐚', '🐠', '🐰', '🐢', '🐦'],
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

// head/body 的展示信息与铸造工坊保持一致:v4 角色库形象(名称统一为「角色 N」,图片为角色 头/身体 切片)
// 配饰/宠物返回 null,沿用目录自身名称与图片
export function getCharacterDisplay(category: NFTCategory, localId: string): { name: string; imageUrl: string } | null {
  if (category !== 'head' && category !== 'body') return null
  const index = localId.split('-')[1]
  const char = getCharacterById(`character-${index}`)
  return {
    name: `角色 ${index}`,
    imageUrl: char ? (category === 'head' ? char.headUrl : char.bodyUrl) : '',
  }
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

