// 主网生存模式热钱包:生成专用 FullAccess 子密钥并挂上链(密钥轮换/初始化用)
// 用法:
//   printf '%s' 'ed25519:<主私钥>' > /tmp/.ak && chmod 600 /tmp/.ak
//   ACCOUNT_KEY_FILE=/tmp/.ak OUT_FILE=/tmp/.survival-env npx tsx scripts/near-mainnet-subkey.ts
//   rm -f /tmp/.ak   # 主私钥用后即删,永不留存
// 输出 OUT_FILE 为 .env 片段(AGENT_NEAR_MAINNET_ACCOUNT_ID / AGENT_NEAR_MAINNET_KEYS JSON)
//
// 设计说明:首选本来是按合约受限的 FunctionCall 子密钥,但 NEAR 协议禁止 FC 钥匙
// 附带押金(InvalidAccessKeyError::DepositWithFunctionCall),而生存模式所有链上调用
// (near_deposit/deposit_and_stake/ft_transfer_call/storage_deposit)都要附押金 —— FC 钥匙无解。
// 退而求其次:专用 FullAccess 子密钥(与主钥匙分离,可在线 delete-key 吊销/轮换,链上可审计哪把钥匙签的名)。
import { connect, keyStores, KeyPair, utils } from 'near-api-js'
import { readFileSync, writeFileSync } from 'node:fs'

const ACCOUNT_ID = process.env.SURVIVAL_ACCOUNT_ID ?? 'agentverse-survival.near'
const RPC = 'https://rpc.mainnet.fastnear.com'

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

  // 清理旧子密钥:FunctionCall 钥匙(链上 FullAccess 权限是字符串 'FullAccess',天然跳过主钥匙;
  // 历史遗留的 FullAccess 子密钥无法与主钥匙区分,需手动在钱包里删)
  const existing = await account.getAccessKeys()
  for (const k of existing) {
    const perm = k.access_key.permission
    if (typeof perm !== 'string') {
      await account.deleteKey(k.public_key)
      console.log(`cleanup FC key -> ${perm?.FunctionCall?.receiver_id ?? '?'}`)
    }
  }
  const kp = randomKeyPair()
  const pub = kp.getPublicKey().toString()
  // addKey 不传 contractId = FullAccess 专用子密钥
  const outcome = await account.addKey(pub)
  const secret = kp.toString() // KeyPair.toString() = "ed25519:<base58>" 编码私钥
  if (!secret.startsWith('ed25519:')) throw new Error(`子密钥导出格式异常: ${secret.slice(0, 12)}…`)
  const status = (outcome as { status?: unknown }).status
  console.log(`add-key fullaccess ${pub.slice(0, 20)}… status=${JSON.stringify(status).slice(0, 60)}`)
  const env = `AGENT_NEAR_MAINNET_ACCOUNT_ID=${ACCOUNT_ID}\nAGENT_NEAR_MAINNET_KEYS=${JSON.stringify({ default: secret })}\n`
  writeFileSync(outFile, env, { mode: 0o600 })
  console.log(`ENV WRITTEN -> ${outFile}(专用 FullAccess 子密钥;主私钥仍在你自己手里,可 delete-key 吊销)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
