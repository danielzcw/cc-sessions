import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary, SessionSummary } from '../shared/types.js'
import { api, fmtBytes, fmtCost, fmtTime, shortPath, type TrashEntry } from './api.js'
import { SessionList } from './components/SessionList.js'
import { Transcript } from './components/Transcript.js'
import { SearchView } from './components/SearchView.js'
import { StatsView } from './components/StatsView.js'
import { NewSessionDialog } from './components/NewSessionDialog.js'

type Tab = 'sessions' | 'search' | 'stats' | 'trash'

type Toast = { kind: 'undo'; entry: TrashEntry } | { kind: 'error'; text: string } | null

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [claudeHome, setClaudeHome] = useState('')
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('sessions')
  const [rescanning, setRescanning] = useState(false)
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)
  const [trashItems, setTrashItems] = useState<TrashEntry[]>([])
  const [err, setErr] = useState<string | null>(null)

  const loadProjects = useCallback(() => {
    api.projects()
      .then((r) => { setProjects(r.projects); setClaudeHome(r.claudeHome) })
      .catch((e) => setErr((e as Error).message))
  }, [])

  useEffect(loadProjects, [loadProjects])

  const loadSessions = useCallback(() => {
    api.sessions(cwd ?? undefined)
      .then((r) => setSessions(r.sessions))
      .catch((e) => setErr((e as Error).message))
  }, [cwd])

  useEffect(loadSessions, [loadSessions])

  // 终端里新增/更新的会话会被服务端监听到，这里定时拉一次让列表跟上
  useEffect(() => {
    const t = setInterval(loadSessions, 15_000)
    return () => clearInterval(t)
  }, [loadSessions])

  const openSession = useCallback((id: string) => {
    setCurrent(id)
    setTab('sessions')
  }, [])

  const loadTrash = useCallback(() => {
    api.trash().then((r) => setTrashItems(r.items)).catch(() => setTrashItems([]))
  }, [])

  useEffect(() => { if (tab === 'trash') loadTrash() }, [tab, loadTrash])

  /**
   * 有实质内容的会话必须二次确认。
   * 撤销条只停留十几秒，误删后如果没当场注意到就很难发现 ——
   * 光有回收站不够，得先挡住误触。空会话（0 条）直接删，不打扰。
   */
  const askDelete = (s: SessionSummary) => {
    if (s.messageCount === 0) void removeSession(s)
    else setPendingDelete(s)
  }

  const removeSession = async (s: SessionSummary) => {
    setPendingDelete(null)
    try {
      const r = await api.remove(s.sessionId)
      if (current === s.sessionId) setCurrent(null)
      setSessions((list) => list.filter((x) => x.sessionId !== s.sessionId))
      setToast({ kind: 'undo', entry: r.entry })
      loadProjects()
    } catch (e) {
      setToast({ kind: 'error', text: (e as Error).message })
    }
  }

  const renameSession = async (s: SessionSummary, title: string) => {
    try {
      const r = await api.rename(s.sessionId, title)
      setSessions((list) => list.map((x) =>
        x.sessionId === s.sessionId
          ? { ...x, title: r.title, titleSource: r.titleSource as SessionSummary['titleSource'] }
          : x))
    } catch (e) {
      setToast({ kind: 'error', text: (e as Error).message })
    }
  }

  const undoDelete = async (entry: TrashEntry) => {
    setToast(null)
    try {
      await api.restore(entry.sessionId)
      loadProjects()
      loadSessions()
      if (tab === 'trash') loadTrash()
    } catch (e) {
      setToast({ kind: 'error', text: (e as Error).message })
    }
  }

  // 撤销条 8 秒后自动消失；错误提示留久一点
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.kind === 'undo' ? 15000 : 8000)
    return () => clearTimeout(t)
  }, [toast])

  const rescan = async () => {
    setRescanning(true)
    try {
      await api.rescan()
      loadProjects()
      loadSessions()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRescanning(false)
    }
  }

  const totalCost = projects.reduce((a, p) => a + p.costUsd, 0)
  const totalSessions = projects.reduce((a, p) => a + p.sessionCount, 0)

  return (
    <div className={`app${tab === 'stats' || tab === 'trash' ? ' wide-detail' : ''}`}>
      <aside className="pane pane-sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            Claude Code 会话管理器
            <small>{claudeHome}</small>
          </div>
        </div>

        <button className="btn new-session" onClick={() => setCreating(true)}>＋ 新建会话</button>

        <div className="nav-tabs">
          <button className={tab === 'sessions' ? 'on' : ''} onClick={() => setTab('sessions')}>会话</button>
          <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>搜索</button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>统计</button>
          <button className={tab === 'trash' ? 'on' : ''} onClick={() => setTab('trash')}>回收站</button>
        </div>

        <div className="pane-body">
          <div className="section-label">项目 · {projects.length}</div>
          <button className={`proj${cwd === null ? ' on' : ''}`} onClick={() => setCwd(null)}>
            <div className="proj-name">全部项目</div>
            <div className="proj-meta"><span>{totalSessions} 会话</span><span>{fmtCost(totalCost)}</span></div>
          </button>
          {projects.map((p) => (
            <button
              key={p.cwd}
              className={`proj${cwd === p.cwd ? ' on' : ''}`}
              onClick={() => setCwd(p.cwd)}
              title={p.cwd + (p.projectDirs.length > 1 ? `\n（合并了 ${p.projectDirs.length} 个磁盘目录）` : '')}
            >
              <div className="proj-name">
                {p.name}
                {p.projectDirs.length > 1 && ' ⧉'}
              </div>
              <div className="proj-meta">
                <span>{p.sessionCount}</span>
                <span>{fmtTime(p.lastActiveAt)}</span>
                <span>{fmtCost(p.costUsd)}</span>
              </div>
            </button>
          ))}
        </div>

        <div style={{ flex: 'none', padding: 10, borderTop: '1px solid var(--border)' }}>
          <button className="btn ghost" style={{ width: '100%' }} onClick={() => void rescan()} disabled={rescanning}>
            {rescanning ? <span className="spin" /> : '重新扫描索引'}
          </button>
        </div>
      </aside>

      {tab !== 'stats' && tab !== 'trash' && (
        <section className="pane pane-list">
          {tab === 'search'
            ? <SearchView scopeCwd={cwd} onOpen={openSession} />
            : <SessionList
                sessions={sessions}
                currentId={current}
                onPick={openSession}
                onDelete={askDelete}
                onRename={(s, t) => void renameSession(s, t)}
                showPath={cwd === null}
              />}
        </section>
      )}

      <main className="pane pane-detail">
        {err && <div className="notice" style={{ margin: 10 }}>{err}</div>}
        {tab === 'trash'
          ? <div className="pane-body">
              <div className="stats" style={{ paddingTop: 16 }}>
                <h3 className="sec">回收站 · {trashItems.length}</h3>
                <p className="mono-dim">
                  删除的会话移到 ~/.claude/cc-sessions/trash/，不会自动清理。还原会放回原始路径。
                </p>
                {trashItems.map((t) => (
                  <div className="trash-row" key={t.sessionId}>
                    <div className="info">
                      <div className="t">{t.title}</div>
                      <div className="p">{shortPath(t.cwd, 60)} · {fmtBytes(t.sizeBytes)} · 删除于 {fmtTime(t.deletedAt)}</div>
                    </div>
                    <button className="btn ghost tiny" onClick={() => void undoDelete(t)}>还原</button>
                    <button
                      className="btn tiny danger"
                      onClick={() => {
                        if (!confirm(`彻底删除「${t.title}」？此操作不可恢复。`)) return
                        void api.purge(t.sessionId).then(loadTrash)
                      }}
                    >彻底删除</button>
                  </div>
                ))}
                {trashItems.length === 0 && <div className="empty" style={{ height: 160 }}>回收站是空的</div>}
              </div>
            </div>
          : tab === 'stats'
          ? <StatsView />
          : current
            ? <Transcript key={current} sessionId={current} onNavigate={openSession} onRenamed={loadSessions} />
            : <div className="empty">
                从左侧选一个会话开始<br />
                <span className="mono-dim">
                  ⌘↵ 发送 · Esc 拒绝审批 · 中文搜索 3 字起走 FTS
                </span>
              </div>}
      </main>

      {toast && (
        <div className={`toast${toast.kind === 'error' ? ' err' : ''}`}>
          {toast.kind === 'undo' ? (
            <>
              <span className="msg">已删除「{toast.entry.title}」</span>
              <button className="btn ghost" onClick={() => void undoDelete(toast.entry)}>撤销</button>
              <button className="btn ghost" onClick={() => setToast(null)}>知道了</button>
            </>
          ) : (
            <>
              <span className="msg">{toast.text}</span>
              <button className="btn ghost" onClick={() => setToast(null)}>关闭</button>
            </>
          )}
        </div>
      )}

      {pendingDelete && (
        <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null) }}>
          <div className="modal" role="dialog" aria-modal="true" style={{ width: 'min(480px, 100%)' }}>
            <div className="modal-head">
              <h3>删除这个会话？</h3>
              <p>会移到回收站，可以还原；不会真的从磁盘抹掉</p>
            </div>
            <div className="modal-body">
              <div style={{ fontWeight: 500, marginBottom: 6 }}>{pendingDelete.title}</div>
              <div className="mono-dim">
                {shortPath(pendingDelete.cwd, 60)}<br />
                {pendingDelete.messageCount} 条消息 · {fmtBytes(pendingDelete.sizeBytes)} · 最后活动 {fmtTime(pendingDelete.updatedAt)}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="btn danger" onClick={() => void removeSession(pendingDelete)}>删除</button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <NewSessionDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            // 新会话还没落盘，先直接进聊天界面；发出首条消息后列表会自动刷新
            openSession(id)
            setTimeout(() => { loadProjects(); loadSessions() }, 1500)
          }}
        />
      )}
    </div>
  )
}
