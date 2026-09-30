// 一次性端到端验证:Fuji AVAX→USDT(TraderJoe V1)
// 1) 策略引擎对白名单内 USDT 兑换的判定  2) 热钱包真实小额 swap 并核实回执+余额差
import { parseEther, formatUnits } from 'viem'
import { config } from '../src/config'
import { quoteSwap, executeSwap, getTokenBalance, getAgentWalletAddress } from '../src/chain/defi'
import { evaluateProposal, type Proposal } from '../src/policy/engine'

const USDT = config.chain.defi.usdt
const amountIn = parseEther('0.001') // 0.001 AVAX(热钱包余额 ~0.002,留 gas)
const amountInHuman = '0.001'

const quoted = await quoteSwap(amountIn, USDT)
console.log(`报价: ${amountInHuman} AVAX -> ${formatUnits(quoted, 6)} USDT`)

const proposal: Proposal = {
  action: 'swap',
  protocol: config.chain.defi.router,
  chainId: config.chain.chainId,
  executionMode: 'hot_wallet',
  params: {
    tokenIn: 'native',
    tokenOut: USDT,
    amountIn: amountIn.toString(),
    amountOutMin: ((quoted * 9950n) / 10000n).toString(),
  },
  estimatedValueUsd: 0.08, // 测试网 AVAX 约 $8,0.01 AVAX ≈ $0.08
  reason: '端到端验证 AVAX/USDT 流动性接入',
}
const verdict = await evaluateProposal(proposal)
console.log(`策略引擎判定: ${verdict.verdict} ${verdict.reasons.join('; ')}`)
if (verdict.verdict === 'rejected') throw new Error('策略引擎拒绝,终止')

const wallet = getAgentWalletAddress()
console.log(`热钱包: ${wallet}`)
const before = await getTokenBalance(USDT, wallet!)
console.log(`兑换前 USDT 余额: ${formatUnits(before, 6)}`)

const r = await executeSwap(amountIn, BigInt(proposal.params.amountOutMin!), USDT)
const after = await getTokenBalance(USDT, wallet!)
console.log(`tx: ${config.chain.explorer}/tx/${r.txHash}`)
console.log(`链上回报 amountOut: ${formatUnits(r.amountOut, 6)} USDT`)
console.log(`余额差核实: ${formatUnits(after - before, 6)} USDT`)
if (after - before !== r.amountOut) throw new Error('余额差与回执不一致')
console.log('E2E 验证通过 ✅')
