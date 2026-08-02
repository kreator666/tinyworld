#!/usr/bin/env node
/**
 * 头/身体分割工具
 * 按 v4 拼接参数把目录内的角色立绘拆成 head + body 两张图,
 * 默认: head 取顶部 430px, body 从 429px 取到图底(与 head 重叠 1px),
 * 输出到 <输入目录>/_split/<原文件名>/头.png + 身体.png
 *
 * 使用:
 *   cd web && node ../scripts/split-head-body.mjs <目录> [--head-h=430] [--overlap=1]
 *
 * 依赖: sharp(已安装到 web/node_modules)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function loadSharp() {
  // 优先从 web 目录的 node_modules 解析 sharp(项目 sharp 安装在该处)
  const webPkg = path.resolve(__dirname, '../web/package.json')
  try {
    const webRequire = createRequire(pathToFileURL(webPkg).href)
    const sharpPath = webRequire.resolve('sharp')
    const mod = await import(pathToFileURL(sharpPath).href)
    return mod.default ?? mod
  } catch {
    // 回退: 从 cwd 解析
    try {
      const cwdRequire = createRequire(pathToFileURL(path.resolve('package.json')).href)
      const sharpPath = cwdRequire.resolve('sharp')
      const mod = await import(pathToFileURL(sharpPath).href)
      return mod.default ?? mod
    } catch {}
  }
  console.error('未找到 sharp 模块。请确保已运行 npm install，或从 web 目录运行:')
  console.error('  cd web && node ../scripts/split-head-body.mjs <目录>')
  process.exit(1)
}

const sharp = await loadSharp()

function parseArgs() {
  const args = process.argv.slice(2)
  let dir = null
  let outDir = null
  let headH = 430
  let overlap = 1
  let resizeW = 0
  let resizeH = 0
  let resizeFit = 'cover'
  for (const a of args) {
    if (a.startsWith('--head-h=')) headH = Number(a.split('=')[1])
    else if (a.startsWith('--overlap=')) overlap = Number(a.split('=')[1])
    else if (a.startsWith('--out=')) outDir = a.split('=')[1]
    else if (a.startsWith('--resize=')) {
      const [w, h] = a.split('=')[1].split(',').map(Number)
      resizeW = w
      resizeH = h
    } else if (a.startsWith('--resize-fit=')) {
      resizeFit = a.split('=')[1]
    } else if (!a.startsWith('-')) dir = a
  }
  return { dir, outDir, headH, overlap, resizeW, resizeH, resizeFit }
}

function isImage(name) {
  return /\.(png|jpg|jpeg|webp)$/i.test(name)
}

async function splitImage(inputPath, outDir, headH, overlap, resizeW, resizeH, resizeFit) {
  let input = sharp(inputPath)
  if (resizeW > 0 && resizeH > 0) {
    input = input.resize(resizeW, resizeH, { fit: resizeFit })
  }

  // 当 resize 时,metadata 可能仍返回原始尺寸,先 toBuffer 再读取确保准确
  const processed = await input.toFormat('png').toBuffer()
  input = sharp(processed)
  const { width, height } = await input.metadata()
  if (!width || !height) throw new Error(`无法读取尺寸: ${inputPath}`)

  const bodyStart = Math.max(0, headH - overlap)
  const bodyH = height - bodyStart
  if (bodyH <= 0) throw new Error(`图高 ${height} 不够拆分(headH=${headH}): ${inputPath}`)

  const headOut = path.join(outDir, '头.png')
  const bodyOut = path.join(outDir, '身体.png')

  await input.clone().extract({ left: 0, top: 0, width, height: headH }).png().toFile(headOut)
  await input.clone().extract({ left: 0, top: bodyStart, width, height: bodyH }).png().toFile(bodyOut)

  return { headH, bodyH, headOut, bodyOut, width, height }
}

async function main() {
  const { dir, outDir, headH, overlap, resizeW, resizeH, resizeFit } = parseArgs()
  if (!dir) {
    console.log('用法: node split-head-body.mjs <目录> [--out=输出目录] [--resize=W,H] [--resize-fit=cover] [--head-h=430] [--overlap=1]')
    console.log('  --out          输出目录(默认 <输入目录>/_split)')
    console.log('  --resize       先缩放再切割,例如 --resize=512,1026')
    console.log('  --resize-fit   缩放模式: cover(默认)/fill/contain')
    console.log('  --head-h       头部高度像素(默认 430, 对应 v4 参数)')
    console.log('  --overlap      head/body 重叠像素(默认 1, 对应 v4 -595 偏移)')
    process.exit(0)
  }

  const inputDir = path.resolve(dir)
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`不是有效目录: ${inputDir}`)
    process.exit(1)
  }

  const outRoot = outDir ? path.resolve(outDir) : path.join(inputDir, '_split')
  fs.mkdirSync(outRoot, { recursive: true })

  const files = fs.readdirSync(inputDir).filter(isImage)
  if (files.length === 0) {
    console.log('目录内没有图片文件(png/jpg/jpeg/webp)')
    return
  }

  console.log(`输入目录: ${inputDir}`)
  console.log(`分割参数: head=${headH}px, overlap=${overlap}px`)
  if (resizeW > 0 && resizeH > 0) {
    console.log(`预处理缩放: ${resizeW}x${resizeH}, fit=${resizeFit}`)
  }
  console.log('')

  for (const file of files) {
    const base = path.parse(file).name
    const outDir = path.join(outRoot, base)
    fs.mkdirSync(outDir, { recursive: true })

    const inputPath = path.join(inputDir, file)
    try {
      const r = await splitImage(inputPath, outDir, headH, overlap, resizeW, resizeH, resizeFit)
      console.log(`${file} -> ${path.relative(inputDir, outDir)}`)
      console.log(`  头.png   ${r.width}x${r.headH}`)
      console.log(`  身体.png ${r.width}x${r.bodyH}`)
    } catch (e) {
      console.error(`  失败: ${file}`, e.message)
    }
  }

  console.log('')
  console.log('完成。输出目录:', outRoot)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
