#!/usr/bin/env node
/**
 * P0-③ cancel 语义实测：
 *  1. 发一个会缓慢流式的任务（mock 延迟 8s）
 *  2. 任务进行中调用 vendored session/cancel
 *  3. 断言：cancel 返回 accepted / 进程仍存活 / 会话可继续 / interrupted 事件落库
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const DSH = process.env.DSH_BIN || 'dsh'
const PATCH = process.env.POC_PATCH || '/app/combo.yml'
const CWD = process.env.POC_CWD || '/app/work'
const SID = process.env.POC_SID || `cancel-${Date.now()}`

const child = spawn(DSH, ['--profile', 'sdk', '--patch', PATCH], {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME || '/tmp/dsh-home' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stderr.write(`[dsh-err] ${d}`))
child.on('exit', (code, sig) => console.log(`[poc] CHILD EXIT code=${code} sig=${sig}`))

const events = []
let alive = true

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && m.method) {
    // server->client request（approval 等）
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: 'allowed-once' } }) + '\n')
    return
  }
  if (m.method === 'session.event') {
    const t = m.params?.event?.type
    events.push(t)
    if (['turn/end', 'step/end', 'assistant/message', 'assistant/attempt'].includes(t)) {
      console.log(`[poc] EV ${t}: ${JSON.stringify(m.params.event.data).slice(0, 260)}`)
    }
  }
  if (m.method === 'session.status') {
    console.log(`[poc] status: ${m.params?.status}`)
  }
})

let id = 0
const pending = new Map()
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && m.method === undefined) {
    const p = pending.get(m.id)
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
  }
})
function call(method, params, timeoutMs = 30000) {
  const rid = ++id
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error(`${method} timeout`)) } }, timeoutMs)
  })
}

;(async () => {
  await call('initialize', { cwd: CWD, provider: 'mock', model: 'mock-model' })
  console.log('[poc] initialize ok')

  const receipt = await call('session/prompt', { sessionId: SID, contentBlocks: [{ type: 'text', text: 'slow task' }] })
  console.log('[poc] prompt receipt:', JSON.stringify(receipt))

  // 等 3 秒（mock 延迟 8 秒，此时 turn 仍在进行）
  await new Promise((r) => setTimeout(r, 3000))
  console.log('[poc] before cancel: child killed?', child.killed, 'pid alive check...')

  try {
    const cancelRes = await call('session/cancel', { sessionId: SID }, 15000)
    console.log('[poc] CANCEL RESULT:', JSON.stringify(cancelRes))
  } catch (e) {
    console.log('[poc] CANCEL ERROR:', e.message)
  }

  // cancel 后再等 3 秒，观察事件
  await new Promise((r) => setTimeout(r, 3000))
  console.log('[poc] after cancel: child.killed?', child.killed, 'exitCode=', child.exitCode)

  // 关键断言：会话还能继续吗？
  try {
    const r2 = await call('session/prompt', { sessionId: SID, contentBlocks: [{ type: 'text', text: 'follow up after cancel' }] }, 20000)
    console.log('[poc] FOLLOW-UP AFTER CANCEL OK:', JSON.stringify(r2))
  } catch (e) {
    console.log('[poc] FOLLOW-UP FAILED:', e.message)
  }

  await new Promise((r) => setTimeout(r, 2000))
  console.log('\n===== CANCEL POC RESULT =====')
  console.log('events seen:', JSON.stringify(events))
  console.log('has turn/end:', events.includes('turn/end'))
  console.log('has interrupted-ish:', events.filter((t) => /interrupt|abort|cancel/.test(t || '')))
  child.kill('SIGKILL')
  process.exit(0)
})().catch((e) => { console.error('[poc] FAILED:', e.message); child.kill('SIGKILL'); process.exit(1) })
