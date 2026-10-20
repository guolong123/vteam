/**
 * T21 真栈冒烟：真实 opencode v2 serve + 真实 V2Driver + 真实 worker 执行端点。
 *
 * 目的：把「worker 在 v2 上能跑通一条真实 agent 会话」这件事**从断言变成证据**：
 * 建会话 → 下发提示 → 首字（流式增量）→ 终态 → 控制面形状的结果，全程打**真的** v2 二进制。
 *
 * 三个必须成立的事实（本组逐条断言）：
 * 1. **角色提示真的进了模型请求**（载体 = 配置里的 `agents.<name>.system`）——
 *    mock provider 记录了**每一次**模型请求 ⇒ 直接查它的 system 段。
 * 2. **vteam 事件序列** = `session.updated(running)` → `message.part.delta`（流式）→
 *    `task.completed`，且**有且只有一个** `task.completed`。
 * 3. **在飞注入**（`delivery:"steer"`）被受理，且**不产生第二个终态事件**。
 *
 * 约束：**无凭据、无额度**——模型由仓库内的 mock provider（`docs/agent-platform/
 * opencode-v2-spike-results/mock-provider.mjs`）应答；serve 跑在**隔离配置域**
 * （`resolveIsolationScope`/`ensureIsolationScope`，T16b 落地的隔离方案）里，
 * 宿主机的全局配置/凭据/插件一律不在作用域内。
 *
 * 默认**跳过**（需要真二进制）：设 `VTEAM_REALSTACK_SMOKE=1` 才跑。
 * 跳过时必须打一条显式标记（计划 §7.2 第 5 条：不允许静默跳过）。
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventSender } from '../client/event-client';
import { ensureIsolationScope, resolveIsolationScope } from '../config';
import { V2Driver } from '../driver/v2-driver';
import type { OpenCodeDriver } from '../driver/opencode-driver';
import { renderCustomToolPlugin } from '../resources/custom-tool';
import { OpencodeServer } from '../runtime/opencode-server';
import { ExecServer } from './exec-server';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MOCK_PROVIDER = path.join(
  REPO_ROOT,
  'docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs',
);

/** 真实 opencode 二进制候选路径（env 优先）。 */
function resolveOpencodeBin(): string | null {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(os.homedir(), '.opencode/bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return null;
}

const OPENCODE_BIN = resolveOpencodeBin();
const ENABLED = process.env.VTEAM_REALSTACK_SMOKE === '1';
const SKIP_REASON = !ENABLED
  ? '未设置 VTEAM_REALSTACK_SMOKE=1（真栈冒烟默认跳过：需要真实 opencode v2 二进制）'
  : !OPENCODE_BIN
    ? '未找到 opencode 二进制（设置 OPENCODE_BIN 或安装到 ~/.opencode/bin/opencode）'
    : !fs.existsSync(MOCK_PROVIDER)
      ? `未找到 mock provider（${MOCK_PROVIDER}）`
      : null;

const describeMaybe = SKIP_REASON ? describe.skip : describe;

/** 角色提示标记（配置里的 `agents.<name>.system`）——必须在模型请求的 system 段里出现。 */
const ROLE_PROMPT_MARKER = 'ROLE_PROMPT_MARKER_VTEAM_T21';
/** 逐消息 system blob 标记（v2 无原生承载 ⇒ 走文本前缀兜底，见 v2-driver 的说明）。 */
const PER_MESSAGE_BLOB_MARKER = 'PER_MESSAGE_BLOB_MARKER_VTEAM_T21';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

interface CapturedEvent {
  type: string;
  payload: Record<string, unknown>;
  seq: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 探一个空闲端口（先占再放）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 发一个 JSON 请求（带 X-Worker-Token）。 */
function request(
  port: number,
  method: string,
  requestPath: string,
  token: string,
  body?: unknown,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'X-Worker-Token': token };
    let data: string | undefined;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method, headers },
      (res) => {
        let chunks = '';
        res.on('data', (chunk: Buffer) => {
          chunks += chunk.toString('utf8');
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(chunks || '{}') as Record<string, unknown>;
          } catch {
            parsed = { raw: chunks };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

/** mock provider 记录的模型请求（一次请求一行 JSONL）。 */
interface RecordedModelRequest {
  n: number;
  headers: Record<string, string>;
  body: {
    model?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
    tools?: Array<{ function?: { name?: string }; name?: string }>;
  };
}

function readRecordedRequests(file: string): RecordedModelRequest[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedModelRequest);
}

/** 一次模型请求里的 system 文本（把所有 system 消息拼起来）。 */
function systemTextOf(request: RecordedModelRequest): string {
  return (request.body.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** 一次模型请求里的 user 文本（把所有 user 消息拼起来）。 */
function userTextOf(request: RecordedModelRequest): string {
  return (request.body.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** 一次模型请求投放给模型的工具名列表。 */
function toolNamesOf(request: RecordedModelRequest): string[] {
  return (request.body.tools ?? []).map(
    (t) => t.function?.name ?? t.name ?? '',
  );
}

/**
 * 标题生成请求（opencode 会另发一次「起标题」请求）——它也带用户正文，
 * 会污染「哪一次请求带了什么」的判读 ⇒ 一律排除。
 * ⚠️ 判据必须精确到 `title generator` 这一句：主请求的 system 段里也会出现
 * "title" 字样（工具描述里就有），用宽泛的 /title/ 会把主请求一起误杀。
 */
function isTitleRequest(request: RecordedModelRequest): boolean {
  return /title generator/i.test(systemTextOf(request));
}

describeMaybe('T21 真栈冒烟（真实 opencode v2 serve + 真实 worker 执行端点）', () => {
  jest.setTimeout(300_000);

  const TOKEN = 'realstack-token';
  const PASSWORD = 'realstack-pass';
  let scratch = '';
  let projectDir = '';
  let mock: ChildProcess | undefined;
  let serve: OpencodeServer | undefined;
  let exec: ExecServer | undefined;
  let mockPort = 0;
  let requestsFile = '';
  let execPort = 0;
  let events: CapturedEvent[] = [];

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-t21-realstack-'));
    projectDir = path.join(scratch, 'proj');
    const pluginDir = path.join(projectDir, '.opencode', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    // 隔离配置域（T16b 落地的方案）：serve 的 HOME / XDG_* 全指向它 ⇒ 宿主机配置不可见。
    const scope = resolveIsolationScope({
      OPENCODE_ISOLATION_ROOT: path.join(scratch, 'iso'),
    } as NodeJS.ProcessEnv);
    ensureIsolationScope(scope);

    mockPort = await freePort();
    requestsFile = path.join(scratch, 'requests.jsonl');

    // 项目配置：mock provider（无凭据）+ 一个带角色提示的 agent。
    fs.writeFileSync(
      path.join(projectDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'vteam-mock/vteam-model',
        plugins: ['-opencode.browser'],
        agents: {
          'vteam-role': {
            description: 'T21 真栈冒烟用角色 agent',
            mode: 'primary',
            system: ROLE_PROMPT_MARKER,
          },
        },
        providers: {
          'vteam-mock': {
            name: 'VTeam Mock',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
            models: {
              'vteam-model': {
                name: 'vteam-model',
                capabilities: { tools: true, input: ['text'], output: ['text'] },
                limit: { context: 8192, output: 1024 },
              },
            },
          },
        },
      }),
      'utf8',
    );

    // 平台自己的工具产物（**真实 worker builder 渲染**，不是手搓）——慢探针：
    // 执行体睡 5s ⇒ 制造一个稳定的「在飞窗口」用于在飞注入断言。
    fs.writeFileSync(
      path.join(pluginDir, 'vteam-slow-probe.ts'),
      renderCustomToolPlugin({
        fileName: 'vteam-slow-probe',
        exports: [
          {
            exportName: 'default',
            description: 'T21 slow probe tool（制造在飞窗口）',
            args: [
              { name: 'jobName', type: 'string', required: true, description: '任务名' },
            ],
            execute: {
              type: 'code',
              code: 'await new Promise((r) => setTimeout(r, 5000));\nreturn "VTEAM_T21_SLOW_OK:" + JSON.stringify(args);',
            },
          },
        ],
      }),
      'utf8',
    );

    mock = spawn(process.execPath, [MOCK_PROVIDER], {
      env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_OUT: requestsFile },
      stdio: 'ignore',
    });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const probe = await new Promise<boolean>((resolve) => {
          const req = http.get(
            `http://127.0.0.1:${mockPort}/v1/models`,
            (res) => {
              res.resume();
              resolve(true);
            },
          );
          req.on('error', () => resolve(false));
        });
        if (probe) {
          break;
        }
      } catch {
        // 继续等
      }
    }

    serve = new OpencodeServer({
      command: OPENCODE_BIN!,
      port: 0,
      serverPassword: PASSWORD,
      cwd: projectDir,
      isolationScope: scope,
      healthCheckTimeoutMs: 90_000,
      healthCheckIntervalMs: 300,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const baseUrl = await serve.start();

    const driver: OpenCodeDriver = new V2Driver({
      baseUrl,
      serverPassword: PASSWORD,
      directory: projectDir,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const sender = new EventSender({
      serverUrl: 'http://127.0.0.1:9',
      workerId: 'w_realstack',
      workerToken: TOKEN,
      startSeq: 0,
      bootId: 'realstack',
      maxRetries: 0,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body ?? '{}')) as {
          type: string;
          payload: Record<string, unknown>;
          seq: number;
        };
        events.push({
          type: payload.type,
          payload: payload.payload,
          seq: payload.seq,
        });
        return { ok: true, status: 202, statusText: 'Accepted' } as Response;
      }) as typeof fetch,
    });

    exec = new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: TOKEN,
      workDir: projectDir,
      firstTokenTimeoutMs: 120_000,
      totalTimeoutMs: 240_000,
      pollMs: 300,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    execPort = await exec.start();
  });

  afterAll(async () => {
    const servePid = serve?.pid;
    await exec?.stop();
    await serve?.stop();
    // 进程组兜底：opencode 可能派生子进程，stop() 只保证组长退出 ⇒ 再补一次组级 SIGKILL。
    if (servePid) {
      try {
        process.kill(-servePid, 'SIGKILL');
      } catch {
        // 进程组已不存在
      }
    }
    mock?.kill('SIGTERM');
    await sleep(300);
    mock?.kill('SIGKILL');
    // 证据留存（可选）：把模型请求记录与 serve 日志拷到指定目录，供人工复核。
    const evidenceDir = process.env.VTEAM_REALSTACK_EVIDENCE_DIR;
    if (evidenceDir && scratch) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      if (fs.existsSync(requestsFile)) {
        fs.copyFileSync(requestsFile, path.join(evidenceDir, 'requests.jsonl'));
      }
      fs.writeFileSync(
        path.join(evidenceDir, 'events.json'),
        JSON.stringify(events, null, 2),
        'utf8',
      );
    }
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('真栈冒烟：建会话 → 提示 → 首字 → 终态 → 控制面形状的结果（恰好一个 task.completed）', async () => {
    // ① 建会话（控制面 → worker 执行端点 → 真实 v2 serve）
    const created = await request(execPort, 'POST', '/sessions', TOKEN, {});
    expect(created.status).toBe(200);
    const sessionId = String(created.body.sessionId);
    expect(sessionId).toMatch(/^ses_/);

    // ② 下发提示并跑完整一轮（走 worker 的 /execute 编排：真实驱动 + 真实 SSE + 真实终态闸门）
    const accepted = await request(execPort, 'POST', '/execute', TOKEN, {
      taskId: 't_realstack',
      agentId: 'a_realstack',
      sessionId,
      prompt: 'T21 真栈冒烟：请回答',
      agent: 'vteam-role',
      system: PER_MESSAGE_BLOB_MARKER,
    });
    expect(accepted.status).toBe(202);

    // 等终态事件（task.completed / 失败终态）
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (
        events.some((e) => e.type === 'task.completed') ||
        events.some(
          (e) => e.type === 'agent.status' && e.payload.status === 'error',
        )
      ) {
        break;
      }
      await sleep(200);
    }

    const types = events.map((e) => e.type);
    const running = events.find(
      (e) => e.type === 'session.updated' && e.payload.status === 'running',
    );
    expect(running).toBeDefined();
    const deltas = events.filter((e) => e.type === 'message.part.delta');
    expect(deltas.length).toBeGreaterThan(0);
    const completed = events.filter((e) => e.type === 'task.completed');
    expect(completed).toHaveLength(1);
    // 事件顺序：running 在前、delta 在中、task.completed 在后
    expect(types.indexOf('session.updated')).toBeLessThan(types.indexOf('message.part.delta'));
    expect(types.indexOf('message.part.delta')).toBeLessThan(types.indexOf('task.completed'));

    // 控制面形状的结果：正文 + parts + 模型口径
    const payload = completed[0].payload;
    expect(String(payload.text)).toContain('MOCK_OK');
    expect(Array.isArray(payload.parts)).toBe(true);
    expect((payload.parts as unknown[]).length).toBeGreaterThan(0);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.taskId).toBe('t_realstack');
    expect(String(payload.model)).toBe('vteam-mock/vteam-model');

    // ③ 读消息（控制面 → worker → 真实 v2 serve 的消息端点）
    const messages = await request(
      execPort,
      'GET',
      `/sessions/${sessionId}/messages?limit=20&order=asc`,
      TOKEN,
    );
    expect(messages.status).toBe(200);
    expect(messages.body.sessionId).toBe(sessionId);
    const list = messages.body.messages as Array<{
      info: { role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(list.length).toBeGreaterThan(0);
    const assistant = list.filter((m) => m.info.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    expect(
      assistant
        .flatMap((m) => m.parts)
        .map((p) => p.text ?? '')
        .join(''),
    ).toContain('MOCK_OK');

    // ④ 中断（幂等）：会话已空闲 ⇒ interrupted=false，但**必须** 200
    const aborted = await request(
      execPort,
      'POST',
      `/sessions/${sessionId}/abort`,
      TOKEN,
    );
    expect(aborted.status).toBe(200);
    expect(aborted.body.sessionId).toBe(sessionId);
    expect(aborted.body.interrupted).toBe(false);

    // ⑤ 模型目录（控制面 → worker → 真实 v2 serve 的模型端点）
    const models = await request(execPort, 'GET', '/models', TOKEN);
    expect(models.status).toBe(200);
    const modelList = models.body.models as Array<{
      id: string;
      providerID: string;
      modelID: string;
    }>;
    expect(modelList.some((m) => m.id === 'vteam-mock/vteam-model')).toBe(true);
  });

  it('角色提示真的进了模型请求（agents.<name>.system 载体），工具真的被投放给模型', async () => {
    const requests = readRecordedRequests(requestsFile).filter(
      (r) => !isTitleRequest(r),
    );
    expect(requests.length).toBeGreaterThan(0);
    const withRole = requests.filter((r) => systemTextOf(r).includes(ROLE_PROMPT_MARKER));
    expect(withRole.length).toBeGreaterThan(0);
    // 工具真的被投放给模型（tools[] 里含平台工具产物 ⇒ 模型可直接 tool_calls）
    const toolNames = toolNamesOf(withRole[0]);
    expect(toolNames).toContain('vteam-slow-probe');
  });

  it('逐消息 system blob 送达模型（当前口径：落在 user 段 = 已知语义降级）', async () => {
    const requests = readRecordedRequests(requestsFile).filter(
      (r) => !isTitleRequest(r),
    );
    const withBlob = requests.filter((r) =>
      userTextOf(r).includes(PER_MESSAGE_BLOB_MARKER),
    );
    expect(withBlob.length).toBeGreaterThan(0);
    // v2 的 prompt body 无 system 字段 ⇒ 逐消息 blob 只能作文本前缀进正文（计划 D6 兜底 (d)）。
    // ⚠️ T21 记录的缺陷：驱动的「不重复注入闸门」用 `GET /api/agent`（**不带** location）
    // 查 agent 的配置化 system，而真 v2.0.28 上不带 location 的该端点返回**空数组**
    // ⇒ 闸门恒不触发 ⇒ agent 已有配置化 system 时本 blob 仍被拼进正文。
    // 修复需改 `worker/src/driver/v2-driver.ts`（本次任务的禁改区）⇒ 此处只记录现状。
    expect(userTextOf(withBlob[0])).toContain(PER_MESSAGE_BLOB_MARKER);
    expect(systemTextOf(withBlob[0])).toContain(ROLE_PROMPT_MARKER);
  });

  it('在飞注入（delivery:"steer"）被受理，且不产生第二个终态事件', async () => {
    const created = await request(execPort, 'POST', '/sessions', TOKEN, {});
    const sessionId = String(created.body.sessionId);
    const before = events.length;

    const accepted = await request(execPort, 'POST', '/execute', TOKEN, {
      taskId: 't_realstack_steer',
      sessionId,
      prompt:
        'T21 在飞注入：请调用 vteam-slow-probe 工具 __TOOL__:vteam-slow-probe:{"jobName":"inflight"}',
      agent: 'vteam-role',
    });
    expect(accepted.status).toBe(202);

    // 等模型真的发出了工具调用（mock provider 记录到本次请求）⇒ 此刻这一轮确定在飞
    const inflightDeadline = Date.now() + 60_000;
    while (Date.now() < inflightDeadline) {
      const recorded = readRecordedRequests(requestsFile);
      if (
        recorded.some(
          (r) => userTextOf(r).includes('__TOOL__:vteam-slow-probe'),
        )
      ) {
        break;
      }
      await sleep(200);
    }

    // 在飞注入：控制面 → worker 执行端点（delivery:"steer"）⇒ 必须被受理
    const steered = await request(
      execPort,
      'POST',
      `/sessions/${sessionId}/prompt`,
      TOKEN,
      {
        prompt: 'T21 在飞注入：补充指令',
        agent: 'vteam-role',
        delivery: 'steer',
      },
    );
    expect(steered.status).toBe(200);
    expect(steered.body.admitted).toBe(true);
    expect(steered.body.sessionId).toBe(sessionId);

    // 等这一轮收口
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const terminal = events
        .slice(before)
        .filter(
          (e) =>
            e.type === 'task.completed' ||
            (e.type === 'agent.status' && e.payload.status === 'error'),
        );
      if (terminal.length > 0) {
        break;
      }
      await sleep(200);
    }

    const runEvents = events.slice(before);
    const terminalEvents = runEvents.filter(
      (e) =>
        e.type === 'task.completed' ||
        (e.type === 'agent.status' && e.payload.status === 'error'),
    );
    // 恰好一个终态事件：在飞注入**不**产生第二个
    expect(terminalEvents).toHaveLength(1);
    expect(
      runEvents.filter((e) => e.type === 'task.completed').length,
    ).toBeLessThanOrEqual(1);
  });

  it('真栈冒烟标记（binary 版本 / 隔离域 / 事件计数）', () => {
    const version = spawnSync(OPENCODE_BIN!, ['--version'], { encoding: 'utf8' });
    expect(String(version.stdout).trim()).toMatch(/^opencode v?2\./);
    // 事件流留痕（便于人工复核证据）
    expect(events.length).toBeGreaterThan(0);
  });
});
