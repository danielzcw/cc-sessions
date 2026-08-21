import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import type { CliHelp, HelpNode } from '../../server/cli-help.js'

const PROVIDERS: { id: string; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'omp', label: 'omp' },
]

/** 命令树 + 完整 help。内容从各 CLI 的 --help 递归抓取，不是手写的文档。 */
export function CliHelpView() {
  const [provider, setProvider] = useState('claude-code')
  const [help, setHelp] = useState<CliHelp | null>(null)
  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = (p: string) => {
    api.cliHelp(p)
      .then((r) => {
        setHelp(r.help)
        setBuilding(r.state.building && r.state.provider === p)
        setProgress(r.state.building ? { done: r.state.done, total: r.state.total } : null)
        if (r.help && !selected) setSelected(r.help.nodes[0]?.command ?? null)
      })
      .catch((e) => setErr((e as Error).message))
  }

  useEffect(() => {
    setSelected(null)
    setHelp(null)
    load(provider)
  }, [provider])

  // 构建期间轮询进度；一次完整抓取要跑几十次 --help
  useEffect(() => {
    if (!building) {
      clearInterval(poll.current ?? undefined)
      poll.current = null
      return
    }
    poll.current = setInterval(() => load(provider), 1500)
    return () => clearInterval(poll.current ?? undefined)
  }, [building, provider])

  const refresh = async () => {
    setErr(null)
    try {
      await api.refreshCliHelp(provider)
      setBuilding(true)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const nodes = help?.nodes ?? []
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return nodes
    return nodes.filter((n) =>
      n.command.toLowerCase().includes(f) ||
      n.summary.toLowerCase().includes(f) ||
      n.options.some((o) => o.flags.toLowerCase().includes(f) || o.desc.toLowerCase().includes(f)))
  }, [nodes, filter])

  const current: HelpNode | null = useMemo(
    () => nodes.find((n) => n.command === selected) ?? shown[0] ?? null,
    [nodes, shown, selected],
  )

  return (
    <>
      <div className="cfg-bar">
        <div className="seg">
          {PROVIDERS.map((p) => (
            <button key={p.id} className={provider === p.id ? 'on' : ''} onClick={() => setProvider(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <input
          className="cfg-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={nodes.length ? `筛选 ${nodes.length} 条指令…` : '筛选…'}
        />
        <button className="btn ghost tiny" onClick={() => void refresh()} disabled={building}>
          {building ? <span className="spin" /> : '重新抓取'}
        </button>
      </div>

      {err && <div className="notice">{err}</div>}

      {building && (
        <div className="notice ok">
          正在从 CLI 抓取 --help…{progress ? ` ${progress.done}/${progress.total}` : ''}
        </div>
      )}

      {!help && !building && (
        <div className="help-empty">
          还没有抓取过 <b>{PROVIDERS.find((p) => p.id === provider)?.label}</b> 的指令。
          <br />
          <span className="mono-dim">
            内容直接来自 CLI 的 --help，不是手写文档，所以升级 CLI 后重新抓取即可保持同步。
          </span>
          <br />
          <button className="btn" style={{ marginTop: 10 }} onClick={() => void refresh()}>开始抓取</button>
        </div>
      )}

      {help && (
        <>
          <div className="help-meta mono-dim">
            {help.version} · {help.bin} · 共 {nodes.length} 条 ·
            抓取于 {new Date(help.generatedAt).toLocaleString('zh-CN')}
            {help.failed.length > 0 && ` · ${help.failed.length} 条抓取失败`}
          </div>

          <div className="help-split">
            <nav className="help-tree">
              {shown.map((n) => (
                <button
                  key={n.command}
                  className={`help-item${current?.command === n.command ? ' on' : ''}`}
                  style={{ paddingLeft: 10 + n.path.length * 12 }}
                  onClick={() => setSelected(n.command)}
                  title={n.summary}
                >
                  <span className="cmd">
                    {n.path.length === 0 ? n.command : n.path[n.path.length - 1]}
                  </span>
                  {n.subcommands.length > 0 && <span className="n">{n.subcommands.length}</span>}
                </button>
              ))}
              {shown.length === 0 && <div className="cfg-empty">没有匹配指令</div>}
            </nav>

            <div className="help-detail">
              {current && (
                <>
                  <h3 className="help-cmd">{current.command}</h3>
                  {current.usage && <div className="help-usage"><code>{current.usage}</code></div>}
                  {current.summary && <p className="help-summary">{current.summary}</p>}

                  {current.subcommands.length > 0 && (
                    <>
                      <h4 className="help-sec">子命令 {current.subcommands.length}</h4>
                      <div className="help-list">
                        {current.subcommands.map((s) => {
                          const child = `${current.command} ${s.name}`
                          const exists = nodes.some((n) => n.command === child)
                          return (
                            <div className="help-kv" key={s.name}>
                              {exists
                                ? <button className="k link" onClick={() => setSelected(child)}>{s.name}</button>
                                : <span className="k">{s.name}</span>}
                              <span className="v">{s.summary}</span>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}

                  {current.options.length > 0 && (
                    <>
                      <h4 className="help-sec">选项 {current.options.length}</h4>
                      <div className="help-list">
                        {current.options.map((o, i) => (
                          <div className="help-kv" key={i}>
                            <span className="k flags">{o.flags}</span>
                            <span className="v">{o.desc}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <details className="help-raw">
                    <summary>原始 --help 输出（{current.text.split('\n').length} 行）</summary>
                    <pre>{current.text}</pre>
                  </details>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
