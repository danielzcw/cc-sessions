# cc-sessions

多 CLI 会话管理器。统一浏览 **Claude Code / Codex / omp** 的历史会话，可自由切换来源，
也能**在页面上配置新的 CLI**（无需改代码）。按项目分组、全文搜索、分支对比、成本看板、
删除与还原、会话改名；Claude Code 还支持**直接在 Web 里续聊或新建会话**（带权限审批弹窗）。

## 前置要求（macOS）

| 项 | 要求 | 为什么 |
|---|---|---|
| macOS | 必需 | 活跃会话检测依赖 BSD 版 `ps` 的输出格式 |
| Node | **≥ 22.5.0** | 用内置 `node:sqlite`（免原生编译），该模块 22.5 才引入 |
| Claude Code CLI | 已安装并能跑 | 续聊直接 spawn 它，复用其鉴权/hooks/MCP/skills |

```bash
npm install
npm run doctor          # 先体检：Node 版本、claude 位置、会话目录
npm run doctor -- --live # 可选：真实验证权限审批链路（会产生少量 API 费用）
npm run dev             # 后端 :5274 + 前端 :5273
open http://localhost:5273
```

生产模式：`npm run build && npm start`（单进程，静态资源由 Hono 托管，访问 :5274）。

### 换一台 Mac 需要注意

- **claude 的位置不固定**，代码不写死 `claude`，按顺序找：
  `CCS_CLAUDE_BIN` → PATH → `~/.local/bin`（原生安装器）→
  `/opt/homebrew/bin`（Apple Silicon）→ `/usr/local/bin`（Intel）→ `~/.claude/local` → npm 全局 prefix。
  都找不到就在启动时明确报错退出（退出码 1），不会崩出栈追踪。
- **端口可能被占用**：`PORT`（后端，默认 5274）、`WEB_PORT`（前端，默认 5273）。
  vite 的代理目标会跟着 `PORT` 自动走，不用改配置文件。
- **配置目录**：默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 指向别处（多账号/隔离测试用）。
- **全新机器**（从没用过 Claude Code）：能正常启动，界面为空；跑完第一个会话会被自动发现，
  无需手动刷新。
- 环境变量可写进项目根的 `.env`。

### 唯一的真实兼容性风险

Web 内**续聊**依赖隐藏参数 `--permission-prompt-tool`，它不在 `--help` 里，官方无兼容承诺。
CLI 自动升级后有可能失效（本项目开发期间 CLI 就从 2.1.223 升到了 2.1.228，重测后仍正常）。

- 失效的表现：续聊时需要授权的工具**全部被拒绝**（而不是静默放行，安全侧是保守的）
- **只读功能不受影响**：浏览、搜索、分支对比、成本统计、删除全都只读解析文件，与 CLI 版本无关
- 换机器或升级后跑 `npm run doctor -- --live` 就能确认

---

## 支持的 CLI

| CLI | 会话位置 | 记录形态 | 续聊 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd>/` | `type=user/assistant` | ✅ Web 内 |
| Codex | `~/.codex/sessions/Y/M/D/rollout-*` | `{timestamp,type,payload}` | 终端 `codex resume` |
| omp | `~/.omp/agent/sessions/<cwd>/` | `{type,id,parentId,message}` | 终端 `omp --resume` |
| 自定义 | 页面上配 | 规则描述 | 视 CLI 而定 |

**codex 与 omp 没有专用代码**，它们就是两份声明式规则配置（`server/providers/builtins.ts`），
和你在页面上添加的 CLI 走同一个引擎。这样 DSL 的表达力被真实格式验证过 ——
撑不住 codex 的规则也撑不住别人的 CLI。

只有 Claude Code 用专用解析器：它需要 tool_result 回填、`/rewind` 分支树、
`custom-title` 写回，这些超出声明式规则的范围。

### 在页面上添加一个 CLI

「来源」页 →「添加自定义 CLI」，填一份规则配置，**先点「试跑」**看真实解析结果再保存：

```jsonc
{
  "id": "my-cli", "name": "My CLI", "enabled": true,
  "kind": "generic-jsonl",
  "root": "~/.my-cli/sessions",     // 会话根目录
  "glob": "*/*.jsonl",              // 相对 root 的匹配，支持 * 与 **
  "sessionId": { "from": "filename", "filenameRegex": "_([0-9a-f-]{36})$" },
  "cwd":   { "paths": ["cwd"] },    // 点号路径，[] 展开数组
  "title": { "paths": ["title"] },
  "rules": [
    { "when": [{ "path": "type", "equals": "message" }],
      "emit": "text", "rolePath": "message.role",
      "textPaths": ["message.content[].text", "message.content"] }
  ],
  "capabilities": { "resume": false, "rename": false, "delete": true },
  "resumeCommand": "my-cli resume {id}"
}
```

引擎对每条记录**依次尝试所有规则并累积产出**，而不是首条命中即停 ——
omp 的一条 message 里 `content[]` 同时混着 text / thinking / toolCall，
首条命中就会丢内容。

内置项的规则以代码为准，只保存你改过的字段（开关、根目录、名称、颜色、续聊命令），
这样 CLI 改格式时更新代码即可生效，不会被旧配置盖住。

### 配规则时踩过的坑

- **codex 的 `event_msg` 会把对话再发一遍**（某会话 `response_item` 16 条 vs `event_msg` 85 条），
  规则必须同时限定 `type=response_item`，否则全量重复
- **codex 的 `reasoning.summary` 是空数组**，真内容在 `encrypted_content` 里读不到，所以不取
- **omp 的 user 消息 `content` 是纯字符串**，assistant 是对象数组 → `textPaths` 两种都要给
- **文本提取只认字符串**：若把对象数组 JSON 化当正文，气泡里会出现
  `{"type":"thinking",...}` 这种原始结构
- **工具块必须有真实工具名才产出**，否则 omp 的 tool 规则会给每条纯文本消息挂一个空工具块
- omp 的子 agent 会话嵌在 `<父会话id>/<Agent>.jsonl`，`*/*.jsonl` 正好排除掉它们
  （想单独浏览就再配一个 `*/*/*.jsonl` 的来源）

## 架构

```
web/            Vite + React
  useChat.ts    SSE 订阅 + 乐观更新 + 审批状态机
  components/   Blocks(折叠渲染+diff) / Transcript(虚拟滚动) / SessionList / SearchView
                StatsView / ApprovalDialog / NewSessionDialog / BranchDiff
server/         Hono 单进程
  providers/    builtins(内置规则) / generic(规则引擎) / registry(配置读写) / probe(试跑)
  parser.ts     Claude Code 专用解析器：tool_result 回填、分支树
  db.ts         node:sqlite + FTS5，增量索引与搜索
  scanner.ts    按 mtime 增量扫描 + 活跃会话探测
  runner.ts     spawn claude CLI，双向 stream-json
  mcp-approver.mjs  权限审批 MCP server（由 CLI 启动的独立进程）
shared/types.ts 前后端共享契约
shared/diff.ts  LCS 行级 diff（Edit 改动渲染与分支对比共用）
```

**数据来源分两条路，不要混淆：**

| 能力 | 来源 | 原因 |
|---|---|---|
| 列表 / 搜索 / 回看 | 直接解析各 CLI 的会话 jsonl | CLI **没有**非交互的会话列表命令。`-r/--resume` 不带参数是交互式 TUI picker，`claude agents --json` 只管后台 agent |
| 续聊 | `spawn claude -p --resume <id>` | 复用 CLI 自身的鉴权、hooks、MCP、skills，行为与终端一致 |
| 活跃检测 | `~/.claude/sessions/<pid>.json` + `ps` | 判断哪些会话不能 resume |

---

## 会话文件格式（实测结论）

- **文件名 = sessionId，一个文件恰好一个会话**（151 个文件校验无例外）
- 目录名 = cwd 把 `/` 和 `.` 都替换成 `-`，**不可逆**
  （`/Users/x/.claude/skills/y` → `-Users-x--claude-skills-y`）
  → 永远从记录里的 `cwd` 字段取路径，不要反解目录名
- macOS 大小写不敏感，`Daniel/` 与 `daniel/` 会生成两个目录却是同一项目 → 按归一化 cwd 合并分组
- 消息是**树**不是列表：`parentUuid` 链接，`/rewind` 产生分叉，`last-prompt.leafUuid` 指向当前叶子
- `isSidechain: true` 是子 agent 的内部往来，主视图必须剔除
- 元信息记录类型：`ai-title`、`custom-title`（标题已存在文件里，不必自己生成）、`last-prompt`、`mode`、`permission-mode`、`queue-operation`、`attachment`、`file-history-snapshot`
- content block：assistant = `text` / `thinking` / `tool_use`；user = `string` | `[tool_result]` | `[image, text]`
- `~/.claude/history.jsonl` 是扁平 prompt 索引（带 `project` + `sessionId` + `timestamp`），适合做冷启动列表

---

## spawn CLI 的坑（都踩过）

1. **可变参数会吞掉 prompt。** `--tools` / `--allowedTools` / `--add-dir` / `--agents` 都是 variadic，
   `claude -p --tools "" "你的问题"` 里问题会被当成 tools 的值，报
   `No deferred tool marker found in the resumed session`。
   → 本项目统一用 `--input-format stream-json` 从 stdin 送 prompt，不走位置参数。
2. **必须处理 stdin。** 不给就卡 3 秒警告；一次性调用加 `< /dev/null`。
3. **不能 resume 正在运行的会话**，会直接失败。所以 `/api/chat/:id/send` 会先查活跃会话并返回 409。
4. **单进程可多轮。** stdin 保持打开，每轮产出一个 `result` 事件；不加 `--fork-session` 时
   `session_id` 保持不变并追加写回原 jsonl，上下文正确延续。
5. `--fork-session` 会生成新 sessionId（在 `system/init` 里返回）→ 前端需跟随跳转，否则用户
   对着一个不再写入的 id 说话。
6. `system/init` 事件带 model、cwd、permissionMode、tools、mcp_servers、slash_commands，
   基本能撑起整个「会话设置」面板。

---

## 权限审批怎么实现的

`-p` 模式下默认**没有审批通道**，凡需人工确认的工具调用都会返回
`system/permission_denied`（"you haven't granted it yet"）。

解法是隐藏 flag `--permission-prompt-tool`，把判定权交给一个我们自己提供的 MCP 工具：

```
claude 想用工具
  → 调 mcp__ccsperm__approve（server/mcp-approver.mjs）
  → POST /api/internal/approval（带共享 token）
  → Hono 挂住请求，推 SSE 给浏览器弹窗
  → 用户点允许/拒绝 → POST /api/chat/:id/approve
  → 决定回传给 MCP → 返回给 claude
```

MCP 工具的返回值必须是单个 text content，内容为 JSON：

```json
{"behavior":"allow","updatedInput":{...}}
{"behavior":"deny","message":"..."}
```

已验证 deny 时工具**确实不执行**（Write 的目标文件未被创建）。

安全边界：
- 服务默认只绑 `127.0.0.1`
- **路径穿越防护**：所有会话 id 都会被拼进文件路径，因此在 HTTP 边界强制校验为 UUID，
  scanner 内部再做一层路径包含校验。缺了这层校验时，
  `DELETE /api/trash/<../../..>` 可删除任意 `.jsonl`/`.meta.json`，
  `GET /api/sessions/<../../..>/export` 可读取任意 `.jsonl`（均已实测并修复）
- `/api/internal/approval` 校验共享 token
- 审批 5 分钟不响应自动**拒绝**；审批通道不可达时也**默认拒绝**，绝不放行
- 会话正文渲染过 DOMPurify —— 正文含抓取的网页与文件内容，属不可信输入，
  而本服务暴露了批准接口，XSS 可升级为任意代码执行

---

## 搜索

`node:sqlite` 自带 FTS5，免原生编译。但默认分词器切不开中文，所以用 `tokenize='trigram'`。

trigram 需要 ≥3 个字符，**2 字中文查询（如"历史"）匹配不到** → 短查询自动退化为 `LIKE` 扫描。
命中片段用控制字符 U+0001/U+0002 包裹（而非 `<b>`），前端按数组渲染，天然免疫注入。

---

## 成本统计说明

历史 jsonl **不含 cost 字段**，只有每条消息的 `usage`。看板数字是
`usage × 官方单价` 的**估算**，注意：

- 会话的代表模型取「输出 token 占比最大」的模型，不是最后出现的
  （末尾常是 `<synthetic>` 本地合成消息，会把整个会话成本错误归到它名下）
- `<synthetic>` 不计费（无真实 API 调用）
- 只有本 App 内新产生的轮次才有 CLI 返回的**真实** `total_cost_usd`

---

## 新建会话

「新建会话」可选 CLI 与工作目录，但**只有 `capabilities.resume` 的 provider 能在 Web 内开** ——
那需要接管该 CLI 的对话协议与权限审批。其余 provider 给出在该目录启动它的终端命令
（`newSessionCommand`，如 `cd {cwd} && codex`），跑完刷新即可在列表里看到。
服务端同样校验，不支持的来源返回 400 并附带该命令。

`--session-id <uuid>` 是可用的（实测 CLI 会采纳该 id，并把文件落到 cwd 派生的项目目录）。
所以流程是：前端选 cwd → `POST /api/sessions/new` 生成 uuid 并登记为 **draft** →
用户发第一条消息时才真正 spawn，首轮用 `--session-id`，之后自动切回 `--resume`。

draft 阶段磁盘和索引里都还没有这个会话，因此 `/api/sessions/:id`、`/stream`、`/send`
在 DB 查不到时会回退到 runner registry 里登记的 cwd，返回一个空壳详情让界面能进聊天页。

## 虚拟滚动

超过 60 条才启用（短会话全渲染，避免测量抖动）。实测 288 条消息、容器 4.3 万 px 高时，
任意滚动位置只渲染 12–27 个 DOM 节点。

两个坑：

1. **不要在 `useLayoutEffect` 里调 `virtualizer.scrollToIndex()`** —— 它内部走 `flushSync`，
   会报 `flushSync was called from inside a lifecycle method`。直接改 `scrollTop` 即可。
2. **虚拟列表总高是逐帧收敛的**：初始按估高算，item 挂载后换真实高度，而贴底又会让新 item
   进视口触发新测量。固定跑两帧会差几百 px，要循环到「高度连续 5 帧不变」才算稳定。

## 分支对比

`/rewind` 会在同一个 jsonl 里留下多条分支（同一 `parentUuid` 有多个子节点）。
`GET /api/sessions/:id/branch-diff?a=&b=` 返回两条链的消息与拍平文本，
前端用 `shared/diff.ts` 的 LCS 行级 diff 渲染，另提供「并排原文」视图。

`shared/diff.ts` 同时被 Edit 工具的改动渲染复用（原本是「全部旧行 + 全部新行」的粗糙输出）。
带公共前后缀剥离与 400 万单元格上限保护，超限退化为整块替换，避免大文件卡死页面。

## 重命名会话

往 jsonl 追加一条 CLI 自己的 `custom-title` 记录：

```json
{"type":"custom-title","customTitle":"新标题","sessionId":"..."}
```

所以改完在终端里也一致 —— `claude --resume` 的选择器读的是同一个字段。
标题优先级：`custom-title` > `ai-title` > 首条 prompt 截断。

- 列表行 hover 出现 ✎，或在会话正文里直接点标题
- 回车提交、Esc 取消、失焦提交
- **留空 = 恢复默认**（解析器把空白 customTitle 视为未设置，回落到 AI 标题）
- 正在终端里运行的会话不允许改名（CLI 进程可能正在写同一个文件）

只追加、不重写文件 —— jsonl 本就是仅追加的事件日志，这是最不具侵入性的写法。
实测验证过：改名后文件每行仍是合法 JSON，且 **CLI 能正常 resume、上下文完好**。

两个容易踩的点：

- 追加前要检查文件末尾有没有换行符，否则会把新记录和最后一行粘成一行
- 标题里的换行/制表符必须过滤，否则破坏 jsonl 的一行一记录结构

## 删除与回收站

删除**不做硬删除** —— 会话历史不可再生，误删无法恢复。流程是移到
`~/.claude/cc-sessions/trash/`，同时写一份 `<id>.meta.json` 记录原始路径，
「还原」把文件放回原位并重建索引。回收站不自动清理，需手动「彻底删除」。

回收站页（侧栏「回收站」tab）可对每条做**还原**或**彻底删除**。

两层防误触：

- **有内容的会话弹二次确认**，空会话（0 条）直接删
- 删除后 15 秒内可点撤销条还原

> 开发期间实测过一次意外删除，靠回收站完整还原了 —— 这个设计不是多余的。

删除时的**顺序很关键**：必须先收掉本 App 自己 spawn 的子进程再判断占用。
runner 为了支持多轮对话会让子进程一直挂着，它写的 `~/.claude/sessions/<pid>.json`
会让会话看起来「正在终端里运行」，反过来判断就永远删不掉自己刚聊过的会话。

活跃检测也因此加了两道校验：

- 用 `ps -axo pid=,lstart=,comm=` 拿进程真实启动时间，与 pid 文件里的 `startedAt`
  比对（差超过 5 分钟视为 pid 已被回收，文件是陈旧的）
- 本 App 自己 spawn 的 pid 单独登记并排除

## 路径显示

- **会话列表**：选「全部项目」时每行显示 cwd；按项目筛选后隐藏（每行都一样，纯噪音）
- **会话正文**：路径放在固定表头里，正文滚动后依然可见，点击复制完整路径
- 列表筛选框同时匹配标题、首条 prompt 和路径

## 布局上的一个坑

统计页和回收站页不渲染中间栏。此时网格必须是**两列** `232px 1fr`；
写成 `232px 0 1fr`（保留中间列宽度为 0）会让 `<main>` 落进那个 0 宽度的列 ——
DOM 里内容齐全，页面却整片空白，非常难查。

## 模型选择

输入区可切模型。CLI **没有列模型的命令**（`claude models` 会被当成 prompt 执行掉），
所以候选项由两部分组成：`--help` 文档里的别名（opus / sonnet / fable / haiku）
＋ 索引里真实出现过的具体版本（如 claude-opus-4-7）。默认项跟随
`~/.claude/settings.json` 的 `model` 字段。

`--model` 只能在进程启动时给，所以切换会**收掉现有子进程让下一轮重开**；
正在生成时禁止切换，避免打断当前回答。

## 设置中心

侧栏「设置」下分两块：

- **CLI 来源** —— 增删改启停 provider（含试跑）
- **MCP / 技能 / 插件** —— 各 CLI 的能力清单，带配置文件路径

写回策略保守，只开放**确定安全**的一处：

| 目标 | 位置 | 可写 | 原因 |
|---|---|---|---|
| Claude 插件开关 | `settings.json` `enabledPlugins` | ✅ | 纯 JSON 布尔表，改动可预测；写前备份，且拒绝新增不存在的键 |
| Claude MCP | `~/.claude.json` | 只读 | 那是 CLI 的活动状态文件，增删请用 `claude mcp` |
| Codex MCP / 插件 | `config.toml` | 只读 | 安全写回 TOML 需要真正的解析器 |
| 技能 | 各 `skills/` 目录 | 只读 | 技能是目录，「停用」不是标准操作 |

只读项一律把配置路径显在界面上，方便直接编辑。MCP 的 env **只列键名不列值** ——
配置里常有 token。

技能枚举支持两级目录：`skills/<name>/SKILL.md` 与 `skills/<pack>/<name>/SKILL.md`
（codex 的 gstack 既是技能又是技能包，只看顶层会漏掉几十个）。

## 能力位

每个 provider 声明自己支持什么，UI 据此显示/禁用按钮，**服务端也会拒绝**
（前端隐藏按钮不算防护）：

- `resume`：能否在 Web 内续聊。目前只有 Claude Code —— 续聊要接管该 CLI 的权限审批协议，
  其他 CLI 未实现也未验证，界面上直接给出终端命令（点击复制）
- `rename`：改标题需要 provider 支持写回，Claude Code 用 `custom-title` 记录
- `delete`：移入回收站，与格式无关，全部支持
- 「运行中」检测读 `~/.claude/sessions` 的 pid 文件，只对 Claude Code 有意义

成本统计只有 Claude Code 有数据（它的 jsonl 里带 `usage`），codex / omp 记 0。

## 数据目录

`~/.cc-sessions/`（索引 + 回收站 + `providers.json`）。

早期在 `~/.claude/cc-sessions/`，现在要管多个 CLI，寄居在 claude 的配置目录下名不正言不顺，
所以移了出来并自动迁移回收站。索引会自动重建，schema 变更直接 drop 重建，不写迁移逻辑。

## 已知限制

- 只有 Claude Code 支持 Web 内续聊，其余给终端命令
- 通用规则引擎不做 tool_use/result 配对与分支检测（各 CLI 关联字段与 rewind 语义差异太大）
- 分支对比只支持「非主干分支 ↔ 主干」两两比，未做任意两条分支的自由组合
- 新建会话不能指定 model / permission-mode，走 CLI 默认值
- 改动 `parser.ts` 或计价逻辑后需 `POST /api/rescan?full=1` 强制全量重解析，
  否则文件 mtime 未变会命中增量缓存
