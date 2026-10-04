import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { verifyJwt, isAgentOwner, AuthError } from '../core/auth'

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
  const token = auth.slice(7).trim()
  try {
    const payload = verifyJwt(token)
    c.set('address', payload.address)
    await next()
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : 'token 无效或已过期'
    return c.json({ error: msg }, 401)
  }
})

/** 在路由里校验 JWT 地址是否为指定 tokenId 的主人;不是则返回 403 */
export async function assertAgentOwnership(c: Context, tokenId: number): Promise<void> {
  const address = c.get('address')
  if (!address) throw new AuthError('未登录', 401)
  const ok = await isAgentOwner(tokenId, address)
  if (!ok) throw new AuthError('你不是该 Agent 的主人', 403)
}
