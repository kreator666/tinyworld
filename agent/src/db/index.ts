import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { EMBEDDING_DIM } from '../core/embedding'
import { config } from '../config'

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
    -- 链扩展配置(defi/aave/行情源/solana 等,见 seedChains);老库升级补列,缺省空对象
    -- DB 是权威:client 工厂优先读这里,行缺失/DB 不可达时回落 config.ts
    ALTER TABLE chains ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- 管理员白名单(签名登录鉴权):地址唯一,added_by 记录引入人(bootstrap=env 引导)
    CREATE TABLE IF NOT EXISTS admin_whitelist (
      address TEXT PRIMARY KEY,
      added_by TEXT NOT NULL DEFAULT 'bootstrap',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 管理操作审计:每次 admin 写操作记一条(action 如 update_chain_config/add_chain/add_protocol...)
    CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY,
      admin_address TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 链协议配置(动态多协议:dex/lending/claim/swap-solana/perp 等,消费方自定义 kind)
    -- 一行 = 一条链上一个协议实例的完整配置;admin CRUD + 热重载,技能 gating 第二阶段消费
    CREATE TABLE IF NOT EXISTS chain_protocols (
      chain_key TEXT NOT NULL,
      protocol_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_key, protocol_key)
    );

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

    -- BENQI Liquid Staking 赎回 ticket 跟踪(M5+):requestUnlock 后写入,
    -- 冷却/领取窗口/过期状态由 check_unstake 工具根据链上数据刷新
    CREATE TABLE IF NOT EXISTS benqi_unlock_requests (
      id TEXT PRIMARY KEY,
      chain_key TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      owner TEXT NOT NULL,
      request_tx_hash TEXT NOT NULL,
      unlock_index INTEGER,
      shares NUMERIC(78,0) NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimable_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claim_tx_hash TEXT,
      overdue_returned_at TIMESTAMPTZ,
      overdue_tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'cooling' CHECK (status IN ('cooling', 'claimable', 'claimed', 'expired_returned'))
    );
    CREATE INDEX IF NOT EXISTS benqi_unlock_owner_idx ON benqi_unlock_requests (chain_key, token_id, owner, status);

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
  `)

  // ============================================================
  // 多链重构(方案A)迁移:全部 token 表加 chain_key 维度。
  // 迁移基线 = 启动默认链(TARGET_CHAIN):历史数据都产生自单链时代,回填默认链。
  // 幂等:加列用 IF NOT EXISTS;主键改造用 DO 块检查,可重复执行。
  // ============================================================
  const baseline = config.chainKey
  const TOKEN_TABLES = [
    'memories',
    'agent_skills',
    'tasks',
    'conversations',
    'messages',
    'social_messages',
    'approvals',
    'agent_settings',
    'owner_facts',
  ] as const
  const addCol = TOKEN_TABLES.map(
    (t) => `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS chain_key TEXT NOT NULL DEFAULT '${baseline}';`,
  ).join('\n')
  await db.exec(`
    ${addCol}

    -- 唯一性升级:agent_skills / agent_settings 原主键只有 token_id,多链会跨链碰撞。
    -- PG 不支持改主键,先 drop 再 add(DO 块保证幂等)。
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'agent_skills' AND constraint_name = 'agent_skills_pkey'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
        WHERE table_name = 'agent_skills' AND constraint_name = 'agent_skills_pkey' AND column_name = 'chain_key'
      ) THEN
        ALTER TABLE agent_skills DROP CONSTRAINT agent_skills_pkey;
        ALTER TABLE agent_skills ADD PRIMARY KEY (chain_key, token_id, skill_id);
      END IF;
    END $$;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'agent_settings' AND constraint_name = 'agent_settings_pkey'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
        WHERE table_name = 'agent_settings' AND constraint_name = 'agent_settings_pkey' AND column_name = 'chain_key'
      ) THEN
        ALTER TABLE agent_settings DROP CONSTRAINT agent_settings_pkey;
        ALTER TABLE agent_settings ADD PRIMARY KEY (chain_key, token_id);
      END IF;
    END $$;
  `)

  await db.exec(`
    -- 链上身份镜像(重建种子):GPA 扫描/单户解析成功后落库,测试网重置后据此重建。
    -- 注意:token_id 由随机 mint 派生,重建重铸后会变化,rehydrate 脚本负责回写新值
    CREATE TABLE IF NOT EXISTS chain_identities (
      token_id NUMERIC(20,0) NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      mint TEXT NOT NULL,
      persona_hash TEXT NOT NULL DEFAULT '',
      persona_arweave_id TEXT NOT NULL DEFAULT '',
      minted_at BIGINT NOT NULL DEFAULT 0,
      chain_key TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_key, token_id)
    );
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'chain_identities' AND constraint_name = 'chain_identities_pkey'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
        WHERE table_name = 'chain_identities' AND constraint_name = 'chain_identities_pkey' AND column_name = 'chain_key'
      ) THEN
        ALTER TABLE chain_identities DROP CONSTRAINT chain_identities_pkey;
        ALTER TABLE chain_identities ADD PRIMARY KEY (chain_key, token_id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS chain_identities_owner_idx ON chain_identities (chain_key, owner);

    -- 数据自愈:messages.chain_key 以会话归属链为准(防御任何遗漏 chain_key 的写入路径)
    UPDATE messages SET chain_key = c.chain_key
    FROM conversations c
    WHERE messages.conversation_id = c.id AND messages.chain_key <> c.chain_key;
  `)

  // ============================================================
  // 竞技场(Arena,P1):赛季 / 参赛账户 / 燃料 / 快照 / 交易 / 策略 / 调度队列
  // token_id 沿用全库 NUMERIC(20,0) 约定
  // ============================================================
  await db.exec(`
    CREATE TABLE IF NOT EXISTS arena_seasons (
      id TEXT PRIMARY KEY,
      chain_key TEXT NOT NULL,
      season_address TEXT NOT NULL DEFAULT '',       -- 链上 ArenaSeason 代理地址(''=未部署)
      account_impl_address TEXT NOT NULL DEFAULT '',
      usdc_address TEXT NOT NULL,
      principal_usd NUMERIC(20,6) NOT NULL,
      fuel_usd NUMERIC(20,6) NOT NULL,
      start_ts BIGINT NOT NULL,
      end_ts BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'open', 'active', 'settling', 'settled')),
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS arena_accounts (
      season_id TEXT NOT NULL REFERENCES arena_seasons(id),
      chain_key TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      owner TEXT NOT NULL,
      account_address TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'active' CHECK (phase IN ('active', 'frozen', 'settled', 'eliminated')),
      nav_usd NUMERIC(20,6),
      eliminated_reason TEXT,
      register_tx TEXT NOT NULL DEFAULT '',
      settled_tx TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (season_id, token_id)
    );
    CREATE INDEX IF NOT EXISTS arena_accounts_addr_idx ON arena_accounts (account_address);

    CREATE TABLE IF NOT EXISTS arena_fuel (
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      balance_usd NUMERIC(20,6) NOT NULL,
      total_spent_usd NUMERIC(20,6) NOT NULL DEFAULT 0,
      last_deduction_ts TIMESTAMPTZ,
      PRIMARY KEY (season_id, token_id)
    );

    CREATE TABLE IF NOT EXISTS arena_snapshots (
      id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      nav_usd NUMERIC(20,6) NOT NULL,
      breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS arena_snapshots_idx ON arena_snapshots (season_id, token_id, created_at);

    CREATE TABLE IF NOT EXISTS arena_trades (
      id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      strategy_type TEXT NOT NULL,
      action TEXT NOT NULL,
      tx_hash TEXT,
      pnl_usd NUMERIC(20,6),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS arena_trades_idx ON arena_trades (season_id, token_id, created_at);

    -- Playbook(owner 可改,版本化保留全量历史)
    CREATE TABLE IF NOT EXISTS arena_playbooks (
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      version INTEGER NOT NULL,
      config JSONB NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (season_id, token_id, version)
    );

    -- 调度队列(统一调度器驱动;落库保证崩溃恢复)
    CREATE TABLE IF NOT EXISTS arena_due (
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      due_ts BIGINT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cheap', 'decision')),
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (season_id, token_id, kind)
    );

    -- 燃料流水(P2):每次 LLM 调用一行,可回放对账
    CREATE TABLE IF NOT EXISTS arena_fuel_ledger (
      id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      token_id NUMERIC(20,0) NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd NUMERIC(20,6) NOT NULL,
      balance_after_usd NUMERIC(20,6) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS arena_fuel_ledger_idx ON arena_fuel_ledger (season_id, token_id, created_at);
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
  config?: Record<string, unknown> // 链扩展配置(defi/aave/行情源/solana),seedChains 写入
}

/** 启动时把 config 里的链配置 upsert 进 chains 表(种子数据)。
 *  注意:config 列只在 INSERT 时写入,ON CONFLICT 不覆盖——DB 里手工改过的链配置是权威,重启不被代码冲掉 */
export async function seedChains(rows: (Omit<ChainRow, 'enabled'> & { family: string })[]): Promise<void> {
  const db = await getDb()
  for (const r of rows) {
    await db.query(
      `INSERT INTO chains (chain_key, chain_id, name, identity_address, parts_address, rpc, explorer, family, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chain_key) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, name = EXCLUDED.name,
         identity_address = EXCLUDED.identity_address, parts_address = EXCLUDED.parts_address,
         rpc = EXCLUDED.rpc, explorer = EXCLUDED.explorer, family = EXCLUDED.family`,
      [r.chain_key, r.chain_id, r.name, r.identity_address, r.parts_address, r.rpc, r.explorer, r.family, JSON.stringify(r.config ?? {})],
    )
  }
}

/** 查询所有启用的链(前端拉取用) */
export async function listChains(): Promise<ChainRow[]> {
  const db = await getDb()
  const res = await db.query<ChainRow>('SELECT * FROM chains WHERE enabled ORDER BY chain_id')
  return res.rows
}

/** 启动时把 chains 表的 config 列整表读出,交给链注册表做 DB 优先覆盖(DB 不可达返回空对象,调用方回落 config.ts) */
export async function loadChainConfigsFromDb(): Promise<Record<string, Record<string, unknown>>> {
  const db = await getDb()
  const res = await db.query<{ chain_key: string; config: Record<string, unknown> }>('SELECT chain_key, config FROM chains')
  const out: Record<string, Record<string, unknown>> = {}
  for (const row of res.rows) out[row.chain_key] = row.config ?? {}
  return out
}

/** 管理接口用:把 body 的顶层键合并进某链的 config 列(jsonb || 语义,body 里给的键覆盖同名字段);调用方负责鉴权 */
export async function updateChainConfig(chainKey: string, configJson: Record<string, unknown>): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('UPDATE chains SET config = config || $1::jsonb WHERE chain_key = $2', [
    JSON.stringify(configJson),
    chainKey,
  ])
  return (res.affectedRows ?? 0) > 0
}

/** 取单条 chains 行(管理接口判重用);不存在返回 null */
export async function getChainRow(chainKey: string): Promise<ChainRow | null> {
  const db = await getDb()
  const res = await db.query<ChainRow>('SELECT * FROM chains WHERE chain_key = $1', [chainKey])
  return res.rows[0] ?? null
}

/** 管理接口用:插入新链行(DB-only 动态链);chain_key/chain_id 冲突抛唯一约束错,调用方转 409 */
export async function insertChainRow(row: Omit<ChainRow, 'enabled'> & { family: string }): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO chains (chain_key, chain_id, name, identity_address, parts_address, rpc, explorer, family, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.chain_key, row.chain_id, row.name, row.identity_address, row.parts_address, row.rpc, row.explorer, row.family, JSON.stringify(row.config ?? {})],
  )
}

// ============================================================
// 管理员白名单 + 审计(签名鉴权管理接口)
// ============================================================

export interface AdminRow {
  address: string
  added_by: string
  created_at: string
}

export async function listAdmins(): Promise<AdminRow[]> {
  const db = await getDb()
  const res = await db.query<AdminRow>('SELECT address, added_by, created_at FROM admin_whitelist ORDER BY created_at')
  return res.rows
}

export async function isAdmin(address: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('SELECT 1 FROM admin_whitelist WHERE address = $1', [address])
  return res.rows.length > 0
}

/** 幂等添加(已存在不报错);返回是否新插入 */
export async function addAdmin(address: string, addedBy: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('INSERT INTO admin_whitelist (address, added_by) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING', [
    address,
    addedBy,
  ])
  return (res.affectedRows ?? 0) > 0
}

/** 删除管理员;返回是否删到了行 */
export async function removeAdmin(address: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM admin_whitelist WHERE address = $1', [address])
  return (res.affectedRows ?? 0) > 0
}

export async function countAdmins(): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM admin_whitelist')
  return Number(res.rows[0]?.count ?? 0)
}

export interface AuditEntry {
  adminAddress: string
  action: string // 如 update_chain_config / add_chain / add_protocol
  target: string // 如链 chain_key 或 admin 地址
  payload?: Record<string, unknown>
}

export async function insertAudit(entry: AuditEntry): Promise<void> {
  const db = await getDb()
  await db.query('INSERT INTO admin_audit (id, admin_address, action, target, payload) VALUES ($1, $2, $3, $4, $5)', [
    randomUUID(),
    entry.adminAddress,
    entry.action,
    entry.target,
    JSON.stringify(entry.payload ?? {}),
  ])
}

// ============================================================
// 链协议配置(chain_protocols):动态多协议,admin CRUD
// ============================================================

export interface ChainProtocolRow {
  chain_key: string
  protocol_key: string
  kind: string
  config: Record<string, unknown>
  enabled: boolean
  updated_by: string
  updated_at: string
}

export async function upsertChainProtocol(row: Omit<ChainProtocolRow, 'updated_at'>): Promise<void> {
  const db = await getDb()
  await db.query(
    `INSERT INTO chain_protocols (chain_key, protocol_key, kind, config, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (chain_key, protocol_key) DO UPDATE SET
       kind = EXCLUDED.kind, config = EXCLUDED.config, enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [row.chain_key, row.protocol_key, row.kind, JSON.stringify(row.config ?? {}), row.enabled, row.updated_by],
  )
}

/** 列协议;chainKey 为空列全部(前端 /chains 一次查出按链分组用) */
export async function listChainProtocols(chainKey?: string): Promise<ChainProtocolRow[]> {
  const db = await getDb()
  const res = chainKey
    ? await db.query<ChainProtocolRow>('SELECT * FROM chain_protocols WHERE chain_key = $1 ORDER BY protocol_key', [chainKey])
    : await db.query<ChainProtocolRow>('SELECT * FROM chain_protocols ORDER BY chain_key, protocol_key')
  return res.rows
}

/** 删除协议;返回是否删到了行 */
export async function deleteChainProtocol(chainKey: string, protocolKey: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.query('DELETE FROM chain_protocols WHERE chain_key = $1 AND protocol_key = $2', [chainKey, protocolKey])
  return (res.affectedRows ?? 0) > 0
}

/** 跨链统一身份映射:某地址在所有链上的身份镜像(chain_identities 按 owner 查) */
export async function listIdentitiesOf(owner: string): Promise<{ chain_key: string; token_id: string; name: string }[]> {
  const db = await getDb()
  const res = await db.query<{ chain_key: string; token_id: string; name: string }>(
    'SELECT chain_key, token_id, name FROM chain_identities WHERE owner = $1 ORDER BY chain_key, token_id',
    [owner],
  )
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

/** 批量 upsert(按 chain_key + token_id 冲突更新);镜像写失败不允许影响链上读取,调用方自行 catch */
export async function upsertChainIdentities(rows: ChainIdentityRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  for (const r of rows) {
    await db.query(
      `INSERT INTO chain_identities (token_id, owner, name, mint, persona_hash, persona_arweave_id, minted_at, chain_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (chain_key, token_id) DO UPDATE SET
         owner = EXCLUDED.owner, name = EXCLUDED.name, mint = EXCLUDED.mint,
         persona_hash = EXCLUDED.persona_hash, persona_arweave_id = EXCLUDED.persona_arweave_id,
         minted_at = EXCLUDED.minted_at, updated_at = now()`,
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
