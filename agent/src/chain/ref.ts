import { getChainContext } from './registry'
import { nearAgentAccountId, nearCall, nearNativeBalance, nearView, ensureStorageDeposit, nearStorageBalance, NEAR_TX_GAS, DEFAULT_STORAGE_DEPOSIT, type NearUnsignedTx } from './nearWrite'

// ============================================================
// Ref Finance 兑换(NEAR 家族,defi-swap-ref 技能用;testnet 合约实测存活,见
// knowledge/near-defi-integration-plan.md)。两种模式:
// - hot_wallet:refSwap 热钱包直发;user_wallet:buildRefSwapTxs 只组装交易,主人钱包逐笔签名
// 报价:get_pools 选池(两币都在的简单池,取首个匹配)+ get_return;
// 兑换:NEP-141 ft_transfer_call(msg 带 swap 指令),wNEAR 不足时先 near_deposit 包裹。
// 前置条件:交易方在 exchange 与 wrap 合约的 NEP-145 storage deposit(未注册时需先付可退押金)。
// ============================================================

/** testnet fakes 代币表(ref-sdk 内置清单) */
export const REF_TESTNET_TOKENS: Record<string, { contractId: string; symbol: string }> = {
  WNEAR: { contractId: 'wrap.testnet', symbol: 'wNEAR' },
  USDC: { contractId: 'usdc.fakes.testnet', symbol: 'USDC' },
  USDT: { contractId: 'usdt.fakes.testnet', symbol: 'USDT' },
  DAI: { contractId: 'dai.fakes.testnet', symbol: 'DAI' },
  WETH: { contractId: 'weth.fakes.testnet', symbol: 'WETH' },
}

/** mainnet 代币表(地址经 fastnear 实测存活,2026-11) */
export const REF_MAINNET_TOKENS: Record<string, { contractId: string; symbol: string }> = {
  WNEAR: { contractId: 'wrap.near', symbol: 'wNEAR' },
  USDC: { contractId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC' }, // 原生 USDC
  USDT: { contractId: 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near', symbol: 'USDT' }, // 桥接 USDT
  STNEAR: { contractId: 'meta-pool.near', symbol: 'stNEAR' }, // Meta Pool 流动质押凭证
}

/** 按链取代币表(以 ChainConfig.chainId 哨兵区分:398=testnet,其余视为 mainnet) */
export function refTokens(chainKey: string): Record<string, { contractId: string; symbol: string }> {
  return getChainContext(chainKey).cfg.chainId === 398 ? REF_TESTNET_TOKENS : REF_MAINNET_TOKENS
}

const decimalsCache = new Map<string, Promise<number>>()

export function refExchange(chainKey: string): string {
  const addr = getChainContext(chainKey).cfg.near?.refExchange
  if (!addr) throw new Error(`[${chainKey}] 未配置 Ref 兑换合约(cfg.near.refExchange)`)
  return addr
}

/** NEP-148 ft_metadata.decimals(带缓存) */
export async function refTokenDecimals(chainKey: string, tokenContract: string): Promise<number> {
  let p = decimalsCache.get(tokenContract)
  if (!p) {
    p = (async () => {
      const meta = await nearView<{ decimals: number }>(chainKey, tokenContract, 'ft_metadata', {})
      if (!meta) throw new Error(`读取代币元数据失败: ${tokenContract}`)
      return meta.decimals
    })()
    decimalsCache.set(tokenContract, p)
  }
  return p
}

export function refToken(chainKey: string, symbol: string): { contractId: string; symbol: string } {
  const t = refTokens(chainKey)[symbol.toUpperCase()]
  if (!t) throw new Error(`不支持的代币: ${symbol}(可选 ${Object.keys(refTokens(chainKey)).join('/')})`)
  return t
}

interface RefPool {
  pool_id?: number
  token_account_ids: string[]
  amounts: string[]
}

// 池列表缓存(60s;测试网 2892 个池全量扫一遍要半分钟,不能每次报价都扫)
const poolListCache = new Map<string, { at: number; pools: RefPool[] }>()
const POOL_CACHE_TTL_MS = 60_000
const MAX_POOL_PAGES = 60 // 每页 100,最多扫 6000 池(主网 9000+;wNEAR↔stNEAR 深池在 500~2000 号段,USDC 储备已改 stNEAR)

/** 拉取交易对池列表(带 60s 缓存;页级 429 退避重试,防免费档 RPM 打满导致整轮失败) */
export async function refGetPools(chainKey: string): Promise<RefPool[]> {
  const cached = poolListCache.get(chainKey)
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) return cached.pools
  const all: RefPool[] = []
  for (let page = 0; page < MAX_POOL_PAGES; page++) {
    let batch: RefPool[] = []
    for (let r = 0; r < 4; r++) {
      try {
        batch = (await nearView<RefPool[]>(chainKey, refExchange(chainKey), 'get_pools', { from_index: page * 100, limit: 100 })) ?? []
        break
      } catch (err) {
        if (r === 3) throw err
        await new Promise((s) => setTimeout(s, 1500 * (r + 1)))
      }
    }
    // 池 id = from_index + 页内序号(get_pools 不返回 id 字段)
    for (let i = 0; i < batch.length; i++) {
      if (batch[i].pool_id === undefined) batch[i].pool_id = page * 100 + i
    }
    all.push(...batch)
    if (batch.length < 100) break
  }
  poolListCache.set(chainKey, { at: Date.now(), pools: all })
  return all
}

/** 找 tokenIn→tokenOut 的池:取两币都在且 tokenIn 侧流动性最大的池 */
export async function refFindPool(chainKey: string, tokenIn: string, tokenOut: string): Promise<{ poolId: number; tokens: string[] }> {
  const pools = await refGetPools(chainKey)
  let best: { poolId: number; tokens: string[]; liquidity: bigint } | null = null
  for (let i = 0; i < pools.length; i++) {
    const ids = pools[i].token_account_ids
    const idxIn = ids.indexOf(tokenIn)
    if (idxIn === -1 || !ids.includes(tokenOut)) continue
    const liquidity = BigInt(pools[i].amounts[idxIn] ?? '0')
    if (liquidity === 0n) continue
    if (!best || liquidity > best.liquidity) {
      best = { poolId: pools[i].pool_id ?? i, tokens: ids, liquidity }
    }
  }
  if (!best) throw new Error(`Ref(${getChainContext(chainKey).cfg.name})无 ${tokenIn} ↔ ${tokenOut} 的非空流动性池(已扫 ${pools.length} 个)`)
  return { poolId: best.poolId, tokens: best.tokens }
}

/** 报价:get_return 返回最小单位的 tokenOut 数量(字符串) */
export async function refQuote(chainKey: string, tokenInSymbol: string, tokenOutSymbol: string, amountInAtomic: string): Promise<{ poolId: number; amountOut: string }> {
  const tin = refToken(chainKey, tokenInSymbol)
  const tout = refToken(chainKey, tokenOutSymbol)
  const { poolId } = await refFindPool(chainKey, tin.contractId, tout.contractId)
  const amountOut = await nearView<string>(chainKey, refExchange(chainKey), 'get_return', {
    pool_id: poolId,
    token_in: tin.contractId,
    token_out: tout.contractId,
    amount_in: amountInAtomic,
  })
  if (amountOut === null) throw new Error('Ref get_return 返回空(流动性不足或金额过大)')
  return { poolId, amountOut }
}

/** NEP-141 余额(最小单位字符串;ft_balance_of 直接返回字符串而非对象) */
export async function refFtBalance(chainKey: string, tokenContract: string, accountId: string): Promise<string> {
  const bal = await nearView<string>(chainKey, tokenContract, 'ft_balance_of', { account_id: accountId })
  return bal ?? '0'
}

/**
 * 执行兑换(hot_wallet):先幂等注册 exchange/wrap 的 storage deposit,
 * wNEAR 不足时先 near_deposit 包裹原生 NEAR,再 ft_transfer_call 完成 swap。
 * 返回交易哈希。
 */
export async function refSwap(
  chainKey: string,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountInAtomic: string,
  slippageBps = 100,
): Promise<{ txHash: string; amountOut: string }> {
  const exchange = refExchange(chainKey)
  const me = nearAgentAccountId(chainKey)
  const tin = refToken(chainKey, tokenInSymbol)
  const tout = refToken(chainKey, tokenOutSymbol)
  if (tin.contractId === tout.contractId) throw new Error('兑入兑出不能是同一代币')

  // 1) storage deposit 注册:exchange 必须;兑出代币合约的接收方也必须注册(否则 swap 成功但到账失败回滚);
  //    wrap 仅 wrap/unwrap 时需要,wNEAR 参与即注册
  await ensureStorageDeposit(chainKey, exchange)
  await ensureStorageDeposit(chainKey, tout.contractId)
  if (tin.contractId === 'wrap.testnet' || tout.contractId === 'wrap.testnet') {
    await ensureStorageDeposit(chainKey, 'wrap.testnet')
  }

  // 2) wNEAR 余额不足则先包裹原生 NEAR
  if (tin.contractId === 'wrap.testnet') {
    const bal = BigInt(await refFtBalance(chainKey, tin.contractId, me))
    if (bal < BigInt(amountInAtomic)) {
      const native = BigInt(await nearNativeBalance(chainKey))
      const need = BigInt(amountInAtomic) - bal
      if (native < need + 10n ** 23n) throw new Error(`热钱包原生 NEAR 不足(需 ${need} yocto + gas)`)
      await nearCall(chainKey, 'wrap.testnet', 'near_deposit', {}, need)
    }
  }

  // 3) 报价 + 滑点保护
  const { poolId, amountOut } = await refQuote(chainKey, tokenInSymbol, tokenOutSymbol, amountInAtomic)
  const minAmountOut = (BigInt(amountOut) * BigInt(10_000 - slippageBps)) / 10_000n
  if (minAmountOut <= 0n) throw new Error('滑点后最小产出为 0,拒绝交易')

  // 4) ft_transfer_call 一笔完成兑换
  const msg = JSON.stringify({
    force: 0,
    actions: [{ pool_id: poolId, token_in: tin.contractId, token_out: tout.contractId, min_amount_out: minAmountOut.toString() }],
  })
  const txHash = await nearCall(chainKey, tin.contractId, 'ft_transfer_call', { receiver_id: exchange, amount: amountInAtomic, msg }, 1n)
  return { txHash, amountOut }
}

/**
 * 组装 Ref 兑换交易(user_wallet 模式;只组装不发交易):
 * 与 refSwap 同款的报价/滑点/storage 预检/wNEAR 包裹判断,产出 1~3 笔 NearUnsignedTx,
 * 由主人钱包逐笔签名。返回交易与报价(技能层组 proposal/估值用)。
 */
export async function buildRefSwapTxs(
  chainKey: string,
  userAccountId: string,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountHuman: string,
  slippageBps = 100,
): Promise<{ txs: NearUnsignedTx[]; poolId: number; amountOut: string }> {
  const exchange = refExchange(chainKey)
  const tin = refToken(chainKey, tokenInSymbol)
  const tout = refToken(chainKey, tokenOutSymbol)
  if (tin.contractId === tout.contractId) throw new Error('兑入兑出不能是同一代币')
  const wrap = refToken(chainKey, 'WNEAR').contractId
  const decimalsIn = await refTokenDecimals(chainKey, tin.contractId)
  const amountAtomic = BigInt(Math.round(parseFloat(amountHuman) * 10 ** decimalsIn)).toString()
  if (BigInt(amountAtomic) <= 0n) throw new Error('amountIn 必须大于 0')

  // 1~3 笔:storage_deposit(按需) → near_deposit(按需) → ft_transfer_call
  const txs: NearUnsignedTx[] = []
  // 1) storage 预检:exchange 必须;兑出代币合约的接收方必须;wNEAR 参与时 wrap 也要
  //    (与 ensureStorageDeposit 同判据:storage_balance_of 无记录或 total=0 才需要注册;兑出代币即 wrap 时去重)
  const storageTargets = [...new Set([exchange, tout.contractId, ...(tin.contractId === wrap || tout.contractId === wrap ? [wrap] : [])])]
  for (const contract of storageTargets) {
    const bal = await nearStorageBalance(chainKey, contract, userAccountId)
    if (bal && BigInt(bal.total) > 0n) continue
    txs.push({
      kind: 'near',
      receiverId: contract,
      actions: [{ methodName: 'storage_deposit', args: {}, gas: NEAR_TX_GAS, deposit: DEFAULT_STORAGE_DEPOSIT }],
      description: `在 ${contract} 注册存储押金(0.25N,可退还)`,
    })
  }

  // 2) wNEAR 余额不足则先包裹原生 NEAR(差额)
  if (tin.contractId === wrap) {
    const bal = BigInt(await refFtBalance(chainKey, tin.contractId, userAccountId))
    if (bal < BigInt(amountAtomic)) {
      const need = BigInt(amountAtomic) - bal
      txs.push({
        kind: 'near',
        receiverId: wrap,
        actions: [{ methodName: 'near_deposit', args: {}, gas: NEAR_TX_GAS, deposit: need.toString() }],
        description: `包裹 ${(Number(need) / 1e24).toFixed(4)} NEAR 为 wNEAR(兑换支付需要)`,
      })
    }
  }

  // 3) 报价 + 滑点保护,ft_transfer_call 一笔完成兑换
  const { poolId, amountOut } = await refQuote(chainKey, tokenInSymbol, tokenOutSymbol, amountAtomic)
  const minAmountOut = (BigInt(amountOut) * BigInt(10_000 - slippageBps)) / 10_000n
  if (minAmountOut <= 0n) throw new Error('滑点后最小产出为 0,拒绝交易')
  const msg = JSON.stringify({
    force: 0,
    actions: [{ pool_id: poolId, token_in: tin.contractId, token_out: tout.contractId, min_amount_out: minAmountOut.toString() }],
  })
  txs.push({
    kind: 'near',
    receiverId: tin.contractId,
    actions: [{ methodName: 'ft_transfer_call', args: { receiver_id: exchange, amount: amountAtomic, msg }, gas: NEAR_TX_GAS, deposit: '1' }],
    description: `经 Ref Finance 用 ${amountHuman} ${tin.symbol} 兑换 ${tout.symbol}(滑点 ≤${slippageBps / 100}%)`,
  })
  return { txs, poolId, amountOut }
}
