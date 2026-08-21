import type { ProviderConfig } from '../../shared/provider.js'

/**
 * 内置 provider 配置。
 *
 * codex 与 omp 完全用声明式规则描述，不写专用代码 —— 和用户在页面上自定义的 CLI
 * 走同一套引擎。这样 DSL 的表达力被真实格式验证过。
 */

/** Claude Code：唯一使用专用解析器的 provider */
export const CLAUDE_CODE: ProviderConfig = {
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  kind: 'builtin-claude',
  builtin: true,
  color: '#c15f3c',
  root: '~/.claude/projects',
  glob: '*/*.jsonl',
  rules: [], // 由专用解析器负责
  capabilities: { resume: true, rename: true, delete: true },
  resumeCommand: 'claude --resume {id}',
}

/**
 * Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`
 * 每行 `{timestamp, type, payload}`。
 *
 * 只取 `type=response_item`：`event_msg` 会把同样的对话再发一遍
 * （实测某会话 response_item 16 条 vs event_msg 85 条），不隔离就会全量重复。
 *
 * `reasoning` 不取：payload.summary 实测为空数组，真正内容在 encrypted_content 里读不到。
 */
export const CODEX: ProviderConfig = {
  id: 'codex',
  name: 'Codex',
  enabled: true,
  kind: 'generic-jsonl',
  builtin: true,
  color: '#10a37f',
  root: '~/.codex/sessions',
  glob: '**/rollout-*.jsonl',
  sessionId: {
    from: 'filename',
    filenameRegex: '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$',
  },
  cwd: { paths: ['payload.cwd'] },
  timestamp: { paths: ['timestamp'] },
  rules: [
    {
      when: [
        { path: 'type', equals: 'response_item' },
        { path: 'payload.type', equals: 'message' },
      ],
      emit: 'text',
      rolePath: 'payload.role',
      roleMap: { developer: 'system', user: 'user', assistant: 'assistant' },
      textPaths: ['payload.content[].text', 'payload.content'],
      // developer 角色是系统提示注入，折叠起来
      metaWhenRole: ['developer'],
    },
    {
      when: [
        { path: 'type', equals: 'response_item' },
        { path: 'payload.type', equals: 'agent_message' },
      ],
      emit: 'text',
      role: 'assistant',
      textPaths: ['payload.content[].text', 'payload.content', 'payload.message'],
    },
    {
      when: [
        { path: 'type', equals: 'response_item' },
        { path: 'payload.type', in: ['custom_tool_call', 'function_call'] },
      ],
      emit: 'tool',
      role: 'assistant',
      toolNamePath: 'payload.name',
      toolInputPath: 'payload.input',
    },
    {
      when: [
        { path: 'type', equals: 'response_item' },
        { path: 'payload.type', in: ['custom_tool_call_output', 'function_call_output'] },
      ],
      emit: 'toolResult',
      role: 'system',
      textPaths: ['payload.output'],
      meta: true,
    },
  ],
  capabilities: { resume: false, rename: false, delete: true },
  resumeCommand: 'codex resume {id}',
  newSessionCommand: 'cd {cwd} && codex',
}

/**
 * omp：`~/.omp/agent/sessions/<cwd 编码>/<ISO>_<uuid>.jsonl`
 *
 * user 消息的 content 是**纯字符串**，assistant 的是数组（text / thinking / toolCall
 * 混在一条记录里），所以 textPaths 要两种都试，且引擎必须累积多个块而非首条命中即停。
 */
export const OMP: ProviderConfig = {
  id: 'omp',
  name: 'omp',
  enabled: true,
  kind: 'generic-jsonl',
  builtin: true,
  color: '#7a6fa8',
  root: '~/.omp/agent/sessions',
  glob: '*/*.jsonl',
  sessionId: { from: 'filename', filenameRegex: '_([0-9a-fA-F-]{36})$' },
  cwd: { paths: ['cwd'] },
  title: { paths: ['title'] },
  timestamp: { paths: ['timestamp'] },
  messageId: { path: 'id' },
  parentId: { path: 'parentId' },
  rules: [
    {
      when: [{ path: 'type', equals: 'message' }],
      emit: 'thinking',
      rolePath: 'message.role',
      textPaths: ['message.content[].thinking'],
    },
    {
      when: [{ path: 'type', equals: 'message' }],
      emit: 'text',
      rolePath: 'message.role',
      roleMap: { user: 'user', assistant: 'assistant', toolResult: 'system' },
      // 数组形态与字符串形态都要覆盖
      textPaths: ['message.content[].text', 'message.content'],
      metaWhenRole: ['toolResult'],
    },
    {
      when: [{ path: 'type', equals: 'message' }],
      emit: 'tool',
      rolePath: 'message.role',
      toolNamePath: 'message.content[].name',
      toolInputPath: 'message.content[].arguments',
    },
  ],
  capabilities: { resume: false, rename: false, delete: true },
  resumeCommand: 'omp --resume {id}',
  newSessionCommand: 'cd {cwd} && omp',
}

export const BUILTIN_PROVIDERS: ProviderConfig[] = [CLAUDE_CODE, CODEX, OMP]
