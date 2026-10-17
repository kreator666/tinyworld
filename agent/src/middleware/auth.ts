import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { verifyJwt, isAgentOwner, AuthError } from '../core/auth'
import { isAdmin } from '../db'
import { resolveChainKey, getChainContext } from '../chain/registry'
import { PERMISSION_SKILL, getAgentPermissions } from '../chain/persona'

// ============================================================
// Hono 认证中间件:从 Authorization: Bearer <jwt> 提取地址并写入上下文
// ============================================================

// 扩展 Hono 上下文变量类型(EVM 0x 地址或 Solana base58 地址,统一 string)
declare module 'hono' {
  interface ContextVariableMap {
    address: string
  }
}

/** 要求请求携带有效 JWT,并把地址写入 c.get('address') */
export const authRequired = createMiddleware(async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: '缺少 Authorization: Bearer <token> 头' }, 401)
  }
  // 请求链先解析(未知链头直接 400,与路由层行为一致)
  let chainKey: string
  try {
    chainKey = resolveChainKey(c.req.header('X-Chain-Key'))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
  const token = auth.slice(7).trim()
  try {
    const payload = verifyJwt(token)
    // 登录链与请求链一致性:新签发的 token 带 chainKey,跨链使用一律拒绝
    if (payload.chainKey && payload.chainKey !== chainKey) {
      return c.json({ error: '登录链与请求链不匹配' }, 401)
    }
    c.set('address', payload.address)
    await next()
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : 'token 无效或已过期'
    return c.json({ error: msg }, 401)
  }
})

/** 管理接口鉴权:有效 JWT + 地址在 admin_whitelist。
 *  与 authRequired 的差异:admin 操作是跨链全局的,不做登录链与 X-Chain-Key 一致性检查(该头不解析)。 */
export const adminRequired = createMiddleware(async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: '缺少 Authorization: Bearer <token> 头' }, 401)
  }
  const token = auth.slice(7).trim()
  try {
    const payload = verifyJwt(token)
    if (!(await isAdmin(payload.address))) {
      return c.json({ error: '该地址不在管理员白名单中' }, 403)
    }
    c.set('address', payload.address)
    await next()
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : 'token 无效或已过期'
    return c.json({ error: msg }, 401)
  }
})

/** 在路由里校验 JWT 地址是否为指定 tokenId 的主人;不是则返回 403 */
export async function assertAgentOwnership(c: Context, chainKey: string, tokenId: number): Promise<void> {
  const address = c.get('address')
  if (!address) throw new AuthError('未登录', 401)
  const ok = await isAgentOwner(chainKey, tokenId, address)
  if (!ok) throw new AuthError('你不是该 Agent 的主人', 403)
}

/** 校验是否为 Agent 主人,或被链上授予了 PERMISSION_SKILL 权限的地址 */
export async function assertAgentSkillAccess(c: Context, chainKey: string, tokenId: number): Promise<void> {
  const address = c.get('address')
  if (!address) throw new AuthError('未登录', 401)
  if (await isAgentOwner(chainKey, tokenId, address)) return
  // Solana 暂不开放 skill 授权
  if (getChainContext(chainKey).family === 'solana') {
    throw new AuthError('Solana 暂不开放自定义 skill 授权', 403)
  }
  const perms = await getAgentPermissions(chainKey, tokenId, address)
  if ((perms & PERMISSION_SKILL) === 0n) {
    throw new AuthError('你没有为该 Agent 管理自定义技能的权限', 403)
  }
}
