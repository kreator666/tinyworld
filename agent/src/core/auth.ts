import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { isAddress, type Address, type Hex, verifyMessage, recoverMessageAddress } from 'viem'
import { verifyAsync as ed25519Verify } from '@noble/ed25519'
import { PublicKey } from '@solana/web3.js'
import { config } from '../config'
import { ownerOf } from '../chain/persona'
import { isValidNearAddress } from '../chain/personaNear'
import { getChainContext } from '../chain/registry'
import { base58Decode } from './base58'

// ============================================================
// 轻量签名登录 + JWT 认证(M4+):
// EVM:钱包签名一条包含 nonce 的 SIWE 风格消息(viem 验签);
// Solana:钱包按逐字节约定格式签名(ed25519 验签,见下方 SOLANA_MESSAGE_TMPL);
// NEAR:钱包签名一笔指向身份合约的 login_challenge(nonce) 链上交易作为登录凭证,
//   后端按交易哈希向 RPC 核对签名者/方法/nonce/执行状态(见 verifyNearLogin)。
// owner 模式的操作(资产/DeFi/设置/审批)必须携带 JWT 且地址对应 tokenId 的主人。
// ============================================================

const NONCE_TTL_MS = 5 * 60 * 1000 // nonce 5 分钟有效

// Solana 登录消息逐字节格式(与 web 侧约定,勿改):
//   AgentVerse 登录验证
//   地址: <base58>
//   随机数: <nonce>
//   时间: <ISO8601>
//   链: solana-devnet
const SOLANA_CHAIN_KEY = 'solana-devnet'

/** base58 地址校验(32~44 位 base58 且能解析为 32 字节公钥) */
export function isBase58Address(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

/** 链无关的地址校验:EVM 0x 地址、Solana base58 地址或 NEAR account_id */
export function isValidAddress(address: string): boolean {
  return isAddress(address) || isBase58Address(address) || isValidNearAddress(address)
}

/** 地址归一化:EVM 地址大小写不敏感(转小写),base58 地址区分大小写(原样) */
function normalizeAddress(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address
}

interface NonceRecord {
  address: string
  chainKey: string // nonce 按链隔离:同一地址在不同链是不同身份
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
  signature: string // EVM 为 0x hex,Solana 为 base58
}

export type JwtChain = 'evm' | 'solana' | 'near'

export interface JwtPayload {
  address: string
  chainId: number
  chain: JwtChain // 旧 token 无该字段,按 'evm' 处理
  chainKey?: string // 登录时解析的链;旧 token 无该字段,不做请求链一致性校验
}

/** 生成登录 nonce */
export function createNonce(chainKey: string, address: string): NoncePayload {
  if (!isValidAddress(address)) throw new AuthError('地址不合法', 400)
  const nonce = randomUUID()
  const issuedAt = new Date().toISOString()
  nonces.set(nonce, { address: normalizeAddress(address), chainKey, createdAt: Date.now() })
  return { nonce, issuedAt, chainId: getChainContext(chainKey).cfg.chainId }
}

/** 消费 nonce:不存在、链不匹配或过期返回 false */
function consumeNonce(chainKey: string, nonce: string, address: string): boolean {
  const rec = nonces.get(nonce)
  if (!rec) return false
  if (rec.chainKey !== chainKey) return false
  if (rec.address !== normalizeAddress(address)) return false
  if (Date.now() - rec.createdAt > NONCE_TTL_MS) return false
  nonces.delete(nonce)
  return true
}

/** 解析登录消息(中文/英文冒号键值对,逐行) */
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

export interface LoginResult {
  address: string
  chain: JwtChain
}

/** Solana 登录:消息含「地址:」行即视为 Solana 格式(web 侧逐字节约定) */
function isSolanaLoginMessage(fields: Record<string, string>): boolean {
  return fields['地址'] !== undefined
}

/** EVM 登录验证(viem 验签 + 恢复地址双重校验,行为与 M4 一致) */
async function verifyEvmLogin(chainKey: string, message: string, signature: string): Promise<LoginResult> {
  const fields = parseLoginMessage(message)
  const address = fields['Address']
  const nonce = fields['Nonce']
  const action = fields['Action']

  if (!address || !isAddress(address)) throw new AuthError('消息中 Address 不合法', 400)
  if (!nonce) throw new AuthError('消息中缺少 Nonce', 400)
  if (action !== 'login') throw new AuthError('消息 Action 必须是 login', 400)

  // nonce 一次性使用,防重放
  if (!consumeNonce(chainKey, nonce, address)) {
    throw new AuthError('nonce 无效、已使用或已过期', 401)
  }

  const sig = signature as Hex
  // 用 viem 验证签名(message 中的地址作为预期地址)
  const valid = await verifyMessage({ message, signature: sig, address: address as Address })
  if (!valid) throw new AuthError('签名验证失败', 401)

  // 再恢复地址,确保与消息声明的地址一致
  const recovered = await recoverMessageAddress({ message, signature: sig })
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new AuthError('签名地址与消息中的地址不一致', 401)
  }

  return { address, chain: 'evm' }
}

/** Solana 登录验证(ed25519;nonce 一次性消费,签名不对返回 401) */
async function verifySolanaLogin(chainKey: string, message: string, signature: string): Promise<LoginResult> {  const fields = parseLoginMessage(message)
  const address = fields['地址']
  const nonce = fields['随机数']
  const chainField = fields['链']

  if (!address || !isBase58Address(address)) throw new AuthError('消息中地址不合法(base58)', 400)
  if (!nonce) throw new AuthError('消息中缺少随机数', 400)
  if (chainField !== SOLANA_CHAIN_KEY) throw new AuthError(`消息链标识必须是 ${SOLANA_CHAIN_KEY}`, 400)

  // nonce 一次性使用,防重放
  if (!consumeNonce(chainKey, nonce, address)) {
    throw new AuthError('nonce 无效、已使用或已过期', 401)
  }

  let sigBytes: Uint8Array
  let pubkeyBytes: Uint8Array
  try {
    sigBytes = base58Decode(signature)
    pubkeyBytes = new PublicKey(address).toBytes()
  } catch {
    throw new AuthError('签名格式不合法(base58)', 400)
  }
  if (sigBytes.length !== 64) throw new AuthError('签名长度必须是 64 字节', 400)

  // 对消息 UTF-8 原始字节验签(noble/ed25519,async 实现内置 sha512)
  const valid = await ed25519Verify(sigBytes, new TextEncoder().encode(message), pubkeyBytes)
  if (!valid) throw new AuthError('签名验证失败', 401)

  return { address, chain: 'solana' }
}

// ------------------------------------------------------------
// NEAR 登录验证(链上挑战)
// 背景:NEP-413 signMessage 的钱包侧实现(MyNearWallet v10 等)只回 {accountId, publicKey,
// signature},不返回签名负载——payload 里的 timestamp 由钱包生成,dApp 无法重建 borsh 验签。
// 因此 NEAR 登录改用链上挑战:前端用钱包签名一笔指向身份合约的 login_challenge(nonce)
// 交易,verify 的 signature 字段携带该交易哈希,后端向 RPC 核对签名者/合约/方法/nonce/执行状态,
// 以此证明该账户的密钥控制权(密码学强度等价 SIWE,且全网可审计)。
// ------------------------------------------------------------

const NEAR_TX_CONFIRM_ATTEMPTS = 5
const NEAR_TX_CONFIRM_INTERVAL_MS = 2000

/** NEAR JSON-RPC 调用(主端点失败轮换 rpcFallbacks) */
async function nearJsonRpc(chainKey: string, method: string, params: unknown[]): Promise<unknown> {
  const cfg = getChainContext(chainKey).cfg
  const endpoints = [cfg.rpc, ...(cfg.rpcFallbacks ?? [])]
  let lastErr: unknown = null
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      const json = (await res.json()) as { error?: { message?: string }; result?: unknown }
      if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error))
      return json.result
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('NEAR RPC 全部端点不可用')
}

/** 查询交易(未落定时 RPC 会报错,轮询等待钱包广播确认) */
async function fetchNearTx(chainKey: string, txHash: string, signerId: string): Promise<Record<string, unknown>> {
  let lastErr: unknown = null
  for (let i = 0; i < NEAR_TX_CONFIRM_ATTEMPTS; i++) {
    try {
      return (await nearJsonRpc(chainKey, 'tx', [txHash, signerId])) as Record<string, unknown>
    } catch (err) {
      lastErr = err
      if (i < NEAR_TX_CONFIRM_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, NEAR_TX_CONFIRM_INTERVAL_MS))
    }
  }
  throw new AuthError(`挑战交易查询失败或尚未落定: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, 401)
}

/** NEAR 登录验证(链上挑战交易;nonce 一次性消费,交易不符返回 401) */
async function verifyNearLogin(chainKey: string, message: string, signature: string): Promise<LoginResult> {
  // 登录消息逐行约定(与 web 侧 buildNearLoginMessage 逐字节一致):
  //   AgentVerse 登录验证 / 地址: <account_id> / 随机数: <nonce> / 时间: <ISO8601> / 链: <chainKey>
  const fields = parseLoginMessage(message)
  const loginAddress = fields['地址']
  const nonce = fields['随机数']
  const chainField = fields['链']

  if (!loginAddress || !isValidNearAddress(loginAddress)) throw new AuthError('消息中地址不合法(NEAR account_id)', 400)
  if (!nonce) throw new AuthError('消息中缺少随机数', 400)
  if (chainField !== chainKey) throw new AuthError(`消息链标识必须是 ${chainKey}`, 400)

  // signature 字段 = 挑战交易哈希(base58)
  const txHash = signature.trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) {
    throw new AuthError('签名字段应为 NEAR 挑战交易哈希(base58)', 400)
  }

  const result = await fetchNearTx(chainKey, txHash, loginAddress)
  const tx = (result.transaction ?? {}) as { signer_id?: string; receiver_id?: string; actions?: unknown[] }
  if (tx.signer_id !== loginAddress) throw new AuthError('交易签名者与登录地址不一致', 401)

  const identity = getChainContext(chainKey).cfg.identityAddress
  if (tx.receiver_id !== identity) throw new AuthError(`交易接收方必须是本链身份合约(${identity})`, 401)

  const actions = Array.isArray(tx.actions) ? tx.actions : []
  const call = actions.find((a) => a && typeof a === 'object' && 'FunctionCall' in (a as Record<string, unknown>)) as
    | { FunctionCall: { method_name?: string; args?: string } }
    | undefined
  if (!call?.FunctionCall) throw new AuthError('交易中必须包含 FunctionCall 动作', 401)
  if (call.FunctionCall.method_name !== 'login_challenge') {
    throw new AuthError('交易必须调用 login_challenge 方法', 401)
  }
  let args: { nonce?: string }
  try {
    args = JSON.parse(Buffer.from(call.FunctionCall.args ?? '', 'base64').toString('utf8'))
  } catch {
    throw new AuthError('挑战交易参数无法解析', 401)
  }
  if (args.nonce !== nonce) throw new AuthError('交易中的 nonce 与登录消息不一致', 401)

  // 执行状态须成功(乐观执行或最终态均可)
  const finalStatus = result.final_execution_status
  if (finalStatus !== 'EXECUTED' && finalStatus !== 'FINAL' && finalStatus !== 'EXECUTED_OPTIMISTIC') {
    throw new AuthError('挑战交易未成功执行', 401)
  }

  // 全部链上核对通过后再消费 nonce(前面任何失败都保留重试机会)
  if (!consumeNonce(chainKey, nonce, loginAddress)) {
    throw new AuthError('nonce 无效、已使用或已过期', 401)
  }

  return { address: loginAddress, chain: 'near' }
}

/** 验证签名消息;按链家族分派 EVM / Solana / NEAR 验证,通过返回地址与链家族 */
export async function verifyLogin(chainKey: string, payload: VerifyPayload): Promise<LoginResult> {
  const { message, signature } = payload
  if (!message || !signature) throw new AuthError('message 和 signature 不能为空', 400)

  const family = getChainContext(chainKey).family
  // NEAR 登录消息同样含「地址:」行,必须先按家族分派,不能落到 Solana 分支
  if (family === 'near') return verifyNearLogin(chainKey, message, signature)

  if (isSolanaLoginMessage(parseLoginMessage(message))) {
    return verifySolanaLogin(chainKey, message, signature)
  }
  return verifyEvmLogin(chainKey, message, signature)
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
    const chain: JwtChain = decoded.chain === 'solana' ? 'solana' : decoded.chain === 'near' ? 'near' : 'evm' // 旧 token 无 chain 字段,按 evm 处理
    const chainKey = typeof decoded.chainKey === 'string' ? decoded.chainKey : undefined // 旧 token 无该字段
    if (!address || typeof address !== 'string' || !isValidAddress(address)) throw new Error('invalid address')
    if (typeof chainId !== 'number') throw new Error('invalid chainId')
    return { address, chainId, chain, chainKey }
  } catch (err) {
    throw new AuthError('token 无效或已过期', 401)
  }
}

/** 检查 address 是否为 tokenId 的主人 */
export async function isAgentOwner(chainKey: string, tokenId: number, address: string): Promise<boolean> {
  try {
    const owner = await ownerOf(chainKey, tokenId)
    // EVM 地址大小写不敏感(base58 区分大小写,必须精确比较)
    return normalizeAddress(owner) === normalizeAddress(address)
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
