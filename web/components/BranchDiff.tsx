import { useEffect, useState } from 'react'
import type { ViewMessage } from '../../shared/types.js'
import { api, fmtTime } from '../api.js'
import { DiffView, MessageView } from './Blocks.js'

type Side = { headUuid: string; messages: ViewMessage[]; text: string }

function sideStats(s: Side) {
  let tools = 0
  for (const m of s.messages) tools += m.blocks.filter((b) => b.kind === 'tool').length
  return { count: s.messages.filter((m) => !m.meta).length, tools }
}

/**
 * 分支对比。/rewind 会在同一个 jsonl 里留下多条分支，
 * 这里既给「拍平文本的行级 diff」，也给「两侧原始气泡并排」两种视角。
 */
export function BranchDiff({
  sessionId, a, b, labelA, labelB, onClose,
}: {
  sessionId: string
  a: string
  b: string
  labelA: string
  labelB: string
  onClose: () => void
}) {
  const [data, setData] = useState<{ a: Side; b: Side } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'diff' | 'side'>('diff')

  useEffect(() => {
    setData(null)
    setErr(null)
    api.branchDiff(sessionId, a, b).then(setData).catch((e) => setErr((e as Error).message))
  }, [sessionId, a, b])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>分支对比</h3>
          <p>
            <span className="tag-a">{labelA}</span> ↔ <span className="tag-b">{labelB}</span>
            {data && `　·　${sideStats(data.a).count} 条 ↔ ${sideStats(data.b).count} 条`}
          </p>
          <div className="nav-tabs" style={{ padding: '8px 0 0', maxWidth: 260 }}>
            <button className={mode === 'diff' ? 'on' : ''} onClick={() => setMode('diff')}>行级 diff</button>
            <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>并排原文</button>
          </div>
        </div>

        <div className="modal-body">
          {err && <div className="notice">{err}</div>}
          {!data && !err && <div className="empty"><span className="spin" /></div>}

          {data && mode === 'diff' && (
            <DiffView
              oldText={data.a.text}
              newText={data.b.text}
              context={4}
              label={`${labelA} → ${labelB}`}
            />
          )}

          {data && mode === 'side' && (
            <div className="side-by-side">
              <div className="side">
                <div className="side-head tag-a">{labelA}</div>
                {data.a.messages.filter((m) => !m.meta).map((m) => (
                  <MessageView key={m.uuid} msg={m} />
                ))}
              </div>
              <div className="side">
                <div className="side-head tag-b">{labelB}</div>
                {data.b.messages.filter((m) => !m.meta).map((m) => (
                  <MessageView key={m.uuid} msg={m} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="countdown">
            {data && `${labelA} 起于 ${fmtTime(data.a.messages[0]?.ts ?? null)} · ${labelB} 起于 ${fmtTime(data.b.messages[0]?.ts ?? null)}`}
          </span>
          <button className="btn ghost" onClick={onClose}>关闭 (Esc)</button>
        </div>
      </div>
    </div>
  )
}
