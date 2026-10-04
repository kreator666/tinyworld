import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../db'

// ============================================================
// 人格正文镜像(过渡方案):链上只存 persona_hash(keccak256),
// 正文由 web 侧 PUT 进来按 hash 去重落盘,loadPersona 时按 hash 取回并校验。
// 目标形态是正文存 Arweave(persona_arweave_id),镜像仅过渡期的同进程兜底。
// 存储:agent/data/personas/<hash>.json,hash 为 0x+64hex(小写文件名)
// ============================================================

const PERSONAS_DIR = path.join(DATA_DIR, 'personas')

function mirrorPath(hash: string): string {
  return path.join(PERSONAS_DIR, `${hash.toLowerCase()}.json`)
}

/** 读镜像原文;不存在返回 null(等价 GET /personas/:hash 的 404) */
export async function readPersonaMirror(hash: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(mirrorPath(hash), 'utf-8')
  } catch {
    return null
  }
}

/** 写入镜像(按 hash 去重:同 hash 内容必然相同,直接覆盖即可) */
export async function writePersonaMirror(hash: string, body: string): Promise<void> {
  await fs.promises.mkdir(PERSONAS_DIR, { recursive: true })
  await fs.promises.writeFile(mirrorPath(hash), body, 'utf-8')
}
