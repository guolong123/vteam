// steer 隔离验证：在回合进行中注入，看是否被消费（容器内运行）
// 用法：node /tmp/steer-test.mjs
import { spawn } from 'node:child_process';

const DSH = 'dsh';
const PATCH = '/tmp/steer-patch.yml';
const HOME = process.env.DSH_HOME;

const child = spawn(DSH, ['--profile', 'sdk', '--patch', PATCH], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[dsh-err] ' + d));

let id = 0;
const pend = new Map();
const events = [];

child.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && m.method === undefined) {
      const p = pend.get(m.id);
      if (p) {
        pend.delete(m.id);
        p(m);
      }
    } else if (m.method === 'session.event') {
      const ev = m.params?.event;
      const t = ev?.type;
      events.push(t);
      if (t === 'user/message') {
        const txt = JSON.stringify(ev.data?.message?.content ?? '').slice(0, 120);
        console.log('[event] user/message:', txt);
      }
      if (t === 'turn/end') {
        console.log('[event] turn/end:', JSON.stringify(ev.data).slice(0, 150));
      }
    }
  }
});

const call = (method, params, timeoutMs = 60000) => {
  const rid = ++id;
  return new Promise((resolve) => {
    pend.set(rid, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
    setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 主流程
const init = await call('initialize', {
  cwd: '/tmp',
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
});
console.log('init:', JSON.stringify(init).slice(0, 100));

// 1) 发起一个**长任务**（要求写长文，让回合持续）
const sid = 'steer-test-1';
const p1 = await call('session/prompt', {
  sessionId: sid,
  contentBlocks: [{ type: 'text', text: '请写一篇 800 字关于分布式系统的介绍，要求详尽。' }],
});
console.log('prompt1:', JSON.stringify(p1).slice(0, 100));

// 2) 等待回合真正开始（看到 turn/start 后再过一会）
await sleep(6000);
console.log('--- 注入 steer（回合进行中）---');

// 3) 在途注入
const steer = await call('session/steer', {
  sessionId: sid,
  contentBlocks: [{ type: 'text', text: '【打断】请立刻改为只回复两个字：STEERED' }],
});
console.log('steer:', JSON.stringify(steer).slice(0, 150));

// 4) 等待观察是否被消费
await sleep(20000);

console.log('--- 结果 ---');
console.log('事件类型:', [...new Set(events)].join(','));
const userMsgs = events.filter((t) => t === 'user/message').length;
console.log('user/message 数量:', userMsgs, '（>1 说明 steer 被当作新 user 消息注入）');

child.kill('SIGKILL');
process.exit(0);
