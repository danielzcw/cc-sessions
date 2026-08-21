import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
import { resolveClaudeBin } from './preflight.js'

/**
 * 各 CLI 的指令说明，**从 CLI 自己身上抓取**：递归跑 `--help` 建出命令树。
 *
 * 不手写文档 —— 手写的必然随 CLI 升级而过时（本项目开发期间 claude 就从
 * 2.1.223 升到了 2.1.228）。抓取结果落盘缓存，因为一次完整构建要跑 60+ 次
 * --help，耗时几十秒。
 *
 * 安全：只执行 `--help`，子命令名必须通过白名单校验后才拼进参数，
 * 且全程 execFile + 数组参数（不经 shell）。绝不把用户输入传给 CLI ——
 * 开发中犯过一次 `claude models`，被当成 prompt 真的跑了一轮。
 */

const CACHE_DIR = path.join(DATA_DIR, 'cli-help')
/** 单次构建的最大 --help 调用数，防止命令树意外很深时跑飞 */
const MAX_CALLS = 160
const CALL_TIMEOUT_MS = 25_000

export type HelpOption = { flags: string; desc: string }

export type HelpNode = {
  /** 命令路径，如 ['mcp','add']；空数组是根命令 */
  path: string[]
  /** 完整命令行，如 `claude mcp add` */
  command: string
  usage: string
  summary: string
  /** 原始 --help 输出，界面上原样展示 */
  text: string
  options: HelpOption[]
  subcommands: { name: string; summary: string }[]
}

export type CliHelp = {
  provider: string
  bin: string
  version: string
  generatedAt: string
  nodes: HelpNode[]
  /** 抓取过程中失败的命令，如实列出而不是假装成功 */
  failed: { command: string; error: string }[]
}

export type BuildState = {
  building: boolean
  provider: string | null
  done: number
  total: number
  startedAt: number
}

const state: BuildState = { building: false, provider: null, done: 0, total: 0, startedAt: 0 }

export function buildState(): BuildState {
  return { ...state }
}

function binFor(provider: string): string | null {
  if (provider === 'claude-code') return resolveClaudeBin()
  const home = os.homedir()
  const names: Record<string, string[]> = {
    codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex')],
    omp: [path.join(home, '.bun/bin/omp'), '/opt/homebrew/bin/omp', path.join(home, '.local/bin/omp')],
  }
  for (const p of names[provider] ?? []) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch { /* 下一个 */ }
  }
  return null
}

/** 子命令名白名单：只有通过校验的名字才会被拼进命令行 */
function isSafeSubcommand(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name)
}

function runHelp(bin: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  execFile(bin, args, { timeout: CALL_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    const text = (stdout || '') + (stderr || '')
    // 很多 CLI 的 --help 走 stderr 或返回非 0，只要有内容就算成功
    if (text.trim()) resolve(text)
    else reject(err ?? new Error('没有输出'))
  })
  return promise
}

/**
 * 段标题：`Commands:` 或大写的 `COMMANDS` 两种风格都要认，但**必须顶格**。
 *
 * 缩进的同名行是描述的一部分 —— claude 的 `claude mcp --help` 里，
 * add 的描述里带一个缩进两格的 `Examples:`，若按段标题处理，
 * 从那行往后的 remove/list/get 全部会被漏掉。
 */
function sectionOf(line: string): string | null {
  const m = /^([A-Za-z][A-Za-z ]{2,20}):\s*$/.exec(line)
  if (m) return m[1].trim().toLowerCase()
  const upper = /^([A-Z][A-Z ]{2,20})$/.exec(line)
  if (upper) return upper[1].trim().toLowerCase()
  return null
}

export function parseHelp(text: string): {
  usage: string
  summary: string
  options: HelpOption[]
  subcommands: { name: string; summary: string }[]
} {
  const lines = text.split('\n')
  let usage = ''
  let summary = ''
  const options: HelpOption[] = []
  const subcommands: { name: string; summary: string }[] = []

  let section = ''
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const sec = /^\S/.test(line) ? sectionOf(line.trim()) : null
    if (sec) { section = sec; continue }
    if (!line.trim()) continue

    // Usage 可能写在 `Usage: x` 同一行，也可能在 USAGE 段的下一行
    if (/^usage:/i.test(line.trim())) {
      if (!usage) usage = line.trim().replace(/^usage:\s*/i, '')
      continue
    }
    if (section === 'usage' && !usage) { usage = line.trim().replace(/^\$\s*/, ''); continue }

    if (section === 'commands') {
      /*
       * 命令行的名字缩进很浅（2-4 空格），而换行的描述会对齐到很深的列。
       * 用 \s{2,} 会把描述续行当成命令 —— claude 的
       *   `  auto-mode        Inspect or reset auto mode classifier`
       *   `                   configuration`
       * 就会凭空多出一个叫 configuration 的命令。
       * 同时要认 `plugin|plugins` 这种别名写法，否则整条会匹配不上。
       */
      const m = /^ {2,4}([a-z][a-z0-9-]*)(?:\|[a-z][a-z0-9-]*)?(?=\s|$)(.*)$/.exec(line)
      if (m && isSafeSubcommand(m[1]) && !subcommands.some((s) => s.name === m[1])) {
        // 名字后面可能跟 `[options] <name> [args...]` 这类占位符，
        // 描述是最后一段用 2+ 空格隔开的文本。不能要求名字后紧跟 2 空格 ——
        // `add [options] <name>  Add an MCP server` 那样就匹配不上了。
        const rest = m[2] ?? ''
        const parts = rest.split(/\s{2,}/).filter((x) => x.trim())
        subcommands.push({ name: m[1], summary: (parts[parts.length - 1] ?? '').trim() })
      }
      continue
    }

    if (section === 'options' || section === 'flags') {
      const m = /^\s{2,}(-{1,2}[^\s].*?)(?:\s{2,}(.*))?$/.exec(line)
      if (m) {
        options.push({ flags: m[1].trim(), desc: (m[2] ?? '').trim() })
      } else if (options.length > 0 && /^\s{6,}\S/.test(line)) {
        // 续行：描述换行了，接到上一条后面
        options[options.length - 1].desc = (options[options.length - 1].desc + ' ' + line.trim()).trim()
      }
      continue
    }

    // 段之前的自由文本当作简介
    if (!section && !summary && !line.startsWith(' ')) summary = line.trim()
  }
  return { usage, summary, options, subcommands }
}

function cacheFile(provider: string): string {
  return path.join(CACHE_DIR, `${provider}.json`)
}

export function readCachedHelp(provider: string): CliHelp | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cacheFile(provider), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'nodes' in parsed) {
      // 结构由本模块写入，读回时只做存在性检查
      return parsed as CliHelp
    }
  } catch { /* 没缓存 */ }
  return null
}

/**
 * 递归抓取命令树。depth=0 是根命令，最多再往下两层
 * （`codex mcp add` 这种两级子命令是常见的）。
 */
export async function buildHelp(provider: string): Promise<CliHelp> {
  if (state.building) throw new Error(`正在构建 ${state.provider} 的指令树，请稍候`)
  const bin = binFor(provider)
  if (!bin) throw new Error(`找不到 ${provider} 的可执行文件`)

  state.building = true
  state.provider = provider
  state.done = 0
  state.total = 1
  state.startedAt = Date.now()

  const nodes: HelpNode[] = []
  const failed: { command: string; error: string }[] = []
  let calls = 0

  const walk = async (segs: string[], depth: number, parentText = ''): Promise<void> => {
    if (calls >= MAX_CALLS) return
    calls++
    state.done = calls
    const label = [path.basename(bin), ...segs].join(' ')
    let text: string
    try {
      text = await runHelp(bin, [...segs, '--help'])
    } catch (e) {
      failed.push({ command: label, error: (e as Error).message.slice(0, 200) })
      return
    }
    // 子命令不存在时，很多 CLI 会原样吐回上一级的 help。
    // 光靠解析器很难杜绝误判，这里做一层兜底：内容与父级一致就丢弃且不再递归。
    if (parentText && text === parentText) return

    const parsed = parseHelp(text)
    nodes.push({
      path: segs,
      command: label,
      usage: parsed.usage,
      summary: parsed.summary,
      text,
      options: parsed.options,
      subcommands: parsed.subcommands,
    })

    if (depth >= 2) return
    // help/completion 之类的子命令再往下没有意义，还容易卡住
    const skip = new Set(['help', 'completion', 'completions'])
    const next = parsed.subcommands.filter((s) => !skip.has(s.name))
    state.total = Math.min(MAX_CALLS, state.total + next.length)
    for (const s of next) {
      if (!isSafeSubcommand(s.name)) continue
      await walk([...segs, s.name], depth + 1, text)
    }
  }

  try {
    let version = ''
    try {
      version = (await runHelp(bin, ['--version'])).trim().split('\n')[0]
    } catch { /* 拿不到版本不影响 */ }

    await walk([], 0)

    const help: CliHelp = {
      provider,
      bin,
      version,
      generatedAt: new Date().toISOString(),
      nodes,
      failed,
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cacheFile(provider), JSON.stringify(help, null, 2) + '\n')
    return help
  } finally {
    state.building = false
    state.provider = null
  }
}
