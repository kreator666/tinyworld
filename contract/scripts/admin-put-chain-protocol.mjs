// 用主网 owner 钱包(管理员)经 admin API 注册 BENQI 质押协议行
// 用法: node scripts/admin-put-chain-protocol.mjs <chainKey> <protocolKey> <kind> '<configJson>'
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'

const BASE = 'https://agent.freetoken.xin'
const CHAIN_KEY = process.argv[2] || 'avalanche'
const PKEY = process.argv[3] || 'benqi-staking'
const KIND = process.argv[4] || 'staking'
const CONFIG = process.argv[5] || '{"staking":"0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE","sAvax":"0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE"}'

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
console.log('JWT 获取成功')

const putRes = await fetch(`${BASE}/admin/chains/${CHAIN_KEY}/protocols/${PKEY}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${verifyPayload.token}` },
  body: JSON.stringify({ kind: KIND, config: JSON.parse(CONFIG), enabled: true }),
})
const putPayload = await putRes.json().catch(() => ({}))
console.log(`PUT protocols/${PKEY} ->`, putRes.status, JSON.stringify(putPayload))

const chains = await (await fetch(`${BASE}/chains`)).json()
const row = chains.chains.find((c) => c.chain_key === CHAIN_KEY)
console.log('protocols:', JSON.stringify((row.protocols || []).map((p) => [p.protocol_key, p.enabled])))
