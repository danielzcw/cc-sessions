import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context, type Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allSessions, getSessionRow, modelsSeen, projectRows, providerCounts,
  removeProviderSessions, removeSession as removeSessionFromIndex,
  search, stats, type SessionRow,
} from './db.js'
import { chainFrom, chainToText } from './parser.js'
import {
  liveSessionIds, listTrash, loadParsedSession, purgeTrash, reindexSession,
  renameSession, restoreSession, scanAll, trashSession,
} from './scanner.js'
import {
  isSafeSessionId, migrateLegacyDataDir, normalizeCwd, projectDisplayName, tildify, PROJECTS_DIR,
} from './paths.js'
import { RunnerRegistry } from './runner.js'
import {
  getProvider, listProviders, providerConfigPath, removeProvider,
  upsertProvider, validateProvider, expandTilde,
} from './providers/registry.js'
import { preflightOrExit, readDefaultModel, runChecks } from './preflight.js'
import type {
  ApprovalDecision, ProjectSummary, SessionDetail, SessionSummary,
} from '../shared/types.js'
import type { ProviderConfig, ProviderRuntimeInfo } from '../shared/provider.js'
import { probeProvider } from './providers/probe.js'
import { readCliConfigs, setClaudePlugin } from './cli-config.js'
import { buildHelp, buildState, readCachedHelp } from './cli-help.js'
import {
  addMcp, addSkill, listSkillTrash, removeMcp, removeSkill, restoreSkill,
} from './cli-mutate.js'

const PORT = Number(process.env.PORT || 5274)
const HOST = process.env.HOST || '127.0.0.1'
const ORIGIN = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`
/** 内部审批端点的共享密钥，只发给我们自己 spawn 的 MCP 进程 */
const TOKEN = process.env.CCS_TOKEN || randomUUID()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIST = path.join(HERE, '..', 'dist', 'web')

const runners = new RunnerRegistry({ serverOrigin: ORIGIN, token: TOKEN, idleMs: 10 * 60_000 })
const app = new Hono()

/**
 * 边界校验：凡是路径里带会话 id 的路由，先确认 id 是 UUID。
 *
 * 这些 id 会被拼进文件路径，不校验就能用 `../` 穿越出目标目录。
 * 实测未修复前 `DELETE /api/trash/<穿越路径>` 可删除文件系统上任意
 * .jsonl / .meta.json，`GET /api/sessions/<穿越路径>/export` 可读取任意 .jsonl。
 * scanner 内部还有一层路径包含校验兜底。
 */
app.use('/api/sessions/:id/*', sessionIdGuard)
app.use('/api/sessions/:id', sessionIdGuard)
app.use('/api/chat/:id/*', sessionIdGuard)
app.use('/api/trash/:id', sessionIdGuard)

async function sessionIdGuard(c: Context, next: Next): Promise<Response | void> {
  const id = c.req.param('id')
  // /api/sessions/new 不是会话 id，是固定路由
  if (id && id !== 'new' && !isSafeSessionId(id)) {
    return c.json({ error: '会话 id 格式非法' }, 400)
  }
  await next()
}

function toSummary(r: SessionRow, live: Set<string>): SessionSummary {
  const cfg = getProvider(r.provider)
  return {
    provider: r.provider,
    providerName: cfg?.name ?? r.provider,
    capabilities: cfg?.capabilities ?? { resume: false, rename: false, delete: true },
    resumeCommand: (cfg?.resumeCommand ?? '').replace('{id}', r.session_id).replace('{cwd}', r.cwd),
    sessionId: r.session_id,
    projectDir: r.project_dir,
    cwd: r.cwd,
    title: r.title,
    titleSource: r.title_source as SessionSummary['titleSource'],
    firstPrompt: r.first_prompt,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.msg_count,
    gitBranch: r.git_branch,
    model: r.model,
    costUsd: r.cost_usd,
    totalTokens: r.in_tokens + r.out_tokens,
    hasBranches: r.has_branches === 1,
    // 活跃检测依赖 ~/.claude/sessions 的 pid 文件，其他 provider 无从判断
    live: r.provider === 'claude-code' && live.has(r.session_id),
    sizeBytes: r.size_bytes,
  }
}

// ---------------- 只读浏览 ----------------

app.get('/api/projects', (c) => {
  const provider = c.req.query('provider') || undefined
  const out: ProjectSummary[] = projectRows(provider).map((p) => ({
    cwd: p.cwd,
    name: projectDisplayName(p.cwd),
    projectDirs: (p.dirs ?? '').split(',').filter(Boolean),
    sessionCount: p.n,
    lastActiveAt: p.last,
    costUsd: p.cost ?? 0,
    gitBranches: (p.branches ?? '').split(',').filter(Boolean),
    providers: (p.providers ?? '').split(',').filter(Boolean),
  }))
  return c.json({ projects: out, claudeHome: tildify(PROJECTS_DIR) })
})

app.get('/api/sessions', (c) => {
  const cwd = c.req.query('cwd')
  const provider = c.req.query('provider') || undefined
  const live = liveSessionIds()
  const rows = allSessions(cwd ? normalizeCwd(cwd) : undefined, provider)
  return c.json({ sessions: rows.map((r) => toSummary(r, live)) })
})

app.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const provider = c.req.query('provider')
  const row = getSessionRow(id, provider)
  const loaded = await loadParsedSession(id, row?.provider ?? provider)
  if (!loaded || !row) {
    // 新建但还没发过消息的会话：磁盘与索引都没有，返回一个空壳让前端能进聊天界面
    const cwd = runners.cwdOf(id)
    if (cwd) {
      const draftCfg = getProvider('claude-code')
      const empty: SessionDetail = {
        summary: {
          provider: draftCfg?.id ?? 'claude-code',
          providerName: draftCfg?.name ?? 'Claude Code',
          capabilities: draftCfg?.capabilities ?? { resume: true, rename: true, delete: true },
          resumeCommand: (draftCfg?.resumeCommand ?? '').replace('{id}', id),
          sessionId: id, projectDir: '', cwd, title: '新会话', titleSource: 'prompt',
          firstPrompt: '', createdAt: null, updatedAt: null, messageCount: 0,
          gitBranch: null, model: null, costUsd: 0, totalTokens: 0,
          hasBranches: false, live: false, sizeBytes: 0,
        },
        messages: [], branches: [], leafUuid: null,
      }
      return c.json(empty)
    }
    return c.json({ error: '会话不存在' }, 404)
  }
  const parsed = loaded.parsed
  const detail: SessionDetail = {
    summary: toSummary(row, liveSessionIds()),
    messages: parsed.messages,
    branches: parsed.branches,
    leafUuid: parsed.leafUuid,
  }
  return c.json(detail)
})

app.get('/api/search', (c) => {
  const q = c.req.query('q') ?? ''
  const cwd = c.req.query('cwd')
  const provider = c.req.query('provider') || undefined
  return c.json({ hits: search(q, { cwdKey: cwd ? normalizeCwd(cwd) : undefined, provider }) })
})

app.get('/api/stats', (c) => c.json(stats(c.req.query('provider') || undefined)))

// ---------------- Provider 管理（页面内配置） ----------------

app.get('/api/providers', (c) => {
  const counts = providerCounts()
  const out: ProviderRuntimeInfo[] = listProviders().map((p) => ({
    ...p,
    rootExists: fs.existsSync(expandTilde(p.root)),
    sessionCount: counts[p.id] ?? 0,
  }))
  return c.json({ providers: out, configPath: tildify(providerConfigPath()) })
})

app.put('/api/providers/:id', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: '请求体不是对象' }, 400)
  const id = c.req.param('id')
  if (!('id' in body) || Reflect.get(body, 'id') !== id) {
    return c.json({ error: 'URL 里的 id 与请求体不一致' }, 400)
  }
  const err = validateProvider(body)
  if (err) return c.json({ error: err }, 400)
  try {
    // validateProvider 已逐字段校验过，这里的断言有据可依
    const cfg = body as ProviderConfig
    upsertProvider(cfg)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/providers/:id', (c) => {
  const id = c.req.param('id')
  try {
    removeProvider(id)
    // 配置删了索引也要清，否则会话还留在列表里但已无来源可解析
    const purged = removeProviderSessions(id)
    return c.json({ ok: true, purged })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/** 试跑：拿真实文件验证规则配置是否能解析出内容，配之前先看效果 */
app.post('/api/providers/probe', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null)
  const err = validateProvider(body)
  if (err) return c.json({ error: err }, 400)
  const cfg = body as ProviderConfig
  try {
    return c.json(await probeProvider(cfg))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.get('/api/health', (c) => c.json({ checks: runChecks() }))

// ---------------- 设置中心：各 CLI 的 MCP / 技能 / 插件 ----------------

app.get('/api/cli-config', (c) => c.json({ clis: readCliConfigs() }))

/**
 * 指令说明。内容从 CLI 自己的 --help 递归抓取并落盘缓存 ——
 * 一次完整构建要跑几十次 --help，不能在请求里同步做。
 */
app.get('/api/cli-help/:provider', (c) => {
  const provider = c.req.param('provider')
  const cached = readCachedHelp(provider)
  return c.json({ help: cached, state: buildState() })
})

app.post('/api/cli-help/:provider/refresh', (c) => {
  const provider = c.req.param('provider')
  if (buildState().building) return c.json({ error: '已有构建在进行中' }, 409)
  // 后台构建，立刻返回；前端轮询 GET 看进度
  void buildHelp(provider).catch((e) => console.warn('[ccs] 抓取指令失败:', (e as Error).message))
  return c.json({ ok: true, started: true })
})

/** MCP 增删：claude / codex 走各自的官方命令，omp 改它的 mcp.json */
app.post('/api/cli-config/mcp', async (c) => {
  type McpBody = {
    provider?: string; name?: string; transport?: string; target?: string
    args?: string[]; env?: Record<string, string>; scope?: 'user' | 'local' | 'project'
  }
  const body = await c.req.json<McpBody>().catch((): McpBody => ({}))
  const provider = body.provider ?? ''
  if (!body.name) return c.json({ error: '缺少名称' }, 400)
  try {
    addMcp(provider, {
      name: body.name,
      transport: body.transport === 'http' ? 'http' : 'stdio',
      target: body.target ?? '',
      args: Array.isArray(body.args) ? body.args.filter((a) => typeof a === 'string') : [],
      env: body.env && typeof body.env === 'object' ? body.env : {},
      scope: body.scope,
    })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/cli-config/mcp/:provider/:name', (c) => {
  try {
    removeMcp(c.req.param('provider'), c.req.param('name'), c.req.query('scope') || undefined)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/** 技能增删：新增落盘 SKILL.md，移除进回收站（技能可能是手写的，删了没法恢复） */
app.post('/api/cli-config/skill', async (c) => {
  type SkillBody = { provider?: string; name?: string; description?: string; body?: string }
  const body = await c.req.json<SkillBody>().catch((): SkillBody => ({}))
  if (!body.name) return c.json({ error: '缺少名称' }, 400)
  try {
    const dir = addSkill(body.provider ?? '', body.name, body.description ?? '', body.body ?? '')
    return c.json({ ok: true, dir })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/cli-config/skill/:provider/:name', (c) => {
  try {
    const entry = removeSkill(c.req.param('provider'), c.req.param('name'))
    return c.json({ ok: true, entry })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.get('/api/cli-config/skill-trash', (c) => c.json({ items: listSkillTrash() }))

app.post('/api/cli-config/skill-restore', async (c) => {
  const body = await c.req.json<{ trashPath?: string }>().catch((): { trashPath?: string } => ({}))
  if (!body.trashPath) return c.json({ error: '缺少 trashPath' }, 400)
  try {
    restoreSkill(body.trashPath)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/** 只开放 Claude Code 的插件开关：它是纯 JSON 布尔表，改动可预测 */
app.post('/api/cli-config/plugin', async (c) => {
  const body = await c.req.json<{ provider?: string; name?: string; enabled?: boolean }>()
    .catch(() => ({} as { provider?: string; name?: string; enabled?: boolean }))
  if (body.provider !== 'claude-code') {
    return c.json({ error: '目前只支持开关 Claude Code 的插件' }, 400)
  }
  if (!body.name) return c.json({ error: '缺少插件名' }, 400)
  try {
    setClaudePlugin(body.name, body.enabled === true)
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

/**
 * 可选模型。CLI 没有列模型的命令（`claude models` 会被当成 prompt 执行），
 * 所以别名取自 --help 的文档，再并上索引里真实出现过的模型。
 */
app.get('/api/models', (c) => {
  const aliases = ['opus', 'sonnet', 'fable', 'haiku']
  const seen = modelsSeen()
  return c.json({
    aliases,
    seen,
    // settings.json 里的默认值，不传 --model 时就是它
    fallback: readDefaultModel(),
  })
})

app.post('/api/rescan', async (c) => c.json(await scanAll(c.req.query('full') === '1')))

/**
 * 新建会话。CLI 支持 --session-id 预先指定 uuid（已实测会被采纳并落盘到
 * cwd 对应的项目目录），所以这里先生成 id 交给前端，第一条消息发出时才真正 spawn。
 */
app.post('/api/sessions/new', async (c) => {
  const body = await c.req.json<{ cwd?: string; provider?: string }>()
    .catch(() => ({} as { cwd?: string; provider?: string }))
  const cwd = (body.cwd ?? '').trim()
  const providerId = (body.provider ?? 'claude-code').trim()
  if (!cwd) return c.json({ error: '必须指定工作目录' }, 400)

  const cfg = getProvider(providerId)
  if (!cfg) return c.json({ error: `未知来源 ${providerId}` }, 400)
  if (!cfg.capabilities.resume) {
    // Web 内新建需要接管该 CLI 的对话协议，没实现的一律拒绝并给出终端命令
    return c.json({
      error: `${cfg.name} 只能在终端里新建会话`,
      terminalCommand: (cfg.newSessionCommand ?? '').replace('{cwd}', cwd),
    }, 400)
  }
  if (!path.isAbsolute(cwd)) return c.json({ error: '工作目录必须是绝对路径' }, 400)
  try {
    const st = await fsp.stat(cwd)
    if (!st.isDirectory()) return c.json({ error: '该路径不是目录' }, 400)
  } catch {
    return c.json({ error: '目录不存在' }, 400)
  }
  const sessionId = randomUUID()
  // 注册为 draft：磁盘还没有 jsonl，DB 也查不到，后续 /stream 与 /send 靠 registry 兜底
  runners.getOrCreate(sessionId, cwd, true)
  return c.json({ sessionId, cwd, provider: cfg.id })
})

/** 候选工作目录：已有项目 + 它们的父目录下的兄弟目录，供新建会话时选择 */
app.get('/api/cwd-suggestions', async (c) => {
  const seen = new Set<string>()
  const out: { cwd: string; known: boolean }[] = []
  for (const p of projectRows()) {
    if (seen.has(p.cwd)) continue
    seen.add(p.cwd)
    out.push({ cwd: p.cwd, known: true })
  }
  // 再补上主要工作区下的直接子目录（存在 .git 或 package.json 的才算项目）
  const roots = [...new Set(out.map((o) => path.dirname(o.cwd)))].slice(0, 6)
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => path.join(root, d.name))
    } catch { continue }
    for (const dir of entries) {
      if (seen.has(dir) || out.length > 200) continue
      const isProject = await Promise.all([
        fsp.stat(path.join(dir, '.git')).then(() => true).catch(() => false),
        fsp.stat(path.join(dir, 'package.json')).then(() => true).catch(() => false),
      ])
      if (!isProject.some(Boolean)) continue
      seen.add(dir)
      out.push({ cwd: dir, known: false })
    }
  }
  return c.json({ suggestions: out })
})

/** 两条分支的对比：返回各自的消息链与拍平文本，diff 由前端计算渲染 */
app.get('/api/sessions/:id/branch-diff', async (c) => {
  const id = c.req.param('id')
  const a = c.req.query('a')
  const b = c.req.query('b')
  if (!a || !b) return c.json({ error: '需要 a 与 b 两个分支头 uuid' }, 400)
  const loaded = await loadParsedSession(id, c.req.query('provider') ?? undefined)
  if (!loaded) return c.json({ error: '会话不存在' }, 404)
  const parsed = loaded.parsed
  const chainA = chainFrom(parsed.messages, a)
  const chainB = chainFrom(parsed.messages, b)
  if (chainA.length === 0 || chainB.length === 0) {
    return c.json({ error: '分支头 uuid 不在该会话中' }, 404)
  }
  return c.json({
    a: { headUuid: a, messages: chainA, text: chainToText(chainA) },
    b: { headUuid: b, messages: chainB, text: chainToText(chainB) },
  })
})

/**
 * 重命名会话。写的是 CLI 自己的 custom-title 机制，终端里的 /resume 选择器也会跟着变。
 * 正在运行的会话不改：CLI 进程可能正在写同一个文件。
 */
app.patch('/api/sessions/:id/title', async (c) => {
  const id = c.req.param('id')
  const row = getSessionRow(id, c.req.query('provider') || undefined)
  if (!row) return c.json({ error: '会话不存在' }, 404)
  const cfg = getProvider(row.provider)
  if (!cfg?.capabilities.rename) {
    // 写回标题依赖各 CLI 自己的机制（claude 是 custom-title 记录），
    // 没实现的 provider 一律拒绝，不能靠前端隐藏按钮当防护
    return c.json({ error: `${cfg?.name ?? row.provider} 暂不支持改名` }, 400)
  }
  if (row.provider === 'claude-code' && liveSessionIds().has(id)) {
    return c.json({ error: '该会话正在终端里运行，请先结束再改名' }, 409)
  }
  const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
  const title = (body.title ?? '').replace(/[\r\n\t]/g, ' ').trim()
  if (title.length > 200) return c.json({ error: '标题过长（上限 200 字）' }, 400)
  try {
    // 空串 = 清除自定义标题，回落到 AI 标题
    await renameSession(id, title, row.provider)
    await reindexSession(id, row.provider)
    const updated = getSessionRow(id, row.provider)
    return c.json({ ok: true, title: updated?.title ?? title, titleSource: updated?.title_source ?? 'custom' })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})

/**
 * 删除会话 —— 移到回收站，可撤销。
 * 会话正在终端里跑时拒绝删除：那个进程还会继续往文件里追加内容。
 */
app.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const row = getSessionRow(id, c.req.query('provider') || undefined)
  if (!row) return c.json({ error: '会话不存在' }, 404)

  // 顺序很重要：先收掉本 App 自己的子进程（它为了多轮对话会一直挂着），
  // 等它真正退出后再判断是否还有终端在占用。反过来会把自己的进程误判成占用。
  await runners.disposeOne(id)

  // 活跃检测读的是 ~/.claude/sessions，只对 claude-code 有意义
  if (row.provider === 'claude-code' && liveSessionIds().has(id)) {
    return c.json({ error: '该会话正在终端里运行，请先结束再删除' }, 409)
  }
  try {
    const entry = await trashSession(id, row.title, row.cwd, row.provider)
    removeSessionFromIndex(row.provider, id)
    return c.json({ ok: true, entry })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})

app.post('/api/sessions/:id/restore', async (c) => {
  const id = c.req.param('id')
  try {
    const entry = await restoreSession(id)
    await reindexSession(id)
    return c.json({ ok: true, entry })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.get('/api/trash', async (c) => c.json({ items: await listTrash() }))

/** 彻底删除，不可恢复 */
app.delete('/api/trash/:id', async (c) => {
  await purgeTrash(c.req.param('id'))
  return c.json({ ok: true })
})

/** 导出为 Markdown，方便贴 issue 或存档 */
app.get('/api/sessions/:id/export', async (c) => {
  const id = c.req.param('id')
  const loaded = await loadParsedSession(id, c.req.query('provider') ?? undefined)
  if (!loaded) return c.json({ error: '会话不存在' }, 404)
  const p = loaded.parsed
  const lines: string[] = [
    `# ${p.customTitle ?? p.aiTitle ?? p.firstPrompt.slice(0, 60) ?? id}`,
    '', `- session: \`${id}\``, `- cwd: \`${p.cwd ?? '?'}\``,
    `- 时间: ${p.firstTs ?? '?'} → ${p.lastTs ?? '?'}`, '', '---', '',
  ]
  for (const m of p.messages) {
    if (m.meta) continue
    lines.push(`## ${m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 Claude' : '⚙️ 系统'}${m.ts ? ` · ${m.ts}` : ''}`, '')
    for (const b of m.blocks) {
      if (b.kind === 'text') lines.push(b.text, '')
      else if (b.kind === 'thinking') lines.push('<details><summary>thinking</summary>', '', b.text, '', '</details>', '')
      else if (b.kind === 'tool') {
        lines.push(`**🔧 ${b.name}**`, '', '```json', JSON.stringify(b.input, null, 2), '```', '')
        if (b.result) lines.push('```', b.result.text.slice(0, 4000), '```', '')
      }
    }
  }
  return c.text(lines.join('\n'), 200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="${id}.md"`,
  })
})

// ---------------- 聊天（SSE + 发送） ----------------

app.get('/api/chat/:id/stream', (c) => {
  const id = c.req.param('id')
  const row = getSessionRow(id)
  // 新建会话此刻还没有 jsonl，DB 查不到，回退到 registry 里登记的 cwd
  const cwd = row?.cwd ?? runners.cwdOf(id)
  if (!cwd) return c.json({ error: '会话不存在' }, 404)
  const session = runners.getOrCreate(id, cwd)

  return streamSSE(c, async (stream) => {
    const send = (data: unknown) => stream.writeSSE({ data: JSON.stringify(data) })
    // 补发尚未处理的审批，避免刷新页面后弹窗丢失、CLI 永久挂住
    for (const request of session.pendingApprovals) {
      await send({ type: 'approval', request })
    }
    await send({ type: 'status', state: session.isBusy ? 'thinking' : 'idle', sessionId: id })

    // 事件先入队，再由循环取出写出 —— 避免在订阅回调里直接 await 造成乱序
    const queue: unknown[] = []
    let wake: (() => void) | null = null
    const unsub = session.subscribe((ev) => {
      queue.push(ev)
      wake?.()
    })
    const abort = () => wake?.()
    c.req.raw.signal.addEventListener('abort', abort)

    try {
      while (!c.req.raw.signal.aborted) {
        while (queue.length) await send(queue.shift())
        if (c.req.raw.signal.aborted) break
        // 等新事件，最多等 15s 就发一次心跳，防止空闲连接被代理掐断
        const woken = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => { wake = null; resolve(false) }, 15_000)
          wake = () => { clearTimeout(t); wake = null; resolve(true) }
        })
        if (!woken && !c.req.raw.signal.aborted) await send({ type: 'ping' })
      }
    } finally {
      unsub()
      c.req.raw.signal.removeEventListener('abort', abort)
    }
  })
})

app.post('/api/chat/:id/send', async (c) => {
  const id = c.req.param('id')
  const row = getSessionRow(id)
  const cwd = row?.cwd ?? runners.cwdOf(id)
  if (!cwd) return c.json({ error: '会话不存在' }, 404)
  if (liveSessionIds().has(id)) {
    // 实测：resume 一个正在运行的会话会直接失败，必须提前挡掉
    return c.json({ error: '该会话正在终端里运行，无法同时从 Web 续聊' }, 409)
  }
  const row2 = getSessionRow(id)
  if (row2 && !getProvider(row2.provider)?.capabilities.resume) {
    return c.json({ error: `${row2.provider} 会话只能在终端里继续` }, 400)
  }
  const body = await c.req.json<{ text?: string; model?: string | null }>()
  const text = (body.text ?? '').trim()
  if (!text) return c.json({ error: '内容为空' }, 400)
  runners.getOrCreate(id, cwd).send(text, body.model)
  return c.json({ ok: true })
})

app.post('/api/chat/:id/interrupt', (c) => {
  runners.get(c.req.param('id'))?.interrupt()
  return c.json({ ok: true })
})

app.post('/api/chat/:id/approve', async (c) => {
  const id = c.req.param('id')
  const session = runners.get(id)
  if (!session) return c.json({ error: '会话未在运行' }, 404)
  const body = await c.req.json<{ approvalId: string; decision: ApprovalDecision }>()
  const ok = session.resolveApproval(body.approvalId, body.decision)
  return c.json({ ok }, ok ? 200 : 404)
})

// ---------------- 内部：MCP 审批器回调 ----------------

app.post('/api/internal/approval', async (c) => {
  if (c.req.header('x-ccs-token') !== TOKEN) return c.json({ behavior: 'deny', message: 'token 不匹配' }, 403)
  const body = await c.req.json<{
    sessionId: string; toolName: string; input: Record<string, unknown>
    toolUseId?: string; timeoutMs?: number
  }>()
  const session = runners.findForApproval(body.sessionId)
  if (!session) {
    return c.json<ApprovalDecision>({ behavior: 'deny', message: '找不到对应会话，已拒绝' })
  }
  // 这里会一直挂住，直到用户在浏览器点击或超时
  const decision = await session.requestApproval(
    { sessionId: body.sessionId, toolName: body.toolName, input: body.input, toolUseId: body.toolUseId },
    body.timeoutMs ?? 300_000,
  )
  return c.json(decision)
})

// ---------------- 静态资源（生产模式） ----------------

if (fs.existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }))
  app.get('/*', serveStatic({ path: path.relative(process.cwd(), path.join(WEB_DIST, 'index.html')) }))
}

// ---------------- 启动 ----------------

const boot = async () => {
  // 环境不满足就在这里明确报错退出，别让用户对着栈追踪猜
  preflightOrExit()

  const moved = migrateLegacyDataDir()
  if (moved.length) console.log(`[ccs] 已从旧目录迁移 ${moved.length} 个回收站文件`)

  const r = await scanAll()
  console.log(`[ccs] 索引完成：扫描 ${r.scanned} 个会话，重建 ${r.reindexed} 个，清理 ${r.removed} 个，耗时 ${r.ms}ms`)

  // 文件变更时增量重建，让终端里的新会话自动出现在 Web。
  // 全新机器上这个目录还不存在，fs.watch 会 ENOENT 并永久降级成手动刷新 ——
  // 先建出来（Claude Code 自己也会建，幂等无副作用）。
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true })
  } catch { /* 建不出来就让下面的 watch 去报错 */ }

  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return
      const id = path.basename(filename, '.jsonl')
      clearTimeout(debounce.get(id))
      debounce.set(id, setTimeout(() => {
        debounce.delete(id)
        void reindexSession(id).catch(() => { /* 写入中途读到是正常的 */ })
      }, 800))
    })
  } catch (e) {
    console.warn('[ccs] 目录监听不可用，改用手动 /api/rescan：', (e as Error).message)
  }

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[ccs] server  http://127.0.0.1:${info.port}`)
    if (!fs.existsSync(WEB_DIST)) {
      console.log(`[ccs] 未构建前端，开发模式请访问 vite: http://localhost:${process.env.WEB_PORT || 5273}`)
    }
  })
}
const debounce = new Map<string, NodeJS.Timeout>()

const shutdown = () => { runners.disposeAll(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

void boot()
