import { useEffect, useState } from 'react'
import type { StatsBucket, StatsResponse } from '../../shared/types.js'
import { api, fmtCost, fmtTokens } from '../api.js'

function Bars({ rows, unit }: { rows: StatsBucket[]; unit: 'cost' | 'tokens' }) {
  const val = (r: StatsBucket) => (unit === 'cost' ? r.costUsd : r.inputTokens + r.outputTokens)
  const max = Math.max(...rows.map(val), 1)
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.key}>
          <span className="label" title={r.key}>{r.key.replace(/^\/Users\/[^/]+/, '~')}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(val(r) / max) * 100}%` }} />
          </div>
          <span className="val">{unit === 'cost' ? fmtCost(r.costUsd) : fmtTokens(val(r))}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsView() {
  const [s, setS] = useState<StatsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.stats().then(setS).catch((e) => setErr((e as Error).message))
  }, [])

  if (err) return <div className="empty">读取统计失败：{err}</div>
  if (!s) return <div className="empty"><span className="spin" /></div>

  const cacheTotal = s.byModel.reduce((a, b) => a + b.cacheReadTokens, 0)
  const inTotal = s.byModel.reduce((a, b) => a + b.inputTokens, 0)
  const outTotal = s.byModel.reduce((a, b) => a + b.outputTokens, 0)

  return (
    <div className="pane-body">
      <div className="stats">
        <div className="stat-cards">
          <div className="stat-card"><div className="v">{fmtCost(s.totalCostUsd)}</div><div className="k">累计成本（估算）</div></div>
          <div className="stat-card"><div className="v">{s.totalSessions}</div><div className="k">会话数</div></div>
          <div className="stat-card"><div className="v">{s.totalMessages}</div><div className="k">消息数</div></div>
          <div className="stat-card"><div className="v">{fmtTokens(inTotal + outTotal)}</div><div className="k">输入+输出 token</div></div>
          <div className="stat-card"><div className="v">{fmtTokens(cacheTotal)}</div><div className="k">缓存命中 token</div></div>
        </div>

        <p className="mono-dim">
          成本按各消息 usage × 官方单价估算。历史 jsonl 里不含 cost 字段，
          只有本 App 内新产生的轮次才有 CLI 返回的真实 total_cost_usd。
        </p>

        <h3 className="sec">按天（近 90 天）</h3>
        <Bars rows={s.byDay} unit="cost" />

        <h3 className="sec">按项目</h3>
        <Bars rows={s.byProject} unit="cost" />

        <h3 className="sec">按模型</h3>
        <Bars rows={s.byModel} unit="cost" />

        <h3 className="sec">模型明细</h3>
        <div className="bars">
          {s.byModel.map((m) => (
            <div key={m.key} className="bar-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span className="label">{m.key}</span>
              <span className="val">
                {m.sessions} 会话 · in {fmtTokens(m.inputTokens)} · out {fmtTokens(m.outputTokens)}
                {' · '}cache {fmtTokens(m.cacheReadTokens)} · {fmtCost(m.costUsd)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
