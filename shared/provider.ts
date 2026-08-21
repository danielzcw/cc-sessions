/**
 * Provider 配置：用声明式规则描述「某个 CLI 的会话 jsonl 长什么样」。
 *
 * 之所以做成配置而不是每个 CLI 写一份代码：内置的 codex / omp 与用户自己在页面上
 * 添加的 CLI 走同一套机制，DSL 的表达力因此被真实格式验证过 —— 如果它撑不住
 * codex，那也撑不住用户的 CLI。
 *
 * 例外：claude-code 用专用解析器（kind: 'builtin-claude'）。它需要 tool_result
 * 回填、/rewind 分支树、custom-title 写回，这些超出声明式规则的范围。
 */

/** 取值路径：点号分隔，`[]` 表示展开数组并拼接。如 `payload.content[].text` */
export type FieldPath = string

/** 单个条件。同一条规则上的多个条件必须全部满足。 */
export type Cond = {
  path: FieldPath
  equals?: string | number | boolean
  in?: (string | number)[]
}

/**
 * 一条记录命中后产出什么内容。
 *
 * 引擎对每条记录**依次尝试所有规则**并累积产出，而不是首条命中即停 ——
 * omp 的一条 message 记录里 content[] 同时混着 text / thinking / toolCall，
 * 首条命中就会丢内容。
 */
export type EmitRule = {
  /** 全部条件满足才命中；省略表示无条件命中 */
  when?: Cond[]
  emit: 'text' | 'thinking' | 'tool' | 'toolResult'
  role?: 'user' | 'assistant' | 'system'
  rolePath?: FieldPath
  /** 角色值映射，如 codex 的 developer -> system */
  roleMap?: Record<string, 'user' | 'assistant' | 'system'>
  /** 依次尝试取第一个非空。用于兼容 content 既可能是字符串又可能是数组 */
  textPaths?: FieldPath[]
  toolNamePath?: FieldPath
  toolInputPath?: FieldPath
  /** 标为 meta 的内容前端默认折叠（系统提示注入等） */
  meta?: boolean
  /** 原始 role 命中这些值时标记为 meta */
  metaWhenRole?: string[]
}

export type ProviderConfig = {
  id: string
  name: string
  enabled: boolean
  /** builtin-claude 走专用解析器；generic-jsonl 走规则引擎 */
  kind: 'builtin-claude' | 'generic-jsonl'
  /** 会话根目录，支持 ~ 前缀 */
  root: string
  /** 相对 root 的匹配模式，如 `**‌/*.jsonl` */
  glob: string
  /** 内置配置不允许删除，只能停用或改字段 */
  builtin?: boolean
  /** UI 上的强调色 */
  color?: string

  /** 会话 id 怎么取。默认用文件名去扩展名 */
  sessionId?: {
    from: 'filename' | 'field'
    /** from=filename 时用正则提取，取第一个捕获组 */
    filenameRegex?: string
    path?: FieldPath
  }

  /** cwd 从哪读。三个内置 CLI 都把 cwd 写在文件里，优先读字段而不是反解目录名 */
  cwd?: { paths: FieldPath[] }
  /** 标题候选路径，按顺序取第一个非空；都取不到则回落首条用户消息 */
  title?: { paths: FieldPath[] }
  /** 时间戳字段 */
  timestamp?: { paths: FieldPath[] }
  /** 消息树用的 id / 父 id，缺省则按行序线性排列 */
  messageId?: { path: FieldPath }
  parentId?: { path: FieldPath }
  /** 子 agent 标记：命中则整条剔除，避免和主线交错 */
  sidechain?: Cond[]

  /** 产出规则 */
  rules: EmitRule[]

  /** 能力位：决定 UI 上哪些操作可用 */
  capabilities: {
    /** 能否在 Web 内续聊（目前只有 claude-code 实现并验证过） */
    resume: boolean
    /** 能否改标题（需要 provider 支持写回） */
    rename: boolean
    /** 能否删除（移入回收站，与格式无关） */
    delete: boolean
  }

  /** 在终端里继续该会话的命令模板，`{id}` / `{cwd}` 会被替换 */
  resumeCommand?: string
}

export type ProviderRuntimeInfo = ProviderConfig & {
  rootExists: boolean
  sessionCount: number
}
