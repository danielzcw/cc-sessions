import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../../shared/types.js'
import { api, fmtTime } from '../api.js'

/**
 * 后端用控制字符 U+0001 / U+0002 包裹命中片段，而不是 <b> —— 这样即使正文里
 * 本身含 HTML 也不会混淆，且前端是按数组渲染，天然免疫注入。
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/[\u0001\u0002]/)
  return (
    <span className="hit-snip">
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  )
}

export function SearchView({
  scopeCwd, onOpen,
}: {
  scopeCwd: string | null
  onOpen: (sessionId: string) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [scoped, setScoped] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const query = q.trim()
    if (!query) { setHits([]); return }
    setBusy(true)
    const t = setTimeout(() => {
      api.search(query, scoped && scopeCwd ? scopeCwd : undefined)
        .then((r) => setHits(r.hits))
        .catch(() => setHits([]))
        .finally(() => setBusy(false))
    }, 220)
    return () => clearTimeout(t)
  }, [q, scoped, scopeCwd])

  return (
    <>
      <div className="search-box">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索所有会话正文…"
        />
        <div className="composer-bar" style={{ marginTop: 8 }}>
          {scopeCwd && (
            <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
              仅当前项目
            </label>
          )}
          <span style={{ marginLeft: 'auto' }}>
            {busy ? <span className="spin" /> : q.trim() ? `${hits.length} 条结果` : '中文 2 字走 LIKE，3 字起走 FTS'}
          </span>
        </div>
      </div>
      <div className="pane-body">
        {hits.map((h, i) => (
          <button className="hit" key={`${h.sessionId}-${i}`} onClick={() => onOpen(h.sessionId)}>
            <div className="hit-title">{h.title}</div>
            <Snippet text={h.snippet} />
            <div className="hit-meta">
              {h.role === 'user' ? '👤' : '🤖'} {fmtTime(h.ts)} · {h.cwd.replace(/^\/Users\/[^/]+/, '~')}
            </div>
          </button>
        ))}
        {!busy && q.trim() && hits.length === 0 && <div className="empty">没有匹配结果</div>}
      </div>
    </>
  )
}
