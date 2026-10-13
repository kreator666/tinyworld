#!/usr/bin/env node
/**
 * 配饰/宠物切片重建 + 角色立绘缩略图生成(精简自旧 build-avatar-assets.mjs, 只处理这两类 + 缩略图)
 *
 * 输入(prototype/素材/装备/):
 *   宠物/*.png        29 张 Q 版萌宠(1728x2304, 白底): 边缘洪水填充去白底 -> alpha 包围盒裁剪
 *                     -> 等比缩放(PET_FIT 150x220 上限, 沿用旧管线校准值) -> 512x512 透明画布底部居中
 *   手持/acc_slice_*.png  30 张配饰场景(1440x2880, 白雾底): 去白雾 -> 铺满 512x1024 画布(人物背景图)
 *
 * 输出:
 *   web/public/assets/equipment/pet/{1..29}.png   (512x512, 脚底贴底)
 *   web/public/assets/equipment/acc/{1..30}.png   (512x1024, 背景图)
 *   web/public/assets/characters/character-{n}/头.thumb.png / 身体.thumb.png  (宽 256)
 *   web/src/data/characterCatalog.ts  (重新生成, 增补 headThumbUrl/bodyThumbUrl)
 *
 * 编号规则: pet 按源文件名码点排序(与历史生成一致, 保证 catalog 中文名与图的对应关系不变),
 *          acc 按切片编号自然排序 1..30
 *
 * 运行: npm run build:assets
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'prototype/素材/装备')
const OUT = path.join(ROOT, 'web/public/assets')
const CHAR_DIR = path.join(OUT, 'characters')
const CATALOG_OUT = path.join(ROOT, 'web/src/data/characterCatalog.ts')

const CW = 512
const CH = 1024
const PET_CANVAS = 512
const PET_FIT = [150, 220] // 宠物内容缩放上限(宽 x 高), 沿用旧管线校准值
const BG_THRESHOLD = 42 // 边缘背景色距离阈值

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function colorDist(data, i, r, g, b) {
  return Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b)
}

// 边缘洪水填充: 把与边缘连通且颜色接近边缘主色的像素置透明(白底/白雾通用)
async function floodRemoveBg(src, { resize } = {}) {
  let img = sharp(src).ensureAlpha()
  if (resize) img = img.resize(resize[0], resize[1], { fit: 'inside' })
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height

  // 边缘主色按通道取中位数
  const edge = []
  for (let x = 0; x < width; x += 4) {
    edge.push((0 * width + x) * 4, ((height - 1) * width + x) * 4)
  }
  for (let y = 0; y < height; y += 4) {
    edge.push((y * width + 0) * 4, (y * width + width - 1) * 4)
  }
  const chan = (c) => {
    const vals = edge.map((i) => data[i + c]).sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }
  const r0 = chan(0)
  const g0 = chan(1)
  const b0 = chan(2)

  const bg = new Uint8Array(width * height)
  const queue = []
  const visit = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = y * width + x
    if (bg[i]) return
    if (colorDist(data, i * 4, r0, g0, b0) > BG_THRESHOLD) return
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

// alpha 包围盒裁剪
async function trimAlpha(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return buf
  return sharp(buf).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer()
}

// 宠物: 去白底 -> 裁边 -> 等比放入 512x512 底部居中
async function normalizePet(src) {
  const cut = await trimAlpha(await floodRemoveBg(src, { resize: [1024, 1024] }))
  const meta = await sharp(cut).metadata()
  const scale = Math.min(PET_FIT[0] / meta.width, PET_FIT[1] / meta.height, 1)
  const w = Math.max(1, Math.round(meta.width * scale))
  const h = Math.max(1, Math.round(meta.height * scale))
  const resized = await sharp(cut).resize(w, h).png().toBuffer()
  return sharp({
    create: { width: PET_CANVAS, height: PET_CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resized, left: Math.round((PET_CANVAS - w) / 2), top: PET_CANVAS - h }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer()
}

// 配饰: 去白雾 -> 铺满 512x1024 画布(人物背景图)
async function normalizeAcc(src) {
  const clean = await floodRemoveBg(src)
  return sharp(clean).resize(CW, CH, { fit: 'fill' }).png({ compressionLevel: 9, palette: true }).toBuffer()
}

// 角色立绘缩略图: 宽 256, 调色板 PNG(单张 <80KB)
async function makeThumb(src, dst) {
  await sharp(src)
    .resize(256, null, { withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true })
    .toFile(dst)
}

async function main() {
  // ---------- 宠物 ----------
  const petDir = path.join(SRC, '宠物')
  // pet 源文件名以 "2D卷轴..." 开头, 数字提取会被 "2D" 干扰, 直接码点排序(与历史生成一致)
  const petFiles = fs.readdirSync(petDir).filter((f) => f.endsWith('.png')).sort()
  const petOut = path.join(OUT, 'equipment', 'pet')
  ensure(petOut)
  let maxPetKB = 0
  for (let i = 0; i < petFiles.length; i++) {
    const buf = await normalizePet(path.join(petDir, petFiles[i]))
    fs.writeFileSync(path.join(petOut, `${i + 1}.png`), buf)
    maxPetKB = Math.max(maxPetKB, buf.length / 1024)
  }
  console.log(`pet: 生成 ${petFiles.length} 张 -> equipment/pet/{1..${petFiles.length}}.png (最大 ${maxPetKB.toFixed(0)}KB)`)

  // ---------- 配饰 ----------
  const accDir = path.join(SRC, '手持')
  const num = (f) => parseInt(f.match(/(\d+)/)?.[1] ?? '0', 10)
  const accFiles = fs.readdirSync(accDir).filter((f) => f.startsWith('acc_slice') && f.endsWith('.png')).sort((a, b) => num(a) - num(b))
  const accOut = path.join(OUT, 'equipment', 'acc')
  ensure(accOut)
  let maxAccKB = 0
  for (let i = 0; i < accFiles.length; i++) {
    const buf = await normalizeAcc(path.join(accDir, accFiles[i]))
    fs.writeFileSync(path.join(accOut, `${i + 1}.png`), buf)
    maxAccKB = Math.max(maxAccKB, buf.length / 1024)
  }
  console.log(`acc: 生成 ${accFiles.length} 张 -> equipment/acc/{1..${accFiles.length}}.png (最大 ${maxAccKB.toFixed(0)}KB)`)

  // ---------- 角色缩略图 + characterCatalog 重新生成 ----------
  const oldCatalog = fs.readFileSync(CATALOG_OUT, 'utf8')
  const nameOf = {}
  for (const m of oldCatalog.matchAll(/"id": "(character-\d+)"[\s\S]*?"name": "([^"]+)"/g)) {
    nameOf[m[1]] = m[2]
  }
  const entries = []
  const charDirs = fs.readdirSync(CHAR_DIR).filter((n) => /^character-\d+$/.test(n)).sort((a, b) => num(a) - num(b))
  let maxThumbKB = 0
  for (const dir of charDirs) {
    const headSrc = path.join(CHAR_DIR, dir, '头.png')
    const bodySrc = path.join(CHAR_DIR, dir, '身体.png')
    const headThumb = path.join(CHAR_DIR, dir, '头.thumb.png')
    const bodyThumb = path.join(CHAR_DIR, dir, '身体.thumb.png')
    await makeThumb(headSrc, headThumb)
    await makeThumb(bodySrc, bodyThumb)
    maxThumbKB = Math.max(maxThumbKB, fs.statSync(headThumb).size / 1024, fs.statSync(bodyThumb).size / 1024)
    entries.push({
      id: dir,
      name: nameOf[dir] ?? dir,
      headUrl: `/assets/characters/${dir}/头.png`,
      bodyUrl: `/assets/characters/${dir}/身体.png`,
      headThumbUrl: `/assets/characters/${dir}/头.thumb.png`,
      bodyThumbUrl: `/assets/characters/${dir}/身体.thumb.png`,
    })
  }
  const catalogContent = `// 自动生成 by web/scripts/build-pet-acc-assets.mjs(勿手改;缩略图由该脚本维护)
export interface CharacterItem {
  id: string
  name: string
  headUrl: string
  bodyUrl: string
  headThumbUrl: string
  bodyThumbUrl: string
}

export const CHARACTERS: CharacterItem[] = ${JSON.stringify(entries, null, 2)}

export function getCharacterById(id: string): CharacterItem | undefined {
  return CHARACTERS.find((c) => c.id === id)
}

// head/body 装备编号(如 head-3) -> 角色 id,与 PaperDoll 立绘同一套映射;
// 空/无效编号回退 character-1(PaperDoll.tsx 的 localIdToCharacterId 同源逻辑)
export function characterIdFromLocalId(localId: string | null): string {
  const index = localId?.split('-')[1]
  if (!index) return 'character-1'
  const id = \`character-\${index}\`
  return getCharacterById(id) ? id : 'character-1'
}
`
  fs.writeFileSync(CATALOG_OUT, catalogContent)
  console.log(`characters: ${entries.length} 套缩略图 (最大 ${maxThumbKB.toFixed(0)}KB), 目录已重新生成`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
