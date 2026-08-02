#!/usr/bin/env node
/**
 * 将 D:/素材/out 下的拆分角色导入到 web/public/assets/characters
 * 并生成 web/src/data/characterCatalog.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../web')
const SRC_DIR = 'D:/素材/out'
const OUT_DIR = path.join(ROOT, 'public/assets/characters')
const CATALOG_OUT = path.join(ROOT, 'src/data/characterCatalog.ts')

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function isImage(name) {
  return /\.(png|jpg|jpeg|webp)$/i.test(name)
}

ensure(OUT_DIR)

const entries = []
const dirs = fs.readdirSync(SRC_DIR).filter((n) => fs.statSync(path.join(SRC_DIR, n)).isDirectory())

for (let i = 0; i < dirs.length; i++) {
  const srcName = dirs[i]
  const id = `character-${i + 1}`
  const srcDir = path.join(SRC_DIR, srcName)
  const dstDir = path.join(OUT_DIR, id)
  ensure(dstDir)

  const files = fs.readdirSync(srcDir).filter(isImage)
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f))
  }

  entries.push({ id, name: srcName, headUrl: `/assets/characters/${id}/头.png`, bodyUrl: `/assets/characters/${id}/身体.png` })
}

const catalogContent = `// 自动生成于 ${new Date().toISOString()} by scripts/import-characters.mjs
export interface CharacterItem {
  id: string
  name: string
  headUrl: string
  bodyUrl: string
}

export const CHARACTERS: CharacterItem[] = ${JSON.stringify(entries, null, 2)}

export function getCharacterById(id: string): CharacterItem | undefined {
  return CHARACTERS.find((c) => c.id === id)
}
`

fs.writeFileSync(CATALOG_OUT, catalogContent)

console.log(`导入 ${entries.length} 套角色到 ${OUT_DIR}`)
console.log(`目录文件: ${CATALOG_OUT}`)
