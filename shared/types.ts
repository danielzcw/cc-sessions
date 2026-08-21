/** 前后端共享类型。原始 jsonl 是仅追加事件日志，UI 需要的是折叠后的气泡列表，两者在此解耦。 */

// ---------- 原始 jsonl 记录（只声明我们真正用到的字段） ----------

export type RawRecord = {
  type: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  session_id?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  isSidechain?: boolean
  isMeta?: boolean
  userType?: string
  requestId?: string
  effort?: string
  message?: RawMessage
  toolUseResult?: unknown
  // 元信息记录
  aiTitle?: string
  customTitle?: string
  leafUuid?: string
  mode?: string
  permissionMode?: string
  operation?: string
  content?: unknown
  attachment?: { type?: string; [k: string]: unknown }
  level?: string
  toolUseID?: string
  isApiErrorMessage?: boolean
}

export type RawMessage = {
  id?: string
  role?: 'user' | 'assistant'
  model?: string
  content?: string | ContentBlock[]
  stop_reason?: string | null
  usage?: Usage
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: 'image'; source?: unknown }
  | { type: string; [k: string]: unknown }

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// ---------- 归一化后的视图模型 ----------

export type ViewBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: ToolResult }
  | { kind: 'image'; alt: string }

export type ToolResult = {
  isError: boolean
  text: string
  /** Edit/Write 类工具的结构化 diff 信息，前端渲染成 diff 视图 */
  patch?: { filePath: string; oldText?: string; newText?: string }
}

export type ViewMessage = {
  uuid: string
  parentUuid: string | null
  role: 'user' | 'assistant' | 'system'
  ts: string | null
  blocks: ViewBlock[]
  model?: string
  usage?: Usage
  /** 系统注入（hook 输出、skill 加载、mcp 状态），默认折叠 */
  meta?: boolean
  /** 该消息属于哪个分支（0 = 主干） */
  branch?: number
  /** true 表示这条是本地乐观插入、尚未落盘 */
  pending?: boolean
  error?: boolean
}

export type SessionSummary = {
  /** 来自哪个 CLI */
  provider: string
  providerName: string
  /** 该 provider 支持哪些操作，UI 据此显示/禁用按钮 */
  capabilities: { resume: boolean; rename: boolean; delete: boolean }
  /** 在终端里继续该会话的命令（已填好 id/cwd），provider 未提供则为空串 */
  resumeCommand: string
  sessionId: string
  projectDir: string
  cwd: string
  title: string
  /** 标题来源：用户自定义 > AI 生成 > 首条 prompt 截断 */
  titleSource: 'custom' | 'ai' | 'prompt'
  firstPrompt: string
  createdAt: string | null
  updatedAt: string | null
  messageCount: number
  gitBranch: string | null
  model: string | null
  costUsd: number
  totalTokens: number
  hasBranches: boolean
  /** 该会话此刻是否有 CLI 进程在跑（不可 resume） */
  live: boolean
  sizeBytes: number
}

export type ProjectSummary = {
  /** 归一化后的 cwd，作为分组主键 */
  cwd: string
  /** 该目录下出现过哪些 CLI */
  providers: string[]
  name: string
  /** 同一 cwd 可能对应多个磁盘目录（大小写/编码差异） */
  projectDirs: string[]
  sessionCount: number
  lastActiveAt: string | null
  costUsd: number
  gitBranches: string[]
}

export type SessionDetail = {
  summary: SessionSummary
  messages: ViewMessage[]
  /** 分支树：每个分叉点的可选路径 */
  branches: BranchInfo[]
  leafUuid: string | null
}

export type BranchInfo = {
  /** 分叉点的父消息 uuid */
  forkAt: string
  /** 该分叉点下的各条分支，每条给出首条消息 uuid 与预览 */
  choices: { headUuid: string; preview: string; ts: string | null; messageCount: number }[]
}

export type SearchHit = {
  sessionId: string
  provider: string
  cwd: string
  title: string
  ts: string | null
  snippet: string
  role: string
}

export type StatsBucket = { key: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; sessions: number }

export type StatsResponse = {
  totalCostUsd: number
  totalSessions: number
  totalMessages: number
  byDay: StatsBucket[]
  byProject: StatsBucket[]
  byModel: StatsBucket[]
}

// ---------- 聊天与审批（SSE 事件） ----------

export type ChatEvent =
  | { type: 'status'; state: 'starting' | 'ready' | 'thinking' | 'idle' | 'closed'; sessionId: string }
  | { type: 'message'; message: ViewMessage }
  | { type: 'delta'; uuid: string; text: string; blockKind: 'text' | 'thinking' }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; decision: ApprovalDecision['behavior'] }
  | { type: 'result'; costUsd: number; durationMs: number; numTurns: number; usage?: Usage; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'session_forked'; from: string; to: string }

export type ApprovalRequest = {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  createdAt: number
}

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
