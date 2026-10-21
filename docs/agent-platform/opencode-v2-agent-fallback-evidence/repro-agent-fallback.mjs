#!/usr/bin/env node
/**
 * opencode v2「会话切到一个**不存在**的 agent」落点实测（锁版 2.0.32）。
 *
 * 被它回答的问题（docs/deployment.md §8.5 的未验证假设）：
 *   v1→v2 迁移后，老团队的成员仍绑在 OmO 的 agent 名上
 *   （`Sisyphus - ultraworker` / `Prometheus - Plan Builder` / `Atlas - Plan Executor`），
 *   而 v2 线**不加载 OmO** ⇒ 这些 agent 在 v2 上**不存在**。
 *   平台在派发时把这个名字**无条件**下发给 opencode（`POST /api/session/{id}/agent`），
 *   **不校验**该名字 ⇒ opencode 到底是**拒绝**（4xx）还是**静默忽略**（回落到默认 agent）？
 *
 * 本脚本在**容器内**跑（2.0.32 是 linux ELF；宿主那个 2.0.28 的 darwin/arm64 二进制不能用于本测量）：
 *   1. 起一个**隔离**的 `opencode serve`（HOME / XDG_* 全指向临时目录）；
 *   2. 项目目录里写一份**平台控制面同形态**的 `opencode.json`（`agents` 节 = 7 个 `vteam-*`）；
 *   3. 依次做：列 agent → 建会话 → 切**未知** agent → 读回会话 → 真发一条消息 → 读回复；
 *   4. **对照组**：新会话切**有效** agent（`vteam-developer`）→ 同一条消息 → 读回复；
 *   5. 落盘所有原始请求/响应（逐条带 HTTP 状态码与 body）。
 *
 * 模型侧用**本地桩 provider**（127.0.0.1 上的 openai-compatible 假端点，无外网、无真实凭据）：
 * 桩端点把**收到的模型请求原文**落盘 ⇒ 哪个 agent 的 `system` 提示进了模型请求，是**直接证据**
 * （不是推断）。桩**只**替代模型本身；"哪个 agent 执行"这件事仍由 opencode 自己产出
 * （assistant 消息的 `agent` 字段 + 模型请求里的 system 标记）。
 *
 * 无第三方依赖（node 内置 fetch / http / fs）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ---- 运行参数（宿主通过 env 注入；默认值只是兜底） ----
const OUT = process.env.OUT_DIR || '/evidence';
const SCRATCH = process.env.SCRATCH || '/scratch';
const SERVE_PORT = Number(process.env.SERVE_PORT || 45991);
const MOCK_PORT = Number(process.env.MOCK_PORT || 45992);
const PW = process.env.OPENCODE_SERVER_PASSWORD || 'probe-fallback-pw-2026';
const BIN = process.env.OPENCODE_BIN || '/usr/local/bin/opencode';
const AUTH = 'Basic ' + Buffer.from(`opencode:${PW}`).toString('base64');

const HOME_DIR = path.join(SCRATCH, 'home');
const PROJ_DIR = path.join(SCRATCH, 'proj');
const BASE = `http://127.0.0.1:${SERVE_PORT}`;

/** OmO 的三个 agent 名（v2 下**不存在**）——平台会原样下发的就是这三个字符串。 */
const UNKNOWN_AGENT_NAMES = [
  'Sisyphus - ultraworker',
  'Prometheus - Plan Builder',
  'Atlas - Plan Executor',
];
/** 平台自己的 agent 名（控制面注入 ⇒ 在 v2 上**存在**）——对照组用。 */
const VALID_AGENT_NAME = 'vteam-developer';

/** 平台控制面注入的 7 个 agent（`server/src/chat/worker-dispatcher.ts` 的 `VTEAM_AGENT_NAMES`）。 */
const VTEAM_AGENTS = [
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-plan',
  'vteam-librarian',
];

// ---- 小工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

/** 写证据文件（同一文件首次写**截断**、其后追加 ⇒ 重跑不会把两轮内容拼在一起）。 */
const writtenFiles = new Set();
function write(file, text) {
  ensureDir(OUT);
  const target = path.join(OUT, file);
  const flag = writtenFiles.has(file) ? 'a' : 'w';
  writtenFiles.add(file);
  fs.writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`, { encoding: 'utf8', flag });
}

/** 一次 HTTP 请求的完整留痕。 */
async function call(method, urlPath, body) {
  const started = Date.now();
  const init = { method, headers: { Authorization: AUTH } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${urlPath}`, init);
  const text = await res.text();
  return {
    method,
    path: urlPath,
    requestBody: body,
    status: res.status,
    statusText: res.statusText,
    contentType: res.headers.get('content-type'),
    body: text,
    ms: Date.now() - started,
  };
}

/** 把一次请求渲染成人类可读、含状态码与原文 body 的块。 */
function render(label, r) {
  return [
    `--- ${label}`,
    `REQUEST : ${r.method} ${r.path}`,
    r.requestBody !== undefined ? `BODY    : ${JSON.stringify(r.requestBody)}` : 'BODY    : (none)',
    `STATUS  : ${r.status} ${r.statusText}`,
    `CTYPE   : ${r.contentType ?? '-'}`,
    `ELAPSED : ${r.ms} ms`,
    'RESPONSE BODY (verbatim):',
    r.body,
    '',
  ].join('\n');
}

/** 解析 JSON，失败则返回 undefined（不抛——原始 body 已经留痕了）。 */
function j(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 订阅 v2 的**全局事件总线**（`GET /api/event`，SSE）——采集原始帧。
 *
 * 为什么采集它：平台的终态判定**只认 durable 的 `session.execution.*` 事件**
 * （`worker/src/driver/v2-event-map.ts`）⇒ "成员这一轮会不会**立刻**被判失败"，
 * 取决于 opencode 在 `AgentNotFoundError` 时**是否发** `session.execution.failed`。
 */
async function subscribeEvents(sessionID, durationMs) {
  const frames = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  try {
    const res = await fetch(`${BASE}/api/event`, {
      headers: { Authorization: AUTH, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (dataLine) {
          let parsed;
          try {
            parsed = JSON.parse(dataLine);
          } catch {
            parsed = dataLine;
          }
          frames.push({ at: stamp(), raw: dataLine, parsed });
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (!String(err).includes('aborted')) {
      frames.push({ at: stamp(), raw: `subscribe error: ${String(err)}`, parsed: null });
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
}

/** 把事件帧渲染成可读块（只留本会话相关的 + 计数）。 */
function renderEvents(label, frames, sessionID) {
  const mine = frames.filter((f) => {
    const p = f.parsed;
    if (!p || typeof p !== 'object') return false;
    const props = p.properties ?? {};
    const sid = props.sessionID ?? props.info?.sessionID ?? props.session?.id;
    return !sid || sid === sessionID;
  });
  return [
    `--- ${label}`,
    `总线帧总数：${frames.length}；与本会话相关的：${mine.length}`,
    '（v2 的 SSE 帧类型在 `data.type`；终态只认 durable 的 `session.execution.*`）',
    '',
    ...mine.map((f) => f.raw),
    '',
  ].join('\n');
}

// ---- 本地桩 provider（openai-compatible） ----
/** 桩收到的模型请求原文（落盘 ⇒ 证明"哪个 agent 的 system 进了模型请求"）。 */
const mockRequests = [];
let mockServer = null;

function startMockProvider() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        const record = {
          at: stamp(),
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsed ?? raw,
        };
        mockRequests.push(record);
        const n = mockRequests.length;
        fs.writeFileSync(
          path.join(OUT, `mock-model-request-${String(n).padStart(2, '0')}.json`),
          `${JSON.stringify(record, null, 2)}\n`,
          'utf8',
        );

        if (req.url && req.url.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'probe-model', object: 'model', created: 0, owned_by: 'probe' }],
            }),
          );
          return;
        }

        const wantsStream = parsed && parsed.stream === true;
        if (!wantsStream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-probe',
              object: 'chat.completion',
              created: 0,
              model: 'probe-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'PROBE_STUB_REPLY' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }

        // SSE 形态（AI SDK 默认走流式）
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-probe',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'probe-model',
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: 'PROBE_STUB_REPLY' }));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    mockServer.on('error', reject);
    mockServer.listen(MOCK_PORT, '127.0.0.1', () => resolve());
  });
}

// ---- 环境与配置准备 ----
function prepareEnvironment() {
  ensureDir(HOME_DIR);
  ensureDir(path.join(HOME_DIR, '.config'));
  ensureDir(path.join(HOME_DIR, '.local/share'));
  ensureDir(path.join(HOME_DIR, '.local/state'));
  ensureDir(path.join(HOME_DIR, '.cache'));
  ensureDir(PROJ_DIR);

  // 项目 `opencode.json`：**平台控制面注入的同形态**（v2 原生 `agents` 节，
  // 角色提示落 `system`；见 `worker/src/resources/opencode-config-builder.ts`）。
  // 每个 vteam agent 的 system 里埋一个**可判别标记** ⇒ 模型请求原文里出现哪个标记，
  // 就说明**哪个 agent 的提示**进了模型请求。
  const agents = {};
  for (const name of VTEAM_AGENTS) {
    agents[name] = {
      description: `PROBE platform agent ${name}`,
      mode: 'primary',
      permissions: [{ action: 'external_directory', resource: '*', effect: 'ask' }],
      system: `PROBE_SYSTEM_MARKER ${name}`,
    };
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    agents,
    provider: {
      probelocal: {
        npm: '@ai-sdk/openai-compatible',
        name: 'ProbeLocalStub',
        options: {
          baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
          apiKey: 'sk-probe-not-a-real-key',
        },
        models: {
          'probe-model': { name: 'probe-model' },
        },
      },
    },
  };
  fs.writeFileSync(path.join(PROJ_DIR, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

// ---- serve 进程 ----
let serveProc = null;
let serveLogPath = '';

function startServe() {
  serveLogPath = path.join(SCRATCH, 'serve.log');
  const out = fs.openSync(serveLogPath, 'w');
  serveProc = spawn(BIN, ['serve', '--port', String(SERVE_PORT), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'debug'], {
    cwd: PROJ_DIR,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      XDG_CONFIG_HOME: path.join(HOME_DIR, '.config'),
      XDG_DATA_HOME: path.join(HOME_DIR, '.local/share'),
      XDG_STATE_HOME: path.join(HOME_DIR, '.local/state'),
      XDG_CACHE_HOME: path.join(HOME_DIR, '.cache'),
      OPENCODE_SERVER_PASSWORD: PW,
    },
    stdio: ['ignore', out, out],
  });
  serveProc.on('error', (e) => {
    write('99-summary.txt', `serve spawn error: ${String(e)}`);
  });
  return serveProc;
}

async function waitForServe(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await call('GET', '/api/info');
      if (r.status === 200) return r;
    } catch {
      /* serve 还没起来 */
    }
    await sleep(500);
  }
  return undefined;
}

// ---- 主流程 ----
const summary = [];

async function main() {
  ensureDir(OUT);
  const config = prepareEnvironment();
  await startMockProvider();

  // 01 —— 版本 / 环境 / 命令
  let versionString = '';
  try {
    const { execFileSync } = await import('node:child_process');
    versionString = execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    versionString = `(采集失败：${String(e)})`;
  }
  write('01-version-and-environment.txt', [
    '=== opencode v2 未知 agent 名落点实测 —— 01 版本与环境 ===',
    `采集时间(UTC)     : ${stamp()}`,
    `opencode 版本串   : ${versionString}   （\`${BIN} --version\` 的原样输出；serve 自报版本见本文件末尾的 GET /api/info）`,
    `opencode 二进制   : ${BIN}`,
    `serve 命令        : ${BIN} serve --port ${SERVE_PORT} --hostname 127.0.0.1 --print-logs --log-level debug`,
    `serve cwd         : ${PROJ_DIR}`,
    `HOME              : ${HOME_DIR}`,
    `XDG_CONFIG_HOME   : ${path.join(HOME_DIR, '.config')}`,
    `XDG_DATA_HOME     : ${path.join(HOME_DIR, '.local/share')}`,
    `OPENCODE_SERVER_PASSWORD : ${PW}   （合成假串；Basic Auth 的 username 恒为 opencode）`,
    `桩 provider 监听  : http://127.0.0.1:${MOCK_PORT}/v1   （本地 openai-compatible 假端点，无外网、无真实凭据）`,
    `容器镜像 ID       : ${process.env.IMAGE_ID || '(未注入)'}`,
    `容器 ID           : ${process.env.CONTAINER_ID || os.hostname()}   （os.hostname() = 容器短 ID）`,
    `宿主平台          : ${process.env.HOST_PLATFORM || '(未注入)'}`,
    `node 版本         : ${process.version}`,
    '',
    '--- 项目 opencode.json（控制面同形态注入；每个 agent 的 system 里埋了判别标记）',
    JSON.stringify(config, null, 2),
    '',
  ].join('\n'));

  // serve 起来
  startServe();
  const info = await waitForServe();
  if (!info) {
    write('99-summary.txt', 'FATAL: serve 未在 90s 内就绪');
    return 1;
  }
  write('01-version-and-environment.txt', [
    '',
    '--- GET /api/info（serve 自报版本）',
    render('GET /api/info', info),
  ].join('\n'));
  summary.push(`GET /api/info => ${info.status} ${info.body.trim()}`);

  // 02 —— 路由发现（不假设 prompt 端点）
  const discovery = [];
  for (const p of ['/api/info', '/api/doc', '/doc', '/openapi.json', '/api/openapi.json', '/api']) {
    const r = await call('GET', p);
    const truncated = r.body.length > 600;
    discovery.push(
      [
        `--- GET ${p}`,
        `STATUS  : ${r.status} ${r.statusText}`,
        `CTYPE   : ${r.contentType ?? '-'}`,
        `LEN     : ${r.body.length} bytes`,
        'RESPONSE BODY (verbatim, >600 字节则截断——web SPA 的 HTML 无诊断价值):',
        truncated ? `${r.body.slice(0, 600)}\n...[截断 ${r.body.length - 600} 字节]` : r.body,
        '',
      ].join('\n'),
    );
  }
  write('02-route-discovery.txt', [
    '=== 02 路由发现（不假设消息端点） ===',
    ...discovery,
  ].join('\n'));

  // 02b —— OpenAPI 契约里"切 agent"这个端点的**书面**形态
  const specR = await call('GET', '/openapi.json');
  const spec = j(specR.body);
  const specPaths = spec && typeof spec === 'object' ? spec.paths ?? {} : {};
  const wanted = [
    '/api/agent',
    '/api/session',
    // ⚠️ OpenAPI 里路径参数的**名字**是 `{sessionID}`（而平台驱动用的是 `{id}` ——
    //    路径模板是位置参数，两种写法都打到同一条路由）。
    '/api/session/{sessionID}',
    '/api/session/{sessionID}/agent',
    '/api/session/{sessionID}/prompt',
    '/api/session/{sessionID}/message',
    '/api/session/{id}',
    '/api/session/{id}/agent',
    '/api/session/{id}/prompt',
    '/api/session/{id}/message',
  ];
  const specBlocks = [];
  specBlocks.push(`GET /openapi.json => ${specR.status}（${specR.contentType ?? '-'}，${specR.body.length} 字节）`);
  specBlocks.push(`spec.info = ${JSON.stringify(spec?.info ?? null)}`);
  specBlocks.push('');
  specBlocks.push(`--- spec 里共有 ${Object.keys(specPaths).length} 条路径；含 "session" 的路径：`);
  specBlocks.push(
    JSON.stringify(Object.keys(specPaths).filter((p) => p.includes('session')), null, 2),
  );
  specBlocks.push('');
  specBlocks.push('--- 本测量用到的端点在 OpenAPI 里的**全部**路径定义');
  for (const p of wanted) {
    specBlocks.push(`### ${p}`);
    specBlocks.push(specPaths[p] ? JSON.stringify(specPaths[p], null, 2) : '(spec 里没有这个路径)');
    specBlocks.push('');
  }
  // Session schema 里的 agent 字段（书面契约）
  const schemas = spec?.components?.schemas ?? {};
  const sessionSchemaKeys = Object.keys(schemas).filter((k) => /^Session/i.test(k));
  specBlocks.push('--- components.schemas 里与 Session 相关的 schema 名');
  specBlocks.push(JSON.stringify(sessionSchemaKeys));
  for (const k of sessionSchemaKeys.slice(0, 4)) {
    const s = schemas[k];
    const props = s?.properties ?? {};
    if (props.agent !== undefined) {
      specBlocks.push(`### ${k}.properties.agent`);
      specBlocks.push(JSON.stringify(props.agent, null, 2));
    }
  }
  write('02b-openapi-contract.txt', [
    '=== 02b OpenAPI 契约（`GET /openapi.json`）里与本测量相关的部分 ===',
    '（书面契约只说"把会话的 agent 设成这个名字"，**没有任何"名字必须存在"的校验/错误码**）',
    '',
    ...specBlocks,
  ].join('\n'));

  // 03 —— 有效 agent 清单（"什么存在"的基准）
  const agentListDefault = await call('GET', '/api/agent');
  let agentListScoped = await call('GET', `/api/agent?location[directory]=${encodeURIComponent(PROJ_DIR)}`);
  // 冷启动时 `/api/agent` 可能返回空数组 ⇒ 有界重试
  const listDeadline = Date.now() + 30000;
  while (
    Date.now() < listDeadline &&
    !(j(agentListScoped.body)?.data ?? []).some((a) => a && a.id === VALID_AGENT_NAME)
  ) {
    await sleep(500);
    agentListScoped = await call('GET', `/api/agent?location[directory]=${encodeURIComponent(PROJ_DIR)}`);
  }
  const ids = (j(agentListScoped.body)?.data ?? []).map((a) => a && a.id);
  write('03-agent-list.txt', [
    '=== 03 GET /api/agent —— "什么存在"的基准 ===',
    render('GET /api/agent（默认 location = serve cwd）', agentListDefault),
    render(`GET /api/agent?location[directory]=${PROJ_DIR}（本会话所在项目目录）`, agentListScoped),
    '',
    '--- 解析出的 agent id 列表（本次实测）',
    JSON.stringify(ids, null, 2),
    '',
    '--- 平台自己的 agent（`vteam-*`）是否都在：',
    JSON.stringify(
      {
        expected: VTEAM_AGENTS,
        present: VTEAM_AGENTS.filter((n) => ids.includes(n)),
        missing: VTEAM_AGENTS.filter((n) => !ids.includes(n)),
        omoNamesPresent: UNKNOWN_AGENT_NAMES.filter((n) => ids.includes(n)),
      },
      null,
      2,
    ),
  ].join('\n'));
  summary.push(`GET /api/agent => ${agentListScoped.status}；agent id = ${JSON.stringify(ids)}`);

  // 04 —— 建会话（未知 agent 用例）
  const mkSession = async () => {
    const r = await call('POST', '/api/session', { location: { directory: PROJ_DIR } });
    const data = j(r.body)?.data ?? j(r.body);
    const id = data?.id ?? data?.sessionId ?? data?.sessionID;
    return { r, id };
  };

  const unknownBlocks = [];
  const unknownReadBacks = [];
  const unknownSessions = {};

  for (const name of UNKNOWN_AGENT_NAMES) {
    const { r: createR, id } = await mkSession();
    unknownBlocks.push(render(`POST /api/session（为未知 agent "${name}" 建会话）`, createR));
    if (!id) {
      unknownBlocks.push(`!! 未取到 session id，跳过该用例`);
      continue;
    }
    unknownSessions[name] = id;

    const switchR = await call('POST', `/api/session/${encodeURIComponent(id)}/agent`, { agent: name });
    unknownBlocks.push(render(`POST /api/session/${id}/agent  {"agent":"${name}"}  ← 平台会原样下发的字符串`, switchR));

    const readR = await call('GET', `/api/session/${encodeURIComponent(id)}`);
    unknownReadBacks.push(render(`GET /api/session/${id}  （切到未知 agent "${name}" 之后读回会话）`, readR));
    const sessionInfo = j(readR.body)?.data ?? j(readR.body);
    unknownReadBacks.push(
      `--- 会话 ${id} 的 agent 字段（判据）：${JSON.stringify(sessionInfo?.agent ?? null)}`,
    );
  }

  write('04-unknown-agent-switch.txt', [
    '=== 04 未知 agent：切 agent 的**确切 HTTP 状态与 body** ===',
    '（平台在派发时把成员绑定的外部 agent 名**无条件**下发，不校验：',
    ' `server/src/chat/worker-dispatcher.ts` 的 `opencodeAgentName ?? policyCandidate ?? omit`；',
    ' `worker/src/driver/v2-driver.ts` 的 `switchAgent` 直接 POST 名字）',
    '',
    ...unknownBlocks,
  ].join('\n'));

  write('05-unknown-agent-session-readback.txt', [
    '=== 05 未知 agent：切完之后把会话**读回** ===',
    ...unknownReadBacks,
  ].join('\n'));

  // 06 —— 未知 agent 的端到端执行（真发一条消息）
  const execBlocks = [];
  const unknownAgentId = unknownSessions[UNKNOWN_AGENT_NAMES[1]] ?? Object.values(unknownSessions)[0];
  if (unknownAgentId) {
    const modelR = await call('POST', `/api/session/${encodeURIComponent(unknownAgentId)}/model`, {
      model: { providerID: 'probelocal', id: 'probe-model' },
    });
    execBlocks.push(render(`POST /api/session/${unknownAgentId}/model（切到桩 provider）`, modelR));

    // 先订阅事件总线（平台的终态判定只认 durable 的 session.execution.*）
    const eventPromise = subscribeEvents(unknownAgentId, 30000);

    let promptR = await call('POST', `/api/session/${encodeURIComponent(unknownAgentId)}/prompt`, {
      text: 'PROBE: 回答任意内容。',
    });
    execBlocks.push(render(`POST /api/session/${unknownAgentId}/prompt（未知 agent 的会话）`, promptR));
    if (promptR.status >= 400) {
      const retryR = await call('POST', `/api/session/${encodeURIComponent(unknownAgentId)}/prompt`, {
        text: 'PROBE: 回答任意内容。',
        delivery: 'steer',
      });
      execBlocks.push(render(`POST /api/session/${unknownAgentId}/prompt（重试：带 delivery=steer）`, retryR));
      promptR = retryR;
    }

    // 等回复（轮询消息列表，**有界**）
    const deadline = Date.now() + 60000;
    let msgs = [];
    let lastGet = undefined;
    while (Date.now() < deadline) {
      const r = await call(
        'GET',
        `/api/session/${encodeURIComponent(unknownAgentId)}/message?order=asc&limit=200`,
      );
      lastGet = r;
      msgs = j(r.body)?.data ?? [];
      const hasAssistant = msgs.some((m) => m && m.type === 'assistant');
      if (hasAssistant || msgs.some((m) => m && m.type === 'error')) break;
      await sleep(1000);
    }
    execBlocks.push(render(`GET /api/session/${unknownAgentId}/message?order=asc&limit=200`, lastGet ?? { method: 'GET', path: '', status: 0, statusText: 'no response', contentType: '-', body: '', ms: 0 }));
    execBlocks.push('--- 消息逐条摘要（type / agent / 文本片段 / error）');
    for (const m of msgs) {
      const text = typeof m?.text === 'string' ? m.text : Array.isArray(m?.content) ? m.content.map((c) => c?.text ?? '').join('') : '';
      execBlocks.push(
        JSON.stringify({
          id: m?.id,
          type: m?.type,
          agent: m?.agent ?? null,
          text: String(text).slice(0, 200),
          error: m?.error ?? null,
        }),
      );
    }
    const assistants = msgs.filter((m) => m && m.type === 'assistant');
    execBlocks.push(
      `--- 判定：assistant 消息的 agent 字段 = ${JSON.stringify(assistants.map((a) => a?.agent ?? null))}`,
    );
    const idle = msgs.filter((m) => m && m.type === 'idle');
    execBlocks.push(
      `--- 判定：idle（run 级结果）消息 = ${JSON.stringify(idle.map((m) => ({ outcome: m?.outcome ?? null, error: m?.error ?? null })))}`,
    );

    const unknownFrames = await eventPromise;
    write('06b-unknown-agent-event-stream.txt', [
      '=== 06b 未知 agent：事件总线（`GET /api/event`）原始帧 ===',
      '（平台的终态判定**只认** durable 的 `session.execution.*` ⇒ 这里有没有 failed 帧，',
      ' 决定了"成员这一轮"是**立刻判失败**还是**挂到首字超时**）',
      '',
      renderEvents(`事件帧（会话 ${unknownAgentId}）`, unknownFrames, unknownAgentId),
    ].join('\n'));
    execBlocks.push(
      `--- 事件总线里出现过的帧类型：${JSON.stringify([...new Set(unknownFrames.map((f) => f?.parsed?.type).filter(Boolean))])}`,
    );
  } else {
    execBlocks.push('!! 没有可用的未知 agent 会话（建会话失败）⇒ 端到端步骤未执行');
  }
  write('06-unknown-agent-execution.txt', [
    '=== 06 未知 agent：**端到端执行**（真发一条消息，看哪个 agent 执行） ===',
    ...execBlocks,
  ].join('\n'));

  // 07 —— 对照组：有效 agent
  const controlBlocks = [];
  const { r: cCreateR, id: cId } = await mkSession();
  controlBlocks.push(render('POST /api/session（对照组）', cCreateR));
  if (cId) {
    const cSwitch = await call('POST', `/api/session/${encodeURIComponent(cId)}/agent`, {
      agent: VALID_AGENT_NAME,
    });
    controlBlocks.push(render(`POST /api/session/${cId}/agent  {"agent":"${VALID_AGENT_NAME}"}  ← 有效名字`, cSwitch));
    const cRead = await call('GET', `/api/session/${encodeURIComponent(cId)}`);
    controlBlocks.push(render(`GET /api/session/${cId}`, cRead));
    const cModel = await call('POST', `/api/session/${encodeURIComponent(cId)}/model`, {
      model: { providerID: 'probelocal', id: 'probe-model' },
    });
    controlBlocks.push(render(`POST /api/session/${cId}/model`, cModel));
    const cEventPromise = subscribeEvents(cId, 30000);
    const cPrompt = await call('POST', `/api/session/${encodeURIComponent(cId)}/prompt`, {
      text: 'PROBE: 回答任意内容。',
    });
    controlBlocks.push(render(`POST /api/session/${cId}/prompt`, cPrompt));

    const deadline = Date.now() + 60000;
    let msgs = [];
    let lastGet = undefined;
    while (Date.now() < deadline) {
      const r = await call(
        'GET',
        `/api/session/${encodeURIComponent(cId)}/message?order=asc&limit=200`,
      );
      lastGet = r;
      msgs = j(r.body)?.data ?? [];
      if (msgs.some((m) => m && m.type === 'assistant') || msgs.some((m) => m && m.type === 'error')) break;
      await sleep(1000);
    }
    controlBlocks.push(render(`GET /api/session/${cId}/message?order=asc&limit=200`, lastGet ?? { method: 'GET', path: '', status: 0, statusText: 'no response', contentType: '-', body: '', ms: 0 }));
    controlBlocks.push('--- 消息逐条摘要');
    for (const m of msgs) {
      const text = typeof m?.text === 'string' ? m.text : Array.isArray(m?.content) ? m.content.map((c) => c?.text ?? '').join('') : '';
      controlBlocks.push(
        JSON.stringify({
          id: m?.id,
          type: m?.type,
          agent: m?.agent ?? null,
          text: String(text).slice(0, 200),
          error: m?.error ?? null,
        }),
      );
    }
    const assistants = msgs.filter((m) => m && m.type === 'assistant');
    controlBlocks.push(
      `--- 判定：assistant 消息的 agent 字段 = ${JSON.stringify(assistants.map((a) => a?.agent ?? null))}`,
    );
    const cFrames = await cEventPromise;
    write('07b-control-event-stream.txt', [
      '=== 07b 对照组：事件总线（`GET /api/event`）原始帧 ===',
      '',
      renderEvents(`事件帧（会话 ${cId}）`, cFrames, cId),
    ].join('\n'));
    controlBlocks.push(
      `--- 事件总线里出现过的帧类型：${JSON.stringify([...new Set(cFrames.map((f) => f?.parsed?.type).filter(Boolean))])}`,
    );
  } else {
    controlBlocks.push('!! 对照组会话未建成');
  }
  write('07-control-valid-agent.txt', [
    '=== 07 对照组：**有效** agent（`vteam-developer`，控制面注入 ⇒ v2 上存在） ===',
    ...controlBlocks,
  ].join('\n'));

  // 08 —— 桩 provider 收到的模型请求原文（"哪个 agent 的提示进了模型请求"的直接证据）
  write('08-mock-model-requests.txt', [
    '=== 08 桩 provider 收到的**模型请求**（摘要；**完整原文**见同目录 `mock-model-request-NN.json`） ===',
    '（每个 agent 的 system 里埋了 `PROBE_SYSTEM_MARKER <name>` 标记：',
    ' 出现哪个标记 ⇒ 哪个 agent 的提示进了模型请求；一个标记都没有 ⇒ 没走任何 vteam agent）',
    '',
    ...mockRequests.map((r, i) => {
      const body = r.body && typeof r.body === 'object' ? r.body : {};
      const sysMsg = (body.messages ?? []).find((m) => m && m.role === 'system');
      const sysContent = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
      const marker = sysContent.match(/PROBE_SYSTEM_MARKER [^\s"\\]+/);
      return [
        `--- 模型请求 #${i + 1}`,
        `at     : ${r.at}`,
        `${r.method} ${r.url}`,
        `model  : ${body.model ?? '(无)'}`,
        `stream : ${body.stream ?? false}`,
        `messages 条数 : ${(body.messages ?? []).length}`,
        `tools 条数    : ${(body.tools ?? []).length}`,
        `system 提示里的判别标记：${marker ? marker[0] : '(无 —— 没走任何 vteam agent)'}`,
        `system 提示前 300 字符：${JSON.stringify(sysContent.slice(0, 300))}`,
        '完整原文：见 `mock-model-request-' + String(i + 1).padStart(2, '0') + '.json`',
        '',
      ].join('\n');
    }),
  ].join('\n'));

  // 09 —— serve 日志（与 agent 有关的行摘录 + 全文）
  let serveLog = '';
  try {
    serveLog = fs.readFileSync(serveLogPath, 'utf8');
  } catch {
    serveLog = '(serve 日志不可读)';
  }
  const agentLogLines = serveLog
    .split('\n')
    .filter((l) => /agent/i.test(l))
    .slice(0, 200);
  write('09-serve-log-agent-lines.txt', [
    '=== 09 serve 日志中与 agent 有关的行（摘录，最多 200 行） ===',
    `serve 日志总行数：${serveLog.split('\n').length}`,
    '',
    ...agentLogLines,
  ].join('\n'));
  write('09b-serve-log-full.txt', [
    '=== 09b serve 日志全文（`--print-logs --log-level debug`） ===',
    serveLog,
  ].join('\n'));

  // 收尾：杀掉 serve，确认无残留
  const cleanup = [];
  if (serveProc && serveProc.exitCode === null) {
    serveProc.kill('SIGTERM');
    const t0 = Date.now();
    while (serveProc.exitCode === null && Date.now() - t0 < 8000) {
      await sleep(200);
    }
    if (serveProc.exitCode === null) {
      serveProc.kill('SIGKILL');
      cleanup.push('serve 进程：TERM 后 8s 未退出 ⇒ 已 KILL');
    } else {
      cleanup.push(`serve 进程：已退出（code=${serveProc.exitCode}）`);
    }
  } else {
    cleanup.push('serve 进程：此前已退出');
  }
  try {
    const { execSync } = await import('node:child_process');
    // ⚠️ 用 `[o]pencode serve` 的括号技巧避免 **pgrep 自匹配**（`sh -c pgrep -fl "opencode serve"`
    // 这条命令行本身含该字符串 ⇒ 会把 pgrep 自己列出来）。
    const leftovers = execSync('pgrep -fl "[o]pencode serve" || true', { encoding: 'utf8' }).trim();
    cleanup.push(`容器内 pgrep -fl "[o]pencode serve" => ${leftovers === '' ? '(空 —— 无残留 serve 进程)' : leftovers}`);
  } catch (e) {
    cleanup.push(`pgrep 检查失败：${String(e)}`);
  }
  if (mockServer) {
    await new Promise((r) => mockServer.close(r));
    cleanup.push('桩 provider：已关闭');
  }
  write('10-cleanup.txt', ['=== 10 收尾核对（容器内） ===', ...cleanup, ''].join('\n'));

  summary.push(...cleanup);
  write('99-summary.txt', [`=== 99 摘要（脚本自动汇总） ===`, ...summary, ''].join('\n'));
  console.log(summary.join('\n'));
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    write('99-summary.txt', `FATAL: ${err instanceof Error ? err.stack : String(err)}`);
    console.error(err);
    process.exit(1);
  });
