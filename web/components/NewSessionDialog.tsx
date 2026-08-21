import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderRuntimeInfo } from '../../shared/provider.js'
import { api } from '../api.js'

/**
 * 新建会话：选 CLI + 选工作目录。
 *
 * 只有 capabilities.resume 的 provider 能在 Web 内直接开 —— 那需要接管该 CLI 的
 * 对话协议与权限审批。其余 provider 给出在该目录启动它的终端命令，
 * 不假装能在 Web 里开一个开不起来的会话。
 */
export function NewSessionDialog({
  providers, onClose, onCreated,
}: {
  providers: ProviderRuntimeInfo[]
  onClose: () => void
  onCreated: (sessionId: string) => void
}) {
  const usable = useMemo(() => providers.filter((p) => p.enabled && p.rootExists), [providers])
  const [providerId, setProviderId] = useState(() => {
    // 默认选中能直接开的那个，省一次点击
    const inApp = usable.find((p) => p.capabilities.resume)
    return inApp?.id ?? usable[0]?.id ?? 'claude-code'
  })
  const [suggestions, setSuggestions] = useState<{ cwd: string; known: boolean }[]>([])
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const provider = usable.find((p) => p.id === providerId)
  const inApp = provider?.capabilities.resume ?? false

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
  const terminalCmd = target && provider?.newSessionCommand
    ? provider.newSessionCommand.replace('{cwd}', target)
    : ''

  const create = async () => {
    if (!target || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.newSession(target, providerId)
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
          <p>选择 CLI 与工作目录 —— 会话记录会落到该目录对应的项目下</p>
        </div>
        <div className="modal-body">
          <div className="mono-dim" style={{ marginBottom: 6 }}>CLI</div>
          <div className="cli-pick">
            {usable.map((p) => (
              <button
                key={p.id}
                className={`cli-opt${providerId === p.id ? ' on' : ''}`}
                onClick={() => setProviderId(p.id)}
                title={p.root}
              >
                <span className="src-dot" style={{ background: p.color ?? 'var(--accent)' }} />
                <span className="cli-name">{p.name}</span>
                <span className={`cli-tag${p.capabilities.resume ? ' inapp' : ''}`}>
                  {p.capabilities.resume ? 'Web 内可聊' : '仅终端'}
                </span>
              </button>
            ))}
          </div>

          <div className="mono-dim" style={{ margin: '14px 0 6px' }}>工作目录</div>
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
            onKeyDown={(e) => { if (e.key === 'Enter' && inApp) void create() }}
          />

          {!inApp && provider && (
            <div className="resume-hint" style={{ marginTop: 14 }}>
              <div>
                <strong>{provider.name}</strong> 的对话协议没有接管，无法在 Web 内新建 ——
                在终端里跑下面这条即可，跑完刷新就能在这里看到。
              </div>
              {terminalCmd
                ? (
                    <button
                      className="resume-cmd"
                      title="点击复制"
                      onClick={() => {
                        void navigator.clipboard?.writeText(terminalCmd).then(
                          () => setCopied(true),
                          () => { /* 无剪贴板权限时静默 */ },
                        )
                        setTimeout(() => setCopied(false), 1400)
                      }}
                    >
                      {copied ? '✓ 已复制' : `$ ${terminalCmd}`}
                    </button>
                  )
                : <div className="mono-dim">该来源未配置新建命令，可在「来源」页补上 newSessionCommand</div>}
            </div>
          )}

          {err && <div className="notice" style={{ marginTop: 12 }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <span className="countdown">
            {target ? target.replace(/^\/Users\/[^/]+/, '~') : '未选择目录'}
          </span>
          <button className="btn ghost" onClick={onClose}>取消</button>
          {inApp && (
            <button className="btn" disabled={!target || busy} onClick={() => void create()}>
              {busy ? <span className="spin" /> : '创建并开始'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
