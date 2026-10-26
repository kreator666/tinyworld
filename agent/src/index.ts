import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { keccak256, toBytes, formatUnits, type Hex, type Address } from 'viem'
import { config } from './config'
import { PersonaError, loadPersona, ownerOf, resolveTokenId } from './chain/persona'
import { resolveChainKey, getChainContext, chainKeyByChainId } from './chain/registry'
import { chatWithAgent, invalidateAgent, reloadAgent, type ChatMode } from './core/agent'
import { clearMemories, distill, getMemoryCounts, listMemories } from './core/memory'
import {
  chatInConversation,
  createConversation,
  deleteConversation,
  getConversationById,
  listConversations,
  listMessages,
} from './core/conversation'
import { initSchema, closeDb, listChains, seedChains, loadChainConfigsFromDb, updateChainConfig, listIdentitiesOf, getChainRow, insertChainRow, listChainProtocols, upsertChainProtocol, deleteChainProtocol, listAdmins, addAdmin, removeAdmin, countAdmins, insertAudit } from './db'
import { applyDbChainConfigs, applyDbChains } from './chain/registry'
import { appendAssistantMessage } from './core/conversation'
import { waitForTxReceipt, parseSwapAmountOut } from './chain/defi'
import { ALL_CHAINS } from './config'
import { SkillError, getInstalledSkills, getInstalledUserSkills, installSkill, listSkills, syncSkillsToDb, uninstallSkill, deleteUserSkill, ensureDefaultSkills, refreshProtocolCache, loadSkills, reloadSkills, removeUserSkillDir } from './skills'
import { seedChainProtocols } from './skills/protocolSeeding'
import { startScheduler, stopScheduler } from './core/scheduler'
import { startArenaScheduler, stopArenaScheduler } from './core/arenaScheduler'
import { getInbox, recordSocialMessage } from './core/social'
import { getApproval, listApprovals, resolveApproval } from './core/approvals'
import { createNonce, verifyLogin, signJwt, AuthError, isValidAddress } from './core/auth'
import { readPersonaMirror, writePersonaMirror } from './core/personaMirror'
import { authRequired, adminRequired, chainAdminRequired, assertAgentOwnership, assertAgentSkillAccess } from './middleware/auth'
import { getAgentStats } from './core/stats'
import { getSwapMode, setSwapMode, type SwapMode } from './core/settings'
import { broadcastSignedTx } from './chain/defi'
import {
  ArenaError,
  buildFreezeTx,
  buildRegisterTxs,
  buildWithdrawTxs,
  confirmFreeze,
  confirmRegister,
  confirmWithdraw,
  deriveSeasonStatus,
  getPlaybook,
  leaderboardOf,
  loadSeasonOrThrow,
  savePlaybook,
  validatePlaybook,
} from './core/arena'
import { getArenaAccount, insertArenaSeason, listArenaAccounts, listArenaSeasons, updateArenaSeason, getArenaFuel } from './db/arena'
import { decisionGate, fuelConfigOf } from './core/arenaFuel'
import { settleAccount } from './core/arenaSettlement'
import { buildDeployTxs, buildWhitelistTx, resolveDeployReceipts, whitelistTemplate } from './core/arenaDeploy'
import { buildSettleTxs, confirmSettleTxs } from './core/arenaSettlement'
import { getPublicClient, getWalletClient } from './chain/clients'
import { toFunctionSelector, type Hex as ViemHex } from 'viem'
import { SOL_MINT, usdcMintOf } from './chain/jupiter'
import { solanaConnection, type FailoverConnection } from './chain/personaSolana'
import { EXEC_CHAIN_KEY, MAINNET_EXPLORER, MAINNET_USDC_MINT, mainnetConnection, mainnetTxUrl } from './chain/solanaExec'
import { executeProposal, recordDefiTask, describeSwapResult, tokenSymbolOf } from '../runtime-skills/builtins/defi-swap'
import { executeLendingProposal } from '../runtime-skills/builtins/defi-lending'
import { executeStakingProposal } from '../runtime-skills/builtins/defi-staking'
import { generateSkill, installGeneratedSkill } from '../runtime-skills/builtins/skill-creator/generator'
import type { Proposal } from './policy/engine'

// ============================================================
// API 网关(hono):健康检查、人格调试、对话,以及 M2 的记忆/技能管理端点
// ============================================================

const app = new Hono()

// 前端 dev 服务器固定跑在 5173;生产环境可通过 CORS_ORIGIN 追加来源,多个用逗号分隔
const defaultOrigins = ['http://localhost:5173']
const corsOrigins = process.env.CORS_ORIGIN
  ? [...defaultOrigins, ...process.env.CORS_ORIGIN.split(',').map((s) => s.trim())]
  : defaultOrigins
app.use('/*', cors({ origin: corsOrigins }))

app.get('/health', (c) => c.json({ ok: true }))

// 全局错误兜底:未捕获异常带请求方法+路径落日志(空 500 排查入口)
app.onError((err, c) => {
  console.error(`[onError] ${c.req.method} ${c.req.path}:`, err.message)
  return c.json({ error: '服务内部错误: ' + err.message.slice(0, 120) }, 500)
})

// 链配置管理(admin):鉴权 = 管理员钱包签名登录的 JWT(adminRequired,白名单在 admin_whitelist 表)。
// 所有写操作 insertAudit 记审计,并热重载链注册表(applyDbChains + applyDbChainConfigs)立即生效。
// 废弃:静态 CHAIN_ADMIN_TOKEN 比对(无身份、无审计)。

/** 写操作后统一热重载:DB-only 链注册 + 内置链 config 覆盖层 + 协议可用性缓存(技能 gating) */
async function reloadChainRegistry(): Promise<void> {
  applyDbChains(await listChains())
  applyDbChainConfigs(await loadChainConfigsFromDb())
  refreshProtocolCache(await listChainProtocols())
}

// 各链合约地址 + 协议配置查询(前端 hydrate 用;config/protocols 原样透传)
app.get('/chains', async (c) => {
  try {
    const chains = await listChains()
    const protocols = await listChainProtocols()
    const byChain = new Map<string, typeof protocols>()
    for (const p of protocols) {
      const list = byChain.get(p.chain_key) ?? []
      list.push(p)
      byChain.set(p.chain_key, list)
    }
    return c.json({
      chains: chains.map((row) => {
        // config 列回退补全:DB 未配的 defi.usdc 等从 ALL_CHAINS 合并层补,前端表单可直接预填
        const merged = row.config ?? {}
        const baseCfg = ALL_CHAINS[row.chain_key as keyof typeof ALL_CHAINS]?.defi
        if (baseCfg && !(merged as Record<string, unknown>).defi) {
          ;(merged as Record<string, unknown>).defi = baseCfg
        }
        return { ...row, config: merged, protocols: byChain.get(row.chain_key) ?? [] }
      }),
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 动态加链(DB-only):插 chains 行并热重载注册表,免改 config.ts 发版重启;chain_key 已存在返回 409
app.post('/admin/chains', adminRequired, async (c) => {
  try {
    const body = await c.req.json<{
      chain_key?: string
      chain_id?: number
      name?: string
      family?: string
      rpc?: string
      explorer?: string
      identity_address?: string
      parts_address?: string
      config?: Record<string, unknown>
    }>().catch(() => null)
    const missing = ['chain_key', 'chain_id', 'name', 'family', 'rpc', 'explorer', 'identity_address', 'parts_address'].filter(
      (k) => body?.[k as keyof typeof body] === undefined || body[k as keyof typeof body] === '',
    )
    if (!body || missing.length > 0) return c.json({ error: `缺少必填字段: ${missing.join(', ')}` }, 400)
    if (body.family !== 'evm' && body.family !== 'solana') return c.json({ error: 'family 必须是 evm 或 solana' }, 400)
    if (!Number.isInteger(body.chain_id) || (body.chain_id as number) <= 0) return c.json({ error: 'chain_id 必须是正整数' }, 400)
    if (await getChainRow(body.chain_key!)) return c.json({ error: `链已存在: ${body.chain_key}` }, 409)
    const row = {
      chain_key: body.chain_key!,
      chain_id: body.chain_id!,
      name: body.name!,
      family: body.family!,
      rpc: body.rpc!,
      explorer: body.explorer!,
      identity_address: body.identity_address!,
      parts_address: body.parts_address!,
      config: body.config ?? {},
    }
    try {
      await insertChainRow(row)
    } catch (err) {
      // chain_id 唯一约束冲突等
      return c.json({ error: `插入失败(chain_key/chain_id 可能已存在): ${err instanceof Error ? err.message : err}` }, 409)
    }
    await insertAudit({ adminAddress: c.get('address'), action: 'add_chain', target: row.chain_key, payload: body })
    await reloadChainRegistry()
    return c.json({ ok: true, chain: await getChainRow(row.chain_key) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 链 config JSONB 合并(jsonb ||:body 顶层键覆盖同名字段;defi/aave/solana 这类子对象需给完整对象)
// 例: curl -X PUT /admin/chains/fuji/config -H 'Authorization: Bearer <jwt>' -d '{"defi":{"router":"0x..."}}'
app.put('/admin/chains/:key/config', adminRequired, async (c) => {
  try {
    const key = c.req.param('key')
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: '请求体必须是 JSON 对象(如 {"defi":{"router":"0x..."}})' }, 400)
    }
    const ok = await updateChainConfig(key, body)
    if (!ok) return c.json({ error: `链不存在: ${key}` }, 404)
    await insertAudit({ adminAddress: c.get('address'), action: 'update_chain_config', target: key, payload: body })
    await reloadChainRegistry() // 立即生效
    return c.json({ ok: true, chainKey: key, config: body })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 链协议配置 CRUD(chain_protocols 表;kind/config 由消费方自定义,技能 gating 第二阶段消费)
app.get('/admin/chains/:key/protocols', adminRequired, async (c) => {
  try {
    const key = c.req.param('key')
    return c.json({ chainKey: key, protocols: await listChainProtocols(key) })
  } catch (err) {
    return handleErr(c, err)
  }
})

app.put('/admin/chains/:key/protocols/:pkey', adminRequired, async (c) => {
  try {
    const key = c.req.param('key')
    const pkey = c.req.param('pkey')
    const body = await c.req.json<{ kind?: string; config?: Record<string, unknown>; enabled?: boolean }>().catch(() => null)
    if (!body || typeof body.kind !== 'string' || body.kind.length === 0) {
      return c.json({ error: '请求体必须是 JSON 对象且 kind 非空(如 {"kind":"dex","config":{...}})' }, 400)
    }
    if (!(await getChainRow(key))) return c.json({ error: `链不存在: ${key}` }, 404)
    const row = { chain_key: key, protocol_key: pkey, kind: body.kind, config: body.config ?? {}, enabled: body.enabled ?? true, updated_by: c.get('address') }
    await upsertChainProtocol(row)
    await insertAudit({ adminAddress: c.get('address'), action: 'upsert_chain_protocol', target: `${key}/${pkey}`, payload: body })
    await reloadChainRegistry() // 协议缓存随写刷新,技能 gating 立即生效
    return c.json({ ok: true, protocol: row })
  } catch (err) {
    return handleErr(c, err)
  }
})

app.delete('/admin/chains/:key/protocols/:pkey', adminRequired, async (c) => {
  try {
    const key = c.req.param('key')
    const pkey = c.req.param('pkey')
    const removed = await deleteChainProtocol(key, pkey)
    if (!removed) return c.json({ error: `协议不存在: ${key}/${pkey}` }, 404)
    await insertAudit({ adminAddress: c.get('address'), action: 'delete_chain_protocol', target: `${key}/${pkey}` })
    await reloadChainRegistry() // 同上:协议缓存随写刷新
    return c.body(null, 204)
  } catch (err) {
    return handleErr(c, err)
  }
})

// 管理员白名单 CRUD(签名登录的 admin 自我管理;删到最后一个会把自己锁死,拒绝)
app.get('/admin/admins', adminRequired, async (c) => {
  try {
    return c.json({ admins: await listAdmins() })
  } catch (err) {
    return handleErr(c, err)
  }
})

app.post('/admin/admins', adminRequired, async (c) => {
  try {
    const body = await c.req.json<{ address?: string }>().catch(() => null)
    const address = body?.address?.trim()
    if (!address || !isValidAddress(address)) return c.json({ error: 'address 必须是合法的 EVM 0x 或 Solana base58 地址' }, 400)
    const added = await addAdmin(address, c.get('address'))
    await insertAudit({ adminAddress: c.get('address'), action: 'add_admin', target: address })
    return c.json({ ok: true, added, admins: await listAdmins() })
  } catch (err) {
    return handleErr(c, err)
  }
})

app.delete('/admin/admins/:address', adminRequired, async (c) => {
  try {
    const address = c.req.param('address')
    if ((await countAdmins()) <= 1) return c.json({ error: '拒绝删除最后一个管理员' }, 400)
    const removed = await removeAdmin(address)
    if (!removed) return c.json({ error: `管理员不存在: ${address}` }, 404)
    await insertAudit({ adminAddress: c.get('address'), action: 'remove_admin', target: address })
    return c.json({ ok: true, admins: await listAdmins() })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 跨链统一身份映射(只读):同一地址在各链上的身份列表。
// 数据底座是 chain_identities 镜像;也是将来 ERC-8004 注册文件 registrations 数组(多链互相引用)的数据源。
// 当前对 EVM 地址(0x)生效;Solana base58 地址镜像里若存在同样能查。
app.get('/identities/of/:address', async (c) => {
  const address = c.req.param('address')
  try {
    const rows = await listIdentitiesOf(address)
    return c.json({
      address,
      identities: rows.map((r) => ({ chainKey: r.chain_key, tokenId: Number(r.token_id), name: r.name })),
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// 认证:SIWE 签名登录
// ============================================================

// 获取一次性 nonce;前端用钱包地址请求,签名消息里必须包含该 nonce(EVM 0x / Solana base58 均可)
app.post('/auth/nonce', async (c) => {
  const body = await c.req.json<{ address?: string }>().catch(() => null)
  const address = body?.address?.trim()
  if (!address || !isValidAddress(address)) return c.json({ error: 'address 不合法' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const payload = createNonce(chainKey, address)
    return c.json(payload)
  } catch (err) {
    return handleErr(c, err)
  }
})

// 验证签名消息,签发 JWT(按消息格式自动分派 EVM/Solana 验签;payload 带 chain/chainKey 字段)
app.post('/auth/verify', async (c) => {
  const body = await c.req.json<{ message?: string; signature?: string }>().catch(() => null)
  if (!body?.message || !body?.signature) {
    return c.json({ error: 'message 和 signature 不能为空' }, 400)
  }
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    // 地址格式必须与链家族匹配:solana 链必须 base58,evm 链必须 0x 地址
    const { address, chain } = await verifyLogin(chainKey, { message: body.message, signature: body.signature })
    if (getChainContext(chainKey).family === 'solana' && chain !== 'solana') {
      return c.json({ error: '地址格式与当前链不匹配(Solana 链必须使用 base58 地址登录)' }, 400)
    }
    if (getChainContext(chainKey).family === 'evm' && chain !== 'evm') {
      return c.json({ error: '地址格式与当前链不匹配(EVM 链必须使用 0x 地址登录)' }, 400)
    }
    const chainId = getChainContext(chainKey).cfg.chainId
    const token = signJwt({ address, chainId, chain, chainKey })
    return c.json({ token, address, chainId, chain, chainKey })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// 人格正文镜像(过渡期):链上只存 persona_hash,正文经此端点按 hash 去重落盘
// (agent/data/personas/<hash>.json);loadPersona 读链后回这里取回并 keccak256 校验。
// 目标形态是正文存 Arweave,此镜像端点仅过渡兜底。hash = 0x + 64hex。
// ============================================================

const PERSONA_HASH_RE = /^0x[0-9a-fA-F]{64}$/

// 写入人格正文:keccak256(body) 必须等于路径里的 hash,否则 400
app.put('/personas/:hash', async (c) => {
  const hash = c.req.param('hash')
  if (!PERSONA_HASH_RE.test(hash)) return c.json({ error: 'hash 必须是 0x+64hex' }, 400)
  const body = await c.req.text()
  if (!body) return c.json({ error: 'body 不能为空' }, 400)
  const actual = keccak256(toBytes(body)) // 哈希按 body 原始字节计算
  if (actual.toLowerCase() !== hash.toLowerCase()) {
    return c.json({ error: `哈希不匹配(声明 ${hash},实际 ${actual})` }, 400)
  }
  try {
    await writePersonaMirror(hash, body)
    return c.json({ ok: true, hash })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 读取人格正文原文;不存在 404
app.get('/personas/:hash', async (c) => {
  const hash = c.req.param('hash')
  if (!PERSONA_HASH_RE.test(hash)) return c.json({ error: 'hash 必须是 0x+64hex' }, 400)
  const text = await readPersonaMirror(hash)
  if (text === null) return c.json({ error: '人格不存在' }, 404)
  return c.text(text)
})

/** 解析路径里的 tokenId,不合法返回 null(已顺手回了 400) */
function parseTokenId(c: Context): number | null {
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    c.json({ error: 'tokenId 不合法' }, 400)
    return null
  }
  return tokenId
}

// 调试用:查看当前装载的人格
app.get('/agents/:tokenId/persona', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const persona = await loadPersona(chainKey, tokenId)
    return c.json(persona)
  } catch (err) {
    return handleErr(c, err)
  }
})

// 强制重新从链上装载人格(用户改配置写链后调用);仅主人可操作
app.post('/agents/:tokenId/reload', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const persona = await reloadAgent(chainKey, tokenId)
    return c.json({ ok: true, persona })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 前端拿的是钱包地址,这个端点最顺手:内部 tokenIdOf 解析;必须本人签名登录
app.post('/agents/by-owner/:address/chat', authRequired, async (c) => {
  const address = c.req.param('address')
  if (!isValidAddress(address)) return c.json({ error: '地址不合法' }, 400)
  const caller = c.get('address')
  // EVM 地址大小写不敏感;base58 区分大小写必须精确匹配
  const sameAddress = (a: string, b: string) =>
    a.startsWith('0x') || b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!sameAddress(caller, address)) {
    return c.json({ error: '只能操作自己的 Agent' }, 403)
  }
  const body = await c.req.json<{ message?: string }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)

  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const tokenId = await resolveTokenId(chainKey, address)
    if (tokenId === 0) return c.json({ error: '该地址还没有铸造 Agent,请先去铸造' }, 404)
    const result = await chatWithAgent(chainKey, tokenId, message, 'owner')
    return c.json({ reply: result.reply, tokenId, refused: result.refused, action: result.action })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 按 tokenId 直连;带 fromTokenId 且指向他人 Agent 时为社交场景,否则为 owner 模式。
// 本端点要求 JWT:owner 模式校验 tokenId 主人身份;social 模式校验 fromTokenId 属于调用者。
app.post('/agents/:tokenId/chat', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ message?: string; fromTokenId?: number }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)
  const fromTokenId = body?.fromTokenId
  if (fromTokenId !== undefined && (!Number.isInteger(fromTokenId) || fromTokenId <= 0)) {
    return c.json({ error: 'fromTokenId 不合法' }, 400)
  }
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const caller = c.get('address')
    // 只有与自己的 Agent 对话时才进入 owner 模式(可操作资产/DeFi);
    // 带有 fromTokenId 且指向他人 Agent 时强制 social 模式(仅聊天)。
    const mode: ChatMode = fromTokenId !== undefined && fromTokenId !== tokenId ? 'social' : 'owner'

    if (mode === 'owner') {
      await assertAgentOwnership(c, chainKey, tokenId)
    } else {
      // social 模式:校验收件人 tokenId 在当前链上真实存在(暂不支持跨链互动)
      try {
        await ownerOf(chainKey, tokenId)
      } catch {
        return c.json({ error: '对方 Agent 不在当前链(暂不支持跨链互动)' }, 400)
      }
      // social 模式:校验 fromTokenId 确实属于调用者,防止伪造发送方
      const callerTokenId = await resolveTokenId(chainKey, caller)
      if (callerTokenId === 0 || callerTokenId !== fromTokenId) {
        return c.json({ error: 'fromTokenId 与登录地址不匹配' }, 403)
      }
    }

    const result = await chatWithAgent(chainKey, tokenId, message, mode, fromTokenId)
    // 社交线程:真人消息(fromTokenId→tokenId, kind='user')+ Agent 回复(tokenId→fromTokenId, kind='auto')
    if (fromTokenId !== undefined) {
      await recordSocialMessage(chainKey, fromTokenId, tokenId, message, 'user')
      await recordSocialMessage(chainKey, tokenId, fromTokenId, result.reply, 'auto')
    }
    return c.json({ reply: result.reply, tokenId, refused: result.refused, action: result.action })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M3:社交收件箱
// ============================================================

// 该 Agent 收到的社交消息(按时间正序,?since=<ISO> 增量拉取);仅主人可查看
app.get('/agents/:tokenId/inbox', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const since = c.req.query('since')
  if (since && Number.isNaN(Date.parse(since))) return c.json({ error: 'since 不是合法时间' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const messages = await getInbox(chainKey, tokenId, since)
    return c.json({ messages })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M2:Agent 状态 / 记忆管理
// ============================================================

// Agent 状态:链上名称、人格来源、记忆统计、已装技能(默认技能自动补齐,首查即 3/3);仅主人
app.get('/agents/:tokenId/status', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const addedSkills = await ensureDefaultSkills(chainKey, tokenId)
    if (addedSkills.length > 0) invalidateAgent(chainKey, tokenId)
    const [persona, counts, skills] = await Promise.all([
      loadPersona(chainKey, tokenId),
      getMemoryCounts(chainKey, tokenId),
      getInstalledSkills(chainKey, tokenId),
    ])
    return c.json({ tokenId, name: persona.name, personaFromChain: persona.fromChain, ...counts, skills })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 个人主页统计:社交互动数 + 近 7 天活跃度(真实活动数据,非静态展示);仅主人
app.get('/agents/:tokenId/stats', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const stats = await getAgentStats(chainKey, tokenId)
    return c.json({ tokenId, ...stats })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 记忆浏览:?kind=episodic|semantic&limit=N;仅主人
app.get('/agents/:tokenId/memories', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const kind = c.req.query('kind')
  if (kind && kind !== 'episodic' && kind !== 'semantic') {
    return c.json({ error: 'kind 只能是 episodic 或 semantic' }, 400)
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const memories = await listMemories(chainKey, tokenId, kind, limit)
    return c.json({ tokenId, memories })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 清空该 Agent 的全部记忆(记忆主权);仅主人
app.delete('/agents/:tokenId/memories', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const deleted = await clearMemories(chainKey, tokenId)
    return c.json({ ok: true, deleted })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 手动触发反思蒸馏(情景 → 语义);仅主人
app.post('/agents/:tokenId/memories/distill', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const result = await distill(chainKey, tokenId)
    return c.json({ ok: true, ...result })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M2:技能安装/卸载
// ============================================================

// 全部可安装技能(清单)
app.get('/skills', (c) => {
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    return c.json({ skills: listSkills(chainKey) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 安装技能(含链上权限校验;未配置 AGENT_SERVICE_ADDRESS 时跳过校验并注明);仅主人
app.post('/agents/:tokenId/skills', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ skillId?: string }>().catch(() => null)
  const skillId = body?.skillId?.trim()
  if (!skillId) return c.json({ error: 'skillId 不能为空' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const { manifest, permissionCheck, note } = await installSkill(chainKey, tokenId, skillId)
    invalidateAgent(chainKey, tokenId) // 工具集变了,下次对话重建 Agent 实例
    return c.json({
      ok: true,
      skill: manifest,
      permissionCheck,
      ...(note ? { note } : {}),
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 卸载技能;仅主人
app.delete('/agents/:tokenId/skills/:skillId', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const skillId = c.req.param('skillId')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const removed = await uninstallSkill(chainKey, tokenId, skillId)
    if (!removed) return c.json({ error: `Agent ${tokenId} 未安装技能 ${skillId}` }, 404)
    invalidateAgent(chainKey, tokenId)
    return c.json({ ok: true, skillId })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// 用户自定义技能管理(由 skill-creator 生成;owner 或被链上授予 PERMISSION_SKILL 的用户可管理)
// ============================================================

// 列出当前 Agent 已安装的用户生成技能
app.get('/agents/:tokenId/user-skills', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentSkillAccess(c, chainKey, tokenId)
    const skills = await getInstalledUserSkills(chainKey, tokenId)
    return c.json({ tokenId, skills })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 通过聊天/表单描述需求,自动生成并安装一个 Python 技能
app.post('/agents/:tokenId/user-skills', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ description?: string }>().catch(() => null)
  const description = body?.description?.trim()
  if (!description) return c.json({ error: 'description 不能为空' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentSkillAccess(c, chainKey, tokenId)
    const createdBy = c.get('address')
    const generated = await generateSkill(description, chainKey, tokenId, createdBy)
    await installGeneratedSkill(generated, chainKey, tokenId)
    invalidateAgent(chainKey, tokenId)
    return c.json({
      ok: true,
      skillId: generated.skillId,
      name: generated.name,
      note: `已生成并安装技能 ${generated.name}。该技能只能读取/处理信息,禁止转账或修改链上状态,且仅当前 Agent 可用。`,
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 删除用户自定义技能:从 DB 卸载、删除物理目录、重载技能表并清空 Agent 缓存
app.delete('/agents/:tokenId/user-skills/:skillId', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const skillId = c.req.param('skillId')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentSkillAccess(c, chainKey, tokenId)
    const removed = await deleteUserSkill(chainKey, tokenId, skillId)
    if (!removed) return c.json({ error: `未找到用户技能 ${skillId}` }, 404)
    removeUserSkillDir(skillId)
    await reloadSkills()
    await syncSkillsToDb()
    invalidateAgent(chainKey, tokenId)
    return c.json({ ok: true, skillId })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// 多对话管理(我的 Agent 助手页;社交场景的 /agents/:tokenId/chat 保留不动)
// ============================================================

// 会话列表(按最近活跃倒序);仅主人
app.get('/agents/:tokenId/conversations', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const conversations = await listConversations(chainKey, tokenId)
    return c.json({ conversations })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 新建会话;仅主人
app.post('/agents/:tokenId/conversations', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const conversation = await createConversation(chainKey, tokenId)
    return c.json({ conversation })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 删除会话(消息级联删除);仅主人
app.delete('/conversations/:id', authRequired, async (c) => {
  const id = c.req.param('id')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const conv = await getConversationById(chainKey, id)
    if (!conv) return c.json({ error: '会话不存在' }, 404)
    await assertAgentOwnership(c, chainKey, conv.tokenId)
    const removed = await deleteConversation(chainKey, id)
    if (!removed) return c.json({ error: '会话不存在' }, 404)
    return c.json({ ok: true })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 会话消息(按时间正序);仅主人
app.get('/conversations/:id/messages', authRequired, async (c) => {
  const id = c.req.param('id')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const conv = await getConversationById(chainKey, id)
    if (!conv) return c.json({ error: '会话不存在' }, 404)
    await assertAgentOwnership(c, chainKey, conv.tokenId)
    const messages = await listMessages(chainKey, id)
    if (messages === null) return c.json({ error: '会话不存在' }, 404)
    return c.json({ messages })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 在会话里对话(tokenId 从会话记录解析);仅主人
app.post('/conversations/:id/chat', authRequired, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ message?: string }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const conv = await getConversationById(chainKey, id)
    if (!conv) return c.json({ error: '会话不存在' }, 404)
    await assertAgentOwnership(c, chainKey, conv.tokenId)
    const result = await chatInConversation(chainKey, conv.tokenId, id, message)
    if (result === null) return c.json({ error: '会话不存在' }, 404)
    return c.json({ reply: result.reply, refused: result.refused, action: result.action })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M4:DeFi 审批
// ============================================================

// 该 Agent 的审批列表(pending 在前);仅主人
app.get('/agents/:tokenId/approvals', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const approvals = await listApprovals(chainKey, tokenId)
    return c.json({ approvals })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 人工放行:执行提案,写 tx_hash,status=executed/failed;仅主人
app.post('/approvals/:id/approve', authRequired, async (c) => {
  const id = c.req.param('id')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const approval = await getApproval(chainKey, id)
    if (!approval) return c.json({ error: '审批单不存在' }, 404)
    await assertAgentOwnership(c, chainKey, approval.tokenId)
    if (approval.status !== 'pending') return c.json({ error: `审批单已是 ${approval.status} 状态,不可重复审批` }, 409)
    try {
      // 按 action 分发:swap 走兑换执行器;supply/withdraw 走借贷执行器;staking 走质押执行器(执行链按提案 chainId 路由)
      const { txHash, amountOut } =
        approval.proposal.action === 'swap'
          ? await executeProposal(chainKey, approval.tokenId, approval.proposal)
          : approval.proposal.action === 'staking'
            ? await executeStakingProposal(chainKey, approval.tokenId, approval.proposal)
            : await executeLendingProposal(chainKey, approval.tokenId, approval.proposal)
      await resolveApproval(id, 'executed', txHash)
      // 浏览器链接按提案目标链拼接(与请求链可能不同)
      const execChainKey = chainKeyByChainId(approval.proposal.chainId) ?? chainKey
      return c.json({ ok: true, status: 'executed', txHash, amountOut, explorer: `${getChainContext(execChainKey).cfg.explorer}/tx/${txHash}` })
    } catch (err) {
      // 执行失败(滑点/余额不足/revert):标 failed,保留人工处置痕迹
      await resolveApproval(id, 'failed')
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, status: 'failed', error: msg.slice(0, 200) }, 502)
    }
  } catch (err) {
    return handleErr(c, err)
  }
})

// 人工拒绝;仅主人
app.post('/approvals/:id/reject', authRequired, async (c) => {
  const id = c.req.param('id')
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const approval = await getApproval(chainKey, id)
    if (!approval) return c.json({ error: '审批单不存在' }, 404)
    await assertAgentOwnership(c, chainKey, approval.tokenId)
    if (approval.status !== 'pending') return c.json({ error: `审批单已是 ${approval.status} 状态,不可重复审批` }, 409)
    await resolveApproval(id, 'rejected')
    return c.json({ ok: true, status: 'rejected' })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M4:Agent 设置(兑换执行模式等)
// ============================================================

// 查询 Agent 设置;仅主人
app.get('/agents/:tokenId/settings', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const swapMode = await getSwapMode(chainKey, tokenId)
    return c.json({ tokenId, swapMode })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 更新 Agent 设置;仅主人
app.post('/agents/:tokenId/settings', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ swapMode?: SwapMode }>().catch(() => null)
  if (!body?.swapMode || (body.swapMode !== 'hot_wallet' && body.swapMode !== 'user_wallet')) {
    return c.json({ error: 'swapMode 必须是 hot_wallet 或 user_wallet' }, 400)
  }
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    await setSwapMode(chainKey, tokenId, body.swapMode)
    return c.json({ ok: true, tokenId, swapMode: body.swapMode })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 用户钱包签名模式:后端广播签名后的 raw transaction;仅主人。
// Solana 交易(protocol=jupiter/meteora)前端浏览器直连公共 RPC 会被 403,
// 签名后交这里由后端经故障转移连接发送;EVM 维持原行为
app.post('/agents/:tokenId/broadcast', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ signedTxs?: string[]; protocol?: string }>().catch(() => null)
  if (!body?.signedTxs || !Array.isArray(body.signedTxs) || body.signedTxs.length === 0) {
    return c.json({ error: 'signedTxs 不能为空数组' }, 400)
  }
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    if (body.protocol === 'jupiter' || body.protocol === 'meteora') {
      const conn = body.protocol === 'meteora' ? mainnetConnection() : solanaConnection(chainKey)
      const txHashes: string[] = []
      for (const signedTx of body.signedTxs) {
        const raw = new Uint8Array(Buffer.from(signedTx, 'base64'))
        txHashes.push(await conn.sendRawTransaction(raw))
      }
      const explorer = body.protocol === 'meteora' ? MAINNET_EXPLORER : getChainContext(chainKey).cfg.explorer
      return c.json({ ok: true, txHashes, explorer })
    }
    const txHashes: Hex[] = []
    for (const signedTx of body.signedTxs) {
      const hash = await broadcastSignedTx(chainKey, signedTx as Hex)
      txHashes.push(hash)
    }
    return c.json({
      ok: true,
      txHashes,
      explorer: getChainContext(chainKey).cfg.explorer,
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 用户钱包签名模式:legacy Solana 交易(Meteora)签名前需刷新 blockhash,
// 浏览器直连公共 RPC 会被 403,改由后端代取;仅主人
app.post('/agents/:tokenId/solana-blockhash', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ protocol?: string }>().catch(() => null)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const conn = body?.protocol === 'meteora' ? mainnetConnection() : solanaConnection(chainKey)
    const latest = await conn.getLatestBlockhash()
    return c.json({ ok: true, ...latest })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 用户钱包签名模式:前端已用钱包直接发送交易;后端核实回执(swap 解析 Swap 事件实际输出),
// 记 tasks 审计表,并在会话里追加一条 assistant 消息主动告知主人结果;仅主人
app.post('/agents/:tokenId/sign-confirm', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req
    .json<{ txHash?: string; proposal?: { action: string }; conversationId?: string }>()
    .catch(() => null)
  if (!body?.txHash || typeof body.txHash !== 'string') {
    return c.json({ error: 'txHash 不能为空' }, 400)
  }
  const action = body?.proposal?.action
  if (!action || !['swap', 'supply', 'withdraw', 'staking', 'gmx_order'].includes(action)) {
    return c.json({ error: 'proposal.action 必须是 swap / supply / withdraw / staking / gmx_order' }, 400)
  }
  const proposal = body.proposal as Proposal
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    // Solana 家族(Jupiter / Meteora):前端 Phantom 已签名自广播,这里走链上确认 + 解析实际输出
    // 注意必须 await:confirmSolanaSign 的异步异常要能被下方 catch 兜住,不能逃逸成裸 500
    if (proposal.protocol === 'jupiter' || proposal.protocol === 'meteora') {
      return await confirmSolanaSign(c, chainKey, tokenId, body.txHash, proposal, body.conversationId)
    }
    const receipt = await waitForTxReceipt(chainKey, body.txHash as Hex)
    if (receipt.status !== 'success') {
      // revert:记失败任务(不计入限额),主动告知失败
      await recordDefiTask(chainKey, tokenId, proposal, { txHash: body.txHash, amountOut: '0', usdValue: null }, 'failed')
      const notice =
        action === 'gmx_order'
          ? describeGmxResult(chainKey, proposal, { confirmed: false, reverted: true })
          : describeSwapResult(chainKey, proposal, { confirmed: false, reverted: true, amountOut: null })
      if (body.conversationId) await appendAssistantMessage(chainKey, body.conversationId, notice)
      return c.json({ ok: true, confirmed: false, reverted: true, notice })
    }
    // 仅 swap 需要解析 Swap 事件拿实际输出;supply/withdraw/gmx_order 以提案金额为准
    const parsed = action === 'swap' ? parseSwapAmountOut(receipt) : null
    const amountOut = parsed?.amountOut ?? null
    await recordDefiTask(chainKey, tokenId, proposal, {
      txHash: body.txHash,
      amountOut: amountOut?.toString() ?? '0',
      usdValue: proposal.estimatedValueUsd ?? null,
    })
    const notice =
      action === 'gmx_order'
        ? describeGmxResult(chainKey, proposal, { confirmed: true, reverted: false })
        : describeSwapResult(chainKey, proposal, { confirmed: true, reverted: false, amountOut })
    if (body.conversationId) await appendAssistantMessage(chainKey, body.conversationId, notice)
    return c.json({
      ok: true,
      confirmed: true,
      amountOut: amountOut?.toString() ?? null,
      notice,
      explorer: `${getChainContext(chainKey).cfg.explorer}/tx/${body.txHash}`,
    })
  } catch (err) {
    // 回执超时/链上查询失败:不阻塞前端,记一笔待确认(金额 0),让 Agent 稍后自查
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[sign-confirm] 回执核实失败,按待确认处理:', msg)
    try {
      const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
      await recordDefiTask(chainKey, tokenId, proposal, { txHash: body.txHash, amountOut: '0', usdValue: proposal.estimatedValueUsd ?? null })
      const notice =
        action === 'gmx_order'
          ? describeGmxResult(chainKey, proposal, { confirmed: false, reverted: false })
          : describeSwapResult(chainKey, proposal, { confirmed: false, reverted: false, amountOut: null })
      if (body.conversationId) await appendAssistantMessage(chainKey, body.conversationId, notice)
      return c.json({ ok: true, confirmed: false, amountOut: null, notice })
    } catch (err2) {
      // 兜底中的兜底:审计/消息追加再失败也不返回 500,绝不让前端拿到裸错误
      return c.json({ ok: true, confirmed: false, amountOut: null, notice: '交易已广播,结果核实遇到故障,签名已记录,稍后帮你确认' })
    }
  }
})


/** Solana 请求链浏览器交易链接(solana 的 explorer 带 ?cluster= 时路径要拼在 query 之前) */
function solanaTxUrl(chainKey: string, signature: string): string {
  const explorer = getChainContext(chainKey).cfg.explorer
  return explorer.includes('?')
    ? `${explorer.split('?')[0]}/tx/${signature}?${explorer.split('?')[1]}`
    : `${explorer}/tx/${signature}`
}

/** 从已确认交易的 parsed meta 解析主人实际收到的输出:
 * SOL 按 lamports 增量还原(owner 即 feePayer,增量已扣手续费,加回得实收);
 * 代币按 postTokenBalances(owner+mint 匹配)取原始金额。解析失败返回 null */
async function parseSolanaSwapOut(
  conn: FailoverConnection,
  txHash: string,
  owner: string,
  outMint: string,
  outIsNative: boolean,
): Promise<bigint | null> {
  const parsed = await conn.getParsedTransaction(txHash)
  const meta = parsed?.meta
  if (!meta || meta.err) return null
  if (outIsNative) {
    const keys = parsed.transaction.message.accountKeys
    const idx = keys.findIndex((k) => ('pubkey' in k ? k.pubkey.toBase58() : String(k)) === owner)
    if (idx < 0) return null
    const delta = BigInt(meta.postBalances[idx] ?? 0) - BigInt(meta.preBalances[idx] ?? 0)
    return delta + BigInt(meta.fee)
  }
  const post = (meta.postTokenBalances ?? []).find((b) => b.mint === outMint && b.owner === owner)
  if (!post) return null
  return BigInt(post.uiTokenAmount.amount)
}

/** Promise 硬超时包装:超时整体 reject,不留下挂起的确认等待 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`确认超时(${Math.round(ms / 1000)}s)`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

/** Solana 家族(Jupiter / Meteora)的 sign-confirm:
 * 链上确认(Meteora 主网 / Jupiter 请求链)→ 解析实际输出 → 记 tasks 审计表 → 追加 assistant 消息 */
async function confirmSolanaSign(
  c: Context,
  chainKey: string,
  tokenId: number,
  txHash: string,
  proposal: Proposal,
  conversationId?: string,
) {
  const isMeteora = proposal.protocol === 'meteora'
  // Meteora 在主网执行(与热钱包路径同记 EXEC_CHAIN_KEY);Jupiter 在请求链执行
  const taskChainKey = isMeteora ? EXEC_CHAIN_KEY : chainKey
  const conn = isMeteora ? mainnetConnection() : solanaConnection(chainKey)
  const params = proposal.params
  const owner = params.owner ?? ''
  const outMint = params.tokenOut === 'SOL' ? SOL_MINT : isMeteora ? MAINNET_USDC_MINT : usdcMintOf(chainKey)
  const amountInHuman = formatUnits(BigInt(params.amountIn), params.tokenIn === 'SOL' ? 9 : 6)
  const txUrl = isMeteora ? mainnetTxUrl(txHash) : solanaTxUrl(chainKey, txHash)
  const noticeOf = (amountOut: bigint | null, confirmed: boolean): string => {
    if (!confirmed) return `你的签名交易已广播,但链上还没确认到账,我把签名记下了,稍后帮你盯一下。`
    if (amountOut == null) {
      return `已确认你的兑换成交(${amountInHuman} ${params.tokenIn} → ${params.tokenOut}),但实际输出解析失败,明细以浏览器为准:${txUrl}`
    }
    return `已确认你的兑换成交:${amountInHuman} ${params.tokenIn} 换得 ${formatUnits(amountOut, params.tokenOut === 'SOL' ? 9 : 6)} ${params.tokenOut}。交易签名 ${txHash},浏览器明细:${txUrl}`
  }
  const record = (amountOut: string, status: 'done' | 'failed' = 'done') =>
    recordDefiTask(taskChainKey, tokenId, proposal, { txHash, amountOut, usdValue: proposal.estimatedValueUsd ?? null }, status)

  try {
    // 硬超时兜底:确认卡住时按待确认处理,绝不无限挂起前端请求
    await withTimeout(conn.confirmTransaction(txHash), 60_000)
  } catch (err) {
    // 确认超时/RPC 失败:不阻塞前端,记一笔待确认(金额 0),让 Agent 稍后自查
    console.warn('[sign-confirm] Solana 确认失败,按待确认处理:', err instanceof Error ? err.message : String(err))
    try {
      await record('0')
      const notice = noticeOf(null, false)
      if (conversationId) await appendAssistantMessage(chainKey, conversationId, notice)
      return c.json({ ok: true, confirmed: false, amountOut: null, notice })
    } catch (err2) {
      return c.json({ ok: true, confirmed: false, amountOut: null, notice: noticeOf(null, false) })
    }
  }
  // 确认后解析失败不影响审计主流程:金额记 0,文案提示以浏览器为准
  let amountOut: bigint | null = null
  try {
    amountOut = await parseSolanaSwapOut(conn, txHash, owner, outMint, params.tokenOut === 'SOL')
  } catch (err) {
    console.warn('[sign-confirm] Solana 输出解析失败:', err instanceof Error ? err.message : String(err))
  }
  try {
    await record(amountOut?.toString() ?? '0')
    const notice = noticeOf(amountOut, true)
    if (conversationId) await appendAssistantMessage(chainKey, conversationId, notice)
    return c.json({ ok: true, confirmed: true, amountOut: amountOut?.toString() ?? null, notice, explorer: txUrl })
  } catch (err) {
    // 落库/追加消息失败不掩盖已确认事实
    return c.json({ ok: true, confirmed: true, amountOut: amountOut?.toString() ?? null, notice: noticeOf(amountOut, true), explorer: txUrl })
  }
}

/** GMX 订单签名确认后的人类可读结果描述 */
function describeGmxResult(
  chainKey: string,
  proposal: Proposal,
  r: { confirmed: boolean; reverted: boolean },
): string {
  const cfg = getChainContext(chainKey).cfg
  const { params } = proposal
  const marketSymbol = (params.tokenOut ?? 'GMX').toUpperCase()
  const sizeUsdHuman = params.amountOutMin ? formatUnits(BigInt(params.amountOutMin), 30) : '未知'
  const collateralSymbol = params.tokenIn === 'native' ? cfg.defi!.nativeSymbol : tokenSymbolOf(chainKey, params.tokenIn as Address)
  const collateralDecimals = collateralSymbol === cfg.defi!.nativeSymbol ? 18 : 6
  const collateralHuman = params.amountIn ? formatUnits(BigInt(params.amountIn), collateralDecimals) : '未知'

  if (r.reverted) {
    return `刚才那笔 GMX 订单没能成交:${marketSymbol} ${sizeUsdHuman} USD 方向订单在链上执行失败(revert),抵押品 ${collateralHuman} ${collateralSymbol} 没有动用。要我重新组装一笔吗?`
  }
  if (!r.confirmed) {
    return `你的 GMX 订单已广播,链上还没确认成交,我把哈希记下了,稍后帮你盯一下。`
  }
  return `已确认你的 GMX 订单上链:${marketSymbol} ${sizeUsdHuman} USD 方向订单已提交,抵押 ${collateralHuman} ${collateralSymbol}。订单由 GMX keeper 执行后仓位会更新,稍后你可以在仓位查询里看到。`
}

// ============================================================
// 竞技场(Arena,P1):赛季管理(admin)、报名注册、紧急冻结、Playbook 配置、排行榜
// 链上裁决在 ArenaAccount/ArenaSeason 合约(见 knowledge/arena-mode-design.md);
// 本层只做交易组装、回执解析与落库
// ============================================================

// 赛季列表(公开;status 为派生态:created/open/active/settling/settled)
app.get('/arena/seasons', async (c) => {
  try {
    // all=1:跨链全量(管理端用);默认按当前激活链过滤(用户端用)
    const all = c.req.query('all') === '1'
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    const rows = await listArenaSeasons(all ? undefined : chainKey)
    const nowSec = Math.floor(Date.now() / 1000)
    return c.json({ seasons: rows.map((r) => ({ ...r, status: deriveSeasonStatus(r, nowSec) })) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 赛季详情 + 排行榜(公开)
app.get('/arena/seasons/:id', async (c) => {
  try {
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const nowSec = Math.floor(Date.now() / 1000)
    const accounts = await leaderboardOf(season.id)
    return c.json({ season: { ...season, status: deriveSeasonStatus(season, nowSec) }, leaderboard: accounts })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 创建赛季(admin):金额/时长可配;链上合约由部署脚本产出地址后经 PUT 回填
app.post('/admin/arena/seasons', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{
      chain_key?: string
      usdc_address?: string
      principal_usd?: number
      fuel_usd?: number
      start_ts?: number
      end_ts?: number
      config?: Record<string, unknown>
    }>().catch(() => null)
    if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
    const chainKey = body.chain_key ?? resolveChainKey(c.req.header('X-Chain-Key'))
    const chainCfg = getChainContext(chainKey).cfg // 校验链存在
    // USDC 地址:显式传入优先,缺省回落链配置(defi.usdc),都没有才拒绝
    const usdc = body.usdc_address ?? (chainCfg.defi && chainCfg.defi.usdc !== '0x0000000000000000000000000000000000000000' ? chainCfg.defi.usdc : '')
    if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) {
      return c.json({ error: 'usdc_address 缺失:请在表单填写,或先在链配置(/admin/chains)中配置 defi.usdc' }, 400)
    }
    body.usdc_address = usdc
    if (!(body.principal_usd! > 0) || !(body.fuel_usd! >= 0)) return c.json({ error: 'principal_usd 必须为正、fuel_usd 必须非负' }, 400)
    if (!Number.isInteger(body.start_ts) || !Number.isInteger(body.end_ts) || body.end_ts! <= body.start_ts!) {
      return c.json({ error: 'start_ts/end_ts 必须是整数且 end_ts > start_ts' }, 400)
    }
    const id = `season-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // config 默认:赛季固定模型(缺省用全局模型,开赛前后不允许换)+ 燃料计价默认项
    const seasonConfig = { llmModel: config.llmModel, priceMarkup: 1.0, ...(body.config ?? {}) }
    await insertArenaSeason({
      id,
      chain_key: chainKey,
      season_address: '',
      account_impl_address: '',
      usdc_address: body.usdc_address!.toLowerCase(),
      principal_usd: String(body.principal_usd),
      fuel_usd: String(body.fuel_usd),
      start_ts: body.start_ts!,
      end_ts: body.end_ts!,
      status: 'created',
      config: seasonConfig,
      created_by: c.get('address'),
    })
    await insertAudit({ adminAddress: c.get('address'), action: 'create_arena_season', target: id, payload: body })
    return c.json({ ok: true, season: await loadSeasonOrThrow(id) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 赛季参数/地址回填(admin):部署 ArenaSeason + ArenaAccount 实现后回填地址,赛季进入 open
app.put('/admin/arena/seasons/:id', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{
      season_address?: string
      account_impl_address?: string
      status?: string
      config?: Record<string, unknown>
    }>().catch(() => null)
    if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
    const patch: Record<string, unknown> = {}
    for (const k of ['season_address', 'account_impl_address', 'status'] as const) {
      if (body[k] !== undefined) {
        if (k !== 'status' && !/^0x[0-9a-fA-F]{40}$/.test(body[k]!)) return c.json({ error: `${k} 必须是 EVM 地址` }, 400)
        patch[k] = body[k]!.toLowerCase()
      }
    }
    if (body.config !== undefined) patch.config = body.config
    // 推进到 open 的硬约束:链上地址已回填 + 赛季固定模型已配置(不可换模型是竞技公平底线)
    if (body.status === 'open') {
      const cur = await loadSeasonOrThrow(c.req.param('id'))
      const merged = { ...(cur.config ?? {}), ...(body.config ?? {}) } as Record<string, unknown>
      const hasAddr = (body.season_address ?? cur.season_address) && (body.account_impl_address ?? cur.account_impl_address)
      if (!hasAddr) return c.json({ error: '进入 open 前必须回填 season_address 与 account_impl_address' }, 409)
      if (typeof merged.llmModel !== 'string' || !merged.llmModel) return c.json({ error: '进入 open 前必须配置 config.llmModel(赛季固定模型)' }, 409)
    }
    const ok = await updateArenaSeason(c.req.param('id'), patch)
    if (!ok) return c.json({ error: '赛季不存在或无有效字段' }, 404)
    await insertAudit({ adminAddress: c.get('address'), action: 'update_arena_season', target: c.req.param('id'), payload: body })
    return c.json({ ok: true, season: await loadSeasonOrThrow(c.req.param('id')) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 建议白名单(公开):按链配置生成 Aave/GMX/DEX 常用方法,管理端表单预填用
app.get('/arena/whitelist-template', async (c) => {
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    return c.json({ entries: whitelistTemplate(chainKey) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 一键部署:组装三笔部署交易(账户实现 → 赛季实现 → 赛季代理),管理员钱包签名广播
app.post('/admin/arena/seasons/:id/deploy-txs', chainAdminRequired, async (c) => {
  try {
    const season = await loadSeasonOrThrow(c.req.param('id'))
    if (season.season_address) return c.json({ error: '该赛季已部署合约' }, 409)
    const bundle = await buildDeployTxs(season, c.get('address') as Address)
    return c.json({ ok: true, ...bundle })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 部署确认:解析三笔回执的实际合约地址,回填赛季(预测失配会报错并提示)
app.post('/admin/arena/seasons/:id/deploy-confirm', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{ txHashes?: string[] }>().catch(() => null)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    if (!body?.txHashes || body.txHashes.length !== 3) return c.json({ error: '需要三笔部署交易的 txHashes' }, 400)
    const addrs = await resolveDeployReceipts(season.chain_key, body.txHashes)
    if (season.account_impl_address && season.account_impl_address !== addrs.accountImpl.toLowerCase()) {
      return c.json({ error: `账户实现地址与预测失配(预测 ${season.account_impl_address} 实际 ${addrs.accountImpl}),请检查是否有其他交易占用 nonce 后重试` }, 409)
    }
    await updateArenaSeason(season.id, { season_address: addrs.seasonProxy.toLowerCase(), account_impl_address: addrs.accountImpl.toLowerCase() })
    await insertAudit({ adminAddress: c.get('address'), action: 'arena_deploy', target: season.id, payload: addrs })
    return c.json({ ok: true, ...addrs })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 白名单上链(组装 unsigned tx,管理员签名):entries = [{target, selector 或方法签名, allowed}]
app.post('/admin/arena/seasons/:id/whitelist-txs', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{ entries?: { target?: string; selector?: string; allowed?: boolean }[] }>().catch(() => null)
    const entries = body?.entries ?? []
    if (entries.length === 0) return c.json({ error: 'entries 不能为空' }, 400)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    if (!season.season_address) return c.json({ error: '赛季合约尚未部署' }, 409)
    const parsed = entries.map((e) => {
      if (!e.target?.match(/^0x[0-9a-fA-F]{40}$/)) throw new ArenaError(`target 地址非法: ${e.target}`)
      let sel = e.selector ?? ''
      if (/^0x[0-9a-fA-F]{8}$/.test(sel)) sel = sel.toLowerCase()
      else if (sel.includes('(')) sel = toFunctionSelector(sel as ViemHex).toLowerCase()
      else throw new ArenaError(`selector 非法(需 0x 四字节或方法签名): ${e.selector}`)
      return { target: e.target.toLowerCase(), selector: sel, allowed: e.allowed ?? true }
    })
    return c.json({ ok: true, txs: [buildWhitelistTx(season, parsed)] })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 白名单确认:核实链上回执
app.post('/admin/arena/seasons/:id/whitelist-confirm', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{ txHash?: string }>().catch(() => null)
    if (!body?.txHash?.match(/^0x[0-9a-fA-F]{64}$/)) return c.json({ error: 'txHash 格式不正确' }, 400)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const receipt = await waitForTxReceipt(season.chain_key, body.txHash as ViemHex)
    if (receipt.status !== 'success') return c.json({ error: '白名单交易未成功执行' }, 400)
    const hit = receipt.logs.some((l: { address: string }) => l.address.toLowerCase() === season.season_address.toLowerCase())
    if (!hit) return c.json({ error: '回执中找不到赛季合约事件' }, 400)
    await insertAudit({ adminAddress: c.get('address'), action: 'arena_whitelist', target: season.id, payload: { txHash: body.txHash } })
    return c.json({ ok: true })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 结算交易组装(admin):未熔断先 haltTrading + 逐账户 recordResult,owner 钱包签名广播
app.post('/admin/arena/seasons/:id/settle-txs', chainAdminRequired, async (c) => {
  try {
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const r = await buildSettleTxs(season)
    return c.json({ ok: true, txs: r.txs, targets: r.targets })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 结算确认(admin):解析 ResultRecorded 事件落库;全部结清自动归档赛季
app.post('/admin/arena/seasons/:id/settle-confirm', chainAdminRequired, async (c) => {
  try {
    const body = await c.req.json<{ txHashes?: string[] }>().catch(() => null)
    if (!body?.txHashes?.length) return c.json({ error: 'txHashes 不能为空' }, 400)
    const r = await confirmSettleTxs(c.req.param('id'), body.txHashes)
    await insertAudit({ adminAddress: c.get('address'), action: 'arena_settle_confirm', target: c.req.param('id'), payload: r })
    return c.json({ ok: true, ...r })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 手动结算某个账户(admin):退赛(frozen)或到期账户立即 recordResult(服务端签名,仅当服务端密钥=合约 owner 时可用)
app.post('/admin/arena/seasons/:id/agents/:tokenId/settle', chainAdminRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const account = await getArenaAccount(season.id, tokenId)
    if (!account) return c.json({ error: '该 Agent 未报名本赛季' }, 404)
    if (account.phase === 'settled') return c.json({ error: '已结算' }, 409)
    const r = await settleAccount(season, account)
    await insertAudit({ adminAddress: c.get('address'), action: 'arena_settle', target: `${season.id}/${tokenId}`, payload: r })
    return c.json({ ok: true, navUsd: r.navUsd, txHash: r.txHash })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 报名:组装 approve + register 两笔 unsigned tx,owner 钱包逐笔签名(前端 chainDispatch 发送)
// tokenId 从请求体取(路径里没有 :tokenId 段;parseTokenId 读 URL 参数会 NaN)
function parseBodyTokenId(body: unknown): number | null {
  const tokenId = (body as { tokenId?: unknown } | null)?.tokenId
  return typeof tokenId === 'number' && Number.isInteger(tokenId) && tokenId > 0 ? tokenId : null
}

app.post('/arena/seasons/:id/register', authRequired, async (c) => {
  const body = await c.req.json<{ tokenId?: number }>().catch(() => null)
  const tokenId = parseBodyTokenId(body)
  if (tokenId === null) return c.json({ error: 'tokenId 不合法' }, 400)
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    // 不校验 agent 归属:报名是自愿出资行为,USDC 扣款由链上 transferFrom 强制签名方付款;
    // 前端只列出当前钱包的 agent,误选无损失
    const season = await loadSeasonOrThrow(c.req.param('id'))
    if (season.chain_key !== chainKey) return c.json({ error: '请求链与赛季链不一致' }, 400)
    // 报名门槛 = 合约已部署 + 赛季未结束(开赛后随时可中途加入,与链上 register 同源:
    // startTime 只控制交易窗口,endTime 前都可报名)
    const nowSec = Math.floor(Date.now() / 1000)
    if (!season.season_address) return c.json({ error: '赛季合约尚未部署' }, 409)
    if (nowSec >= season.end_ts) return c.json({ error: '赛季已结束,无法报名' }, 409)
    if (await getArenaAccount(season.id, tokenId)) return c.json({ error: '该 Agent 已报名本赛季' }, 409)
    const txs = buildRegisterTxs(season, tokenId, c.get('address') as Address)
    return c.json({ ok: true, txs, season: { id: season.id, principal_usd: season.principal_usd, fuel_usd: season.fuel_usd } })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 注册确认:前端发送 register 交易后回传 txHash,后端解析 Registered 事件落库(账户地址以链上为准)
app.post('/arena/seasons/:id/register-confirm', authRequired, async (c) => {
  try {
    const body = await c.req.json<{ txHash?: string; tokenId?: number }>().catch(() => null)
    const tokenId = parseBodyTokenId(body)
    if (tokenId === null) return c.json({ error: 'tokenId 不合法' }, 400)
    if (!body?.txHash?.match(/^0x[0-9a-fA-F]{64}$/)) return c.json({ error: 'txHash 格式不正确' }, 400)
    const account = await confirmRegister(c.req.param('id'), tokenId, c.get('address'), body.txHash)
    return c.json({ ok: true, account })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 我的参赛账户查询(owner)
app.get('/arena/seasons/:id/agents/:tokenId', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const account = await getArenaAccount(season.id, tokenId)
    if (!account) return c.json({ error: '该 Agent 未报名本赛季' }, 404)
    const playbook = await getPlaybook(season.id, tokenId)
    const fuel = await getArenaFuel(season.id, tokenId)
    const fuelCfg = fuelConfigOf(season, config.llmModel)
    const gate = fuel ? await decisionGate(season.id, tokenId, fuelCfg) : null
    return c.json({
      account,
      playbook: playbook?.config ?? null,
      playbookVersion: playbook?.version ?? 0,
      fuel: fuel ? { balance_usd: fuel.balance_usd, total_spent_usd: fuel.total_spent_usd, decision_halted: gate?.halted ?? false } : null,
      llmModel: fuelCfg.llmModel,
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// Playbook 保存(owner 赛季中可改,版本化留历史)
app.put('/arena/seasons/:id/agents/:tokenId/playbook', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const body = await c.req.json<{ config?: unknown }>().catch(() => null)
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const account = await getArenaAccount(season.id, tokenId)
    if (!account) return c.json({ error: '该 Agent 未报名本赛季' }, 404)
    if (account.phase !== 'active') return c.json({ error: `当前状态(${account.phase})不可修改策略` }, 409)
    const config = validatePlaybook(body?.config)
    const version = await savePlaybook(season.id, tokenId, config, c.get('address'))
    return c.json({ ok: true, version })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 结算后提取:组装 withdraw(USDC) + withdrawNative 两笔 unsigned tx,owner 签名
app.post('/arena/seasons/:id/agents/:tokenId/withdraw', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const account = await getArenaAccount(season.id, tokenId)
    if (!account) return c.json({ error: '该 Agent 未报名本赛季' }, 404)
    if (account.phase !== 'settled') return c.json({ error: '账户尚未结算,无法提取(紧急停止后等待平台结算)' }, 409)
    return c.json({ ok: true, txs: buildWithdrawTxs(season, account) })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 提取确认:核实链上回执
app.post('/arena/seasons/:id/agents/:tokenId/withdraw-confirm', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const body = await c.req.json<{ txHash?: string }>().catch(() => null)
    if (!body?.txHash?.match(/^0x[0-9a-fA-F]{64}$/)) return c.json({ error: 'txHash 格式不正确' }, 400)
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    await confirmWithdraw(c.req.param('id'), tokenId, body.txHash)
    return c.json({ ok: true })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 动作记录(owner):谁(该 agent)、哪个赛季、做了什么(策略/动作/tx/盈亏),时间倒序
app.get('/arena/seasons/:id/agents/:tokenId/trades', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
    const { listArenaTrades } = await import('./db/arena')
    const trades = await listArenaTrades(season.id, tokenId, limit)
    return c.json({ trades })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 动作记录(admin):管理员可查看任意 agent 的竞技场交易流水(用于排查日志不全问题)
app.get('/admin/arena/seasons/:id/agents/:tokenId/trades', chainAdminRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
    const { listArenaTrades } = await import('./db/arena')
    const trades = await listArenaTrades(season.id, tokenId, limit)
    return c.json({ trades })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 净值曲线(owner):按时间升序返回快照
app.get('/arena/seasons/:id/agents/:tokenId/snapshots', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const limit = Math.min(Number(c.req.query('limit')) || 200, 500)
    const db = await (await import('./db')).getDb()
    const res = await db.query(
      `SELECT nav_usd::text AS nav_usd, breakdown, created_at FROM arena_snapshots
       WHERE season_id = $1 AND token_id = $2 ORDER BY created_at ASC LIMIT $3`,
      [season.id, tokenId, limit],
    )
    return c.json({ snapshots: res.rows })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 紧急冻结:组装 freeze unsigned tx,owner 一笔签名
app.post('/arena/seasons/:id/agents/:tokenId/freeze', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    const season = await loadSeasonOrThrow(c.req.param('id'))
    const account = await getArenaAccount(season.id, tokenId)
    if (!account) return c.json({ error: '该 Agent 未报名本赛季' }, 404)
    if (account.phase !== 'active') return c.json({ error: `当前状态(${account.phase})不可冻结` }, 409)
    return c.json({ ok: true, txs: [buildFreezeTx(season, account)] })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 冻结确认:解析链上 Frozen 事件后置 frozen(等待平台结算后退赛取回)
app.post('/arena/seasons/:id/agents/:tokenId/freeze-confirm', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const body = await c.req.json<{ txHash?: string }>().catch(() => null)
    if (!body?.txHash?.match(/^0x[0-9a-fA-F]{64}$/)) return c.json({ error: 'txHash 格式不正确' }, 400)
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    await confirmFreeze(c.req.param('id'), tokenId, body.txHash)
    return c.json({ ok: true })
  } catch (err) {
    return handleErr(c, err)
  }
})


/** 统一错误出口:人格完整性问题 422,技能问题按其 status,竞技场按其 status,LLM 网关异常 502,其余 500 */
function handleErr(c: Context, err: unknown) {
  if (err instanceof AuthError) {
    return c.json({ error: err.message }, err.status)
  }
  if (err instanceof ArenaError) {
    return c.json({ error: err.message }, err.status)
  }
  if (err instanceof PersonaError) {
    return c.json({ error: err.message }, 422)
  }
  if (err instanceof SkillError) {
    return c.json({ error: err.message }, err.status)
  }
  const msg = err instanceof Error ? err.message : String(err)
  // 未知链是客户端错误,直接 400
  if (msg.startsWith('未知链:')) {
    return c.json({ error: msg }, 400)
  }
  // LLM 网关专属错误(不再把链上 RPC/外部 API 的张冠李戴到 LLM 头上)
  if (/LLM|chat\/completions|aiping|网关|gateway|429/i.test(msg)) {
    console.error('[llm]', msg)
    return c.json({ error: 'LLM 网关暂时不可用,请稍后重试' }, 502)
  }
  // 链上 RPC / 外部行情 API 等上游网络故障:如实告知类别
  if (/fetch|network|timeout|ECONN|ETIMEDOUT|5\d\d/i.test(msg)) {
    console.error('[upstream]', msg)
    return c.json({ error: '网络请求失败(链上节点或外部 API),请稍后重试: ' + msg.slice(0, 80) }, 502)
  }
  console.error('[internal]', msg)
  return c.json({ error: '服务内部错误: ' + msg.slice(0, 120) }, 500)
}

async function main() {
  // 先建表、同步内置技能清单与链配置种子数据,再开始接请求
  await initSchema()
  await seedChains(
    Object.entries(ALL_CHAINS).map(([key, c]) => ({
      chain_key: key,
      chain_id: c.chainId,
      name: c.name,
      identity_address: c.identityAddress,
      parts_address: c.partsAddress,
      rpc: c.rpc,
      explorer: c.explorer,
      family: c.family,
      // 扩展配置(defi/aave/行情源/solana/新手装备领养合约/铸造直售市场)落 chains.config 列;只在新行插入时写入,不重载手工改动
      config: {
        ...(c.defi ? { defi: c.defi } : {}),
        ...(c.aave ? { aave: c.aave } : {}),
        ...(c.nativePriceId ? { nativePriceId: c.nativePriceId } : {}),
        ...(c.nativeGatePair ? { nativeGatePair: c.nativeGatePair } : {}),
        ...(c.rpcFallbacks ? { rpcFallbacks: c.rpcFallbacks } : {}),
        ...(c.solana ? { solana: c.solana } : {}),
        ...(c.partsClaim ? { partsClaim: c.partsClaim } : {}),
        ...(c.market ? { market: c.market } : {}),
        ...(c.benqi ? { benqi: c.benqi } : {}),
      },
    })),
  )
  // 链配置下沉 + DB-only 动态链:chains 表是权威,注入注册表(DB 不可达时回落 config.ts)
  applyDbChains(await listChains())
  applyDbChainConfigs(await loadChainConfigsFromDb())
  // 协议表 seeding:每链无行时从合并后 ChainConfig 推导初始协议行(已有行不动),随后刷新 gating 缓存
  const seeded = await seedChainProtocols()
  if (seeded.length > 0) console.log(`[protocols] 已 seed 初始协议行: ${seeded.join(', ')}`)
  refreshProtocolCache(await listChainProtocols())
  // 引导首个管理员:白名单为空且配置了 ADMIN_ADDRESS 时写入(added_by='bootstrap'),幂等
  if ((await countAdmins()) === 0 && config.adminAddress) {
    await addAdmin(config.adminAddress, 'bootstrap')
    console.log(`[admin] 已引导首个管理员: ${config.adminAddress}`)
  }
  // 从 runtime-skills/ 目录加载内置技能与用户技能,再同步清单到 DB
  await loadSkills()
  await syncSkillsToDb()
  startScheduler() // M3:心跳驱动自主社交
  startArenaScheduler() // P4:竞技场统一调度(两层 tick + 燃料闸门)
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Agent 服务已启动: http://localhost:${info.port} (模型: ${config.llmModel}, 链: ${config.chain.name})`)
  })
  // 正常退出时优雅关闭调度器与 PGlite,避免数据目录残留锁/半成品 checkpoint
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopScheduler()
      stopArenaScheduler()
      closeDb().finally(() => process.exit(0))
    })
  }
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
