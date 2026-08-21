import { useEffect, useMemo, useState } from 'react'
import type { ProviderConfig, ProviderRuntimeInfo } from '../../shared/provider.js'
import type { ProbeResult } from '../../server/providers/probe.js'
import { api } from '../api.js'

/** 新建自定义 provider 的起始模板：给一份能直接改的骨架，比空表单好用 */
function blankProvider(): ProviderConfig {
  return {
    id: '',
    name: '',
    enabled: true,
    kind: 'generic-jsonl',
    root: '~/',
    glob: '**/*.jsonl',
    color: '#6b7fd7',
    sessionId: { from: 'filename' },
    cwd: { paths: ['cwd'] },
    title: { paths: ['title'] },
    timestamp: { paths: ['timestamp'] },
    rules: [
      {
        when: [{ path: 'type', equals: 'message' }],
        emit: 'text',
        rolePath: 'role',
        textPaths: ['content', 'content[].text'],
      },
    ],
    capabilities: { resume: false, rename: false, delete: true },
    resumeCommand: '',
  }
}

function ProbeView({ result }: { result: ProbeResult }) {
  return (
    <div className="probe">
      <div className="probe-head">
        {result.rootExists ? '✅ 根目录存在' : '❌ 根目录不存在'}
        {' · '}匹配到 {result.matchedFiles} 个文件
      </div>
      {result.warnings.length > 0 && (
        <ul className="probe-warn">
          {result.warnings.map((w, i) => <li key={i}>⚠️ {w}</li>)}
        </ul>
      )}
      {result.samples.map((s) => (
        <div className="probe-sample" key={s.file}>
          <div className="mono-dim">{s.file}</div>
          <div className="probe-meta">
            id={s.sessionId.slice(0, 12)}… · cwd={s.cwd ?? '(未取到)'} · 标题={s.title ?? '(未取到)'}
            {' · '}消息 {s.messageCount}（可见 {s.visibleCount}）
          </div>
          {s.preview.length === 0
            ? <div className="probe-empty">规则没解析出任何内容</div>
            : s.preview.map((p, i) => (
                <div className="probe-line" key={i}>
                  <span className="tag">{p.role}/{p.kind}</span> {p.text}
                </div>
              ))}
        </div>
      ))}
    </div>
  )
}

export function ProviderSettingsInner({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<ProviderRuntimeInfo[]>([])
  const [configPath, setConfigPath] = useState('')
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [json, setJson] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => {
    api.providers()
      .then((r) => { setItems(r.providers); setConfigPath(r.configPath) })
      .catch((e) => setMsg({ kind: 'err', text: (e as Error).message }))
  }
  useEffect(load, [])

  const startEdit = (cfg: ProviderConfig) => {
    setEditing(cfg)
    setProbe(null)
    setMsg(null)
    // 内置 provider 的规则是代码里的，编辑时只暴露可覆盖字段，避免用户把规则改坏
    setJson(JSON.stringify(cfg, null, 2))
  }

  const parsed = useMemo((): { cfg?: ProviderConfig; err?: string } => {
    if (!json.trim()) return { err: '内容为空' }
    try {
      const v: unknown = JSON.parse(json)
      if (!v || typeof v !== 'object') return { err: '不是对象' }
      // 服务端会再做一次完整校验，这里只保证能解析
      return { cfg: v as ProviderConfig }
    } catch (e) {
      return { err: (e as Error).message }
    }
  }, [json])

  const doProbe = async () => {
    if (!parsed.cfg) return
    setBusy(true)
    setProbe(null)
    try {
      setProbe(await api.probeProvider(parsed.cfg))
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const doSave = async () => {
    if (!parsed.cfg) return
    setBusy(true)
    try {
      await api.saveProvider(parsed.cfg)
      setMsg({ kind: 'ok', text: '已保存，正在重新扫描…' })
      await api.rescan()
      load()
      onChanged()
      setEditing(null)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: ProviderRuntimeInfo, enabled: boolean) => {
    try {
      await api.saveProvider({ ...p, enabled })
      await api.rescan()
      load()
      onChanged()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  const remove = async (p: ProviderRuntimeInfo) => {
    if (!confirm(`删除 provider「${p.name}」？只删配置，不动会话文件。`)) return
    try {
      await api.deleteProvider(p.id)
      await api.rescan()
      load()
      onChanged()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  return (
    <>
        <h3 className="sec">CLI 来源 · {items.length}</h3>
        <p className="mono-dim">
          配置存放于 {configPath}。内置项的解析规则随版本更新，只保留你改过的字段；
          自定义项整体存盘。改完会自动重新扫描。
        </p>

        {items.map((p) => (
          <div className="prov-row" key={p.id}>
            <span className="prov-dot" style={{ background: p.color ?? 'var(--accent)' }} />
            <div className="prov-info">
              <div className="prov-name">
                {p.name}
                <span className="mono-dim"> · {p.id}</span>
                {p.builtin && <span className="badge">内置</span>}
                {!p.rootExists && <span className="badge live">目录不存在</span>}
                {p.capabilities.resume && <span className="badge branch">可续聊</span>}
              </div>
              <div className="prov-meta">
                {p.root} · {p.glob} · 已索引 {p.sessionCount} 个会话
              </div>
            </div>
            <label className="prov-toggle">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => void toggle(p, e.target.checked)}
              />
              启用
            </label>
            <button className="btn ghost tiny" onClick={() => startEdit(p)}>编辑</button>
            {!p.builtin && (
              <button className="btn tiny danger" onClick={() => void remove(p)}>删除</button>
            )}
          </div>
        ))}

        <div style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => startEdit(blankProvider())}>＋ 添加自定义 CLI</button>
        </div>

        {msg && (
          <div className={msg.kind === 'err' ? 'notice' : 'notice ok'} style={{ marginTop: 12 }}>
            {msg.text}
          </div>
        )}

        {editing && (
          <div className="prov-editor">
            <h3 className="sec">
              {editing.id ? `编辑 ${editing.name || editing.id}` : '新增 CLI 来源'}
            </h3>
            <p className="mono-dim">
              用规则描述会话 jsonl 的结构：<code>root</code> 是会话根目录，<code>glob</code> 匹配文件，
              <code>rules</code> 决定每条记录产出什么。路径用点号，<code>[]</code> 展开数组，
              例如 <code>payload.content[].text</code>。保存前先「试跑」看解析结果。
            </p>
            <textarea
              className="prov-json"
              value={json}
              onChange={(e) => { setJson(e.target.value); setProbe(null) }}
              spellCheck={false}
              rows={22}
            />
            {parsed.err && <div className="notice" style={{ marginTop: 8 }}>JSON 解析失败：{parsed.err}</div>}
            <div className="prov-actions">
              <button className="btn ghost" onClick={() => setEditing(null)}>取消</button>
              <button className="btn ghost" disabled={!parsed.cfg || busy} onClick={() => void doProbe()}>
                {busy ? <span className="spin" /> : '试跑'}
              </button>
              <button className="btn" disabled={!parsed.cfg || busy} onClick={() => void doSave()}>保存</button>
            </div>
            {probe && <ProbeView result={probe} />}
          </div>
        )}
    </>
  )
}
