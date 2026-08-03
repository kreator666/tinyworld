import type { Equipped } from '../types'
import { getPartByLocalId } from '../data/equipmentCatalog'
import {
  BASE_CANVAS,
  BASE_IMAGE,
  DEFAULT_BODY_INDEX,
  SLOT_ANCHORS,
  SLOT_CANVAS,
  type AvatarSlotKey,
} from '../data/avatarConfig'

// 把当前装备的纸娃娃合成为游戏可用的 canvas sprite(穿戴切片制式)
// 输出画布 480x480(2 倍精度), 锚点 = 脚底中心 (240,436),
// 与旧 SVG 版 (120,218)/240 比例一致, 引擎绘制逻辑无需改动
// 切片仅有男性版本, 固定使用男性基底

export interface DollSprites {
  doll: HTMLCanvasElement | null
  pet: HTMLCanvasElement | null
}

const OUT = 480
const FOOT_X = 240
const FOOT_Y = 436
const K = FOOT_Y / BASE_CANVAS.height // 逻辑 512x1024 -> 输出缩放
const GENDER = 'male' as const

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
function drawSlot(c: CanvasRenderingContext2D, img: HTMLImageElement, slot: AvatarSlotKey) {
  const cfg = SLOT_CANVAS[slot]
  const anchor = SLOT_ANCHORS[GENDER][slot]
  const x = FOOT_X + (anchor.offsetX - cfg.width * cfg.anchorX) * K
  const y = FOOT_Y + (anchor.offsetY - cfg.height * cfg.anchorY) * K
  c.drawImage(img, x, y, cfg.width * K, cfg.height * K)
}

export async function buildDollSprites(equipped: Equipped): Promise<DollSprites> {
  // body 套装 = leg + torso 同编号两张; 空槽时显示默认套装(纯显示)
  const bodyId = equipped.body ?? `body-${DEFAULT_BODY_INDEX}`
  const bodyIndex = bodyId.split('-')[1] ?? String(DEFAULT_BODY_INDEX)
  const bodyPart = getPartByLocalId(bodyId)
  const headPart = equipped.head ? getPartByLocalId(equipped.head) : null
  const accPart = equipped.accessory ? getPartByLocalId(equipped.accessory) : null
  const petPart = equipped.pet ? getPartByLocalId(equipped.pet) : null

  const [baseImg, legImg, torsoImg, headImg, accImg, petImg] = await Promise.all([
    loadImage(BASE_IMAGE[GENDER]).catch(() => null),
    loadImage(`/assets/equipment/leg/${bodyIndex}.png`).catch(() => null),
    bodyPart ? loadImage(bodyPart.imageUrl).catch(() => null) : Promise.resolve(null),
    headPart ? loadImage(headPart.imageUrl).catch(() => null) : Promise.resolve(null),
    accPart ? loadImage(accPart.imageUrl).catch(() => null) : Promise.resolve(null),
    petPart ? loadImage(petPart.imageUrl).catch(() => null) : Promise.resolve(null),
  ])

  // 人物本体: acc(背景) → base → leg → body → head(宠物由引擎作为独立跟随者绘制)
  let doll: HTMLCanvasElement | null = null
  if (baseImg) {
    const [canvas, c] = createCanvas()
    if (accImg) {
      const ACC_W = 512
      const ACC_H = 1024
      c.drawImage(
        accImg,
        FOOT_X - (ACC_W / 2) * K,
        FOOT_Y - ACC_H * K,
        ACC_W * K,
        ACC_H * K,
      )
    }
    c.drawImage(
      baseImg,
      FOOT_X - (BASE_CANVAS.width / 2) * K,
      FOOT_Y - BASE_CANVAS.height * K,
      BASE_CANVAS.width * K,
      BASE_CANVAS.height * K,
    )
    if (legImg) drawSlot(c, legImg, 'leg')
    if (torsoImg) drawSlot(c, torsoImg, 'body')
    if (headImg) drawSlot(c, headImg, 'head')
    doll = canvas
  }

  // 宠物单独一张: 底部中心锚点居中放置(独立跟随定位, 不含腰侧偏移)
  let petCanvas: HTMLCanvasElement | null = null
  if (petImg) {
    const [canvas, c] = createCanvas()
    const cfg = SLOT_CANVAS.pet
    c.drawImage(
      petImg,
      FOOT_X - (cfg.width / 2) * K,
      FOOT_Y - cfg.height * K,
      cfg.width * K,
      cfg.height * K,
    )
    petCanvas = canvas
  }

  return { doll, pet: petCanvas }
}
