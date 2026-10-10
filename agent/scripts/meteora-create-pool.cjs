// ============================================================
// Meteora DLMM 免许可池创建 + 注入流动性(devnet)
// 运行:cd agent && node scripts/meteora-create-pool.cjs
//
// 背景:devnet 上 DLMM 程序(LBUZKhRx...)已被官方升级到「可定制的免许可池」时代,
// SDK 0.7.7 自带的 initializeLbPair 需要 preset_parameter(仅管理员可建,devnet 未建),
// 因此池创建用与已部署程序同代的 IDL(0.8.6,来自 @meteora-ag/dlmm@1.4.0,存于
// 本目录 dlmm-0.8.6.json)经 @coral-xyz/anchor 直调
// initializeCustomizablePermissionlessLbPair;
// 加流动性仍走 SDK 0.7.7 的 LBCLMM.initializePositionAndAddLiquidityByWeight。
// ============================================================
const fs = require('node:fs')
const path = require('node:path')
const {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} = require('@solana/web3.js')
const {
  LBCLMM, LBCLMM_PROGRAM_IDS,
  deriveReserve, deriveOracle, deriveBinArrayBitmapExtension,
  binIdToBinArrayIndex, isOverflowDefaultBinArrayBitmap,
  getOrCreateATAInstruction, calculateSpotDistribution, wrapSOLInstruction,
} = require('@meteora-ag/dlmm-sdk')
// 用 SDK 自带的 anchor 0.28(与 IDL 0.8.6 同代;根目录 anchor 0.32 的 Program 构造器只认新 IDL 格式)
const anchor = require('@meteora-ag/dlmm-sdk/node_modules/@coral-xyz/anchor')
const BN = require('bn.js')

const IDL = require('./dlmm-0.8.6.json')

// ---------- 常量 ----------
const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const TUSDC_MINT = 'BrUqLZyTAQX8H7M1UdkipKJFEfYW2Sj9PyMAUwgYVq2k' // 我们自己的测试 USDC(SPL,6 位)
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ILM_BASE = new PublicKey('MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1') // 可定制免许可池 PDA 种子(官方 SDK 常量)
const BIN_STEP = 100 // 1%
const FEE_BPS = 100 // 目标基础费率 1%(程序内 base_factor = feeBps*10000/binStep)
const TARGET_USDC_PER_SOL = 200
const SEED_SOL = 0.1 // tokenX = WSOL
const SEED_TUSDC = 20 // tokenY = tUSDC
const BINS_EACH_SIDE = 5

// ---------- 热钱包 ----------
function base58Decode(text) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = 0n
  for (const ch of text) num = num * 58n + BigInt(ALPHABET.indexOf(ch))
  const bytes = []
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes])
}
const secret = fs.readFileSync(path.join(__dirname, '../../solana/.agent-sol.key'), 'utf8').trim()
const wallet = Keypair.fromSecretKey(base58Decode(secret))
console.log('hot wallet:', wallet.publicKey.toBase58())

const conn = new Connection(RPC, 'confirmed')
const programId = new PublicKey(LBCLMM_PROGRAM_IDS.devnet)
console.log('DLMM program:', programId.toBase58())

// ---------- 代币顺序(DLMM 要求 tokenX < tokenY,按公钥字节序) ----------
const mintWsol = new PublicKey(WSOL_MINT)
const mintTusdc = new PublicKey(TUSDC_MINT)
const [tokenX, tokenY] = mintWsol.toBuffer().compare(mintTusdc.toBuffer()) < 0 ? [mintWsol, mintTusdc] : [mintTusdc, mintWsol]
const decX = tokenX.equals(mintWsol) ? 9 : 6
const decY = tokenX.equals(mintWsol) ? 6 : 9
console.log(`tokenX=${tokenX.toBase58()} (${decX} dec), tokenY=${tokenY.toBase58()} (${decY} dec)`)

// ---------- activeBin:1 SOL ≈ TARGET_USDC_PER_SOL USDC ----------
// bin 价格 = (1+binStep/10000)^binId = 每 lamport-X 兑 lamport-Y(见 SDK getPriceOfBinByBinId)
// 人类价格 Y/X = 200 → pricePerLamport = 200 * 10^(decY-decX)
const pricePerLamport = TARGET_USDC_PER_SOL * 10 ** (decY - decX) // decY=6, decX=9 → 0.2
const activeId = Math.floor(Math.log(pricePerLamport) / Math.log(1 + BIN_STEP / 10000))
const sdkPrice = parseFloat(LBCLMM.getPriceOfBinByBinId(BIN_STEP, activeId)) // lamport-Y per lamport-X
const impliedUsdcPerSol = sdkPrice * 10 ** (decX - decY) // 人类价格 Y per X
console.log(`activeId=${activeId} (binStep=${BIN_STEP}) → 1 SOL ≈ ${impliedUsdcPerSol.toFixed(2)} USDC`)

// ---------- PDA ----------
const [minKey, maxKey] = tokenX.toBuffer().compare(tokenY.toBuffer()) < 0 ? [tokenX, tokenY] : [tokenY, tokenX]
const [lbPair] = PublicKey.findProgramAddressSync([ILM_BASE.toBuffer(), minKey.toBuffer(), maxKey.toBuffer()], programId)
const [reserveX] = deriveReserve(tokenX, lbPair, programId)
const [reserveY] = deriveReserve(tokenY, lbPair, programId)
const [oracle] = deriveOracle(lbPair, programId)
const binArrayIndex = binIdToBinArrayIndex(new BN(activeId))
const needExtension = isOverflowDefaultBinArrayBitmap(binArrayIndex)
const binArrayBitmapExtension = needExtension ? deriveBinArrayBitmapExtension(lbPair, programId)[0] : null
console.log('lbPair:', lbPair.toBase58(), '| binArrayIndex:', binArrayIndex.toString(), '| ext:', binArrayBitmapExtension?.toBase58() ?? 'none')

// ---------- 发送辅助(带 fresh blockhash 重试) ----------
async function sendAndConfirm(tx, signers, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight
      tx.sign(...signers)
      const sig = await conn.sendRawTransaction(tx.serialize())
      console.log(`[${label}] sent ${sig} (attempt ${attempt})`)
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
      console.log(`[${label}] confirmed`)
      return sig
    } catch (e) {
      const msg = String(e)
      console.log(`[${label}] attempt ${attempt} failed: ${msg.slice(0, 160)}`)
      if (attempt === 4) throw e
      await new Promise(r => setTimeout(r, 3000 * attempt))
    }
  }
}

async function balances() {
  const sol = (await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL
  const ataX = await getOrCreateATAInstruction(conn, tokenX, wallet.publicKey) // 只取地址不建
  const ataY = await getOrCreateATAInstruction(conn, tokenY, wallet.publicKey)
  const x = await conn.getTokenAccountBalance(ataX.ataPubKey).catch(() => null)
  const y = await conn.getTokenAccountBalance(ataY.ataPubKey).catch(() => null)
  const rx = await conn.getTokenAccountBalance(reserveX).catch(() => null)
  const ry = await conn.getTokenAccountBalance(reserveY).catch(() => null)
  return {
    sol: sol.toFixed(4),
    walletX: x ? `${x.value.uiAmount} (ata ${ataX.ataPubKey.toBase58()})` : '0 (no ata)',
    walletY: y ? `${y.value.uiAmount} (ata ${ataY.ataPubKey.toBase58()})` : '0 (no ata)',
    reserveX: rx ? rx.value.uiAmount : '?',
    reserveY: ry ? ry.value.uiAmount : '?',
  }
}

async function main() {
  const existed = await conn.getAccountInfo(lbPair)
  if (existed) {
    console.log('\n该交易对已存在(可能由先前运行创建),跳过创建,仅确认状态并补注流动性。')
  } else {
    // ---------- 1) 创建可定制免许可池(IDL 0.8.6 直调) ----------
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), { commitment: 'confirmed' })
    const program = new anchor.Program(IDL, programId, provider)
    const baseFactor = Math.floor((FEE_BPS * 10000) / BIN_STEP)
    const { ataPubKey: userTokenX, ix: createAtaXIx } = await getOrCreateATAInstruction(conn, tokenX, wallet.publicKey)
    const { ataPubKey: userTokenY, ix: createAtaYIx } = await getOrCreateATAInstruction(conn, tokenY, wallet.publicKey)
    // 程序要求 funder 的 tokenX(WSOL)ATA 里已有余额作为 "token launch proof":预包 0.11 SOL 进去
    const wrapIx = wrapSOLInstruction(wallet.publicKey, userTokenX, 110_000_000n) // 0.11 SOL
    const pre = [createAtaXIx, createAtaYIx, ...wrapIx].filter(Boolean)
    if (pre.length) console.log(`pre-instructions: ${pre.length}(创建缺失 ATA / 预包 WSOL)`)
    const tx = await program.methods
      .initializeCustomizablePermissionlessLbPair({
        activeId,
        binStep: BIN_STEP,
        baseFactor,
        activationType: 0, // 0 = 时间戳激活(无激活点 = 立即启用)
        hasAlphaVault: false,
        activationPoint: null,
        creatorPoolOnOffControl: false,
        padding: Buffer.alloc(63),
      })
      .accounts({
        lbPair,
        binArrayBitmapExtension,
        tokenMintX: tokenX,
        tokenMintY: tokenY,
        reserveX,
        reserveY,
        oracle,
        userTokenX,
        userTokenY,
        funder: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(pre)
      .transaction()
    await sendAndConfirm(tx, [wallet], 'create-pool')
    console.log('\n✅ pool created:', lbPair.toBase58())
  }

  // ---------- 2) 经 SDK 载入池子状态 ----------
  const [pair] = await LBCLMM.createMultiple(conn, [lbPair], { cluster: 'devnet' })
  const active = await pair.getActiveBin()
  console.log('on-chain activeBin:', active.binId, 'price:', active.price)
  console.log('fee info:', JSON.stringify(pair.getFeeInfo()))

  // ---------- 3) 注入双边流动性(SDK 一把梭:init position + 建 bin arrays + wrap SOL + add) ----------
  // 注意:SDK 的 processXYAmountDistribution 用 `binId !== currentBinId + 1` 连续性校验,
  // 只接受普通 number(传 BN 会因 +1 变字符串拼接而误报 Discontinuous),activeBin/binIds 全用 number
  const binIds = []
  for (let i = -BINS_EACH_SIDE; i <= BINS_EACH_SIDE; i++) binIds.push(activeId + i)
  const xYAmountDistribution = calculateSpotDistribution(activeId, binIds)
  const position = Keypair.generate()
  const seedTx = await pair.initializePositionAndAddLiquidityByWeight({
    positionPubKey: position.publicKey,
    totalXAmount: new BN(Math.round(SEED_SOL * 10 ** decX)),
    totalYAmount: new BN(Math.round(SEED_TUSDC * 10 ** decY)),
    xYAmountDistribution,
    user: wallet.publicKey,
  })
  await sendAndConfirm(seedTx, [wallet, position], 'seed-liquidity')

  // ---------- 4) 汇总 ----------
  await pair.refetchStates()
  const b = await balances()
  console.log('\n========== 结果 ==========')
  console.log('pair address :', lbPair.toBase58())
  console.log('binStep      :', BIN_STEP)
  console.log('activeBinId  :', active.binId)
  console.log('hot wallet   :', wallet.publicKey.toBase58())
  console.log('balances     :', JSON.stringify(b, null, 2))
  console.log(`explorer     : https://explorer.solana.com/address/${lbPair.toBase58()}?cluster=devnet`)
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
