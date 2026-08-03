#!/usr/bin/env node
/**
 * 为 web/public/assets/characters 下的 头.png/身体.png 去除白底背景,
 * 输出为 RGBA, 使实时预览中的配饰背景能够透出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../public/assets/characters')

const WHITE = 222

function colorDist(d, i, r, g, b) {
  return Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b)
}

async function dehaze(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height

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

async function main() {
  const dirs = fs.readdirSync(ROOT).filter((n) => fs.statSync(path.join(ROOT, n)).isDirectory())
  let processed = 0
  for (const dir of dirs) {
    const charDir = path.join(ROOT, dir)
    for (const f of ['身体.png', '头.png']) {
      const src = path.join(charDir, f)
      if (!fs.existsSync(src)) continue
      const buf = await dehaze(src)
      fs.writeFileSync(src, buf)
      processed++
    }
  }
  console.log(`已处理 ${processed} 张角色图,去除白底背景: ${dirs.length} 套角色`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
