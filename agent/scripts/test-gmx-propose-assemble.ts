import { formatEther, parseUnits, type Address } from 'viem'
import { findMarketByIndexSymbol, estimateGmxExecutionFee } from '../src/chain/gmx'
import { buildUnsignedGmxOrder, buildGmxOrderProposal } from '../runtime-skills/builtins/defi-perp-gmx'

process.env.TARGET_CHAIN = 'avalanche'

async function main() {
  const chainKey = 'avalanche'

  // 1. 通过常用别名找到永续市场(AVAX->WAVAX)
  const market = await findMarketByIndexSymbol(chainKey, 'AVAX')
  if (!market) throw new Error('未找到 AVAX 永续市场')
  if (market.indexToken.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error('命中的是现货兑换市场,不是永续')
  }
  console.log('matched market:', market.indexSymbol, market.marketToken)

  // 2. 测试提案构建(不广播)
  const sizeUsd = '100'
  const collateralAmount = parseUnits('0.1', 18)
  const proposal = await buildGmxOrderProposal(
    chainKey,
    market,
    'LONG',
    'increase',
    sizeUsd,
    market.longToken as Address,
    collateralAmount,
    'user_wallet',
    '测试用例:组装 GMX 多单',
  )
  console.log('proposal action:', proposal.action)
  console.log('proposal protocol:', proposal.protocol)
  console.log('proposal tokenIn:', proposal.params.tokenIn)
  console.log('proposal amountIn:', proposal.params.amountIn)
  console.log('proposal estimatedValueUsd:', proposal.estimatedValueUsd)

  // 3. 测试 unsigned txs 组装(使用一个虚拟用户地址,无需真实余额)
  const dummyUser = '0x1234567890123456789012345678901234567890' as Address
  const executionFee = await estimateGmxExecutionFee(chainKey, 'increase')
  console.log('estimated executionFee:', formatEther(executionFee), 'AVAX')
  if (executionFee <= 0n) throw new Error('执行费估算失败')
  const unsignedTxs = await buildUnsignedGmxOrder(
    chainKey,
    market,
    'LONG',
    'increase',
    sizeUsd,
    market.longToken as Address,
    collateralAmount,
    dummyUser,
    executionFee,
  )

  console.log('unsignedTxs count:', unsignedTxs.length)
  for (const tx of unsignedTxs) {
    console.log(`- to:${tx.to} value:${formatEther(BigInt(tx.value))} description:${tx.description}`)
  }

  // 4. 基础断言
  if (unsignedTxs.length !== 2) throw new Error(`期望 2 笔 unsigned tx,实际 ${unsignedTxs.length}`)
  const [approveTx, orderTx] = unsignedTxs
  if (approveTx.to.toLowerCase() !== market.longToken.toLowerCase()) throw new Error('第一笔应为抵押品 approve')
  if (orderTx.to.toLowerCase() !== proposal.protocol.toLowerCase()) throw new Error('第二笔应发往 ExchangeRouter')
  if (BigInt(orderTx.value) !== executionFee) throw new Error('第二笔 value 应等于 executionFee')

  console.log('\nPASS: GMX propose 组装测试通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
