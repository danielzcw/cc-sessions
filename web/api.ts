import type {
  ApprovalDecision, ProjectSummary, SearchHit, SessionDetail, SessionSummary, StatsResponse, ViewMessage,
} from '../shared/types.js'
import type { ProviderConfig, ProviderRuntimeInfo } from '../shared/provider.js'
import type { ProbeResult } from '../server/providers/probe.js'

export type TrashEntry = {
  sessionId: string
  title: string
  cwd: string
  originalPath: string
  deletedAt: string
  sizeBytes: number
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 200))
  return (await r.json()) as T
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T)
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`)
  return json
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T)
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`)
  return json
}

async function del<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'DELETE' })
  const text = await r.text()
  const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T)
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`)
  return json
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T)
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`)
  return json
}

/** provider 维度的查询参数拼接 */
function pq(params: Record<string, string | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return q.length ? '?' + q.join('&') : ''
}

export const api = {
  providers: () => get<{ providers: ProviderRuntimeInfo[]; configPath: string }>('/api/providers'),
  saveProvider: (cfg: ProviderConfig) => put<{ ok: true }>(`/api/providers/${cfg.id}`, cfg),
  deleteProvider: (id: string) => del<{ ok: true }>(`/api/providers/${id}`),
  probeProvider: (cfg: ProviderConfig) => post<ProbeResult>('/api/providers/probe', cfg),
  projects: (provider?: string) =>
    get<{ projects: ProjectSummary[]; claudeHome: string }>('/api/projects' + pq({ provider })),
  sessions: (cwd?: string, provider?: string) =>
    get<{ sessions: SessionSummary[] }>('/api/sessions' + pq({ cwd, provider })),
  session: (id: string, provider?: string) =>
    get<SessionDetail>(`/api/sessions/${id}` + pq({ provider })),
  search: (q: string, cwd?: string, provider?: string) =>
    get<{ hits: SearchHit[] }>('/api/search' + pq({ q, cwd, provider })),
  stats: (provider?: string) => get<StatsResponse>('/api/stats' + pq({ provider })),
  rescan: () => post<{ scanned: number; reindexed: number; removed: number; ms: number }>('/api/rescan'),
  send: (id: string, text: string) => post<{ ok: true }>(`/api/chat/${id}/send`, { text }),
  interrupt: (id: string) => post<{ ok: true }>(`/api/chat/${id}/interrupt`),
  approve: (id: string, approvalId: string, decision: ApprovalDecision) =>
    post<{ ok: boolean }>(`/api/chat/${id}/approve`, { approvalId, decision }),
  exportUrl: (id: string) => `/api/sessions/${id}/export`,
  newSession: (cwd: string, provider?: string) =>
    post<{ sessionId: string; cwd: string; provider: string }>('/api/sessions/new', { cwd, provider }),
  cwdSuggestions: () => get<{ suggestions: { cwd: string; known: boolean }[] }>('/api/cwd-suggestions'),
  rename: (id: string, title: string) =>
    patch<{ ok: true; title: string; titleSource: string }>(`/api/sessions/${id}/title`, { title }),
  remove: (id: string) => del<{ ok: true; entry: TrashEntry }>(`/api/sessions/${id}`),
  restore: (id: string) => post<{ ok: true; entry: TrashEntry }>(`/api/sessions/${id}/restore`),
  trash: () => get<{ items: TrashEntry[] }>('/api/trash'),
  purge: (id: string) => del<{ ok: true }>(`/api/trash/${id}`),
  branchDiff: (id: string, a: string, b: string) =>
    get<{
      a: { headUuid: string; messages: ViewMessage[]; text: string }
      b: { headUuid: string; messages: ViewMessage[]; text: string }
    }>(`/api/sessions/${id}/branch-diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
}

export function fmtCost(usd: number): string {
  if (!usd) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = Date.now()
  const diff = now - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days} 天前`
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)}M`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)}K`
  return `${n}B`
}

/** ~ 缩写 + 过长时保留首尾，中间省略 —— 列表宽度有限，尾部目录名信息量最大 */
export function shortPath(p: string, max = 44): string {
  const t = p.replace(/^\/Users\/[^/]+/, '~')
  if (t.length <= max) return t
  const parts = t.split('/')
  if (parts.length <= 3) return '…' + t.slice(-(max - 1))
  const tail = parts.slice(-2).join('/')
  const head = parts[0] || '/'
  return `${head}/…/${tail}`.length <= max ? `${head}/…/${tail}` : '…/' + tail
}
