// ============================================================
// Meteora DLMM 真实兑换端到端自测(devnet)
// 运行:cd agent && npx tsx scripts/meteora-swap-test.ts
// 覆盖真实代码路径:src/chain/meteora.ts 的 quoteMeteoraSwap / executeMeteoraSwap
// (SOL→USDC 0.02 SOL,USDC→SOL 1 tUSDC),前后读余额断言资金确实移动。
// 注意:在导入任何 src 模块前注入 env(本地 .env 未配 AGENT_SOLANA_PRIVATE_KEY / SOLANA_USDC_MINT)。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const keyPath = fileURLToPath(new URL('../../solana/.agent-sol.key', import.meta.url))
process.env.AGENT_SOLANA_PRIVATE_KEY ||= readFileSync(keyPath, 'utf8').trim()
process.env.SOLANA_USDC_MINT ||= 'BrUqLZyTAQX8H7M1UdkipKJFEfYW2Sj9PyMAUwgYVq2k'
process.env.TARGET_CHAIN ||= 'solana-devnet'

const CHAIN = 'solana-devnet'
const WSOL = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS = 500 // 池子浅(0.1 SOL/20 USDC),跨 ~2 个 bin ≈ 2% 冲击,给 5% 滑点

const { Connection, PublicKey } = await import('@solana/web3.js')
const { getChainContext } = await import('../src/chain/registry')
const { usdcMintOf } = await import('../src/chain/jupiter')
const { quoteMeteoraSwap, executeMeteoraSwap, meteoraPoolAddress, isMeteoraSwapConfigured } = await import('../src/chain/meteora')

const ctx = getChainContext(CHAIN)
const conn = new Connection(ctx.cfg.rpc, 'confirmed')
const WALLET = new PublicKey('89cSXCwnYfA31Lrbw45RZjtfNEmGrYFA3yzRxJkfWhnS')

console.log('chain        :', CHAIN, `(family=${ctx.family})`)
console.log('pool         :', meteoraPoolAddress().toBase58())
console.log('configured   :', isMeteoraSwapConfigured())
console.log('usdcMint     :', usdcMintOf(CHAIN))

async function balances() {
  const sol = (await conn.getBalance(WALLET)) / 1e9
  const usdcAta = (
    await conn.getTokenAccountsByOwner(WALLET, { mint: new PublicKey(usdcMintOf(CHAIN)) })
  ).value[0]
  const usdc = usdcAta
    ? (await conn.getTokenAccountBalance(usdcAta.pubkey)).value.uiAmount ?? 0
    : 0
  return { sol, usdc }
}

async function swap(tokenIn: 'SOL' | 'USDC', tokenOut: 'SOL' | 'USDC', amountHuman: string, amountAtomic: bigint) {
  const inMint = tokenIn === 'SOL' ? WSOL : usdcMintOf(CHAIN)
  const outMint = tokenOut === 'SOL' ? WSOL : usdcMintOf(CHAIN)
  const before = await balances()
  console.log(`\n=== ${tokenIn} → ${tokenOut} ${amountHuman} ===`)
  console.log('before:', JSON.stringify(before))
  const quote = await quoteMeteoraSwap(CHAIN, inMint, outMint, amountAtomic, SLIPPAGE_BPS)
  console.log(`quote: in=${amountAtomic.toString()} → out=${quote.outAmount}(pool ${quote.poolId})`)
  const sig = await executeMeteoraSwap(CHAIN, inMint, outMint, amountAtomic, SLIPPAGE_BPS)
  console.log('signature:', sig)
  const after = await balances()
  console.log('after :', JSON.stringify(after))
  const dSol = after.sol - before.sol
  const dUsdc = (after.usdc ?? 0) - (before.usdc ?? 0)
  console.log(`delta : SOL ${dSol.toFixed(6)}, USDC ${dUsdc.toFixed(6)}`)
  return { sig, before, after, dSol, dUsdc }
}

if (!isMeteoraSwapConfigured()) throw new Error('Meteora 未配置(AGENT_SOLANA_PRIVATE_KEY/SOLANA_USDC_MINT)')

// 1) SOL → USDC 0.02
const r1 = await swap('SOL', 'USDC', '0.02', 20_000_000n)
if (r1.dSol >= -0.019 || r1.dUsdc <= 0) throw new Error(`SOL→USDC 余额未按预期移动: ${JSON.stringify(r1)}`)
console.log(`\n✅ SOL→USDC ok: https://explorer.solana.com/tx/${r1.sig}?cluster=devnet`)

// 2) USDC → SOL 1
const r2 = await swap('USDC', 'SOL', '1', 1_000_000n)
if (r2.dUsdc >= -0.99 || r2.dSol <= 0) throw new Error(`USDC→SOL 余额未按预期移动: ${JSON.stringify(r2)}`)
console.log(`\n✅ USDC→SOL ok: https://explorer.solana.com/tx/${r2.sig}?cluster=devnet`)

console.log('\n全部通过')
