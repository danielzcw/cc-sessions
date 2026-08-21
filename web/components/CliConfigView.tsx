import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import type { CliConfig } from '../../server/cli-config.js'

type Section = 'mcp' | 'skills' | 'plugins'

/**
 * 各 CLI 的 MCP / 技能 / 插件。
 *
 * 只有 Claude Code 的插件可以在这里开关（settings.json 里是纯 JSON 布尔表）；
 * Codex 是 TOML、Claude 的 MCP 在 ~/.claude.json 那个活动状态文件里，手改风险高，
 * 一律只读并把路径显出来让用户自己编辑。
 */
export function CliConfigView() {
  const [clis, setClis] = useState<CliConfig[]>([])
  const [section, setSection] = useState<Section>('mcp')
  const [filter, setFilter] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    api.cliConfig()
      .then((r) => setClis(r.clis))
      .catch((e) => setMsg({ kind: 'err', text: (e as Error).message }))
  }
  useEffect(load, [])

  const togglePlugin = async (provider: string, name: string, enabled: boolean) => {
    setBusy(name)
    setMsg(null)
    try {
      await api.setPlugin(provider, name, enabled)
      setMsg({ kind: 'ok', text: `已${enabled ? '启用' : '停用'} ${name}，重启 CLI 会话后生效` })
      load()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const f = filter.trim().toLowerCase()
  const match = (s: string): boolean => !f || s.toLowerCase().includes(f)

  const counts = useMemo(() => ({
    mcp: clis.reduce((a, c) => a + c.mcp.length, 0),
    skills: clis.reduce((a, c) => a + c.skills.length, 0),
    plugins: clis.reduce((a, c) => a + c.plugins.length, 0),
  }), [clis])

  return (
    <>
      <div className="cfg-bar">
        <div className="nav-tabs" style={{ padding: 0, maxWidth: 320 }}>
          <button className={section === 'mcp' ? 'on' : ''} onClick={() => setSection('mcp')}>
            MCP <span className="mono-dim">{counts.mcp}</span>
          </button>
          <button className={section === 'skills' ? 'on' : ''} onClick={() => setSection('skills')}>
            技能 <span className="mono-dim">{counts.skills}</span>
          </button>
          <button className={section === 'plugins' ? 'on' : ''} onClick={() => setSection('plugins')}>
            插件 <span className="mono-dim">{counts.plugins}</span>
          </button>
        </div>
        <input
          className="cwd-filter"
          style={{ maxWidth: 260, marginBottom: 0 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选…"
        />
      </div>

      {msg && <div className={msg.kind === 'err' ? 'notice' : 'notice ok'}>{msg.text}</div>}

      {clis.map((c) => {
        const items = section === 'mcp' ? c.mcp.filter((x) => match(x.name) || match(x.command))
          : section === 'skills' ? c.skills.filter((x) => match(x.name) || match(x.description))
          : c.plugins.filter((x) => match(x.name))
        return (
          <div className="cfg-cli" key={c.provider}>
            <div className="cfg-cli-head">
              <b>{c.provider}</b>
              <span className="mono-dim">{items.length} 项</span>
              <span className="cfg-paths">
                {c.configPaths.map((p) => (
                  <span key={p.path} className={p.exists ? '' : 'missing'} title={p.exists ? p.path : `${p.path}（不存在）`}>
                    {p.label}: <code>{p.path}</code>
                  </span>
                ))}
              </span>
            </div>

            {items.length === 0 && <div className="cfg-empty">（无）</div>}

            {section === 'mcp' && c.mcp.filter((x) => match(x.name) || match(x.command)).map((m) => (
              <div className="cfg-row" key={m.name}>
                <div className="cfg-main">
                  <div className="cfg-name">{m.name}</div>
                  <div className="cfg-sub"><code>{m.command || '(未配 command)'}</code></div>
                  {m.envKeys.length > 0 && (
                    // 只列键名不列值：配置里常有 token
                    <div className="cfg-sub">env: {m.envKeys.join(', ')}</div>
                  )}
                </div>
                <span className="badge">只读</span>
              </div>
            ))}

            {section === 'skills' && c.skills.filter((x) => match(x.name) || match(x.description)).map((s) => (
              <div className="cfg-row" key={s.path}>
                <div className="cfg-main">
                  <div className="cfg-name">{s.name}</div>
                  {s.description && <div className="cfg-sub desc">{s.description}</div>}
                  <div className="cfg-sub"><code>{s.path}</code></div>
                </div>
              </div>
            ))}

            {section === 'plugins' && c.plugins.filter((x) => match(x.name)).map((p) => (
              <div className="cfg-row" key={p.name}>
                <div className="cfg-main">
                  <div className="cfg-name">{p.name}</div>
                  <div className="cfg-sub"><code>{p.source}</code></div>
                </div>
                {p.writable ? (
                  <label className="prov-toggle">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={busy === p.name}
                      onChange={(e) => void togglePlugin(c.provider, p.name, e.target.checked)}
                    />
                    {p.enabled ? '已启用' : '已停用'}
                  </label>
                ) : (
                  <span className={`badge${p.enabled ? ' branch' : ''}`}>
                    {p.enabled ? '已启用（只读）' : '已停用（只读）'}
                  </span>
                )}
              </div>
            ))}

            {c.notes.length > 0 && (
              <ul className="cfg-notes">
                {c.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
          </div>
        )
      })}
    </>
  )
}
