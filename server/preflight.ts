import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_HOME, PROJECTS_DIR } from './paths.js'

export type CheckLevel = 'ok' | 'warn' | 'fatal'
export type Check = { name: string; level: CheckLevel; detail: string; hint?: string }

/** node:sqlite（DatabaseSync）从 Node 22.5.0 才有，低于此版本会直接崩在 import 阶段 */
const MIN_NODE = [22, 5, 0] as const

function cmpVersion(v: string, min: readonly number[]): boolean {
  const parts = v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]) return true
    if ((parts[i] ?? 0) < min[i]) return false
  }
  return true
}

/**
 * 找 claude 可执行文件。
 * macOS 上装法不止一种，PATH 里不一定有 —— 尤其从 GUI 或非登录 shell 启动时：
 *   原生安装器  ~/.local/bin/claude
 *   Homebrew   /opt/homebrew/bin（Apple Silicon）/usr/local/bin（Intel）
 *   npm 全局    $(npm prefix -g)/bin
 *   旧版本地装  ~/.claude/local/claude
 */
export function resolveClaudeBin(): string | null {
  const explicit = process.env.CCS_CLAUDE_BIN
  if (explicit) return fs.existsSync(explicit) ? explicit : null

  // 优先用 PATH 里的，跟用户在终端敲 claude 的行为一致。
  // 直接调 /bin/sh -c 而不是给 execFileSync 传 shell 选项 —— 后者会把参数
  // 拼进命令行且不转义（Node 会给 DEP0190 警告）。
  try {
    const p = execFileSync('/bin/sh', ['-c', 'command -v claude'], {
      encoding: 'utf8', timeout: 3000,
    }).trim()
    if (p && fs.existsSync(p)) return p
  } catch { /* PATH 里没有，往下找 */ }

  const home = os.homedir()
  const candidates = [
    path.join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.claude/local/claude'),
  ]
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (prefix) candidates.push(path.join(prefix, 'bin/claude'))
  } catch { /* 没装 npm 也无所谓 */ }

  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch { /* 下一个 */ }
  }
  return null
}

/** CLI 的默认模型（settings.json 里的 model 字段），不传 --model 时生效 */
export function readDefaultModel(): string | null {
  try {
    const raw = fs.readFileSync(path.join(CLAUDE_HOME, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'model' in parsed) {
      const m = Reflect.get(parsed, 'model')
      if (typeof m === 'string' && m.trim()) return m.trim()
    }
  } catch { /* 没配就是没配 */ }
  return null
}

export function runChecks(): Check[] {
  const checks: Check[] = []

  checks.push(
    cmpVersion(process.version, MIN_NODE)
      ? { name: 'Node 版本', level: 'ok', detail: process.version }
      : {
          name: 'Node 版本',
          level: 'fatal',
          detail: `${process.version}，低于所需的 v${MIN_NODE.join('.')}`,
          hint: '本项目用内置的 node:sqlite（免原生编译），它从 Node 22.5.0 起才提供。请升级 Node。',
        },
  )

  const bin = resolveClaudeBin()
  if (!bin) {
    checks.push({
      name: 'claude CLI',
      level: 'fatal',
      detail: '未找到可执行文件',
      hint: '装好 Claude Code 并确保 claude 在 PATH 中；或用 CCS_CLAUDE_BIN=/path/to/claude 显式指定。',
    })
  } else {
    let version = ''
    try {
      version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
    } catch (e) {
      checks.push({
        name: 'claude CLI',
        level: 'fatal',
        detail: `${bin} 执行失败：${(e as Error).message.slice(0, 120)}`,
      })
    }
    if (version) {
      checks.push({ name: 'claude CLI', level: 'ok', detail: `${version}  (${bin})` })
      checks.push({
        name: '版本兼容性',
        level: 'warn',
        detail: '续聊依赖隐藏参数 --permission-prompt-tool，官方无兼容承诺',
        hint: '只读浏览不受影响。若续聊时工具调用全被拒绝，多半是该参数在新版里改了，跑 npm run doctor -- --live 实测。',
      })
    }
  }

  if (fs.existsSync(PROJECTS_DIR)) {
    let n = 0
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        n += fs.readdirSync(path.join(PROJECTS_DIR, d.name)).filter((f) => f.endsWith('.jsonl')).length
      }
    } catch { /* 权限问题，下面按 0 处理 */ }
    checks.push(
      n > 0
        ? { name: '会话目录', level: 'ok', detail: `${PROJECTS_DIR.replace(os.homedir(), '~')}（${n} 个会话）` }
        : {
            name: '会话目录',
            level: 'warn',
            detail: '目录存在但没有会话文件',
            hint: '先用 claude 跑一个会话，或用 CLAUDE_CONFIG_DIR 指向别的配置目录。',
          },
    )
  } else {
    checks.push({
      name: '会话目录',
      level: 'warn',
      detail: `${PROJECTS_DIR.replace(os.homedir(), '~')} 不存在`,
      hint: '还没用过 Claude Code？先跑一次 claude 即可生成。界面会是空的但不影响启动。',
    })
  }

  if (process.platform !== 'darwin') {
    checks.push({
      name: '运行平台',
      level: 'warn',
      detail: `${process.platform}（本项目只在 macOS 上验证过）`,
      hint: '活跃会话检测依赖 BSD 版 ps 的输出格式，其他平台可能误判。',
    })
  }

  return checks
}

const ICON: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️ ', fatal: '❌' }

export function printChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`${ICON[c.level]} ${c.name}：${c.detail}`)
    if (c.hint && c.level !== 'ok') console.log(`   ↳ ${c.hint}`)
  }
}

/** 启动时调用：有 fatal 就打印原因并退出，别让用户对着一堆栈追踪猜 */
export function preflightOrExit(): void {
  const checks = runChecks()
  const fatal = checks.filter((c) => c.level === 'fatal')
  if (fatal.length === 0) {
    const warns = checks.filter((c) => c.level === 'warn')
    if (warns.length) {
      console.log('[ccs] 启动自检有提示：')
      printChecks(warns)
    }
    return
  }
  console.error('\n[ccs] 环境不满足，无法启动：\n')
  printChecks(checks)
  console.error(`\n配置目录：${CLAUDE_HOME}\n完整体检：npm run doctor\n`)
  process.exit(1)
}
