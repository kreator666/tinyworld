// ============================================================
// Drift 永续主网端到端实测(真实链上、真钱小金额):
//   预备(只读,默认只跑这段,不产生任何费用):
//     0) 主网 DriftClient 初始化(mainnet-beta,MAINNET_RPC)
//     0.1) 读 SOL-PERP 市场:marketIndex / 预言机 / 预言机价格 / 市场状态
//     0.2) 主网热钱包 USDC 余额(未充值时 = 0,预期)
//   写阶段(资金到位后设 DRIFT_RUN_WRITES=1 再跑,会真实花主网 SOL/USDC):
//     1) ensureDriftUser(初始化 Drift 用户账户)
//     2) deposit 5 USDC(主网真钱;入金前余额校验,不足则报错退出)
//     3) 市价开多 SOL-PERP(~10-20 USD 名义额,远低于硬顶)
//     4) driftStatus(确认持仓存在)
//     5) 市价平仓
//     6) withdraw 5 USDC(留余量)
// 运行:npx tsx scripts/drift-perp-test.ts            # 只读预备
//      DRIFT_RUN_WRITES=1 npx tsx scripts/drift-perp-test.ts  # 完整流程(需先充值)
// 私钥从 ../solana/.mainnet-hot.key 注入环境变量(先读后导,绝不打印)。
// split-brain:身份链仍是 solana-devnet,资产操作全在主网(见 chain/solanaExec.ts)。
// ⚠ 链侧现状(2026-10 实测):dRiftyHA39... 主网部署已事实下线——自 2026-09-25 起
// 拒绝所有用户交易(101 InstructionFallbackNotFound),Drift 已迁移至闭源 Velocity
// 程序(vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P)。只读预备照常工作;
// 写阶段当前会在第 1 步(initialize_user)以 101 失败,属链侧问题,待 Velocity
// 接入或链侧恢复后本脚本可直接复用。
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 必须在 import src 之前注入主网热钱包私钥(config.ts 在模块加载时读取)
const keyPath = fileURLToPath(new URL('../../solana/.mainnet-hot.key', import.meta.url))
process.env.AGENT_SOLANA_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim()
process.env.TARGET_CHAIN = process.env.TARGET_CHAIN || 'solana-devnet'

const ONE_USDC = 10n ** 6n

function fmtUsdc(atomic: bigint): string {
  return (Number(atomic) / Number(ONE_USDC)).toFixed(2)
}

async function main() {
  const drift = await import('../src/chain/drift')
  const exec = await import('../src/chain/solanaExec')
  console.log(`执行链: 主网 (${exec.EXEC_CHAIN_KEY}),RPC ${exec.MAINNET_RPC}`)

  // ---- 只读预备 ----
  const handle = await drift.driftHandle()
  console.log(`Drift env: ${handle.env},程序 ${drift.DRIFT_PROGRAM_ID}`)
  console.log(`热钱包: ${handle.wallet.publicKey.toBase58()}`)

  const quote = drift.driftQuoteSpotMarket(handle.env)
  console.log(`保证金市场: spot #${quote.marketIndex} ${quote.symbol} mint ${quote.mint}`)
  console.log(`与执行层 MAINNET_USDC_MINT 一致: ${quote.mint === exec.MAINNET_USDC_MINT}`)

  const solPerp = drift.driftPerpMarkets(handle.env).find((m) => m.symbol === 'SOL-PERP')
  if (!solPerp) throw new Error('SDK 配置里找不到 SOL-PERP')
  console.log(`SOL-PERP: marketIndex ${solPerp.marketIndex}`)

  const perpAccount = handle.client.getPerpMarketAccount(solPerp.marketIndex)
  if (!perpAccount) throw new Error('链上未加载到 SOL-PERP 市场账户')
  const statusKey = Object.keys(perpAccount.status ?? {})[0] ?? 'unknown'
  console.log(`SOL-PERP 链上状态: ${statusKey},oracle ${perpAccount.amm.oracle.toBase58()}`)

  const oracle = await drift.driftOraclePriceUsd(solPerp.marketIndex)
  console.log(`预言机价格: ${oracle.toFixed(4)} USD`)

  const balance = await drift.driftQuoteTokenBalance()
  console.log(`主网热钱包 USDC 余额: ${fmtUsdc(balance)}(未充值 = 0,预期)`)

  if (!process.env.DRIFT_RUN_WRITES) {
    console.log('\n只读预备完成,未产生任何交易。资金到位后设 DRIFT_RUN_WRITES=1 跑完整流程。')
    await handle.client.unsubscribe()
    process.exit(0)
  }

  // ---- 写阶段(真钱)----
  console.log('\n[1] 确保 Drift 用户账户存在 …')
  const { initialized, signature } = await drift.ensureDriftUser()
  console.log(initialized ? `   已初始化用户账户,tx: ${signature}` : '   用户账户已存在,跳过初始化')

  console.log('\n[2] 存入 4 USDC 作为保证金 …')
  const depSig = await drift.driftDeposit(4n * ONE_USDC)
  console.log(`   deposit tx: ${depSig}`)

  console.log('\n[3] 市价开多 SOL-PERP(名义额 ~12 USD)…')
  const baseAmount = await drift.driftCalcBaseAmount(solPerp.marketIndex, 12)
  console.log(`   换算 base 数量: ${baseAmount}(原子单位)`)
  const openSig = await drift.driftOpenPosition(solPerp.marketIndex, 'long', baseAmount)
  console.log(`   open tx: ${openSig}`)

  console.log('\n[4] 查询账户状态(应看到持仓)…')
  let status = await drift.driftStatus()
  console.log(`   保证金 ${status.collateral} USDC,可用 ${status.freeCollateral} USDC,SOL-PERP 购买力 ${status.buyingPower} SOL`)
  console.log(`   持仓: ${JSON.stringify(status.positions)}`)
  const pos = status.positions.find((p) => p.marketIndex === solPerp.marketIndex)
  if (!pos || pos.side !== 'long' || Number(pos.base) <= 0) throw new Error('开仓后状态里没有多头持仓')

  console.log('\n[5] 市价平仓 …')
  const closeSig = await drift.driftClosePosition(solPerp.marketIndex)
  console.log(`   close tx: ${closeSig}`)
  status = await drift.driftStatus()
  console.log(`   平仓后持仓: ${JSON.stringify(status.positions)}`)
  if (status.positions.some((p) => p.marketIndex === solPerp.marketIndex)) throw new Error('平仓后仍有持仓残留')

  console.log('\n[6] 提取 4 USDC 回热钱包 …')
  const wdSig = await drift.driftWithdraw(4n * ONE_USDC)
  console.log(`   withdraw tx: ${wdSig}`)

  const finalBal = await drift.driftQuoteTokenBalance()
  const finalStatus = await drift.driftStatus()
  console.log('\n===== 最终链上状态 =====')
  console.log(`热钱包 USDC 余额: ${fmtUsdc(finalBal)}`)
  console.log(`Drift 账户: 保证金 ${finalStatus.collateral} USDC,可用 ${finalStatus.freeCollateral} USDC,持仓 ${finalStatus.positions.length} 个`)

  await handle.client.unsubscribe()
  console.log('\n全部步骤成功 ✅')
  process.exit(0)
}

main().catch(async (e) => {
  console.error('\nE2E 失败:', e instanceof Error ? e.message : e)
  try {
    const drift = await import('../src/chain/drift')
    const handle = await drift.driftHandle()
    await handle.client.unsubscribe()
  } catch {
    // 忽略清理错误
  }
  process.exit(1)
})
