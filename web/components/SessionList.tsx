import { useMemo, useState } from 'react'
import type { SessionSummary } from '../../shared/types.js'
import { fmtBytes, fmtCost, fmtTime, shortPath } from '../api.js'
import { TitleEditor } from './TitleEditor.js'

type Sort = 'recent' | 'cost' | 'size'

export function SessionList({
  sessions, currentId, onPick, onDelete, onRename, showPath, showProvider,
}: {
  sessions: SessionSummary[]
  currentId: string | null
  onPick: (id: string) => void
  onDelete: (s: SessionSummary) => void
  onRename: (s: SessionSummary, title: string) => void
  /** 未按项目筛选时才显示路径 —— 筛选后每行都一样，纯噪音 */
  showPath: boolean
  /** 混合多个 CLI 时才显示来源徽标 */
  showProvider: boolean
}) {
  const [sort, setSort] = useState<Sort>('recent')
  const [editing, setEditing] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = f
      ? sessions.filter((s) =>
          s.title.toLowerCase().includes(f) ||
          s.firstPrompt.toLowerCase().includes(f) ||
          s.cwd.toLowerCase().includes(f))
      : sessions
    const sorted = [...list]
    if (sort === 'cost') sorted.sort((a, b) => b.costUsd - a.costUsd)
    else if (sort === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes)
    // recent 已由后端按 updated_at 排好
    return sorted
  }, [sessions, sort, filter])

  return (
    <>
      <div className="search-box">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="按标题或路径筛选…"
        />
        <div className="nav-tabs" style={{ padding: '8px 0 0' }}>
          {([['recent', '最近'], ['cost', '成本'], ['size', '体积']] as [Sort, string][]).map(([k, label]) => (
            <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="pane-body">
        {rows.map((s) => (
          <div
            key={s.sessionId}
            className={`sess${s.sessionId === currentId ? ' on' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onPick(s.sessionId)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.sessionId) } }}
          >
            <div className="sess-title">
              {editing === s.sessionId ? (
                <TitleEditor
                  initial={s.titleSource === 'custom' ? s.title : ''}
                  onSubmit={(t) => { setEditing(null); onRename(s, t) }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <span>{s.title}</span>
                  {/* 只留状态徽标：来源/分支/自定义都挤在标题行会把标题挤到很早就截断 */}
                  {s.live && <span className="badge live">运行中</span>}
                  <button
                    className="sess-rename"
                    title={
                      s.live ? '运行中的会话不能改名'
                        : !s.capabilities.rename ? `${s.providerName} 暂不支持改名`
                        : '重命名'
                    }
                    disabled={s.live || !s.capabilities.rename}
                    onClick={(e) => { e.stopPropagation(); setEditing(s.sessionId) }}
                  >
                    ✎
                  </button>
                </>
              )}
              <button
                className="sess-del"
                title={s.live ? '运行中的会话不能删除' : '删除会话（可撤销）'}
                disabled={s.live || !s.capabilities.delete}
                onClick={(e) => { e.stopPropagation(); onDelete(s) }}
                style={editing === s.sessionId ? { display: 'none' } : undefined}
              >
                ✕
              </button>
            </div>

            {showPath && (
              <div className="sess-path" title={s.cwd}>{shortPath(s.cwd)}</div>
            )}

            {s.firstPrompt && s.firstPrompt !== s.title && (
              <div className="sess-prompt">{s.firstPrompt}</div>
            )}

            {/* 单行不换行：字段一多就会把行高从 70px 撑到 140px，列表变得没法扫读。
                git 分支最长且价值最低，只在没有其他次要标记时才显示。 */}
            <div className="sess-meta">
              {showProvider && <span className="src">{s.providerName}</span>}
              <span>{fmtTime(s.updatedAt)}</span>
              <span>{s.messageCount} 条</span>
              {s.costUsd > 0 && <span>{fmtCost(s.costUsd)}</span>}
              <span>{fmtBytes(s.sizeBytes)}</span>
              {s.hasBranches && <span title="含 /rewind 分支">⑂</span>}
              {s.titleSource === 'custom' && <span title="已自定义标题">✎</span>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="empty">没有会话</div>}
      </div>
    </>
  )
}
