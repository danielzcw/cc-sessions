import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../../shared/types.js'

/** 从入参里挑出最该让人看清的内容 —— 命令、文件路径、要写入的正文 */
function focusOf(req: ApprovalRequest): { label: string; body: string } | null {
  const i = req.input
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const cmd = s('command')
  if (cmd) return { label: '将执行命令', body: cmd }
  const fp = s('file_path')
  if (fp) {
    const content = s('content') ?? s('new_string')
    return { label: content ? `将写入 ${fp}` : '目标文件', body: content ?? fp }
  }
  const url = s('url')
  if (url) return { label: '将请求', body: url }
  return null
}

const RISKY = /^(Bash|Write|Edit|NotebookEdit|KillShell)$/

export function ApprovalDialog({
  request, total, onDecide,
}: {
  request: ApprovalRequest
  total: number
  onDecide: (allow: boolean) => void
}) {
  const [left, setLeft] = useState(() => Math.max(0, 300 - Math.floor((Date.now() - request.createdAt) / 1000)))

  useEffect(() => {
    const t = setInterval(() => {
      setLeft(Math.max(0, 300 - Math.floor((Date.now() - request.createdAt) / 1000)))
    }, 1000)
    return () => clearInterval(t)
  }, [request.createdAt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDecide(false)
      // 需要按住 meta 才能回车放行，避免手滑批准危险操作
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onDecide(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  const focus = focusOf(request)
  const risky = RISKY.test(request.toolName)

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onDecide(false) }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>
            {risky ? '⚠️ ' : ''}Claude 请求使用 <code>{request.toolName}</code>
          </h3>
          <p>
            批准后该工具会在 <code>{'本机'}</code> 真实执行
            {total > 1 && `　·　还有 ${total - 1} 个待处理`}
          </p>
        </div>
        <div className="modal-body">
          <dl className="kv">
            <dt>工具</dt><dd>{request.toolName}</dd>
            {request.toolUseId && <><dt>tool_use_id</dt><dd>{request.toolUseId}</dd></>}
          </dl>
          {focus && (
            <>
              <div className="mono-dim" style={{ marginBottom: 4 }}>{focus.label}</div>
              <pre style={{ marginBottom: 12 }}>{focus.body.slice(0, 4000)}</pre>
            </>
          )}
          <div className="mono-dim" style={{ marginBottom: 4 }}>完整入参</div>
          <pre>{JSON.stringify(request.input, null, 2).slice(0, 6000)}</pre>
        </div>
        <div className="modal-foot">
          <span className="countdown">
            {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后自动拒绝` : '即将超时'}
          </span>
          <button className="btn ghost" onClick={() => onDecide(false)}>拒绝 (Esc)</button>
          <button className={`btn${risky ? ' danger' : ''}`} onClick={() => onDecide(true)}>
            允许 (⌘↵)
          </button>
        </div>
      </div>
    </div>
  )
}
