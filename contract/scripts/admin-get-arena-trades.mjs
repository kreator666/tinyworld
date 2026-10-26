// 用主网 owner 钱包(管理员白名单成员)走 SIWE 登录,查询任意 agent 的竞技场交易流水
// 用法: node scripts/admin-get-arena-trades.mjs <seasonId> <tokenId> [chainKey]
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'

const BASE = 'https://agent.freetoken.xin'
const SEASON_ID = process.argv[2]
const TOKEN_ID = process.argv[3]
const CHAIN_KEY = process.argv[4] || 'avalanche'

if (!SEASON_ID || !TOKEN_ID) {
  console.error('用法: node scripts/admin-get-arena-trades.mjs <seasonId> <tokenId> [chainKey]')
  process.exit(1)
}

const key = readFileSync(new URL('../.keys/mainnet-owner.key', import.meta.url), 'utf8').trim()
const wallet = new ethers.Wallet(key)
console.log('admin:', wallet.address)

const nonceRes = await fetch(`${BASE}/auth/nonce`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN_KEY },
  body: JSON.stringify({ address: wallet.address }),
})
const noncePayload = await nonceRes.json()
if (!nonceRes.ok) throw new Error('nonce 失败: ' + JSON.stringify(noncePayload))

const message = [
  'AgentVerse Login',
  'Action: login',
  `Address: ${wallet.address}`,
  `Nonce: ${noncePayload.nonce}`,
  `Chain ID: ${noncePayload.chainId}`,
  `Issued At: ${noncePayload.issuedAt}`,
].join('\n')
const signature = await wallet.signMessage(message)

const verifyRes = await fetch(`${BASE}/auth/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN_KEY },
  body: JSON.stringify({ message, signature }),
})
const verifyPayload = await verifyRes.json()
if (!verifyRes.ok) throw new Error('verify 失败: ' + JSON.stringify(verifyPayload))
const token = verifyPayload.token
console.log('JWT 获取成功')

const tradesRes = await fetch(`${BASE}/admin/arena/seasons/${SEASON_ID}/agents/${TOKEN_ID}/trades?limit=200`, {
  headers: { Authorization: `Bearer ${token}`, 'X-Chain-Key': CHAIN_KEY },
})
const tradesPayload = await tradesRes.json()
console.log('GET /admin/arena/.../trades ->', tradesRes.status)
console.log(JSON.stringify(tradesPayload, null, 2))
