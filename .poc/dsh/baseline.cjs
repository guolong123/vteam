#!/usr/bin/env node
/**
 * P0-④ 资源基线：启动 sdk 运行时 → 完成一轮任务 → 采样进程 RSS/CPU。
 * 同时打印 sandbox/mode 事件（确认沙箱降级链实际落在哪一级）。
 */
const { spawn, execSync } = require('node:child_process')
const readline = require('node:readline')
const fs = require('node:fs')

const DSH = process.env.DSH_BIN || 'dsh'
const PATCH = process.env.POC_PATCH || '/app/combo.yml'
const CWD = process.env.POC_CWD || '/app/work'
const SID = `base-${Date.now()}`

const t0 = Date.now()
const child = spawn(DSH, ['--profile', 'sdk', '--patch', PATCH], {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME || '/tmp/dsh-home' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const marks = {}
child.on('spawn', () => { marks.spawn = Date.now() - t0 })

let sandboxMode = null
const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && m.method) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: 'allowed-once' } }) + '\n')
    return
  }
  if (m.method === 'session.event') {
    const e = m.params?.event
    if (e?.type === 'sandbox/mode') sandboxMode = e.data
    if (e?.type === 'turn/end') marks.turnEnd = Date.now() - t0
    if (e?.type === 'assistant/message') marks.assistantMessage = Date.now() - t0
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
const call = (method, params, ms = 60000) => {
  const rid = ++id
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error(`${method} timeout`)) } }, ms)
  })
}

function rssOf(pid) {
  try {
    const out = execSync(`cat /proc/${pid}/status 2>/dev/null | grep VmRSS`, { encoding: 'utf8' })
    const kb = Number(out.replace(/[^0-9]/g, ''))
    return kb ? Math.round(kb / 1024) : null
  } catch { return null }
}
function treeRss(pid) {
  // 采样主进程 + 子进程（DSH 会 spawn 工具子进程）
  let total = 0, found = []
  try {
    const kids = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    for (const k of [pid, ...kids.map(Number)]) {
      const r = rssOf(k)
      if (r) { total += r; found.push(`${k}:${r}MB`) }
    }
  } catch {}
  return { total, found }
}

;(async () => {
  await call('initialize', { cwd: CWD, provider: 'mock', model: 'mock-model' })
  marks.initialize = Date.now() - t0
  const memAfterInit = treeRss(child.pid)

  await call('session/prompt', { sessionId: SID, contentBlocks: [{ type: 'text', text: 'reply PONG' }] })
  marks.promptReceipt = Date.now() - t0

  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !marks.turnEnd && !marks.assistantMessage) {
    await new Promise((r) => setTimeout(r, 200))
  }
  await new Promise((r) => setTimeout(r, 1500))
  const memAfterTurn = treeRss(child.pid)

  console.log('\n===== P0-④ 资源基线 =====')
  console.log('pid:', child.pid)
  console.log('sandbox/mode event:', JSON.stringify(sandboxMode))
  console.log('timings(ms):', JSON.stringify(marks))
  console.log('first-token-ish (prompt→assistant/message):',
    marks.assistantMessage && marks.promptReceipt ? marks.assistantMessage - marks.promptReceipt : 'n/a')
  console.log('RSS after initialize:', memAfterInit.total, 'MB', memAfterInit.found.join(' '))
  console.log('RSS after one turn:', memAfterTurn.total, 'MB', memAfterTurn.found.join(' '))
  console.log('node version:', process.version)
  child.kill('SIGKILL')
  process.exit(0)
})().catch((e) => { console.error('[poc] FAILED:', e.message); child.kill('SIGKILL'); process.exit(1) })
