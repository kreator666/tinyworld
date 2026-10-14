import { knownChainKeys, getChainContext } from '../chain/registry'
import { isMeteoraPoolConfigured, meteoraPoolAddress } from '../chain/meteora'
import { listChainProtocols, upsertChainProtocol, type ChainProtocolRow } from '../db'

// ============================================================
// chain_protocols 启动 seeding(第二阶段 C:技能 gating 统一):
// 每条已知链(knownChainKeys,含 DB-only 动态链)若协议表完全无行,
// 从合并后 ChainConfig 推导初始协议行 upsert(enabled=true, updated_by='seed');
// 已有行则一律不动(尊重人工删除/停用)。
// 协议 key 约定(与技能 manifest.protocol、admin 接口一致):
//   dex          = cfg.defi 存在(EVM V2 风格 swap)
//   lending      = cfg.aave 存在(Aave)
//   starter-claim= cfg.partsClaim 存在(新手装备领养)
//   jupiter      = cfg.solana.jupiterApiUrl 存在(Solana 兑换)
//   meteora      = Solana 链且 Meteora 池地址可解析(env METEORA_POOL_ADDRESS,全局配置)
//   drift        = Solana 链(无配置门槛,与 defi-perp-drift manifest 老逻辑一致)
// (orca/raydium 无链配置来源且 manifest 清单层 disabled,不 seed;
//  日后重启用时由 admin 手工插 enabled 行)
// ============================================================

type SeedRow = Omit<ChainProtocolRow, 'updated_at'>

/** 从合并后链配置推导该链的初始协议行;无则返回空数组 */
export function deriveProtocolRows(chainKey: string): SeedRow[] {
  const ctx = getChainContext(chainKey)
  const cfg = ctx.cfg
  const rows: SeedRow[] = []
  const push = (protocolKey: string, kind: string, config: Record<string, unknown>) =>
    rows.push({ chain_key: chainKey, protocol_key: protocolKey, kind, config, enabled: true, updated_by: 'seed' })

  if (cfg.defi) push('dex', 'dex', cfg.defi as unknown as Record<string, unknown>)
  if (cfg.aave) push('lending', 'lending', cfg.aave as unknown as Record<string, unknown>)
  if (cfg.partsClaim) push('starter-claim', 'claim', { address: cfg.partsClaim })
  if (cfg.solana?.jupiterApiUrl) push('jupiter', 'swap-solana', { apiUrl: cfg.solana.jupiterApiUrl })
  if (ctx.family === 'solana') {
    if (isMeteoraPoolConfigured()) push('meteora', 'swap-solana', { poolAddress: meteoraPoolAddress().toBase58() })
    push('drift', 'perp', {})
  }
  return rows
}

/** 幂等 seeding:只对协议表完全无行的链推导写入;返回本次写入的 "chain/protocol" 列表 */
export async function seedChainProtocols(): Promise<string[]> {
  const seeded: string[] = []
  for (const chainKey of knownChainKeys()) {
    if ((await listChainProtocols(chainKey)).length > 0) continue
    for (const row of deriveProtocolRows(chainKey)) {
      await upsertChainProtocol(row)
      seeded.push(`${row.chain_key}/${row.protocol_key}`)
    }
  }
  return seeded
}
