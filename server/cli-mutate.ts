import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
import { resolveClaudeBin } from './preflight.js'

/**
 * MCP 与技能的增删。
 *
 * MCP 一律走各 CLI 自己的 `mcp add|remove` 命令，而不是手改配置文件 ——
 * claude 的 MCP 在 ~/.claude.json（活动状态文件）、codex 是 TOML，
 * 手改都容易写坏，而两个 CLI 都提供了官方命令。
 * omp 没有 mcp 子命令，但它的 mcp.json 是纯 JSON，直接改是安全的。
 *
 * 所有外部命令都用 execFile + 数组参数（不经 shell），配合名称白名单，
 * 从根上避免命令注入。
 */

const home = os.homedir()

export type McpInput = {
  name: string
  /** claude 的作用域：user 全局 / local 仅当前目录 / project 写进项目 .mcp.json */
  scope?: 'user' | 'local' | 'project'
  transport: 'stdio' | 'http'
  /** stdio 时是可执行文件，http 时是 URL */
  target: string
  args: string[]
  env: Record<string, string>
}

/** MCP / 技能名称白名单：这些名字会进命令行与文件路径 */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('名称只能是字母数字与 . _ -，且以字母数字开头，不超过 64 字符')
  }
}

function run(bin: string, args: string[], label: string): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    // execFileSync 的报错里 stderr 才是有用信息
    const stderr = 'stderr' in err && err.stderr ? String(err.stderr).trim() : ''
    throw new Error(`${label} 失败：${stderr || err.message}`.slice(0, 500))
  }
}

function codexBin(): string {
  for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex')]) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch { /* 下一个 */ }
  }
  return 'codex'
}

function ompMcpFile(): string {
  return path.join(home, '.omp', 'agent', 'mcp.json')
}

function readOmpMcp(): { data: Record<string, unknown>; servers: Record<string, unknown> } {
  const file = ompMcpFile()
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) data[k] = v
    }
  } catch {
    data = {}
  }
  const raw = data.mcpServers
  const servers: Record<string, unknown> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) servers[k] = v
  }
  return { data, servers }
}

function writeOmpMcp(data: Record<string, unknown>, servers: Record<string, unknown>): void {
  const file = ompMcpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-ccs')
  data.mcpServers = servers
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

export function addMcp(provider: string, input: McpInput): void {
  assertSafeName(input.name)
  const target = input.target.trim()
  if (!target) throw new Error('必须填写命令或 URL')
  if (input.transport === 'http' && !/^https?:\/\//.test(target)) {
    throw new Error('HTTP 传输的 target 必须是 http(s) URL')
  }

  if (provider === 'claude-code') {
    const bin = resolveClaudeBin()
    if (!bin) throw new Error('找不到 claude 可执行文件')
    const args = ['mcp', 'add']
    // 不显式指定的话 claude 默认写 local（只对某个目录生效），
    // 从设置中心添加的服务器应当全局可用
    args.push('--scope', input.scope ?? 'user')
    if (input.transport === 'http') {
      // http 形式：claude mcp add --transport http <name> <url>
      args.push('--transport', 'http', input.name, target)
      for (const [k, v] of Object.entries(input.env)) args.push('-e', `${k}=${v}`)
    } else {
      // stdio 形式：claude mcp add <name> [-e K=V] -- <command> [args...]
      // 命令必须在 `--` 之后，写成 `--` 前的位置参数会报 missing commandOrUrl
      args.push(input.name)
      for (const [k, v] of Object.entries(input.env)) args.push('-e', `${k}=${v}`)
      args.push('--', target, ...input.args)
    }
    run(bin, args, 'claude mcp add')
    return
  }

  if (provider === 'codex') {
    const args = ['mcp', 'add', input.name]
    if (input.transport === 'http') args.push('--url', target)
    else args.push('--', target, ...input.args)
    run(codexBin(), args, 'codex mcp add')
    if (Object.keys(input.env).length) {
      // codex mcp add 不接受 -e，环境变量要写进 config.toml 的 env 子表
      throw new Error('已添加，但 codex 的环境变量需手动写进 config.toml 的 [mcp_servers.<name>.env]')
    }
    return
  }

  if (provider === 'omp') {
    const { data, servers } = readOmpMcp()
    if (input.name in servers) throw new Error(`${input.name} 已存在`)
    servers[input.name] = input.transport === 'http'
      ? { url: target }
      : {
          command: target,
          ...(input.args.length ? { args: input.args } : {}),
          ...(Object.keys(input.env).length ? { env: input.env } : {}),
        }
    writeOmpMcp(data, servers)
    return
  }

  throw new Error(`${provider} 不支持增删 MCP`)
}

export function removeMcp(provider: string, name: string, scope?: string): void {
  assertSafeName(name)
  if (provider === 'claude-code') {
    const bin = resolveClaudeBin()
    if (!bin) throw new Error('找不到 claude 可执行文件')
    // 不带 scope 时 CLI 会自己找它在哪个作用域
    const args = scope ? ['mcp', 'remove', '--scope', scope, name] : ['mcp', 'remove', name]
    run(bin, args, 'claude mcp remove')
    return
  }
  if (provider === 'codex') {
    run(codexBin(), ['mcp', 'remove', name], 'codex mcp remove')
    return
  }
  if (provider === 'omp') {
    const { data, servers } = readOmpMcp()
    if (!(name in servers)) throw new Error(`${name} 不存在`)
    Reflect.deleteProperty(servers, name)
    writeOmpMcp(data, servers)
    return
  }
  throw new Error(`${provider} 不支持增删 MCP`)
}

// ---------------- 技能 ----------------

const SKILL_TRASH = path.join(DATA_DIR, 'trash-skills')

function skillsRoot(provider: string): string {
  if (provider === 'claude-code') {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')
  }
  if (provider === 'codex') return path.join(home, '.codex', 'skills')
  throw new Error(`${provider} 没有可管理的技能目录`)
}

export function addSkill(provider: string, name: string, description: string, body: string): string {
  assertSafeName(name)
  const desc = description.replace(/[\r\n]+/g, ' ').trim()
  if (!desc) throw new Error('description 不能为空：CLI 靠它判断何时加载技能')
  const root = skillsRoot(provider)
  const dir = path.join(root, name)
  if (fs.existsSync(dir)) throw new Error(`${name} 已存在`)

  fs.mkdirSync(dir, { recursive: true })
  // frontmatter 里的值用双引号包住并转义，description 常含冒号和逗号
  const fm = [
    '---',
    `name: ${name}`,
    `description: "${desc.replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + (body.trim() ? body.trim() + '\n' : `# ${name}\n`))
  return dir
}

export type SkillTrashEntry = {
  provider: string
  name: string
  originalPath: string
  trashPath: string
  deletedAt: string
}

/** 移除技能：移到回收站而不是删除 —— 技能可能是用户手写的，删了没法恢复 */
export function removeSkill(provider: string, name: string): SkillTrashEntry {
  assertSafeName(name)
  const root = skillsRoot(provider)
  const dir = path.join(root, name)
  const resolved = path.resolve(dir)
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('路径越界')
  }
  if (!fs.existsSync(dir)) throw new Error(`${name} 不存在`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(SKILL_TRASH, provider, `${name}-${stamp}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(dir, dest)
  const entry: SkillTrashEntry = {
    provider, name,
    originalPath: dir,
    trashPath: dest,
    deletedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dest, '.ccs-trash.json'), JSON.stringify(entry, null, 2) + '\n')
  return entry
}

export function listSkillTrash(): SkillTrashEntry[] {
  const out: SkillTrashEntry[] = []
  let providers: string[]
  try {
    providers = fs.readdirSync(SKILL_TRASH, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const p of providers) {
    const dir = path.join(SKILL_TRASH, p)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      try {
        const meta: unknown = JSON.parse(fs.readFileSync(path.join(dir, e.name, '.ccs-trash.json'), 'utf8'))
        if (meta && typeof meta === 'object' && 'name' in meta) {
          out.push({
            provider: p,
            name: String(Reflect.get(meta, 'name')),
            originalPath: String(Reflect.get(meta, 'originalPath') ?? ''),
            trashPath: path.join(dir, e.name),
            deletedAt: String(Reflect.get(meta, 'deletedAt') ?? ''),
          })
        }
      } catch { /* 元数据坏了就跳过 */ }
    }
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
}

export function restoreSkill(trashPath: string): void {
  const resolved = path.resolve(trashPath)
  if (!resolved.startsWith(path.resolve(SKILL_TRASH) + path.sep)) throw new Error('路径越界')
  const metaFile = path.join(resolved, '.ccs-trash.json')
  const meta: unknown = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  if (!meta || typeof meta !== 'object' || !('originalPath' in meta)) throw new Error('缺少还原信息')
  const dest = String(Reflect.get(meta, 'originalPath'))
  const provider = String(Reflect.get(meta, 'provider') ?? '')
  // 还原目标必须落在该 provider 的技能目录内
  const root = path.resolve(skillsRoot(provider))
  if (!path.resolve(dest).startsWith(root + path.sep)) throw new Error('还原路径越界')
  if (fs.existsSync(dest)) throw new Error('原位置已存在同名技能，未覆盖')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(resolved, dest)
  fs.rmSync(path.join(dest, '.ccs-trash.json'), { force: true })
}
