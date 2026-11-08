// 主网生存模式热钱包:生成受限 FunctionCall 子密钥并挂上链(密钥轮换/初始化用)
// 用法:
//   printf '%s' 'ed25519:<主私钥>' > /tmp/.ak && chmod 600 /tmp/.ak
//   ACCOUNT_KEY_FILE=/tmp/.ak OUT_FILE=/tmp/.survival-env npx tsx scripts/near-mainnet-subkey.ts
//   rm -f /tmp/.ak   # 主私钥用后即删,永不留存
// 输出 OUT_FILE 为 .env 片段(AGENT_NEAR_MAINNET_ACCOUNT_ID / AGENT_NEAR_MAINNET_KEYS JSON)
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js'
import { readFileSync, writeFileSync } from 'node:fs'
import BN from 'bn.js'

const ACCOUNT_ID = process.env.SURVIVAL_ACCOUNT_ID ?? 'agentverse-survival.near'
const RPC = 'https://rpc.mainnet.fastnear.com'
const ALLOWANCE_NEO = process.env.ALLOWANCE_NEO ?? '5' // 子密钥 gas 津贴上限

// 生存模式分配会触达的合约白名单(与 survivalAllocate/metapool/ref 的调用一一对应)
const SPECS: Array<{ receiver: string; methods: string[] }> = [
  { receiver: 'wrap.near', methods: ['near_deposit', 'near_withdraw', 'ft_transfer_call'] },
  { receiver: 'v2.ref-finance.near', methods: ['storage_deposit', 'ft_transfer_call'] },
  { receiver: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', methods: ['storage_deposit'] }, // 原生 USDC
  { receiver: 'meta-pool.near', methods: ['deposit_and_stake'] },
]

function randomKeyPair(): KeyPair {
  const fromRandom = (utils as { KeyPair?: { fromRandom: (curve: string) => KeyPair } }).KeyPair?.fromRandom
  if (fromRandom) return fromRandom('ed25519')
  // 兼容旧版 near-api-js
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KeyPairEd25519 } = require('near-api-js') as { KeyPairEd25519: { fromRandom: () => KeyPair } }
  return KeyPairEd25519.fromRandom()
}

async function main() {
  const keyFile = process.env.ACCOUNT_KEY_FILE
  const outFile = process.env.OUT_FILE
  if (!keyFile || !outFile) throw new Error('需要 ACCOUNT_KEY_FILE(主私钥临时文件)与 OUT_FILE(.env 输出)')
  const accountKey = readFileSync(keyFile, 'utf8').trim()
  const keyStore = new keyStores.InMemoryKeyStore()
  await keyStore.setKey('mainnet', ACCOUNT_ID, KeyPair.fromString(accountKey as `ed25519:${string}`))
  const near = await connect({ networkId: 'mainnet', nodeUrl: RPC, keyStore, headers: {} })
  const account = await near.account(ACCOUNT_ID) // near-api-js 5.x:account() 返回 Promise
  const allowance = new BN(utils.format.parseNearAmount(ALLOWANCE_NEO)!)

  const map: Record<string, string> = {}
  // 清理旧子密钥(同 receiver+methods 的 FunctionCall 钥匙,防止轮换堆积)
  const existing = await account.getAccessKeys()
  for (const k of existing) {
    const perm = k.access_key.permission
    if (typeof perm !== 'string' && perm?.FunctionCall) {
      const fc = perm.FunctionCall
      const spec = SPECS.find((s) => s.receiver === fc.receiver_id)
      if (spec && fc.method_names.every((m) => spec.methods.includes(m))) {
        await account.deleteKey(k.public_key)
        console.log(`cleanup old key for ${fc.receiver_id}`)
      }
    }
  }
  for (const spec of SPECS) {
    const kp = randomKeyPair()
    const pub = kp.getPublicKey().toString()
    // near-api-js 5.x: addKey(publicKey, contractId, methodNames, amount) = FunctionCall 受限钥匙;contractId 缺省才是 FullAccess
    const outcome = await account.addKey(pub, spec.receiver, spec.methods, allowance)
    const secret = kp.toString() // KeyPair.toString() = "ed25519:<base58>" 编码私钥
    if (!secret.startsWith('ed25519:')) throw new Error(`子密钥导出格式异常: ${secret.slice(0, 12)}…`)
    map[spec.receiver] = secret
    const status = (outcome as { status?: unknown }).status
    console.log(`add-key ${spec.receiver.padEnd(20)} ${pub.slice(0, 16)}… status=${JSON.stringify(status).slice(0, 60)}`)
  }
  const env = `AGENT_NEAR_MAINNET_ACCOUNT_ID=${ACCOUNT_ID}\nAGENT_NEAR_MAINNET_KEYS=${JSON.stringify(map)}\n`
  writeFileSync(outFile, env, { mode: 0o600 })
  console.log(`ENV WRITTEN -> ${outFile}(4 把受限子密钥;泄露也转不走钱,可 delete-key 吊销)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
