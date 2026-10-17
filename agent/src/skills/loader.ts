import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnyTool, SkillDef, SkillManifest, SkillRuntime, SkillSource } from './registry'
import { PythonSkillHost, wrapPythonTool } from './python-host'

// ============================================================
// 技能加载器(M5):从 runtime-skills/ 目录动态加载技能
// - builtins/ 下的为系统内置技能(TypeScript,同进程)
// - user/ 下的为用户通过聊天生成的技能(可以是 Python/MCP)
// 设计目标:新增/修改技能不需要改 agent/src/skills/index.ts 并重新编译整个项目,
// 只需在 runtime-skills/ 下增删目录,重启服务(或热重载)即可生效
// ============================================================

const ROOT = resolve(process.cwd(), 'runtime-skills')
const BUILTINS_DIR = join(ROOT, 'builtins')
const USER_DIR = join(ROOT, 'user')

export interface LoadedSkill {
  manifest: SkillManifest
  makeTools: (chainKey: string, tokenId: number) => Record<string, AnyTool>
}

/** 读取技能目录下的 skill.json */
function readManifest(dir: string): SkillManifest | null {
  const path = join(dir, 'skill.json')
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as SkillManifest
  } catch (e) {
    console.warn(`[skill-loader] 读取 manifest 失败: ${path}`, e)
    return null
  }
}

/** 发现某个 source 下的所有技能目录 */
function discoverSkillDirs(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) return []
  return readdirSync(sourceDir)
    .map((name) => join(sourceDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'skill.json')))
}

/** 加载一个 TypeScript 内置技能 */
async function loadTypeScriptSkill(dir: string, manifest: SkillManifest): Promise<LoadedSkill | null> {
  const entry = manifest.entry ?? 'index.ts'
  const entryPath = join(dir, entry)
  if (!existsSync(entryPath)) {
    console.warn(`[skill-loader] TypeScript 技能入口不存在: ${entryPath}`)
    return null
  }
  try {
    // 用 file:// URL 兼容 Windows;tsx 运行时负责编译 TS
    const mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>
    // 寻找第一个符合 SkillDef 形状的导出:含 manifest + makeTools
    const exported = Object.values(mod).find(
      (v): v is SkillDef =>
        v != null && typeof v === 'object' && 'manifest' in v && 'makeTools' in v && typeof (v as SkillDef).makeTools === 'function',
    )
    if (!exported) {
      console.warn(`[skill-loader] ${manifest.id} 未导出 SkillDef 对象`)
      return null
    }
    // skill.json 中的 manifest 为权威,但允许 index.ts 里补上没有 runtime/entry/source 的老技能
    return {
      manifest: { ...exported.manifest, ...manifest },
      makeTools: exported.makeTools,
    }
  } catch (e) {
    console.warn(`[skill-loader] 加载 TypeScript 技能 ${manifest.id} 失败`, e)
    return null
  }
}

/** 加载一个 Python/MCP 用户技能 */
async function loadMcpSkill(dir: string, manifest: SkillManifest): Promise<LoadedSkill | null> {
  const entry = manifest.entry ?? (manifest.runtime === 'python' ? 'index.py' : 'server.ts')
  const entryPath = join(dir, entry)
  if (!existsSync(entryPath)) {
    console.warn(`[skill-loader] MCP 技能入口不存在: ${entryPath}`)
    return null
  }
  // 每个 (chainKey, tokenId) 会构造自己的工具集;这里为 makeTools 闭包创建 host 工厂
  return {
    manifest,
    makeTools: () => {
      const host = new PythonSkillHost({ skillDir: dir, entry })
      // 启动并获取工具是异步的,但 Mastra 工具 execute 才是异步入口;
      // 这里先返回一个占位工具,在首次 execute 时完成启动并替换为真实工具集合较复杂,
      // 因此 Phase 2 先采用"技能在 skill.json 中声明 tools,host 启动后校验"的简化方案。
      const declaredTools = manifest.tools
      const tools: Record<string, AnyTool> = {}
      for (const toolName of declaredTools) {
        tools[toolName] = {
          id: toolName,
          description: `${manifest.name} 的技能工具: ${toolName}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
          outputSchema: { type: 'object', properties: { result: {} } },
          execute: async ({ context }: { context: Record<string, unknown> }) => {
            const realTools = await host.start()
            const schema = realTools.find((t) => t.name === toolName)
            if (!schema) throw new Error(`Python 技能未声明工具 ${toolName}`)
            return host.callTool(toolName, context)
          },
        } as unknown as AnyTool
      }
      return tools
    },
  }
}

/** 加载单个技能目录 */
async function loadSkillDir(dir: string, source: SkillSource): Promise<LoadedSkill | null> {
  const manifest = readManifest(dir)
  if (!manifest) return null
  const enriched: SkillManifest = { ...manifest, source }
  const runtime: SkillRuntime = enriched.runtime ?? 'typescript'

  if (runtime === 'typescript') {
    return loadTypeScriptSkill(dir, enriched)
  }
  return loadMcpSkill(dir, enriched)
}

/** 扫描 builtins 目录,返回所有成功加载的技能 */
export async function loadBuiltinSkills(): Promise<LoadedSkill[]> {
  const dirs = discoverSkillDirs(BUILTINS_DIR)
  const skills: LoadedSkill[] = []
  for (const dir of dirs) {
    const skill = await loadSkillDir(dir, 'builtin')
    if (skill) skills.push(skill)
  }
  return skills
}

/** 扫描 user 目录,返回所有成功加载的技能 */
export async function loadUserSkills(): Promise<LoadedSkill[]> {
  const dirs = discoverSkillDirs(USER_DIR)
  const skills: LoadedSkill[] = []
  for (const dir of dirs) {
    const skill = await loadSkillDir(dir, 'user')
    if (skill) skills.push(skill)
  }
  return skills
}

/** 扫描全部 runtime-skills/ 目录 */
export async function loadAllSkills(): Promise<LoadedSkill[]> {
  const [builtins, users] = await Promise.all([loadBuiltinSkills(), loadUserSkills()])
  return [...builtins, ...users]
}

/** 运行时根目录(用于外部模块定位) */
export function getRuntimeSkillsRoot(): string {
  return ROOT
}

/** 为某个用户生成技能准备目录路径 */
export function getUserSkillDir(skillId: string): string {
  return join(USER_DIR, skillId)
}

/** 删除用户技能目录(物理文件) */
export function removeUserSkillDir(skillId: string): void {
  const dir = getUserSkillDir(skillId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
