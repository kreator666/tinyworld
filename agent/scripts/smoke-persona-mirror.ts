// persona 镜像链路冒烟:update_persona 上链 hash → PUT 镜像 → loadPersona 校验装载
// 用法: npx tsx scripts/smoke-persona-mirror.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { keccak256, toBytes } from 'viem'
import idl from '../src/idl/tinyworld.json'

const RPC = process.env.SOLANA_RPC ?? 'https://api.testnet.solana.com'
const AGENT = process.env.AGENT_URL ?? 'http://localhost:4111'
const PROGRAM_ID = new PublicKey('5JEXwXv9VqiKnokZ8sRVkxM4ws6BwHcFH67rL3YKhVKp')

// 用最近一次 E2E 铸造的身份(其密钥不在这里,所以本脚本只负责写链 + 读端验证;
// 身份密钥从 solana 部署钱包派生一个专用密钥并先铸造,见 e2e-solana-login.mts)
// —— 简化:直接生成新身份走完整流程太重,这里改用一个轻量做法:
// 从文件读取 e2e 保存的密钥(若存在),否则跳过。

async function main() {
  const keyFile = path.join(os.tmpdir(), 'tw-e2e-key.json')
  if (!fs.existsSync(keyFile)) {
    console.log('跳过:未找到 e2e 密钥文件(本脚本需与 e2e-solana-login 联跑)')
    return
  }
  const me = Keypair.fromSecretKey(Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))))
  const connection = new Connection(RPC, 'confirmed')
  const identityPda = PublicKey.findProgramAddressSync([Buffer.from('identity'), me.publicKey.toBuffer()], PROGRAM_ID)[0]

  const persona = JSON.stringify({ template: '活泼', personality: '爱聊 Web3 的元气少女', tone: '活泼可爱' })
  const hash = keccak256(toBytes(persona))

  // update_persona 要求 agent_permission PDA 已初始化(owner 路径也需要该账户可解析):
  // 先用 set_agent 给自己授 PERMISSION_PERSONA(bit0)
  const setAgentIx = (idl as any).instructions.find((i: any) => i.name === 'set_agent')
  const agentPermPda = PublicKey.findProgramAddressSync(
    [Buffer.from('agent-permission'), identityPda.toBuffer(), me.publicKey.toBuffer()],
    PROGRAM_ID,
  )[0]
  const setTx = new Transaction().add(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([Buffer.from(setAgentIx.discriminator), me.publicKey.toBuffer(), Buffer.from([1])]),
      keys: [
        { pubkey: identityPda, isSigner: false, isWritable: true },
        { pubkey: me.publicKey, isSigner: true, isWritable: true },
        { pubkey: me.publicKey, isSigner: false, isWritable: false },
        { pubkey: agentPermPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  )
  await sendAndConfirmTransaction(connection, setTx, [me])
  console.log('[0] set_agent 授权 PERMISSION_PERSONA 完成')

  const ix = (idl as any).instructions.find((i: any) => i.name === 'update_persona')
  const arweave = ''
  const arwBuf = Buffer.from(arweave, 'utf8')
  const data = Buffer.concat([
    Buffer.from(ix.discriminator),
    Buffer.from(hash.slice(2), 'hex'),
    Buffer.from([arwBuf.length, 0, 0, 0]),
    arwBuf,
  ])
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      data,
      keys: [
        { pubkey: identityPda, isSigner: false, isWritable: true },
        { pubkey: me.publicKey, isSigner: true, isWritable: false },
        { pubkey: agentPermPda, isSigner: false, isWritable: false },
      ],
    }),
  )
  await sendAndConfirmTransaction(connection, tx, [me])
  console.log('[1] update_persona 上链, hash =', hash)

  const put = await fetch(`${AGENT}/personas/${hash}`, { method: 'PUT', body: persona })
  console.log('[2] PUT 镜像:', put.status)

  // 通过本地函数读链(tokenId 由链上解析;本脚本固定 solana-testnet)
  const { resolveTokenId, loadPersona } = await import('../src/chain/persona')
  const tokenId = await resolveTokenId('solana-testnet', me.publicKey.toBase58())
  const p = await loadPersona('solana-testnet', tokenId, true)
  console.log('[3] loadPersona: name =', p.name, 'fromChain =', p.fromChain, 'contentHash =', p.contentHash)
  console.log('    profile.template =', p.profile.template, 'personality =', p.profile.personality)
  const ok = p.fromChain === true && p.contentHash === hash && p.profile.template === '活泼'
  console.log(ok ? '✅ persona 镜像链路通过' : '❌ persona 镜像链路失败')
  if (!ok) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
