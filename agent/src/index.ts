import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { keccak256, toBytes, formatUnits, type Hex } from 'viem'
import { config } from './config'
import { PersonaError, loadPersona, ownerOf, resolveTokenId } from './chain/persona'
import { resolveChainKey, getChainContext } from './chain/registry'
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
import { initSchema, closeDb, listChains, seedChains } from './db'
import { appendAssistantMessage } from './core/conversation'
import { waitForTxReceipt, parseSwapAmountOut } from './chain/defi'
import { ALL_CHAINS } from './config'
import { SkillError, getInstalledSkills, installSkill, listSkills, syncSkillsToDb, uninstallSkill, ensureDefaultSkills } from './skills'
import { startScheduler, stopScheduler } from './core/scheduler'
import { getInbox, recordSocialMessage } from './core/social'
import { getApproval, listApprovals, resolveApproval } from './core/approvals'
import { createNonce, verifyLogin, signJwt, AuthError, isValidAddress } from './core/auth'
import { readPersonaMirror, writePersonaMirror } from './core/personaMirror'
import { authRequired, assertAgentOwnership } from './middleware/auth'
import { getAgentStats } from './core/stats'
import { getSwapMode, setSwapMode, type SwapMode } from './core/settings'
import { broadcastSignedTx } from './chain/defi'
import { SOL_MINT, usdcMintOf } from './chain/jupiter'
import { solanaConnection, type FailoverConnection } from './chain/personaSolana'
import { EXEC_CHAIN_KEY, MAINNET_USDC_MINT, mainnetConnection, mainnetTxUrl } from './chain/solanaExec'
import { executeProposal, recordDefiTask, describeSwapResult } from './skills/defi-swap'
import { executeLendingProposal } from './skills/defi-lending'
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

// 各链合约地址查询(数据源是 chains 表;前端另存本地兜底,服务不可达时用本地数据)
app.get('/chains', async (c) => {
  try {
    const chains = await listChains()
    return c.json({ chains })
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
      // 按 action 分发:swap 走兑换执行器;supply/withdraw 走借贷执行器
      const { txHash, amountOut } =
        approval.proposal.action === 'swap'
          ? await executeProposal(chainKey, approval.tokenId, approval.proposal)
          : await executeLendingProposal(chainKey, approval.tokenId, approval.proposal)
      await resolveApproval(id, 'executed', txHash)
      return c.json({ ok: true, status: 'executed', txHash, amountOut, explorer: `${getChainContext(chainKey).cfg.explorer}/tx/${txHash}` })
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

// 用户钱包签名模式:后端广播签名后的 raw transaction;仅主人
app.post('/agents/:tokenId/broadcast', authRequired, async (c) => {
  const tokenId = parseTokenId(c)
  if (tokenId === null) return
  const body = await c.req.json<{ signedTxs?: string[] }>().catch(() => null)
  if (!body?.signedTxs || !Array.isArray(body.signedTxs) || body.signedTxs.length === 0) {
    return c.json({ error: 'signedTxs 不能为空数组' }, 400)
  }
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
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
  if (!action || !['swap', 'supply', 'withdraw'].includes(action)) {
    return c.json({ error: 'proposal.action 必须是 swap / supply / withdraw' }, 400)
  }
  const proposal = body.proposal as Proposal
  try {
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await assertAgentOwnership(c, chainKey, tokenId)
    // Solana 家族(Jupiter / Meteora):前端 Phantom 已签名自广播,这里走链上确认 + 解析实际输出
    if (proposal.protocol === 'jupiter' || proposal.protocol === 'meteora') {
      return confirmSolanaSign(c, chainKey, tokenId, body.txHash, proposal, body.conversationId)
    }
    const receipt = await waitForTxReceipt(chainKey, body.txHash as Hex)
    if (receipt.status !== 'success') {
      // revert:记失败任务(不计入限额),主动告知失败
      await recordDefiTask(chainKey, tokenId, proposal, { txHash: body.txHash, amountOut: '0', usdValue: null }, 'failed')
      const notice = describeSwapResult(chainKey, proposal, { confirmed: false, reverted: true, amountOut: null })
      if (body.conversationId) await appendAssistantMessage(chainKey, body.conversationId, notice)
      return c.json({ ok: true, confirmed: false, reverted: true, notice })
    }
    // 仅 swap 需要解析 Swap 事件拿实际输出;supply/withdraw 以提案金额为准
    const parsed = action === 'swap' ? parseSwapAmountOut(receipt) : null
    const amountOut = parsed?.amountOut ?? null
    await recordDefiTask(chainKey, tokenId, proposal, {
      txHash: body.txHash,
      amountOut: amountOut?.toString() ?? '0',
      usdValue: proposal.estimatedValueUsd ?? null,
    })
    const notice = describeSwapResult(chainKey, proposal, { confirmed: true, reverted: false, amountOut })
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
    const chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
    await recordDefiTask(chainKey, tokenId, proposal, { txHash: body.txHash, amountOut: '0', usdValue: proposal.estimatedValueUsd ?? null })
    const notice = describeSwapResult(chainKey, proposal, { confirmed: false, reverted: false, amountOut: null })
    if (body.conversationId) await appendAssistantMessage(chainKey, body.conversationId, notice)
    return c.json({ ok: true, confirmed: false, amountOut: null, notice })
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
    await conn.confirmTransaction(txHash)
  } catch (err) {
    // 确认超时/RPC 失败:不阻塞前端,记一笔待确认(金额 0),让 Agent 稍后自查
    console.warn('[sign-confirm] Solana 确认失败,按待确认处理:', err instanceof Error ? err.message : String(err))
    await record('0')
    const notice = noticeOf(null, false)
    if (conversationId) await appendAssistantMessage(chainKey, conversationId, notice)
    return c.json({ ok: true, confirmed: false, amountOut: null, notice })
  }
  // 确认后解析失败不影响审计主流程:金额记 0,文案提示以浏览器为准
  let amountOut: bigint | null = null
  try {
    amountOut = await parseSolanaSwapOut(conn, txHash, owner, outMint, params.tokenOut === 'SOL')
  } catch (err) {
    console.warn('[sign-confirm] Solana 输出解析失败:', err instanceof Error ? err.message : String(err))
  }
  await record(amountOut?.toString() ?? '0')
  const notice = noticeOf(amountOut, true)
  if (conversationId) await appendAssistantMessage(chainKey, conversationId, notice)
  return c.json({ ok: true, confirmed: true, amountOut: amountOut?.toString() ?? null, notice, explorer: txUrl })
}

/** 统一错误出口:人格完整性问题 422,技能问题按其 status,LLM 网关异常 502,其余 500 */
function handleErr(c: Context, err: unknown) {
  if (err instanceof AuthError) {
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
  // viem/网络错误和 LLM 网关错误都按上游故障处理
  if (/fetch|network|timeout|LLM|api|429|5\d\d/i.test(msg)) {
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
      family: c.family,
    })),
  )
  await syncSkillsToDb()
  startScheduler() // M3:心跳驱动自主社交
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Agent 服务已启动: http://localhost:${info.port} (模型: ${config.llmModel}, 链: ${config.chain.name})`)
  })
  // 正常退出时优雅关闭调度器与 PGlite,避免数据目录残留锁/半成品 checkpoint
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopScheduler()
      closeDb().finally(() => process.exit(0))
    })
  }
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
