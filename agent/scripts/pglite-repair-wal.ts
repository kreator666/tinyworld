// ============================================================
// PGlite WAL 紧急修复(等价 pg_resetwal 的最小实现,wasm 版无 resetwal 可用)
// 适用场景:干净关闭的库(state=DB_SHUTDOWN)WAL 检查点记录损坏,PANIC:
//   "could not locate a valid checkpoint record"
// 原理:
//   1) 从 global/pg_control 读 checkPoint(记录位置 LSN)与 checkPointCopy(记录内容副本)
//   2) 在该 LSN 处重写一条合法的 XLOG_CHECKPOINT_SHUTDOWN 记录(CRC32C 重算)
//      redo 指向记录末尾(= 截断点),表示"无需重放"
//   3) 截断所在 WAL 段,删除其后的段 → 重放为空,数据页状态 = 上次干净检查点
// 用法:
//   tsx pglite-repair-wal.ts offsets <dir>        # 解析控制文件布局(调试用)
//   tsx pglite-repair-wal.ts verify   <dir>       # 校验控制文件与 WAL 交叉一致
//   tsx pglite-repair-wal.ts corrupt  <dir>       # 测试床:故意打坏检查点记录
//   tsx pglite-repair-wal.ts repair   <dir>       # 执行修复
// ============================================================
import fs from 'node:fs'
import path from 'node:path'

// ---------- CRC32C (Castagnoli,PG 的 COMP_CRC32C 语义:init/xor 0xFFFFFFFF) ----------
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32c(parts: Buffer[]): number {
  let crc = 0xffffffff
  for (const buf of parts) {
    for (let i = 0; i < buf.length; i++) crc = CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------- 结构常量(PG18,pg_control_version=1800,已由测试床字节级验证) ----------
// pg_control.h: XLOG_CHECKPOINT_SHUTDOWN = 0x00(不是 0x40!)
const XLOG_CHECKPOINT_SHUTDOWN = 0x00
const RM_XLOG_ID = 0
const SIZEOF_XLOG_RECORD = 24
const SIZEOF_CHECKPOINT = 88 // CheckPoint 结构(PG18:time@64, oldestActiveXid@80)
const XLOG_BLCKSZ = 8192
const WAL_SEG_SIZE = 16 * 1024 * 1024 // 与磁盘上 16MB 段文件一致

// ControlFileData 字段偏移(PG18;time 因 8 字节对齐落在 24 而非 20)
const CTL = { state: 16, checkPoint: 32, checkPointCopy: 40 } as const

interface PgControl {
  state: number
  time: bigint
  checkPoint: bigint // 检查点记录所在 LSN
  checkpointCopy: Buffer // 80 字节
  walSegmentSize: number
  xlogBlockSize: number
  magic: number // 备用
}

// 解析 global/pg_control(PG18 布局,偏移见 CTL)
function parseControl(dir: string): PgControl {
  const buf = fs.readFileSync(path.join(dir, 'global/pg_control'))
  if (buf.length < 8192) throw new Error('pg_control 长度异常: ' + buf.length)
  const state = buf.readUInt32LE(CTL.state)
  const checkPoint = buf.readBigUInt64LE(CTL.checkPoint)
  const checkpointCopy = Buffer.from(buf.subarray(CTL.checkPointCopy, CTL.checkPointCopy + SIZEOF_CHECKPOINT))
  // 交叉验证 checkPointCopy:redo 应指向 checkPoint 之前不远处、tli==1、time 是合理 unix 秒
  const redo = checkpointCopy.readBigUInt64LE(0)
  const tli = checkpointCopy.readUInt32LE(8)
  if (tli !== 1) throw new Error(`checkPointCopy.tli=${tli} 异常(应为 1),布局不匹配`)
  if (redo > checkPoint) throw new Error(`checkPointCopy.redo(0x${redo.toString(16)}) > checkPoint(0x${checkPoint.toString(16)}),布局不匹配`)
  // 段大小:pglite 预分配 16MB(两个数据目录的段文件均已确认);不做猜测性推导
  const segDir = path.join(dir, 'pg_wal')
  const { file } = walFileFor(checkPoint, WAL_SEG_SIZE)
  if (!fs.existsSync(path.join(segDir, file))) throw new Error(`WAL 段 ${file} 不存在`)
  return {
    state,
    time: buf.readBigInt64LE(24),
    checkPoint,
    checkpointCopy,
    walSegmentSize: WAL_SEG_SIZE,
    xlogBlockSize: XLOG_BLCKSZ,
    magic: buf.readUInt16LE(0),
  }
}

function walFileFor(lsn: bigint, segSize: number): { file: string; off: number } {
  const segNo = Number(lsn / BigInt(segSize))
  const off = Number(lsn % BigInt(segSize))
  const file = `0000000100000000${segNo.toString(16).padStart(8, '0')}`
  return { file, off }
}

// 构造一条 shutdown 检查点记录;内容整体沿用控制文件里的
// checkPointCopy 副本(事务号/OID 计数器保持真实值),只改 redo。
// 记录布局(PG ≥ 9.5):[XLogRecord 24B][DataHeaderShort 2B: id=255,len][CheckPoint 88B]
// CRC(xlog.c/xlogreader.c 双向确认):先 [24,tot_len) 记录体(含 data header),
// 再 [0,20) 记录头(含 xl_tot_len,不含 xl_crc)
function buildCheckpointRecord(lsn: bigint, cpTemplate: Buffer): Buffer {
  const cp = Buffer.from(cpTemplate)
  const dataHdr = Buffer.from([255, SIZEOF_CHECKPOINT]) // XLR_BLOCK_ID_DATA_SHORT + length
  const totLen = SIZEOF_XLOG_RECORD + dataHdr.length + SIZEOF_CHECKPOINT // 114
  // 真实 shutdown 检查点的 redo == 记录自身位置(重放从检查点开始,遇 shutdown 记录即收尾)
  cp.writeBigUInt64LE(lsn, 0)
  const hdr = Buffer.alloc(SIZEOF_XLOG_RECORD)
  hdr.writeUInt32LE(totLen, 0) // xl_tot_len
  hdr.writeUInt32LE(0, 4) // xl_xid = InvalidTransactionId
  hdr.writeBigUInt64LE(0n, 8) // xl_prev = 0(读检查点记录时不校验 prev)
  hdr.writeUInt8(XLOG_CHECKPOINT_SHUTDOWN, 16) // xl_info
  hdr.writeUInt8(RM_XLOG_ID, 17) // xl_rmid
  const crc = crc32c([Buffer.concat([dataHdr, cp]), hdr.subarray(0, 20)])
  hdr.writeUInt32LE(crc, 20)
  return Buffer.concat([hdr, dataHdr, cp])
}

// 测试床:打坏指定 LSN 处的 WAL 字节(模拟真实故障)
function corrupt(dir: string, lsn: bigint, segSize: number): void {
  const { file, off } = walFileFor(lsn, segSize)
  const p = path.join(dir, 'pg_wal', file)
  const fd = fs.openSync(p, 'r+')
  const garbage = Buffer.alloc(256).fill(0x53)
  fs.writeSync(fd, garbage, 0, garbage.length, off)
  fs.closeSync(fd)
  console.log(`[corrupt] ${file} @0x${off.toString(16)} 已写入 256 字节垃圾`)
}

// 修复:重写检查点记录 + 截断 WAL
function repair(dir: string): void {
  const ctl = parseControl(dir)
  console.log(`[repair] state=${ctl.state} checkPoint=0x${ctl.checkPoint.toString(16)} walSeg=${ctl.walSegmentSize}`)
  // PG18 DBState: 1=DB_SHUTDOWNED 2=DB_SHUTDOWNED_IN_RECOVERY(其余状态警告继续)
  if (ctl.state > 2) console.warn('[repair] 警告: state 不是干净关闭(1/2),修复会丢未检查点数据')
  const { file, off } = walFileFor(ctl.checkPoint, ctl.walSegmentSize)
  const walPath = path.join(dir, 'pg_wal', file)
  const record = buildCheckpointRecord(ctl.checkPoint, ctl.checkpointCopy)
  const fd = fs.openSync(walPath, 'r+')
  fs.writeSync(fd, record, 0, record.length, off)
  // WAL 段是预分配 16MB 的:记录之后补零(等价干净关闭后的状态)。
  // 干净关闭的检查点不会被重放(wasShutdown),零填充段即可正常打开
  fs.ftruncateSync(fd, off + record.length)
  const zeros = Buffer.alloc(1024 * 1024)
  let pos = off + record.length
  while (pos < ctl.walSegmentSize) {
    const n = Math.min(zeros.length, ctl.walSegmentSize - pos)
    fs.writeSync(fd, zeros, 0, n, pos)
    pos += n
  }
  fs.closeSync(fd)
  console.log(`[repair] ${file} @0x${off.toString(16)} 写入 ${record.length} 字节检查点记录,其余补零至 ${ctl.walSegmentSize}`)
  // 删除其后的 WAL 段(避免重放读到垃圾)
  const segNo = Number(ctl.checkPoint / BigInt(ctl.walSegmentSize))
  for (const f of fs.readdirSync(path.join(dir, 'pg_wal'))) {
    if (!/^[0-9A-F]{24}$/.test(f)) continue
    const n = parseInt(f.slice(16), 16)
    if (n > segNo) {
      fs.renameSync(path.join(dir, 'pg_wal', f), path.join(dir, 'pg_wal', f + '.removed'))
      console.log(`[repair] 段 ${f} 已移出(改名 .removed)`)
    }
  }
}

// 校验:控制文件解析 + 打开试读
async function verify(dir: string): Promise<void> {
  const ctl = parseControl(dir)
  console.log('[verify] control:', JSON.stringify({ state: ctl.state, checkPoint: '0x' + ctl.checkPoint.toString(16), walSeg: ctl.walSegmentSize }))
  const { PGlite } = await import('@electric-sql/pglite')
  const { vector } = await import('@electric-sql/pglite-pgvector')
  const db = new PGlite(dir, { extensions: { vector } })
  await db.waitReady
  const r = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_skills").catch(() => null)
  console.log('[verify] 打开成功, agent_skills 行数:', r?.rows?.[0]?.n ?? '(表查询失败)')
  const t = await db
    .query<{ rel: string; n: string }>(
      `SELECT relname AS rel, n_live_tup::text AS n FROM pg_stat_user_tables ORDER BY relname`,
    )
    .catch(() => null)
  if (t) for (const row of t.rows) console.log('  ', row.rel, '=', row.n)
  await db.close()
}

const [, , mode, dir] = process.argv
if (!mode || !dir) {
  console.error('用法: tsx pglite-repair-wal.ts <offsets|verify|corrupt|repair> <dataDir>')
  process.exit(1)
}
try {
  if (mode === 'repair') {
    repair(dir)
    console.log('[repair] 完成,开始打开验证...')
    await verify(dir)
  } else if (mode === 'corrupt') {
    const ctl = parseControl(dir)
    corrupt(dir, ctl.checkPoint, ctl.walSegmentSize)
  } else if (mode === 'verify') {
    await verify(dir)
  } else if (mode === 'offsets') {
    const ctl = parseControl(dir)
    console.log(JSON.stringify(ctl, (k, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v), 2))
  }
  process.exit(0)
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
}
