import path from 'node:path'
import type { Cond, EmitRule, FieldPath, ProviderConfig } from '../../shared/provider.js'
import type { ViewBlock, ViewMessage } from '../../shared/types.js'
import type { ParsedSession } from '../parser.js'

/**
 * 规则驱动的 jsonl 解析器。内置的 codex / omp 与用户在页面上自定义的 CLI 都走这里，
 * 只有 claude-code 用专用解析器。
 */

/** 按路径取值。点号分隔；`[]` 展开数组，其后的路径应用到每个元素。 */
function getRaw(obj: unknown, seg: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined
  // Reflect.get 而不是断言成 Record：不凭空声明形状，取不到自然是 undefined
  return Reflect.get(obj, seg)
}

function getValue(obj: unknown, fieldPath: FieldPath): unknown {
  if (!fieldPath) return undefined
  const bracket = fieldPath.indexOf('[]')
  if (bracket >= 0) {
    const head = fieldPath.slice(0, bracket)
    const tail = fieldPath.slice(bracket + 2).replace(/^\./, '')
    const arr = head ? getValue(obj, head) : obj
    if (!Array.isArray(arr)) return undefined
    return arr.map((el) => (tail ? getValue(el, tail) : el))
  }
  let cur: unknown = obj
  for (const seg of fieldPath.split('.')) {
    cur = getRaw(cur, seg)
    if (cur === undefined) return undefined
  }
  return cur
}

/** 取文本。**只认字符串**（以及字符串数组）—— 见下方说明 */
function getText(obj: unknown, fieldPath?: FieldPath): string {
  if (!fieldPath) return ''
  return textualize(getValue(obj, fieldPath))
}

/**
 * 文本化时刻意只接受字符串：对象/数组一律视为「取不到文本」。
 *
 * 否则回落路径会过于贪心 —— omp 的 user 消息 content 是字符串、assistant 是
 * 对象数组，若把数组 JSON 化当正文，气泡里就会出现
 * `{"type":"thinking","thinking":"",...}` 这种原始结构（实测踩过）。
 */
function textualize(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return v.filter((el) => typeof el === 'string' && el.trim()).join('\n')
  }
  return ''
}

/** 结构化值转字符串，用于工具入参等需要保留结构的场景 */
function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(stringify).filter(Boolean).join('\n')
  return JSON.stringify(v, null, 2)
}

function firstText(obj: unknown, paths?: FieldPath[]): string {
  if (!paths) return ''
  for (const p of paths) {
    const s = getText(obj, p)
    if (s && s.trim()) return s
  }
  return ''
}

function condOk(rec: unknown, c: Cond): boolean {
  const v = getValue(rec, c.path)
  if (c.in) return typeof v === 'string' || typeof v === 'number' ? c.in.includes(v) : false
  if (c.equals !== undefined) return v === c.equals
  return v != null
}

function allOk(rec: unknown, conds?: Cond[]): boolean {
  if (!conds || conds.length === 0) return true
  return conds.every((c) => condOk(rec, c))
}

function resolveRole(rec: unknown, rule: EmitRule): { role: ViewMessage['role']; raw: string } {
  if (rule.role) return { role: rule.role, raw: rule.role }
  const raw = rule.rolePath ? getText(rec, rule.rolePath) : ''
  const mapped = rule.roleMap?.[raw]
  if (mapped) return { role: mapped, raw }
  if (raw === 'user' || raw === 'assistant' || raw === 'system') return { role: raw, raw }
  // 未知角色按系统处理，避免污染主对话
  return { role: 'system', raw }
}

function toInputRecord(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // 数组先滤掉空洞：`content[].arguments` 在非 toolCall 的元素上取到的是 undefined，
  // 不滤就会得到 [undefined] 这种「非空但无内容」的值，凭空造出空工具块
  const v = Array.isArray(raw) ? raw.filter((el) => el != null) : raw
  if (Array.isArray(v)) {
    if (v.length === 0) return out
    if (v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
      for (const [k, val] of Object.entries(v[0])) out[k] = val
      return out
    }
    out.input = stringify(v)
    return out
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) out[k] = val
  } else if (typeof v === 'string' && v) {
    out.input = v
  } else if (v != null) {
    out.input = stringify(v)
  }
  return out
}

/** 从文件名取会话 id */
export function sessionIdFromFile(cfg: ProviderConfig, filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl$/, '')
  const re = cfg.sessionId?.filenameRegex
  if (re) {
    try {
      const m = new RegExp(re).exec(base)
      if (m && m[1]) return m[1]
    } catch {
      // 用户写错正则不该让整个扫描崩掉，退回完整文件名
    }
  }
  return base
}

export function foldGeneric(
  records: unknown[],
  sessionId: string,
  cfg: ProviderConfig,
): ParsedSession {
  let cwd: string | null = null
  let title: string | null = null
  let firstTs: string | null = null
  let lastTs: string | null = null
  let firstPrompt = ''

  const messages: ViewMessage[] = []
  let seq = 0

  for (const rec of records) {
    if (cfg.cwd && !cwd) {
      const c = firstText(rec, cfg.cwd.paths)
      if (c) cwd = c.trim()
    }
    if (cfg.title && !title) {
      const t = firstText(rec, cfg.title.paths)
      if (t) title = t.trim()
    }
    const ts = firstText(rec, cfg.timestamp?.paths ?? ['timestamp'])
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }

    // 子 agent 的内部往来不进主线
    if (cfg.sidechain && allOk(rec, cfg.sidechain)) continue

    // 累积所有命中规则的产出：一条记录可能同时含 text / thinking / toolCall
    const blocks: ViewBlock[] = []
    let role: ViewMessage['role'] | null = null
    let rawRole = ''
    let isMeta = false

    for (const rule of cfg.rules) {
      if (!allOk(rec, rule.when)) continue

      let produced: ViewBlock | null = null
      if (rule.emit === 'text' || rule.emit === 'thinking') {
        const text = firstText(rec, rule.textPaths)
        if (text.trim()) {
          produced = { kind: rule.emit === 'thinking' ? 'thinking' : 'text', text }
        }
      } else if (rule.emit === 'tool') {
        const name = getText(rec, rule.toolNamePath).trim()
        const input = toInputRecord(rule.toolInputPath ? getValue(rec, rule.toolInputPath) : undefined)
        // 必须有真实工具名才产出：omp 的 tool 规则会命中每条 message 记录，
        // 只靠 input 判空会给纯文本消息凭空挂上一个空工具块
        if (name) {
          produced = { kind: 'tool', id: `${sessionId}-t${seq}-${blocks.length}`, name, input }
        }
      } else if (rule.emit === 'toolResult') {
        const text = firstText(rec, rule.textPaths)
        if (text.trim()) {
          // 通用解析器不做 tool_use/result 配对（各 CLI 关联字段差异太大），
          // 单独成块并默认折叠：信息不丢，也不打断主线阅读
          produced = {
            kind: 'tool',
            id: `${sessionId}-r${seq}-${blocks.length}`,
            name: getText(rec, rule.toolNamePath) || '工具输出',
            input: {},
            result: { isError: false, text },
          }
        }
      }
      if (!produced) continue

      blocks.push(produced)
      if (!role) {
        const r = resolveRole(rec, rule)
        role = r.role
        rawRole = r.raw
      }
      if (rule.meta || (rule.metaWhenRole?.includes(rawRole) ?? false)) isMeta = true
    }

    if (blocks.length === 0 || !role) continue

    const id = cfg.messageId ? getText(rec, cfg.messageId.path) : ''
    const parent = cfg.parentId ? getText(rec, cfg.parentId.path) : ''

    messages.push({
      uuid: id || `${sessionId}-m${seq}`,
      parentUuid: parent || null,
      role,
      ts: ts || null,
      blocks,
      meta: isMeta,
    })

    if (!firstPrompt && role === 'user' && !isMeta) {
      const t = blocks.map((b) => (b.kind === 'text' ? b.text : '')).filter(Boolean).join(' ')
      // 跳过被当成用户消息注入的系统上下文（codex 会把 <recommended_plugins> 之类塞进 user）
      if (t && !t.trimStart().startsWith('<')) firstPrompt = t.replace(/\s+/g, ' ').slice(0, 200)
    }
    seq++
  }

  return {
    sessionId,
    cwd,
    gitBranch: null,
    version: null,
    model: null,
    aiTitle: title,
    customTitle: null,
    leafUuid: null,
    firstPrompt,
    firstTs,
    lastTs,
    messages,
    // 通用解析器不做分支检测：各 CLI 是否有 rewind 语义无法一概而论
    branches: [],
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, costUsd: 0,
    },
    visibleCount: messages.filter((m) => !m.meta).length,
  }
}
