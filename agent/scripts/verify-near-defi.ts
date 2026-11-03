// P0/P1/P2 链上验证:NEAR 热钱包 → Ref 报价/兑换 → Burrow 存款/仓位
// 用法: cd agent && npx tsx scripts/verify-near-defi.ts
import { nearAgentAccountId, nearNativeBalance, isNearWriteReady } from '../src/chain/nearWrite.js'
import { refQuote, refSwap, refFtBalance, refTokenDecimals, REF_TESTNET_TOKENS } from '../src/chain/ref.js'
import { burrowSupply, burrowGetAccount } from '../src/chain/burrow.js'

const CHAIN = 'near-testnet'
const me = nearAgentAccountId()

console.log('write ready:', isNearWriteReady(), '| agent account:', me)
console.log('native balance NEAR:', (Number(await nearNativeBalance(CHAIN)) / 1e24).toFixed(4))

// 1) 报价:0.5 wNEAR → USDC
const decWnear = await refTokenDecimals(CHAIN, REF_TESTNET_TOKENS.WNEAR.contractId)
const decUsdc = await refTokenDecimals(CHAIN, REF_TESTNET_TOKENS.USDC.contractId)
console.log('decimals: wNEAR', decWnear, '| USDC', decUsdc)
const amountIn = BigInt(Math.round(0.5 * 10 ** decWnear)).toString()
const q = await refQuote(CHAIN, 'WNEAR', 'USDC', amountIn)
console.log(`quote: 0.5 WNEAR → ${(Number(q.amountOut) / 10 ** decUsdc).toFixed(4)} USDC (pool ${q.poolId})`)

// 2) 真兑换(hot_wallet)
const usdcBefore = await refFtBalance(CHAIN, REF_TESTNET_TOKENS.USDC.contractId, me)
const { txHash, amountOut } = await refSwap(CHAIN, 'WNEAR', 'USDC', amountIn)
// near-api-js functionCall 在 EXECUTED_OPTIMISTIC 即返回,余额轮询等待最终态
let usdcAfter = usdcBefore
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  usdcAfter = await refFtBalance(CHAIN, REF_TESTNET_TOKENS.USDC.contractId, me)
  if (BigInt(usdcAfter) > BigInt(usdcBefore)) break
}
console.log(`swap ok tx=${txHash}`)
console.log(`USDC balance: ${usdcBefore} → ${usdcAfter} (got ${amountOut})`)
if (BigInt(usdcAfter) <= BigInt(usdcBefore)) throw new Error('兑换后 USDC 未增加!')

// 3) Burrow 存入全部 USDC + 读仓位
const acc = await burrowGetAccount(CHAIN)
console.log('burrow registered before:', acc ? 'yes' : 'no')
const supplyTx = await burrowSupply(CHAIN, 'USDC', usdcAfter)
console.log('burrow supply tx:', supplyTx)
const after = await burrowGetAccount(CHAIN)
console.log('burrow supplied:', JSON.stringify(after?.supplied ?? []))
console.log('\nALL NEAR-DEFI CHECKS PASSED')
