import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DB_FILE } from './paths.js'
import type { SearchHit, StatsResponse, StatsBucket } from '../shared/types.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DB_FILE)

/**
 * 索引结构版本。索引完全由会话文件重建（146 个会话约 2 秒），
 * 所以 schema 变更直接 drop 重建，不写迁移逻辑。
 */
const SCHEMA_VERSION = 2

db.exec('pragma journal_mode = wal; pragma synchronous = normal;')
db.exec('create table if not exists meta (k text primary key, v text)')
{
  const row = db.prepare("select v from meta where k = 'schema_version'").get()
  const cur = row && typeof row === 'object' && 'v' in row ? Number(row.v) : 0
  if (cur !== SCHEMA_VERSION) {
    for (const t of ['sessions', 'msg_fts', 'daily_stats']) {
      db.exec(`drop table if exists ${t}`)
    }
    db.prepare("insert into meta (k, v) values ('schema_version', ?) on conflict(k) do update set v = excluded.v")
      .run(String(SCHEMA_VERSION))
  }
}

db.exec(`
  create table if not exists sessions (
    provider     text not null default 'claude-code',
    session_id   text not null,
    project_dir  text not null,
    cwd          text not null,
    cwd_key      text not null,
    title        text not null,
    title_source text not null,
    first_prompt text not null default '',
    created_at   text,
    updated_at   text,
    msg_count    integer not null default 0,
    git_branch   text,
    model        text,
    cost_usd     real not null default 0,
    in_tokens    integer not null default 0,
    out_tokens   integer not null default 0,
    cache_tokens integer not null default 0,
    has_branches integer not null default 0,
    size_bytes   integer not null default 0,
    -- 增量扫描依据：文件 mtime + size 都没变就跳过重解析
    file_mtime   integer not null default 0,
    file_size    integer not null default 0,
    -- 不同 provider 理论上可能撞 id（自定义 provider 可能用文件名当 id），所以联合主键
    primary key (provider, session_id)
  );
  create index if not exists idx_sessions_cwd on sessions(cwd_key);
  create index if not exists idx_sessions_provider on sessions(provider);
  create index if not exists idx_sessions_updated on sessions(updated_at desc);

  -- trigram 分词器让中文子串可搜（≥3 字），2 字以内走 LIKE 兜底
  create virtual table if not exists msg_fts using fts5(
    body,
    session_id unindexed,
    provider   unindexed,
    role       unindexed,
    ts         unindexed,
    tokenize = 'trigram'
  );

  create table if not exists daily_stats (
    day       text not null,
    cwd_key   text not null,
    model     text not null,
    cost_usd  real not null default 0,
    in_tokens integer not null default 0,
    out_tokens integer not null default 0,
    cache_tokens integer not null default 0,
    sessions  integer not null default 0,
    primary key (day, cwd_key, model)
  );
`)

export type SessionRow = {
  provider: string
  session_id: string; project_dir: string; cwd: string; cwd_key: string
  title: string; title_source: string; first_prompt: string
  created_at: string | null; updated_at: string | null
  msg_count: number; git_branch: string | null; model: string | null
  cost_usd: number; in_tokens: number; out_tokens: number; cache_tokens: number
  has_branches: number; size_bytes: number; file_mtime: number; file_size: number
}

const upsertSession = db.prepare(`
  insert into sessions (
    provider, session_id, project_dir, cwd, cwd_key, title, title_source, first_prompt,
    created_at, updated_at, msg_count, git_branch, model, cost_usd,
    in_tokens, out_tokens, cache_tokens, has_branches, size_bytes, file_mtime, file_size
  ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  on conflict(provider, session_id) do update set
    project_dir=excluded.project_dir, cwd=excluded.cwd, cwd_key=excluded.cwd_key,
    title=excluded.title, title_source=excluded.title_source, first_prompt=excluded.first_prompt,
    created_at=excluded.created_at, updated_at=excluded.updated_at, msg_count=excluded.msg_count,
    git_branch=excluded.git_branch, model=excluded.model, cost_usd=excluded.cost_usd,
    in_tokens=excluded.in_tokens, out_tokens=excluded.out_tokens, cache_tokens=excluded.cache_tokens,
    has_branches=excluded.has_branches, size_bytes=excluded.size_bytes,
    file_mtime=excluded.file_mtime, file_size=excluded.file_size
`)

const deleteFts = db.prepare('delete from msg_fts where session_id = ?')
const insertFts = db.prepare('insert into msg_fts (body, session_id, provider, role, ts) values (?,?,?,?,?)')
const getStamp = db.prepare(
  'select file_mtime, file_size from sessions where provider = ? and session_id = ?',
)

export function needsReindex(provider: string, sessionId: string, mtimeMs: number, size: number): boolean {
  const row = getStamp.get(provider, sessionId)
  if (!row || typeof row !== 'object') return true
  const mtime = 'file_mtime' in row ? Number(row.file_mtime) : -1
  const fsize = 'file_size' in row ? Number(row.file_size) : -1
  return mtime !== Math.floor(mtimeMs) || fsize !== size
}

export function saveSession(row: SessionRow, ftsRows: { body: string; role: string; ts: string | null }[]): void {
  db.exec('begin')
  try {
    upsertSession.run(
      row.provider, row.session_id, row.project_dir, row.cwd, row.cwd_key, row.title, row.title_source,
      row.first_prompt, row.created_at, row.updated_at, row.msg_count, row.git_branch, row.model,
      row.cost_usd, row.in_tokens, row.out_tokens, row.cache_tokens, row.has_branches,
      row.size_bytes, row.file_mtime, row.file_size,
    )
    deleteFts.run(row.session_id)
    for (const f of ftsRows) {
      if (f.body.trim()) insertFts.run(f.body.slice(0, 20000), row.session_id, row.provider, f.role, f.ts)
    }
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

export function removeSession(provider: string, sessionId: string): void {
  db.exec('begin')
  try {
    db.prepare('delete from sessions where provider = ? and session_id = ?').run(provider, sessionId)
    deleteFts.run(sessionId)
    db.exec('commit')
  } catch {
    db.exec('rollback')
  }
}

/** 清掉某个 provider 的全部索引（删除来源时用） */
export function removeProviderSessions(provider: string): number {
  db.exec('begin')
  try {
    const ids = db.prepare('select session_id from sessions where provider = ?').all(provider)
    for (const r of ids as unknown as { session_id: string }[]) deleteFts.run(r.session_id)
    const info = db.prepare('delete from sessions where provider = ?').run(provider)
    db.exec('commit')
    return Number(info.changes ?? 0)
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

/** 索引里真实出现过的模型，按会话数排序 */
export function modelsSeen(): { model: string; sessions: number }[] {
  const rows = db.prepare(`
    select model, count(*) n from sessions
    where model is not null and model != '' and model != 'unknown'
    group by model order by n desc
  `).all()
  return (rows as unknown as { model: string; n: number }[]).map((r) => ({ model: r.model, sessions: r.n }))
}

/** 库里出现过的所有 provider id（用于清理已被删除的来源） */
export function indexedProviderIds(): string[] {
  const rows = db.prepare('select distinct provider from sessions').all()
  return (rows as unknown as { provider: string }[]).map((r) => r.provider)
}

export function allSessions(cwdKey?: string, provider?: string): SessionRow[] {
  const where: string[] = []
  const args: string[] = []
  if (cwdKey) { where.push('cwd_key = ?'); args.push(cwdKey) }
  if (provider) { where.push('provider = ?'); args.push(provider) }
  const sql = `select * from sessions ${where.length ? 'where ' + where.join(' and ') : ''}
    order by coalesce(updated_at, created_at) desc`
  const rows = db.prepare(sql).all(...args)
  return rows as unknown as SessionRow[]
}

export function getSessionRow(sessionId: string, provider?: string): SessionRow | undefined {
  const row = provider
    ? db.prepare('select * from sessions where provider = ? and session_id = ?').get(provider, sessionId)
    : db.prepare('select * from sessions where session_id = ? limit 1').get(sessionId)
  return row as unknown as SessionRow | undefined
}

export type ProjectRow = {
  cwd: string; cwd_key: string; n: number; last: string | null
  cost: number; dirs: string; branches: string; providers: string
}

export function projectRows(provider?: string): ProjectRow[] {
  const rows = db.prepare(`
    select cwd_key,
           min(cwd) as cwd,
           count(*) as n,
           max(coalesce(updated_at, created_at)) as last,
           sum(cost_usd) as cost,
           group_concat(distinct project_dir) as dirs,
           group_concat(distinct git_branch) as branches,
           group_concat(distinct provider) as providers
    from sessions ${provider ? 'where provider = ?' : ''}
    group by cwd_key order by last desc
  `).all(...(provider ? [provider] : []))
  return rows as unknown as ProjectRow[]
}

/** FTS5 的 MATCH 语法里这些字符有特殊含义，作为字面量搜索时必须转义 */
function ftsQuote(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"'
}

export function search(q: string, opts: { cwdKey?: string; limit?: number; provider?: string } = {}): SearchHit[] {
  const query = q.trim()
  if (!query) return []
  const limit = opts.limit ?? 80
  const cjkShort = /[㐀-鿿]/.test(query) && query.length < 3
  const extra = [
    opts.cwdKey ? 'and s.cwd_key = ?' : '',
    opts.provider ? 'and s.provider = ?' : '',
  ].join(' ')
  const extraArgs = [
    ...(opts.cwdKey ? [opts.cwdKey] : []),
    ...(opts.provider ? [opts.provider] : []),
  ]
  const rows = cjkShort || query.length < 3
    // trigram 需要 ≥3 字符，短查询退化成 LIKE 扫描（数据量小，可接受）
    ? db.prepare(`
        select f.session_id, s.provider, f.role, f.ts, f.body, s.cwd, s.title
        from msg_fts f join sessions s
          on s.session_id = f.session_id and s.provider = f.provider
        where f.body like ? ${extra}
        order by f.ts desc limit ?
      `).all(...[`%${query}%`, ...extraArgs, limit])
    : db.prepare(`
        select f.session_id, s.provider, f.role, f.ts,
               snippet(msg_fts, 0, char(1), char(2), '…', 12) as body,
               s.cwd, s.title
        from msg_fts f join sessions s
          on s.session_id = f.session_id and s.provider = f.provider
        where msg_fts match ? ${extra}
        order by rank limit ?
      `).all(...[ftsQuote(query), ...extraArgs, limit])

  return (rows as unknown as { session_id: string; provider: string; role: string; ts: string | null; body: string; cwd: string; title: string }[])
    .map((r) => ({
      sessionId: r.session_id,
      provider: r.provider,
      cwd: r.cwd,
      title: r.title,
      ts: r.ts,
      role: r.role,
      snippet: cjkShort || query.length < 3 ? highlightLike(r.body, query) : r.body,
    }))
}

/** LIKE 分支没有 snippet()，手动截取并插入同样的高亮标记 */
function highlightLike(body: string, q: string): string {
  const i = body.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return body.slice(0, 160)
  const start = Math.max(0, i - 50)
  const seg = body.slice(start, i + q.length + 90)
  const rel = i - start
  return (start > 0 ? '…' : '') + seg.slice(0, rel) + '\u0001' + seg.slice(rel, rel + q.length) + '\u0002' + seg.slice(rel + q.length)
}

/**
 * 空会话（一条 user/assistant 都没有）记录里没有 cwd 字段，只能退回目录名，
 * 而目录名是 `/` 和 `.` 都替换成 `-` 的产物，会凭空多出一个假项目分组。
 * 同目录下别的会话通常有真 cwd，扫描结束后据此回填。
 */
export function repairMissingCwd(): number {
  const broken = db.prepare(
    "select session_id, project_dir from sessions where cwd like '-%'",
  ).all() as unknown as { session_id: string; project_dir: string }[]
  let fixed = 0
  const findSibling = db.prepare(
    "select cwd from sessions where project_dir = ? and cwd not like '-%' limit 1",
  )
  const upd = db.prepare('update sessions set cwd = ?, cwd_key = ? where session_id = ?')
  for (const b of broken) {
    const sib = findSibling.get(b.project_dir) as { cwd: string } | undefined
    if (!sib) continue
    upd.run(sib.cwd, sib.cwd.toLowerCase(), b.session_id)
    fixed++
  }
  return fixed
}

/** 清掉 mtime 指纹，强迫下次扫描全量重解析 */
export function resetStamps(): void {
  db.prepare('update sessions set file_mtime = 0, file_size = -1').run()
}

export function rebuildDailyStats(): void {
  db.exec('delete from daily_stats')
  db.prepare(`
    insert into daily_stats (day, cwd_key, model, cost_usd, in_tokens, out_tokens, cache_tokens, sessions)
    select substr(coalesce(updated_at, created_at), 1, 10) as day,
           cwd_key,
           coalesce(model, 'unknown'),
           sum(cost_usd), sum(in_tokens), sum(out_tokens), sum(cache_tokens), count(*)
    from sessions
    where coalesce(updated_at, created_at) is not null
    group by day, cwd_key, coalesce(model, 'unknown')
  `).run()
}

/** 各 provider 已索引的会话数 */
export function providerCounts(): Record<string, number> {
  const rows = db.prepare('select provider, count(*) n from sessions group by provider').all()
  const out: Record<string, number> = {}
  for (const r of rows as unknown as { provider: string; n: number }[]) out[r.provider] = r.n
  return out
}

export function stats(provider?: string): StatsResponse {
  const w = provider ? 'where provider = ?' : ''
  const a = provider ? [provider] : []
  const tot = db.prepare(`select sum(cost_usd) c, count(*) n, sum(msg_count) m from sessions ${w}`).get(...a) as
    { c: number | null; n: number; m: number | null }
  const mk = (rows: unknown[]): StatsBucket[] =>
    (rows as { key: string; cost: number; i: number; o: number; cr: number; n: number }[]).map((r) => ({
      key: r.key, costUsd: r.cost ?? 0, inputTokens: r.i ?? 0, outputTokens: r.o ?? 0,
      cacheReadTokens: r.cr ?? 0, sessions: r.n ?? 0,
    }))
  const byDay = mk(db.prepare(`
    select substr(coalesce(updated_at, created_at),1,10) key, sum(cost_usd) cost,
           sum(in_tokens) i, sum(out_tokens) o, sum(cache_tokens) cr, count(*) n
    from sessions where coalesce(updated_at, created_at) is not null
      ${provider ? 'and provider = ?' : ''}
    group by key order by key desc limit 90
  `).all(...a))
  const byProject = mk(db.prepare(`
    select min(cwd) key, sum(cost_usd) cost, sum(in_tokens) i, sum(out_tokens) o,
           sum(cache_tokens) cr, count(*) n
    from sessions ${w} group by cwd_key order by cost desc limit 40
  `).all(...a))
  const byModel = mk(db.prepare(`
    select coalesce(model,'unknown') key, sum(cost_usd) cost, sum(in_tokens) i, sum(out_tokens) o,
           sum(cache_tokens) cr, count(*) n
    from sessions ${w} group by key order by cost desc
  `).all(...a))
  return {
    totalCostUsd: tot.c ?? 0,
    totalSessions: tot.n ?? 0,
    totalMessages: tot.m ?? 0,
    byDay: byDay.reverse(),
    byProject,
    byModel,
  }
}

export function dbPath(): string {
  return path.resolve(DB_FILE)
}
