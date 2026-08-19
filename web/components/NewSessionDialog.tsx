import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'

/**
 * 新建会话：本质是挑一个工作目录。
 * CLI 的会话是绑定 cwd 的（jsonl 落到 cwd 派生的项目目录），所以目录必须先定下来。
 */
export function NewSessionDialog({
  onClose, onCreated,
}: {
  onClose: () => void
  onCreated: (sessionId: string) => void
}) {
  const [suggestions, setSuggestions] = useState<{ cwd: string; known: boolean }[]>([])
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    api.cwdSuggestions()
      .then((r) => {
        setSuggestions(r.suggestions)
        setPicked(r.suggestions[0]?.cwd ?? null)
      })
      .catch((e) => setErr((e as Error).message))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? suggestions.filter((s) => s.cwd.toLowerCase().includes(f)) : suggestions
  }, [suggestions, filter])

  const target = custom.trim() || picked

  const create = async () => {
    if (!target || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.newSession(target)
      onCreated(r.sessionId)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>新建会话</h3>
          <p>选择工作目录 —— 会话记录会落到该目录对应的项目下，Claude 也只能访问这里</p>
        </div>
        <div className="modal-body">
          <input
            ref={inputRef}
            className="cwd-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选目录…"
          />
          <div className="cwd-list">
            {rows.map((s) => (
              <button
                key={s.cwd}
                className={`cwd-row${!custom.trim() && picked === s.cwd ? ' on' : ''}`}
                onClick={() => { setPicked(s.cwd); setCustom('') }}
              >
                <span className="path">{s.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
                {s.known && <span className="badge">有历史</span>}
              </button>
            ))}
            {rows.length === 0 && <div className="mono-dim" style={{ padding: 10 }}>没有匹配目录</div>}
          </div>

          <div className="mono-dim" style={{ margin: '12px 0 4px' }}>或手动输入绝对路径</div>
          <input
            className="cwd-filter"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="/Users/…"
            onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
          />

          {err && <div className="notice" style={{ marginTop: 12 }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <span className="countdown">
            {target ? target.replace(/^\/Users\/[^/]+/, '~') : '未选择目录'}
          </span>
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn" disabled={!target || busy} onClick={() => void create()}>
            {busy ? <span className="spin" /> : '创建并开始'}
          </button>
        </div>
      </div>
    </div>
  )
}
