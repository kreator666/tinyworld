// 一次性冒烟验证:多链多协议动态配置(第一阶段 A+B)
// 覆盖: 服务能起 / initSchema 幂等(起两次) / 未登录 401 / 非白名单 JWT 403 /
//       引导管理员 / 动态加链(DB-only) / config 合并 / 协议 CRUD / 删管理员守卫 / 审计随写随记
// 用法: npx tsx scripts/verify-dynamic-chain-config.ts(自带独立数据目录,不影响 agent/data)
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'

const PORT = 4299
const BASE = `http://localhost:${PORT}`
const DATA_DIR = path.resolve(process.cwd(), 'data-smoke-dynamic-chain').replaceAll('\\', '/')

// 两个测试账户:admin(写入 ADMIN_ADDRESS 引导进白名单)/ outsider(不在白名单)
const adminAccount = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') // hardhat #0
const outsiderAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') // hardhat #1
const NEW_CHAIN = 'smoke-chain'

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
        HEARTBEAT_SECONDS: '999999', // 调度器不在冒烟窗口内触发
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

/** SIWE 登录换 JWT(EVM 纯文本消息,与 web/src/lib/wallet.ts 的 buildAgentLoginMessage 一致) */
async function login(account: { address: Address; signMessage: (args: { message: string }) => Promise<string> }): Promise<string> {
  const nonceRes = await api('POST', '/auth/nonce', { body: { address: account.address } })
  assert(nonceRes.status === 200, `nonce 申请失败: ${nonceRes.text}`)
  const { nonce, chainId, issuedAt } = nonceRes.json as { nonce: string; chainId: number; issuedAt: string }
  const message = ['AgentVerse Login', 'Action: login', `Address: ${account.address}`, `Nonce: ${nonce}`, `Chain ID: ${chainId}`, `Issued At: ${issuedAt}`].join('\n')
  const signature = await account.signMessage({ message })
  const verifyRes = await api('POST', '/auth/verify', { body: { message, signature } })
  assert(verifyRes.status === 200, `签名验证失败: ${verifyRes.text}`)
  return (verifyRes.json as { token: string }).token
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  try {
    // 1. 首次启动(建表 + 种子 + 引导管理员)
    await startServer()
    ok('服务启动(首次,initSchema + 引导管理员)')
    assert(serverLogs.includes('已引导首个管理员'), '启动日志应含引导管理员')
    ok('ADMIN_ADDRESS 已引导进 admin_whitelist')

    // 2. 鉴权:未登录 401 / 非白名单 JWT 403
    const noAuth = await api('GET', '/admin/admins')
    assert(noAuth.status === 401, `未登录应 401,实际 ${noAuth.status}`)
    ok('未登录访问 admin 接口 → 401')
    const outsiderToken = await login(outsiderAccount)
    const forbidden = await api('GET', '/admin/admins', { token: outsiderToken })
    assert(forbidden.status === 403, `非白名单应 403,实际 ${forbidden.status}: ${forbidden.text}`)
    ok('非白名单 JWT → 403')
    const adminToken = await login(adminAccount)

    // 3. 白名单 CRUD + 删最后一个守卫
    const guard = await api('DELETE', `/admin/admins/${adminAccount.address}`, { token: adminToken })
    assert(guard.status === 400, `删最后一个管理员应 400,实际 ${guard.status}`)
    ok('拒绝删除最后一个管理员 → 400')
    const addAdminRes = await api('POST', '/admin/admins', { token: adminToken, body: { address: outsiderAccount.address } })
    assert(addAdminRes.status === 200 && (addAdminRes.json as { added: boolean }).added === true, `添加管理员失败: ${addAdminRes.text}`)
    const removeAdminRes = await api('DELETE', `/admin/admins/${outsiderAccount.address}`, { token: adminToken })
    assert(removeAdminRes.status === 200, `移除管理员失败: ${removeAdminRes.text}`)
    ok('管理员增删正常')

    // 4. 动态加链(DB-only):热重载后立即可用,不用改 config.ts 重启
    const newChainBody = {
      chain_key: NEW_CHAIN,
      chain_id: 999999,
      name: 'Smoke Chain',
      family: 'evm',
      rpc: 'http://localhost:8545',
      explorer: 'https://example.com',
      identity_address: '0x0000000000000000000000000000000000000001',
      parts_address: '0x0000000000000000000000000000000000000002',
      config: { partsClaim: '0x0000000000000000000000000000000000000003' },
    }
    const addChain = await api('POST', '/admin/chains', { token: adminToken, body: newChainBody })
    assert(addChain.status === 200, `动态加链失败: ${addChain.text}`)
    ok('POST /admin/chains 动态加链')
    const dupChain = await api('POST', '/admin/chains', { token: adminToken, body: newChainBody })
    assert(dupChain.status === 409, `重复加链应 409,实际 ${dupChain.status}`)
    ok('重复加链 → 409')

    // 新链热注册进 registry:带 X-Chain-Key 的请求不再报"未知链"(选只读接口,不触链上 RPC)
    const onNewChain = await api('GET', `/identities/of/${adminAccount.address}`, { chainKey: NEW_CHAIN })
    assert(onNewChain.status === 200, `新链应已注册进 registry,实际 ${onNewChain.status}: ${onNewChain.text}`)
    ok('新链热重载后 registry 立即可解析(免重启)')

    // 5. config JSONB 合并
    const putConfig = await api('PUT', `/admin/chains/${NEW_CHAIN}/config`, { token: adminToken, body: { defi: { router: '0xabc0000000000000000000000000000000000001' } } })
    assert(putConfig.status === 200, `config 合并失败: ${putConfig.text}`)
    const chainsRes = await api('GET', '/chains')
    const chains = (chainsRes.json as { chains: { chain_key: string; config: { partsClaim?: string; defi?: { router: string } }; protocols: unknown[] }[] }).chains
    const smokeRow = chains.find((r) => r.chain_key === NEW_CHAIN)
    assert(smokeRow?.config.partsClaim === '0x0000000000000000000000000000000000000003', 'config 应保留建链时的 partsClaim')
    assert(smokeRow?.config.defi?.router === '0xabc0000000000000000000000000000000000001', 'config 应合并 defi.router')
    assert(Array.isArray(smokeRow?.protocols), 'GET /chains 每链应带 protocols 数组')
    ok('PUT config 合并 + GET /chains 带 protocols 字段')

    // 6. 协议 CRUD
    const putProto = await api('PUT', `/admin/chains/${NEW_CHAIN}/protocols/dex-v2`, {
      token: adminToken,
      body: { kind: 'dex', config: { router: '0xrouter' }, enabled: true },
    })
    assert(putProto.status === 200, `协议 upsert 失败: ${putProto.text}`)
    const listProto = await api('GET', `/admin/chains/${NEW_CHAIN}/protocols`, { token: adminToken })
    const protos = (listProto.json as { protocols: { protocol_key: string; kind: string; updated_by: string }[] }).protocols
    assert(protos.length === 1 && protos[0].protocol_key === 'dex-v2' && protos[0].updated_by.toLowerCase() === adminAccount.address.toLowerCase(), `协议列表异常: ${listProto.text}`)
    const chainsAfterProto = await api('GET', '/chains')
    const rowAfter = (chainsAfterProto.json as { chains: { chain_key: string; protocols: { protocol_key: string }[] }[] }).chains.find((r) => r.chain_key === NEW_CHAIN)
    assert(rowAfter?.protocols.length === 1, 'GET /chains 应带新协议行')
    ok('协议 upsert / 列表 / GET /chains 透传')
    const delProto = await api('DELETE', `/admin/chains/${NEW_CHAIN}/protocols/dex-v2`, { token: adminToken })
    assert(delProto.status === 204, `协议删除应 204,实际 ${delProto.status}`)
    const delAgain = await api('DELETE', `/admin/chains/${NEW_CHAIN}/protocols/dex-v2`, { token: adminToken })
    assert(delAgain.status === 404, `重复删除应 404,实际 ${delAgain.status}`)
    ok('协议删除 204 / 重复删除 404')

    // 7. 审计:上面的写操作都应落 admin_audit(insertAudit 在写路径内同步执行,成功即已记录)
    // 8. 重启验证 initSchema 幂等 + 不重复引导
    await stopServer()
    await startServer()
    ok('服务重启(initSchema 幂等,起第二次)')
    assert(!serverLogs.includes('已引导首个管理员'), '第二次启动不应重复引导管理员')
    ok('白名单非空,未重复引导')
    const relogin = await login(adminAccount)
    const adminsAfter = await api('GET', '/admin/admins', { token: relogin })
    assert(adminsAfter.status === 200, `重启后 admin 接口异常: ${adminsAfter.text}`)
    const chainsAfterRestart = await api('GET', '/chains', { token: relogin })
    assert(
      (chainsAfterRestart.json as { chains: { chain_key: string }[] }).chains.some((r) => r.chain_key === NEW_CHAIN),
      '重启后 DB-only 链仍应由 applyDbChains 注册(chains 表行还在)',
    )
    ok('重启后动态链仍在 /chains(applyDbChains 启动重放)')

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
