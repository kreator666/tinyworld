import type { Equipped } from '../types'
import { getCharacterById, characterIdFromLocalId } from '../data/characterCatalog'

// 像素小屋:把立绘素材(头.png + 身体.png,与 PaperDoll 同一套角色映射)实时像素化成
// 64x64 的电子宠物式小人。目标是"像素游戏立绘"风格:大平色块 + 清晰轮廓,不抖动。
// 管线:众数采样(4bit 量化投票,忽略 alpha<100 的边缘像素)→ popularity 32 色调色板
// (含稀有色保护名额,保住瞳色等小面积高饱和色)→ 最近色映射(无抖动)→ 3x3 众数滤波清杂点
// 展示时由调用方放大绘制并关闭平滑(见 drawPixelDoll)
// 按 头角色|体角色 组合缓存,换装后同组合直接命中,异组合重新合成;
// accessory/pet 槽不参与像素小人(素材是全身立绘制式,无独立宠物切片)

export const PIXEL_SIZE = 64

// 调色板色数(比 24 多留几档给渐变层次)
const PALETTE_COLORS = 32
// 投票/调色板统一的量化位数:4bit/通道(16 级),避免 5bit 时相近色分裂导致平色区斑驳
const QBITS = 4
const QSHIFT = 8 - QBITS
const QMASK = (1 << QBITS) - 1
// 采样时忽略的半透明边缘阈值(抗锯齿边缘不参与颜色投票,保证轮廓干净)
const MIN_ALPHA = 100
// 稀有色保护名额:popularity 前 N-RESERVE 名按频次取,剩余名额给高饱和稀有色(瞳色/饰品)
const RESERVE_RARE = 4

// 12bit 量化色 <-> [r,g,b](桶中值)
function quantKey(r: number, g: number, b: number): number {
  return ((r >> QSHIFT) << (QBITS * 2)) | ((g >> QSHIFT) << QBITS) | (b >> QSHIFT)
}
function keyRGB(key: number): [number, number, number] {
  return [((key >> (QBITS * 2)) & QMASK) << QSHIFT | (1 << (QSHIFT - 1)),
    ((key >> QBITS) & QMASK) << QSHIFT | (1 << (QSHIFT - 1)),
    (key & QMASK) << QSHIFT | (1 << (QSHIFT - 1))]
}

// 图片加载缓存
const imageCache = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(src)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    })
    imageCache.set(src, p)
  }
  return p
}

// 缓存 key:头角色|体角色(accessory/pet 槽不影响像素小人)
function equippedKey(equipped: Equipped): string {
  return `${characterIdFromLocalId(equipped.head)}|${characterIdFromLocalId(equipped.body)}`
}

// 按 PaperDoll 的拼接关系合成立绘:宽 512,head 在 y=0,body 底部与画布底边齐平(脚底=底边)
async function composeDollCanvas(equipped: Equipped): Promise<HTMLCanvasElement | null> {
  const head = getCharacterById(characterIdFromLocalId(equipped.head))
  const body = getCharacterById(characterIdFromLocalId(equipped.body))
  if (!head || !body) return null
  const [headImg, bodyImg] = await Promise.all([loadImage(head.headUrl), loadImage(body.bodyUrl)])
  if (!headImg || !bodyImg) return null
  const canvas = document.createElement('canvas')
  canvas.width = headImg.width
  canvas.height = headImg.height + bodyImg.height - 1 // overlap=1,与 PaperDoll 一致
  const c = canvas.getContext('2d')!
  c.drawImage(headImg, 0, 0)
  c.drawImage(bodyImg, 0, headImg.height - 1)
  return canvas
}

// 扫描不透明像素求内容包围盒(像素化时整个包围盒映射到 64x64,脚底自然贴底边)
function findContentBox(src: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const w = src.width
  const h = src.height
  const data = src.getContext('2d')!.getImageData(0, 0, w, h).data
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

// 亮度(感知加权),细节保护与滤波用
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

// 众数采样:包围盒区域划分成 PIXEL_SIZE x PIXEL_SIZE 个格子,每格取众数色
// 投票前量化到 4bit/通道;alpha < MIN_ALPHA 的抗锯齿边缘像素不参与投票,避免轮廓杂色
// 细节保护:大眼睛/描边等小面积深色特征在格内通常是少数派(25%~55%)会被众数抹掉,
// 若胜者偏亮且格内存在"占比 >=28% 且亮度不足胜者一半"的深色候选,则改用该深色(像素风粗描边/大眼)
function modeSample(src: ImageData): Uint8ClampedArray {
  const { width: sw, height: sh, data: sd } = src
  const out = new Uint8ClampedArray(PIXEL_SIZE * PIXEL_SIZE * 4)
  for (let py = 0; py < PIXEL_SIZE; py++) {
    const y0 = Math.floor((py * sh) / PIXEL_SIZE)
    const y1 = Math.max(y0 + 1, Math.floor(((py + 1) * sh) / PIXEL_SIZE))
    for (let px = 0; px < PIXEL_SIZE; px++) {
      const x0 = Math.floor((px * sw) / PIXEL_SIZE)
      const x1 = Math.max(x0 + 1, Math.floor(((px + 1) * sw) / PIXEL_SIZE))
      const counts = new Map<number, number>()
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4
          if (sd[i + 3] < MIN_ALPHA) continue
          const key = quantKey(sd[i], sd[i + 1], sd[i + 2])
          counts.set(key, (counts.get(key) ?? 0) + 1)
          total++
        }
      }
      const o = (py * PIXEL_SIZE + px) * 4
      if (total === 0) continue // 全透明背景格保持透明
      let best = -1
      let bestN = -1
      counts.forEach((n, key) => {
        if (n > bestN) {
          bestN = n
          best = key
        }
      })
      if (bestN / total < 0.55) {
        const [wr, wg, wb] = keyRGB(best)
        const wl = luminance(wr, wg, wb)
        if (wl > 140) {
          let dark = -1
          let darkN = 0
          counts.forEach((n, key) => {
            if (n < total * 0.28 || n >= bestN) return
            const [r, g, b] = keyRGB(key)
            if (luminance(r, g, b) < Math.min(wl * 0.5, 110) && n > darkN) {
              dark = key
              darkN = n
            }
          })
          if (dark >= 0) best = dark
        }
      }
      const [r, g, b] = keyRGB(best)
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = 255
    }
  }
  return out
}

// 调色板量化:popularity 取频次最高的量化色,但纯 popularity 会丢掉瞳色/饰品色等
// 面积小却高饱和的关键色,因此前 PALETTE_COLORS-RESERVE_RARE 名按频次取,
// 剩余名额强制给"与现有调色板差异大且饱和度高"的稀有色;无抖动,逐像素取最近色
function quantizeToPalette(pixels: Uint8ClampedArray) {
  const freq = new Map<number, number>()
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue
    const key = quantKey(pixels[i], pixels[i + 1], pixels[i + 2])
    freq.set(key, (freq.get(key) ?? 0) + 1)
  }
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1])
  const keys: number[] = ranked.slice(0, Math.max(PALETTE_COLORS - RESERVE_RARE, 0)).map(([k]) => k)
  // 稀有色候选:饱和度高,且与已选调色板的最小距离足够大
  for (const [key] of ranked.slice(keys.length)) {
    if (keys.length >= PALETTE_COLORS) break
    const [r, g, b] = keyRGB(key)
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    if (sat < 48) continue
    const minD = Math.min(...keys.map((k2) => {
      const [r2, g2, b2] = keyRGB(k2)
      return (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2
    }))
    if (minD > 90 ** 2) keys.push(key)
  }
  // 名额没用完则用频次顺序补齐
  for (const [key] of ranked) {
    if (keys.length >= PALETTE_COLORS) break
    if (!keys.includes(key)) keys.push(key)
  }
  const palette = keys.map(keyRGB)
  if (palette.length === 0) return
  for (let p = 0; p < PIXEL_SIZE * PIXEL_SIZE; p++) {
    const i = p * 4
    if (pixels[i + 3] === 0) continue
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < palette.length; k++) {
      const dr = pixels[i] - palette[k][0]
      const dg = pixels[i + 1] - palette[k][1]
      const db = pixels[i + 2] - palette[k][2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    pixels[i] = palette[best][0]
    pixels[i + 1] = palette[best][1]
    pixels[i + 2] = palette[best][2]
  }
}

// 3x3 众数滤波(温和版):只清理"孤立单点杂色"——中心色在 3x3 内只出现 1 次
// 且某邻居色出现 >=4 次才替换;透明侵蚀也收紧到 7/9 票,保住 1~2px 的眼睛等细节
function majorityFilter(pixels: Uint8ClampedArray) {
  const src = new Uint8ClampedArray(pixels)
  const colorAt = (i: number) => quantKey(src[i], src[i + 1], src[i + 2])
  for (let py = 0; py < PIXEL_SIZE; py++) {
    for (let px = 0; px < PIXEL_SIZE; px++) {
      const o = (py * PIXEL_SIZE + px) * 4
      const centerT = src[o + 3] === 0
      const counts = new Map<number, number>()
      let tCount = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = py + dy
          const nx = px + dx
          if (ny < 0 || ny >= PIXEL_SIZE || nx < 0 || nx >= PIXEL_SIZE) continue
          const i = (ny * PIXEL_SIZE + nx) * 4
          if (src[i + 3] === 0) {
            tCount++
            continue
          }
          const key = colorAt(i)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      if (centerT) {
        // 透明中心只在几乎被不透明包围时补色(填小孔),否则保持透明
        if (tCount <= 3) {
          let best = -1
          let bestN = -1
          counts.forEach((n, key) => {
            if (n > bestN) {
              bestN = n
              best = key
            }
          })
          if (best >= 0) {
            const [r, g, b] = keyRGB(best)
            pixels[o] = r
            pixels[o + 1] = g
            pixels[o + 2] = b
            pixels[o + 3] = 255
          }
        }
        continue
      }
      if (tCount >= 7) {
        pixels[o + 3] = 0 // 几乎全是透明 -> 透明
        continue
      }
      const centerKey = colorAt(o)
      if ((counts.get(centerKey) ?? 0) > 1) continue // 中心色有同伴,保留(护细节)
      let best = -1
      let bestN = -1
      counts.forEach((n, key) => {
        if (n > bestN) {
          bestN = n
          best = key
        }
      })
      if (bestN >= 4 && best !== centerKey) {
        const [r, g, b] = keyRGB(best)
        pixels[o] = r
        pixels[o + 1] = g
        pixels[o + 2] = b
      }
    }
  }
}

const pixelCache = new Map<string, Promise<HTMLCanvasElement | null>>()

// 获取装备对应的 64x64 像素小人(采样 + 调色板 + 滤波均为缓存内一次性计算)
// 合成失败(立绘图缺失)返回 null,由调用方兜底
export function getPixelDoll(equipped: Equipped): Promise<HTMLCanvasElement | null> {
  const key = equippedKey(equipped)
  let p = pixelCache.get(key)
  if (!p) {
    p = (async () => {
      const doll = await composeDollCanvas(equipped)
      if (!doll) return null
      const box = findContentBox(doll)
      const src = doll.getContext('2d')!.getImageData(box.x, box.y, box.w, box.h)
      const pixels = modeSample(src)
      quantizeToPalette(pixels)
      majorityFilter(pixels)
      const out = document.createElement('canvas')
      out.width = PIXEL_SIZE
      out.height = PIXEL_SIZE
      const outCtx = out.getContext('2d')!
      outCtx.putImageData(new ImageData(pixels, PIXEL_SIZE, PIXEL_SIZE), 0, 0)
      return out
    })()
    pixelCache.set(key, p)
  }
  return p
}

// 把 64x64 像素画放大绘制到目标矩形(关闭平滑保持像素风);flip=true 时水平翻转
export function drawPixelDoll(
  c: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  flip = false,
) {
  c.save()
  c.imageSmoothingEnabled = false
  if (flip) {
    c.translate(dx + dw, dy)
    c.scale(-1, 1)
    c.drawImage(sprite, 0, 0, dw, dh)
  } else {
    c.drawImage(sprite, dx, dy, dw, dh)
  }
  c.restore()
}
