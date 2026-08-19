/**
 * 环境体检：npm run doctor
 * 加 --live 会真实跑一轮 CLI，验证权限审批链路在**这台机器的这个 CLI 版本**上确实有效。
 * 这是唯一可靠的验证方式 —— --permission-prompt-tool 是隐藏参数，--help 里查不到。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { printChecks, resolveClaudeBin, runChecks } from './preflight.js'
import { PROJECTS_DIR, encodeProjectDir } from './paths.js'

console.log('\n=== cc-sessions 环境体检 ===\n')
const checks = runChecks()
printChecks(checks)

const hasFatal = checks.some((c) => c.level === 'fatal')
const live = process.argv.includes('--live')

if (!live) {
  console.log('\n提示：加 --live 可实测权限审批链路（会真实调用一次 API，产生少量费用）')
  console.log('      npm run doctor -- --live\n')
  process.exit(hasFatal ? 1 : 0)
}

if (hasFatal) {
  console.error('\n存在致命项，跳过实测。\n')
  process.exit(1)
}

console.log('\n--- 实测：权限审批链路 ---')

const bin = resolveClaudeBin()!
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-doctor-'))
const probeFile = path.join(tmpDir, 'doctor-probe.txt')

// 一次性的审批器：固定返回 deny。deny 比 allow 更有说服力 ——
// 如果链路没生效，工具会照常执行、文件会被创建。
const approverSrc = `
import readline from 'node:readline'
import { appendFileSync } from 'node:fs'
const LOG = ${JSON.stringify(path.join(tmpDir, 'approver.log'))}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const TOOL = { name: 'approve', description: 'approve or deny', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'doctor', version: '1' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [TOOL] } })
  else if (m.method === 'tools/call') {
    appendFileSync(LOG, 'CALLED ' + JSON.stringify(m.params?.arguments ?? {}) + '\\n')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'doctor 探测：拒绝' }) }] } })
  } else if (m.method && !m.method.startsWith('notifications/')) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } })
})
`
const approverPath = path.join(tmpDir, 'approver.mjs')
fs.writeFileSync(approverPath, approverSrc)

const mcpConfig = JSON.stringify({
  mcpServers: { doctor: { command: process.execPath, args: [approverPath] } },
})

const child = spawn(bin, [
  '-p', `用 Write 工具在 ${probeFile} 写入 doctor-probe。不要做别的事。`,
  // 体检不该在用户的历史里留下垃圾会话（否则会多出一个 ccs-doctor-xxx 项目）
  '--no-session-persistence',
  '--output-format', 'stream-json', '--verbose',
  '--mcp-config', mcpConfig,
  '--permission-prompt-tool', 'mcp__doctor__approve',
], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'] })

let sawResult = false
let cliError = ''
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  try {
    const ev = JSON.parse(line) as Record<string, unknown>
    if (ev.type === 'result') sawResult = true
  } catch { /* 非 JSON 行忽略 */ }
})
child.stderr.on('data', (d: Buffer) => { cliError += d.toString() })

const timer = setTimeout(() => {
  child.kill('SIGKILL')
  console.error('❌ 超时（180s），CLI 无响应')
}, 180_000)

child.on('close', () => {
  clearTimeout(timer)
  const approverCalled = fs.existsSync(path.join(tmpDir, 'approver.log'))
  const fileCreated = fs.existsSync(probeFile)

  console.log(`  CLI 完成一轮        ${sawResult ? '✅' : '❌'}`)
  console.log(`  审批器被调用        ${approverCalled ? '✅' : '❌'}`)
  console.log(`  拒绝后文件未创建    ${!fileCreated ? '✅' : '❌'}`)

  const pass = sawResult && approverCalled && !fileCreated
  if (pass) {
    console.log('\n✅ 权限审批链路在这台机器上工作正常，Web 内续聊可放心使用。\n')
  } else {
    console.error('\n❌ 权限审批链路异常。')
    if (!approverCalled) {
      console.error('   审批器没被调用 —— 多半是这个 CLI 版本改动了 --permission-prompt-tool。')
      console.error('   影响：Web 内续聊时需要授权的工具会被直接拒绝（只读浏览不受影响）。')
    } else if (fileCreated) {
      console.error('   已拒绝但工具仍然执行了 —— 这是安全问题，请勿在此机器上使用 Web 续聊。')
    }
    if (cliError.trim()) console.error('   CLI stderr:', cliError.trim().slice(0, 400))
    console.error('')
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
  // 即使加了 --no-session-persistence，CLI 仍会为 cwd 建一个空的项目目录。
  // 没有 .jsonl 所以不会出现在界面里，但也别留在 ~/.claude/projects 下。
  try {
    const leftover = path.join(PROJECTS_DIR, encodeProjectDir(tmpDir))
    if (fs.existsSync(leftover) && !fs.readdirSync(leftover).some((f) => f.endsWith('.jsonl'))) {
      fs.rmSync(leftover, { recursive: true, force: true })
    }
  } catch { /* 清不掉也无所谓，空目录不影响功能 */ }
  process.exit(pass ? 0 : 1)
})
