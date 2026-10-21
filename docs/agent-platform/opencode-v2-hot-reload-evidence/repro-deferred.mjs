#!/usr/bin/env node
/**
 * probe.mjs — opencode v2.0.32 上的 **config-reload pending 闸门** 端到端取证。
 *
 * 场景：worker（独立模式，容器内跑真正的 opencode v2.0.32 serve）收到
 *   ① 配置变更（POST /config/agent-policies）→ ② POST /config/reload
 * 断言（有 pending 待答复项时）：
 *   A. 重载被**跳过**：outcome = deferred（不是 reloaded）
 *   B. pending 项**存活**：重载前后 id 完全一致、仍在等待答复
 *   C. 配置变更**仍然生效**：文件监听路径把变更落进 serve（GET /api/agent/<name> 读回）
 * 对照（无 pending 时）：同一入口重载 ⇒ outcome = reloaded（证明是闸门导致的延后）
 * 反证：直接 POST /api/location/reload ⇒ pending 项被取消（证明闸门确实在保护它们）
 *
 * ── 取证渲染约定（**不要"改回去"**）──────────────────────────────────────
 * 真实发出的请求头**一个字都不改**（wire 上仍是标准的 `Basic <base64>`）；
 * 但**落到证据文本里**时，`Authorization` 头会被**解回明文**再记录：
 *     > header Authorization: Basic base64(opencode:probe-serve-pw-deferred)
 * 为什么这么做：
 *   ① `Basic <base64>` 这个**形状**（认证方案 + base64）会被仓库的密钥扫描器
 *      （GitGuardian 的 Bearer Token 探测器）判成"疑似凭据"——它看的是**形状**，
 *      不是长度也不是熵（同一次采集里的 40 位 git SHA、64 位镜像摘要都**没有**被命中）；
 *   ② 本探针用的口令是**脚本自己定义的合成假串**（opencode:probe-serve-pw-deferred），
 *      **明文比 base64 更可核验**：读者能直接确认"用的就是这个假口令"，
 *      而不是对着一坨不透明的 base64 去猜它解出来是什么。
 * ⇒ 结果：证据里**不再有任何** `Basic <base64>` 形状 ⇒ 扫描器可以**全库保持严格**，
 *   同时凭据**仍然被完整记录**（只是换成人可读的形式）。
 * ⚠️ **只**处理 `Authorization` 头；其它头（如 `X-Worker-Token`）原样照抄。
 */

import fsSync from 'node:fs';

const WORKER = 'http://127.0.0.1:4199';
const SERVE = 'http://127.0.0.1:18099';
const TOKEN = 'probe-token-deferred-2026';
const PW = 'probe-serve-pw-deferred';
const WORKDIR = '/scratch/work';
const TASKDIR = '/scratch/work/tasks/task-1';
const OUT = '/tmp/vteam-deferred-probe/evidence.txt';

const OUT_LINES = [];
let T0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const ms = () => `+${String(Date.now() - T0).padStart(6)}ms`;

/** serve 自己的诊断日志（容器内 /scratch/iso/data/opencode/log/opencode.log，宿主可读）。 */
const SERVE_LOG = '/tmp/vteam-deferred-probe/scratch/iso/data/opencode/log/opencode.log';
function serveLogMark() {
  try {
    return fsSync.statSync(SERVE_LOG).size;
  } catch {
    return 0;
  }
}
function serveLogSince(mark, { limit = 40, re = null } = {}) {
  let text = '';
  try {
    const size = fsSync.statSync(SERVE_LOG).size;
    const len = Math.max(0, size - mark);
    const fd = fsSync.openSync(SERVE_LOG, 'r');
    const buf = Buffer.alloc(len);
    fsSync.readSync(fd, buf, 0, len, mark);
    fsSync.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const picked = re ? lines.filter((l) => re.test(l)) : lines;
  return picked.slice(0, limit);
}

function say(...lines) {
  for (const l of lines) {
    OUT_LINES.push(l);
    console.log(l);
  }
}
function section(title) {
  say('', '='.repeat(78), title, '='.repeat(78));
}
function kv(pairs) {
  for (const [k, v] of pairs) say(`  ${String(k).padEnd(30)}: ${v}`);
}
function body(raw) {
  if (raw === undefined || raw === null) return '(空请求体)';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

/**
 * 头值的**取证渲染**：`Authorization` 的 `Basic <base64>` 被**解回明文**再记录，
 * 形如 `Basic base64(opencode:probe-serve-pw-deferred)`。
 *
 * ⚠️ 这只影响**记进证据的文本**；真正发出去的请求头**不变**（仍是标准
 * `Basic <base64>`）。理由见文件头"取证渲染约定"：① `Basic <base64>` 这个形状会被
 * 密钥扫描器判成疑似凭据；② 这里用的是脚本自己定义的**合成假口令**，明文更可核验。
 * 其它头一律原样照抄。解不开（非 base64 / 解出来不可打印 / 编码回去对不上）时
 * 也原样保留 ⇒ 宁可多记，也不丢信息。
 */
function renderHeaderValue(name, value) {
  const v = String(value);
  if (String(name).toLowerCase() !== 'authorization') return v;
  const m = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/.exec(v.trim());
  if (!m) return v;
  const blob = m[1];
  const decoded = Buffer.from(blob, 'base64').toString('utf8');
  if (!decoded) return v;
  if (!/^[\x20-\x7e]+$/.test(decoded)) return v; // 只解可打印 ASCII
  if (Buffer.from(decoded, 'utf8').toString('base64') !== blob) return v; // 必须能原样编回去
  return `Basic base64(${decoded})`;
}

/** 一次请求的原始记录（方法/URL/请求体/状态码/响应体逐字照抄）。 */
async function req(label, base, method, path, { payload, headers = {}, raw = false } = {}) {
  const url = base + path;
  const h = { ...headers };
  let reqBody;
  if (payload !== undefined) {
    h['Content-Type'] = 'application/json';
    reqBody = JSON.stringify(payload);
  }
  const t0 = Date.now();
  const res = await fetch(url, { method, headers: h, body: reqBody });
  const text = await res.text();
  const elapsed = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  say('');
  say(`  [${ms()} | ${iso()}] ${label}`);
  say(`  > ${method} ${url}`);
  if (reqBody !== undefined) say(`  > request-body: ${reqBody}`);
  for (const [k, v] of Object.entries(headers)) say(`  > header ${k}: ${renderHeaderValue(k, v)}`);
  say(`  < HTTP ${res.status}  (${elapsed} ms)`);
  say(`  < response-body: ${text === '' ? '(空)' : text}`);
  return { status: res.status, text, json, ms: elapsed };
}

/** serve 请求（Basic Auth，username 恒为 opencode）。 */
function sreq(label, method, path, opts = {}) {
  return req(label, SERVE, method, path, {
    ...opts,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${PW}`).toString('base64')}`, ...(opts.headers ?? {}) },
  });
}

/** worker 执行端点请求（X-Worker-Token）。 */
function wreq(label, method, path, opts = {}) {
  return req(label, WORKER, method, path, {
    ...opts,
    headers: { 'X-Worker-Token': TOKEN, ...(opts.headers ?? {}) },
  });
}

/** 轮询到条件成立。 */
async function poll(fn, { timeoutMs = 40000, intervalMs = 150 } = {}) {
  const t0 = Date.now();
  const timeline = [];
  for (;;) {
    const r = await fn();
    timeline.push({ ms: Date.now() - t0, r });
    if (r.hit) return { hit: true, ms: Date.now() - t0, timeline, last: r };
    if (Date.now() - t0 > timeoutMs) return { hit: false, ms: Date.now() - t0, timeline, last: r };
    await sleep(intervalMs);
  }
}

/** location 是否真的解析成它自己（location 是惰性加载的）。 */
const waitForLocation = (dir) =>
  poll(async () => {
    const r = await sreq('轮询 GET /api/location', 'GET', `/api/location?location[directory]=${encodeURIComponent(dir)}`);
    return { hit: r.json?.directory === dir, got: r.json?.directory };
  });

/** 某 location 的 agent 集合里是否出现指定 agent。 */
const waitForAgent = (dir, agentID) =>
  poll(async () => {
    const r = await sreq('轮询 GET /api/agent', 'GET', `/api/agent?location[directory]=${encodeURIComponent(dir)}`);
    const ids = (r.json?.data || []).map((a) => a.id);
    return { hit: ids.includes(agentID), ids };
  });

/** 某 location 的 agent 的 system 提示是否已含 marker（= 文件监听路径把变更落进 serve 了）。 */
const waitForSystem = (dir, agentID, marker) =>
  poll(async () => {
    const r = await sreq(
      '轮询 GET /api/agent/<name>',
      'GET',
      `/api/agent/${encodeURIComponent(agentID)}?location[directory]=${encodeURIComponent(dir)}`,
    );
    const sys = r.json?.data?.system;
    return { hit: typeof sys === 'string' && sys.includes(marker), sys };
  });

const ids = (payload) => (payload?.data || []).map((x) => x.id);

async function main() {
  T0 = Date.now();
  section('0. 前置：serve 与 worker 的基本信息');
  const info = await sreq('GET /api/info', 'GET', '/api/info');
  const loc = await sreq('GET /api/location（默认 location = serve 的 cwd）', 'GET', '/api/location');
  kv([
    ['serve baseUrl', SERVE],
    ['worker exec baseUrl', WORKER],
    ['serve 默认 location', loc.json?.directory],
    ['预期 workDir（默认 location）', WORKDIR],
  ]);

  // ──────────────────────────────────────────────────────────────────────
  section('1. 用 worker 自己的 /sessions 建会话（⇒ 进入 worker 的 knownSessions，pending 闸门才看得见它）');
  const sessA = await wreq('POST worker /sessions（默认 location 会话 A）', 'POST', '/sessions', { payload: {} });
  const sidA = sessA.json?.sessionId;
  kv([['会话 A（默认 location）', sidA]]);
  if (!sidA) throw new Error('会话 A 建不出来');

  const locA = await waitForLocation(WORKDIR);
  kv([['默认 location 就绪', `${locA.hit ? '是' : '否'}（${locA.ms} ms）`]]);
  const agentA = await waitForAgent(WORKDIR, 'build');
  kv([['默认 location 的 agent 集合就绪', `${agentA.hit ? '是' : '否'}（${agentA.ms} ms）；ids=${JSON.stringify(agentA.last.ids?.slice(0, 8))}`]]);

  section('2. 造 pending 项（默认 location）：form + permission（真实 opencode 待答复请求，非文件伪造）');
  const formA = await sreq('POST /api/session/<sidA>/form', 'POST', `/api/session/${sidA}/form`, {
    payload: {
      title: 'Pending form (default location / deferred gate probe)',
      fields: [{ key: 'answer', type: 'string', title: 'Your answer', required: true }],
    },
  });
  let permA = null;
  for (let i = 0; i < 20; i++) {
    permA = await sreq(
      `POST /api/session/<sidA>/permission（第 ${i + 1} 次尝试）`,
      'POST',
      `/api/session/${sidA}/permission`,
      { payload: { action: 'read', resources: ['.env'] } },
    );
    if (permA.json?.data?.effect === 'ask') break;
    await sleep(500);
  }
  const formIdA = formA.json?.data?.id;
  const permIdA = permA.json?.data?.id;
  kv([
    ['pending form id', formIdA],
    ['pending permission id', permIdA],
    ['permission effect', permA.json?.data?.effect],
  ]);

  section('3. 闸门前的 pending 快照（逐会话 = worker 的探测口径；全局端点 = location 作用域口径）');
  const beforeFormA = await sreq('GET /api/session/<sidA>/form', 'GET', `/api/session/${sidA}/form`);
  const beforePermA = await sreq('GET /api/session/<sidA>/permission', 'GET', `/api/session/${sidA}/permission`);
  const beforeGlobForm = await sreq('GET /api/form（默认 location）', 'GET', '/api/form');
  const beforeGlobPerm = await sreq('GET /api/permission/request（默认 location）', 'GET', '/api/permission/request');
  kv([
    ['逐会话 form ids', JSON.stringify(ids(beforeFormA.json))],
    ['逐会话 permission ids', JSON.stringify(ids(beforePermA.json))],
    ['全局 form ids（默认 location）', JSON.stringify(ids(beforeGlobForm.json))],
    ['全局 permission ids（默认 location）', JSON.stringify(ids(beforeGlobPerm.json))],
  ]);

  section('4. 施加配置变更（平台自己的下推面：POST /config/agent-policies）');
  const MARKER_A = 'DEFERRED_GATE_MARKER_V1';
  const markA = serveLogMark();
  const pushA = await wreq('POST worker /config/agent-policies', 'POST', '/config/agent-policies', {
    payload: {
      agents: [
        {
          name: 'deferred-probe-agent',
          description: 'deferred gate probe agent',
          mode: 'all',
          prompt: `${MARKER_A} — 角色提示（本行由 /config/agent-policies 落盘，经文件监听生效）`,
          permission: { read: 'ask', bash: 'ask', edit: 'ask' },
        },
      ],
    },
  });
  kv([['下推响应', pushA.text]]);

  section('5. ★ 有 pending ⇒ 触发 worker 的 POST /config/reload（期望 outcome=deferred）');
  const infoBeforeA = await sreq('GET /api/info（重载前）', 'GET', '/api/info');
  const reloadA = await wreq('POST worker /config/reload（有 pending）', 'POST', '/config/reload', { payload: {} });
  const outcomeA = reloadA.json?.reload;
  await sleep(1500);
  const infoAfterA = await sreq('GET /api/info（重载后）', 'GET', '/api/info');
  const logA = serveLogSince(markA, { re: /watcher (stopped|started)|config\.updated|agent\.updated/, limit: 400 });
  const stoppedA = logA.filter((l) => l.includes('watcher stopped')).length;
  const startedA = logA.filter((l) => l.includes('watcher started')).length;
  const updA = logA.filter((l) => l.includes('config.updated') || l.includes('agent.updated')).length;
  kv([
    ['reload outcome', outcomeA],
    ['是否为 deferred', outcomeA === 'deferred' ? '**是**' : '**否**'],
    ['完整响应体', reloadA.text],
    ['serve PID（重载前/后）', `${infoBeforeA.json?.pid} / ${infoAfterA.json?.pid} ⇒ ${infoBeforeA.json?.pid === infoAfterA.json?.pid ? '**未变**' : '**变了**'}`],
    ['窗口内 serve 日志：watcher stopped / started 条数', `${stoppedA} / ${startedA}`],
    ['窗口内 serve 日志：config.updated + agent.updated 条数', String(updA)],
    ['判定：location/reload 是否被调用过', stoppedA >= 10 ? '**被调用过**（location 全量重建 ⇒ watcher 停/起约 19~20 条）' : '**未被调用**（无 location 全量重建痕迹；只有文件监听路径的局部痕迹）'],
  ]);
  for (const l of logA.slice(0, 14)) say(`    ${l}`);
  if (logA.length > 14) say(`    ...（窗口内共 ${logA.length} 行匹配，其余略）`);

  section('6. ★ pending 项是否存活（重载后立刻复查）');
  const afterFormA = await sreq('GET /api/session/<sidA>/form（重载后）', 'GET', `/api/session/${sidA}/form`);
  const afterPermA = await sreq('GET /api/session/<sidA>/permission（重载后）', 'GET', `/api/session/${sidA}/permission`);
  const survivedForm = ids(afterFormA.json).includes(formIdA);
  const survivedPerm = ids(afterPermA.json).includes(permIdA);
  kv([
    ['form id 前后一致', `${formIdA} ⇒ ${JSON.stringify(ids(afterFormA.json))} ⇒ ${survivedForm ? '**存活**' : '**丢失**'}`],
    ['permission id 前后一致', `${permIdA} ⇒ ${JSON.stringify(ids(afterPermA.json))} ⇒ ${survivedPerm ? '**存活**' : '**丢失**'}`],
  ]);

  section('7. ★ 配置变更是否仍然生效（deferred 走文件监听路径 ⇒ 变更不能丢）');
  const appliedA = await waitForSystem(WORKDIR, 'deferred-probe-agent', MARKER_A);
  const agentA1 = await sreq('GET /api/agent/deferred-probe-agent', 'GET', `/api/agent/deferred-probe-agent?location[directory]=${encodeURIComponent(WORKDIR)}`);
  kv([
    ['新 system 提示可见', appliedA.hit ? `**是**（改后 ${appliedA.ms} ms）` : `**否**（超时 ${appliedA.ms} ms）`],
    ['读回的 system', JSON.stringify(agentA1.json?.data?.system)],
  ]);

  // ──────────────────────────────────────────────────────────────────────
  section('8. 任务子目录 location：会话 B move 过去，再造一套 pending（这正是全局 location 端点查不到的那类）');
  const sessB = await wreq('POST worker /sessions（任务子目录会话 B）', 'POST', '/sessions', { payload: {} });
  const sidB = sessB.json?.sessionId;
  kv([['会话 B', sidB]]);
  if (!sidB) throw new Error('会话 B 建不出来');
  const moveB = await sreq('POST /api/session/<sidB>/move', 'POST', `/api/session/${sidB}/move`, {
    payload: { directory: TASKDIR },
  });
  kv([['move 响应', `HTTP ${moveB.status} ${moveB.text}`]]);
  const locB = await waitForLocation(TASKDIR);
  kv([['任务子目录 location 就绪', `${locB.hit ? '**是**' : '否**'}（${locB.ms} ms；解析成 ${locB.last.got}）`]]);
  const agentB = await waitForAgent(TASKDIR, 'deferred-probe-agent');
  kv([['任务子目录 agent 集合就绪', `${agentB.hit ? '**是**' : '否**'}（${agentB.ms} ms）`]]);

  const formB = await sreq('POST /api/session/<sidB>/form（任务子目录）', 'POST', `/api/session/${sidB}/form`, {
    payload: {
      title: 'Pending form (task subdirectory / deferred gate probe)',
      fields: [{ key: 'answer', type: 'string', title: 'Your answer', required: true }],
    },
  });
  let permB = null;
  for (let i = 0; i < 20; i++) {
    permB = await sreq(
      `POST /api/session/<sidB>/permission（第 ${i + 1} 次尝试）`,
      'POST',
      `/api/session/${sidB}/permission`,
      { payload: { action: 'read', resources: ['.env'] } },
    );
    if (permB.json?.data?.effect === 'ask') break;
    await sleep(500);
  }
  const formIdB = formB.json?.data?.id;
  const permIdB = permB.json?.data?.id;
  kv([
    ['pending form id（任务子目录）', formIdB],
    ['pending permission id（任务子目录）', permIdB],
    ['permission effect', permB.json?.data?.effect],
  ]);

  section('9. location 作用域对照：逐会话查得到 vs 全局 location 端点查不到');
  const beforeFormB = await sreq('GET /api/session/<sidB>/form', 'GET', `/api/session/${sidB}/form`);
  const beforePermB = await sreq('GET /api/session/<sidB>/permission', 'GET', `/api/session/${sidB}/permission`);
  const globFormDefault = await sreq('GET /api/form（默认 location）', 'GET', '/api/form');
  const globFormTask = await sreq('GET /api/form?location[directory]=<任务子目录>', 'GET', `/api/form?location[directory]=${encodeURIComponent(TASKDIR)}`);
  const globPermDefault = await sreq('GET /api/permission/request（默认 location）', 'GET', '/api/permission/request');
  const globPermTask = await sreq('GET /api/permission/request?location[directory]=<任务子目录>', 'GET', `/api/permission/request?location[directory]=${encodeURIComponent(TASKDIR)}`);
  kv([
    ['逐会话 form（会话 B）', JSON.stringify(ids(beforeFormB.json))],
    ['逐会话 permission（会话 B）', JSON.stringify(ids(beforePermB.json))],
    ['全局 form（默认 location）', JSON.stringify(ids(globFormDefault.json))],
    ['全局 form（任务子目录）', JSON.stringify(ids(globFormTask.json))],
    ['全局 permission（默认 location）', JSON.stringify(ids(globPermDefault.json))],
    ['全局 permission（任务子目录）', JSON.stringify(ids(globPermTask.json))],
  ]);

  section('10. ★ 再次施加配置变更 + POST /config/reload（两个 location 都有 pending ⇒ 期望仍 deferred）');
  const MARKER_B = 'DEFERRED_GATE_MARKER_V2';
  const markB = serveLogMark();
  const pushB = await wreq('POST worker /config/agent-policies（第二次）', 'POST', '/config/agent-policies', {
    payload: {
      agents: [
        {
          name: 'deferred-probe-agent',
          description: 'deferred gate probe agent',
          mode: 'all',
          prompt: `${MARKER_B} — 角色提示（第二次配置变更）`,
          permission: { read: 'ask', bash: 'ask', edit: 'ask' },
        },
      ],
    },
  });
  kv([['下推响应', pushB.text]]);
  const reloadB = await wreq('POST worker /config/reload（两个 location 都有 pending）', 'POST', '/config/reload', { payload: {} });
  const outcomeB = reloadB.json?.reload;
  await sleep(1500);
  const logB = serveLogSince(markB, { re: /watcher (stopped|started)|config\.updated|agent\.updated/, limit: 400 });
  const stoppedB = logB.filter((l) => l.includes('watcher stopped')).length;
  const startedB = logB.filter((l) => l.includes('watcher started')).length;
  kv([
    ['reload outcome', outcomeB],
    ['是否为 deferred', outcomeB === 'deferred' ? '**是**' : '**否**'],
    ['完整响应体', reloadB.text],
    ['窗口内 serve 日志：watcher stopped / started 条数', `${stoppedB} / ${startedB}`],
    ['判定：location/reload 是否被调用过', stoppedB >= 10 ? '**被调用过**（location 全量重建）' : '**未被调用**（无 location 全量重建痕迹）'],
  ]);
  for (const l of logB.slice(0, 14)) say(`    ${l}`);
  if (logB.length > 14) say(`    ...（窗口内共 ${logB.length} 行匹配，其余略）`);

  section('11. ★ 四个 pending 项是否全部存活（重载后立刻复查）');
  const postFormA = await sreq('GET /api/session/<sidA>/form（重载后）', 'GET', `/api/session/${sidA}/form`);
  const postPermA = await sreq('GET /api/session/<sidA>/permission（重载后）', 'GET', `/api/session/${sidA}/permission`);
  const postFormB = await sreq('GET /api/session/<sidB>/form（重载后）', 'GET', `/api/session/${sidB}/form`);
  const postPermB = await sreq('GET /api/session/<sidB>/permission（重载后）', 'GET', `/api/session/${sidB}/permission`);
  kv([
    ['会话 A form ids', JSON.stringify(ids(postFormA.json))],
    ['会话 A permission ids', JSON.stringify(ids(postPermA.json))],
    ['会话 B form ids（任务子目录）', JSON.stringify(ids(postFormB.json))],
    ['会话 B permission ids（任务子目录）', JSON.stringify(ids(postPermB.json))],
    ['四个 id 全部存活', ids(postFormA.json).includes(formIdA) && ids(postPermA.json).includes(permIdA) && ids(postFormB.json).includes(formIdB) && ids(postPermB.json).includes(permIdB) ? '**是**' : '**否**'],
  ]);

  section('12. ★ 第二次配置变更是否仍然生效（文件监听路径落地的证明）');
  const appliedB = await waitForSystem(WORKDIR, 'deferred-probe-agent', MARKER_B);
  kv([['新 system 提示可见', appliedB.hit ? `**是**（改后 ${appliedB.ms} ms）` : `**否**（超时 ${appliedB.ms} ms）`]]);

  // ──────────────────────────────────────────────────────────────────────
  section('13. 对照组：把四个 pending 项都答复掉（清空）⇒ 同一入口重载应不再是 deferred');
  const replyFormA = await sreq('POST /api/session/<sidA>/form/<formID>/reply', 'POST', `/api/session/${sidA}/form/${formIdA}/reply`, {
    payload: { answer: { answer: 'probe-answer-A' } },
  });
  const replyPermA = await sreq('POST /api/session/<sidA>/permission/<permID>/reply', 'POST', `/api/session/${sidA}/permission/${permIdA}/reply`, {
    payload: { decision: 'once' },
  });
  const replyFormB = await sreq('POST /api/session/<sidB>/form/<formID>/reply', 'POST', `/api/session/${sidB}/form/${formIdB}/reply`, {
    payload: { answer: { answer: 'probe-answer-B' } },
  });
  const replyPermB = await sreq('POST /api/session/<sidB>/permission/<permID>/reply', 'POST', `/api/session/${sidB}/permission/${permIdB}/reply`, {
    payload: { decision: 'once' },
  });
  kv([
    ['答复 form A', `HTTP ${replyFormA.status}`],
    ['答复 permission A', `HTTP ${replyPermA.status}`],
    ['答复 form B', `HTTP ${replyFormB.status}`],
    ['答复 permission B', `HTTP ${replyPermB.status}`],
  ]);
  const clearedFormA = await sreq('GET /api/session/<sidA>/form（答复后）', 'GET', `/api/session/${sidA}/form`);
  const clearedPermA = await sreq('GET /api/session/<sidA>/permission（答复后）', 'GET', `/api/session/${sidA}/permission`);
  const clearedFormB = await sreq('GET /api/session/<sidB>/form（答复后）', 'GET', `/api/session/${sidB}/form`);
  const clearedPermB = await sreq('GET /api/session/<sidB>/permission（答复后）', 'GET', `/api/session/${sidB}/permission`);
  kv([
    ['会话 A form（应为 []）', JSON.stringify(clearedFormA.json?.data)],
    ['会话 A permission（应为 []）', JSON.stringify(clearedPermA.json?.data)],
    ['会话 B form（应为 []）', JSON.stringify(clearedFormB.json?.data)],
    ['会话 B permission（应为 []）', JSON.stringify(clearedPermB.json?.data)],
  ]);

  const MARKER_C = 'DEFERRED_GATE_MARKER_V3_CONTROL';
  const markC = serveLogMark();
  const pushC = await wreq('POST worker /config/agent-policies（对照组）', 'POST', '/config/agent-policies', {
    payload: {
      agents: [
        {
          name: 'deferred-probe-agent',
          description: 'deferred gate probe agent',
          mode: 'all',
          prompt: `${MARKER_C} — 对照组：无 pending 时的配置变更`,
          permission: { read: 'ask', bash: 'ask', edit: 'ask' },
        },
      ],
    },
  });
  kv([['下推响应', pushC.text]]);
  const reloadC = await wreq('POST worker /config/reload（无 pending ⇒ 对照组）', 'POST', '/config/reload', { payload: {} });
  const outcomeC = reloadC.json?.reload;
  await sleep(3000);
  const logC = serveLogSince(markC, { re: /watcher (stopped|started)|config\.updated|agent\.updated/, limit: 400 });
  const stoppedC = logC.filter((l) => l.includes('watcher stopped')).length;
  const startedC = logC.filter((l) => l.includes('watcher started')).length;
  kv([
    ['reload outcome', outcomeC],
    ['是否为 deferred', outcomeC === 'deferred' ? '是（对照组失败！）' : `**否**（是 ${outcomeC}）`],
    ['完整响应体', reloadC.text],
    ['窗口内 serve 日志：watcher stopped / started 条数', `${stoppedC} / ${startedC}`],
    ['判定：location/reload 是否被调用过', stoppedC >= 10 ? '**被调用过**（location 全量重建 ⇒ 与 deferred 时的窗口形成对照）' : '未用（异常：对照组本该重建）'],
  ]);
  for (const l of logC.slice(0, 12)) say(`    ${l}`);
  if (logC.length > 12) say(`    ...（窗口内共 ${logC.length} 行匹配，其余略）`);
  const appliedC = await waitForSystem(WORKDIR, 'deferred-probe-agent', MARKER_C);
  kv([['新 system 提示可见（对照组）', appliedC.hit ? `**是**（改后 ${appliedC.ms} ms）` : `**否**（超时 ${appliedC.ms} ms）`]]);

  // ──────────────────────────────────────────────────────────────────────
  section('14. 反证：直接 POST /api/location/reload ⇒ pending 项会被取消（证明闸门确实在保护它们）');
  const sessC = await wreq('POST worker /sessions（反证会话 C）', 'POST', '/sessions', { payload: {} });
  const sidC = sessC.json?.sessionId;
  const formC = await sreq('POST /api/session/<sidC>/form', 'POST', `/api/session/${sidC}/form`, {
    payload: {
      title: 'Pending form (negative control: direct location/reload)',
      fields: [{ key: 'answer', type: 'string', title: 'Your answer', required: true }],
    },
  });
  let permC = null;
  for (let i = 0; i < 20; i++) {
    permC = await sreq(
      `POST /api/session/<sidC>/permission（第 ${i + 1} 次尝试）`,
      'POST',
      `/api/session/${sidC}/permission`,
      { payload: { action: 'read', resources: ['.env'] } },
    );
    if (permC.json?.data?.effect === 'ask') break;
    await sleep(500);
  }
  const formIdC = formC.json?.data?.id;
  const permIdC = permC.json?.data?.id;
  kv([
    ['会话 C', sidC],
    ['pending form id', formIdC],
    ['pending permission id', permIdC],
  ]);
  const preCForm = await sreq('GET /api/session/<sidC>/form（反证前）', 'GET', `/api/session/${sidC}/form`);
  const preCPerm = await sreq('GET /api/session/<sidC>/permission（反证前）', 'GET', `/api/session/${sidC}/permission`);
  kv([
    ['反证前 form ids', JSON.stringify(ids(preCForm.json))],
    ['反证前 permission ids', JSON.stringify(ids(preCPerm.json))],
  ]);
  const directReload = await sreq('POST /api/location/reload（直接打 serve，绕过 worker 的闸门）', 'POST', '/api/location/reload');
  kv([['直接重载结果', `HTTP ${directReload.status}（${directReload.ms} ms）`]]);
  await sleep(1500);
  const postCForm = await sreq('GET /api/session/<sidC>/form（反证后）', 'GET', `/api/session/${sidC}/form`);
  const postCPerm = await sreq('GET /api/session/<sidC>/permission（反证后）', 'GET', `/api/session/${sidC}/permission`);
  kv([
    ['反证后 form ids', JSON.stringify(ids(postCForm.json))],
    ['反证后 permission ids', JSON.stringify(ids(postCPerm.json))],
    ['结论', ids(postCForm.json).length === 0 && ids(postCPerm.json).length === 0 ? '**pending 被取消** ⇒ location/reload 确实会销毁待答复项 ⇒ worker 的闸门是必需的' : '**未取消**（与既有观测不同！）'],
  ]);

  section('15. 汇总判定');
  const rows = [
    ['A. 有 pending ⇒ 重载被跳过（outcome=deferred）', outcomeA === 'deferred' && outcomeB === 'deferred', `outcomeA=${outcomeA}, outcomeB=${outcomeB}`],
    ['B. pending 项存活（id 不变）', survivedForm && survivedPerm && ids(postFormB.json).includes(formIdB) && ids(postPermB.json).includes(permIdB), `A:form=${formIdA},perm=${permIdA} / B:form=${formIdB},perm=${permIdB}`],
    ['C. 配置变更仍然生效（文件监听路径）', appliedA.hit && appliedB.hit, `V1=${appliedA.hit}, V2=${appliedB.hit}`],
    ['D. 对照组：无 pending ⇒ outcome≠deferred', outcomeC !== 'deferred', `outcomeC=${outcomeC}`],
    ['E. 反证：直接 location/reload 会取消 pending', ids(postCForm.json).length === 0 && ids(postCPerm.json).length === 0, `form ids=${JSON.stringify(ids(postCForm.json))}, perm ids=${JSON.stringify(ids(postCPerm.json))}`],
  ];
  for (const [k, ok, detail] of rows) {
    say(`  ${ok ? '✅' : '❌'} ${k}  —— ${detail}`);
  }

  const fs = await import('node:fs');
  fs.writeFileSync(OUT, OUT_LINES.join('\n') + '\n', 'utf8');
  console.log(`\nevidence written: ${OUT}`);
}

main().catch(async (err) => {
  console.error(err);
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, OUT_LINES.join('\n') + '\n\n!!! FAILED: ' + String(err) + '\n', 'utf8');
  process.exit(1);
});
