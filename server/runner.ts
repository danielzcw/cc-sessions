import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ApprovalDecision, ApprovalRequest, ChatEvent, ContentBlock, ViewBlock, ViewMessage } from '../shared/types.js'
import { registerOwnedPid, reindexSession, unregisterOwnedPid } from './scanner.js'
import { resolveClaudeBin } from './preflight.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APPROVER = path.join(HERE, 'mcp-approver.mjs')

export type RunnerOptions = {
  serverOrigin: string
  token: string
  /** 空闲多久回收子进程 */
  idleMs?: number
}

type Pending = {
  request: ApprovalRequest
  resolve: (d: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

type Listener = (ev: ChatEvent) => void

/**
 * 一个 ChatSession 对应一个长驻的 `claude -p --input-format stream-json` 子进程。
 *
 * 实测依据：
 *  - 单进程可连续处理多轮（stdin 保持打开，每轮产出一个 result 事件），上下文正确延续
 *  - 不加 --fork-session 时 session_id 保持不变，直接追加写回原 jsonl
 *  - prompt 绝不能作为位置参数传：--tools/--allowedTools 等是可变参数会把它吞掉，
 *    所以这里统一走 stdin 的 stream-json 输入
 */
class ChatSession {
  readonly sessionId: string
  readonly cwd: string
  /** 全新会话：磁盘上还没有 jsonl，第一轮必须用 --session-id 而不是 --resume */
  private draft: boolean
  private child: ChildProcessWithoutNullStreams | null = null
  private listeners = new Set<Listener>()
  private pending = new Map<string, Pending>()
  private idleTimer: NodeJS.Timeout | null = null
  private busy = false
  private queue: string[] = []
  private opts: RunnerOptions
  /** 当前轮次里 assistant 各消息的累积，用于把 stream 事件折叠成气泡 */
  private closed = false

  constructor(sessionId: string, cwd: string, opts: RunnerOptions, draft = false) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.opts = opts
    this.draft = draft
  }

  get isDraft(): boolean {
    return this.draft
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(ev: ChatEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev) } catch { /* 单个订阅者出错不影响其他人 */ }
    }
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0
  }

  get isBusy(): boolean {
    return this.busy
  }

  get pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  /** 由 HTTP 层调用：MCP 审批器请求人工决定 */
  requestApproval(req: Omit<ApprovalRequest, 'id' | 'createdAt'>, timeoutMs: number): Promise<ApprovalDecision> {
    const id = randomUUID()
    const request: ApprovalRequest = { ...req, id, createdAt: Date.now() }
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.emit({ type: 'approval_resolved', id, decision: 'deny' })
        resolve({ behavior: 'deny', message: '审批超时，已自动拒绝' })
      }, timeoutMs)
      this.pending.set(id, { request, resolve, timer })
      this.emit({ type: 'approval', request })
    })
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(decision)
    this.emit({ type: 'approval_resolved', id, decision: decision.behavior })
    return true
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child

    const mcpConfig = JSON.stringify({
      mcpServers: {
        ccsperm: {
          command: process.execPath,
          args: [APPROVER],
          env: {
            CCS_SERVER: this.opts.serverOrigin,
            CCS_TOKEN: this.opts.token,
            CCS_SESSION_ID: this.sessionId,
          },
        },
      },
    })

    const args = [
      '-p',
      // 新会话用 --session-id 预定 id；已有会话用 --resume 续写同一个文件
      ...(this.draft ? ['--session-id', this.sessionId] : ['--resume', this.sessionId]),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--mcp-config', mcpConfig,
      // 隐藏 flag，把权限判定交给我们自己的 MCP 工具
      '--permission-prompt-tool', 'mcp__ccsperm__approve',
    ]

    // 不能裸写 'claude'：macOS 上装法多样（原生安装器/homebrew/npm 全局），
    // 从非登录 shell 或 GUI 启动时 PATH 里未必有
    const bin = resolveClaudeBin() ?? 'claude'
    const child = spawn(bin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.child = child
    this.closed = false
    // 登记自己的子进程：它写的 pid 文件不该让本会话显示成「被终端占用」
    if (child.pid) registerOwnedPid(child.pid)
    this.emit({ type: 'status', state: 'starting', sessionId: this.sessionId })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => this.onLine(line))

    let stderrBuf = ''
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000)
    })

    child.on('close', (code) => {
      if (child.pid) unregisterOwnedPid(child.pid)
      this.child = null
      this.busy = false
      this.closed = true
      // 拒绝掉所有悬空审批，否则 MCP 那侧会一直等
      for (const [id] of this.pending) {
        this.resolveApproval(id, { behavior: 'deny', message: '会话进程已退出' })
      }
      if (code !== 0 && stderrBuf.trim()) {
        this.emit({ type: 'error', message: stderrBuf.trim().slice(0, 1200) })
      }
      this.emit({ type: 'status', state: 'closed', sessionId: this.sessionId })
    })

    child.on('error', (err) => {
      this.emit({ type: 'error', message: `启动 claude 失败：${err.message}` })
    })

    return child
  }

  /** 当前轮次里按 message id 累积的 partial 文本 */
  private partials = new Map<string, { uuid: string; text: string; thinking: string }>()

  private onLine(line: string): void {
    if (!line.trim()) return
    let ev: Record<string, unknown>
    try { ev = JSON.parse(line) as Record<string, unknown> } catch { return }

    const type = String(ev.type ?? '')

    // 流式增量：把 token 逐个推给前端
    if (type === 'stream_event') {
      const e = ev.event as Record<string, unknown> | undefined
      if (!e) return
      const et = String(e.type ?? '')
      const msgId = String((ev.parent_tool_use_id as string) ?? (ev.uuid as string) ?? 'cur')
      if (et === 'content_block_delta') {
        const delta = e.delta as Record<string, unknown> | undefined
        if (!delta) return
        const slot = this.partials.get(msgId) ?? { uuid: msgId, text: '', thinking: '' }
        if (typeof delta.text === 'string') {
          slot.text += delta.text
          this.emit({ type: 'delta', uuid: msgId, text: delta.text, blockKind: 'text' })
        } else if (typeof delta.thinking === 'string') {
          slot.thinking += delta.thinking
          this.emit({ type: 'delta', uuid: msgId, text: delta.thinking, blockKind: 'thinking' })
        }
        this.partials.set(msgId, slot)
      }
      return
    }

    if (type === 'system') {
      const sub = String(ev.subtype ?? '')
      if (sub === 'init') {
        this.emit({ type: 'status', state: 'ready', sessionId: String(ev.session_id ?? this.sessionId) })
        // 不加 --fork-session 时 id 应当不变；变了说明 CLI 另开了会话，必须告知前端改指向
        const sid = String(ev.session_id ?? '')
        if (sid && sid !== this.sessionId) {
          this.emit({ type: 'session_forked', from: this.sessionId, to: sid })
        }
      } else if (sub === 'permission_denied') {
        this.emit({
          type: 'message',
          message: {
            uuid: String(ev.uuid ?? randomUUID()),
            parentUuid: null,
            role: 'system',
            ts: new Date().toISOString(),
            blocks: [{ kind: 'text', text: `**权限被拒绝**\n\n${String(ev.message ?? '')}` }],
            error: true,
          },
        })
      }
      return
    }

    if (type === 'assistant' || type === 'user') {
      const message = ev.message as { role?: string; content?: string | ContentBlock[]; model?: string; usage?: never } | undefined
      if (!message) return
      const raw: ContentBlock[] = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content) ? message.content : []

      // tool_result 不单独成条，交给前端按 tool_use_id 回填
      const blocks: ViewBlock[] = []
      for (const b of raw) {
        if (b.type === 'text' && typeof (b as { text: string }).text === 'string') {
          blocks.push({ kind: 'text', text: (b as { text: string }).text })
        } else if (b.type === 'thinking') {
          blocks.push({ kind: 'thinking', text: String((b as { thinking?: string }).thinking ?? '') })
        } else if (b.type === 'tool_use') {
          const tu = b as Extract<ContentBlock, { type: 'tool_use' }>
          blocks.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input ?? {} })
        } else if (b.type === 'tool_result') {
          const tr = b as Extract<ContentBlock, { type: 'tool_result' }>
          this.emit({
            type: 'message',
            message: {
              uuid: `tr-${tr.tool_use_id}`,
              parentUuid: null,
              role: 'user',
              ts: new Date().toISOString(),
              blocks: [{
                kind: 'tool',
                id: tr.tool_use_id,
                name: '__result__',
                input: {},
                result: { isError: Boolean(tr.is_error), text: toolResultText(tr.content) },
              }],
              meta: true,
            },
          })
        }
      }
      if (blocks.length === 0) return

      const m: ViewMessage = {
        uuid: String(ev.uuid ?? randomUUID()),
        parentUuid: (ev.parentUuid as string | null) ?? null,
        role: type,
        ts: String(ev.timestamp ?? new Date().toISOString()),
        blocks,
        model: message.model,
      }
      this.emit({ type: 'message', message: m })
      return
    }

    if (type === 'result') {
      this.busy = false
      this.partials.clear()
      // 首轮已落盘，后续改用 --resume
      this.draft = false
      this.emit({
        type: 'result',
        costUsd: Number(ev.total_cost_usd ?? 0),
        durationMs: Number(ev.duration_ms ?? 0),
        numTurns: Number(ev.num_turns ?? 0),
        usage: ev.usage as never,
        isError: Boolean(ev.is_error),
      })
      // 落盘后重建索引，列表/搜索/成本立刻反映这一轮
      void reindexSession(this.sessionId).catch(() => { /* 索引失败不影响聊天 */ })
      this.emit({ type: 'status', state: 'idle', sessionId: this.sessionId })
      this.armIdle()
      this.drainQueue()
      return
    }

    if (type === 'error' || type === 'rate_limit_event') {
      const msg = typeof ev.message === 'string' ? ev.message : JSON.stringify(ev).slice(0, 400)
      if (type === 'error') this.emit({ type: 'error', message: msg })
    }
  }

  send(text: string): void {
    if (this.busy) {
      this.queue.push(text)
      return
    }
    const child = this.ensureChild()
    this.busy = true
    this.clearIdle()
    this.emit({ type: 'status', state: 'thinking', sessionId: this.sessionId })
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    child.stdin.write(JSON.stringify(payload) + '\n')
  }

  private drainQueue(): void {
    const next = this.queue.shift()
    if (next !== undefined) this.send(next)
  }

  interrupt(): void {
    if (!this.child) return
    // SIGINT 让 CLI 优雅收尾并落盘，SIGKILL 会丢当前轮
    this.child.kill('SIGINT')
  }

  private armIdle(): void {
    this.clearIdle()
    const ms = this.opts.idleMs ?? 10 * 60_000
    this.idleTimer = setTimeout(() => this.dispose(), ms)
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  dispose(): void {
    this.clearIdle()
    if (this.child) {
      try { this.child.stdin.end() } catch { /* 已关闭 */ }
      this.child.kill('SIGINT')
      this.child = null
    }
    this.closed = true
  }

  /** 结束子进程并等它真正退出 —— 删除会话前必须等，否则进程还会往文件里写 */
  async disposeAndWait(timeoutMs = 4000): Promise<void> {
    const child = this.child
    this.dispose()
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        // 优雅退出超时就强杀，避免删除操作被无限拖住
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        resolve()
      }, timeoutMs)
      child.once('close', done)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c
      const o = c as Record<string, unknown>
      return o.type === 'text' ? String(o.text ?? '') : JSON.stringify(o)
    }).join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

export class RunnerRegistry {
  private sessions = new Map<string, ChatSession>()
  constructor(private opts: RunnerOptions) {}

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId)
  }

  getOrCreate(sessionId: string, cwd: string, draft = false): ChatSession {
    let s = this.sessions.get(sessionId)
    if (s && !s.isClosed) return s
    // 已存在但已关闭的会话：保留原 draft 状态，避免把已落盘会话当新会话重开
    const stillDraft = s ? s.isDraft : draft
    s = new ChatSession(sessionId, cwd, this.opts, stillDraft)
    this.sessions.set(sessionId, s)
    return s
  }

  /** 尚未入库的新建会话，供 /stream 与 /send 在 DB 查不到时兜底 */
  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

  /** 审批器只知道 sessionId，据此找回对应会话 */
  findForApproval(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** 结束并移除某个会话的子进程（删除会话前必须调用，否则进程还会继续写文件） */
  async disposeOne(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    await s.disposeAndWait()
    this.sessions.delete(sessionId)
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.sessions.clear()
  }
}

export type { ChatSession }
