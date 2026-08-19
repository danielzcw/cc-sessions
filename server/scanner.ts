import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PROJECTS_DIR, LIVE_SESSIONS_DIR, TRASH_DIR, assertContained, isValidSessionId, normalizeCwd } from './paths.js'
import { foldSession, parseLines } from './parser.js'
import type { ParsedSession } from './parser.js'
import { needsReindex, removeSession, saveSession, rebuildDailyStats, type SessionRow } from './db.js'
import type { ViewMessage } from '../shared/types.js'

export type ScanResult = { scanned: number; reindexed: number; removed: number; ms: number }

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

async function indexFile(projectDir: string, file: string): Promise<boolean> {
  const full = path.join(PROJECTS_DIR, projectDir, file)
  const sessionId = file.replace(/\.jsonl$/, '')
  let st: fs.Stats
  try {
    st = await fsp.stat(full)
  } catch {
    return false
  }
  if (!needsReindex(sessionId, st.mtimeMs, st.size)) return false

  const text = await fsp.readFile(full, 'utf8')
  const records = parseLines(text.split('\n'))
  if (records.length === 0) return false
  const parsed = foldSession(records, sessionId)

  // cwd 一律取自记录内容 —— 目录名做过 `/`和`.`→`-` 替换，不可逆
  const cwd = parsed.cwd ?? projectDir
  const { title, source } = titleOf(parsed)

  const row: SessionRow = {
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

/**
 * @param force 忽略 mtime 缓存全量重解析。改动 parser/计价逻辑后必须用，
 *              否则旧结果会因为文件没变而一直留在库里。
 */
export async function scanAll(force = false): Promise<ScanResult> {
  const t0 = Date.now()
  let scanned = 0
  let reindexed = 0
  const seen = new Set<string>()

  if (force) {
    const { resetStamps } = await import('./db.js')
    resetStamps()
  }

  let dirs: string[]
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return { scanned: 0, reindexed: 0, removed: 0, ms: Date.now() - t0 }
  }

  for (const dir of dirs) {
    let files: string[]
    try {
      files = (await fsp.readdir(path.join(PROJECTS_DIR, dir))).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      scanned++
      seen.add(f.replace(/\.jsonl$/, ''))
      try {
        if (await indexFile(dir, f)) reindexed++
      } catch (e) {
        console.warn(`[scan] 跳过 ${dir}/${f}:`, (e as Error).message)
      }
    }
  }

  // 清理已被删除的会话
  let removed = 0
  const { allSessions } = await import('./db.js')
  for (const row of allSessions()) {
    if (!seen.has(row.session_id)) {
      removeSession(row.session_id)
      removed++
    }
  }

  // 必须在全部会话入库后做：回填依赖同目录下的兄弟会话。很便宜，每次都跑。
  const { repairMissingCwd } = await import('./db.js')
  const repaired = repairMissingCwd()
  if (reindexed || removed || repaired) rebuildDailyStats()
  return { scanned, reindexed, removed, ms: Date.now() - t0 }
}

/** 单个会话的强制重新索引（收到文件变更或聊完一轮后调用） */
export async function reindexSession(sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return }
  for (const dir of dirs) {
    const p = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) {
      await indexFile(dir, `${sessionId}.jsonl`)
      rebuildDailyStats()
      return
    }
  }
}

export async function readSessionFile(sessionId: string): Promise<{ records: ReturnType<typeof parseLines>; projectDir: string } | null> {
  if (!isValidSessionId(sessionId)) return null
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return null }
  for (const dir of dirs) {
    const p = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) {
      const text = await fsp.readFile(p, 'utf8')
      return { records: parseLines(text.split('\n')), projectDir: dir }
    }
  }
  return null
}

/**
 * 重命名会话：往 jsonl 追加一条 custom-title 记录。
 *
 * 这是 CLI 自己用的机制（它的 /resume 选择器读同一个字段），所以改完在终端里也一致。
 * 只追加、不重写文件 —— jsonl 本来就是仅追加的事件日志，这是最不具侵入性的写法。
 * 传空字符串表示清除自定义标题，回落到 AI 生成的标题。
 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  if (!isValidSessionId(sessionId)) throw new Error('会话 id 非法')
  const file = await locateSessionFile(sessionId)
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
export async function trashSession(sessionId: string, title: string, cwd: string): Promise<TrashEntry> {
  if (!isValidSessionId(sessionId)) throw new Error('会话 id 非法')
  const src = await locateSessionFile(sessionId)
  if (!src) throw new Error('会话文件不存在')
  await fsp.mkdir(TRASH_DIR, { recursive: true })

  const dest = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  const st = await fsp.stat(src)
  const entry: TrashEntry = {
    sessionId, title, cwd,
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
  if (!isValidSessionId(sessionId)) throw new Error('会话 id 非法')
  const metaPath = path.join(TRASH_DIR, `${sessionId}.meta.json`)
  assertContained(TRASH_DIR, metaPath)
  const raw = await fsp.readFile(metaPath, 'utf8').catch(() => null)
  if (!raw) throw new Error('回收站里没有这个会话')
  const entry = JSON.parse(raw) as TrashEntry
  const src = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  if (!fs.existsSync(src)) throw new Error('回收站文件已丢失')

  // originalPath 读自回收站的 meta 文件，属于外部数据 —— 必须限制在会话目录内，
  // 否则被篡改的 meta 就能把文件还原到任意位置
  assertContained(PROJECTS_DIR, entry.originalPath)

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
  if (!isValidSessionId(sessionId)) throw new Error('会话 id 非法')
  const jsonl = path.join(TRASH_DIR, `${sessionId}.jsonl`)
  const meta = path.join(TRASH_DIR, `${sessionId}.meta.json`)
  assertContained(TRASH_DIR, jsonl)
  assertContained(TRASH_DIR, meta)
  await fsp.unlink(jsonl).catch(() => {})
  await fsp.unlink(meta).catch(() => {})
}

async function locateSessionFile(sessionId: string): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return null }
  for (const dir of dirs) {
    const p = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  return null
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
