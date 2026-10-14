// 一次性冒烟验证:技能 gating 统一(第二阶段 C)
// 覆盖: 启动 seeding(协议行从 ChainConfig 推导、尊重已有行)/ 协议停用 → 技能从清单消失 /
//       重新启用 → 恢复 / 重启后 seeding 幂等不重复 / 清单接口按 X-Chain-Key 分链过滤
// 用法: npx tsx scripts/verify-skill-gating.ts(自带独立数据目录,不影响 agent/data)
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

const PORT = 4298
const BASE = `http://localhost:${PORT}`
const DATA_DIR = path.resolve(process.cwd(), 'data-smoke-skill-gating').replaceAll('\\', '/')

const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') // hardhat #0

let server: ChildProcess | null = null
let serverLogs = ''

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    serverLogs = ''
    // Windows 下直接 spawn npx.cmd 会 EINVAL;改走 node + tsx cli 入口
    server = spawn(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        TARGET_CHAIN: 'sepolia',
        ADMIN_ADDRESS: adminAccount.address,
        JWT_SECRET: 'smoke-test-secret',
        HEARTBEAT_SECONDS: '999999',
        AGENT_DATA_DIR: DATA_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (buf: Buffer) => {
      serverLogs += buf.toString()
      if (buf.toString().includes('Agent 服务已启动')) resolve()
    }
    server.stdout?.on('data', onData)
    server.stderr?.on('data', (buf: Buffer) => (serverLogs += buf.toString()))
    server.on('exit', (code) => reject(new Error(`服务提前退出(code=${code}): ${serverLogs.slice(-500)}`)))
    setTimeout(() => reject(new Error(`服务启动超时: ${serverLogs.slice(-500)}`)), 60_000)
  })
}

async function stopServer(): Promise<void> {
  if (!server) return
  const proc = server
  server = null
  proc.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1500))
  if (!proc.killed) proc.kill('SIGKILL')
}

async function api(method: string, urlPath: string, opts: { token?: string; body?: unknown; chainKey?: string } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.chainKey ? { 'X-Chain-Key': opts.chainKey } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 204 等空响应 */
  }
  return { status: res.status, json, text }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}
let passed = 0
function ok(msg: string): void {
  passed++
  console.log(`✅ ${msg}`)
}

async function login(): Promise<string> {
  const nonceRes = await api('POST', '/auth/nonce', { body: { address: adminAccount.address } })
  assert(nonceRes.status === 200, `nonce 申请失败: ${nonceRes.text}`)
  const { nonce, chainId, issuedAt } = nonceRes.json as { nonce: string; chainId: number; issuedAt: string }
  const message = ['AgentVerse Login', 'Action: login', `Address: ${adminAccount.address}`, `Nonce: ${nonce}`, `Chain ID: ${chainId}`, `Issued At: ${issuedAt}`].join('\n')
  const signature = await adminAccount.signMessage({ message })
  const verifyRes = await api('POST', '/auth/verify', { body: { message, signature } })
  assert(verifyRes.status === 200, `签名验证失败: ${verifyRes.text}`)
  return (verifyRes.json as { token: string }).token
}

interface ChainRow {
  chain_key: string
  protocols: { protocol_key: string; kind: string; enabled: boolean; updated_by: string; config: Record<string, unknown> }[]
}
interface SkillEntry {
  id: string
  protocol?: string
}

async function listSkillsOn(chainKey: string): Promise<SkillEntry[]> {
  const res = await api('GET', '/skills', { chainKey })
  assert(res.status === 200, `GET /skills(${chainKey}) 失败: ${res.text}`)
  return (res.json as { skills: SkillEntry[] }).skills
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  try {
    await startServer()
    ok('服务启动(seeding 随启动完成)')
    assert(serverLogs.includes('已 seed 初始协议行'), '启动日志应含 seeding 记录')
    const adminToken = await login()

    // 1. seeding 结果:EVM 链 dex/lending;Solana 链 meteora/drift;全部 updated_by='seed'
    const chainsRes = await api('GET', '/chains')
    const chains = (chainsRes.json as { chains: ChainRow[] }).chains
    const fuji = chains.find((r) => r.chain_key === 'fuji')!
    const sepolia = chains.find((r) => r.chain_key === 'sepolia')!
    const avalanche = chains.find((r) => r.chain_key === 'avalanche')!
    const solana = chains.find((r) => r.chain_key === 'solana-devnet')!
    const fujiKeys = fuji.protocols.map((p) => p.protocol_key)
    assert(fujiKeys.includes('dex') && fujiKeys.includes('lending'), `fuji 应 seed dex/lending,实际: ${fujiKeys}`)
    assert(sepolia.protocols.some((p) => p.protocol_key === 'dex'), 'sepolia 应有 dex')
    assert(avalanche.protocols.some((p) => p.protocol_key === 'lending'), 'avalanche 应有 lending')
    assert(fuji.protocols.every((p) => p.updated_by === 'seed' && p.enabled), 'seed 行应 enabled=true, updated_by=seed')
    assert(fuji.protocols.find((p) => p.protocol_key === 'dex')!.config.router, 'dex config 应含 router')
    assert(solana.protocols.some((p) => p.protocol_key === 'meteora' && p.config.poolAddress), 'solana-devnet 应 seed meteora(poolAddress)')
    assert(solana.protocols.some((p) => p.protocol_key === 'drift'), 'solana-devnet 应 seed drift')
    assert(!solana.protocols.some((p) => p.protocol_key === 'jupiter'), '未配 JUPITER_API_URL 时不应 seed jupiter')
    ok('seeding: EVM dex/lending + Solana meteora/drift,config/updated_by 正确')

    // 2. 清单基线:fuji 可见 defi-swap/defi-lending;solana-devnet 可见 defi-swap-meteora(池可解析);disabled 技能(orica/raydium)不可见
    const fujiSkills0 = await listSkillsOn('fuji')
    assert(fujiSkills0.some((s) => s.id === 'defi-swap' && s.protocol === 'dex'), 'fuji 清单应有 defi-swap')
    assert(fujiSkills0.some((s) => s.id === 'defi-lending' && s.protocol === 'lending'), 'fuji 清单应有 defi-lending')
    const solSkills0 = await listSkillsOn('solana-devnet')
    assert(solSkills0.some((s) => s.id === 'defi-swap-meteora'), 'solana-devnet 清单应有 defi-swap-meteora')
    assert(!solSkills0.some((s) => s.id === 'defi-swap-orca') && !solSkills0.some((s) => s.id === 'defi-swap-raydium'), '清单层 disabled 技能不可见')
    ok('清单基线:fuji defi-swap/defi-lending;solana-devnet meteora;disabled 技能隐藏')

    // 3. 停用 fuji dex → defi-swap 从 fuji 清单消失(其余技能不受影响)
    const disable = await api('PUT', '/admin/chains/fuji/protocols/dex', {
      token: adminToken,
      body: { kind: 'dex', config: { router: '0xdisabled' }, enabled: false },
    })
    assert(disable.status === 200, `停用 dex 失败: ${disable.text}`)
    const fujiSkills1 = await listSkillsOn('fuji')
    assert(!fujiSkills1.some((s) => s.id === 'defi-swap'), '停用 dex 后 fuji 清单不应有 defi-swap')
    assert(fujiSkills1.some((s) => s.id === 'defi-lending'), '停用 dex 不影响 defi-lending')
    const sepoliaSkills1 = await listSkillsOn('sepolia')
    assert(sepoliaSkills1.some((s) => s.id === 'defi-swap'), '停用只影响 fuji,sepolia 的 defi-swap 仍在')
    ok('停用协议 → 对应技能从该链清单消失(其他链不受影响)')

    // 4. 重新启用 → 恢复
    const enable = await api('PUT', '/admin/chains/fuji/protocols/dex', {
      token: adminToken,
      body: { kind: 'dex', config: { router: '0xrestored' }, enabled: true },
    })
    assert(enable.status === 200, `启用 dex 失败: ${enable.text}`)
    const fujiSkills2 = await listSkillsOn('fuji')
    assert(fujiSkills2.some((s) => s.id === 'defi-swap'), '重新启用 dex 后 fuji 清单应恢复 defi-swap')
    ok('重新启用协议 → 技能恢复可见')

    // 5. 重启:seeding 幂等(已有行不动),停用状态经 reloadChainRegistry 缓存重放
    await api('PUT', '/admin/chains/fuji/protocols/dex', { token: adminToken, body: { kind: 'dex', config: {}, enabled: false } })
    await stopServer()
    await startServer()
    ok('服务重启')
    const relogin = await login()
    const chainsAfter = (await api('GET', '/chains')).json as { chains: ChainRow[] }
    const fujiAfter = chainsAfter.chains.find((r) => r.chain_key === 'fuji')!
    assert(fujiAfter.protocols.length === fuji.protocols.length, `重启后 fuji 协议行数应变(无重复 seed): ${fujiAfter.protocols.length} vs ${fuji.protocols.length}`)
    const dexRow = fujiAfter.protocols.find((p) => p.protocol_key === 'dex')!
    assert(dexRow.enabled === false && dexRow.config.router === undefined, '重启后应保留人工停用状态与改动(不回落 seed)')
    const fujiSkills3 = await listSkillsOn('fuji')
    assert(!fujiSkills3.some((s) => s.id === 'defi-swap'), '重启后缓存重放:defi-swap 仍隐藏')
    // 恢复 enabled,避免后续断言混淆
    await api('PUT', '/admin/chains/fuji/protocols/dex', { token: relogin, body: { kind: 'dex', config: { router: '0xfinal' }, enabled: true } })
    const fujiSkills4 = await listSkillsOn('fuji')
    assert(fujiSkills4.some((s) => s.id === 'defi-swap'), '重启后再启用 → 恢复')
    ok('重启幂等:无重复 seed、人工停用状态保留、缓存重放正确')

    console.log(`\n全部通过(${passed} 项)`)
  } finally {
    await stopServer()
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('冒烟失败:', err instanceof Error ? err.message : err)
  console.error('--- 服务日志尾部 ---\n' + serverLogs.slice(-1500))
  process.exit(1)
})
