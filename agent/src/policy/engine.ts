import { config } from '../config'
import { getDb } from '../db'
import { chainKeyByChainId, getChainContext } from '../chain/registry'
import type { UnsignedTx } from '../chain/defi'

// ============================================================
// 策略引擎(M4,设计文档 §7.2):所有链上写操作的必经关卡
// 规则与阈值:单笔限额 / 日累计限额 / 协议白名单 / 代币白名单 / 冷却 / 熔断
// 阈值走 env(POLICY_MAX_TX_USD 等,见 config.ts),默认单笔 $25、日累计 $125、冷却 10 分钟
// ============================================================

export type ExecutionMode = 'hot_wallet' | 'user_wallet'

export type ProposalAction = 'swap' | 'supply' | 'withdraw' | 'staking' | 'unstake' | 'claim_stake'

/** 交易提案(defi-swap / defi-lending 生成,审批放行后按 proposal.params 原样执行) */
export interface Proposal {
  action: ProposalAction
  protocol: string // router 地址
  chainId: number
  params: {
    tokenIn: string // 'native' 表示原生币(AVAX/ETH),否则为 ERC20 地址(用户资金路径)
    tokenOut: string // ERC20 地址,或 'native'(代币换原生币);借贷场景记 aToken 描述
    amountIn: string // 最小单位字符串(native=wei,USDC=6 位)
    amountOutMin?: string // 仅 swap 需要(滑点保护)
    owner?: string // 用户资金路径:出资人(主人)地址,代执行时 transferFrom 的 from
  }
  executionMode: ExecutionMode // 由 Agent 设置或用户显式指定
  estimatedValueUsd: number | null // null = 价格源失败(熔断信号)
  reason: string // Agent 给出的提案理由(审计用)
  // 用户钱包签名模式:Agent 组装好但尚未签名的交易(前端钱包签名后后端广播)
  unsignedTxs?: UnsignedTx[]
  // 需要用户钱包签名的前置动作(目前仅 ERC20 approve);前端拿到后弹钱包插件签名
  signatureRequest?: {
    type: 'erc20_approve'
    token: string
    tokenSymbol: string
    spender: string
    amount: string // 最小单位字符串
    decimals: number
  }
}

export interface Verdict {
  verdict: 'execute' | 'needsApproval' | 'rejected'
  reasons: string[]
}

/** 当天已执行的 defi 交易总额(USD,tasks 表 result.usdValue 累计) */
async function dailySpentUsd(chainKey: string): Promise<number> {
  const db = await getDb()
  const res = await db.query<{ total: number | null }>(
    `SELECT COALESCE(SUM((result->>'usdValue')::numeric), 0)::float AS total FROM tasks
     WHERE chain_key = $1 AND type = 'defi' AND status = 'done' AND created_at::date = CURRENT_DATE`,
    [chainKey],
  )
  return res.rows[0]?.total ?? 0
}

/** 同 action 距上次执行是否还在冷却期内 */
async function inCooldown(chainKey: string, action: string): Promise<boolean> {
  if (config.policyCooldownSeconds <= 0) return false
  const db = await getDb()
  const res = await db.query(
    `SELECT 1 FROM tasks
     WHERE chain_key = $1 AND type = 'defi' AND status = 'done' AND payload->>'action' = $2
       AND created_at > now() - make_interval(secs => $3)
     LIMIT 1`,
    [chainKey, action, config.policyCooldownSeconds],
  )
  return res.rows.length > 0
}

/**
 * 评估提案:
 * - rejected:白名单外协议/代币、chainId 不在 CHAINS 白名单或该链无 defi 合约配置(硬规则,人工也不能放行)
 * - needsApproval:估值失败(熔断)、超单笔限额、超日累计、冷却期内(软规则,人工审批可放行)
 * - execute:全部通过
 *
 * 多链重构(方案A):chainId 不再要求等于请求链,只要求落在 CHAINS 白名单且该链配置了 defi 合约;
 * 协议/代币白名单与日累计限额全部按"提案目标链"解析,与请求链解耦。
 */
export async function evaluateProposal(chainKey: string, p: Proposal): Promise<Verdict> {
  const hardFail: string[] = []
  const soft: string[] = []

  // 链硬规则:chainId 必须对应 CHAINS 白名单内的链,且该链必须配置 defi 合约(无配置直接拒绝并说明)
  const pChainKey = chainKeyByChainId(p.chainId)
  const pCfg = pChainKey ? getChainContext(pChainKey).cfg : null
  if (!pChainKey || !pCfg) {
    hardFail.push(`chainId=${p.chainId} 不在 CHAINS 白名单`)
  } else if (!pCfg.defi) {
    hardFail.push(`chainId=${p.chainId}(${pCfg.name})未配置 defi 合约,不支持执行`)
  } else {
    // 协议白名单:swap 只能走目标链 DEX router;supply/withdraw 只能走目标链 Aave Pool;
    // staking/unstake/claim_stake 只能走目标链 BENQI 质押合约
    if (p.action === 'swap') {
      if (p.protocol.toLowerCase() !== pCfg.defi.router.toLowerCase()) {
        hardFail.push(`协议不在白名单: ${p.protocol}(action=${p.action} 仅允许 ${pCfg.defi.router})`)
      }
    } else if (p.action === 'staking' || p.action === 'unstake' || p.action === 'claim_stake') {
      if (!pCfg.benqi || p.protocol.toLowerCase() !== pCfg.benqi.staking.toLowerCase()) {
        hardFail.push(`协议不在白名单: ${p.protocol}(action=${p.action} 仅允许 ${pCfg.benqi?.staking ?? '未配置 BENQI Liquid Staking'})`)
      }
    } else if (!pCfg.aave || p.protocol.toLowerCase() !== pCfg.aave.pool.toLowerCase()) {
      hardFail.push(`协议不在白名单: ${p.protocol}(action=${p.action} 仅允许 ${pCfg.aave?.pool ?? '未配置 Aave'})`)
    }

    // 代币白名单按 action 解耦:
    // - swap: 只能走 DEX 基础代币(wNative/USDC/USDT)
    // - supply/withdraw: 只能从 Aave 资产配置列表出
    // - staking/unstake/claim_stake: DEX 基础代币 + sAVAX(unstake 时)
    const swapWhitelist = [pCfg.defi.wNative, pCfg.defi.usdc, pCfg.defi.usdt]
      .filter((a) => a !== '0x0000000000000000000000000000000000000000')
      .map((a) => a.toLowerCase())
    const lendingWhitelist = (pCfg.aave?.assets ?? [])
      .map((a) => a.address.toLowerCase())
      .filter((a) => a !== '0x0000000000000000000000000000000000000000')
    const stakingWhitelist =
      p.action === 'unstake' && pCfg.benqi
        ? [...swapWhitelist, pCfg.benqi.sAvax.toLowerCase()]
        : swapWhitelist

    let whitelist: string[]
    if (p.action === 'swap') {
      whitelist = swapWhitelist
    } else if (p.action === 'supply' || p.action === 'withdraw') {
      whitelist = lendingWhitelist
    } else {
      whitelist = stakingWhitelist
    }

    if (p.params.tokenIn !== 'native' && !whitelist.includes(p.params.tokenIn.toLowerCase())) {
      hardFail.push(`tokenIn 不在白名单: ${p.params.tokenIn}`)
    }
    if (p.action === 'swap' && p.params.tokenOut !== 'native' && !whitelist.includes(p.params.tokenOut.toLowerCase())) {
      hardFail.push(`tokenOut 不在白名单: ${p.params.tokenOut}`)
    }
  }

  if (hardFail.length > 0) return { verdict: 'rejected', reasons: hardFail }

  // 熔断:估值失败一律转人工,绝不自动执行
  if (p.estimatedValueUsd === null) {
    soft.push('价格源不可用,无法估值,按熔断规则转人工审批')
  } else {
    if (p.estimatedValueUsd > config.policyMaxTxUsd) {
      soft.push(`单笔估值 $${p.estimatedValueUsd.toFixed(2)} 超过限额 $${config.policyMaxTxUsd}`)
    }
    // 日累计按提案目标链统计(执行/记 tasks 都在目标链)
    const spent = await dailySpentUsd(pChainKey!)
    if (spent + p.estimatedValueUsd > config.policyDailyLimitUsd) {
      soft.push(`日累计将达到 $${(spent + p.estimatedValueUsd).toFixed(2)},超过日限额 $${config.policyDailyLimitUsd}`)
    }
  }

  if (await inCooldown(pChainKey!, p.action)) {
    soft.push(`同 action(${p.action})在 ${config.policyCooldownSeconds}s 冷却期内`)
  }

  return soft.length > 0 ? { verdict: 'needsApproval', reasons: soft } : { verdict: 'execute', reasons: [] }
}
