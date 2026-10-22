import { randomUUID } from 'node:crypto'
import { type Address, type Hex } from 'viem'
import { config } from '../config'
import { getDb } from '../db'
import { getWalletClient } from '../chain/clients'
import { waitForTxReceipt } from '../chain/defi'
import {
  listArenaAccounts,
  listArenaSeasons,
  updateArenaAccountPhase,
  updateArenaSeason,
  type ArenaAccountRow,
  type ArenaSeasonRow,
} from '../db/arena'
import { computeNav } from './arenaNav'
import { deriveSeasonStatus } from './arena'

// ============================================================
// 竞技场结算(P6,设计文档 §5):
// - 到期(或赛季进入 settling)后,平台对每个未结算账户:先 haltTrading 熔断,
//   计算最终 NAV → 链上 recordResult(赛季合约 owner 权限,驱动 ArenaAccount.settle
//   解锁 owner 提取)→ 落库 nav/settled_tx → 全部结完赛季置 settled
// - 退赛结算走同一函数:owner freeze 后 recordResult 的 frozen 分支随时可结
// ============================================================

const seasonAbi = [
  {
    type: 'function',
    name: 'haltTrading',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'recordResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'navUsd', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

async function recordTask(chainKey: string, tokenId: number, payload: Record<string, unknown>, result: Record<string, unknown>, status: 'done' | 'failed' = 'done') {
  const db = await getDb()
  await db.query('INSERT INTO tasks (id, chain_key, token_id, type, status, payload, result) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    randomUUID(),
    chainKey,
    tokenId,
    'arena',
    status,
    JSON.stringify(payload),
    JSON.stringify(result),
  ])
}

/** NAV(number USD)→ 6 decimals bigint(与合约 settledNavUsd 精度一致,截断非取整避免虚高) */
export function navToUnits(navUsd: number): bigint {
  return BigInt(Math.floor(navUsd * 1e6))
}

/** 单账户结算:链上 recordResult + 落库(退赛与到期结算共用) */
export async function settleAccount(season: ArenaSeasonRow, account: ArenaAccountRow): Promise<{ navUsd: number; txHash: Hex }> {
  if (!config.arenaAdminPrivateKey) throw new Error('未配置赛季管理员密钥(ARENA_ADMIN_PRIVATE_KEY)')
  if (!season.season_address) throw new Error('赛季合约地址未回填')
  const chainKey = season.chain_key
  const tokenId = Number(account.token_id)
  const nav = await computeNav(chainKey, account.account_address as Address)
  const navUnits = navToUnits(nav.navUsd)
  const client = getWalletClient(chainKey, config.arenaAdminPrivateKey as Hex)
  const tx = await client.writeContract({
    address: season.season_address as Address,
    abi: seasonAbi,
    functionName: 'recordResult',
    args: [account.account_address as Address, navUnits],
  })
  const receipt = await waitForTxReceipt(chainKey, tx)
  if (receipt.status !== 'success') throw new Error(`recordResult 交易 revert: ${tx}`)
  await updateArenaAccountPhase(season.id, tokenId, 'settled', { nav_usd: (Number(navUnits) / 1e6).toString(), settled_tx: tx })
  await recordTask(chainKey, tokenId, { action: 'settle', season: season.id }, { navUsd: nav.navUsd.toFixed(6), txHash: tx })
  console.log(`[arena:${chainKey}] 账户结算完成(token=${tokenId}): NAV $${nav.navUsd.toFixed(2)} tx=${tx.slice(0, 12)}…`)
  return { navUsd: nav.navUsd, txHash: tx }
}

/** 到期赛季结算入口(调度器每轮调用):熔断 → 逐个结算 → 赛季归档 */
export async function settleDueSeasons(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const seasons = await listArenaSeasons()
  for (const season of seasons) {
    if (deriveSeasonStatus(season, nowSec) !== 'settling') continue
    const accounts = await listArenaAccounts(season.id)
    const unsettled = accounts.filter((a) => a.phase === 'active' || a.phase === 'frozen')
    if (unsettled.length === 0) {
      if (season.status !== 'settled') await updateArenaSeason(season.id, { status: 'settled' })
      continue
    }
    // 熔断:停止一切新开交易(幂等,已熔断时忽略)
    try {
      const client = getWalletClient(season.chain_key, config.arenaAdminPrivateKey as Hex)
      const tx = await client.writeContract({
        address: season.season_address as Address,
        abi: seasonAbi,
        functionName: 'haltTrading',
      })
      await waitForTxReceipt(season.chain_key, tx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('Halted')) console.warn(`[arena] haltTrading 失败(继续结算): ${msg.slice(0, 120)}`)
    }
    // 逐个结算(单账户失败不阻塞其他账户)
    for (const account of unsettled) {
      try {
        await settleAccount(season, account)
      } catch (err) {
        console.error(`[arena:${season.chain_key}] 结算失败(token=${account.token_id}):`, err instanceof Error ? err.message : err)
        await recordTask(season.chain_key, Number(account.token_id), { action: 'settle_failed', season: season.id }, { error: err instanceof Error ? err.message.slice(0, 200) : String(err) }, 'failed')
      }
    }
  }
}
