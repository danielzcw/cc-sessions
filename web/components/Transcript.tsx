import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { BranchInfo, SessionDetail, SessionSummary, ViewMessage } from '../../shared/types.js'
import { api, fmtCost, fmtTime, shortPath } from '../api.js'
import { MessageView } from './Blocks.js'
import { ApprovalDialog } from './ApprovalDialog.js'
import { BranchDiff } from './BranchDiff.js'
import { TitleEditor } from './TitleEditor.js'
import { useChat } from '../useChat.js'

/** 超过这个条数才启用虚拟滚动；短会话直接全渲染，避免测量开销和跳动 */
const VIRTUAL_THRESHOLD = 60

function branchLabel(b: BranchInfo, headUuid: string): string {
  const i = b.choices.findIndex((c) => c.headUuid === headUuid)
  return i === b.choices.length - 1 ? '主干' : `分支${i + 1}`
}

function BranchPanel({
  branches, chosen, onChoose, onCompare,
}: {
  branches: BranchInfo[]
  chosen: Record<string, string>
  onChoose: (forkAt: string, headUuid: string) => void
  onCompare: (forkAt: string, a: string, b: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (branches.length === 0) return null
  return (
    <div className="branch-panel">
      <button className="fold-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="name">⑂ {branches.length} 处分叉</span>
        <span className="hint">{open ? '' : '由 /rewind 产生，可切换查看或两两对比'}</span>
      </button>
      {open && branches.map((b) => {
        const active = chosen[b.forkAt] ?? b.choices[b.choices.length - 1].headUuid
        return (
          <div key={b.forkAt}>
            {b.choices.map((c, i) => (
              <button
                key={c.headUuid}
                className={`branch-choice${active === c.headUuid ? ' on' : ''}`}
                onClick={() => onChoose(b.forkAt, c.headUuid)}
              >
                <span className="tag">{i === b.choices.length - 1 ? '主干' : `分支${i + 1}`}</span>
                <span className="prev">{c.preview}</span>
                <span className="mono-dim">{c.messageCount} 条 · {fmtTime(c.ts)}</span>
              </button>
            ))}
            {b.choices.length >= 2 && (
              <div className="branch-actions">
                {b.choices.slice(0, -1).map((c, i) => {
                  const main = b.choices[b.choices.length - 1]
                  return (
                    <button
                      key={c.headUuid}
                      className="btn ghost tiny"
                      onClick={() => onCompare(b.forkAt, c.headUuid, main.headUuid)}
                    >
                      对比 分支{i + 1} ↔ 主干
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 按选定分支裁剪消息列表。
 * jsonl 是仅追加的，分叉后两条分支的记录在文件里交错存在，
 * 直接按行序渲染会把两个版本混在一起，所以要沿 parentUuid 只保留选中的那条链。
 */
function selectBranch(messages: ViewMessage[], branches: BranchInfo[], chosen: Record<string, string>): ViewMessage[] {
  if (branches.length === 0) return messages
  const dropped = new Set<string>()
  const childrenOf = new Map<string, ViewMessage[]>()
  for (const m of messages) {
    if (!m.parentUuid) continue
    const a = childrenOf.get(m.parentUuid) ?? []
    a.push(m)
    childrenOf.set(m.parentUuid, a)
  }
  for (const b of branches) {
    const keep = chosen[b.forkAt] ?? b.choices[b.choices.length - 1].headUuid
    for (const c of b.choices) {
      if (c.headUuid === keep) continue
      const stack = [c.headUuid]
      while (stack.length) {
        const id = stack.pop()!
        if (dropped.has(id)) continue
        dropped.add(id)
        for (const k of childrenOf.get(id) ?? []) stack.push(k.uuid)
      }
    }
  }
  return messages.filter((m) => !dropped.has(m.uuid))
}

export function Transcript({
  sessionId, sessions, onNavigate, onRenamed,
}: {
  sessionId: string
  /** 列表数据，用于在详情加载前就知道该会话属于哪个 provider */
  sessions: SessionSummary[]
  onNavigate: (id: string) => void
  onRenamed?: () => void
}) {
  const listed = sessions.find((s) => s.sessionId === sessionId)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [showMeta, setShowMeta] = useState(false)
  const [draft, setDraft] = useState('')
  const [compare, setCompare] = useState<{ a: string; b: string; labelA: string; labelB: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

  const chat = useChat(sessionId)

  const reload = useCallback(() => {
    api.session(sessionId, listed?.provider).then(setDetail).catch((e) => setLoadErr((e as Error).message))
  }, [sessionId, listed?.provider])

  useEffect(() => {
    setDetail(null)
    setLoadErr(null)
    setChosen({})
    reload()
  }, [sessionId, reload])

  // 每轮结束后重新拉取，让实时气泡被落盘记录替换（uuid 对齐后去重）
  useEffect(() => {
    if (chat.lastResult) reload()
  }, [chat.lastResult, reload])

  useEffect(() => {
    if (chat.forkedTo && chat.forkedTo !== sessionId) onNavigate(chat.forkedTo)
  }, [chat.forkedTo, sessionId, onNavigate])

  const historyMessages = useMemo(
    () => (detail ? selectBranch(detail.messages, detail.branches, chosen) : []),
    [detail, chosen],
  )
  const known = useMemo(() => new Set(historyMessages.map((m) => m.uuid)), [historyMessages])
  const all = useMemo(
    () => [...historyMessages, ...chat.liveMessages.filter((m) => !known.has(m.uuid))],
    [historyMessages, chat.liveMessages, known],
  )
  const visible = useMemo(() => (showMeta ? all : all.filter((m) => !m.meta)), [all, showMeta])

  const useVirtual = visible.length > VIRTUAL_THRESHOLD

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    // 首屏用估高，挂载后 measureElement 会替换成真实高度
    estimateSize: () => 160,
    overscan: 8,
    getItemKey: (i) => visible[i]?.uuid ?? i,
    enabled: useVirtual,
  })

  /**
   * 只有用户本来就贴在底部时才自动滚动，避免打断往上翻历史。
   *
   * 虚拟列表的总高是逐帧收敛的：初始按估高算，item 挂载后 measureElement 换成真实高度，
   * 而贴底又会让新的 item 进入视口、触发新的测量。所以固定跑两帧不够（实测会差几百 px），
   * 这里改成「高度连续若干帧不再变化」才认为稳定。
   */
  useEffect(() => {
    if (!atBottomRef.current) return
    let raf = 0
    let cancelled = false
    let lastHeight = -1
    let stableFrames = 0
    let totalFrames = 0

    const pin = () => {
      if (cancelled) return
      const el = scrollRef.current
      if (!el) return
      if (el.scrollHeight !== lastHeight) {
        lastHeight = el.scrollHeight
        el.scrollTop = el.scrollHeight
        stableFrames = 0
      } else {
        stableFrames++
      }
      // 连续 5 帧高度不变即收敛；再加总帧数上限兜底，避免持续变化时空转
      if (stableFrames < 5 && ++totalFrames < 180) raf = requestAnimationFrame(pin)
    }
    raf = requestAnimationFrame(pin)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [visible.length, chat.liveMessages])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const submit = () => {
    const t = draft.trim()
    if (!t || chat.status === 'thinking') return
    setDraft('')
    void chat.send(t)
    atBottomRef.current = true
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  if (loadErr) return <div className="empty">加载失败：{loadErr}</div>
  if (!detail) return <div className="empty"><span className="spin" /></div>

  const s = detail.summary
  const busy = chat.status === 'thinking' || chat.status === 'starting'
  const isNew = s.messageCount === 0 && historyMessages.length === 0

  const items = virtualizer.getVirtualItems()

  return (
    <>
      <div className="pane-head">
        <div className="head-title">
          {editingTitle ? (
            <TitleEditor
              className="head"
              initial={s.titleSource === 'custom' ? s.title : ''}
              onSubmit={(t) => {
                setEditingTitle(false)
                api.rename(sessionId, t)
                  .then(() => { reload(); onRenamed?.() })
                  .catch((e) => setLoadErr((e as Error).message))
              }}
              onCancel={() => setEditingTitle(false)}
            />
          ) : (
            <h2
              className={s.live || !s.capabilities.rename ? undefined : 'editable'}
              title={
                s.live ? '运行中的会话不能改名'
                  : !s.capabilities.rename ? `${s.providerName} 暂不支持改名`
                  : '点击重命名'
              }
              onClick={() => { if (!s.live && s.capabilities.rename) setEditingTitle(true) }}
            >
              {s.title}
            </h2>
          )}
          {/* 路径放在固定表头里 —— 正文区滚动后元信息行就看不见了 */}
          <button
            className="head-path"
            title={`${s.cwd}\n（点击复制）`}
            onClick={() => {
              void navigator.clipboard?.writeText(s.cwd).then(
                () => setCopied(true),
                () => { /* 无剪贴板权限时静默 */ },
              )
              setTimeout(() => setCopied(false), 1400)
            }}
          >
            {copied ? '✓ 已复制' : shortPath(s.cwd, 60)}
            {s.gitBranch ? <span className="br"> ⎇ {s.gitBranch}</span> : null}
          </button>
        </div>
        <div className="toolbar">
          <span className="badge">{s.providerName}</span>
          {s.live && <span className="badge live">终端占用中</span>}
          {useVirtual && <span className="badge">虚拟滚动 {visible.length} 条</span>}
          <button className="icon-btn" onClick={() => setShowMeta(!showMeta)}>
            {showMeta ? '隐藏系统消息' : '显示系统消息'}
          </button>
          <a className="icon-btn" href={api.exportUrl(sessionId)} download>导出 MD</a>
        </div>
      </div>

      <div className="pane-body" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript">
          <div className="mono-dim" style={{ marginBottom: 16 }}>
            {s.createdAt ? `${fmtTime(s.createdAt)} 创建 · ` : ''}
            {s.messageCount} 条 · {fmtCost(s.costUsd)}
            {s.model ? ` · ${s.model}` : ''}
            <br />
            <span style={{ opacity: 0.7 }}>{sessionId}</span>
          </div>

          <BranchPanel
            branches={detail.branches}
            chosen={chosen}
            onChoose={(forkAt, head) => setChosen((c) => ({ ...c, [forkAt]: head }))}
            onCompare={(forkAt, a, b) => {
              const info = detail.branches.find((x) => x.forkAt === forkAt)
              if (!info) return
              setCompare({ a, b, labelA: branchLabel(info, a), labelB: branchLabel(info, b) })
            }}
          />

          {isNew && (
            <div className="empty" style={{ height: 'auto', padding: '32px 0' }}>
              新会话已就绪 · 工作目录 {s.cwd.replace(/^\/Users\/[^/]+/, '~')}
              <br />
              <span className="mono-dim">发出第一条消息后，CLI 才会真正创建会话文件</span>
            </div>
          )}

          {useVirtual ? (
            // 虚拟滚动：外层撑出总高度，内层用 transform 定位可见项
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((v) => (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <MessageView msg={visible[v.index]} />
                </div>
              ))}
            </div>
          ) : (
            visible.map((m) => <MessageView key={m.uuid} msg={m} />)
          )}

          {busy && (
            <div className="msg">
              <div className="msg-role"><span className="spin" /> <span>Claude 正在处理…</span></div>
            </div>
          )}
        </div>
      </div>

      {!s.capabilities.resume ? (
        <div className="composer">
          <div className="resume-hint">
            <div>
              <strong>{s.providerName}</strong> 的会话只能在终端里继续 ——
              Web 内续聊需要接管该 CLI 的权限审批协议，目前只有 Claude Code 实现并验证过。
            </div>
            {s.resumeCommand && (
              <button
                className="resume-cmd"
                title="点击复制"
                onClick={() => {
                  void navigator.clipboard?.writeText(s.resumeCommand).then(
                    () => setCopiedCmd(true),
                    () => { /* 无剪贴板权限时静默 */ },
                  )
                  setTimeout(() => setCopiedCmd(false), 1400)
                }}
              >
                {copiedCmd ? '✓ 已复制' : `$ ${s.resumeCommand}`}
              </button>
            )}
            <div className="mono-dim">工作目录：{s.cwd}</div>
          </div>
        </div>
      ) : (
      <div className="composer">
        {chat.error && (
          <div className="notice" onClick={chat.clearError} style={{ cursor: 'pointer' }}>
            {chat.error}　（点击关闭）
          </div>
        )}
        {s.live && (
          <div className="notice">
            该会话正在终端里运行。CLI 不允许 resume 一个活跃会话，请先在终端结束它再从这里续聊。
          </div>
        )}
        <div className="composer-inner">
          <textarea
            ref={taRef}
            value={draft}
            rows={1}
            placeholder={s.live ? '该会话被终端占用，暂时无法发送' : isNew ? '说第一句话，开始这个会话…（⌘↵ 发送）' : '接着这个会话继续说…（⌘↵ 发送）'}
            disabled={s.live}
            onChange={(e) => {
              setDraft(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-bar">
            <span>
              {chat.status === 'thinking' ? '生成中' : chat.status === 'closed' ? '进程已退出（发送会自动重启）' : '就绪'}
            </span>
            {chat.lastResult && (
              <span>
                上轮 {fmtCost(chat.lastResult.costUsd)} · {(chat.lastResult.durationMs / 1000).toFixed(1)}s
              </span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {busy && <button className="btn ghost" onClick={() => void chat.interrupt()}>中断</button>}
              <button className="btn" disabled={!draft.trim() || busy || s.live} onClick={submit}>发送</button>
            </span>
          </div>
        </div>
      </div>

      )}

      {chat.approvals.length > 0 && (
        <ApprovalDialog
          request={chat.approvals[0]}
          total={chat.approvals.length}
          onDecide={(allow) => void chat.decide(chat.approvals[0].id, allow)}
        />
      )}

      {compare && (
        <BranchDiff
          sessionId={sessionId}
          a={compare.a}
          b={compare.b}
          labelA={compare.labelA}
          labelB={compare.labelB}
          onClose={() => setCompare(null)}
        />
      )}
    </>
  )
}
