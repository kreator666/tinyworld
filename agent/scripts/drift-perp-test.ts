// ============================================================
// Drift 永续 devnet 端到端实测(真实链上,不走 mock):
//   1) 经 Drift 官方 token faucet 领取保证金 USDC 并报余额
//   2) ensureDriftUser(初始化用户账户)
//   3) deposit 5 USDC
//   4) 市价开多 SOL-PERP(~10-20 USD 名义额)
//   5) driftStatus(确认持仓存在)
//   6) 市价平仓
//   7) withdraw 5 USDC(留余量供后续测试)
// 运行:npx tsx scripts/drift-perp-test.ts
// 私钥从 ../solana/.agent-sol.key 注入环境变量(先读后导,绝不打印)。
// ⚠ 链侧现状(2026-10):devnet Drift 程序为未发布分支构建,无法解析链上
// 市场账户——步骤 3(deposit)起会稳定报 SpotMarketNotFound(6087),
// 步骤 4 下单报 PerpMarketNotFound(6078)。faucet(步骤 1)与
// 用户账户初始化(步骤 2)真实成功,失败步骤的错误原样打印作为证据。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 必须在 import src 之前注入热钱包私钥(config.ts 在模块加载时读取)
const keyPath = fileURLToPath(new URL('../../solana/.agent-sol.key', import.meta.url))
process.env.AGENT_SOLANA_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim()
process.env.TARGET_CHAIN = process.env.TARGET_CHAIN || 'solana-devnet'

const CHAIN_KEY = 'solana-devnet'
const USDC = 6
const ONE_USDC = 10n ** BigInt(USDC)

function fmtUsdc(atomic: bigint): string {
  return (Number(atomic) / Number(ONE_USDC)).toFixed(2)
}

async function main() {
  const drift = await import('../src/chain/drift')
  const { getChainContext } = await import('../src/chain/registry')
  const ctx = getChainContext(CHAIN_KEY)
  console.log(`链: ${ctx.cfg.name} (${CHAIN_KEY}),Drift env = ${ctx.cfg.chainId === 103 ? 'devnet' : 'mainnet-beta'}`)

  const quote = drift.driftQuoteSpotMarket('devnet')
  console.log(`保证金市场: spot #${quote.marketIndex} ${quote.symbol} mint ${quote.mint}`)
  const solPerp = drift.driftPerpMarkets('devnet').find((m) => m.symbol === 'SOL-PERP')!
  console.log(`SOL-PERP: marketIndex ${solPerp.marketIndex}`)

  // 1) faucet 领取 USDC + 报余额
  console.log('\n[1] Drift devnet 水龙头领取 100 USDC …')
  const before = await drift.driftQuoteTokenBalance(CHAIN_KEY)
  console.log(`   领取前热钱包 USDC 余额: ${fmtUsdc(before)}`)
  let minted = false
  if (before < 20n * ONE_USDC) {
    const { signature, ata } = await drift.driftFaucetUsdc(CHAIN_KEY, 100n * ONE_USDC)
    console.log(`   水龙头铸造 tx: ${signature}(ATA ${ata})`)
    minted = true
  } else {
    console.log('   余额充足,跳过铸造')
  }
  const after = await drift.driftQuoteTokenBalance(CHAIN_KEY)
  console.log(`   领取后热钱包 USDC 余额: ${fmtUsdc(after)}`)
  if (minted && after <= before) throw new Error('faucet 后余额未增加')

  // 2) ensureDriftUser
  console.log('\n[2] 确保 Drift 用户账户存在 …')
  const { initialized, signature } = await drift.ensureDriftUser(CHAIN_KEY)
  console.log(initialized ? `   已初始化用户账户,tx: ${signature}` : '   用户账户已存在,跳过初始化')

  // 3) deposit 5 USDC
  console.log('\n[3] 存入 5 USDC 作为保证金 …')
  const depSig = await drift.driftDeposit(CHAIN_KEY, 5n * ONE_USDC)
  console.log(`   deposit tx: ${depSig}`)

  // 4) 开多 SOL-PERP,名义额 ~15 USD
  console.log('\n[4] 市价开多 SOL-PERP(名义额 ~15 USD)…')
  const oracle = await drift.driftOraclePriceUsd(CHAIN_KEY, solPerp.marketIndex)
  console.log(`   预言机价格: ${oracle.toFixed(4)} USD`)
  const baseAmount = await drift.driftCalcBaseAmount(CHAIN_KEY, solPerp.marketIndex, 15)
  console.log(`   换算 base 数量: ${baseAmount}(原子单位)`)
  const openSig = await drift.driftOpenPosition(CHAIN_KEY, solPerp.marketIndex, 'long', baseAmount)
  console.log(`   open tx: ${openSig}`)

  // 5) driftStatus:确认持仓存在
  console.log('\n[5] 查询账户状态(应看到持仓)…')
  let status = await drift.driftStatus(CHAIN_KEY)
  console.log(`   保证金 ${status.collateral} USDC,可用 ${status.freeCollateral} USDC,SOL-PERP 购买力 ${status.buyingPower} SOL`)
  console.log(`   持仓: ${JSON.stringify(status.positions)}`)
  const pos = status.positions.find((p) => p.marketIndex === solPerp.marketIndex)
  if (!pos || pos.side !== 'long' || Number(pos.base) <= 0) throw new Error('开仓后状态里没有多头持仓')

  // 6) 平仓
  console.log('\n[6] 市价平仓 …')
  const closeSig = await drift.driftClosePosition(CHAIN_KEY, solPerp.marketIndex)
  console.log(`   close tx: ${closeSig}`)
  status = await drift.driftStatus(CHAIN_KEY)
  console.log(`   平仓后持仓: ${JSON.stringify(status.positions)}`)
  if (status.positions.some((p) => p.marketIndex === solPerp.marketIndex)) throw new Error('平仓后仍有持仓残留')

  // 7) withdraw 5 USDC(留余量)
  console.log('\n[7] 提取 5 USDC 回热钱包 …')
  const wdSig = await drift.driftWithdraw(CHAIN_KEY, 5n * ONE_USDC)
  console.log(`   withdraw tx: ${wdSig}`)

  const finalBal = await drift.driftQuoteTokenBalance(CHAIN_KEY)
  const finalStatus = await drift.driftStatus(CHAIN_KEY)
  console.log('\n===== 最终链上状态 =====')
  console.log(`热钱包 USDC 余额: ${fmtUsdc(finalBal)}`)
  console.log(`Drift 账户: 保证金 ${finalStatus.collateral} USDC,可用 ${finalStatus.freeCollateral} USDC,持仓 ${finalStatus.positions.length} 个`)

  const handle = await drift.driftHandle(CHAIN_KEY)
  await handle.client.unsubscribe()
  console.log('\n全部步骤成功 ✅')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('\nE2E 失败:', e instanceof Error ? e.message : e)
  try {
    const drift = await import('../src/chain/drift')
    const handle = await drift.driftHandle(CHAIN_KEY)
    await handle.client.unsubscribe()
  } catch {
    // 忽略清理错误
  }
  process.exit(1)
})
