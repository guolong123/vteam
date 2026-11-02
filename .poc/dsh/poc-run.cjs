#!/usr/bin/env node
/**
 * P0 POC：用 DSH sdk profile 跑一轮真实任务，验证：
 *  - session.event 事件流形状（assistant/message 是否带 usage）
 *  - turn/end 终态与 reason.kind
 *  - session.status idle 收口
 *  - 工具调用是否发生
 * 用法：node poc-run.js "<task>"
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const DSH = process.env.DSH_BIN || 'dsh'
const PATCH = process.env.POC_PATCH || '/app/poc-patch.yml'
const TASK = process.argv[2] || 'Reply with exactly: PONG'
const CWD = process.env.POC_CWD || '/app/work'

const DSH_ARGS = ['--profile', 'sdk']
if (!process.env.POC_NO_PATCH) DSH_ARGS.push('--patch', PATCH)
const child = spawn(DSH, DSH_ARGS, {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME || '/tmp/dsh-home' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const seen = { types: new Map(), usageSamples: [], turnEnd: null, final: null }
let id = 0
const pending = new Map()

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result) }
    return
  }
  if (msg.id !== undefined && msg.method) {
    // server->client request：approval/request / user-question/ask
    seen.serverRequests = seen.serverRequests || []
    seen.serverRequests.push({ method: msg.method, params: msg.params })
    console.log('[poc] server->client request:', msg.method, JSON.stringify(msg.params).slice(0, 300))
    const rid = msg.id
    if (msg.method === 'approval/request') {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, result: { outcome: 'allowed-once' } }) + '\n')
    } else if (msg.method === 'user-question/ask') {
      const qs = msg.params?.questions || []
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, result: { answers: qs.map(q => ({ id: q.id, selected: (q.options||[])[0]?.id })) } }) + '\n')
    } else {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: 'unsupported' } }) + '\n')
    }
    return
  }
  if (msg.method === 'session.event') {
    const ev = msg.params?.event
    const t = ev?.type || '?'
    seen.types.set(t, (seen.types.get(t) || 0) + 1)
    if (t === 'assistant/message') {
      const u = ev.data?.usage
      seen.usageSamples.push(u ? { input: u.input, output: u.output, total: u.total ?? u.totalTokens, raw: u } : null)
    }
    if (t === 'turn/end') seen.turnEnd = ev.data?.reason
    if (t.startsWith('tool/')) seen.types.set('TOOL:'+t, JSON.stringify(ev.data).slice(0,220))
    if (t === 'assistant/message') {
      const m = ev.data?.message
      seen.assistantContent = JSON.stringify(m?.content ?? m).slice(0,400)
    }
  }
  if (msg.method === 'session.status') {
    const p = msg.params
    if (p?.status === 'idle') seen.final = 'idle'
  }
})

child.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`))

function call(method, params) {
  const rid = ++id
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error(`${method} timeout`)) } }, 180000)
  })
}

;(async () => {
  await call('initialize', { cwd: CWD, provider: process.env.POC_PROVIDER || 'opencode-go', model: process.env.POC_MODEL || 'deepseek-v4.1-flash' })
  console.log('[poc] initialize ok')

  const q = await call('session/prompt', { sessionId: process.env.POC_SID || 'poc-1', contentBlocks: [{ type: 'text', text: TASK }] })
  console.log('[poc] prompt receipt:', JSON.stringify(q))
  // session/wait：等 root idle 且后代工作结束
  try {
    await call('session/wait', { sessionId: process.env.POC_SID || 'poc-1' })
    console.log('[poc] session/wait returned')
  } catch (e) { console.log('[poc] session/wait err:', e.message) }

  // 等 idle 或超时
  const deadline = Date.now() + 180000
  while (Date.now() < deadline && !seen.final) await new Promise((r) => setTimeout(r, 300))

  console.log('\n===== POC RESULT =====')
  console.log('event types:', JSON.stringify(Object.fromEntries(seen.types)))
  console.log('turn/end reason:', JSON.stringify(seen.turnEnd))
  console.log('idle seen:', seen.final)
  console.log('assistant/message usage samples:', JSON.stringify(seen.usageSamples, null, 1))
  console.log('assistant content:', seen.assistantContent)
  for (const [k,v] of seen.types) if (k.startsWith('TOOL:')) console.log(k, v)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'shutdown' }) + '\n')
  setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 3000)
})().catch((e) => { console.error('[poc] FAILED:', e.message); child.kill('SIGKILL'); process.exit(1) })
