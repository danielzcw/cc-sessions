import type {
  BranchInfo, ContentBlock, RawRecord, ToolResult, Usage, ViewBlock, ViewMessage,
} from '../shared/types.js'

/** 一个会话文件解析后的全部信息 */
export type ParsedSession = {
  sessionId: string
  cwd: string | null
  gitBranch: string | null
  version: string | null
  model: string | null
  aiTitle: string | null
  customTitle: string | null
  leafUuid: string | null
  firstPrompt: string
  firstTs: string | null
  lastTs: string | null
  messages: ViewMessage[]
  branches: BranchInfo[]
  usage: Usage & { costUsd: number }
  /** 排除 meta 后的可见消息数 */
  visibleCount: number
}

export function parseLines(lines: string[]): RawRecord[] {
  const out: RawRecord[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as RawRecord)
    } catch {
      // 会话文件可能在写入中途被读到，最后一行截断是正常的，跳过即可
    }
  }
  return out
}

function blockText(b: ContentBlock): string {
  if (b.type === 'text') return (b as { text: string }).text ?? ''
  if (b.type === 'thinking') return (b as { thinking: string }).thinking ?? ''
  return ''
}

/** tool_result 的 content 可能是 string、block 数组，或带 stdout 的对象 */
function stringifyToolResult(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        const o = c as Record<string, unknown>
        if (o.type === 'text') return String(o.text ?? '')
        if (o.type === 'image') return '[image]'
        return JSON.stringify(o)
      })
      .join('\n')
  }
  const o = content as Record<string, unknown>
  if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
    return [o.stdout, o.stderr].filter(Boolean).join('\n')
  }
  return JSON.stringify(o, null, 2)
}

/** 从 toolUseResult 里挖出 Edit/Write 的前后内容，供前端渲染 diff */
function extractPatch(toolName: string, input: Record<string, unknown>, raw: unknown): ToolResult['patch'] {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
  if (!filePath) return undefined
  if (toolName === 'Write') {
    return { filePath, newText: typeof input.content === 'string' ? input.content : undefined }
  }
  if (toolName === 'Edit') {
    const o = (raw ?? {}) as Record<string, unknown>
    return {
      filePath,
      oldText: typeof input.old_string === 'string' ? input.old_string : (typeof o.oldString === 'string' ? o.oldString : undefined),
      newText: typeof input.new_string === 'string' ? input.new_string : (typeof o.newString === 'string' ? o.newString : undefined),
    }
  }
  return undefined
}

const MODEL_PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  // 每 1M token 美元价，用于历史记录里没有 cost 字段时的兜底估算
  'claude-opus-5': { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-fable-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

function priceFor(model: string | undefined): { in: number; out: number; cacheRead: number; cacheWrite: number } {
  if (!model) return MODEL_PRICING['claude-sonnet-5']
  for (const [k, v] of Object.entries(MODEL_PRICING)) {
    if (model.includes(k.replace('claude-', '').split('-')[0])) return v
  }
  return MODEL_PRICING['claude-sonnet-5']
}

function estimateCost(usage: Usage, model?: string): number {
  // <synthetic> 是 CLI 本地合成的消息（如中断提示），没有真实 API 调用，不能计费
  if (!model || model === '<synthetic>') return 0
  const p = priceFor(model)
  const M = 1_000_000
  return (
    ((usage.input_tokens ?? 0) * p.in +
      (usage.output_tokens ?? 0) * p.out +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) / M
  )
}

/**
 * 把仅追加的事件日志折叠成气泡列表。
 * 关键处理：
 *  - isSidechain 的子 agent 消息整体剔除（否则和主线交错成一锅粥）
 *  - tool_result 回填到对应的 tool_use 块上，而不是单独成一条消息
 *  - attachment / hook 输出标记为 meta，前端默认折叠
 *  - 按 parentUuid 建树，识别 /rewind 产生的分叉
 */
export function foldSession(records: RawRecord[], sessionId: string): ParsedSession {
  let cwd: string | null = null
  let gitBranch: string | null = null
  let version: string | null = null
  let model: string | null = null
  /** model -> 输出 token 权重，用于挑出会话的代表模型 */
  const modelWeights = new Map<string, number>()
  let aiTitle: string | null = null
  let customTitle: string | null = null
  let leafUuid: string | null = null
  let firstPrompt = ''
  let firstTs: string | null = null
  let lastTs: string | null = null

  const agg: Usage & { costUsd: number } = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, costUsd: 0,
  }

  const messages: ViewMessage[] = []
  const byUuid = new Map<string, ViewMessage>()
  /** tool_use_id -> 承载它的消息与块索引，用于回填 tool_result */
  const toolSlots = new Map<string, { msg: ViewMessage; idx: number }>()

  for (const r of records) {
    // --- 元信息记录 ---
    switch (r.type) {
      case 'ai-title': aiTitle = r.aiTitle ?? aiTitle; continue
      // 空串表示清除自定义标题，回落到 AI 标题 —— 这是「恢复默认」的实现方式
      case 'custom-title': {
        const t = (r.customTitle ?? '').trim()
        customTitle = t ? t : null
        continue
      }
      case 'last-prompt': leafUuid = r.leafUuid ?? leafUuid; continue
      case 'mode':
      case 'permission-mode':
      case 'queue-operation':
      case 'file-history-snapshot':
      case 'file-history-delta':
        continue
    }

    if (r.cwd && !cwd) cwd = r.cwd
    if (r.gitBranch && !gitBranch) gitBranch = r.gitBranch
    if (r.version) version = r.version
    if (r.timestamp) {
      if (!firstTs) firstTs = r.timestamp
      lastTs = r.timestamp
    }

    // 子 agent 的内部往来不进主线
    if (r.isSidechain) continue

    // --- 系统注入：hook 输出、skill 加载、mcp 状态 ---
    if (r.type === 'attachment' || r.type === 'system') {
      const label = r.type === 'attachment'
        ? String(r.attachment?.type ?? 'attachment')
        : String(r.subtype ?? 'system')
      // permission_denied 是真实事件，值得显眼展示
      const isDenied = r.subtype === 'permission_denied'
      const text = isDenied
        ? String((r as unknown as { message?: string }).message ?? '')
        : summarizeInjection(r)
      if (!text) continue
      const m: ViewMessage = {
        uuid: r.uuid ?? `${r.type}-${messages.length}`,
        parentUuid: r.parentUuid ?? null,
        role: 'system',
        ts: r.timestamp ?? null,
        blocks: [{ kind: 'text', text: `**${label}**\n\n${text}` }],
        meta: !isDenied,
        error: isDenied,
      }
      messages.push(m)
      byUuid.set(m.uuid, m)
      continue
    }

    if (r.type !== 'user' && r.type !== 'assistant') continue
    const msg = r.message
    if (!msg) continue

    const content = msg.content
    const rawBlocks: ContentBlock[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content) ? content : []

    // 纯 tool_result 的 user 记录 —— 回填到 tool_use，不新建气泡
    const onlyToolResults =
      r.type === 'user' && rawBlocks.length > 0 && rawBlocks.every((b) => b.type === 'tool_result')
    if (onlyToolResults) {
      for (const b of rawBlocks) {
        const tr = b as Extract<ContentBlock, { type: 'tool_result' }>
        const slot = toolSlots.get(tr.tool_use_id)
        if (!slot) continue
        const blk = slot.msg.blocks[slot.idx]
        if (blk.kind !== 'tool') continue
        blk.result = {
          isError: Boolean(tr.is_error),
          text: stringifyToolResult(tr.content),
          patch: extractPatch(blk.name, blk.input, r.toolUseResult),
        }
      }
      continue
    }

    const blocks: ViewBlock[] = []
    for (const b of rawBlocks) {
      if (b.type === 'text' || b.type === 'thinking') {
        const t = blockText(b)
        if (t) blocks.push({ kind: b.type === 'thinking' ? 'thinking' : 'text', text: t })
      } else if (b.type === 'tool_use') {
        const tu = b as Extract<ContentBlock, { type: 'tool_use' }>
        blocks.push({ kind: 'tool', id: tu.id, name: tu.name, input: tu.input ?? {} })
      } else if (b.type === 'image') {
        blocks.push({ kind: 'image', alt: '粘贴的图片' })
      }
    }
    if (blocks.length === 0) continue

    // 按输出 token 累计各模型的份量，取占比最大的作为会话代表模型。
    // 不能用"最后出现的" —— 会话末尾常是 <synthetic> 之类的本地合成消息，
    // 那样整个会话的成本都会被错误归到它名下。
    if (msg.model && msg.model !== '<synthetic>') {
      const w = (msg.usage?.output_tokens ?? 0) + 1
      modelWeights.set(msg.model, (modelWeights.get(msg.model) ?? 0) + w)
    }
    if (msg.usage) {
      agg.input_tokens! += msg.usage.input_tokens ?? 0
      agg.output_tokens! += msg.usage.output_tokens ?? 0
      agg.cache_read_input_tokens! += msg.usage.cache_read_input_tokens ?? 0
      agg.cache_creation_input_tokens! += msg.usage.cache_creation_input_tokens ?? 0
      agg.costUsd += estimateCost(msg.usage, msg.model)
    }

    const m: ViewMessage = {
      uuid: r.uuid ?? `${r.type}-${messages.length}`,
      parentUuid: r.parentUuid ?? null,
      role: r.type,
      ts: r.timestamp ?? null,
      blocks,
      model: msg.model,
      usage: msg.usage,
      meta: Boolean(r.isMeta),
      error: Boolean(r.isApiErrorMessage),
    }
    messages.push(m)
    byUuid.set(m.uuid, m)

    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i]
      if (blk.kind === 'tool') toolSlots.set(blk.id, { msg: m, idx: i })
    }

    if (!firstPrompt && r.type === 'user' && !r.isMeta) {
      const t = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join(' ')
      // 跳过 slash 命令和系统提醒，取第一句真人说的话
      if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) firstPrompt = t.replace(/\s+/g, ' ').slice(0, 200)
    }
  }

  if (modelWeights.size) {
    model = [...modelWeights.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  const branches = detectBranches(messages, byUuid)
  const visibleCount = messages.filter((m) => !m.meta).length

  return {
    sessionId, cwd, gitBranch, version, model, aiTitle, customTitle, leafUuid,
    firstPrompt, firstTs, lastTs, messages, branches, usage: agg, visibleCount,
  }
}

function summarizeInjection(r: RawRecord): string {
  const a = r.attachment as Record<string, unknown> | undefined
  if (a) {
    if (typeof a.content === 'string') return a.content.slice(0, 4000)
    if (typeof a.stdout === 'string' || typeof a.stderr === 'string') {
      return [a.stdout, a.stderr].filter(Boolean).join('\n').slice(0, 4000)
    }
    if (typeof a.prompt === 'string') return a.prompt.slice(0, 2000)
    const names = [a.addedNames, a.removedNames, a.names].filter(Boolean)
    if (names.length) return names.map((n) => (Array.isArray(n) ? n.join(', ') : String(n))).join(' / ')
    return ''
  }
  if (typeof r.content === 'string') return r.content.slice(0, 4000)
  return ''
}

/** 找出同一个 parentUuid 下有多个子节点的位置 —— 那就是 /rewind 留下的分叉 */
function detectBranches(messages: ViewMessage[], byUuid: Map<string, ViewMessage>): BranchInfo[] {
  const children = new Map<string, ViewMessage[]>()
  for (const m of messages) {
    if (!m.parentUuid) continue
    const arr = children.get(m.parentUuid) ?? []
    arr.push(m)
    children.set(m.parentUuid, arr)
  }
  const out: BranchInfo[] = []
  for (const [parent, kids] of children) {
    if (kids.length < 2) continue
    out.push({
      forkAt: parent,
      choices: kids.map((k) => ({
        headUuid: k.uuid,
        preview: previewOf(k),
        ts: k.ts,
        messageCount: countDescendants(k.uuid, children),
      })),
    })
  }
  // 给每条消息标注分支序号：主干（各分叉点的最后一个子节点链）为 0
  if (out.length) {
    for (const info of out) {
      info.choices.forEach((c, i) => {
        const isMain = i === info.choices.length - 1
        markSubtree(c.headUuid, children, byUuid, isMain ? 0 : i + 1)
      })
    }
  }
  return out
}

function markSubtree(
  uuid: string,
  children: Map<string, ViewMessage[]>,
  byUuid: Map<string, ViewMessage>,
  branch: number,
): void {
  const stack = [uuid]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const m = byUuid.get(id)
    if (m && m.branch === undefined) m.branch = branch
    for (const k of children.get(id) ?? []) stack.push(k.uuid)
  }
}

function countDescendants(uuid: string, children: Map<string, ViewMessage[]>): number {
  let n = 0
  const stack = [uuid]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    n++
    for (const k of children.get(id) ?? []) stack.push(k.uuid)
  }
  return n
}

/**
 * 从某个分支头节点出发，沿 parentUuid 树往下取出整条链。
 * 链上若还有嵌套分叉，按与主干一致的约定取最后一个子节点。
 */
export function chainFrom(messages: ViewMessage[], headUuid: string): ViewMessage[] {
  const byUuid = new Map(messages.map((m) => [m.uuid, m]))
  const children = new Map<string, ViewMessage[]>()
  for (const m of messages) {
    if (!m.parentUuid) continue
    const a = children.get(m.parentUuid) ?? []
    a.push(m)
    children.set(m.parentUuid, a)
  }
  const out: ViewMessage[] = []
  let cur = byUuid.get(headUuid)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid)
    out.push(cur)
    const kids = children.get(cur.uuid) ?? []
    cur = kids.length ? kids[kids.length - 1] : undefined
  }
  return out
}

/** 把一条链拍平成可 diff 的纯文本，工具调用压成单行摘要 */
export function chainToText(chain: ViewMessage[]): string {
  const lines: string[] = []
  for (const m of chain) {
    if (m.meta) continue
    const who = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 Claude' : '⚙️ 系统'
    lines.push(`### ${who}`)
    for (const b of m.blocks) {
      if (b.kind === 'text') lines.push(...b.text.split('\n'))
      else if (b.kind === 'thinking') lines.push(`[thinking] ${b.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      else if (b.kind === 'tool') {
        const hint = ['command', 'file_path', 'pattern', 'url']
          .map((k) => (typeof b.input[k] === 'string' ? (b.input[k] as string) : null))
          .find(Boolean)
        lines.push(`[工具 ${b.name}] ${hint ? String(hint).replace(/\s+/g, ' ').slice(0, 160) : ''}`)
      } else if (b.kind === 'image') lines.push('[图片]')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function previewOf(m: ViewMessage): string {
  for (const b of m.blocks) {
    if (b.kind === 'text') return b.text.replace(/\s+/g, ' ').slice(0, 80)
    if (b.kind === 'tool') return `[${b.name}]`
  }
  return '(空)'
}

export { estimateCost }
