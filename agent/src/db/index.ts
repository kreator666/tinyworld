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
// AGENT_DATA_DIR 可覆盖数据目录(多实例并行验证时用,默认 agent/data)
const DATA_DIR = (process.env.AGENT_DATA_DIR || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../data')).replaceAll('\\', '/')

export { DATA_DIR }

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
      token_id NUMERIC(20,0) NOT NULL,
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
      token_id NUMERIC(20,0) NOT NULL,
      skill_id TEXT NOT NULL REFERENCES skills (id),
      config JSONB NOT NULL DEFAULT '{}',
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (token_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      token_id NUMERIC(20,0) NOT NULL,
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
    -- 链家族(evm/solana);老库升级补列,缺省按 evm 处理
    ALTER TABLE chains ADD COLUMN IF NOT EXISTS family TEXT NOT NULL DEFAULT 'evm';

    -- 多对话管理(我的 Agent 助手页):对话历史按会话隔离,事实记忆跨会话共享
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      token_id NUMERIC(20,0) NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversations_token_idx ON conversations (token_id, updated_at);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, created_at);

    -- 社交消息(M3):Agent 间/真人对 Agent 的广场私信,心跳调度器读写
    CREATE TABLE IF NOT EXISTS social_messages (
      id TEXT PRIMARY KEY,
      from_token_id NUMERIC(20,0) NOT NULL,
      to_token_id NUMERIC(20,0) NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS social_msg_to_idx ON social_messages (to_token_id, created_at);

    -- DeFi 审批(M4):超限额/白名单外/熔断时的交易提案,等人工放行
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      token_id NUMERIC(20,0) NOT NULL,
      proposal JSONB NOT NULL,
      agent_reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
      tx_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS approvals_token_idx ON approvals (token_id, created_at);

    -- Agent 级设置(M4):兑换执行模式等可由主人调整的开关
    CREATE TABLE IF NOT EXISTS agent_settings (
      token_id NUMERIC(20,0) PRIMARY KEY,
      swap_mode TEXT NOT NULL DEFAULT 'hot_wallet' CHECK (swap_mode IN ('hot_wallet', 'user_wallet')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 主人画像(M5 调教):Agent 与主人聊天中学习的事实,按隐私分级
    -- general=可对外分享;coarse=对外只可用概略形态(城市级位置、姓氏等);private=仅限主人对话
    CREATE TABLE IF NOT EXISTS owner_facts (
      id TEXT PRIMARY KEY,
      token_id NUMERIC(20,0) NOT NULL,
      category TEXT NOT NULL, -- 喜好/习惯/个人信息/位置/职业/其他
      fact TEXT NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('general', 'coarse', 'private')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS owner_facts_token_idx ON owner_facts (token_id, created_at);

    -- token_id 用 NUMERIC(20,0):Solana tokenId = mint 前 8 字节 u64(最大 ~1.8e19),
    -- 超出 int4/int8;JS 侧以 number(双精度)往返,写入时按十进制精确存储
    ALTER TABLE memories ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE agent_skills ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE tasks ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE conversations ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE social_messages ALTER COLUMN from_token_id TYPE NUMERIC(20,0);
    ALTER TABLE social_messages ALTER COLUMN to_token_id TYPE NUMERIC(20,0);
    ALTER TABLE approvals ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE agent_settings ALTER COLUMN token_id TYPE NUMERIC(20,0);
    ALTER TABLE owner_facts ALTER COLUMN token_id TYPE NUMERIC(20,0);

    -- 链上身份镜像(重建种子):GPA 扫描/单户解析成功后落库,测试网重置后据此重建。
    -- 注意:token_id 由随机 mint 派生,重建重铸后会变化,rehydrate 脚本负责回写新值
    CREATE TABLE IF NOT EXISTS chain_identities (
      token_id NUMERIC(20,0) PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      mint TEXT NOT NULL,
      persona_hash TEXT NOT NULL DEFAULT '',
      persona_arweave_id TEXT NOT NULL DEFAULT '',
      minted_at BIGINT NOT NULL DEFAULT 0,
      chain_key TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chain_identities_owner_idx ON chain_identities (chain_key, owner);
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
  family: string // 'evm' | 'solana',前端 hydrateFromApi 用
}

/** 启动时把 config 里的链配置 upsert 进 chains 表(种子数据) */
export async function seedChains(rows: (Omit<ChainRow, 'enabled'> & { family: string })[]): Promise<void> {
  const db = await getDb()
  for (const r of rows) {
    await db.query(
      `INSERT INTO chains (chain_key, chain_id, name, identity_address, parts_address, rpc, explorer, family)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (chain_key) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, name = EXCLUDED.name,
         identity_address = EXCLUDED.identity_address, parts_address = EXCLUDED.parts_address,
         rpc = EXCLUDED.rpc, explorer = EXCLUDED.explorer, family = EXCLUDED.family`,
      [r.chain_key, r.chain_id, r.name, r.identity_address, r.parts_address, r.rpc, r.explorer, r.family],
    )
  }
}

/** 查询所有启用的链(前端拉取用) */
export async function listChains(): Promise<ChainRow[]> {
  const db = await getDb()
  const res = await db.query<ChainRow>('SELECT * FROM chains WHERE enabled ORDER BY chain_id')
  return res.rows
}

// ============================================================
// 链上身份镜像:测试网定期重置的重建种子(P1 方案)
// 写入时机:GPA 扫描成功(批量)/ resolveTokenId 单户解析成功(增量)
// ============================================================

export interface ChainIdentityRow {
  token_id: string // 十进制字符串;JS 侧往返转 number(与全库 token_id 约定一致)
  owner: string
  name: string
  mint: string
  persona_hash: string
  persona_arweave_id: string
  minted_at: number
  chain_key: string
}

/** 批量 upsert(按 token_id 冲突更新);镜像写失败不允许影响链上读取,调用方自行 catch */
export async function upsertChainIdentities(rows: ChainIdentityRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  for (const r of rows) {
    await db.query(
      `INSERT INTO chain_identities (token_id, owner, name, mint, persona_hash, persona_arweave_id, minted_at, chain_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (token_id) DO UPDATE SET
         owner = EXCLUDED.owner, name = EXCLUDED.name, mint = EXCLUDED.mint,
         persona_hash = EXCLUDED.persona_hash, persona_arweave_id = EXCLUDED.persona_arweave_id,
         minted_at = EXCLUDED.minted_at, chain_key = EXCLUDED.chain_key, updated_at = now()`,
      [r.token_id, r.owner, r.name, r.mint, r.persona_hash, r.persona_arweave_id, r.minted_at, r.chain_key],
    )
  }
}

export async function listChainIdentities(chainKey: string): Promise<ChainIdentityRow[]> {
  const db = await getDb()
  const res = await db.query<ChainIdentityRow>(
    'SELECT * FROM chain_identities WHERE chain_key = $1 ORDER BY minted_at',
    [chainKey],
  )
  return res.rows
}

/** 重建重铸后 token_id/mint 变化:按 owner+chain 定位旧行并回写新值 */
export async function rewriteChainIdentityToken(
  chainKey: string,
  owner: string,
  newTokenId: string,
  newMint: string,
): Promise<void> {
  const db = await getDb()
  await db.query(
    `UPDATE chain_identities SET token_id = $1, mint = $2, updated_at = now()
     WHERE chain_key = $3 AND owner = $4`,
    [newTokenId, newMint, chainKey, owner],
  )
}
