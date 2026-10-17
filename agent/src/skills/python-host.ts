import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnyTool } from './registry'

// ============================================================
// Python 技能宿主(M5 轻量版):
// 每个 Python 技能作为一个子进程通过 stdio 启动,
// 使用类 MCP 的 JSON Lines 协议通信:
//   -> {type:'tools/list'}
//   <- {type:'tools','tools':[{name,description,inputSchema,outputSchema}]}
//   -> {type:'tool/call',id,name,args}
//   <- {type:'result',id,result} / {type:'error',id,error}
// 不依赖官方 MCP SDK,先用最小可行协议把 Python 技能跑起来;
// 未来可平滑替换为完整 MCP server。
// ============================================================

export interface PythonToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PythonHostOptions {
  skillDir: string
  entry?: string // 缺省 index.py
  pythonCmd?: string // 缺省 python3,Windows 可回退 python
  timeoutMs?: number // 单次调用超时,缺省 30s
  env?: Record<string, string>
}

export class PythonSkillHost {
  private proc: ChildProcess | null = null
  private ready = false
  private tools: PythonToolSchema[] = []
  private buffer = ''
  private pending = new Map<string, PendingCall>()
  private callSeq = 0
  private started = false

  constructor(private opts: PythonHostOptions) {}

  private entryPath(): string {
    return join(this.opts.skillDir, this.opts.entry ?? 'index.py')
  }

  /** 启动 Python 子进程并握手获取工具列表 */
  async start(): Promise<PythonToolSchema[]> {
    if (this.started) return this.tools
    const entry = this.entryPath()
    if (!existsSync(entry)) throw new Error(`Python 技能入口不存在: ${entry}`)

    const python = this.opts.pythonCmd ?? (process.platform === 'win32' ? 'python' : 'python3')
    this.proc = spawn(python, [entry], {
      cwd: this.opts.skillDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.opts.env ?? {}) },
    })
    this.started = true

    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf-8')))
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf-8').trim()
      if (line) console.warn(`[python-skill ${this.opts.skillDir}] ${line}`)
    })
    this.proc.on('error', (err) => this.onProcessError(err))
    this.proc.on('exit', (code) => this.onProcessExit(code))

    // 等进程就绪并获取工具列表
    const resp = await this.sendAndWait({ type: 'tools/list' }, 10_000)
    if (!resp || typeof resp !== 'object' || !Array.isArray((resp as { tools?: unknown }).tools)) {
      throw new Error('Python 技能握手失败:未返回 tools 列表')
    }
    this.tools = (resp as { tools: PythonToolSchema[] }).tools
    this.ready = true
    return this.tools
  }

  /** 调用某个工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.ready) await this.start()
    return this.sendAndWait({ type: 'tool/call', name, args }, this.opts.timeoutMs ?? 30_000)
  }

  /** 关闭子进程 */
  stop(): void {
    if (!this.proc || this.proc.killed) return
    try {
      this.proc.stdin?.end()
      this.proc.kill('SIGTERM')
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL')
      }, 2000).unref()
    } catch {
      // ignore
    }
  }

  private onData(text: string): void {
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? '' // 保留未完整行
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.handleMessage(JSON.parse(trimmed))
      } catch (e) {
        console.warn(`[python-skill] 非法 JSON: ${trimmed.slice(0, 200)}`, e)
      }
    }
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as { type?: string; id?: string; result?: unknown; error?: string; tools?: PythonToolSchema[] }
    if (m.type === 'tools') {
      if (Array.isArray(m.tools)) this.tools = m.tools
      return
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.type === 'error' || m.error) {
        p.reject(new Error(typeof m.error === 'string' ? m.error : 'Python 技能返回错误'))
      } else {
        p.resolve(m.result)
      }
    }
  }

  private sendAndWait(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error('Python 子进程未启动或已退出'))
        return
      }
      const id = `c${++this.callSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python 技能调用超时(${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin?.write(JSON.stringify({ ...payload, id }) + '\n')
    })
  }

  private onProcessError(err: Error): void {
    console.error(`[python-skill] 子进程错误: ${err.message}`)
    for (const p of this.pending.values()) p.reject(new Error(`子进程错误: ${err.message}`))
    this.pending.clear()
  }

  private onProcessExit(code: number | null): void {
    if (code !== 0 && code !== null) {
      console.warn(`[python-skill] 子进程异常退出,代码: ${code}`)
    }
    this.ready = false
    this.started = false
    for (const p of this.pending.values()) p.reject(new Error(`子进程已退出(code=${code})`))
    this.pending.clear()
  }
}

/** 把 Python 工具 schema 包装成 Mastra tool */
export function wrapPythonTool(host: PythonSkillHost, schema: PythonToolSchema): AnyTool {
  return {
    id: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema as unknown as AnyTool['inputSchema'],
    outputSchema: (schema.outputSchema ?? { type: 'object', properties: {} }) as unknown as AnyTool['outputSchema'],
    execute: async ({ context }: { context: Record<string, unknown> }) => host.callTool(schema.name, context),
  } as unknown as AnyTool
}
