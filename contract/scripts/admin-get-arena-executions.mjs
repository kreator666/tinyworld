// 管理员查询 agent 的竞技场执行记录
// 用法: node scripts/admin-get-arena-executions.mjs <seasonId> <tokenId> [decisionId] [chainKey]
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'

const BASE = 'https://agent.freetoken.xin'
const SEASON_ID = process.argv[2]
const TOKEN_ID = process.argv[3]
const DECISION_ID = process.argv[4]
const CHAIN_KEY = process.argv[5] || 'avalanche'

if (!SEASON_ID || !TOKEN_ID) {
  console.error('用法: node scripts/admin-get-arena-executions.mjs <seasonId> <tokenId> [decisionId] [chainKey]')
  process.exit(1)
}

const key = readFileSync(new URL('../.keys/mainnet-owner.key', import.meta.url), 'utf8').trim()
const wallet = new ethers.Wallet(key)

const nonceRes = await fetch(`${BASE}/auth/nonce`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN_KEY },
  body: JSON.stringify({ address: wallet.address }),
})
const noncePayload = await nonceRes.json()
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
const { token } = await verifyRes.json()

const url = DECISION_ID && DECISION_ID.startsWith('decision-')
  ? `${BASE}/admin/arena/seasons/${SEASON_ID}/agents/${TOKEN_ID}/executions?decisionId=${DECISION_ID}`
  : `${BASE}/admin/arena/seasons/${SEASON_ID}/agents/${TOKEN_ID}/executions?limit=50`
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, 'X-Chain-Key': CHAIN_KEY },
})
const payload = await res.json()
console.log('GET /admin/arena/.../executions ->', res.status)
console.log(JSON.stringify(payload, null, 2))
