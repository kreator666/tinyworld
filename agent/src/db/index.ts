import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { EMBEDDING_DIM } from '../core/embedding'

// ============================================================
// 存储层:PGlite(嵌入式 Postgres + pgvector),数据文件在 agent/data/
// 不依赖 docker;生产可平滑换成独立 PostgreSQL,这里的 SQL 完全通用
// 注意:pgvector 扩展在 pglite 0.5.x 已拆分为独立包 @electric-sql/pglite-pgvector
// ============================================================

// PGlite 的 NodeFS 在 Windows 下不认反斜杠路径(会把路径拼接错),统一转正斜杠
const DATA_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../data').replaceAll('\\', '/')

let dbPromise: Promise<PGlite> | null = null

async function openDb(): Promise<PGlite> {
  // relaxedDurability: 每次提交后直接 checkpoint,不走 WAL 重放恢复;
  // 嵌入式 dev 场景下进程被强杀(taskkill /F)时 WAL 会损坏导致下次启动 PANIC,开这个选项规避
  const open = async () => {
    const db = new PGlite(DATA_DIR, { extensions: { vector }, relaxedDurability: true })
    await db.waitReady
    return db
  }
  try {
    return await open()
  } catch (err) {
    // 进程被强杀后 postmaster.pid 残留也可能导致启动失败;清掉锁文件重试一次
    const pidFile = path.join(DATA_DIR, 'postmaster.pid')
    if (!fs.existsSync(pidFile)) throw err
    console.warn('[db] 检测到残留的 postmaster.pid,清理后重试')
    fs.rmSync(pidFile, { force: true })
    return open()
  }
}

/** PGlite 单例(嵌入式库只允许一个连接,全局共用) */
export function getDb(): Promise<PGlite> {
  if (!dbPromise) dbPromise = openDb()
  return dbPromise
}

/** 优雅关闭(收到 SIGINT/SIGTERM 时调用,让 PGlite 正常 checkpoint 退出) */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return
  const db = await dbPromise.catch(() => null)
  dbPromise = null
  await db?.close()
}

/** 幂等建表;数据量小,向量检索直接全表余弦(<=>),不建 ivfflat 索引 */
export async function initSchema(): Promise<void> {
  const db = await getDb()
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      token_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('episodic', 'semantic')),
      content TEXT NOT NULL,
      embedding vector(${EMBEDDING_DIM}),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memories_token_kind_idx ON memories (token_id, kind);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      token_id INTEGER NOT NULL,
      skill_id TEXT NOT NULL REFERENCES skills (id),
      config JSONB NOT NULL DEFAULT '{}',
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (token_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      token_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 各链合约地址表:前端通过 GET /chains 查询(前端另存一份本地兜底)
    CREATE TABLE IF NOT EXISTS chains (
      chain_key TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      identity_address TEXT NOT NULL,
      parts_address TEXT NOT NULL,
      rpc TEXT NOT NULL,
      explorer TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true
    );
  `)
}

export interface ChainRow {
  chain_key: string
  chain_id: number
  name: string
  identity_address: string
  parts_address: string
  rpc: string
  explorer: string
  enabled: boolean
}

/** 启动时把 config 里的链配置 upsert 进 chains 表(种子数据) */
export async function seedChains(rows: Omit<ChainRow, 'enabled'>[]): Promise<void> {
  const db = await getDb()
  for (const r of rows) {
    await db.query(
      `INSERT INTO chains (chain_key, chain_id, name, identity_address, parts_address, rpc, explorer)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_key) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, name = EXCLUDED.name,
         identity_address = EXCLUDED.identity_address, parts_address = EXCLUDED.parts_address,
         rpc = EXCLUDED.rpc, explorer = EXCLUDED.explorer`,
      [r.chain_key, r.chain_id, r.name, r.identity_address, r.parts_address, r.rpc, r.explorer],
    )
  }
}

/** 查询所有启用的链(前端拉取用) */
export async function listChains(): Promise<ChainRow[]> {
  const db = await getDb()
  const res = await db.query<ChainRow>('SELECT * FROM chains WHERE enabled ORDER BY chain_id')
  return res.rows
}
