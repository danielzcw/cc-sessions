import os from 'node:os'
import path from 'node:path'

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
export const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects')
export const HISTORY_FILE = path.join(CLAUDE_HOME, 'history.jsonl')
/** 每个正在运行的 CLI 进程会在这里留一个 <pid>.json */
export const LIVE_SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions')
export const DATA_DIR = path.join(CLAUDE_HOME, 'cc-sessions')
export const DB_FILE = path.join(DATA_DIR, 'index.db')
/** 删除的会话先移到这里，可撤销；不做硬删除，历史记录丢了没法恢复 */
export const TRASH_DIR = path.join(DATA_DIR, 'trash')

/**
 * 目录名是 cwd 把 `/` 和 `.` 都替换成 `-` 得到的，**不可逆**：
 *   /Users/you/.claude/skills/x  ->  -Users-you--claude-skills-x
 * 所以永远不要反解目录名，cwd 一律从记录里的 cwd 字段读。
 * 这个函数只用于「已知 cwd 时定位目录」。
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/**
 * 分组主键。macOS 文件系统默认大小写不敏感，
 * /Users/you/Work/x 和 /Users/you/work/x 是同一个目录却会生成两个 project dir，
 * 必须归一化后合并，否则同一项目的历史会被劈成两半。
 */
export function normalizeCwd(cwd: string): string {
  let p = cwd.trim()
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p
}

export function projectDisplayName(cwd: string): string {
  const base = path.basename(cwd)
  return base || cwd
}

export function tildify(p: string): string {
  const home = os.homedir()
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}

/**
 * 会话 id 必须是 UUID。
 *
 * 所有 sessionId 都来自文件名（CLI 生成的 UUID），而这些 id 会被拼进文件路径。
 * 不校验的话 `../../..` 就能穿越出目标目录 —— 实测可通过
 * `DELETE /api/trash/<穿越路径>` 删除文件系统上任意 .jsonl / .meta.json。
 */
export function isValidSessionId(id: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)
}

/**
 * 纵深防御：确认 target 解析后确实位于 base 之内。
 * 即使上层漏了校验，这里也不会让操作逃出目标目录。
 */
export function assertContained(base: string, target: string): void {
  const b = path.resolve(base)
  const t = path.resolve(target)
  if (t !== b && !t.startsWith(b + path.sep)) {
    throw new Error(`路径越界：${t} 不在 ${b} 之内`)
  }
}
