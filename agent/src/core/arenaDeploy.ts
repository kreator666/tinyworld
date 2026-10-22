import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters, encodeFunctionData, getContractAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from '../config'
import { getPublicClient } from '../chain/clients'
import { waitForTxReceipt } from '../chain/defi'
import { getChainContext } from '../chain/registry'
import type { ArenaSeasonRow } from '../db/arena'

// ============================================================
// 竞技场合约部署(P5 管理端一键部署):
// 从编译产物读 bytecode,按"账户实现 → 赛季实现 → 赛季代理(含 initialize)"顺序
// 组三笔部署交易。用 getContractAddress 预测地址,使代理的 initialize 能写入
// 账户实现地址,一轮签名全部完成;确认时以回执实际地址回填(预测失配会报错)。
// ============================================================

const ARTIFACTS_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../contract/artifacts/src')

interface Artifact {
  abi: unknown[]
  bytecode: Hex
}

function readArtifact(contractName: string, file: string): Artifact {
  const p = path.join(ARTIFACTS_DIR, file, `${contractName}.json`)
  if (!fs.existsSync(p)) {
    throw new Error(`合约编译产物缺失: ${p}(先 cd contract && npx hardhat compile)`)
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf-8')) as { abi: unknown[]; bytecode: string }
  if (!json.bytecode || json.bytecode.length < 10) throw new Error(`bytecode 为空: ${p}`)
  return { abi: json.abi, bytecode: json.bytecode as Hex }
}

function erc1967ProxyBytecode(): Hex {
  // 与 contract/src/testing/OzProxyImports.sol 触发的编译产物一致
  // 注意路径:hardhat 对 node_modules 导入的编译产物放在 artifacts 根下(非 src/ 镜像)
  const p = path.join(
    path.resolve(ARTIFACTS_DIR, '..'),
    '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json',
  )
  if (!fs.existsSync(p)) throw new Error(`ERC1967Proxy 编译产物缺失: ${p}`)
  const json = JSON.parse(fs.readFileSync(p, 'utf-8')) as { bytecode: string }
  return json.bytecode as Hex
}

const seasonInitAbi = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner_', type: 'address' },
      { name: 'usdc_', type: 'address' },
      { name: 'accountImplementation_', type: 'address' },
      { name: 'executor_', type: 'address' },
      { name: 'feeRecipient_', type: 'address' },
      { name: 'principalUsd_', type: 'uint256' },
      { name: 'fuelUsd_', type: 'uint256' },
      { name: 'startTime_', type: 'uint64' },
      { name: 'endTime_', type: 'uint64' },
    ],
    outputs: [],
  },
] as const

export interface DeployTx extends Omit<import('../chain/defi').UnsignedTx, 'to'> {
  to?: Address // 部署交易无 to
  /** 显式 nonce:三连号,与 predicted 地址推导一致;钱包严格照办,避免 rapid 连续广播时
   *  钱包本地 nonce 状态与预测失配(nonce too low / 地址预测失配) */
  nonce?: number
}

export interface DeployBundle {
  txs: DeployTx[]
  predicted: { accountImpl: Address; seasonImpl: Address; seasonProxy: Address }
  executor: Address // 赛季执行地址(平台热钱包),展示给管理员确认
}

/** 组装三笔部署交易(管理员钱包签名,顺序发送,nonce 连续) */
export async function buildDeployTxs(season: ArenaSeasonRow, admin: Address): Promise<DeployBundle> {
  const chainKey = season.chain_key
  const { cfg } = getChainContext(chainKey)
  const client = getPublicClient(chainKey)
  const nonce = BigInt(await client.getTransactionCount({ address: admin, blockTag: 'pending' }))

  const accountImpl = getContractAddress({ from: admin, nonce })
  const seasonImpl = getContractAddress({ from: admin, nonce: nonce + 1n })
  const seasonProxy = getContractAddress({ from: admin, nonce: nonce + 2n })

  const accountArtifact = readArtifact('ArenaAccount', 'ArenaAccount.sol')
  const seasonArtifact = readArtifact('ArenaSeason', 'ArenaSeason.sol')

  if (!config.agentPrivateKey) throw new Error('未配置执行密钥(AGENT_PRIVATE_KEY),无法确定赛季执行地址')
  const executor = privateKeyToAccount(config.agentPrivateKey as Hex).address
  const usd6 = (s: string) => BigInt(Math.floor(Number(s) * 1e6))

  const initData = encodeFunctionData({
    abi: seasonInitAbi,
    functionName: 'initialize',
    args: [
      admin,
      season.usdc_address as Address,
      accountImpl,
      executor,
      admin, // feeRecipient: 燃料费归管理员(平台)地址
      usd6(season.principal_usd),
      usd6(season.fuel_usd),
      BigInt(season.start_ts),
      BigInt(season.end_ts),
    ],
  })
  // ERC1967Proxy 构造函数:(address implementation, bytes memory _data)
  const proxyInit = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }],
    [seasonImpl, initData],
  )
  const proxyBytecode = erc1967ProxyBytecode()

  const n0 = Number(nonce)
  return {
    txs: [
      { data: accountArtifact.bytecode, value: '0', chainId: cfg.chainId, nonce: n0, description: '部署 ArenaAccount 实现(参赛账户克隆模板)' },
      { data: seasonArtifact.bytecode, value: '0', chainId: cfg.chainId, nonce: n0 + 1, description: '部署 ArenaSeason 实现' },
      { data: (proxyBytecode + proxyInit.slice(2)) as Hex, value: '0', chainId: cfg.chainId, nonce: n0 + 2, description: '部署 ArenaSeason 代理(初始化赛季参数)' },
    ],
    predicted: { accountImpl, seasonImpl, seasonProxy },
    executor,
  }
}

/** 解析三笔部署回执,返回实际合约地址(顺序:账户实现/赛季实现/赛季代理) */
export async function resolveDeployReceipts(chainKey: string, txHashes: string[]): Promise<{ accountImpl: Address; seasonImpl: Address; seasonProxy: Address }> {
  if (txHashes.length !== 3) throw new Error('需要三笔部署交易的哈希')
  const out = [] as Address[]
  for (const h of txHashes) {
    const receipt = await waitForTxReceipt(chainKey, h as Hex)
    if (receipt.status !== 'success') throw new Error(`部署交易未成功: ${h}`)
    if (!receipt.contractAddress) throw new Error(`回执中无合约地址(不是部署交易?): ${h}`)
    out.push(receipt.contractAddress)
  }
  return { accountImpl: out[0], seasonImpl: out[1], seasonProxy: out[2] }
}

const setAllowedCallsAbi = [
  {
    type: 'function',
    name: 'setAllowedCalls',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'targets', type: 'address[]' },
      { name: 'selectors', type: 'bytes4[]' },
      { name: 'allowed', type: 'bool[]' },
    ],
    outputs: [],
  },
] as const

export interface WhitelistEntry {
  target: string
  selector: string // 0x 四字节
  allowed: boolean
  note: string
}

/** 按链配置生成建议白名单(Aave/GMX/DEX 常用方法),管理员 review 后确认 */
export function whitelistTemplate(chainKey: string): WhitelistEntry[] {
  const cfg = getChainContext(chainKey).cfg
  const entries: WhitelistEntry[] = []
  const usdc = cfg.defi?.usdc
  if (usdc && usdc !== '0x0000000000000000000000000000000000000000') {
    if (cfg.aave) entries.push({ target: usdc, selector: '0x095ea7b3', allowed: true, note: `USDC.approve → Aave Pool` })
    if (cfg.gmx) entries.push({ target: usdc, selector: '0x095ea7b3', allowed: true, note: `USDC.approve → GMX Router` })
    if (cfg.defi) entries.push({ target: usdc, selector: '0x095ea7b3', allowed: true, note: `USDC.approve → DEX Router` })
  }
  if (cfg.aave) {
    entries.push({ target: cfg.aave.pool, selector: '0xe8eda9df', allowed: true, note: 'Aave Pool.supply(存款)' })
    entries.push({ target: cfg.aave.pool, selector: '0x69328dec', allowed: true, note: 'Aave Pool.withdraw(取款)' })
  }
  if (cfg.defi) {
    entries.push({ target: cfg.defi.router, selector: '0x38ed1739', allowed: true, note: 'DEX swapExactTokensForTokens(现货兑换)' })
  }
  if (cfg.gmx) {
    entries.push({ target: cfg.gmx.exchangeRouter, selector: '0xac9650d8', allowed: true, note: 'GMX ExchangeRouter.multicall(下单/平仓)' })
  }
  // 去重(USDC.approve 可能重复)
  const seen = new Set<string>()
  return entries.filter((e) => {
    const k = `${e.target.toLowerCase()}:${e.selector}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 组装白名单交易(管理员签名) */
export function buildWhitelistTx(season: ArenaSeasonRow, entries: { target: string; selector: string; allowed: boolean }[]): import('../chain/defi').UnsignedTx {
  const { cfg } = getChainContext(season.chain_key)
  return {
    to: season.season_address as Address,
    data: encodeFunctionData({
      abi: setAllowedCallsAbi,
      functionName: 'setAllowedCalls',
      args: [
        entries.map((e) => e.target as Address),
        entries.map((e) => e.selector as Hex),
        entries.map((e) => e.allowed),
      ],
    }),
    value: '0',
    chainId: cfg.chainId,
    description: `配置赛季协议白名单(${entries.length} 条方法级规则)`,
  }
}
