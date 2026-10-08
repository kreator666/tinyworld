// Solana 登录 E2E 冒烟(阶段 3 验收):
//   1. 生成一次性 ed25519 测试密钥,用部署钱包(~/.config/solana/id.json)在 testnet 上转 0.2 SOL 资助
//   2. 直接构造 mint_identity 指令(raw web3.js,不用 anchor)铸造一个 Identity(owner = 测试密钥)
//   3. 按逐字节约定格式签登录消息 → POST /auth/nonce → /auth/verify 拿 JWT
//   4. 带 JWT 调 GET /agents/:tokenId/status 验证 authRequired 通过;错误签名确认 401
// 用法: npx tsx scripts/e2e-solana-login.mts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { signAsync as edSign } from '@noble/ed25519'
import { keccak256, toBytes } from 'viem'
import { base58Decode, base58Encode } from '../src/core/base58'
import idl from '../src/idl/tinyworld.json'

const RPC = process.env.SOLANA_RPC ?? 'https://api.testnet.solana.com'
const AGENT = process.env.AGENT_URL ?? 'http://localhost:4111'
const PROGRAM_ID = new PublicKey('4ErVmJjpd798U2riCj76fDy8ggPd2W2fhRnP5Ta6dBaH')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

function disc(name: string): Buffer {
  const acc = (idl as any).accounts.find((a: any) => a.name === name)
  return Buffer.from(acc.discriminator)
}
function ixDisc(name: string): Buffer {
  const ix = (idl as any).instructions.find((i: any) => i.name === name)
  return Buffer.from(ix.discriminator)
}

function tokenIdFromMint(mint: PublicKey): number {
  const b = mint.toBytes()
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
  return Number(v)
}

const lower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
const nameHash = (name: string) => {
  const h = keccak256(toBytes(lower(name)))
  return Buffer.from(h.slice(2), 'hex')
}

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const provider = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'solana', 'id.json'), 'utf8'))),
  )
  const me = Keypair.generate()
  const address = me.publicKey.toBase58()
  console.log('[1] 测试地址:', address)

  // 资助 0.2 SOL(铸造租金 + 手续费)
  const bal = await connection.getBalance(provider.publicKey)
  console.log('    部署钱包余额:', bal / 1e9, 'SOL')
  const fund = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: provider.publicKey, toPubkey: me.publicKey, lamports: 0.2 * 1e9 }),
  )
  await sendAndConfirmTransaction(connection, fund, [provider])
  console.log('[2] 已资助 0.2 SOL')

  // mint_identity(name)
  const name = `E2E${Date.now().toString(36).slice(-6)}`
  const identityPda = PublicKey.findProgramAddressSync([Buffer.from('identity'), me.publicKey.toBuffer()], PROGRAM_ID)[0]
  const nameRecord = PublicKey.findProgramAddressSync([Buffer.from('name-record'), nameHash(name)], PROGRAM_ID)[0]
  const mint = Keypair.generate()
  const mintAuth = PublicKey.findProgramAddressSync([Buffer.from('mint-auth')], PROGRAM_ID)[0]
  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0]
  const [ownerAta] = PublicKey.findProgramAddressSync(
    [me.publicKey.toBuffer(), TOKEN_2022.toBuffer(), mint.publicKey.toBuffer()],
    ATA_PROGRAM,
  )
  const nameBuf = Buffer.from(name, 'utf8')
  const data = Buffer.concat([ixDisc('mint_identity'), Buffer.from([nameBuf.length, 0, 0, 0]), nameBuf])
  const keys = [
    { pubkey: me.publicKey, isSigner: true, isWritable: true }, // owner
    { pubkey: identityPda, isSigner: false, isWritable: true },
    { pubkey: nameRecord, isSigner: false, isWritable: true },
    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
    { pubkey: ownerAta, isSigner: false, isWritable: true },
    { pubkey: mintAuth, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]
  const tx = new Transaction().add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data }))
  await sendAndConfirmTransaction(connection, tx, [me, mint])
  const tokenId = tokenIdFromMint(mint.publicKey)
  console.log(`[3] 已铸造 Identity「${name}」tokenId=${tokenId}`)
  // 保存密钥供 smoke-persona-mirror.ts 做 update_persona 联跑
  fs.writeFileSync(path.join(os.tmpdir(), 'tw-e2e-key.json'), JSON.stringify(Array.from(me.secretKey)))

  // 登录全流
  const nonceRes = await fetch(`${AGENT}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chain-Key': 'solana-testnet' },
    body: JSON.stringify({ address }),
  }).then((r) => r.json())
  console.log('[4] nonce:', nonceRes.nonce)
  const message = `AgentVerse 登录验证\n地址: ${address}\n随机数: ${nonceRes.nonce}\n时间: ${new Date().toISOString()}\n链: solana-testnet`
  const signature = base58Encode(await edSign(new TextEncoder().encode(message), me.secretKey.subarray(0, 32)))

  const verifyRes = await fetch(`${AGENT}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chain-Key': 'solana-testnet' },
    body: JSON.stringify({ message, signature }),
  }).then((r) => r.json())
  if (!verifyRes.token) throw new Error('登录失败: ' + JSON.stringify(verifyRes))
  console.log('[5] JWT 签发成功, chain =', verifyRes.chain)

  // 错误签名必须 401
  const bad = await fetch(`${AGENT}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chain-Key': 'solana-testnet' },
    body: JSON.stringify({ message, signature: base58Encode(new Uint8Array(64).fill(1)) }),
  })
  console.log('[6] 错误签名状态码(期望 401):', bad.status)

  // nonce 一次性:重放同一 nonce 应 401
  const replay = await fetch(`${AGENT}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chain-Key': 'solana-testnet' },
    body: JSON.stringify({ message, signature }),
  })
  console.log('    重放 nonce 状态码(期望 401):', replay.status)

  // 带 JWT 调 authRequired 接口(新铸造的身份在 GPA 扫描里有秒级传播延迟,允许重试)
  let statusCode = 0
  let statusBody: any = {}
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${AGENT}/agents/${tokenId}/status`, {
      headers: { Authorization: `Bearer ${verifyRes.token}`, 'X-Chain-Key': 'solana-testnet' },
    })
    statusCode = res.status
    statusBody = await res.json()
    if (statusCode === 200) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.log('[7] GET /agents/:tokenId/status(带 JWT):', statusCode, JSON.stringify(statusBody).slice(0, 300))

  // 无 JWT 必须 401
  const noAuth = await fetch(`${AGENT}/agents/${tokenId}/status`)
  console.log('[8] 无 JWT 状态码(期望 401):', noAuth.status)

  // 公开调试接口:读链人格(新铸造 → 默认人格兜底)
  const persona = await fetch(`${AGENT}/agents/${tokenId}/persona`, {
    headers: { 'X-Chain-Key': 'solana-testnet' },
  }).then((r) => r.json())
  console.log('[9] GET /agents/:tokenId/persona:', persona.name, 'fromChain =', persona.fromChain, 'owner =', persona.owner)

  const ok =
    verifyRes.chain === 'solana' &&
    bad.status === 401 &&
    replay.status === 401 &&
    statusCode === 200 &&
    statusBody.tokenId === tokenId &&
    noAuth.status === 401 &&
    persona.owner === address &&
    persona.fromChain === false
  console.log(ok ? '✅ E2E 全部通过' : '❌ E2E 存在失败项')
  if (!ok) process.exit(1)
}

main().catch((err) => {
  console.error('E2E 失败:', err)
  process.exit(1)
})
