#!/usr/bin/env node
/** 诊断：打印 DSH sdk profile 的全部事件与 stderr，定位工具模式卡点。 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')

const DSH = process.env.DSH_BIN || 'dsh'
const PATCH = process.env.POC_PATCH || '/app/poc-patch.yml'
const CWD = process.env.POC_CWD || '/app/work'
const PROVIDER = process.env.POC_PROVIDER || 'mock'
const MODEL = process.env.POC_MODEL || 'mock-model'
const TASK = process.argv[2] || 'Call the get_time tool'

const child = spawn(DSH, ['--profile', 'sdk', '--patch', PATCH], {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME || '/tmp/dsh-home' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stderr.write(`[dsh-err] ${d}`))

const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'session.event') {
    const e = m.params?.event
    const t = e?.type
    if (['turn/start', 'step/start', 'step/end', 'turn/end', 'request/context'].includes(t) ||
        String(t).startsWith('tool/') || String(t).startsWith('llm/') || String(t).startsWith('agent/')) {
      console.log(`EV ${t}: ${JSON.stringify(e.data).slice(0, 260)}`)
    }
  } else if (m.method) {
    console.log(`NOTIF ${m.method}: ${JSON.stringify(m.params).slice(0, 200)}`)
  } else {
    console.log(`RESP ${m.id}: ${JSON.stringify(m.result ?? m.error).slice(0, 220)}`)
  }
})

let id = 0
const call = (method, params) => {
  const rid = ++id
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
}

call('initialize', { cwd: CWD, provider: PROVIDER, model: MODEL })
setTimeout(() => call('session/prompt', { sessionId: `dbg-${Date.now()}`, contentBlocks: [{ type: 'text', text: TASK }] }), 2500)
setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, Number(process.env.POC_MAX_MS || 50000))
