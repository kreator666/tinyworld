// 用主网 owner 钱包(管理员白名单成员)走 SIWE 登录,经 admin API 写入 fuji 市场配置
// 用法: node scripts/admin-put-chain-config.mjs <chainKey> '<json>'
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'

const BASE = 'https://agent.freetoken.xin'
const CHAIN_KEY = process.argv[2] || 'fuji'
const CONFIG_JSON = process.argv[3] || '{"market":{"address":"0xA0323a6E825912736F2C7b7e64920c71d8d27A31"}}'

const key = readFileSync(new URL('../.keys/mainnet-owner.key', import.meta.url), 'utf8').trim()
const wallet = new ethers.Wallet(key)
console.log('admin:', wallet.address)

// 1) nonce
const nonceRes = await fetch(`${BASE}/auth/nonce`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN_KEY },
  body: JSON.stringify({ address: wallet.address }),
})
const noncePayload = await nonceRes.json()
if (!nonceRes.ok) throw new Error('nonce 失败: ' + JSON.stringify(noncePayload))
console.log('nonce ok, chainId:', noncePayload.chainId)

// 2) 签名(对齐 agent/src/core/auth.ts 的 SIWE 风格消息)
const message = [
  'AgentVerse Login',
  'Action: login',
  `Address: ${wallet.address}`,
  `Nonce: ${noncePayload.nonce}`,
  `Chain ID: ${noncePayload.chainId}`,
  `Issued At: ${noncePayload.issuedAt}`,
].join('\n')
const signature = await wallet.signMessage(message)

// 3) verify → JWT
const verifyRes = await fetch(`${BASE}/auth/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN_KEY },
  body: JSON.stringify({ message, signature }),
})
const verifyPayload = await verifyRes.json()
if (!verifyRes.ok) throw new Error('verify 失败: ' + JSON.stringify(verifyPayload))
const token = verifyPayload.token
console.log('JWT 获取成功')

// 4) PUT chain config
const putRes = await fetch(`${BASE}/admin/chains/${CHAIN_KEY}/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: CONFIG_JSON,
})
const putPayload = await putRes.json().catch(() => ({}))
console.log('PUT /admin/chains/' + CHAIN_KEY + '/config ->', putRes.status, JSON.stringify(putPayload))

// 5) 回读验证
const chains = await (await fetch(`${BASE}/chains`)).json()
const fuji = chains.chains.find((c) => c.chain_key === CHAIN_KEY)
console.log('回读 config:', JSON.stringify(fuji.config))
