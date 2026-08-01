import type { Equipped, NFTCategory } from '../types'
import { getPartByLocalId } from '../data/equipmentCatalog'
import {
  BASE_CANVAS,
  BASE_IMAGE,
  SLOT_ANCHORS,
  SLOT_CANVAS,
  type AvatarGender,
  type AvatarSlotKey,
} from '../data/avatarConfig'

// 把当前装备的纸娃娃合成为游戏可用的 canvas sprite
// 输出画布 480x480(2 倍精度), 锚点 = 脚底中心 (240,436),
// 与旧 SVG 版 (120,218)/240 比例一致, 引擎绘制逻辑无需改动

export interface DollSprites {
  doll: HTMLCanvasElement | null
  pet: HTMLCanvasElement | null
}

const OUT = 480
const FOOT_X = 240
const FOOT_Y = 436
const K = FOOT_Y / BASE_CANVAS.height // 逻辑 512x1024 -> 输出缩放

const CATEGORY_TO_SLOT: Record<NFTCategory, AvatarSlotKey> = {
  head: 'head',
  body: 'body',
  accessory: 'acc',
  pet: 'pet',
}

// 图片加载缓存
const imageCache = new Map<string, Promise<HTMLImageElement>>()

function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`sprite 加载失败: ${src}`))
      img.src = src
    })
    imageCache.set(src, p)
  }
  return p
}

function createCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = OUT
  canvas.height = OUT
  return [canvas, canvas.getContext('2d')!]
}

// 按插槽配置把素材画布绘制到输出画布(锚点对齐, 逻辑原点 = 脚底中心)
function drawSlot(
  c: CanvasRenderingContext2D,
  img: HTMLImageElement,
  slot: AvatarSlotKey,
  gender: AvatarGender,
) {
  const cfg = SLOT_CANVAS[slot]
  const anchor = SLOT_ANCHORS[gender][slot]
  const x = FOOT_X + (anchor.offsetX - cfg.width * cfg.anchorX) * K
  const y = FOOT_Y + (anchor.offsetY - cfg.height * cfg.anchorY) * K
  c.drawImage(img, x, y, cfg.width * K, cfg.height * K)
}

async function loadSlotImage(equipped: Equipped, category: NFTCategory) {
  const localId = equipped[category]
  if (!localId) return null
  const part = getPartByLocalId(localId)
  if (!part) return null
  const img = await loadImage(part.imageUrl).catch(() => null)
  return img ? { img, slot: CATEGORY_TO_SLOT[category] } : null
}

export async function buildDollSprites(
  equipped: Equipped,
  gender: AvatarGender = 'male',
): Promise<DollSprites> {
  const [baseImg, body, head, acc, pet] = await Promise.all([
    loadImage(BASE_IMAGE[gender]).catch(() => null),
    loadSlotImage(equipped, 'body'),
    loadSlotImage(equipped, 'head'),
    loadSlotImage(equipped, 'accessory'),
    loadSlotImage(equipped, 'pet'),
  ])

  // 人物本体: base → body → head → acc(宠物由引擎作为独立跟随者绘制)
  let doll: HTMLCanvasElement | null = null
  if (baseImg) {
    const [canvas, c] = createCanvas()
    c.drawImage(
      baseImg,
      FOOT_X - (BASE_CANVAS.width / 2) * K,
      FOOT_Y - BASE_CANVAS.height * K,
      BASE_CANVAS.width * K,
      BASE_CANVAS.height * K,
    )
    for (const layer of [body, head, acc]) {
      if (layer) drawSlot(c, layer.img, layer.slot, gender)
    }
    doll = canvas
  }

  // 宠物单独一张: 底部中心锚点居中放置(独立跟随定位, 不含腰侧偏移)
  let petCanvas: HTMLCanvasElement | null = null
  if (pet) {
    const [canvas, c] = createCanvas()
    const cfg = SLOT_CANVAS.pet
    c.drawImage(
      pet.img,
      FOOT_X - (cfg.width / 2) * K,
      FOOT_Y - cfg.height * K,
      cfg.width * K,
      cfg.height * K,
    )
    petCanvas = canvas
  }

  return { doll, pet: petCanvas }
}
