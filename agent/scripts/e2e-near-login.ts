// NEAR 登录(链上挑战 login_challenge)端到端测试
// 用法: cd agent && npx tsx scripts/e2e-near-login.ts [--http]
// 原理:前端钱包签名 login_challenge(nonce) 交易 → /auth/verify 的 signature 字段携带交易哈希
//      → 后端向 NEAR RPC 核对签名者/合约/方法/nonce/执行状态。
// 本脚本用 ~/.near-credentials/tinyworld.testnet.json 的密钥模拟钱包发真实挑战交易(testnet)。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect, keyStores, KeyPair } from 'near-api-js'
import { createNonce, verifyLogin, signJwt, verifyJwt } from '../src/core/auth.js'

const CHAIN = 'near-testnet'
const ACCOUNT = 'tinyworld.testnet' // 挑战交易签名者(用其密钥模拟钱包)
const RPC = 'https://rpc.testnet.fastnear.com' // rpc.testnet.near.org 已弃用(429)

// ---------- 模拟钱包:发 login_challenge 交易 ----------
let account: import('near-api-js').Account
async function walletSendChallenge(nonce: string): Promise<string> {
  const outcome = await account.functionCall({
    contractId: ACCOUNT,
    methodName: 'login_challenge',
    args: { nonce },
    gas: 30n * 10n ** 12n,
    attachedDeposit: 0n,
  })
  const hash =
    (outcome as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ??
    (outcome as { transaction?: { hash?: string } })?.transaction?.hash
  if (!hash) throw new Error('交易未返回哈希')
  return hash
}

function buildLoginMessage(address: string, nonce: string): string {
  return [
    'AgentVerse 登录验证',
    `地址: ${address}`,
    `随机数: ${nonce}`,
    `时间: ${new Date().toISOString()}`,
    `链: ${CHAIN}`,
  ].join('\n')
}

let passed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    console.error(`FAIL  ${name}: ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
  }
}

async function main() {
  const cred = JSON.parse(readFileSync(join(homedir(), '.near-credentials', `${ACCOUNT}.json`), 'utf8'))
  const keyStore = new keyStores.InMemoryKeyStore()
  await keyStore.setKey('testnet', ACCOUNT, KeyPair.fromString(cred.private_key))
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore })
  account = await near.account(ACCOUNT)
  console.log(`== NEAR 链上挑战登录测试(signer: ${ACCOUNT}) ==`)

  console.log('== 函数级:verifyLogin ==')
  await check('正常登录通过(真实挑战交易)', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, nonce)
    const txHash = await walletSendChallenge(nonce)
    const res = await verifyLogin(CHAIN, { message, signature: txHash })
    if (res.address !== ACCOUNT || res.chain !== 'near') throw new Error(`unexpected ${JSON.stringify(res)}`)
  })

  await check('重放同一交易:nonce 已消费,拒绝', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, nonce)
    const txHash = await walletSendChallenge(nonce)
    await verifyLogin(CHAIN, { message, signature: txHash })
    await verifyLogin(CHAIN, { message, signature: txHash }).then(
      () => { throw new Error('重放竟然通过') },
      () => {},
    )
  })

  await check('消息地址与交易签名者不符:拒绝', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage('mallory.testnet', nonce) // 冒用他人地址
    const txHash = await walletSendChallenge(nonce)
    await verifyLogin(CHAIN, { message, signature: txHash }).then(
      () => { throw new Error('冒名竟然通过') },
      () => {},
    )
  })

  await check('交易 nonce 与消息 nonce 不一致:拒绝', async () => {
    const a = createNonce(CHAIN, ACCOUNT)
    const b = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, b.nonce) // 消息用 nonce B
    const txHash = await walletSendChallenge(a.nonce) // 交易带 nonce A
    await verifyLogin(CHAIN, { message, signature: txHash }).then(
      () => { throw new Error('nonce 错位竟然通过') },
      () => {},
    )
  })

  await check('链标识错误:拒绝(400,不发交易)', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, nonce).replace(`链: ${CHAIN}`, '链: near-mainnet')
    await verifyLogin(CHAIN, { message, signature: '1'.repeat(44) }).then(
      () => { throw new Error('错误链标识竟然通过') },
      (e) => { if (e.status !== 400) throw new Error(`应为 400,实际 ${e.status}`) },
    )
  })

  await check('交易哈希格式不合法:拒绝(400)', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, nonce)
    await verifyLogin(CHAIN, { message, signature: 'not-a-tx-hash!!' }).then(
      () => { throw new Error('非法哈希竟然通过') },
      (e) => { if (e.status !== 400) throw new Error(`应为 400,实际 ${e.status}`) },
    )
  })

  await check('随机交易哈希(非挑战交易):拒绝', async () => {
    const { nonce } = createNonce(CHAIN, ACCOUNT)
    const message = buildLoginMessage(ACCOUNT, nonce)
    // 用一笔 mint_part 交易冒充挑战交易
    const outcome = await account.functionCall({
      contractId: ACCOUNT,
      methodName: 'mint_part',
      args: { to: ACCOUNT, part_id: '1001', amount: '1' },
      gas: 30n * 10n ** 12n,
      attachedDeposit: 0n,
    })
    const hash = (outcome as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ?? ''
    await verifyLogin(CHAIN, { message, signature: hash }).then(
      () => { throw new Error('非挑战交易竟然通过') },
      () => {},
    )
  })

  await check('JWT 签发/校验 roundtrip(chain=near)', () => {
    const token = signJwt({ address: ACCOUNT, chainId: 398, chain: 'near', chainKey: CHAIN })
    const decoded = verifyJwt(token)
    if (decoded.chain !== 'near' || decoded.address !== ACCOUNT || decoded.chainKey !== CHAIN) {
      throw new Error(`unexpected ${JSON.stringify(decoded)}`)
    }
  })

  // ---------- HTTP 级(需要 agent 服务在 :4111) ----------
  if (process.argv.includes('--http')) {
    console.log('== HTTP 级:/auth/nonce + /auth/verify ==')
    await check('HTTP 完整登录流程', async () => {
      const nonceRes = await fetch('http://localhost:4111/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN },
        body: JSON.stringify({ address: ACCOUNT }),
      })
      if (!nonceRes.ok) throw new Error(`nonce ${nonceRes.status}: ${await nonceRes.text()}`)
      const { nonce } = await nonceRes.json()
      const message = buildLoginMessage(ACCOUNT, nonce)
      const txHash = await walletSendChallenge(nonce)
      const verifyRes = await fetch('http://localhost:4111/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chain-Key': CHAIN },
        body: JSON.stringify({ message, signature: txHash }),
      })
      const body = await verifyRes.json()
      if (!verifyRes.ok) throw new Error(`verify ${verifyRes.status}: ${JSON.stringify(body)}`)
      if (body.chain !== 'near' || body.address !== ACCOUNT) throw new Error(`unexpected ${JSON.stringify(body)}`)
      console.log(`    verify ok: chain=${body.chain} address=${body.address} token=${String(body.token).slice(0, 24)}...`)
    })
  }

  console.log(`\n${passed} checks passed${process.exitCode ? ' (有失败)' : ''}`)
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1) })
