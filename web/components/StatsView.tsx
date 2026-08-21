import { useEffect, useState } from 'react'
import type { StatsBucket, StatsResponse } from '../../shared/types.js'
import { api, fmtCost, fmtTokens } from '../api.js'

type Metric = 'cost' | 'tokens' | 'sessions'

function Bars({ rows, unit }: { rows: StatsBucket[]; unit: Metric }) {
  const val = (r: StatsBucket) =>
    unit === 'cost' ? r.costUsd
      : unit === 'tokens' ? r.inputTokens + r.outputTokens
      : r.sessions
  const fmt = (r: StatsBucket) =>
    unit === 'cost' ? fmtCost(r.costUsd)
      : unit === 'tokens' ? fmtTokens(val(r))
      : `${r.sessions} 会话`
  // 滤掉零值行：codex / omp 没有成本数据，不滤就会出现几十行 $0 的空条
  const shown = rows.filter((r) => val(r) > 0)
  const max = Math.max(...shown.map(val), 1)

  if (shown.length === 0) return <div className="mono-dim">（无数据）</div>
  return (
    <div className="bars">
      {shown.map((r) => (
        <div className="bar-row" key={r.key}>
          <span className="label" title={r.key}>{r.key.replace(/^\/Users\/[^/]+/, '~')}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(val(r) / max) * 100}%` }} />
          </div>
          <span className="val">{fmt(r)}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsView({ provider }: { provider: string | null }) {
  const [s, setS] = useState<StatsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setS(null)
    api.stats(provider ?? undefined).then(setS).catch((e) => setErr((e as Error).message))
  }, [provider])

  if (err) return <div className="empty">读取统计失败：{err}</div>
  if (!s) return <div className="empty"><span className="spin" /></div>

  const cacheTotal = s.byModel.reduce((a, b) => a + b.cacheReadTokens, 0)
  const inTotal = s.byModel.reduce((a, b) => a + b.inputTokens, 0)
  const outTotal = s.byModel.reduce((a, b) => a + b.outputTokens, 0)
  /**
   * 只有 Claude Code 的 jsonl 里带 usage，codex / omp 一律为 0。
   * 选中这些来源时按成本画图只会得到一片零值，改用会话数才有信息量。
   */
  const hasCost = s.totalCostUsd > 0
  const metric: Metric = hasCost ? 'cost' : 'sessions'

  return (
    <div className="pane-body">
      <div className="stats">
        <div className="stat-cards">
          {hasCost && (
            <div className="stat-card"><div className="v">{fmtCost(s.totalCostUsd)}</div><div className="k">累计成本（估算）</div></div>
          )}
          <div className="stat-card"><div className="v">{s.totalSessions}</div><div className="k">会话数</div></div>
          <div className="stat-card"><div className="v">{s.totalMessages}</div><div className="k">消息数</div></div>
          {inTotal + outTotal > 0 && (
            <div className="stat-card"><div className="v">{fmtTokens(inTotal + outTotal)}</div><div className="k">输入+输出 token</div></div>
          )}
          {cacheTotal > 0 && (
            <div className="stat-card"><div className="v">{fmtTokens(cacheTotal)}</div><div className="k">缓存命中 token</div></div>
          )}
        </div>

        <p className="mono-dim">
          {hasCost
            ? '成本按各消息 usage × 官方单价估算。历史 jsonl 里不含 cost 字段，只有本 App 内新产生的轮次才有 CLI 返回的真实 total_cost_usd。'
            : '该来源的会话记录里没有 token usage，无法估算成本，以下按会话数统计。'}
        </p>

        <h3 className="sec">按天{metric === 'cost' ? '（有花费的日子）' : ''}</h3>
        <Bars rows={s.byDay} unit={metric} />

        <h3 className="sec">按项目</h3>
        <Bars rows={s.byProject} unit={metric} />

        {hasCost && (
          <>
            <h3 className="sec">按模型</h3>
            <Bars rows={s.byModel} unit="cost" />

            <h3 className="sec">模型明细</h3>
            <div className="bars">
              {s.byModel.filter((m) => m.costUsd > 0).map((m) => (
                <div key={m.key} className="bar-row" style={{ gridTemplateColumns: '1fr auto' }}>
                  <span className="label">{m.key}</span>
                  <span className="val">
                    {m.sessions} 会话 · in {fmtTokens(m.inputTokens)} · out {fmtTokens(m.outputTokens)}
                    {' · '}cache {fmtTokens(m.cacheReadTokens)} · {fmtCost(m.costUsd)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
