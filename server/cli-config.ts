import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 读取各 CLI 的 MCP / 技能 / 插件清单。
 *
 * 写回策略保守：只有 Claude Code 的插件开关是纯 JSON 布尔表，改动可预测；
 * Codex 是 TOML、Claude 的 MCP 在 ~/.claude.json（一个很大的活动状态文件），
 * 手改都有风险，因此一律只读并把配置路径交给用户。
 */

export type McpEntry = {
  name: string
  command: string
  source: string
  /** 作用域：user 全局生效，local/project 只对某个目录生效 */
  scope: string
  /** local/project 作用域对应的目录 */
  scopePath?: string
  /** 能否通过本 App 增删（claude/codex 走官方命令，omp 改 JSON） */
  writable: boolean
  /** 环境变量键名（只列键不列值，避免把密钥吐到界面上） */
  envKeys: string[]
}

export type SkillEntry = {
  name: string
  description: string
  path: string
}

/** 该 provider 是否有可管理的技能目录 */
export type CliCapabilities = {
  mcpWritable: boolean
  skillsWritable: boolean
  pluginsWritable: boolean
}

export type PluginEntry = {
  name: string
  enabled: boolean
  source: string
  /** 能否通过本 App 开关 */
  writable: boolean
}

export type CliConfig = {
  provider: string
  capabilities: CliCapabilities
  /** 配置文件路径，界面上直接展示便于用户手改 */
  configPaths: { label: string; path: string; exists: boolean }[]
  mcp: McpEntry[]
  skills: SkillEntry[]
  plugins: PluginEntry[]
  notes: string[]
}

const home = os.homedir()
const tilde = (p: string): string => (p.startsWith(home) ? '~' + p.slice(home.length) : p)

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}


/**
 * 读技能目录。支持两级：`skills/<name>/SKILL.md` 与
 * `skills/<pack>/<name>/SKILL.md`（codex 的 gstack 就是这种打包形式）。
 */
function readSkillDir(dir: string, depth = 0, prefix = ''): SkillEntry[] {
  const out: SkillEntry[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const sub = path.join(dir, e.name)
    const md = path.join(sub, 'SKILL.md')

    if (fs.existsSync(md)) {
      let description = ''
      let name = prefix + e.name
      try {
        const text = fs.readFileSync(md, 'utf8').slice(0, 4000)
        // frontmatter 是 --- 包起来的 YAML，这里只取两个标量字段，不引 YAML 解析器
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
        if (fm) {
          const d = /^description:\s*(.+)$/m.exec(fm[1])
          if (d) description = d[1].trim().replace(/^["']|["']$/g, '')
          const n = /^name:\s*(.+)$/m.exec(fm[1])
          if (n) name = prefix + n[1].trim().replace(/^["']|["']$/g, '')
        }
      } catch {
        // 读不出 frontmatter 也照样列出，至少让用户知道它存在
      }
      out.push({ name, description: description.slice(0, 300), path: tilde(sub) })
    }

    // 即使自己就是技能也要往下找：codex 的 gstack 既有自己的 SKILL.md，
    // 又在子目录里带了几十个子技能，只看顶层会漏掉绝大部分
    if (depth === 0) out.push(...readSkillDir(sub, 1, e.name + '/'))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 从 TOML 里抽取我们关心的两类段落。
 *
 * 只做行扫描而不引 TOML 解析器：需要的信息就是 `[mcp_servers.X]` 下的 command/env
 * 与 `[plugins."X"]` 下的 enabled。多行数组、内联表等语法一概不处理 ——
 * 因此本函数只用于**读取展示**，不用于写回。
 */
function scanToml(file: string): { mcp: McpEntry[]; plugins: PluginEntry[] } {
  const mcp: McpEntry[] = []
  const plugins: PluginEntry[] = []
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { mcp, plugins }
  }

  let section = ''
  let cur: McpEntry | null = null
  let curPlugin: PluginEntry | null = null

  const flush = (): void => {
    if (cur) { mcp.push(cur); cur = null }
    if (curPlugin) { plugins.push(curPlugin); curPlugin = null }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      const m = /^\[([^\]]+)\]$/.exec(line)
      if (!m) continue
      const sec = m[1]
      // env 子表属于上一个 server，不要在这里 flush
      if (/^mcp_servers\.[^.]+\.env$/.test(sec)) { section = 'mcp-env'; continue }
      flush()
      section = sec
      const mcpName = /^mcp_servers\.(.+)$/.exec(sec)
      if (mcpName) {
        cur = {
          name: mcpName[1].replace(/^"|"$/g, ''),
          command: '', source: tilde(file), scope: 'user', writable: true, envKeys: [],
        }
        continue
      }
      const plugName = /^plugins\.(.+)$/.exec(sec)
      if (plugName) {
        curPlugin = {
          name: plugName[1].replace(/^"|"$/g, ''),
          enabled: false,
          source: tilde(file),
          // TOML 写回需要真正的解析器，这里只读
          writable: false,
        }
      }
      continue
    }
    if (!line || line.startsWith('#')) continue
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    const [, key, rawVal] = kv
    const val = rawVal.trim().replace(/^["']|["']$/g, '')
    if (cur && section.startsWith('mcp_servers') && key === 'command') cur.command = val
    else if (cur && section === 'mcp-env') cur.envKeys.push(key)
    else if (curPlugin && key === 'enabled') curPlugin.enabled = val === 'true'
  }
  flush()
  return { mcp, plugins }
}

function claudeConfig(): CliConfig {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const stateFile = path.join(home, '.claude.json')
  const settingsFile = path.join(claudeHome, 'settings.json')
  const skillsDir = path.join(claudeHome, 'skills')

  const mcp: McpEntry[] = []
  const state = readJson(stateFile)

  const collect = (servers: unknown, scope: string, scopePath?: string): void => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, v] of Object.entries(servers)) {
      const cmd = v && typeof v === 'object' && 'command' in v ? String(Reflect.get(v, 'command'))
        : v && typeof v === 'object' && 'url' in v ? String(Reflect.get(v, 'url')) : ''
      const env = v && typeof v === 'object' && 'env' in v ? Reflect.get(v, 'env') : null
      mcp.push({
        name, command: cmd, source: tilde(stateFile), scope, scopePath,
        writable: true,
        envKeys: env && typeof env === 'object' ? Object.keys(env) : [],
      })
    }
  }

  if (state && typeof state === 'object') {
    collect(Reflect.get(state, 'mcpServers'), 'user')
    // 项目作用域的 MCP 也要列出来，否则清单会漏掉只在某个目录生效的服务器
    const projects = Reflect.get(state, 'projects')
    if (projects && typeof projects === 'object') {
      for (const [dir, pv] of Object.entries(projects)) {
        if (!pv || typeof pv !== 'object') continue
        collect(Reflect.get(pv, 'mcpServers'), 'local', dir)
      }
    }
  }

  const plugins: PluginEntry[] = []
  const settings = readJson(settingsFile)
  if (settings && typeof settings === 'object' && 'enabledPlugins' in settings) {
    const ep = Reflect.get(settings, 'enabledPlugins')
    if (ep && typeof ep === 'object') {
      for (const [name, v] of Object.entries(ep)) {
        // 纯布尔表，改动可预测，是唯一开放写回的地方
        plugins.push({ name, enabled: v === true, source: tilde(settingsFile), writable: true })
      }
    }
  }

  return {
    provider: 'claude-code',
    capabilities: { mcpWritable: true, skillsWritable: true, pluginsWritable: true },
    configPaths: [
      { label: 'MCP 与项目状态', path: tilde(stateFile), exists: fs.existsSync(stateFile) },
      { label: '设置与插件开关', path: tilde(settingsFile), exists: fs.existsSync(settingsFile) },
      { label: '技能目录', path: tilde(skillsDir), exists: fs.existsSync(skillsDir) },
    ],
    mcp,
    skills: readSkillDir(skillsDir),
    plugins: plugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    notes: [
      'MCP 增删走 claude mcp add/remove 官方命令，不手改 ~/.claude.json。',
      'claude mcp add 默认写 local 作用域（只对当前目录生效），本 App 默认用 user 全局作用域。',
      '插件开关直接写 settings.json 的 enabledPlugins，改完需重启 CLI 会话生效。',
      '插件自带的技能不在技能目录里，这里只列独立安装的。',
    ],
  }
}

function codexConfig(): CliConfig {
  const root = path.join(home, '.codex')
  const cfg = path.join(root, 'config.toml')
  const skillsDir = path.join(root, 'skills')
  const { mcp, plugins } = scanToml(cfg)
  return {
    provider: 'codex',
    capabilities: { mcpWritable: true, skillsWritable: true, pluginsWritable: false },
    configPaths: [
      { label: '主配置（TOML）', path: tilde(cfg), exists: fs.existsSync(cfg) },
      { label: '技能目录', path: tilde(skillsDir), exists: fs.existsSync(skillsDir) },
    ],
    mcp,
    skills: readSkillDir(skillsDir),
    plugins: plugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    notes: [
      'MCP 增删走 codex mcp add/remove 官方命令，不手改 TOML。',
      '插件开关在 config.toml 里，安全写回需要 TOML 解析器，暂时只读。',
    ],
  }
}

function ompConfig(): CliConfig {
  const root = path.join(home, '.omp', 'agent')
  const mcpFile = path.join(root, 'mcp.json')
  const ymlFile = path.join(root, 'config.yml')

  const mcp: McpEntry[] = []
  const j = readJson(mcpFile)
  if (j && typeof j === 'object' && 'mcpServers' in j) {
    const servers = Reflect.get(j, 'mcpServers')
    if (servers && typeof servers === 'object') {
      for (const [name, v] of Object.entries(servers)) {
        const cmd = v && typeof v === 'object' && 'command' in v ? String(Reflect.get(v, 'command')) : ''
        const env = v && typeof v === 'object' && 'env' in v ? Reflect.get(v, 'env') : null
        mcp.push({
          name,
          command: cmd,
          source: tilde(mcpFile),
          scope: 'user',
          writable: true,
          envKeys: env && typeof env === 'object' ? Object.keys(env) : [],
        })
      }
    }
  }

  return {
    provider: 'omp',
    // omp 没有 mcp 子命令，但 mcp.json 是纯 JSON，直接改是安全的
    capabilities: { mcpWritable: true, skillsWritable: false, pluginsWritable: false },
    configPaths: [
      { label: 'MCP 配置', path: tilde(mcpFile), exists: fs.existsSync(mcpFile) },
      { label: '主配置（YAML）', path: tilde(ymlFile), exists: fs.existsSync(ymlFile) },
    ],
    mcp,
    skills: [],
    plugins: [],
    notes: [
      'omp 没有 mcp 子命令，增删直接改 mcp.json（改前自动备份）。',
      'omp 没有独立的技能目录，技能随 CLI 内置或由插件提供，本 App 无法枚举。',
    ],
  }
}

export function readCliConfigs(): CliConfig[] {
  return [claudeConfig(), codexConfig(), ompConfig()]
}

/**
 * 开关 Claude Code 的插件。写前先确认 key 存在 —— 不凭空新增，
 * 避免把一个 CLI 不认识的插件名塞进配置。
 */
export function setClaudePlugin(name: string, enabled: boolean): void {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const file = path.join(claudeHome, 'settings.json')
  const raw = fs.readFileSync(file, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('settings.json 不是对象')
  if (!('enabledPlugins' in parsed)) throw new Error('settings.json 里没有 enabledPlugins')
  const ep = Reflect.get(parsed, 'enabledPlugins')
  if (!ep || typeof ep !== 'object') throw new Error('enabledPlugins 不是对象')
  if (!(name in ep)) throw new Error(`插件 ${name} 不在 enabledPlugins 里`)

  // 先备份：这是 CLI 的主配置，改坏了影响的是用户的日常使用
  fs.copyFileSync(file, file + '.bak-ccs')
  Reflect.set(ep, name, enabled)
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n')
}
