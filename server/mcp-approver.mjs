/**
 * 权限审批 MCP server（由 claude CLI 通过 --mcp-config 启动的独立进程）。
 *
 * 链路：claude 想用工具 → 调这里的 approve 工具 → 我们 POST 给 Hono server
 *      → server 推 SSE 给浏览器弹窗 → 用户点击 → server 返回决定 → 这里回给 claude。
 *
 * 实测过的关键点：
 *  - 传给 claude 的 flag 是隐藏选项 --permission-prompt-tool mcp__<server>__<tool>
 *  - 返回值必须是单个 text content，内容为 JSON：
 *      {"behavior":"allow","updatedInput":{...}} 或 {"behavior":"deny","message":"..."}
 *  - 返回 deny 时工具确实不会执行（已用 Write 验证文件未被创建）
 *
 * 纯 JS 无依赖，被 spawn 时不需要经过 TS 编译。
 */
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'

const SERVER = process.env.CCS_SERVER || 'http://127.0.0.1:5274'
const TOKEN = process.env.CCS_TOKEN || ''
const SESSION_ID = process.env.CCS_SESSION_ID || ''
const LOGF = process.env.CCS_LOG || ''
/** 用户多久不点就自动拒绝。宁可拒绝也不要让 CLI 无限期挂住。 */
const TIMEOUT_MS = Number(process.env.CCS_APPROVAL_TIMEOUT_MS || 300_000)

const log = (...a) => {
  if (!LOGF) return
  try { appendFileSync(LOGF, `[${new Date().toISOString()}] ${a.join(' ')}\n`) } catch { /* noop */ }
}

const TOOL = {
  name: 'approve',
  description:
    'Ask the human operator to approve or deny a tool use request. Returns the permission decision.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool being requested' },
      input: { type: 'object', description: 'Input the tool would be called with' },
      tool_use_id: { type: 'string', description: 'Tool use id, if known' },
    },
    required: ['tool_name', 'input'],
  },
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

/** 把审批请求交给 Web UI，阻塞等待用户决定 */
async function askHuman(args) {
  const body = JSON.stringify({
    sessionId: SESSION_ID,
    toolName: args.tool_name,
    input: args.input ?? {},
    toolUseId: args.tool_use_id,
    timeoutMs: TIMEOUT_MS,
  })
  const res = await fetch(`${SERVER}/api/internal/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccs-token': TOKEN },
    body,
    // server 端会一直挂住直到用户点击或超时
    signal: AbortSignal.timeout(TIMEOUT_MS + 15_000),
  })
  if (!res.ok) throw new Error(`approval endpoint ${res.status}`)
  return await res.json()
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ccsperm', version: '0.1.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
    return
  }
  if (msg.method === 'tools/call') {
    const args = msg.params?.arguments || {}
    log('approval request:', args.tool_name, JSON.stringify(args.input || {}).slice(0, 300))
    let decision
    try {
      decision = await askHuman(args)
      log('decision:', JSON.stringify(decision))
    } catch (e) {
      // 服务器不可达或超时 —— 按拒绝处理，绝不默认放行
      log('approval failed, denying:', e.message)
      decision = { behavior: 'deny', message: `审批通道不可用（${e.message}），已默认拒绝` }
    }
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
    })
    return
  }
  if (msg.method && !msg.method.startsWith('notifications/')) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `not implemented: ${msg.method}` } })
  }
})

log(`mcp-approver started session=${SESSION_ID} server=${SERVER}`)
