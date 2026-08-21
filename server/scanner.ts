import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PROJECTS_DIR, LIVE_SESSIONS_DIR, TRASH_DIR, assertContained, isSafeSessionId, normalizeCwd } from './paths.js'
import { foldSession, parseLines } from './parser.js'
import type { ParsedSession } from './parser.js'
import {
  allSessions, indexedProviderIds, needsReindex, rebuildDailyStats, removeProviderSessions,
  removeSession, repairMissingCwd, resetStamps, saveSession, type SessionRow,
} from './db.js'
import type { ViewMessage } from '../shared/types.js'
import type { ProviderConfig } from '../shared/provider.js'
import { enabledProviders, expandTilde, listProviders } from './providers/registry.js'
import { foldGeneric, sessionIdFromFile } from './providers/generic.js'

export type ScanResult = {
  scanned: number
  reindexed: number
  removed: number
  ms: number
  /** 每个 provider 匹配到的文件数，便于在界面上定位「为什么某个 CLI 没会话」 */
  perProvider: Record<string, number>
}

function titleOf(p: ParsedSession): { title: string; source: 'custom' | 'ai' | 'prompt' } {
  if (p.customTitle) return { title: p.customTitle, source: 'custom' }
  if (p.aiTitle) return { title: p.aiTitle, source: 'ai' }
  const t = p.firstPrompt.trim()
  return { title: t ? t.slice(0, 80) : '(无标题会话)', source: 'prompt' }
}

/** 抽出进 FTS 的文本：用户与助手的正文，thinking 也进（找"当时怎么想的"很有用），工具输出不进（噪音大） */
function ftsRowsOf(messages: ViewMessage[]): { body: string; role: string; ts: string | null }[] {
  const out: { body: string; role: string; ts: string | null }[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const parts: string[] = []
    for (const b of m.blocks) {
      if (b.kind === 'text' || b.kind === 'thinking') parts.push(b.text)
      else if (b.kind === 'tool') parts.push(`[${b.name}]`)
    }
    const body = parts.join('\n').trim()
    if (body) out.push({ body, role: m.role, ts: m.ts })
  }
  return out
}

/**
 * 索引单个会话文件。
 * claude-code 走专用解析器（需要 tool_result 回填与分支树），其余走规则引擎。
 */
async function indexFile(cfg: ProviderConfig, absPath: string, rootAbs: string): Promise<boolean> {
  let st: fs.Stats
  try {
    st = await fsp.stat(absPath)
  } catch {
    return false
  }

  const sessionId = cfg.kind === 'builtin-claude'
    ? path.basename(absPath).replace(/\.jsonl$/, '')
    : sessionIdFromFile(cfg, absPath)

  if (!needsReindex(cfg.id, sessionId, st.mtimeMs, st.size)) return false

  const text = await fsp.readFile(absPath, 'utf8')
  const lines = text.split('\n')
  if (lines.length === 0) return false

  let parsed: ParsedSession
  if (cfg.kind === 'builtin-claude') {
    const records = parseLines(lines)
    if (records.length === 0) return false
    parsed = foldSession(records, sessionId)
  } else {
    const records: unknown[] = []
    for (const l of lines) {
      const t = l.trim()
      if (!t) continue
      try { records.push(JSON.parse(t)) } catch { /* 写入中途被读到，末行截断是正常的 */ }
    }
    if (records.length === 0) return false
    parsed = foldGeneric(records, sessionId, cfg)
  }

  // cwd 一律取自记录内容 —— 目录名普遍做过不可逆的字符替换
  const projectDir = path.relative(rootAbs, path.dirname(absPath)) || '.'
  const cwd = parsed.cwd ?? projectDir
  const { title, source } = titleOf(parsed)

  const row: SessionRow = {
    provider: cfg.id,
    session_id: sessionId,
    project_dir: projectDir,
    cwd,
    cwd_key: normalizeCwd(cwd),
    title,
    title_source: source,
    first_prompt: parsed.firstPrompt,
    created_at: parsed.firstTs,
    updated_at: parsed.lastTs,
    msg_count: parsed.visibleCount,
    git_branch: parsed.gitBranch,
    model: parsed.model,
    cost_usd: parsed.usage.costUsd,
    in_tokens: parsed.usage.input_tokens ?? 0,
    out_tokens: parsed.usage.output_tokens ?? 0,
    cache_tokens: (parsed.usage.cache_read_input_tokens ?? 0) + (parsed.usage.cache_creation_input_tokens ?? 0),
    has_branches: parsed.branches.length > 0 ? 1 : 0,
    size_bytes: st.size,
    file_mtime: Math.floor(st.mtimeMs),
    file_size: st.size,
  }
  saveSession(row, ftsRowsOf(parsed.messages))
  return true
}

/** 把 glob（只支持 `*` 与 `**`）编译成正则，用于匹配相对 root 的路径 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** 跨目录；后面紧跟 / 时把这段斜杠也吞掉，好让 `**/x` 能匹配顶层的 x
        i++
        if (glob[i + 1] === '/') i++
        re += '(?:.*/)?'
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** 递归列出 root 下匹配 glob 的文件（相对路径） */
async function listMatching(rootAbs: string, glob: string): Promise<string[]> {
  const re = globToRegExp(glob)
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs, depth + 1)
      } else if (e.isFile()) {
        const rel = path.relative(rootAbs, abs)
        if (re.test(rel)) out.push(rel)
      }
    }
  }
  await walk(rootAbs, 0)
  return out
}

/**
 * @param force 忽略 mtime 缓存全量重解析。改动解析逻辑或 provider 规则后必须用，
 *              否则旧结果会因为文件没变而一直留在库里。
 */
export async function scanAll(force = false): Promise<ScanResult> {
  const t0 = Date.now()
  let scanned = 0
  let reindexed = 0
  /** `${provider}\u0000${sessionId}`，用于清理已删除会话 */
  const seen = new Set<string>()

  if (force) resetStamps()

  const perProvider: Record<string, number> = {}
  for (const cfg of enabledProviders()) {
    const rootAbs = expandTilde(cfg.root)
    if (!fs.existsSync(rootAbs)) continue
    const files = await listMatching(rootAbs, cfg.glob || '**/*.jsonl')
    perProvider[cfg.id] = files.length
    for (const rel of files) {
      const abs = path.join(rootAbs, rel)
      scanned++
      const sid = cfg.kind === 'builtin-claude'
        ? path.basename(abs).replace(/\.jsonl$/, '')
        : sessionIdFromFile(cfg, abs)
      seen.add(`${cfg.id}\u0000${sid}`)
      try {
        if (await indexFile(cfg, abs, rootAbs)) reindexed++
      } catch (e) {
        console.warn(`[scan] 跳过 ${cfg.id}:${rel}:`, (e as Error).message)
      }
    }
  }

  // 配置里已经不存在的 provider（被删掉的），整批索引清掉。
  // 仅「停用」的保留，否则重新启用又要全量重扫。
  const known = new Set(listProviders().map((p) => p.id))
  let removed = 0
  for (const pid of indexedProviderIds()) {
    if (!known.has(pid)) removed += removeProviderSessions(pid)
  }

  const active = new Set(enabledProviders().map((p) => p.id))
  for (const row of allSessions()) {
    if (!active.has(row.provider)) continue
    if (!seen.has(`${row.provider}\u0000${row.session_id}`)) {
      removeSession(row.provider, row.session_id)
      removed++
    }
  }

  // 必须在全部会话入库后做：回填依赖同目录下的兄弟会话。很便宜，每次都跑。
  const repaired = repairMissingCwd()
  if (reindexed || removed || repaired) rebuildDailyStats()
  return { scanned, reindexed, removed, ms: Date.now() - t0, perProvider }
}

export type LocatedSession = { cfg: ProviderConfig; absPath: string; rootAbs: string }

/**
 * 在各 provider 的根目录下定位会话文件。
 * provider 已知时只搜它，否则按启用顺序逐个找（用于只拿到 sessionId 的旧接口）。
 */
export async function locateSession(sessionId: string, provider?: string): Promise<LocatedSession | null> {
  if (!isSafeSessionId(sessionId)) return null
  const candidates = provider
    ? enabledProviders().filter((p) => p.id === provider)
    : enabledProviders()
  for (const cfg of candidates) {
    const rootAbs = expandTilde(cfg.root)
    if (!fs.existsSync(rootAbs)) continue
    for (const rel of await listMatching(rootAbs, cfg.glob || '**/*.jsonl')) {
      const abs = path.join(rootAbs, rel)
      const sid = cfg.kind === 'builtin-claude'
        ? path.basename(abs).replace(/\.jsonl$/, '')
        : sessionIdFromFile(cfg, abs)
      if (sid !== sessionId) continue
      assertContained(rootAbs, abs)
      return { cfg, absPath: abs, rootAbs }
    }
  }
  return null
}

/** 解析出会话内容，自动按 provider 选择解析器 */
export async function loadParsedSession(
  sessionId: string,
  provider?: string,
): Promise<{ cfg: ProviderConfig; parsed: ParsedSession } | null> {
  const loc = await locateSession(sessionId, provider)
  if (!loc) return null
  const text = await fsp.readFile(loc.absPath, 'utf8')
  const lines = text.split('\n')
  if (loc.cfg.kind === 'builtin-claude') {
    return { cfg: loc.cfg, parsed: foldSession(parseLines(lines), sessionId) }
  }
  const records: unknown[] = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) continue
    try { records.push(JSON.parse(t)) } catch { /* 末行可能截断 */ }
  }
  return { cfg: loc.cfg, parsed: foldGeneric(records, sessionId, loc.cfg) }
}

/** 单个会话的强制重新索引（收到文件变更或聊完一轮后调用） */
export async function reindexSession(sessionId: string, provider?: string): Promise<void> {
  const loc = await locateSession(sessionId, provider)
  if (!loc) return
  await indexFile(loc.cfg, loc.absPath, loc.rootAbs)
  rebuildDailyStats()
}


/**
 * 重命名会话：往 jsonl 追加一条 custom-title 记录。
 *
 * 这是 CLI 自己用的机制（它的 /resume 选择器读同一个字段），所以改完在终端里也一致。
 * 只追加、不重写文件 —— jsonl 本来就是仅追加的事件日志，这是最不具侵入性的写法。
 * 传空字符串表示清除自定义标题，回落到 AI 生成的标题。
 */
export async function renameSession(sessionId: string, title: string, provider?: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
  const file = await locateSessionFile(sessionId, provider)
  if (!file) throw new Error('会话文件不存在')
  const clean = title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200)
  const record = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId }) + '\n'

  // 确保追加从新行开始：文件最后一行可能没有换行符，直接追加会把两条记录粘成一行
  const fh = await fsp.open(file, 'r+')
  try {
    const { size } = await fh.stat()
    let prefix = ''
    if (size > 0) {
      const buf = Buffer.alloc(1)
      await fh.read(buf, 0, 1, size - 1)
      if (buf.toString() !== '\n') prefix = '\n'
    }
    await fh.write(prefix + record, size)
  } finally {
    await fh.close()
  }
}

export type TrashEntry = {
  sessionId: string
  /** 来自哪个 provider —— 还原时要按它的根目录做包含校验 */
  provider: string
  title: string
  cwd: string
  originalPath: string
  deletedAt: string
  sizeBytes: number
}

/**
 * 删除会话：移到回收站而非 unlink。
 * 会话历史是不可再生的数据，硬删除一旦误操作就没救了。
 */
export async function trashSession(sessionId: string, title: string, cwd: string, provider = 'claude-code'): Promise<TrashEntry> {
  if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
  const src = await locateSessionFile(sessionId, provider)
  if (!src) throw new Error('会话文件不存在')
  await fsp.mkdir(TRASH_DIR, { recursive: true })

  const dest = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  const st = await fsp.stat(src)
  const entry: TrashEntry = {
    sessionId, provider, title, cwd,
    originalPath: src,
    deletedAt: new Date().toISOString(),
    sizeBytes: st.size,
  }
  // 先写元数据再移动文件：反过来的话中途失败就丢失了原始路径，无法还原
  await fsp.writeFile(path.join(TRASH_DIR, `${sessionId}.meta.json`), JSON.stringify(entry, null, 2))
  await fsp.rename(src, dest).catch(async (e) => {
    // 跨设备时 rename 会失败，退回复制+删除
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fsp.copyFile(src, dest)
    await fsp.unlink(src)
  })
  return entry
}

/** 从回收站还原到原始路径 */
export async function restoreSession(sessionId: string): Promise<TrashEntry> {
  if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
  const metaPath = path.join(TRASH_DIR, `${sessionId}.meta.json`)
  assertContained(TRASH_DIR, metaPath)
  const raw = await fsp.readFile(metaPath, 'utf8').catch(() => null)
  if (!raw) throw new Error('回收站里没有这个会话')
  const entry = JSON.parse(raw) as TrashEntry
  const src = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  if (!fs.existsSync(src)) throw new Error('回收站文件已丢失')

  // originalPath 读自回收站的 meta 文件，属于外部数据 —— 必须限制在该 provider 的
  // 根目录内，否则被篡改的 meta 就能把文件还原到任意位置。
  // 不能写死 claude 的 projects 目录，否则 codex / omp 的会话根本还原不回去。
  // 迁移前写入的条目没有 provider 字段，那时只支持 claude-code
  const providerId = entry.provider || 'claude-code'
  const owner = enabledProviders().find((p) => p.id === providerId)
  const allowedRoot = owner ? expandTilde(owner.root) : PROJECTS_DIR
  assertContained(allowedRoot, entry.originalPath)

  // 原目录可能已被清理，重建后再还原
  await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true })
  if (fs.existsSync(entry.originalPath)) throw new Error('原位置已存在同名会话，未覆盖')
  await fsp.rename(src, entry.originalPath).catch(async (e) => {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fsp.copyFile(src, entry.originalPath)
    await fsp.unlink(src)
  })
  await fsp.unlink(metaPath).catch(() => { /* 元数据删不掉不影响还原 */ })
  return entry
}

export async function listTrash(): Promise<TrashEntry[]> {
  let files: string[]
  try {
    files = (await fsp.readdir(TRASH_DIR)).filter((f) => f.endsWith('.meta.json'))
  } catch {
    return []
  }
  const out: TrashEntry[] = []
  for (const f of files) {
    try {
      const e = JSON.parse(await fsp.readFile(path.join(TRASH_DIR, f), 'utf8')) as TrashEntry
      if (fs.existsSync(path.join(TRASH_DIR, `${e.sessionId}.jsonl`))) out.push(e)
    } catch { /* 元数据损坏就跳过 */ }
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
}

/** 彻底删除回收站里的一条（不可恢复） */
export async function purgeTrash(sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
  const jsonl = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  const meta = path.join(TRASH_DIR, `${sessionId}.meta.json`)
  assertContained(TRASH_DIR, jsonl)
  assertContained(TRASH_DIR, meta)
  await fsp.unlink(jsonl).catch(() => {})
  await fsp.unlink(meta).catch(() => {})
}

async function locateSessionFile(sessionId: string, provider?: string): Promise<string | null> {
  const loc = await locateSession(sessionId, provider)
  return loc ? loc.absPath : null
}

/**
 * 哪些会话此刻有 CLI 进程在跑 —— 这些不能 resume（实测会直接失败）。
 * ~/.claude/sessions/<pid>.json 是运行中进程留下的，进程没了文件可能残留，所以要验活。
 */
export function liveSessionIds(): Set<string> {
  const out = new Set<string>()
  let files: string[]
  try {
    files = fs.readdirSync(LIVE_SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }

  // 进程退出后 pid 文件会残留，而 pid 会被系统回收给别的进程 —— 只看「pid 存活且叫 claude」
  // 仍会误判。这里再用进程真实启动时间与文件里的 startedAt 对齐，排除 pid 复用。
  const claudeProcs = liveClaudeProcs()

  for (const f of files) {
    const pid = Number(f.replace(/\.json$/, ''))
    if (!Number.isFinite(pid)) continue
    const procStartMs = claudeProcs.get(pid)
    if (procStartMs === undefined) continue

    let j: Record<string, unknown>
    try {
      j = JSON.parse(fs.readFileSync(path.join(LIVE_SESSIONS_DIR, f), 'utf8')) as Record<string, unknown>
    } catch { continue /* 文件可能正在写 */ }

    // startedAt 是 CLI 启动后不久写下的；若当前进程的启动时间与之相差过大，
    // 说明这个 pid 已经被回收给了另一个 claude 进程，文件是陈旧的
    const startedAt = typeof j.startedAt === 'number' ? j.startedAt : null
    if (startedAt !== null && Math.abs(procStartMs - startedAt) > 5 * 60_000) continue

    // 排除本 App 自己 spawn 的子进程：它们由我们管理，不该阻止用户操作会话
    if (ownedPids.has(pid)) continue

    for (const key of ['sessionId', 'session_id', 'id']) {
      const v = j[key]
      if (typeof v === 'string') out.add(v)
    }
  }
  return out
}

/** 本 App 自己 spawn 的 claude 子进程 pid，由 runner 注册 */
const ownedPids = new Set<number>()

export function registerOwnedPid(pid: number): void {
  ownedPids.add(pid)
}
export function unregisterOwnedPid(pid: number): void {
  ownedPids.delete(pid)
}

/** pid -> 进程启动时间（ms）。只收命令名为 claude 的进程。 */
function liveClaudeProcs(): Map<number, number> {
  const procs = new Map<number, number>()
  try {
    // lstart 给绝对启动时间，可与 pid 文件里的 startedAt 直接比对
    const out = execFileSync('ps', ['-axo', 'pid=,lstart=,comm='], { encoding: 'utf8', timeout: 3000 })
    for (const line of out.split('\n')) {
      // pid  <24字符的 lstart>  comm
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line)
      if (!m) continue
      const comm = m[3]
      if (!/(^|\/)claude$/.test(comm.trim())) continue
      const t = Date.parse(m[2])
      procs.set(Number(m[1]), Number.isNaN(t) ? 0 : t)
    }
  } catch {
    // ps 不可用时退回单纯存活探测。宁可多报「运行中」也不要漏报 ——
    // 漏报会让用户去 resume 一个活跃会话而直接失败。
    try {
      for (const f of fs.readdirSync(LIVE_SESSIONS_DIR)) {
        const pid = Number(f.replace(/\.json$/, ''))
        if (!Number.isFinite(pid)) continue
        try { process.kill(pid, 0); procs.set(pid, 0) } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EPERM') procs.set(pid, 0)
        }
      }
    } catch { /* 目录不存在 */ }
  }
  return procs
}
