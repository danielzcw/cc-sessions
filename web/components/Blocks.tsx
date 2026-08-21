import { memo, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ToolResult, ViewBlock, ViewMessage } from '../../shared/types.js'
import { collapseContext, diffLines, diffStats } from '../../shared/diff.js'

marked.setOptions({ gfm: true, breaks: true })

/**
 * 会话正文里混着抓取到的网页、读入的文件内容、粘贴的文本 —— 都是不可信输入。
 * 而本应用暴露了 /api/chat/:id/approve，一旦 XSS 就能自动批准工具执行，
 * 等于把 XSS 升级成任意代码执行。所以 markdown 渲染必须过一遍 sanitizer。
 */
function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'span',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
    // 禁止 javascript:/data: 等协议
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|file):/i,
    ADD_ATTR: ['target', 'rel'],
  })
}

function Prose({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
}

function Fold({
  kind, name, hint, error, defaultOpen = false, children,
}: {
  kind: 'thinking' | 'tool' | 'meta'
  name: string
  hint?: string
  error?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`fold ${kind}${error ? ' err' : ''}`}>
      <button className="fold-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="name">{name}</span>
        {hint && !open && <span className="hint">{hint}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

/** 工具入参里最能说明「这一步在干什么」的那个字段 */
function toolHint(input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const v =
    pick('command') ?? pick('file_path') ?? pick('pattern') ?? pick('path') ??
    pick('prompt') ?? pick('url') ?? pick('query') ?? pick('description') ??
    // 通用 provider 把非对象入参统一收进 input（如 codex 的 exec 是一段脚本字符串）
    pick('input')
  if (v) return v.replace(/\s+/g, ' ').slice(0, 120)
  const keys = Object.keys(input)
  return keys.length ? `${keys.length} 个参数` : ''
}

export function DiffView({
  oldText, newText, context = 3, label,
}: {
  oldText: string
  newText: string
  context?: number
  label?: string
}) {
  const { hunks, stats } = useMemo(() => {
    const lines = diffLines(oldText, newText)
    return { hunks: collapseContext(lines, context), stats: diffStats(lines) }
  }, [oldText, newText, context])

  return (
    <>
      <div className="mono-dim" style={{ marginBottom: 6 }}>
        {label ? `${label} · ` : ''}
        <span style={{ color: 'var(--diff-add-fg)' }}>+{stats.added}</span>{' '}
        <span style={{ color: 'var(--danger)' }}>−{stats.removed}</span>
      </div>
      <div className="diff">
        {hunks.map((h, hi) => (
          <div key={hi}>
            {h.skipped > 0 && <div className="skip">⋯ 省略 {h.skipped} 行未改动 ⋯</div>}
            {h.lines.map((l, i) => (
              <div key={i} className={l.op}>
                <span className="ln">{l.oldNo ?? ''}</span>
                <span className="ln">{l.newNo ?? ''}</span>
                <span className="sign">{l.op === 'del' ? '-' : l.op === 'add' ? '+' : ' '}</span>
                <span className="txt">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        ))}
        {hunks.length === 0 && <div className="skip">（无差异）</div>}
      </div>
    </>
  )
}

function Diff({ patch }: { patch: NonNullable<ToolResult['patch']> }) {
  return (
    <DiffView
      oldText={patch.oldText ?? ''}
      newText={patch.newText ?? ''}
      label={patch.filePath}
    />
  )
}

function ToolBlock({ block }: { block: Extract<ViewBlock, { kind: 'tool' }> }) {
  const r = block.result
  const hint = toolHint(block.input)
  return (
    <Fold
      kind="tool"
      name={`🔧 ${block.name}`}
      hint={hint}
      error={r?.isError}
    >
      <div className="mono-dim" style={{ marginBottom: 4 }}>入参</div>
      <pre>{JSON.stringify(block.input, null, 2)}</pre>
      {r?.patch && (
        <>
          <div className="mono-dim" style={{ margin: '10px 0 4px' }}>改动</div>
          <Diff patch={r.patch} />
        </>
      )}
      {r && (
        <>
          <div className="mono-dim" style={{ margin: '10px 0 4px' }}>
            {r.isError ? '错误输出' : '输出'}
          </div>
          <pre>{r.text.length > 20000 ? r.text.slice(0, 20000) + '\n…（已截断）' : r.text || '(空)'}</pre>
        </>
      )}
      {!r && <div className="mono-dim" style={{ marginTop: 8 }}>（无返回记录）</div>}
    </Fold>
  )
}

function BlockView({ block }: { block: ViewBlock }) {
  switch (block.kind) {
    case 'text':
      return <Prose text={block.text} />
    case 'thinking':
      return (
        <Fold kind="thinking" name="💭 thinking" hint={block.text.replace(/\s+/g, ' ').slice(0, 100)}>
          <div className="thinking-text">{block.text}</div>
        </Fold>
      )
    case 'tool':
      return <ToolBlock block={block} />
    case 'image':
      return <div className="mono-dim">🖼 {block.alt}</div>
  }
}

// 标签不能写死某个 CLI 的名字：同一个界面里会同时出现 claude / codex / omp 的会话
const ROLE_LABEL: Record<string, string> = {
  user: '👤 你',
  assistant: '🤖 助手',
  system: '⚙️ 系统',
}

export const MessageView = memo(function MessageView({ msg }: { msg: ViewMessage }) {
  // 系统注入默认整条折叠，避免 hook / skill 噪音刷屏
  if (msg.meta) {
    const text = msg.blocks.map((b) => ('text' in b ? b.text : b.kind === 'tool' ? b.name : '')).join('\n')
    const firstLine = text.split('\n').find((l) => l.replace(/[*#\s]/g, '')) ?? '系统注入'
    return (
      <div className="msg msg-meta">
        <Fold kind="meta" name="⚙️ 系统" hint={firstLine.replace(/\*\*/g, '').slice(0, 100)}>
          {msg.blocks.map((b, i) => <BlockView key={i} block={b} />)}
        </Fold>
      </div>
    )
  }

  const isUser = msg.role === 'user'
  return (
    <div className={`msg msg-${msg.role}`}>
      <div className="msg-role">
        <span>{ROLE_LABEL[msg.role] ?? msg.role}</span>
        {msg.branch ? <span className="badge branch">分支 {msg.branch}</span> : null}
        {msg.pending ? <span className="spin" /> : null}
        {msg.model ? <span className="mono-dim">{msg.model.replace('claude-', '')}</span> : null}
      </div>
      <div className={isUser ? 'bubble' : undefined}>
        {msg.blocks.map((b, i) => <BlockView key={i} block={b} />)}
      </div>
    </div>
  )
})
