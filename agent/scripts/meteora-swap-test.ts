// ============================================================
// Meteora DLMM 真实兑换端到端自测(主网,小金额)
// 运行:cd agent && npx tsx scripts/meteora-swap-test.ts
// 覆盖真实代码路径:src/chain/meteora.ts 的 quoteMeteoraSwap / executeMeteoraSwap
// (SOL→USDC 0.02 SOL,USDC→SOL 1 USDC),前后读余额断言资金确实移动。
// 注意:在导入任何 src 模块前注入 env(本地 .env 未配 AGENT_SOLANA_PRIVATE_KEY)。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const keyPath = fileURLToPath(new URL('../../solana/.mainnet-hot.key', import.meta.url))
process.env.AGENT_SOLANA_PRIVATE_KEY ||= readFileSync(keyPath, 'utf8').trim()
process.env.TARGET_CHAIN ||= 'solana-devnet' // 身份链(devnet);兑换执行层在 mainnet(见 solanaExec)

const CHAIN = 'solana-devnet'
const WSOL = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS = 100 // 主网池流动性 ~$300k,1% 滑点足够

const { Connection, PublicKey } = await import('@solana/web3.js')
const { getChainContext } = await import('../src/chain/registry')
const { quoteMeteoraSwap, executeMeteoraSwap, meteoraPoolAddress, isMeteoraSwapConfigured } = await import('../src/chain/meteora')
const { MAINNET_RPC, MAINNET_USDC_MINT, mainnetTxUrl } = await import('../src/chain/solanaExec')

const ctx = getChainContext(CHAIN)
const conn = new Connection(MAINNET_RPC, 'confirmed') // 余额读自主网
const WALLET = new PublicKey('GTAUNuN1tW7Cuh8FUvi1d3ZkJ1Cvyzg4eckuRzK3VXsB')
const USDC = new PublicKey(MAINNET_USDC_MINT)

console.log('identity chain:', CHAIN, `(family=${ctx.family})`)
console.log('exec          : mainnet (solanaExec)')
console.log('pool          :', meteoraPoolAddress().toBase58())
console.log('configured    :', isMeteoraSwapConfigured())
console.log('usdcMint      :', MAINNET_USDC_MINT)

async function balances() {
  const sol = (await conn.getBalance(WALLET)) / 1e9
  const usdcAta = (await conn.getTokenAccountsByOwner(WALLET, { mint: USDC })).value[0]
  const usdc = usdcAta ? ((await conn.getTokenAccountBalance(usdcAta.pubkey)).value.uiAmount ?? 0) : 0
  return { sol, usdc }
}

async function swap(tokenIn: 'SOL' | 'USDC', tokenOut: 'SOL' | 'USDC', amountHuman: string, amountAtomic: bigint) {
  const inMint = tokenIn === 'SOL' ? WSOL : MAINNET_USDC_MINT
  const outMint = tokenOut === 'SOL' ? WSOL : MAINNET_USDC_MINT
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

if (!isMeteoraSwapConfigured()) throw new Error('Meteora 未配置(AGENT_SOLANA_PRIVATE_KEY)')

// 1) SOL → USDC 0.02(≈$1.7 @ $84)
const r1 = await swap('SOL', 'USDC', '0.02', 20_000_000n)
if (r1.dSol >= -0.019 || r1.dUsdc <= 0) throw new Error(`SOL→USDC 余额未按预期移动: ${JSON.stringify(r1)}`)
console.log(`\n✅ SOL→USDC ok: ${mainnetTxUrl(r1.sig)}`)

// 2) USDC → SOL 1
const r2 = await swap('USDC', 'SOL', '1', 1_000_000n)
if (r2.dUsdc >= -0.99 || r2.dSol <= 0) throw new Error(`USDC→SOL 余额未按预期移动: ${JSON.stringify(r2)}`)
console.log(`\n✅ USDC→SOL ok: ${mainnetTxUrl(r2.sig)}`)

console.log('\n全部通过')
