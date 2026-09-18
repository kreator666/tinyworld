import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { isAddress, type Address } from 'viem'
import { config } from './config'
import { PersonaError, loadPersona, resolveTokenId } from './chain/persona'
import { chatWithAgent, reloadAgent } from './core/agent'

// ============================================================
// API 网关(hono):M1 只暴露健康检查、人格调试、对话三类端点
// ============================================================

const app = new Hono()

// 前端 dev 服务器固定跑在 5173
app.use('/*', cors({ origin: ['http://localhost:5173'] }))

app.get('/health', (c) => c.json({ ok: true }))

// 调试用:查看当前装载的人格
app.get('/agents/:tokenId/persona', async (c) => {
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId) || tokenId <= 0) return c.json({ error: 'tokenId 不合法' }, 400)
  try {
    const persona = await loadPersona(tokenId)
    return c.json(persona)
  } catch (err) {
    return handleErr(c, err)
  }
})

// 强制重新从链上装载人格(用户改配置写链后调用)
app.post('/agents/:tokenId/reload', async (c) => {
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId) || tokenId <= 0) return c.json({ error: 'tokenId 不合法' }, 400)
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
  const tokenId = Number(c.req.param('tokenId'))
  if (!Number.isInteger(tokenId) || tokenId <= 0) return c.json({ error: 'tokenId 不合法' }, 400)
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

/** 统一错误出口:人格完整性问题 422,LLM 网关异常 502,其余 500 */
function handleErr(c: Context, err: unknown) {
  if (err instanceof PersonaError) {
    return c.json({ error: err.message }, 422)
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Agent 服务已启动: http://localhost:${info.port} (模型: ${config.llmModel})`)
})
