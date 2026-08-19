# cc-sessions

Claude Code CLI 历史会话管理器。按项目分组浏览、全文搜索、分支树与分支对比、成本看板、
会话删除（回收站可还原），支持**直接在 Web 里续聊或新建会话**（带工具权限审批弹窗），
长会话虚拟滚动。

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

## 架构

```
web/            Vite + React
  useChat.ts    SSE 订阅 + 乐观更新 + 审批状态机
  components/   Blocks(折叠渲染+diff) / Transcript(虚拟滚动) / SessionList / SearchView
                StatsView / ApprovalDialog / NewSessionDialog / BranchDiff
server/         Hono 单进程
  parser.ts     jsonl 事件日志 → 气泡视图模型（本项目的核心）
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
| 列表 / 搜索 / 回看 | 直接解析 `~/.claude/projects/**/*.jsonl` | CLI **没有**非交互的会话列表命令。`-r/--resume` 不带参数是交互式 TUI picker，`claude agents --json` 只管后台 agent |
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

## 已知限制

- 分支对比只支持「非主干分支 ↔ 主干」两两比，未做任意两条分支的自由组合
- 新建会话不能指定 model / permission-mode，走 CLI 默认值
- 改动 `parser.ts` 或计价逻辑后需 `POST /api/rescan?full=1` 强制全量重解析，
  否则文件 mtime 未变会命中增量缓存
