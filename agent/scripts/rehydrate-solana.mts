// Solana 测试网重置后的链上身份重建脚本(镜像表 chain_identities 为重建种子)
//
// 用法(在 agent/ 目录):
//   TARGET_CHAIN=solana-testnet npx tsx scripts/rehydrate-solana.mts [--dry-run]
//
// 流程:
//   1. 检查程序账户存活(executable);缺失则提示先 anchor deploy(solana/redeploy-devnet.sh)
//   2. 读镜像表,筛出 owner = 本地钱包(~/.config/solana/id.json)的身份
//      —— mint_identity 要求 owner 签名,别人的身份只能列出清单,由各主人自行重铸
//   3. 余额不足时向官方水龙头领水(备用节点无水龙头)
//   4. config PDA 缺失则 initialize_config
//   5. 逐个重铸 mint_identity(已存在的跳过),并按旧镜像调 update_persona 恢复人格哈希
//   6. 回写镜像表的新 token_id/mint(随机 mint 派生,重置后必然变化),
//      并列出需要主人自行重铸的身份清单
//
// 注意:token_id = mint 前 8 字节,重铸后必然变化;DB 里按旧 token_id 关联的数据
// (memories/conversations 等)需要业务侧另行迁移或按 owner 重新关联。
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
} from '@solana/web3.js'
import jsSha3 from 'js-sha3'
import { config } from '../src/config'
import { initSchema, listChainIdentities, rewriteChainIdentityToken, getDb, type ChainIdentityRow } from '../src/db'
import idl from '../src/idl/tinyworld.json'

const DRY_RUN = process.argv.includes('--dry-run')
const PROGRAM_ID = new PublicKey(config.chain.identityAddress)
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const ZERO_HASH = '0x' + '0'.repeat(64)

function ixDisc(name: string): Buffer {
  const ix = (idl.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === name)
  if (!ix) throw new Error(`IDL 缺少指令: ${name}`)
  return Buffer.from(ix.discriminator)
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]
}

function encodeString(s: string): Buffer {
  const body = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(body.length, 0)
  return Buffer.concat([len, body])
}

/** ATA(Token-2022 同样推导):findProgramAddress([owner, token_program, mint]) */
function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

function tokenIdFromMint(mint: string): number {
  const bytes = new PublicKey(mint).toBytes()
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return Number(v)
}

async function sendIx(
  conn: Connection,
  wallet: Keypair,
  signers: Keypair[],
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction()
  tx.add(ix)
  tx.feePayer = wallet.publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.sign(wallet, ...signers)
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction(sig, 'confirmed')
  return sig
}

async function ensureBalance(conn: Connection, wallet: Keypair): Promise<void> {
  const bal = await conn.getBalance(wallet.publicKey)
  console.log(`钱包 ${wallet.publicKey.toBase58()} 余额 ${(bal / 1e9).toFixed(4)} SOL`)
  if (bal >= 0.2 * 1e9) return
  console.log('余额不足,向官方水龙头领水(备用节点无水龙头,限流时会重试)...')
  for (let i = 1; i <= 8; i++) {
    try {
      const sig = await conn.requestAirdrop(wallet.publicKey, 1e9)
      await conn.confirmTransaction(sig, 'confirmed')
      console.log(`  第 ${i} 次领水成功`)
      return
    } catch (e) {
      console.log(`  第 ${i} 次领水失败: ${String(e).slice(0, 100)}`)
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }
  throw new Error('领水失败 8 次,稍后重试或到 https://faucet.solana.com 手动领取')
}

async function main(): Promise<void> {
  if (config.chain.family !== 'solana') {
    throw new Error(`TARGET_CHAIN 必须是 solana 家族(当前 ${config.chainKey})`)
  }
  console.log(`== rehydrate ${config.chainKey} → ${config.chain.rpc}${DRY_RUN ? '(dry-run)' : ''}`)

  await initSchema()
  const conn = new Connection(config.chain.rpc, 'confirmed')

  // 1. 程序存活检查
  const prog = await conn.getAccountInfo(PROGRAM_ID)
  if (!prog || !prog.executable) {
    throw new Error(
      `程序 ${PROGRAM_ID.toBase58()} 不存在或不可执行(测试网已被重置)。\n` +
        '请先用固定密钥对重新部署(程序 ID 不变):\n' +
        '  cd solana && anchor deploy --provider.cluster testnet\n' +
        '  (或 solana/redeploy-devnet.sh,需要 ~7.5 SOL 租金)\n' +
        '部署完成后再跑本脚本。',
    )
  }
  console.log('程序存活 ✓')

  // 2. 本地钱包 + 镜像筛选
  const keypairPath = process.env.SOLANA_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json')
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))))
  const rows = await listChainIdentities(config.chainKey)
  console.log(`镜像共 ${rows.length} 条身份`)
  if (rows.length === 0) {
    console.log('镜像为空:链上身份从未被镜像过(或数据库也是新的)。无法重建。')
    return
  }
  const mine = rows.filter((r) => r.owner === wallet.publicKey.toBase58())
  const others = rows.filter((r) => r.owner !== wallet.publicKey.toBase58())
  const blocked: { row: ChainIdentityRow; reason: string }[] = []

  if (DRY_RUN) {
    console.log(`\n[dry-run] 将重铸 ${mine.length} 个本钱包身份:`, mine.map((r) => r.name).join(', ') || '(无)')
    console.log(`[dry-run] ${others.length} 个身份需各主人自行重铸(列表见下)`)
  } else {
    await ensureBalance(conn, wallet)

    // 4. config PDA
    const configPda = pda([Buffer.from('config')])
    if (await conn.getAccountInfo(configPda)) {
      console.log('config PDA 已存在,跳过 initialize_config')
    } else {
      console.log('initialize_config...')
      await sendIx(
        conn,
        wallet,
        [],
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: configPda, isSigner: false, isWritable: true },
            { pubkey: pda([Buffer.from('mint-auth')]), isSigner: false, isWritable: false },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: ixDisc('initialize_config'),
        }),
      )
      console.log('  ✓ config 已初始化')
    }

    // 5. 逐个重铸本钱包身份
    for (const row of mine) {
      const identityPda = pda([Buffer.from('identity'), wallet.publicKey.toBuffer()])
      if (await conn.getAccountInfo(identityPda)) {
        console.log(`身份 ${row.name} 已存在,跳过`)
        continue
      }
      const nameHash = Buffer.from(jsSha3.keccak_256.arrayBuffer(Buffer.from(row.name.toLowerCase(), 'utf8')))
      const nameRecord = pda([Buffer.from('name-record'), nameHash])
      const mint = Keypair.generate()
      console.log(`重铸 ${row.name} ...`)
      try {
        await sendIx(
          conn,
          wallet,
          [mint],
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
              { pubkey: identityPda, isSigner: false, isWritable: true },
              { pubkey: nameRecord, isSigner: false, isWritable: true },
              { pubkey: mint.publicKey, isSigner: true, isWritable: true },
              { pubkey: ata(wallet.publicKey, mint.publicKey), isSigner: false, isWritable: true },
              { pubkey: pda([Buffer.from('mint-auth')]), isSigner: false, isWritable: false },
              { pubkey: configPda, isSigner: false, isWritable: false },
              { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              // Option 占位:程序 ID = None(费率=0 时);费率>0 时须传 config authority
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([ixDisc('mint_identity'), encodeString(row.name)]),
          }),
        )
      } catch (e) {
        // NameTaken(6000):名字被占(名字记录未被重置释放/半关闭残留/被抢注),无法以旧名重建
        if (/NameTaken|6000|0x1770/.test(String(e))) {
          blocked.push({ row, reason: '名字已被占用(name-record 未释放),需改名或放弃' })
          console.log(`  ✗ ${row.name} 名字被占用,跳过(记入待处理清单)`)
          continue
        }
        throw e
      }
      // 旧镜像有人格哈希则恢复(零哈希无需)
      if (row.persona_hash && row.persona_hash !== ZERO_HASH) {
        const hashBytes = Buffer.from(row.persona_hash.replace(/^0x/, ''), 'hex')
        // Option<Account> 占位约定:传程序 ID 表示 None(owner 自签,无需 agent 授权账户)
        console.log(`  恢复人格哈希 ${row.persona_hash.slice(0, 12)}...`)
        await sendIx(
          conn,
          wallet,
          [],
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: identityPda, isSigner: false, isWritable: true },
              { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
              { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([ixDisc('update_persona'), hashBytes, encodeString(row.persona_arweave_id ?? '')]),
          }),
        )
      }
      // 6. 回写镜像新 token_id/mint
      const newMint = mint.publicKey.toBase58()
      await rewriteChainIdentityToken(config.chainKey, row.owner, String(tokenIdFromMint(newMint)), newMint)
      console.log(`  ✓ ${row.name} 重铸完成,新 mint ${newMint}`)
    }
  }

  if (blocked.length > 0) {
    console.log(`\n${blocked.length} 个本钱包身份重建受阻,需要人工处理:`)
    for (const b of blocked) console.log(`  - ${b.row.name}: ${b.reason}`)
  }

  if (others.length > 0) {
    console.log(`\n${others.length} 个身份需各主人用原钱包重新铸造(mint_identity 要求 owner 签名,无法代铸):`)
    for (const r of others) console.log(`  - ${r.name} (owner ${r.owner})`)
    console.log('重铸后 token_id 会变;DB 中按旧 token_id 关联的数据需按 owner 重新关联或迁移。')
  }
  console.log('\nREHYDRATE_DONE')
}

main()
  .catch((e) => {
    console.error('REHYDRATE_FAIL:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDbQuietly()
  })

async function closeDbQuietly(): Promise<void> {
  try {
    await (await getDb()).close()
  } catch {
    // 关闭失败不影响退出码
  }
}
