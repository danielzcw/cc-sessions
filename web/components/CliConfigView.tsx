import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import type { CliConfig } from '../../server/cli-config.js'

export type Section = 'mcp' | 'skills' | 'plugins'

type AddForm =
  | {
      kind: 'mcp'; provider: string; name: string; transport: 'stdio' | 'http'
      target: string; args: string; env: string; scope: 'user' | 'local' | 'project'
    }
  | { kind: 'skill'; provider: string; name: string; description: string; body: string }

function blankMcp(provider: string): AddForm {
  return { kind: 'mcp', provider, name: '', transport: 'stdio', target: '', args: '', env: '', scope: 'user' }
}
function blankSkill(provider: string): AddForm {
  return { kind: 'skill', provider, name: '', description: '', body: '' }
}

/** 解析 `KEY=value` 每行一条 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

export function CliConfigView({ section }: { section: Section }) {
  const [clis, setClis] = useState<CliConfig[]>([])
  const [filter, setFilter] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<AddForm | null>(null)
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({})

  const load = () => {
    api.cliConfig().then((r) => setClis(r.clis)).catch((e) => setMsg({ kind: 'err', text: (e as Error).message }))
  }
  useEffect(load, [])

  const act = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(key)
    setMsg(null)
    try {
      await fn()
      setMsg({ kind: 'ok', text: okText })
      load()
      setForm(null)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const f = filter.trim().toLowerCase()
  const match = (...fields: string[]): boolean => !f || fields.some((x) => x.toLowerCase().includes(f))

  const counts = useMemo(() => ({
    mcp: clis.reduce((a, c) => a + c.mcp.length, 0),
    skills: clis.reduce((a, c) => a + c.skills.length, 0),
    plugins: clis.reduce((a, c) => a + c.plugins.length, 0),
  }), [clis])

  // section 由上层的分段控件决定，切换时清掉未提交的表单
  useEffect(() => { setForm(null) }, [section])

  return (
    <>
      <div className="cfg-bar">
        <input
          className="cfg-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`筛选 ${counts[section]} 项…`}
        />
      </div>

      {msg && <div className={msg.kind === 'err' ? 'notice' : 'notice ok'}>{msg.text}</div>}

      {clis.map((c) => {
        const canAdd = section === 'mcp' ? c.capabilities.mcpWritable
          : section === 'skills' ? c.capabilities.skillsWritable
          : false
        const mcpItems = c.mcp.filter((x) => match(x.name, x.command))
        const skillItems = c.skills.filter((x) => match(x.name, x.description))
        const pluginItems = c.plugins.filter((x) => match(x.name))
        const shown = section === 'mcp' ? mcpItems.length : section === 'skills' ? skillItems.length : pluginItems.length
        const total = section === 'mcp' ? c.mcp.length : section === 'skills' ? c.skills.length : c.plugins.length

        return (
          <section className="cfg-cli" key={c.provider}>
            <header className="cfg-cli-head">
              <b>{c.provider}</b>
              <span className="cfg-count">{f ? `${shown} / ${total}` : total}</span>
              <button
                className="cfg-path-btn"
                onClick={() => setOpenPaths((p) => ({ ...p, [c.provider]: !p[c.provider] }))}
              >
                配置路径 {openPaths[c.provider] ? '▾' : '▸'}
              </button>
              {canAdd && (
                <button
                  className="btn tiny"
                  onClick={() => setForm(section === 'mcp' ? blankMcp(c.provider) : blankSkill(c.provider))}
                >
                  ＋ 添加
                </button>
              )}
            </header>

            {openPaths[c.provider] && (
              <div className="cfg-paths">
                {c.configPaths.map((p) => (
                  <div key={p.path} className={p.exists ? '' : 'missing'}>
                    <span className="lbl">{p.label}</span>
                    <code>{p.path}</code>
                    {!p.exists && <span className="mono-dim"> 不存在</span>}
                  </div>
                ))}
              </div>
            )}

            {form?.provider === c.provider && form.kind === 'mcp' && section === 'mcp' && (
              <div className="cfg-form">
                <div className="cfg-form-grid">
                  <label>名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-server" /></label>
                  <label>类型
                    <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value === 'http' ? 'http' : 'stdio' })}>
                      <option value="stdio">stdio（本地命令）</option>
                      <option value="http">http（远端 URL）</option>
                    </select>
                  </label>
                  <label className="wide">
                    {form.transport === 'http' ? 'URL' : '可执行命令'}
                    <input
                      value={form.target}
                      onChange={(e) => setForm({ ...form, target: e.target.value })}
                      placeholder={form.transport === 'http' ? 'https://example.com/mcp' : 'npx'}
                    />
                  </label>
                  {c.provider === 'claude-code' && (
                    <label>作用域
                      <select
                        value={form.scope}
                        onChange={(e) => {
                          const v = e.target.value
                          setForm({ ...form, scope: v === 'local' ? 'local' : v === 'project' ? 'project' : 'user' })
                        }}
                      >
                        <option value="user">user（全局生效）</option>
                        <option value="local">local（仅当前目录）</option>
                        <option value="project">project（写进项目 .mcp.json）</option>
                      </select>
                    </label>
                  )}
                  {form.transport === 'stdio' && (
                    <label className="wide">参数（空格分隔）
                      <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y some-mcp-server" />
                    </label>
                  )}
                  <label className="wide">环境变量（每行 KEY=value）
                    <textarea rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} placeholder="API_KEY=xxx" />
                  </label>
                </div>
                <div className="cfg-form-foot">
                  <span className="mono-dim">
                    {c.provider === 'omp' ? '写入 mcp.json（自动备份）' : `执行 ${c.provider === 'codex' ? 'codex' : 'claude'} mcp add`}
                  </span>
                  <button className="btn ghost tiny" onClick={() => setForm(null)}>取消</button>
                  <button
                    className="btn tiny"
                    disabled={!form.name.trim() || !form.target.trim() || busy !== null}
                    onClick={() => void act('add-mcp', () => api.addMcp({
                      provider: c.provider,
                      name: form.name.trim(),
                      transport: form.transport,
                      target: form.target.trim(),
                      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
                      env: parseEnv(form.env),
                      scope: form.scope,
                    }), `已添加 MCP ${form.name.trim()}`)}
                  >{busy ? <span className="spin" /> : '添加'}</button>
                </div>
              </div>
            )}

            {form?.provider === c.provider && form.kind === 'skill' && section === 'skills' && (
              <div className="cfg-form">
                <div className="cfg-form-grid">
                  <label>名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-skill" /></label>
                  <label className="wide">description（CLI 靠它判断何时加载，必填）
                    <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Use when the user asks to …" />
                  </label>
                  <label className="wide">正文（Markdown，可留空）
                    <textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="# 步骤…" />
                  </label>
                </div>
                <div className="cfg-form-foot">
                  <span className="mono-dim">写入 SKILL.md</span>
                  <button className="btn ghost tiny" onClick={() => setForm(null)}>取消</button>
                  <button
                    className="btn tiny"
                    disabled={!form.name.trim() || !form.description.trim() || busy !== null}
                    onClick={() => void act('add-skill', () => api.addSkill({
                      provider: c.provider,
                      name: form.name.trim(),
                      description: form.description.trim(),
                      body: form.body,
                    }), `已创建技能 ${form.name.trim()}`)}
                  >{busy ? <span className="spin" /> : '创建'}</button>
                </div>
              </div>
            )}

            {shown === 0 && <div className="cfg-empty">{f ? '没有匹配项' : '（无）'}</div>}

            {section === 'mcp' && mcpItems.map((m) => (
              <div className="cfg-row" key={`${m.scope}:${m.scopePath ?? ''}:${m.name}`}>
                <div className="cfg-main">
                  <div className="cfg-name">
                    {m.name}
                    {m.scope !== 'user' && (
                      <span className="badge" title={m.scopePath ?? ''}>
                        {m.scope}{m.scopePath ? `: ${m.scopePath.replace(/^\/Users\/[^/]+/, '~')}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="cfg-sub"><code>{m.command || '(未配 command)'}</code></div>
                  {m.envKeys.length > 0 && <div className="cfg-sub">env: {m.envKeys.join(', ')}</div>}
                </div>
                {m.writable
                  ? (
                      <button
                        className="cfg-del"
                        disabled={busy !== null}
                        title="移除该 MCP"
                        onClick={() => {
                          if (!confirm(`移除 MCP「${m.name}」？`)) return
                          void act('del-mcp', () => api.removeMcp(c.provider, m.name, m.scope), `已移除 ${m.name}`)
                        }}
                      >移除</button>
                    )
                  : <span className="badge">只读</span>}
              </div>
            ))}

            {section === 'skills' && skillItems.map((s) => (
              <div className="cfg-row" key={s.path}>
                <div className="cfg-main">
                  <div className="cfg-name">{s.name}</div>
                  {s.description && <div className="cfg-sub desc">{s.description}</div>}
                  <div className="cfg-sub"><code>{s.path}</code></div>
                </div>
                {c.capabilities.skillsWritable && !s.name.includes('/') && (
                  <button
                    className="cfg-del"
                    disabled={busy !== null}
                    title="移到回收站（可还原）"
                    onClick={() => {
                      if (!confirm(`移除技能「${s.name}」？会放进回收站，可还原。`)) return
                      void act('del-skill', () => api.removeSkill(c.provider, s.name), `已移除技能 ${s.name}`)
                    }}
                  >移除</button>
                )}
              </div>
            ))}

            {section === 'plugins' && pluginItems.map((p) => (
              <div className="cfg-row" key={p.name}>
                <div className="cfg-main">
                  <div className="cfg-name">{p.name}</div>
                  <div className="cfg-sub"><code>{p.source}</code></div>
                </div>
                {p.writable ? (
                  <label className="cfg-switch">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={busy !== null}
                      onChange={(e) => void act(
                        'plugin',
                        () => api.setPlugin(c.provider, p.name, e.target.checked),
                        `已${e.target.checked ? '启用' : '停用'} ${p.name}，重启 CLI 会话生效`,
                      )}
                    />
                    <span>{p.enabled ? '启用' : '停用'}</span>
                  </label>
                ) : (
                  <span className={`badge${p.enabled ? ' branch' : ''}`}>{p.enabled ? '启用（只读）' : '停用（只读）'}</span>
                )}
              </div>
            ))}

            {c.notes.length > 0 && (
              <details className="cfg-notes">
                <summary>说明 {c.notes.length} 条</summary>
                <ul>{c.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </details>
            )}
          </section>
        )
      })}
    </>
  )
}
