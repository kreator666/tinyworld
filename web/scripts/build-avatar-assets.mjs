/**
 * 纸娃娃素材预处理管线(依据 prototype/v2/design.md)
 *
 * 输入: prototype/素材/{人物,装备/{头部,身体,手持,宠物}} 下的白底单物品 PNG
 * 处理: 白底洪水填充抠图 -> 去除右下角"豆包AI生成"水印连通域 -> 透明裁剪
 *       -> 按 design.md 标准画布与锚点规范化 -> 填充缺口到每类 30 件
 * 输出:
 *   web/public/assets/avatar/base_male.png / base_female.png  (512x1024)
 *   web/public/assets/equipment/{head,body,acc,pet}/{1..30}.png
 *   web/src/data/avatarConfig.ts  (各插槽锚点偏移配置, male/female)
 *   prototype/素材/_preview/*.png (调试用合成预览, 不入库可删)
 *
 * 运行: node web/scripts/build-avatar-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'prototype/素材')
const OUT = path.resolve(ROOT, 'web/public/assets')
const PREVIEW = path.join(SRC, '_preview')

// 处理前先把源图最长边缩到该尺寸, 加速抠图(最终画布仅 512, 无质量损失)
const WORK_SIZE = 1024
// 白底判定阈值(与参考色的 RGB 曼哈顿距离)
const BG_THRESHOLD = 42
// 水印区域(归一化坐标): 完全落在该区域的连通域视为水印丢弃
const WATERMARK = { x: 0.72, y: 0.9 }
// 前景蒙版腐蚀像素, 去白边
const ERODE = 1

// ---------------------------------------------------------------
// 插槽定义: 标准画布 / 锚点 / 适配盒(素材缩放后不超过的尺寸)
// anchor 为素材在自身画布中的对齐点, 运行时 Sprite anchor 与之对应
// ---------------------------------------------------------------
const CATEGORIES = {
  head: {
    dir: '装备/头部',
    out: 'head',
    canvas: [512, 512],
    anchor: [0.5, 1], // 底部中心
    fit: [340, 360],
    count: 30,
  },
  body: {
    dir: '装备/身体',
    out: 'body',
    canvas: [512, 1024],
    anchor: [0.5, 0], // 顶部中心
    fit: [400, 620],
    count: 30,
  },
  acc: {
    dir: '装备/手持',
    out: 'acc',
    canvas: [512, 512],
    anchor: [0.5, 0.5], // 几何中心
    fit: [260, 340],
    count: 30,
  },
  pet: {
    dir: '装备/宠物',
    out: 'pet',
    canvas: [512, 512],
    anchor: [0.5, 1], // 底部中心(站地面)
    fit: [280, 360],
    count: 30,
  },
}

// ---------------------------------------------------------------
// 基底 512x1024 画布上的插槽锚点(原点=脚底中心, y 向上为负)
// 通过 _preview 合成图校准
// ---------------------------------------------------------------
const SLOT_ANCHORS = {
  male: {
    head: { offsetX: 0, offsetY: -770 },
    body: { offsetX: 0, offsetY: -690 },
    acc: { offsetX: -130, offsetY: -430 },
    pet: { offsetX: 120, offsetY: 0 },
  },
  female: {
    head: { offsetX: 0, offsetY: -770 },
    body: { offsetX: 0, offsetY: -690 },
    acc: { offsetX: -130, offsetY: -430 },
    pet: { offsetX: 120, offsetY: 0 },
  },
}

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true })

function colorDist(d, i, r, g, b) {
  return Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b)
}

/**
 * 抠图 + 去水印 + 裁剪, 返回 { buffer(RGBA png), width, height }
 * 背景判定: 与边缘参考色(白底)色距 ≤ threshold 且与边缘连通
 * (物品内部的白色区域不与边缘连通, 得以保留)
 */
async function cutout(src, threshold = BG_THRESHOLD) {
  const img = sharp(src).resize(WORK_SIZE, WORK_SIZE, { fit: 'inside' })
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const ch = info.channels // 3 or 4

  // 0) 边缘参考色: 取四条边所有像素的中位数
  const edgePixels = []
  for (let x = 0; x < width; x += 4) {
    for (const y of [0, height - 1]) edgePixels.push(y * width + x)
  }
  for (let y = 0; y < height; y += 4) {
    for (const x of [0, width - 1]) edgePixels.push(y * width + x)
  }
  const median = (vals) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)]
  const refR = median(edgePixels.map((i) => data[i * ch]))
  const refG = median(edgePixels.map((i) => data[i * ch + 1]))
  const refB = median(edgePixels.map((i) => data[i * ch + 2]))

  // 1) 边缘洪水填充标记背景(全程以边缘参考色为基准)
  const bg = new Uint8Array(width * height)
  const queue = []
  const visit = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = y * width + x
    if (bg[i]) return
    if (colorDist(data, i * ch, refR, refG, refB) > threshold) return
    bg[i] = 1
    queue.push(x, y)
  }
  for (let x = 0; x < width; x++) {
    visit(x, 0)
    visit(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    visit(0, y)
    visit(width - 1, y)
  }
  while (queue.length) {
    const y = queue.pop()
    const x = queue.pop()
    visit(x + 1, y)
    visit(x - 1, y)
    visit(x, y + 1)
    visit(x, y - 1)
  }

  // 2) 前景蒙版 + 腐蚀去白边
  let fg = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) fg[i] = bg[i] ? 0 : 1
  for (let e = 0; e < ERODE; e++) {
    const next = new Uint8Array(width * height)
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x
        if (fg[i] && fg[i - 1] && fg[i + 1] && fg[i - width] && fg[i + width]) next[i] = 1
      }
    }
    fg = next
  }

  // 3) 连通域: 丢弃水印区与噪点, 取并集 bbox
  const label = new Int32Array(width * height).fill(-1)
  const comps = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * width + x
      if (!fg[si] || label[si] !== -1) continue
      const id = comps.length
      const c = { minX: x, maxX: x, minY: y, maxY: y, area: 0 }
      const q = [x, y]
      label[si] = id
      while (q.length) {
        const cy = q.pop()
        const cx = q.pop()
        c.area++
        if (cx < c.minX) c.minX = cx
        if (cx > c.maxX) c.maxX = cx
        if (cy < c.minY) c.minY = cy
        if (cy > c.maxY) c.maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const ni = ny * width + nx
          if (fg[ni] && label[ni] === -1) {
            label[ni] = id
            q.push(nx, ny)
          }
        }
      }
      comps.push(c)
    }
  }
  if (!comps.length) throw new Error(`未检测到前景: ${src}`)
  const maxArea = Math.max(...comps.map((c) => c.area))
  const keep = new Set()
  comps.forEach((c, i) => {
    const inWatermark =
      c.minX >= WATERMARK.x * width && c.minY >= WATERMARK.y * height
    if (inWatermark) return
    if (c.area < maxArea * 0.005) return // 噪点
    keep.add(i)
  })
  if (!keep.size) {
    throw new Error(`前景被水印/噪点规则清空: ${src} (comps=${comps.length}, maxArea=${maxArea})`)
  }

  // 4) 生成 RGBA: 仅保留 keep 连通域, 其余透明
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const p = i * 4
    const s = i * ch
    rgba[p] = data[s]
    rgba[p + 1] = data[s + 1]
    rgba[p + 2] = data[s + 2]
    rgba[p + 3] = label[i] !== -1 && keep.has(label[i]) ? 255 : 0
  }

  let minX = width, minY = height, maxX = 0, maxY = 0
  comps.forEach((c, i) => {
    if (!keep.has(i)) return
    if (c.minX < minX) minX = c.minX
    if (c.minY < minY) minY = c.minY
    if (c.maxX > maxX) maxX = c.maxX
    if (c.maxY > maxY) maxY = c.maxY
  })
  const pad = 4
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  const w = maxX - minX + 1
  const h = maxY - minY + 1

  const buffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: w, height: h })
    .png()
    .toBuffer()
  return { buffer, width: w, height: h }
}

/**
 * 透明底素材按插槽规范放置到标准画布
 */
async function normalize(cut, { canvas, anchor, fit }) {
  const [cw, chh] = canvas
  const [fw, fh] = fit
  const scale = Math.min(fw / cut.width, fh / cut.height, 1)
  const w = Math.max(1, Math.round(cut.width * scale))
  const h = Math.max(1, Math.round(cut.height * scale))
  const resized = await sharp(cut.buffer).resize(w, h).png().toBuffer()
  // 锚点对齐: 素材的 anchor 点落在画布同一 anchor 点上
  const left = Math.round(cw * anchor[0] - w * anchor[0])
  const top = Math.round(chh * anchor[1] - h * anchor[1])
  return sharp({ create: { width: cw, height: chh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer()
}

/**
 * 基底人物: 高度缩放到画布的 88%(头顶预留约 12%), 脚底贴底, 水平居中
 */
async function normalizeBase(cut) {
  const cw = 512
  const chh = 1024
  const targetH = Math.round(chh * 0.88)
  const scale = targetH / cut.height
  const w = Math.max(1, Math.round(cut.width * scale))
  const resized = await sharp(cut.buffer).resize(w, targetH).png().toBuffer()
  const left = Math.round((cw - w) / 2)
  const top = chh - targetH
  return sharp({ create: { width: cw, height: chh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer()
}

/** 源文件排序: 无编号文件排最前, 其余按 (N) 编号升序 */
function sortSources(files) {
  const num = (f) => {
    const m = f.match(/\((\d+)\)/)
    return m ? parseInt(m[1], 10) : -1
  }
  return [...files].sort((a, b) => {
    // head1.png 这类无括号命名视为 0 号, 排在无编号文件之后
    const na = num(a)
    const nb = num(b)
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  })
}

async function main() {
  ensure(PREVIEW)
  ensure(path.join(OUT, 'avatar'))

  // ---------- 基底人物 ----------
  for (const [key, file] of [['male', 'base_male.png'], ['female', 'base_female.png']]) {
    const cut = await cutout(path.join(SRC, '人物', file))
    const buf = await normalizeBase(cut)
    fs.writeFileSync(path.join(OUT, 'avatar', `base_${key}.png`), buf)
    console.log(`base_${key}: ${cut.width}x${cut.height} -> 512x1024`)
  }

  // ---------- 装备 ----------
  for (const [slot, cfg] of Object.entries(CATEGORIES)) {
    const dir = path.join(SRC, cfg.dir)
    const files = sortSources(fs.readdirSync(dir).filter((f) => f.endsWith('.png')))
    const outDir = path.join(OUT, 'equipment', cfg.out)
    ensure(outDir)
    const normalized = []
    for (const f of files) {
      const cut = await cutout(path.join(dir, f))
      normalized.push(await normalize(cut, cfg))
    }
    console.log(`${slot}: 处理 ${files.length} 张源图`)
    // 填充缺口到 cfg.count(循环复用)
    for (let i = 0; i < cfg.count; i++) {
      const buf = normalized[i % normalized.length]
      fs.writeFileSync(path.join(outDir, `${i + 1}.png`), buf)
    }
    if (normalized.length < cfg.count) {
      console.log(`  ${slot}: 仅 ${normalized.length} 件, 复用填充到 ${cfg.count}`)
    }
  }

  // ---------- avatarConfig.ts ----------
  const ts = `// 本文件由 web/scripts/build-avatar-assets.mjs 自动生成, 请勿手改
// 坐标系: 基底画布 512x1024, 原点 = 脚底中心, y 向上为负
// 各插槽素材画布锚点见 prototype/v2/design.md §2.3
export type AvatarGender = 'male' | 'female'
export type AvatarSlotKey = 'head' | 'body' | 'acc' | 'pet'

export interface SlotAnchor {
  offsetX: number
  offsetY: number
}

export const BASE_CANVAS = { width: 512, height: 1024 } as const

export const SLOT_CANVAS: Record<AvatarSlotKey, { width: number; height: number; anchorX: number; anchorY: number }> = {
  head: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
  body: { width: 512, height: 1024, anchorX: 0.5, anchorY: 0 },
  acc: { width: 512, height: 512, anchorX: 0.5, anchorY: 0.5 },
  pet: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
}

export const SLOT_ANCHORS: Record<AvatarGender, Record<AvatarSlotKey, SlotAnchor>> = ${JSON.stringify(SLOT_ANCHORS, null, 2)}

export const BASE_IMAGE: Record<AvatarGender, string> = {
  male: '/assets/avatar/base_male.png',
  female: '/assets/avatar/base_female.png',
}
`
  fs.writeFileSync(path.resolve(ROOT, 'web/src/data/avatarConfig.ts'), ts)

  // ---------- 调试合成预览(多套组合) ----------
  for (const combo of [1, 5, 12, 20]) {
    const base = await sharp(path.join(OUT, 'avatar', 'base_male.png')).png().toBuffer()
    const layers = [{ input: base, left: 0, top: 0 }]
    const A = SLOT_ANCHORS.male
    const C = CATEGORIES
    const place = (slot, idx) => {
      const cfg = C[slot]
      const a = A[slot]
      // 素材画布 anchor 点对准基底锚点(基底原点=脚底中心=(256,1024))
      const px = 256 + a.offsetX - cfg.canvas[0] * cfg.anchor[0]
      const py = 1024 + a.offsetY - cfg.canvas[1] * cfg.anchor[1]
      layers.push({
        input: fs.readFileSync(path.join(OUT, 'equipment', cfg.out, `${idx}.png`)),
        left: Math.round(px),
        top: Math.round(py),
      })
    }
    // Z 序: body(1) -> head(2) -> acc(3) -> pet(4)
    place('body', combo)
    place('head', combo)
    place('acc', combo)
    place('pet', combo)
    await sharp({ create: { width: 512, height: 1024, channels: 4, background: { r: 240, g: 240, b: 245, alpha: 1 } } })
      .composite(layers)
      .png()
      .toFile(path.join(PREVIEW, `composite_male_${combo}.png`))
  }
  console.log(`preview: ${PREVIEW}/composite_male_{1,5,12,20}.png`)
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
