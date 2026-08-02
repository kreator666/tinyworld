/**
 * 纸娃娃素材预处理管线(穿戴切片制式, 依据 prototype/v2/design.md 画布规范)
 *
 * 输入(prototype/素材/):
 *   人物/base_male.png, base_female.png  无装备素体(白底 RGB)
 *   装备/头部/head_slice_*.png           脸+头饰切片(RGBA, 与素体同比例)
 *   装备/身体/torso_slice_*.png          躯干+衣服切片
 *   装备/腿/leg_slice_*.png              腿+裤靴切片(与 torso 同编号配成套装)
 *   装备/手持/acc_slice_*.png            手+武器切片
 *   装备/宠物/*.png                      独立宠物(白底, 旧制式沿用)
 *
 * 对齐规则(在素体归一化后的 512x1024 画布坐标系, 切片随基底同系数缩放):
 *   head  -> 切片肤色(脸)质心 对齐 素体脸部中心
 *   torso -> 切片顶部中心     对齐 素体颈部点
 *   leg   -> 切片底部中心     对齐 素体脚底中心
 *   acc   -> 切片肤色(拳)质心 对齐 素体手部点
 * 所有切片放置到与基底相同的 512x1024 透明画布, 运行时原点位叠放, offset 全 0。
 *
 * 输出:
 *   web/public/assets/avatar/base_male.png / base_female.png
 *   web/public/assets/equipment/{head,body,leg,acc,pet}/{1..30}.png
 *   web/src/data/avatarConfig.ts
 *   prototype/素材/_preview/composite_*.png (调试合成预览)
 *
 * 运行: npm run build:assets
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

const CW = 512
const CH = 1024
const BASE_FILL = 0.86 // 基底身高占画布比例(头顶留 14% 给帽子)
const BG_THRESHOLD = 42
const ERODE = 1
const WATERMARK = { x: 0.72, y: 0.9 }
const PET_FIT = [150, 220]
const PET_ANCHOR = { offsetX: 150, offsetY: 0 } // 脚边地面点
const DEFAULT_BODY_INDEX = 1 // body 空槽时的默认套装(纯显示)
// 各插槽缩放校准系数(在目测量测比的基础上, 按合成预览效果校准)
const SCALE_CALIB = { head: 1.0, body: 1.05, leg: 1.45, acc: 0.9 }
// 身体切片对齐后的整体上移量(画布像素, 负值向上)
const TORSO_SHIFT_Y = -150
// 头部切片: 全槽统一缩放比(取中位数, 消除大小不一致) + 上移量(画布像素)
const HEAD_UNIFIED_SCALE = true
const HEAD_SHIFT_Y = -30
// 腿部切片纵向: 精确匹配素体腿长并上探(原生像素), 让裤腰塞进上衣下摆消除腰部缝隙
const LEG_OVERLAP = 45
// 素体颈部以下纵向压缩比: 原素体四肢过长, 与切片人物的 Q 版比例不匹配,
// 压缩颈下区域(脸部不变形)使素体比例接近切片人物
const BODY_SQUASH = 0.85
const SQUASH_SEAM = 0.45 // 压缩接缝位置(颈部, 占图高比例)

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true })

function colorDist(d, i, r, g, b) {
  return Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b)
}

// ---------------------------------------------------------------
// 白底抠图(素体/宠物用): 边缘参考色 + 连通性, 去水印连通域, 裁剪
// 返回 { buffer(RGBA png), width, height, data, info } data 为裁剪前 RGBA 像素
// ---------------------------------------------------------------
async function cutout(src, { watermark = true } = {}) {
  const img = sharp(src).resize(1024, 1024, { fit: 'inside' })
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const ch = info.channels

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

  const bg = new Uint8Array(width * height)
  const queue = []
  const visit = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = y * width + x
    if (bg[i]) return
    if (colorDist(data, i * ch, refR, refG, refB) > BG_THRESHOLD) return
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
    if (watermark && c.minX >= WATERMARK.x * width && c.minY >= WATERMARK.y * height) return
    if (c.area < maxArea * 0.005) return
    keep.add(i)
  })
  if (!keep.size) throw new Error(`前景被规则清空: ${src}`)

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
  const pad = 2
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

// ---------------------------------------------------------------
// 素体 landmarks: 在抠图后的 RGBA 图上测量(原生尺寸坐标)
// ---------------------------------------------------------------
async function measureBase(buffer, width, height) {
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true })
  // 肤色参考: 胸口区域(y 42%-55%, x 42%-58%)中位色(素体无衣, 必为皮肤)
  const samples = []
  for (let y = Math.floor(height * 0.42); y < height * 0.55; y++) {
    for (let x = Math.floor(width * 0.42); x < width * 0.58; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] > 200) samples.push([data[i], data[i + 1], data[i + 2]])
    }
  }
  const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  const skin = [med(0), med(1), med(2)]
  const skinAt = (x, y) => {
    const i = (y * width + x) * 4
    if (data[i + 3] < 128) return false
    return colorDist(data, i, skin[0], skin[1], skin[2]) <= 70
  }

  // 颈部点: y < 45%h 肤色像素的最大 y(下巴/颈底), x 取该行肤色中点
  let neckY = 0
  for (let y = Math.floor(height * 0.45); y > 0; y--) {
    let cnt = 0
    for (let x = 0; x < width; x++) if (skinAt(x, y)) cnt++
    if (cnt >= 3) {
      neckY = y
      break
    }
  }
  let nx0 = width, nx1 = 0
  for (let x = 0; x < width; x++) {
    if (skinAt(x, neckY)) {
      if (x < nx0) nx0 = x
      if (x > nx1) nx1 = x
    }
  }
  const neck = { x: (nx0 + nx1) / 2, y: neckY }

  // 手部点/拳宽: y 60%-78%h 且 x < 25%w 的肤色簇(左臂+拳), 取簇的最低部分(拳头)
  const cluster = []
  for (let y = Math.floor(height * 0.6); y < height * 0.78; y++) {
    for (let x = 0; x < width * 0.25; x++) {
      if (skinAt(x, y)) cluster.push([x, y])
    }
  }
  let hand = { x: width * 0.15, y: height * 0.7 }
  let fistW = Math.round(width * 0.06)
  if (cluster.length) {
    const maxY = Math.max(...cluster.map((p) => p[1]))
    const fist = cluster.filter((p) => p[1] >= maxY - height * 0.06)
    hand = {
      x: fist.reduce((s, p) => s + p[0], 0) / fist.length,
      y: fist.reduce((s, p) => s + p[1], 0) / fist.length,
    }
    fistW = Math.max(...fist.map((p) => p[0])) - Math.min(...fist.map((p) => p[0])) + 1
  }

  // 脸部: y < 35%h 肤色 bbox 与中心
  let fw0 = width, fw1 = 0, fh0 = height, fh1 = 0, fn = 0
  for (let y = 0; y < height * 0.35; y++) {
    for (let x = 0; x < width; x++) {
      if (skinAt(x, y)) {
        if (x < fw0) fw0 = x
        if (x > fw1) fw1 = x
        if (y < fh0) fh0 = y
        if (y > fh1) fh1 = y
        fn++
      }
    }
  }
  const faceW = fw1 - fw0
  const faceBox = { x: (fw0 + fw1) / 2, y: (fh0 + fh1) / 2, w: faceW, h: fh1 - fh0 }

  // 躯干宽: y=47%h 行的中央连通段宽(不含两侧手臂)
  const alphaAt = (x, y) => data[(y * width + x) * 4 + 3] > 30
  const centralRunW = (y) => {
    const cx = width / 2
    let x0 = Math.floor(cx)
    let x1 = Math.floor(cx)
    while (x0 > 0 && alphaAt(x0 - 1, y)) x0--
    while (x1 < width - 1 && alphaAt(x1 + 1, y)) x1++
    return x1 - x0 + 1
  }
  const chestW = centralRunW(Math.floor(height * 0.47))
  // 躯干全幅宽(含双臂): y 42%-55%h 最大行宽
  let chestSpanW = 0
  for (let y = Math.floor(height * 0.42); y < height * 0.55; y++) {
    let x0 = -1, x1 = -1
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, y)) {
        if (x0 < 0) x0 = x
        x1 = x
      }
    }
    if (x0 >= 0 && x1 - x0 > chestSpanW) chestSpanW = x1 - x0
  }

  // 腿幅宽: y=80%h 行 alpha 全幅(双腿+间隙)
  let lx0 = -1, lx1 = -1
  const legY = Math.floor(height * 0.8)
  for (let x = 0; x < width; x++) {
    if (alphaAt(x, legY)) {
      if (lx0 < 0) lx0 = x
      lx1 = x
    }
  }
  const legSpanW = lx0 >= 0 ? lx1 - lx0 + 1 : Math.round(width * 0.4)

  // 拳高: 手部肤色簇(上方 cluster)的纵向跨度
  const fistH = cluster.length
    ? Math.max(...cluster.map((p) => p[1])) - Math.min(...cluster.map((p) => p[1])) + 1
    : Math.round(height * 0.05)

  // 裆部 y: 沿中心列从颈部向下扫描, 找到持续透明(腿间缝隙)的起点
  let crotchY = Math.floor(height * 0.6)
  {
    const cx = Math.floor(width / 2)
    let run = 0
    for (let y = neckY; y < height * 0.95; y++) {
      if (!alphaAt(cx, y)) {
        run++
        if (run >= 8) {
          crotchY = y - run + 1
          break
        }
      } else {
        run = 0
      }
    }
  }

  const foot = { x: width / 2, y: height - 1 }
  const torsoH = crotchY - neckY
  const legH = foot.y - crotchY
  return { faceBox, neck, hand, foot, faceW, chestW, chestSpanW, legSpanW, fistW, fistH, torsoH, legH }
}

// 去白雾: 切片源图带白色半透明雾底, 从边缘洪水填充标记"近白色"像素并置为全透明
// (衣物内部的白色区域不与边缘连通, 得以保留; 肤色 min 通道 < 222 不受影响)
async function dehaze(src) {
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const WHITE = 222
  const isWhite = (x, y) => {
    const i = (y * width + x) * 4
    return data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE
  }
  const bg = new Uint8Array(width * height)
  const queue = []
  const visit = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = y * width + x
    if (bg[i] || !isWhite(x, y)) return
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
  for (let i = 0; i < width * height; i++) {
    if (bg[i]) data[i * 4 + 3] = 0
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

// 切片量测: alpha bbox + 肤色 bbox(缩放参考与对齐锚点)
async function measureSlice(src, skin) {
  const img = sharp(src)
  const meta = await img.metadata()
  const { data } = await img.raw().toBuffer({ resolveWithObject: true })
  const width = meta.width
  const height = meta.height
  let ax0 = width, ay0 = height, ax1 = 0, ay1 = 0
  let sx0 = width, sx1 = 0, sy0 = height, sy1 = 0, sn = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] <= 30) continue
      if (x < ax0) ax0 = x
      if (x > ax1) ax1 = x
      if (y < ay0) ay0 = y
      if (y > ay1) ay1 = y
      if (data[i + 3] >= 128 && colorDist(data, i, skin[0], skin[1], skin[2]) <= 70) {
        if (x < sx0) sx0 = x
        if (x > sx1) sx1 = x
        if (y < sy0) sy0 = y
        if (y > sy1) sy1 = y
        sn++
      }
    }
  }
  // 躯干中央连通段宽(y=28%h 胸部行, 不含手臂)
  const alphaAt2 = (x, y) => data[(y * width + x) * 4 + 3] > 30
  let cx0 = Math.floor(width / 2)
  let cx1 = Math.floor(width / 2)
  const chestRow = Math.floor(height * 0.28)
  while (cx0 > 0 && alphaAt2(cx0 - 1, chestRow)) cx0--
  while (cx1 < width - 1 && alphaAt2(cx1 + 1, chestRow)) cx1++
  return {
    width,
    height,
    bboxW: ax1 - ax0 + 1,
    bboxH: ay1 - ay0 + 1,
    bbox: { left: ax0, top: ay0, width: ax1 - ax0 + 1, height: ay1 - ay0 + 1 },
    skinW: sn ? sx1 - sx0 + 1 : 0,
    skinH: sn ? sy1 - sy0 + 1 : 0,
    chestW: cx1 - cx0 + 1,
    skinBox: sn ? { cx: (sx0 + sx1) / 2, cy: (sy0 + sy1) / 2 } : null,
  }
}

// 把已定位的切片合成进 512x1024 透明画布(允许切片超出画布, 超界部分裁掉)
async function placeOnCanvas(sliceBuffer, sw, sh, left, top) {
  const padX = sw
  const padY = sh
  const big = await sharp({
    create: {
      width: CW + padX * 2,
      height: CH + padY * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: sliceBuffer, left: Math.round(left) + padX, top: Math.round(top) + padY }])
    .png()
    .toBuffer()
  return sharp(big).extract({ left: padX, top: padY, width: CW, height: CH }).png().toBuffer()
}

// 素体颈部以下纵向压缩(脸部不变形), 解决素体四肢过长与切片比例不匹配
async function squashBase(cut) {
  const seamY = Math.round(cut.height * SQUASH_SEAM)
  const bottomH = cut.height - seamY
  const newBottomH = Math.max(1, Math.round(bottomH * BODY_SQUASH))
  const top = await sharp(cut.buffer)
    .extract({ left: 0, top: 0, width: cut.width, height: seamY })
    .png()
    .toBuffer()
  const bottom = await sharp(cut.buffer)
    .extract({ left: 0, top: seamY, width: cut.width, height: bottomH })
    .resize(cut.width, newBottomH)
    .png()
    .toBuffer()
  const buffer = await sharp({
    create: { width: cut.width, height: seamY + newBottomH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: top, left: 0, top: 0 },
      { input: bottom, left: 0, top: seamY },
    ])
    .png()
    .toBuffer()
  return { buffer, width: cut.width, height: seamY + newBottomH }
}

async function normalizeBase(cut) {  const targetH = Math.round(CH * BASE_FILL)
  const scale = targetH / cut.height
  const w = Math.max(1, Math.round(cut.width * scale))
  const resized = await sharp(cut.buffer).resize(w, targetH).png().toBuffer()
  const left = Math.round((CW - w) / 2)
  const top = CH - targetH
  const buffer = await sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer()
  return { buffer, scale, left, top, targetH }
}

// 宠物(旧制式): 抠图后缩放到 512x512 底部中心
async function normalizePet(cut) {
  const scale = Math.min(PET_FIT[0] / cut.width, PET_FIT[1] / cut.height, 1)
  const w = Math.max(1, Math.round(cut.width * scale))
  const h = Math.max(1, Math.round(cut.height * scale))
  const resized = await sharp(cut.buffer).resize(w, h).png().toBuffer()
  return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, left: Math.round((512 - w) / 2), top: 512 - h }])
    .png()
    .toBuffer()
}

function sortSlices(files) {
  const num = (f) => {
    const m = f.match(/(\d+)/)
    return m ? parseInt(m[1], 10) : 0
  }
  return [...files].sort((a, b) => num(a) - num(b))
}

async function main() {
  ensure(PREVIEW)
  ensure(path.join(OUT, 'avatar'))

  // ---------- 素体: 抠图 + 颈下压缩 + 归一化 + landmarks ----------
  const maleCut = await squashBase(await cutout(path.join(SRC, '人物', 'base_male.png'), { watermark: false }))
  const landmarks = await measureBase(maleCut.buffer, maleCut.width, maleCut.height)
  const male = await normalizeBase(maleCut)
  fs.writeFileSync(path.join(OUT, 'avatar', 'base_male.png'), male.buffer)
  // landmarks -> 画布坐标
  const S = male.scale
  const toCanvas = (p) => ({ x: male.left + p.x * S, y: male.top + p.y * S })
  const L = {
    face: toCanvas({ x: landmarks.faceBox.x, y: landmarks.faceBox.y }), // 脸 bbox 中心
    neck: toCanvas(landmarks.neck),
    hand: toCanvas(landmarks.hand),
    foot: { x: toCanvas(landmarks.foot).x, y: CH },
  }
  console.log('landmarks(canvas):', JSON.stringify(L, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)))

  const femaleCut = await squashBase(await cutout(path.join(SRC, '人物', 'base_female.png'), { watermark: false }))
  const female = await normalizeBase(femaleCut)
  fs.writeFileSync(path.join(OUT, 'avatar', 'base_female.png'), female.buffer)
  console.log(`base: male ${maleCut.width}x${maleCut.height} s=${S.toFixed(3)}, female ${femaleCut.width}x${femaleCut.height}`)

  // 肤色参考(从男性素体脸部取, 供切片肤色检测)
  const { data: baseData } = await sharp(male.buffer).raw().toBuffer({ resolveWithObject: true })
  const fi = (Math.round(L.face.y) * CW + Math.round(L.face.x)) * 4
  const skin = [baseData[fi], baseData[fi + 1], baseData[fi + 2]]

  // ---------- 切片插槽 ----------
  // 切片与素体并非同一像素比例: 按解剖尺寸逐件校准缩放
  //   head: 素体脸宽/切片肤色宽(等比)  body: 素体躯干全幅宽/切片bbox宽(等比)
  //   leg:  X=素体腿幅宽/切片bbox宽, Y=素体腿长(含上探)/切片bbox高(独立缩放, 裤腰接上衣)
  //   acc:  素体拳高/切片肤色高(等比)
  // 对齐: face=肤色bbox中心对脸部中心 neck=顶部中心对颈部
  //   foot=底部中心对脚底 hand=肤色bbox中心偏下对手部
  const SLICES = {
    head: { dir: '装备/头部', align: 'face', count: 30, ratio: (m) => landmarks.faceW / m.skinW },
    body: { dir: '装备/身体', align: 'neck', count: 30, ratio: (m) => landmarks.chestSpanW / m.bboxW },
    leg: { dir: '装备/腿', align: 'foot', count: 30, ratio: (m) => landmarks.legSpanW / m.bboxW, ratioY: (m) => (landmarks.legH + LEG_OVERLAP) / m.bboxH },
    acc: { dir: '装备/手持', align: 'hand', count: 30, ratio: (m) => landmarks.fistH / m.skinH },
  }

  for (const [slot, cfg] of Object.entries(SLICES)) {
    const files = sortSlices(fs.readdirSync(path.join(SRC, cfg.dir)).filter((f) => f.endsWith('.png')))
    const outDir = path.join(OUT, 'equipment', slot)
    ensure(outDir)

    // 第一遍: 去白雾 + 量测 + 原始缩放比(X/Y)
    const measured = []
    for (const f of files) {
      const src = path.join(SRC, cfg.dir, f)
      const index = parseInt(f.match(/(\d+)/)[1], 10)
      const clean = await dehaze(src)
      const m = await measureSlice(clean, skin)
      const raw = m.skinW || m.bboxW ? cfg.ratio(m) : NaN
      const rawY = cfg.ratioY ? cfg.ratioY(m) : NaN
      measured.push({ src, clean, index, m, raw, rawY })
    }
    const pickMedian = (key) => {
      const vals = measured.map((t) => t[key]).filter((r) => isFinite(r) && r > 0).sort((a, b) => a - b)
      return vals.length ? vals[Math.floor(vals.length / 2)] : 1
    }
    const medianX = pickMedian('raw')
    const medianY = cfg.ratioY ? pickMedian('rawY') : 0
    const clamp = (r, med) => (isFinite(r) && r > 0 ? Math.min(Math.max(r, med * 0.75), med * 1.33) : med)
    console.log(`${slot}: ${files.length} 张切片, 缩放比中位 X=${medianX.toFixed(3)}${cfg.ratioY ? ` Y=${medianY.toFixed(3)}` : ''}`)

    // 第二遍: 裁内容 bbox -> 缩放(X/Y 可独立) -> 对齐放置
    const byIndex = new Map()
    for (const t of measured) {
      // head 槽全件统一用中位比, 保证头部大小一致; 其他槽逐件钳位
      const ratioX = slot === 'head' && HEAD_UNIFIED_SCALE ? medianX : clamp(t.raw, medianX)
      let scaleX = S * ratioX * (SCALE_CALIB[slot] ?? 1)
      let scaleY = cfg.ratioY ? S * clamp(t.rawY, medianY) : scaleX
      // 画布容纳上限: 超宽/超高时收敛对应轴缩放, 保证切片完整不裁边
      const maxW = CW - 16
      const maxH = CH - 16
      if (t.m.bboxW * scaleX > maxW) scaleX = maxW / t.m.bboxW
      if (t.m.bboxH * scaleY > maxH) scaleY = maxH / t.m.bboxH
      const sw = Math.max(1, Math.round(t.m.bboxW * scaleX))
      const sh = Math.max(1, Math.round(t.m.bboxH * scaleY))
      const resized = await sharp(t.clean).extract(t.m.bbox).resize(sw, sh).png().toBuffer()

      let anchor
      if (cfg.align === 'neck') anchor = { x: sw / 2, y: 0 }
      else if (cfg.align === 'foot') anchor = { x: sw / 2, y: sh }
      else if (cfg.align === 'hand') {
        // 手持: 肤色区含前臂, 锚点取肤色 bbox 中心偏下(拳头一侧), 避免被前臂拉偏
        anchor = t.m.skinBox
          ? {
              x: (t.m.skinBox.cx - t.m.bbox.left) * scaleX,
              y: (t.m.skinBox.cy - t.m.bbox.top + t.m.skinH * 0.3) * scaleY,
            }
          : { x: sw / 2, y: sh / 2 }
      } else {
        // face: 肤色 bbox 中心(换算到裁剪后坐标并随切片同系数缩放)
        anchor = t.m.skinBox
          ? { x: (t.m.skinBox.cx - t.m.bbox.left) * scaleX, y: (t.m.skinBox.cy - t.m.bbox.top) * scaleY }
          : { x: sw / 2, y: sh / 2 }
      }
      const target = L[cfg.align === 'face' ? 'face' : cfg.align === 'neck' ? 'neck' : cfg.align === 'foot' ? 'foot' : 'hand']
      const shiftY = slot === 'body' ? TORSO_SHIFT_Y : slot === 'head' ? HEAD_SHIFT_Y : 0
      const buf = await placeOnCanvas(resized, sw, sh, target.x - anchor.x, target.y + shiftY - anchor.y)
      byIndex.set(t.index, buf)
    }
    // 缺失编号用前一件补齐
    for (let i = 1; i <= cfg.count; i++) {
      const buf = byIndex.get(i) ?? byIndex.get(i - 1) ?? [...byIndex.values()][0]
      fs.writeFileSync(path.join(outDir, `${i}.png`), buf)
    }
  }

  // ---------- 宠物(沿用旧制式) ----------
  const petDir = path.join(SRC, '装备/宠物')
  const petFiles = sortSlices(fs.readdirSync(petDir).filter((f) => f.endsWith('.png')))
  const petOut = path.join(OUT, 'equipment', 'pet')
  ensure(petOut)
  const pets = []
  for (const f of petFiles) {
    pets.push(await normalizePet(await cutout(path.join(petDir, f))))
  }
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(petOut, `${i + 1}.png`), pets[i % pets.length])
  }
  console.log(`pet: 处理 ${petFiles.length} 张, 复用填充到 30`)

  // ---------- avatarConfig.ts ----------
  const ts = `// 本文件由 web/scripts/build-avatar-assets.mjs 自动生成, 请勿手改
// 穿戴切片制式: 所有切片与基底共用 512x1024 画布, 原点位叠放, offset 全 0
// Z 序: base(0) -> leg(1) -> body(2) -> head(3) -> acc(4) -> pet(5)
// body 插槽 = 套装: torso(equipment/body/{n}.png) + leg(equipment/leg/{n}.png)
export type AvatarGender = 'male' | 'female'
export type AvatarSlotKey = 'leg' | 'body' | 'head' | 'acc' | 'pet'

export interface SlotAnchor {
  offsetX: number
  offsetY: number
}

export const BASE_CANVAS = { width: 512, height: 1024 } as const

// body 空槽时渲染的默认套装编号(纯显示层, 不影响链上数据)
export const DEFAULT_BODY_INDEX = ${DEFAULT_BODY_INDEX}

export const SLOT_CANVAS: Record<AvatarSlotKey, { width: number; height: number; anchorX: number; anchorY: number }> = {
  leg: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  body: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  head: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  acc: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  pet: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
}

export const SLOT_ANCHORS: Record<AvatarGender, Record<AvatarSlotKey, SlotAnchor>> = {
  male: {
    leg: { offsetX: 0, offsetY: 0 },
    body: { offsetX: 0, offsetY: 0 },
    head: { offsetX: 0, offsetY: 0 },
    acc: { offsetX: 0, offsetY: 0 },
    pet: { offsetX: ${PET_ANCHOR.offsetX}, offsetY: ${PET_ANCHOR.offsetY} },
  },
  female: {
    leg: { offsetX: 0, offsetY: 0 },
    body: { offsetX: 0, offsetY: 0 },
    head: { offsetX: 0, offsetY: 0 },
    acc: { offsetX: 0, offsetY: 0 },
    pet: { offsetX: ${PET_ANCHOR.offsetX}, offsetY: ${PET_ANCHOR.offsetY} },
  },
}

export const BASE_IMAGE: Record<AvatarGender, string> = {
  male: '/assets/avatar/base_male.png',
  female: '/assets/avatar/base_female.png',
}
`
  fs.writeFileSync(path.resolve(ROOT, 'web/src/data/avatarConfig.ts'), ts)

  // ---------- 调试合成预览 ----------
  for (const combo of [1, 3, 7, 12, 16, 20, 24, 28]) {
    const layers = [{ input: male.buffer, left: 0, top: 0 }]
    // Z: leg -> body -> head -> acc -> pet
    for (const [slot, cv, anchor] of [
      ['leg', [CW, CH], [0.5, 1]],
      ['body', [CW, CH], [0.5, 1]],
      ['head', [CW, CH], [0.5, 1]],
      ['acc', [CW, CH], [0.5, 1]],
      ['pet', [512, 512], [0.5, 1]],
    ]) {
      const a = slot === 'pet' ? PET_ANCHOR : { offsetX: 0, offsetY: 0 }
      layers.push({
        input: fs.readFileSync(path.join(OUT, 'equipment', slot, `${combo}.png`)),
        left: Math.round(256 + a.offsetX - cv[0] * anchor[0]),
        top: Math.round(1024 + a.offsetY - cv[1] * anchor[1]),
      })
    }
    await sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 240, g: 240, b: 245, alpha: 1 } } })
      .composite(layers)
      .png()
      .toFile(path.join(PREVIEW, `composite_${combo}.png`))
  }
  console.log(`preview: ${PREVIEW}/composite_{1,5,12,20}.png`)
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
