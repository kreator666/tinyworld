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

export const seasonAbi = [
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

// ------------------------------------------------------------------
// 钱包签名结算(管理端):组装 haltTrading(未熔断时) + 逐账户 recordResult 的
// unsigned txs,由赛季合约 owner 钱包签名广播;确认端解析 ResultRecorded 事件落库。
// 自动结算(settleDueSeasons)走服务端密钥,仅在服务端密钥=合约 owner 时可用(如主网);
// 测试网赛季由 MetaMask 部署时,必须用这里的人工签名流程。
// ------------------------------------------------------------------

import { encodeFunctionData } from 'viem'
import { getPublicClient } from '../chain/clients'
import { getChainContext } from '../chain/registry'
import type { UnsignedTx } from '../chain/defi'
import { getArenaAccountByAddress } from '../db/arena'

/** 组装结算交易:未熔断先 haltTrading,再对每个未结算账户 recordResult(当前链上净值) */
export async function buildSettleTxs(season: ArenaSeasonRow): Promise<{ txs: UnsignedTx[]; targets: { tokenId: number; account: string; navUsd: number }[] }> {
  if (!season.season_address) throw new Error('赛季合约尚未部署')
  const chainKey = season.chain_key
  const { cfg } = getChainContext(chainKey)
  const client = getPublicClient(chainKey)
  const halted = (await client.readContract({
    address: season.season_address as Address,
    abi: seasonAbi,
    functionName: 'tradingHalted',
  })) as boolean
  const accounts = (await listArenaAccounts(season.id)).filter((a) => a.phase === 'active' || a.phase === 'frozen')
  if (accounts.length === 0) throw new Error('没有待结算账户')

  const txs: UnsignedTx[] = []
  if (!halted) {
    txs.push({
      to: season.season_address as Address,
      data: encodeFunctionData({ abi: seasonAbi, functionName: 'haltTrading' }),
      value: '0',
      chainId: cfg.chainId,
      description: '熔断:停止本赛季一切新开交易',
    })
  }
  const targets: { tokenId: number; account: string; navUsd: number }[] = []
  for (const a of accounts) {
    const nav = await computeNav(chainKey, a.account_address as Address)
    targets.push({ tokenId: Number(a.token_id), account: a.account_address, navUsd: nav.navUsd })
    txs.push({
      to: season.season_address as Address,
      data: encodeFunctionData({
        abi: seasonAbi,
        functionName: 'recordResult',
        args: [a.account_address as Address, navToUnits(nav.navUsd)],
      }),
      value: '0',
      chainId: cfg.chainId,
      description: `结算 Agent #${a.token_id}:NAV $${nav.navUsd.toFixed(2)}`,
    })
  }
  return { txs, targets }
}

const resultRecordedAbi = [
  {
    type: 'event',
    name: 'ResultRecorded',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'navUsd', type: 'uint256' },
    ],
  },
] as const

/** 确认:解析每笔 recordResult 回执的 ResultRecorded 事件,按账户地址落库结算值 */
export async function confirmSettleTxs(seasonId: string, txHashes: string[]): Promise<{ settled: number }> {
  const { getArenaSeason } = await import('../db/arena')
  const season = await getArenaSeason(seasonId)
  if (!season) throw new Error('赛季不存在')
  const client = getPublicClient(season.chain_key)
  const { decodeEventLog } = await import('viem')
  let settled = 0
  for (const h of txHashes) {
    const receipt = await client.getTransactionReceipt({ hash: h as Hex })
    if (!receipt || receipt.status !== 'success') throw new Error(`结算交易未成功: ${h}`)
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== season.season_address.toLowerCase()) continue
      try {
        const evt = decodeEventLog({ abi: resultRecordedAbi, eventName: 'ResultRecorded', topics: log.topics as [Hex, ...Hex[]], data: log.data })
        const row = await getArenaAccountByAddress(evt.args.account)
        if (!row || row.season_id !== seasonId) continue
        await updateArenaAccountPhase(seasonId, Number(row.token_id), 'settled', {
          nav_usd: (Number(evt.args.navUsd) / 1e6).toString(),
          settled_tx: h,
        })
        settled += 1
      } catch {
        // 非 ResultRecorded 日志(如 haltTrading 事件),跳过
      }
    }
  }
  // 全部结清 → 赛季归档
  const remaining = (await listArenaAccounts(seasonId)).filter((a) => a.phase === 'active' || a.phase === 'frozen')
  if (remaining.length === 0) await updateArenaSeason(seasonId, { status: 'settled' })
  return { settled }
}
