import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, ChatEvent, ViewMessage } from '../shared/types.js'
import { api } from './api.js'

export type ChatState = {
  /** 本轮新产生的消息，追加在历史之后 */
  liveMessages: ViewMessage[]
  status: 'idle' | 'starting' | 'thinking' | 'closed'
  approvals: ApprovalRequest[]
  lastResult: { costUsd: number; durationMs: number; numTurns: number } | null
  error: string | null
  /** CLI 另开了会话时的新 id，需要跳转 */
  forkedTo: string | null
}

const EMPTY: ChatState = {
  liveMessages: [], status: 'idle', approvals: [], lastResult: null, error: null, forkedTo: null,
}

export function useChat(sessionId: string | null) {
  const [state, setState] = useState<ChatState>(EMPTY)
  const esRef = useRef<EventSource | null>(null)
  /** 流式增量按 uuid 累积，避免每个 token 触发整列表重排 */
  const deltaRef = useRef(new Map<string, string>())

  useEffect(() => {
    setState(EMPTY)
    deltaRef.current.clear()
    esRef.current?.close()
    if (!sessionId) return

    const es = new EventSource(`/api/chat/${sessionId}/stream`)
    esRef.current = es

    es.onmessage = (e) => {
      // 服务端会夹带 {"type":"ping"} 心跳，不在 ChatEvent 联合里，先单独滤掉
      let parsed: ChatEvent | { type: 'ping' }
      try { parsed = JSON.parse(e.data) as ChatEvent | { type: 'ping' } } catch { return }
      if (parsed.type === 'ping') return
      const ev: ChatEvent = parsed

      setState((s) => {
        switch (ev.type) {
          case 'status':
            return { ...s, status: ev.state === 'ready' ? 'thinking' : ev.state === 'closed' ? 'closed' : ev.state }
          case 'message': {
            // tool_result 以 tr-<id> 形式单独到达，回填到对应的 tool 块上
            const m = ev.message
            const first = m.blocks[0]
            if (m.uuid.startsWith('tr-') && first?.kind === 'tool' && first.result) {
              const toolId = first.id
              const next = s.liveMessages.map((lm) => ({
                ...lm,
                blocks: lm.blocks.map((b) =>
                  b.kind === 'tool' && b.id === toolId ? { ...b, result: first.result } : b),
              }))
              return { ...s, liveMessages: next }
            }
            // 同 uuid 重复到达（partial 收尾）时替换而非追加
            const idx = s.liveMessages.findIndex((x) => x.uuid === m.uuid)
            const next = idx >= 0
              ? s.liveMessages.map((x, i) => (i === idx ? m : x))
              : [...s.liveMessages, m]
            return { ...s, liveMessages: next }
          }
          case 'delta': {
            // 流式增量：先落到占位气泡，完整消息到达后会被上面的分支替换
            const key = ev.uuid
            const acc = (deltaRef.current.get(key) ?? '') + ev.text
            deltaRef.current.set(key, acc)
            const holder = `streaming-${key}`
            const idx = s.liveMessages.findIndex((x) => x.uuid === holder)
            const msg: ViewMessage = {
              uuid: holder,
              parentUuid: null,
              role: 'assistant',
              ts: new Date().toISOString(),
              blocks: [{ kind: ev.blockKind === 'thinking' ? 'thinking' : 'text', text: acc }],
              pending: true,
            }
            return {
              ...s,
              liveMessages: idx >= 0
                ? s.liveMessages.map((x, i) => (i === idx ? msg : x))
                : [...s.liveMessages, msg],
            }
          }
          case 'approval':
            return { ...s, approvals: [...s.approvals, ev.request] }
          case 'approval_resolved':
            return { ...s, approvals: s.approvals.filter((a) => a.id !== ev.id) }
          case 'result':
            // 本轮结束，清掉流式占位气泡（正式消息已经在列表里）
            deltaRef.current.clear()
            return {
              ...s,
              status: 'idle',
              liveMessages: s.liveMessages.filter((m) => !m.pending),
              lastResult: { costUsd: ev.costUsd, durationMs: ev.durationMs, numTurns: ev.numTurns },
            }
          case 'error':
            return { ...s, error: ev.message, status: 'idle' }
          case 'session_forked':
            return { ...s, forkedTo: ev.to }
          default:
            return s
        }
      })
    }

    es.onerror = () => {
      // EventSource 会自动重连，这里不做处理，只在彻底关闭时提示
      if (es.readyState === EventSource.CLOSED) {
        setState((s) => ({ ...s, status: 'closed' }))
      }
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [sessionId])

  const send = useCallback(async (text: string) => {
    if (!sessionId) return
    // 乐观插入用户气泡，等 CLI 落盘后会被真实记录替换
    setState((s) => ({
      ...s,
      status: 'thinking',
      error: null,
      liveMessages: [...s.liveMessages, {
        uuid: `local-${Date.now()}`,
        parentUuid: null,
        role: 'user',
        ts: new Date().toISOString(),
        blocks: [{ kind: 'text', text }],
        pending: true,
      }],
    }))
    try {
      await api.send(sessionId, text)
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message, status: 'idle' }))
    }
  }, [sessionId])

  const decide = useCallback(async (approvalId: string, allow: boolean, denyMessage = '用户拒绝了此操作') => {
    if (!sessionId) return
    // 先本地关掉弹窗，服务端确认后会再推 approval_resolved
    setState((s) => ({ ...s, approvals: s.approvals.filter((a) => a.id !== approvalId) }))
    try {
      await api.approve(sessionId, approvalId, allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: denyMessage })
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message }))
    }
  }, [sessionId])

  const interrupt = useCallback(async () => {
    if (!sessionId) return
    try { await api.interrupt(sessionId) } catch { /* 进程可能已退出 */ }
  }, [sessionId])

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), [])

  return { ...state, send, decide, interrupt, clearError }
}
