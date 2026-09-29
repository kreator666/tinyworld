import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { isAddress, type Address, type Hex, verifyMessage, recoverMessageAddress } from 'viem'
import { config } from '../config'
import { ownerOf } from '../chain/persona'

// ============================================================
// 轻量 SIWE + JWT 认证(M4+):
// 前端用钱包签名一条包含 nonce 的消息,后端验证后签发 JWT。
// owner 模式的操作(资产/DeFi/设置/审批)必须携带 JWT 且地址对应 tokenId 的主人。
// ============================================================

const NONCE_TTL_MS = 5 * 60 * 1000 // nonce 5 分钟有效

interface NonceRecord {
  address: string
  createdAt: number
}

const nonces = new Map<string, NonceRecord>()

/** 清理过期 nonce(简单定时) */
setInterval(() => {
  const now = Date.now()
  for (const [nonce, rec] of nonces.entries()) {
    if (now - rec.createdAt > NONCE_TTL_MS) nonces.delete(nonce)
  }
}, 60_000)

export interface NoncePayload {
  nonce: string
  issuedAt: string
  chainId: number
}

export interface VerifyPayload {
  message: string
  signature: Hex
}

export interface JwtPayload {
  address: Address
  chainId: number
}

/** 生成登录 nonce */
export function createNonce(address: string): NoncePayload {
  if (!isAddress(address)) throw new AuthError('地址不合法', 400)
  const nonce = randomUUID()
  const issuedAt = new Date().toISOString()
  nonces.set(nonce, { address: address.toLowerCase(), createdAt: Date.now() })
  return { nonce, issuedAt, chainId: config.chain.chainId }
}

/** 消费 nonce:不存在或过期返回 false */
function consumeNonce(nonce: string, address: string): boolean {
  const rec = nonces.get(nonce)
  if (!rec) return false
  if (rec.address !== address.toLowerCase()) return false
  if (Date.now() - rec.createdAt > NONCE_TTL_MS) return false
  nonces.delete(nonce)
  return true
}

/** 解析自定义 SIWE 风格消息,提取字段 */
function parseLoginMessage(message: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of message.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    fields[key] = value
  }
  return fields
}

/** 验证签名消息并恢复地址;验证通过返回地址 */
export async function verifyLogin(payload: VerifyPayload): Promise<Address> {
  const { message, signature } = payload
  if (!message || !signature) throw new AuthError('message 和 signature 不能为空', 400)

  const fields = parseLoginMessage(message)
  const address = fields['Address']
  const nonce = fields['Nonce']
  const action = fields['Action']

  if (!address || !isAddress(address)) throw new AuthError('消息中 Address 不合法', 400)
  if (!nonce) throw new AuthError('消息中缺少 Nonce', 400)
  if (action !== 'login') throw new AuthError('消息 Action 必须是 login', 400)

  // nonce 一次性使用,防重放
  if (!consumeNonce(nonce, address)) {
    throw new AuthError('nonce 无效、已使用或已过期', 401)
  }

  // 用 viem 验证签名(message 中的地址作为预期地址)
  const valid = await verifyMessage({ message, signature, address: address as Address })
  if (!valid) throw new AuthError('签名验证失败', 401)

  // 再恢复地址,确保与消息声明的地址一致
  const recovered = await recoverMessageAddress({ message, signature })
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new AuthError('签名地址与消息中的地址不一致', 401)
  }

  return address as Address
}

/** 签发 JWT */
export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions)
}

/** 验证 JWT,返回 payload */
export function verifyJwt(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, config.jwtSecret)
    if (typeof decoded === 'string') throw new Error('invalid payload')
    const address = decoded.address
    const chainId = decoded.chainId
    if (!address || !isAddress(address)) throw new Error('invalid address')
    if (typeof chainId !== 'number') throw new Error('invalid chainId')
    return { address, chainId }
  } catch (err) {
    throw new AuthError('token 无效或已过期', 401)
  }
}

/** 检查 address 是否为 tokenId 的主人 */
export async function isAgentOwner(tokenId: number, address: Address): Promise<boolean> {
  try {
    const owner = await ownerOf(tokenId)
    return owner.toLowerCase() === address.toLowerCase()
  } catch {
    return false
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 = 400,
  ) {
    super(message)
  }
}
