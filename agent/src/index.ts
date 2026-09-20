import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { isAddress, type Address } from 'viem'
import { config } from './config'
import { PersonaError, loadPersona, resolveTokenId } from './chain/persona'
import { chatWithAgent, invalidateAgent, reloadAgent } from './core/agent'
import { clearMemories, distill, getMemoryCounts, listMemories } from './core/memory'
import {
  chatInConversation,
  createConversation,
  deleteConversation,
  getConversationById,
  listConversations,
  listMessages,
} from './core/conversation'
import { initSchema, closeDb, listChains, seedChains } from './db'
import { ALL_CHAINS } from './config'
import { SkillError, getInstalledSkills, installSkill, listSkills, syncSkillsToDb, uninstallSkill } from './skills'

// ============================================================
// API 网关(hono):健康检查、人格调试、对话,以及 M2 的记忆/技能管理端点
// ============================================================

const app = new Hono()

// 前端 dev 服务器固定跑在 5173
app.use('/*', cors({ origin: ['http://localhost:5173'] }))

app.get('/health', (c) => c.json({ ok: true }))

// 各链合约地址查询(数据源是 chains 表;前端另存本地兜底,服务不可达时用本地数据)
app.get('/chains', async (c) => {
  try {
    const chains = await listChains()
    return c.json({ chains })
  } catch (err) {
    return handleErr(c, err)
  }
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
    const persona = await loadPersona(tokenId)
    return c.json(persona)
  } catch (err) {
    return handleErr(c, err)
  }
})

// 强制重新从链上装载人格(用户改配置写链后调用)
app.post('/agents/:tokenId/reload', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const persona = await reloadAgent(tokenId)
    return c.json({ ok: true, persona })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 前端拿的是钱包地址,这个端点最顺手:内部 tokenIdOf 解析
app.post('/agents/by-owner/:address/chat', async (c) => {
  const address = c.req.param('address')
  if (!isAddress(address)) return c.json({ error: '地址不合法' }, 400)
  const body = await c.req.json<{ message?: string }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)

  try {
    const tokenId = await resolveTokenId(address as Address)
    if (tokenId === 0) return c.json({ error: '该地址还没有铸造 Agent,请先去铸造' }, 404)
    const result = await chatWithAgent(tokenId, message)
    return c.json({ reply: result.reply, tokenId, refused: result.refused })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 按 tokenId 直连(调试/内部用)
app.post('/agents/:tokenId/chat', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ message?: string }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)
  try {
    const result = await chatWithAgent(tokenId, message)
    return c.json({ reply: result.reply, tokenId, refused: result.refused })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M2:Agent 状态 / 记忆管理
// ============================================================

// Agent 状态:链上名称、人格来源、记忆统计、已装技能
app.get('/agents/:tokenId/status', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const [persona, counts, skills] = await Promise.all([
      loadPersona(tokenId),
      getMemoryCounts(tokenId),
      getInstalledSkills(tokenId),
    ])
    return c.json({ tokenId, name: persona.name, personaFromChain: persona.fromChain, ...counts, skills })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 记忆浏览:?kind=episodic|semantic&limit=N
app.get('/agents/:tokenId/memories', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const kind = c.req.query('kind')
  if (kind && kind !== 'episodic' && kind !== 'semantic') {
    return c.json({ error: 'kind 只能是 episodic 或 semantic' }, 400)
  }
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
  try {
    const memories = await listMemories(tokenId, kind, limit)
    return c.json({ tokenId, memories })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 清空该 Agent 的全部记忆(记忆主权)
app.delete('/agents/:tokenId/memories', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const deleted = await clearMemories(tokenId)
    return c.json({ ok: true, deleted })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 手动触发反思蒸馏(情景 → 语义)
app.post('/agents/:tokenId/memories/distill', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const result = await distill(tokenId)
    return c.json({ ok: true, ...result })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// M2:技能安装/卸载
// ============================================================

// 全部可安装技能(清单)
app.get('/skills', (c) => c.json({ skills: listSkills() }))

// 安装技能(含链上权限校验;未配置 AGENT_SERVICE_ADDRESS 时跳过校验并注明)
app.post('/agents/:tokenId/skills', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ skillId?: string }>().catch(() => null)
  const skillId = body?.skillId?.trim()
  if (!skillId) return c.json({ error: 'skillId 不能为空' }, 400)
  try {
    const { manifest, permissionCheck } = await installSkill(tokenId, skillId)
    invalidateAgent(tokenId) // 工具集变了,下次对话重建 Agent 实例
    return c.json({
      ok: true,
      skill: manifest,
      permissionCheck,
      ...(permissionCheck === 'skipped' ? { note: '未配置 AGENT_SERVICE_ADDRESS,已跳过链上权限校验' } : {}),
    })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 卸载技能
app.delete('/agents/:tokenId/skills/:skillId', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const skillId = c.req.param('skillId')
  try {
    const removed = await uninstallSkill(tokenId, skillId)
    if (!removed) return c.json({ error: `Agent ${tokenId} 未安装技能 ${skillId}` }, 404)
    invalidateAgent(tokenId)
    return c.json({ ok: true, skillId })
  } catch (err) {
    return handleErr(c, err)
  }
})

// ============================================================
// 多对话管理(我的 Agent 助手页;社交场景的 /agents/:tokenId/chat 保留不动)
// ============================================================

// 会话列表(按最近活跃倒序)
app.get('/agents/:tokenId/conversations', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const conversations = await listConversations(tokenId)
    return c.json({ conversations })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 新建会话
app.post('/agents/:tokenId/conversations', async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  try {
    const conversation = await createConversation(tokenId)
    return c.json({ conversation })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 删除会话(消息级联删除)
app.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const removed = await deleteConversation(id)
    if (!removed) return c.json({ error: '会话不存在' }, 404)
    return c.json({ ok: true })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 会话消息(按时间正序)
app.get('/conversations/:id/messages', async (c) => {
  const id = c.req.param('id')
  try {
    const messages = await listMessages(id)
    if (messages === null) return c.json({ error: '会话不存在' }, 404)
    return c.json({ messages })
  } catch (err) {
    return handleErr(c, err)
  }
})

// 在会话里对话(tokenId 从会话记录解析)
app.post('/conversations/:id/chat', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ message?: string }>().catch(() => null)
  const message = body?.message?.trim()
  if (!message) return c.json({ error: 'message 不能为空' }, 400)
  try {
    const conv = await getConversationById(id)
    if (!conv) return c.json({ error: '会话不存在' }, 404)
    const result = await chatInConversation(conv.tokenId, id, message)
    if (result === null) return c.json({ error: '会话不存在' }, 404)
    return c.json({ reply: result.reply, refused: result.refused })
  } catch (err) {
    return handleErr(c, err)
  }
})

/** 统一错误出口:人格完整性问题 422,技能问题按其 status,LLM 网关异常 502,其余 500 */
function handleErr(c: Context, err: unknown) {
  if (err instanceof PersonaError) {
    return c.json({ error: err.message }, 422)
  }
  if (err instanceof SkillError) {
    return c.json({ error: err.message }, err.status)
  }
  const msg = err instanceof Error ? err.message : String(err)
  // viem/网络错误和 LLM 网关错误都按上游故障处理
  if (/fetch|network|timeout|LLM|api|401|429|5\d\d/i.test(msg)) {
    console.error('[upstream]', msg)
    return c.json({ error: 'LLM 网关暂时不可用,请稍后重试' }, 502)
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
    })),
  )
  await syncSkillsToDb()
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Agent 服务已启动: http://localhost:${info.port} (模型: ${config.llmModel}, 链: ${config.chain.name})`)
  })
  // 正常退出时优雅关闭 PGlite,避免数据目录残留锁/半成品 checkpoint
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      closeDb().finally(() => process.exit(0))
    })
  }
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
