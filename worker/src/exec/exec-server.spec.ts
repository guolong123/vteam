/**
 * T10 执行端点测试（node:http POST /execute + FR-41 GET /file）。
 *
 * mock V1Driver + EventSender（fetch 注入收集），真实启动 ExecServer（port 0 随机），
 * 覆盖：
 * - /execute 返回 202 {accepted:true} 且驱动 serve（createSession + sendMessage + awaitCompletion）
 * - 事件按序上送：session.updated(running) → message.part.delta（增量去重）→
 *   session.updated(idle) → task.completed
 * - 失败路径：awaitCompletion 首字超时 → agent.status(error) + session.updated(failed) + abort
 * - trackInstance 计数增减（执行期间 = 1，完成后归零）
 * - 请求校验：非 /execute 404、非 POST 405、缺 prompt 400
 * - GET /file（FR-41）：鉴权 401（缺失/错误 token）、成功 200 二进制内容、
 *   不存在 404、目录 400、超 10MB 413、缺 path 400
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import { join } from 'path';
import { EventSender } from '../client/event-client';
import {
  V1Driver,
  ServeMessage,
  ServePart,
  DriverRequestError,
} from '../driver/v1-driver';
import { getLoad, resetInstanceCount } from '../instance-tracker';
import {
  ExecServer,
  MAX_FILE_FETCH_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PLAN_DOC_BYTES,
  MAX_PLAN_UPLOAD_BYTES,
} from './exec-server';

function asstMsg(id: string, parts: ServePart[]): ServeMessage {
  return { info: { id, role: 'assistant' }, parts };
}

function textPart(text: string): ServePart {
  return { id: `p_${text}`, type: 'text', text };
}

function stepFinishPart(): ServePart {
  return { id: 'p_fin', type: 'step-finish', reason: 'stop', cost: 0.5, tokens: { input: 10, output: 2 } };
}

/** 首轮即完成的 serve messages（含 step-finish）。 */
const FINISH_MSGS: ServeMessage[] = [
  asstMsg('a1', [textPart('Hello'), stepFinishPart()]),
];

/** 两轮完成：首轮无 finish（触发增量轮询），次轮追加 finish。 */
const PARTIAL_MSGS: ServeMessage[] = [
  asstMsg('a1', [{ id: 'p_start', type: 'step-start' }, textPart('Hello')]),
];
const FINISH_MSGS_2: ServeMessage[] = [
  ...PARTIAL_MSGS,
  asstMsg('a2', [textPart(' done'), stepFinishPart()]),
];

/** 永无首字（仅 step-start，无 text part → 首字超时路径）。 */
const STEP_START_ONLY: ServeMessage[] = [
  asstMsg('a1', [{ id: 'p_start', type: 'step-start' }]),
];

function mockDriver(): {
  driver: V1Driver;
  createSession: jest.Mock;
  sendMessage: jest.Mock;
  getMessages: jest.Mock;
  abort: jest.Mock;
} {
  const createSession = jest.fn().mockResolvedValue('ses_1');
  const sendMessage = jest.fn().mockResolvedValue(undefined);
  // P1：sendAndAwait 先取基线（sendMessage 前 getMessages）；前 2 次调用可能都是
  // 基线（含 404 重建会话后的新基线），返回空会话 []；之后为 awaitCompletion 轮询。
  let baseCalls = 0;
  const getMessages = jest.fn().mockImplementation(async () => {
    baseCalls += 1;
    return baseCalls <= 2 ? [] : FINISH_MSGS;
  }) as jest.Mock;
  const abort = jest.fn().mockResolvedValue(undefined);
  const driver = { createSession, sendMessage, getMessages, abort } as unknown as V1Driver;
  return { driver, createSession, sendMessage, getMessages, abort };
}

/** 收集事件 sender（send 包装同步 push 的测试辅助）。 */
function createSender(): {
  sender: EventSender;
  sent: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const fetchImpl = (async () => {
    return { ok: true, status: 202, statusText: 'Accepted' } as Response;
  }) as typeof fetch;
  const sender = new EventSender({
    serverUrl: 'http://server:3000',
    workerId: 'w_test',
    workerToken: 'tok',
    startSeq: 0,
    bootId: 'boot',
    fetchImpl,
    maxRetries: 0,
    logger: { warn: () => undefined, error: () => undefined },
  });
  const rawSend = sender.send.bind(sender);
  sender.send = (async (type: string, payload: Record<string, unknown>) => {
    sent.push({ type, payload });
    return rawSend(type as never, payload);
  }) as EventSender['send'];
  return { sender, sent };
}

const SILENT_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

function postExecute(
  port: number,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/execute',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c: Buffer) => {
          chunks += c.toString('utf8');
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(chunks || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor 超时');
}

/** FR-41：GET /file?path=...（可带 X-Worker-Token），返回状态码 + 原始响应字节。 */
function getFile(
  port: number,
  filePath: string,
  token?: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers['X-Worker-Token'] = token;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/file?path=${encodeURIComponent(filePath)}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('ExecServer：POST /execute（T10 执行端点）', () => {
  beforeEach(() => {
    resetInstanceCount();
  });

  it('202 立即返回 + 驱动 serve（无 sessionId → createSession；parts 字符串归一）', async () => {
    const { driver, createSession, sendMessage } = mockDriver();
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await postExecute(bound, { taskId: 't_1', prompt: 'hello' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
      await waitFor(() => sent.length >= 5);
      expect(createSession).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith('ses_1', {
        model: null,
        agent: undefined,
        parts: [{ type: 'text', text: 'hello' }],
        directory: undefined,
      });
    } finally {
      await exec.stop();
    }
  });

  it('directory 存在时：执行前 mkdir -p 兜底创建（server/worker 文件系统可能不共享，is_0000000010）', async () => {
    const { driver, sendMessage } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    const parent = join(os.tmpdir(), `keta-exec-wd-${process.pid}-${Date.now()}`);
    const workDir = join(parent, '深 开发');
    try {
      await postExecute(bound, { taskId: 't_1', prompt: 'go', directory: workDir });
      await waitFor(() => sendMessage.mock.calls.length > 0);
      // worker 执行端点兜底创建目录（递归），且 directory 原样透传 serve
      expect(fs.existsSync(workDir)).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith('ses_1', expect.objectContaining({ directory: workDir }));
    } finally {
      await exec.stop();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('browserProfileRoot 指定时：执行前按 opencode 会话预建 browser-profiles/<scope>/（per-agent 隔离落点）', async () => {
    const { driver, sendMessage } = mockDriver();
    const { sender } = createSender();
    const profileRoot = fs.mkdtempSync(join(os.tmpdir(), 'keta-profroot-'));
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, browserProfileRoot: profileRoot, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', sessionId: 'ses_iso', prompt: 'go' });
      await waitFor(() => sendMessage.mock.calls.length > 0);
      expect(fs.existsSync(join(profileRoot, 'browser-profiles', 'ses_iso'))).toBe(true);
    } finally {
      await exec.stop();
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it('复用会话：请求带 sessionId 时不 createSession（端点按 opencode 会话 id 区分）', async () => {
    const { driver, createSession, sendMessage } = mockDriver();
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', sessionId: 'ses_existing', prompt: 'go' });
      await waitFor(() => sent.length >= 5);
      // 无 404 → 不重建：createSession 不调用、sendMessage 仅一次且用原 id（回归）
      expect(createSession).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('ses_existing', expect.anything());
      // 事件 sessionId = 复用的会话 id
      expect(sent[0].payload.sessionId).toBe('ses_existing');
      const completed = sent.find((s) => s.type === 'task.completed');
      expect(completed?.payload.sessionId).toBe('ses_existing');
    } finally {
      await exec.stop();
    }
  });

  it('复用会话 404（serve 重启后旧会话丢失）→ 自动 createSession 新建 → 重试成功，事件用新 sessionId', async () => {
    const { driver, createSession, sendMessage } = mockDriver();
    createSession.mockResolvedValue('ses_new');
    sendMessage
      .mockRejectedValueOnce(new DriverRequestError('prompt_async HTTP 404', 404))
      .mockResolvedValue(undefined);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', sessionId: 'ses_existing', prompt: 'go' });
      await waitFor(() => sent.length >= 5);
      // 404 后重建会话重试一次
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenCalledWith('ses_existing', expect.anything());
      expect(sendMessage).toHaveBeenLastCalledWith('ses_new', expect.anything());
      // 终态事件 sessionId = 新会话 id
      const idle = sent.find((s) => s.type === 'session.updated' && s.payload.status === 'idle');
      expect(idle?.payload.sessionId).toBe('ses_new');
      const completed = sent.find((s) => s.type === 'task.completed');
      expect(completed?.payload).toMatchObject({ sessionId: 'ses_new', text: 'Hello' });
    } finally {
      await exec.stop();
    }
  });

  it('复用会话 404 → 回退 createSession 也失败 → agent.status(error) + session.updated(failed)', async () => {
    const { driver, createSession, sendMessage } = mockDriver();
    createSession.mockRejectedValue(new Error('serve 未就绪'));
    sendMessage.mockRejectedValue(new DriverRequestError('prompt_async HTTP 404', 404));
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', sessionId: 'ses_existing', prompt: 'go' });
      await waitFor(() => sent.length >= 4);
      // createSession 失败 → 不重试 sendMessage，直接走 error 收敛（sessionId 仍为复用的旧 id）
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[0].payload).toMatchObject({ sessionId: 'ses_existing', status: 'running' });
      expect(terminal[1].payload).toMatchObject({ sessionId: 'ses_existing', status: 'loading', phase: 'thinking' });
      expect(terminal[2].payload).toMatchObject({ sessionId: 'ses_existing', status: 'error' });
      expect(String(terminal[2].payload.error)).toContain('serve 未就绪');
      expect(terminal[3].payload).toMatchObject({ sessionId: 'ses_existing', status: 'failed' });
    } finally {
      await exec.stop();
    }
  });

  it('无 sessionId 新建场景：sendMessage 404 不触发重建（createSession 仅一次）→ error + failed', async () => {
    const { driver, createSession, sendMessage } = mockDriver();
    sendMessage.mockRejectedValue(new DriverRequestError('prompt_async HTTP 404', 404));
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', prompt: 'go' });
      await waitFor(() => sent.length >= 4);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('ses_1', expect.anything());
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[1].payload).toMatchObject({ status: 'loading', phase: 'thinking' });
      expect(terminal[2].payload.status).toBe('error');
      expect(terminal[3].payload).toMatchObject({ sessionId: 'ses_1', status: 'failed' });
    } finally {
      await exec.stop();
    }
  });

  it('事件按序上送：running → loading → delta（增量去重）→ idle → task.completed', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages
      .mockResolvedValueOnce([]) // P1：基线（sendMessage 前）
      .mockResolvedValueOnce(PARTIAL_MSGS)
      .mockResolvedValueOnce(FINISH_MSGS_2);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, pollMs: 5, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', channelId: 'ch_1', prompt: 'go' });
      await waitFor(() => sent.length >= 6);
      expect(sent.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'message.part.delta',
        'message.part.delta',
        'session.updated',
        'task.completed',
      ]);
      // running
      expect(sent[0].payload).toMatchObject({
        sessionId: 'ses_1',
        taskId: 't_1',
        agentId: 'a_1',
        channelId: 'ch_1',
        status: 'running',
      });
      // loading：成功路径主动上报（status=loading phase=thinking），server 侧据此清首字 watchdog
      expect(sent[1].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        channelId: 'ch_1',
        status: 'loading',
        phase: 'thinking',
      });
      // 增量 delta：第一轮只含消息 a1 的 parts，第二轮只含新消息 a2 的 parts（按消息 id 去重）
      expect(sent[2].payload).toMatchObject({ status: 'streaming' });
      expect((sent[2].payload.parts as ServePart[]).map((p) => p.type)).toEqual(['step-start', 'text']);
      expect((sent[3].payload.parts as ServePart[]).map((p) => p.type)).toEqual(['text', 'step-finish']);
      // idle + completed（text 聚合 Hello done）
      expect(sent[4].payload).toMatchObject({ sessionId: 'ses_1', status: 'idle' });
      expect(sent[5].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        channelId: 'ch_1',
        text: 'Hello done',
      });
      expect(sent[5].payload.cost).toBe(0.5);
    } finally {
      await exec.stop();
    }
  });

  it('失败路径（awaitCompletion 首字超时）→ agent.status(error) + session.updated(failed) + abort', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValueOnce([]).mockResolvedValue(STEP_START_ONLY);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 60, pollMs: 5, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', prompt: 'go' });
      await waitFor(() => sent.length >= 5);
      // 超时前 onPoll 会先上送流式 delta（step-start）；核心终态序列不受影响
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[0].payload).toMatchObject({ status: 'running' });
      expect(terminal[1].payload).toMatchObject({ status: 'loading', phase: 'thinking' });
      expect(terminal[2].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        status: 'error',
      });
      expect(String(terminal[2].payload.error)).toContain('超时');
      expect(terminal[3].payload).toMatchObject({ status: 'failed' });
      expect(abort).toHaveBeenCalledWith('ses_1');
    } finally {
      await exec.stop();
    }
  });

  it('serve 日志出现 Rate limit（serveErrorReader + onServeError 命中）→ 执行失败 + 错误文本含 Rate limit（快速 abort，不等首字超时）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 永无首字（仅 step-start）；首字超时 1000ms 远大于测试耗时——能提前失败说明是
    // serve 日志检测（Rate limit 只写 serve stderr，不透传 message.info.error）而非超时
    getMessages.mockResolvedValueOnce([]).mockResolvedValue(STEP_START_ONLY);
    const { sender, sent } = createSender();
    const serveLines = [
      'message="stream error" time="2026-01-01T00:00:00Z" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
    ];
    const exec = new ExecServer({
      port: 0,
      driver,
      sender,
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', prompt: 'go' });
      await waitFor(() => sent.length >= 4);
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[1].payload).toMatchObject({ status: 'loading', phase: 'thinking' });
      expect(terminal[2].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        status: 'error',
      });
      // 错误文本透传 serve 日志中的 Rate limit（去 AI_APICallError: 前缀），非「模型无任何输出」
      expect(String(terminal[2].payload.error)).toContain('Rate limit exceeded. Please try again later.');
      expect(String(terminal[2].payload.error)).not.toContain('AI_APICallError');
      expect(String(terminal[2].payload.error)).not.toContain('模型无任何输出');
      expect(abort).toHaveBeenCalledWith('ses_1');
    } finally {
      await exec.stop();
    }
  });

  it('createSession 失败 → agent.status(error) + session.updated(failed) + trackInstance 归零（不 unhandled rejection）', async () => {
    const { driver, createSession } = mockDriver();
    createSession.mockRejectedValue(new Error('serve 未就绪'));
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', prompt: 'go' });
      await waitFor(() => sent.length >= 2);
      expect(sent.map((s) => s.type)).toEqual(['agent.status', 'session.updated']);
      expect(sent[0].payload.status).toBe('error');
      expect(sent[1].payload.status).toBe('failed');
      expect(getLoad().instances).toBe(0);
    } finally {
      await exec.stop();
    }
  });

  it('trackInstance：执行期间计数 = 1（驱动心跳 load），完成后归零', async () => {
    const { driver, getMessages } = mockDriver();
    let msgCalls = 0;
    getMessages.mockImplementation(async () => {
      expect(getLoad().instances).toBe(1);
      msgCalls += 1;
      return msgCalls === 1 ? [] : FINISH_MSGS; // P1：基线（空）→ 轮询完成
    });
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      expect(getLoad().instances).toBe(0);
      await postExecute(bound, { taskId: 't_1', prompt: 'go' });
      await waitFor(() => getLoad().instances === 0);
      await waitFor(() => sent.length >= 5);
      expect(getLoad().instances).toBe(0);
    } finally {
      await exec.stop();
    }
  });

  it('请求校验：非 /execute 404、非 POST 405、缺 prompt 400', async () => {
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const notFound = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: bound, path: '/other', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(notFound).toBe(404);

      const methodErr = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: bound, path: '/execute', method: 'GET' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(methodErr).toBe(405);

      const noPrompt = await postExecute(bound, { taskId: 't_1' });
      expect(noPrompt.status).toBe(400);
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：POST /execute 图片附件（问题二：图片进执行上下文）', () => {
  const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  });

  function stubDownload(bytes: Buffer, ok = true, status = 200): jest.Mock {
    const stub = jest.fn().mockResolvedValue({ ok, status, arrayBuffer: async () => bytes });
    (globalThis as unknown as { fetch: unknown }).fetch = stub;
    return stub;
  }

  it('/uploads/ 相对路径 + serverBaseUrl → 下载落盘 attachments/ + file part 并入 prompt', async () => {
    const stub = stubDownload(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { driver, sendMessage } = mockDriver();
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, serverBaseUrl: 'http://server:3000', logger: SILENT_LOGGER });
    const bound = await exec.start();
    const workDir = fs.mkdtempSync(join(os.tmpdir(), 'exec-attach-'));
    try {
      const res = await postExecute(bound, {
        taskId: 't_1',
        prompt: '看看图',
        directory: workDir,
        attachments: [{ url: '/uploads/a.png', mime: 'image/png', filename: 'a.png' }],
      });
      expect(res.status).toBe(202);
      await waitFor(() => sendMessage.mock.calls.length > 0);
      expect(stub).toHaveBeenCalledWith('http://server:3000/uploads/a.png', expect.anything());
      const parts = (sendMessage.mock.calls[0][1] as { parts: Array<Record<string, unknown>> }).parts;
      const file = parts.find((p) => p.type === 'file') as Record<string, unknown> | undefined;
      expect(file).toMatchObject({ type: 'file', mime: 'image/png', filename: 'a.png' });
      expect(String(file?.url)).toMatch(/^file:\/\//);
      expect(fs.existsSync(join(workDir, 'attachments', 'a.png'))).toBe(true);
      await waitFor(() => sent.length >= 5);
    } finally {
      await exec.stop();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('file:// 引用一律拒绝 → 注记文本 part 入 prompt，无 file part', async () => {
    const stub = stubDownload(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { driver, sendMessage } = mockDriver();
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, serverBaseUrl: 'http://server:3000', logger: SILENT_LOGGER });
    const bound = await exec.start();
    const workDir = fs.mkdtempSync(join(os.tmpdir(), 'exec-attach-'));
    try {
      await postExecute(bound, {
        taskId: 't_1',
        prompt: '看看图',
        directory: workDir,
        attachments: [{ url: 'file:///etc/passwd', mime: 'image/png', filename: 'x.png' }],
      });
      await waitFor(() => sendMessage.mock.calls.length > 0);
      expect(stub).not.toHaveBeenCalled();
      const parts = (sendMessage.mock.calls[0][1] as { parts: Array<Record<string, unknown>> }).parts;
      expect(parts.some((p) => p.type === 'file')).toBe(false);
      expect(parts.some((p) => p.type === 'text' && String(p.text).includes('未能送达'))).toBe(true);
      await waitFor(() => sent.length >= 5);
    } finally {
      await exec.stop();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('超 MAX_IMAGE_ATTACHMENT_BYTES → 跳过落盘 + 注记文本，不阻断执行', async () => {
    stubDownload(Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 1));
    const { driver, sendMessage } = mockDriver();
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, serverBaseUrl: 'http://server:3000', logger: SILENT_LOGGER });
    const bound = await exec.start();
    const workDir = fs.mkdtempSync(join(os.tmpdir(), 'exec-attach-'));
    try {
      await postExecute(bound, {
        taskId: 't_1',
        prompt: '看看图',
        directory: workDir,
        attachments: [{ url: '/uploads/big.png', mime: 'image/png', filename: 'big.png' }],
      });
      await waitFor(() => sendMessage.mock.calls.length > 0);
      const parts = (sendMessage.mock.calls[0][1] as { parts: Array<Record<string, unknown>> }).parts;
      expect(parts.some((p) => p.type === 'file')).toBe(false);
      expect(fs.existsSync(join(workDir, 'attachments', 'big.png'))).toBe(false);
      expect(parts.some((p) => p.type === 'text' && String(p.text).includes('超过'))).toBe(true);
      await waitFor(() => sent.length >= 5);
    } finally {
      await exec.stop();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('ExecServer：GET /file（FR-41 文件拉取端点）', () => {
  const TOKEN = 'tok';
  let tmpDir: string;
  let exec: ExecServer;
  let bound: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'exec-file-'));
    const { driver } = mockDriver();
    const { sender } = createSender();
    exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    bound = await exec.start();
  });

  afterEach(async () => {
    await exec.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('鉴权：缺失 token / 错误 token → 401（文件读取比 /execute 更敏感，独立把关）', async () => {
    const file = join(tmpDir, 'hello.txt');
    fs.writeFileSync(file, 'hello');

    const noToken = await getFile(bound, file);
    expect(noToken.status).toBe(401);

    const badToken = await getFile(bound, file, 'wrong-token');
    expect(badToken.status).toBe(401);
  });

  it('未配置 workerToken → 一律 401（宁可不暴露文件，绝不无鉴权放行）', async () => {
    const { driver } = mockDriver();
    const { sender } = createSender();
    const noTokenServer = new ExecServer({ port: 0, driver, sender, logger: SILENT_LOGGER });
    const noTokenBound = await noTokenServer.start();
    try {
      const file = join(tmpDir, 'secret.txt');
      fs.writeFileSync(file, 'secret');
      const res = await getFile(noTokenBound, file, 'anything');
      expect(res.status).toBe(401);
    } finally {
      await noTokenServer.stop();
    }
  });

  it('成功：200 返回文件原始字节（二进制安全）', async () => {
    const file = join(tmpDir, 'data.bin');
    const content = Buffer.from([0x00, 0x01, 0xff, 0x10, 0x41, 0x42]);
    fs.writeFileSync(file, content);

    const res = await getFile(bound, file, TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.equals(content)).toBe(true);
  });

  it('文件不存在 → 404', async () => {
    const res = await getFile(bound, join(tmpDir, 'missing.txt'), TOKEN);
    expect(res.status).toBe(404);
  });

  it('path 为目录 → 400（仅允许读取文件）', async () => {
    const res = await getFile(bound, tmpDir, TOKEN);
    expect(res.status).toBe(400);
  });

  it('超过 10MB 上限 → 413', async () => {
    const big = join(tmpDir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(MAX_FILE_FETCH_BYTES + 1, 0x41));

    const res = await getFile(bound, big, TOKEN);

    expect(res.status).toBe(413);
  });

  it('缺 path query 参数 → 400', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: bound, path: '/file', method: 'GET', headers: { 'X-Worker-Token': TOKEN } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it('非 GET 方法 → 405（不影响 /execute POST 主流程）', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: bound, path: '/file', method: 'POST', headers: { 'X-Worker-Token': TOKEN } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});

describe('ExecServer：GET /agents（opencode 原生 agent 清单端点）', () => {
  const TOKEN = 'tok';
  const WORK_DIR = '/data/vteam-worker';

  /** 发 GET /agents（可选 directory / token）。 */
  function getAgents(
    port: number,
    opts: { directory?: string; token?: string } = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token !== undefined) {
        headers['X-Worker-Token'] = opts.token;
      }
      const qs = opts.directory
        ? `?directory=${encodeURIComponent(opts.directory)}`
        : '';
      const req = http.request(
        { host: '127.0.0.1', port, path: `/agents${qs}`, method: 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: any = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              /* 保留原始文本 */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function serverWith(listAgents: jest.Mock, workDir?: string): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    (driver as any).listAgents = listAgents;
    return new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: TOKEN,
      workDir,
      logger: SILENT_LOGGER,
    });
  }

  it('鉴权：缺失 token / 错误 token → 401', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      expect((await getAgents(bound)).status).toBe(401);
      expect((await getAgents(bound, { token: 'wrong' })).status).toBe(401);
      expect(listAgents).not.toHaveBeenCalled();
    } finally {
      await exec.stop();
    }
  });

  it('未配置 workerToken → 一律 401', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const { driver } = mockDriver();
    const { sender } = createSender();
    (driver as any).listAgents = listAgents;
    const exec = new ExecServer({ port: 0, driver, sender, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      expect((await getAgents(bound, { token: 'anything' })).status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('成功：200 {agents} 透传 driver 结果', async () => {
    const agents = [
      { name: 'build', mode: 'primary', native: true },
      { name: 'plan', mode: 'primary', native: true },
      { name: 'my-agent', mode: 'primary', native: false },
    ];
    const listAgents = jest.fn().mockResolvedValue(agents);
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      const res = await getAgents(bound, { token: TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual(agents);
    } finally {
      await exec.stop();
    }
  });

  it('directory 显式传入 → 原样透传 driver（per-directory 隔离依赖它）', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      await getAgents(bound, { token: TOKEN, directory: '/data/vteam-worker/tasks/t_1' });
      expect(listAgents).toHaveBeenCalledWith('/data/vteam-worker/tasks/t_1');
    } finally {
      await exec.stop();
    }
  });

  it('未传 directory → 回落 workDir（与 serve cwd 一致）', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      await getAgents(bound, { token: TOKEN });
      expect(listAgents).toHaveBeenCalledWith(WORK_DIR);
    } finally {
      await exec.stop();
    }
  });

  it('未传 directory 且未配置 workDir → 400（不猜测目录，避免列出集合与实际不符）', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listAgents, undefined);
    const bound = await exec.start();
    try {
      const res = await getAgents(bound, { token: TOKEN });
      expect(res.status).toBe(400);
      expect(listAgents).not.toHaveBeenCalled();
    } finally {
      await exec.stop();
    }
  });

  it('driver 抛错（serve 未就绪/旧版无该端点）→ 502 {error}，不抛未捕获异常', async () => {
    const listAgents = jest.fn().mockRejectedValue(new Error('serve 未就绪'));
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      const res = await getAgents(bound, { token: TOKEN });
      expect(res.status).toBe(502);
      expect(String(res.body.error)).toContain('serve 未就绪');
    } finally {
      await exec.stop();
    }
  });

  it('非 GET 方法 → 405', async () => {
    const listAgents = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listAgents, WORK_DIR);
    const bound = await exec.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: bound,
            path: '/agents',
            method: 'POST',
            headers: { 'X-Worker-Token': TOKEN },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(405);
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：GET /todos（opencode 会话 todo 步骤端点）', () => {
  const TOKEN = 'tok';

  /** 发 GET /todos（可选 sessionId/directory/token）。 */
  function getTodos(
    port: number,
    opts: { sessionId?: string; directory?: string; token?: string } = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token !== undefined) {
        headers['X-Worker-Token'] = opts.token;
      }
      const params = new URLSearchParams();
      if (opts.sessionId !== undefined) params.set('sessionId', opts.sessionId);
      if (opts.directory !== undefined) params.set('directory', opts.directory);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const req = http.request(
        { host: '127.0.0.1', port, path: `/todos${qs}`, method: 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: any = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              /* 保留原始文本 */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function serverWith(listTodos: jest.Mock): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    (driver as any).listTodos = listTodos;
    return new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: TOKEN,
      logger: SILENT_LOGGER,
    });
  }

  it('鉴权：缺失 token / 错误 token → 401', async () => {
    const listTodos = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listTodos);
    const bound = await exec.start();
    try {
      expect((await getTodos(bound, { sessionId: 'ses_1' })).status).toBe(401);
      expect(
        (await getTodos(bound, { sessionId: 'ses_1', token: 'wrong' })).status,
      ).toBe(401);
      expect(listTodos).not.toHaveBeenCalled();
    } finally {
      await exec.stop();
    }
  });

  it('缺少 sessionId → 400（不猜测会话）', async () => {
    const listTodos = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listTodos);
    const bound = await exec.start();
    try {
      const res = await getTodos(bound, { token: TOKEN });
      expect(res.status).toBe(400);
      expect(listTodos).not.toHaveBeenCalled();
    } finally {
      await exec.stop();
    }
  });

  it('成功：200 {todos} 透传 driver 结果（含 directory 透传）', async () => {
    const todos = [
      { content: '拆解任务', status: 'completed' },
      { content: '写代码', status: 'in_progress' },
    ];
    const listTodos = jest.fn().mockResolvedValue(todos);
    const exec = serverWith(listTodos);
    const bound = await exec.start();
    try {
      const res = await getTodos(bound, {
        token: TOKEN,
        sessionId: 'ses_1',
        directory: '/data/vteam-worker/tasks/t_1',
      });
      expect(res.status).toBe(200);
      expect(res.body.todos).toEqual(todos);
      expect(listTodos).toHaveBeenCalledWith(
        'ses_1',
        '/data/vteam-worker/tasks/t_1',
      );
    } finally {
      await exec.stop();
    }
  });

  it('directory 缺省 → 传 undefined（serve 按会话 id 定位，与 per-directory 发现语义不同）', async () => {
    const listTodos = jest.fn().mockResolvedValue([]);
    const exec = serverWith(listTodos);
    const bound = await exec.start();
    try {
      await getTodos(bound, { token: TOKEN, sessionId: 'ses_1' });
      expect(listTodos).toHaveBeenCalledWith('ses_1', undefined);
    } finally {
      await exec.stop();
    }
  });

  it('driver 抛错（会话不存在/旧版无该端点）→ 502 {error}', async () => {
    const listTodos = jest.fn().mockRejectedValue(new Error('session 不存在'));
    const exec = serverWith(listTodos);
    const bound = await exec.start();
    try {
      const res = await getTodos(bound, { token: TOKEN, sessionId: 'ses_x' });
      expect(res.status).toBe(502);
      expect(String(res.body.error)).toContain('session 不存在');
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：question/权限确认旁路检测（onPoll 轮询 pending 上送）', () => {
  function mockDriverWithPending(): {
    driver: V1Driver;
    getMessages: jest.Mock;
    listQuestions: jest.Mock;
    listPermissions: jest.Mock;
  } {
    const createSession = jest.fn().mockResolvedValue('ses_1');
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    let baseCalls = 0;
    const getMessages = jest.fn().mockImplementation(async () => {
      baseCalls += 1;
      return baseCalls <= 2 ? [] : FINISH_MSGS;
    }) as jest.Mock;
    const abort = jest.fn().mockResolvedValue(undefined);
    const listQuestions = jest.fn().mockResolvedValue([]);
    const listPermissions = jest.fn().mockResolvedValue([]);
    const driver = {
      createSession,
      sendMessage,
      getMessages,
      abort,
      listQuestions,
      listPermissions,
    } as unknown as V1Driver;
    return { driver, getMessages, listQuestions, listPermissions };
  }

  it('serve 出现 pending question → 上送 session.question 事件（含 questions 详情，不 abort 正常完成）', async () => {
    const { driver, listQuestions } = mockDriverWithPending();
    listQuestions.mockResolvedValue([
      {
        id: 'que_1',
        sessionID: 'ses_1',
        questions: [{ question: '继续吗？', header: '确认', options: [{ label: '继续', description: 'x' }] }],
      },
    ]);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, pollMs: 5, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await postExecute(bound, { taskId: 't_1', prompt: 'hi' });
      expect(res.status).toBe(202);
      await waitFor(() =>
        sent.some((s) => s.type === 'session.question') && sent.some((s) => s.type === 'task.completed'),
      );
      const questionEvent = sent.find((s) => s.type === 'session.question');
      expect(questionEvent?.payload).toMatchObject({
        taskId: 't_1',
        sessionId: 'ses_1',
        requestId: 'que_1',
        questions: [{ question: '继续吗？', header: '确认' }],
      });
      // 正常完成不被旁路阻断
      expect(sent.some((s) => s.type === 'task.completed')).toBe(true);
    } finally {
      await exec.stop();
    }
  });

  it('同一 requestId 只上送一次（去重：多轮 poll 不重复上报）', async () => {
    const { driver, listQuestions } = mockDriverWithPending();
    listQuestions.mockResolvedValue([
      {
        id: 'que_1',
        sessionID: 'ses_1',
        questions: [{ question: 'q', header: 'h', options: [] }],
      },
    ]);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, pollMs: 5, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', prompt: 'hi' });
      await waitFor(() => sent.some((s) => s.type === 'task.completed'));
      // 多轮 poll 只上报一次
      const questionEvents = sent.filter((s) => s.type === 'session.question');
      expect(questionEvents).toHaveLength(1);
    } finally {
      await exec.stop();
    }
  });

  it('serve 出现 pending permission → 上送 session.permission 事件（type/pattern/title）', async () => {
    const { driver, listPermissions } = mockDriverWithPending();
    listPermissions.mockResolvedValue([
      { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['/data/*'] },
    ]);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, pollMs: 5, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', prompt: 'hi' });
      await waitFor(() => sent.some((s) => s.type === 'session.permission'));
      const permEvent = sent.find((s) => s.type === 'session.permission');
      expect(permEvent?.payload).toMatchObject({
        taskId: 't_1',
        sessionId: 'ses_1',
        permissionId: 'per_1',
        type: 'bash',
        pattern: '/data/*',
      });
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：POST /question-reply（server 下行转发用户回复）', () => {
  const TOKEN = 'tok';

  function questionReplyReq(
    port: number,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/question-reply',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...(token ? { 'X-Worker-Token': token } : {}),
          },
        },
        (res) => {
          let chunks = '';
          res.on('data', (c: Buffer) => {
            chunks += c.toString('utf8');
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(chunks || '{}') }),
          );
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  it('question 回复：POST → driver.replyQuestion 收到 answers，返回 200 {ok, kind: question}', async () => {
    const { driver } = mockDriver();
    const replyQuestion = jest.fn().mockResolvedValue(undefined);
    (driver as unknown as { replyQuestion: jest.Mock }).replyQuestion = replyQuestion;
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', requestId: 'que_1', answers: [['继续']] },
        TOKEN,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, kind: 'question' });
      expect(replyQuestion).toHaveBeenCalledWith('ses_1', 'que_1', [['继续']]);
    } finally {
      await exec.stop();
    }
  });

  it('question 拒绝：answers=null+reject → driver.rejectQuestion', async () => {
    const { driver } = mockDriver();
    const rejectQuestion = jest.fn().mockResolvedValue(undefined);
    (driver as unknown as { rejectQuestion: jest.Mock }).rejectQuestion = rejectQuestion;
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', requestId: 'que_1', answers: null, reject: true },
        TOKEN,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, kind: 'question', rejected: true });
      expect(rejectQuestion).toHaveBeenCalledWith('ses_1', 'que_1');
    } finally {
      await exec.stop();
    }
  });

  it('permission 回复：POST → driver.replyPermission(response)，返回 200 {ok, kind: permission}', async () => {
    const { driver } = mockDriver();
    const replyPermission = jest.fn().mockResolvedValue(undefined);
    (driver as unknown as { replyPermission: jest.Mock }).replyPermission = replyPermission;
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', permissionId: 'per_1', response: 'once' },
        TOKEN,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, kind: 'permission' });
      expect(replyPermission).toHaveBeenCalledWith('ses_1', 'per_1', 'once');
    } finally {
      await exec.stop();
    }
  });

  it('鉴权：缺失/错误 token → 401（与 /file 一致，涉及 serve 会话状态写入不放行）', async () => {
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const noToken = await questionReplyReq(bound, { sessionId: 'ses_1', requestId: 'que_1', answers: [] });
      expect(noToken.status).toBe(401);
      const badToken = await questionReplyReq(bound, { sessionId: 'ses_1', requestId: 'que_1', answers: [] }, 'wrong');
      expect(badToken.status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('缺 sessionId → 400；question 缺 requestId/answers → 400；permission response 非法 → 400', async () => {
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const noSession = await questionReplyReq(bound, { requestId: 'que_1', answers: [] }, TOKEN);
      expect(noSession.status).toBe(400);
      const noRequest = await questionReplyReq(bound, { sessionId: 'ses_1', answers: [] }, TOKEN);
      expect(noRequest.status).toBe(400);
      const noAnswers = await questionReplyReq(bound, { sessionId: 'ses_1', requestId: 'que_1' }, TOKEN);
      expect(noAnswers.status).toBe(400);
      const badResponse = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', permissionId: 'per_1', response: 'maybe' },
        TOKEN,
      );
      expect(badResponse.status).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('非 POST → 405', async () => {
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: bound, path: '/question-reply', method: 'GET', headers: { 'X-Worker-Token': TOKEN } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(405);
    } finally {
      await exec.stop();
    }
  });

  it('转发失败（serve 404 = 僵尸 requestId）→ 404 + code=QUESTION_EXPIRED（server 据此终态收敛）', async () => {
    const { driver } = mockDriver();
    const replyQuestion = jest
      .fn()
      .mockRejectedValue(new DriverRequestError('[v1-driver] /reply HTTP 404', 404));
    (driver as unknown as { replyQuestion: jest.Mock }).replyQuestion = replyQuestion;
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', requestId: 'que_stale', answers: [['x']] },
        TOKEN,
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('QUESTION_EXPIRED');
      expect(String(res.body.error)).toContain('HTTP 404');
    } finally {
      await exec.stop();
    }
  });

  it('转发失败（非 404，如 serve 500/网络错）→ 400 透传错误（保留现状，不误判僵尸）', async () => {
    const { driver } = mockDriver();
    const replyQuestion = jest
      .fn()
      .mockRejectedValue(new DriverRequestError('[v1-driver] /reply HTTP 500', 500));
    (driver as unknown as { replyQuestion: jest.Mock }).replyQuestion = replyQuestion;
    const { sender } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, workerToken: TOKEN, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      const res = await questionReplyReq(
        bound,
        { sessionId: 'ses_1', requestId: 'que_1', answers: [['x']] },
        TOKEN,
      );
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('HTTP 500');
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：GET /plan-files（计划文件同步端点）', () => {
  const TOKEN = 'tok';
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(join(os.tmpdir(), 'vteam-plan-'));
  });

  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  /** 直接往 `<dir>/.opencode/plans/` 落文件（模拟 opencode plan agent 写盘）。 */
  async function seedPlan(
    dir: string,
    name: string,
    content: string,
    mtime?: Date,
  ): Promise<string> {
    const plansDir = join(dir, '.opencode', 'plans');
    await fsp.mkdir(plansDir, { recursive: true });
    const full = join(plansDir, name);
    await fsp.writeFile(full, content, 'utf8');
    if (mtime) {
      await fsp.utimes(full, mtime, mtime);
    }
    return full;
  }

  function getPlanFiles(
    port: number,
    opts: { directory?: string; token?: string; method?: string } = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token !== undefined) {
        headers['X-Worker-Token'] = opts.token;
      }
      const qs = opts.directory ? `?directory=${encodeURIComponent(opts.directory)}` : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/plan-files${qs}`,
          method: opts.method ?? 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: any = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              /* 保留原始文本 */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function serverWith(opts: { workDir?: string; workerToken?: string } = {}): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    return new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: opts.workerToken ?? TOKEN,
      workDir: opts.workDir,
      logger: SILENT_LOGGER,
    });
  }

  it('鉴权：缺失 token / 错误 token → 401（不泄露目录结构，不读盘）', async () => {
    await seedPlan(workDir, 'a.md', '# A');
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      expect((await getPlanFiles(bound)).status).toBe(401);
      expect((await getPlanFiles(bound, { token: 'wrong' })).status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('未配置 workerToken → 一律 401', async () => {
    const exec = serverWith({ workDir, workerToken: '' });
    const bound = await exec.start();
    try {
      expect((await getPlanFiles(bound, { token: 'anything' })).status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('成功：200 {files} 含正文/大小/updatedAt/truncated（计划 Tab 一次拿全）', async () => {
    const mtime = new Date('2026-03-01T02:03:04.000Z');
    await seedPlan(workDir, 'plan.md', '# 计划正文\n步骤一', mtime);
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.files).toHaveLength(1);
      expect(res.body.files[0]).toEqual({
        name: 'plan.md',
        updatedAt: mtime.toISOString(),
        size: Buffer.byteLength('# 计划正文\n步骤一', 'utf8'),
        content: '# 计划正文\n步骤一',
        truncated: false,
      });
    } finally {
      await exec.stop();
    }
  });

  it('directory 显式传入 → 读该任务目录（per-task 隔离）；未传回落 workDir', async () => {
    const taskDir = join(workDir, 'tasks', 't_1');
    await seedPlan(taskDir, 't1.md', 'task1');
    await seedPlan(workDir, 'root.md', 'root');
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const scoped = await getPlanFiles(bound, { token: TOKEN, directory: taskDir });
      expect(scoped.body.files.map((f: any) => f.name)).toEqual(['t1.md']);
      const fallback = await getPlanFiles(bound, { token: TOKEN });
      expect(fallback.body.files.map((f: any) => f.name)).toEqual(['root.md']);
    } finally {
      await exec.stop();
    }
  });

  it('目录不存在 → 200 {files: []}（agent 还没写过计划是常态，不是错误）', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
    } finally {
      await exec.stop();
    }
  });

  it('未传 directory 且未配置 workDir → 400（不猜测目录）', async () => {
    const exec = serverWith({ workDir: undefined });
    const bound = await exec.start();
    try {
      expect((await getPlanFiles(bound, { token: TOKEN })).status).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('过滤：非 .md / 大写 .MD / 隐藏文件 / 子目录一律忽略，且按名排序', async () => {
    await seedPlan(workDir, 'b.md', 'B');
    await seedPlan(workDir, 'a.md', 'A');
    await fsp.writeFile(join(workDir, '.opencode', 'plans', 'note.txt'), 'x', 'utf8');
    await fsp.writeFile(join(workDir, '.opencode', 'plans', 'UP.MD'), 'x', 'utf8');
    await fsp.writeFile(join(workDir, '.opencode', 'plans', '.hidden.md'), 'x', 'utf8');
    await fsp.mkdir(join(workDir, '.opencode', 'plans', 'sub.md'), { recursive: true });
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      expect(res.body.files.map((f: any) => f.name)).toEqual(['a.md', 'b.md']);
    } finally {
      await exec.stop();
    }
  });

  it('回归：agent 把计划写在 .omo/plans/ 时也能读到（OmO 实际落点）', async () => {
    // 装了 OmO 后，计划模式下主 Agent 产出的文件落在 <dir>/.omo/plans/，
    // 只读 .opencode/plans/ 会得到空列表（实测：计划已写出但页面显示"暂无计划"）
    const plansDir = join(workDir, '.omo', 'plans');
    await fsp.mkdir(plansDir, { recursive: true });
    await fsp.writeFile(join(plansDir, 'plan.md'), '# OmO 计划', 'utf8');

    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      expect(res.status).toBe(200);
      expect(res.body.files.map((f: any) => f.name)).toEqual(['plan.md']);
      expect(res.body.files[0].content).toBe('# OmO 计划');
    } finally {
      await exec.stop();
    }
  });

  it('两个位置都有文件时合并返回（.omo 优先，同名去重）', async () => {
    await seedPlan(workDir, 'only-opencode.md', 'A');
    const omoDir = join(workDir, '.omo', 'plans');
    await fsp.mkdir(omoDir, { recursive: true });
    await fsp.writeFile(join(omoDir, 'only-omo.md'), 'B', 'utf8');
    await fsp.writeFile(join(omoDir, 'only-opencode.md'), 'B-wins', 'utf8');

    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      const byName = Object.fromEntries(
        res.body.files.map((f: any) => [f.name, f.content]),
      );
      expect(Object.keys(byName).sort()).toEqual(['only-omo.md', 'only-opencode.md']);
      // 同名时以 .omo/plans（优先级首位）为准
      expect(byName['only-opencode.md']).toBe('B-wins');
    } finally {
      await exec.stop();
    }
  });

  it('超 MAX_PLAN_DOC_BYTES 的单文件 → 截断 + truncated:true（size 仍为真实字节数）', async () => {
    const big = 'x'.repeat(MAX_PLAN_DOC_BYTES + 100);
    await seedPlan(workDir, 'big.md', big);
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await getPlanFiles(bound, { token: TOKEN });
      const file = res.body.files[0];
      expect(file.truncated).toBe(true);
      expect(file.content).toHaveLength(MAX_PLAN_DOC_BYTES);
      expect(file.size).toBe(MAX_PLAN_DOC_BYTES + 100);
    } finally {
      await exec.stop();
    }
  });

  it('非 GET 方法 → 405', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      expect((await getPlanFiles(bound, { token: TOKEN, method: 'POST' })).status).toBe(405);
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：POST /plan-file（计划文件直传端点）', () => {
  const TOKEN = 'tok';
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(join(os.tmpdir(), 'vteam-plan-up-'));
  });

  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  function postPlanFile(
    port: number,
    body: unknown,
    opts: { token?: string; method?: string } = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
      };
      if (opts.token !== undefined) {
        headers['X-Worker-Token'] = opts.token;
      }
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/plan-file',
          method: opts.method ?? 'POST',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              /* 保留原始文本 */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  function serverWith(opts: { workDir?: string; workerToken?: string } = {}): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    return new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: opts.workerToken ?? TOKEN,
      workDir: opts.workDir,
      logger: SILENT_LOGGER,
    });
  }

  it('鉴权：缺失 token / 错误 token → 401，不落盘', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const body = { directory: workDir, name: 'up.md', content: '# x' };
      expect((await postPlanFile(bound, body)).status).toBe(401);
      expect((await postPlanFile(bound, body, { token: 'wrong' })).status).toBe(401);
      await expect(fsp.stat(join(workDir, '.opencode', 'plans', 'up.md'))).rejects.toThrow();
    } finally {
      await exec.stop();
    }
  });

  it('未配置 workerToken → 一律 401', async () => {
    const exec = serverWith({ workDir, workerToken: '' });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name: 'up.md', content: '# x' },
        { token: 'anything' },
      );
      expect(res.status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('成功：200 {name, updatedAt} 且 <directory>/.omo/plans/ 出现该文件（目录自动创建）', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name: 'uploaded.md', content: '# 上传的计划' },
        { token: TOKEN },
      );
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('uploaded.md');
      expect(typeof res.body.updatedAt).toBe('string');
      const written = await fsp.readFile(
        join(workDir, '.omo', 'plans', 'uploaded.md'),
        'utf8',
      );
      expect(written).toBe('# 上传的计划');
    } finally {
      await exec.stop();
    }
  });

  it('同目录同名覆盖写（上传即替换，不做版本堆叠）', async () => {
    const plansDir = join(workDir, '.omo', 'plans');
    await fsp.mkdir(plansDir, { recursive: true });
    await fsp.writeFile(join(plansDir, 'same.md'), '旧内容', 'utf8');
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name: 'same.md', content: '新内容' },
        { token: TOKEN },
      );
      expect(res.status).toBe(200);
      expect(await fsp.readFile(join(plansDir, 'same.md'), 'utf8')).toBe('新内容');
      expect(await fsp.readdir(plansDir)).toEqual(['same.md']);
    } finally {
      await exec.stop();
    }
  });

  it('directory 缺省 → 回落 workDir；两者都缺 → 400', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const ok = await postPlanFile(
        bound,
        { name: 'fallback.md', content: '# f' },
        { token: TOKEN },
      );
      expect(ok.status).toBe(200);
      await expect(
        fsp.stat(join(workDir, '.omo', 'plans', 'fallback.md')),
      ).resolves.toBeTruthy();
    } finally {
      await exec.stop();
    }
    const noDir = serverWith({ workDir: undefined });
    const bound2 = await noDir.start();
    try {
      const res = await postPlanFile(
        bound2,
        { name: 'x.md', content: '# x' },
        { token: TOKEN },
      );
      expect(res.status).toBe(400);
    } finally {
      await noDir.stop();
    }
  });

  it.each([
    ['路径穿越 ../evil.md', '../evil.md'],
    ['子目录 a/b.md', 'a/b.md'],
    ['绝对路径 /tmp/evil.md', '/tmp/evil.md'],
    ['非 .md 扩展名 a.txt', 'a.txt'],
    ['无扩展名', 'noext'],
    ['以点开头', '.hidden.md'],
    ['非法字符 a b.md', 'a b.md'],
    ['空串', ''],
  ])('非法 name（%s）→ 400 且不落盘', async (_label, name) => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name, content: '# x' },
        { token: TOKEN },
      );
      expect(res.status).toBe(400);
      expect(await fsp.readdir(workDir)).toEqual([]);
    } finally {
      await exec.stop();
    }
  });

  it('content 非字符串（缺省/null/数字）→ 400', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      for (const content of [undefined, null, 123, { a: 1 }]) {
        const res = await postPlanFile(
          bound,
          { directory: workDir, name: 'c.md', content },
          { token: TOKEN },
        );
        expect(res.status).toBe(400);
      }
    } finally {
      await exec.stop();
    }
  });

  it('content 超 MAX_PLAN_UPLOAD_BYTES → 413 且不落盘', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name: 'huge.md', content: 'x'.repeat(MAX_PLAN_UPLOAD_BYTES + 1) },
        { token: TOKEN },
      );
      expect(res.status).toBe(413);
      expect(await fsp.readdir(workDir)).toEqual([]);
    } finally {
      await exec.stop();
    }
  });

  it('请求体非合法 JSON → 400', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: bound,
            path: '/plan-file',
            method: 'POST',
            headers: { 'X-Worker-Token': TOKEN, 'Content-Type': 'application/json' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end('not-json');
      });
      expect(status).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('非 POST 方法 → 405', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      const res = await postPlanFile(
        bound,
        { directory: workDir, name: 'm.md', content: '# x' },
        { token: TOKEN, method: 'GET' },
      );
      expect(res.status).toBe(405);
    } finally {
      await exec.stop();
    }
  });

  it('写入后 GET /plan-files 立即可见（上传→展示闭环）', async () => {
    const exec = serverWith({ workDir });
    const bound = await exec.start();
    try {
      await postPlanFile(
        bound,
        { directory: workDir, name: 'loop.md', content: '# 闭环' },
        { token: TOKEN },
      );
      const listed = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: bound,
            path: `/plan-files?directory=${encodeURIComponent(workDir)}`,
            method: 'GET',
            headers: { 'X-Worker-Token': TOKEN },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(listed.files.map((f: any) => f.name)).toEqual(['loop.md']);
      expect(listed.files[0].content).toBe('# 闭环');
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：GET/POST /omo-config（OmO agent 模型配置读写）', () => {
  const TOKEN = 'tok';
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(join(os.tmpdir(), 'vteam-omo-'));
  });

  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  function serverFor(opts: { workDir?: string | null; token?: string } = {}): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    return new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: opts.token ?? TOKEN,
      // 缺省用本用例的临时 workDir；显式传 null 才表示"未配置 workDir"
      workDir: opts.workDir === null ? undefined : (opts.workDir ?? workDir),
      logger: SILENT_LOGGER,
    });
  }

  function req(
    port: number,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      const headers: Record<string, string> = {};
      if (token !== undefined) headers['X-Worker-Token'] = token;
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(data));
      }
      const r = http.request(
        { host: '127.0.0.1', port, path: '/omo-config', method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = raw;
            try { parsed = JSON.parse(raw); } catch { /* 原文 */ }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  it('鉴权：缺失/错误 token → 401', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      expect((await req(bound, 'GET')).status).toBe(401);
      expect((await req(bound, 'GET', undefined, 'wrong')).status).toBe(401);
      expect((await req(bound, 'POST', { agents: {} }, 'wrong')).status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('未配置 workDir → 400（不猜目录）', async () => {
    const exec = serverFor({ workDir: null });
    const bound = await exec.start();
    try {
      expect((await req(bound, 'GET', undefined, TOKEN)).status).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('GET：无配置时返回空 agents + available 全量 agent 名', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      const res = await req(bound, 'GET', undefined, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual({});
      expect(res.body.available).toEqual(
        expect.arrayContaining(['sisyphus', 'prometheus', 'atlas']),
      );
      expect(res.body.available).toHaveLength(14);
      // 透出生效文件路径：全新环境（无文件）→ 指向新位置
      expect(res.body.configPath).toBe(join('.omo', 'omo.jsonc'));
      expect(res.body.configKind).toBe('none');
    } finally {
      await exec.stop();
    }
  });

  it('POST：写入后 GET 回读一致，且落到实际生效的 .omo/omo.jsonc', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      const post = await req(
        bound,
        'POST',
        { agents: { sisyphus: 'opencode/big-pickle', prometheus: 'opencode/big-pickle' } },
        TOKEN,
      );
      expect(post.status).toBe(200);
      expect(post.body.agents).toEqual({
        sisyphus: 'opencode/big-pickle',
        prometheus: 'opencode/big-pickle',
      });
      const get = await req(bound, 'GET', undefined, TOKEN);
      expect(get.body.agents).toEqual(post.body.agents);
      // OmO 优先读 .omo/omo.jsonc（实测：同时存在时它胜出），故写入必须落这里
      const onDisk = JSON.parse(
        await fsp.readFile(join(workDir, '.omo', 'omo.jsonc'), 'utf8'),
      );
      expect(onDisk.agents.sisyphus).toEqual({ model: 'opencode/big-pickle' });
    } finally {
      await exec.stop();
    }
  });

  it('POST：增量合并（只改传入项，其余保留）+ 空串清除覆盖', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      await req(bound, 'POST', { agents: { sisyphus: 'a/one', atlas: 'a/two' } }, TOKEN);
      const merged = await req(bound, 'POST', { agents: { sisyphus: 'b/three' } }, TOKEN);
      expect(merged.body.agents).toEqual({ sisyphus: 'b/three', atlas: 'a/two' });
      const cleared = await req(bound, 'POST', { agents: { sisyphus: '' } }, TOKEN);
      expect(cleared.body.agents).toEqual({ atlas: 'a/two' });
    } finally {
      await exec.stop();
    }
  });

  it('POST：agents 缺失/非对象/值非字符串 → 400', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      expect((await req(bound, 'POST', {}, TOKEN)).status).toBe(400);
      expect((await req(bound, 'POST', { agents: [] }, TOKEN)).status).toBe(400);
      expect((await req(bound, 'POST', { agents: 'x' }, TOKEN)).status).toBe(400);
      expect(
        (await req(bound, 'POST', { agents: { sisyphus: 123 } }, TOKEN)).status,
      ).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('保存后触发重启：响应带 restart=executed（配置需重启才生效）', async () => {
    const restartServe = jest.fn().mockResolvedValue('executed');
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({
      port: 0,
      driver,
      sender,
      workerToken: TOKEN,
      workDir,
      restartServe,
      logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      const res = await req(bound, 'POST', { agents: { sisyphus: 'a/b' } }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.restart).toBe('executed');
      expect(restartServe).toHaveBeenCalledTimes(1);
      // 重启原因要能区分是 OmO 配置触发的（便于日志排障）
      expect(String(restartServe.mock.calls[0][0])).toContain('omo-config');
    } finally {
      await exec.stop();
    }
  });

  it('有活跃会话时重启挂起：restart=pending 透传给前端（保存仍算成功）', async () => {
    const restartServe = jest.fn().mockResolvedValue('pending');
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({
      port: 0, driver, sender, workerToken: TOKEN, workDir,
      restartServe, logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      const res = await req(bound, 'POST', { agents: { atlas: 'a/b' } }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.restart).toBe('pending');
      // 配置已落盘（不因挂起而回滚）
      const onDisk = JSON.parse(
        await fsp.readFile(join(workDir, '.omo', 'omo.jsonc'), 'utf8'),
      );
      expect(onDisk.agents.atlas).toEqual({ model: 'a/b' });
    } finally {
      await exec.stop();
    }
  });

  it('未注入 restartServe → restart=skipped，保存照常成功（旧行为兼容）', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      const res = await req(bound, 'POST', { agents: { sisyphus: 'a/b' } }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.restart).toBe('skipped');
    } finally {
      await exec.stop();
    }
  });

  it('重启失败不导致保存失败：restart=skipped，配置仍落盘', async () => {
    const restartServe = jest.fn().mockRejectedValue(new Error('serve 起不来'));
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({
      port: 0, driver, sender, workerToken: TOKEN, workDir,
      restartServe, logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      const res = await req(bound, 'POST', { agents: { sisyphus: 'a/b' } }, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.restart).toBe('skipped');
      const onDisk = JSON.parse(
        await fsp.readFile(join(workDir, '.omo', 'omo.jsonc'), 'utf8'),
      );
      expect(onDisk.agents.sisyphus).toEqual({ model: 'a/b' });
    } finally {
      await exec.stop();
    }
  });

  it('GET 不触发重启（只有写路径才重启）', async () => {
    const restartServe = jest.fn().mockResolvedValue('executed');
    const { driver } = mockDriver();
    const { sender } = createSender();
    const exec = new ExecServer({
      port: 0, driver, sender, workerToken: TOKEN, workDir,
      restartServe, logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      await req(bound, 'GET', undefined, TOKEN);
      expect(restartServe).not.toHaveBeenCalled();
    } finally {
      await exec.stop();
    }
  });

  it('非 GET/POST 方法 → 405', async () => {
    const exec = serverFor();
    const bound = await exec.start();
    try {
      expect((await req(bound, 'DELETE', undefined, TOKEN)).status).toBe(405);
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：GET /omo-agent-prompt（按需取单 agent 提示词）', () => {
  const TOKEN = 'tok';
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(join(os.tmpdir(), 'vteam-omo-prompt-'));
  });
  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  function serverWith(listAgents: jest.Mock): ExecServer {
    const { driver } = mockDriver();
    const { sender } = createSender();
    (driver as any).listAgents = listAgents;
    return new ExecServer({
      port: 0, driver, sender, workerToken: TOKEN, workDir, logger: SILENT_LOGGER,
    });
  }

  function get(port: number, qs: string, token?: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token !== undefined) headers['X-Worker-Token'] = token;
      const r = http.request(
        { host: '127.0.0.1', port, path: `/omo-agent-prompt${qs}`, method: 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = raw;
            try { parsed = JSON.parse(raw); } catch { /* 原文 */ }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on('error', reject);
      r.end();
    });
  }

  const AGENTS = [
    { name: 'Prometheus - Plan Builder', description: 'Plan agent', mode: 'primary', prompt: 'You are Prometheus' },
    { name: 'oracle', description: 'Read-only consultant', mode: 'subagent', prompt: 'You are Oracle' },
  ];

  it('鉴权：缺失/错误 token → 401', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      expect((await get(bound, '?name=oracle')).status).toBe(401);
      expect((await get(bound, '?name=oracle', 'wrong')).status).toBe(401);
    } finally {
      await exec.stop();
    }
  });

  it('缺 name → 400', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      expect((await get(bound, '', TOKEN)).status).toBe(400);
    } finally {
      await exec.stop();
    }
  });

  it('配置键名（prometheus）能匹配 serve 展示名（"Prometheus - Plan Builder"）', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      const res = await get(bound, '?name=prometheus', TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.prompt).toBe('You are Prometheus');
      expect(res.body.name).toBe('Prometheus - Plan Builder');
    } finally {
      await exec.stop();
    }
  });

  it('展示名（含 " - 描述" 后缀）也能匹配', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      const res = await get(bound, `?name=${encodeURIComponent('Prometheus - Plan Builder')}`, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.prompt).toBe('You are Prometheus');
    } finally {
      await exec.stop();
    }
  });

  it('未注册的 agent → 404 且说明原因（不是 500）', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      const res = await get(bound, '?name=hephaestus', TOKEN);
      expect(res.status).toBe(404);
      expect(String(res.body.error)).toContain('未注册');
    } finally {
      await exec.stop();
    }
  });

  it('prompt 为空的原生 agent → 200 + empty:true（不报错）', async () => {
    const exec = serverWith(
      jest.fn().mockResolvedValue([{ name: 'build', description: 'Build', mode: 'primary', prompt: '' }]),
    );
    const bound = await exec.start();
    try {
      const res = await get(bound, '?name=build', TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.empty).toBe(true);
      expect(res.body.prompt).toBe('');
    } finally {
      await exec.stop();
    }
  });

  it('driver 抛错 → 502', async () => {
    const exec = serverWith(jest.fn().mockRejectedValue(new Error('serve down')));
    const bound = await exec.start();
    try {
      expect((await get(bound, '?name=oracle', TOKEN)).status).toBe(502);
    } finally {
      await exec.stop();
    }
  });

  it('非 GET → 405', async () => {
    const exec = serverWith(jest.fn().mockResolvedValue(AGENTS));
    const bound = await exec.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const r = http.request(
          { host: '127.0.0.1', port: bound, path: '/omo-agent-prompt?name=oracle', method: 'POST',
            headers: { 'X-Worker-Token': TOKEN } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        r.on('error', reject);
        r.end();
      });
      expect(status).toBe(405);
    } finally {
      await exec.stop();
    }
  });
});

describe('ExecServer：session→policy 映射（Todo 19 guard 会话映射）', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fsp.mkdtemp(join(os.tmpdir(), 'vteam-guardmap-'));
    resetInstanceCount();
  });

  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });
  });

  function sessionFile(sessionId: string): string {
    return join(workDir, '.vteam-role-guard', 'sessions', `${sessionId}.json`);
  }

  it('vteam agent 运行：prompt 前写映射，完成后删除', async () => {
    const { driver, sendMessage } = mockDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMessage.mockImplementation(() => gate);
    const { sender, sent } = createSender();
    const taskDir = join(workDir, 'tasks', 't_1');
    const exec = new ExecServer({
      port: 0, driver, sender, firstTokenTimeoutMs: 1000, workDir, logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      const res = await postExecute(bound, {
        taskId: 't_1',
        sessionId: 'ses_map1',
        agent: 'vteam-developer',
        directory: taskDir,
        prompt: 'go',
      });
      expect(res.status).toBe(202);
      // prompt 发送中（sendMessage 被 gate 阻塞）→ 映射已先写好
      await waitFor(() => fs.existsSync(sessionFile('ses_map1')));
      const onDisk = JSON.parse(fs.readFileSync(sessionFile('ses_map1'), 'utf8'));
      expect(onDisk).toEqual({ agent: 'vteam-developer', dir: taskDir });
      release();
      await waitFor(() => sent.some((s) => s.type === 'task.completed'));
      // 完成后清理映射文件
      await waitFor(() => !fs.existsSync(sessionFile('ses_map1')));
    } finally {
      release();
      await exec.stop();
    }
  });

  it('非 vteam agent / 未传 agent：不写映射（未映射 pass-through，不建目录）', async () => {
    for (const agent of [undefined, 'build'] as const) {
      const { driver } = mockDriver();
      const { sender, sent } = createSender();
      const exec = new ExecServer({
        port: 0, driver, sender, firstTokenTimeoutMs: 1000, workDir, logger: SILENT_LOGGER,
      });
      const bound = await exec.start();
      try {
        const res = await postExecute(bound, {
          taskId: 't_1',
          sessionId: `ses_nomap_${agent ?? 'none'}`,
          ...(agent ? { agent } : {}),
          prompt: 'go',
        });
        expect(res.status).toBe(202);
        await waitFor(() => sent.some((s) => s.type === 'task.completed'));
      } finally {
        await exec.stop();
      }
    }
    expect(fs.existsSync(join(workDir, '.vteam-role-guard'))).toBe(false);
  });

  it('复用会话残留错角色映射 → 执行中重写为当前 payload.agent（不误标）', async () => {
    const { driver, sendMessage } = mockDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMessage.mockImplementation(() => gate);
    const { sender, sent } = createSender();
    const taskDir = join(workDir, 'tasks', 't_2');
    // 预置过期残留：同一 ses_ id 上一次是 product 的映射（如 worker 重启孤儿文件）
    const sessionsDir = join(workDir, '.vteam-role-guard', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      sessionFile('ses_reuse'),
      JSON.stringify({ agent: 'vteam-product', dir: join(workDir, 'tasks', 't_1') }),
    );
    const exec = new ExecServer({
      port: 0, driver, sender, firstTokenTimeoutMs: 1000, workDir, logger: SILENT_LOGGER,
    });
    const bound = await exec.start();
    try {
      const res = await postExecute(bound, {
        taskId: 't_2',
        sessionId: 'ses_reuse',
        agent: 'vteam-architect',
        directory: taskDir,
        prompt: 'go',
      });
      expect(res.status).toBe(202);
      // prompt 发送中 → 映射已被重写为当前执行的 agent
      await waitFor(() => {
        if (!fs.existsSync(sessionFile('ses_reuse'))) {
          return false;
        }
        return (
          (JSON.parse(fs.readFileSync(sessionFile('ses_reuse'), 'utf8')) as { agent: string })
            .agent === 'vteam-architect'
        );
      });
      const onDisk = JSON.parse(fs.readFileSync(sessionFile('ses_reuse'), 'utf8'));
      expect(onDisk).toEqual({ agent: 'vteam-architect', dir: taskDir });
      release();
      await waitFor(() => sent.some((s) => s.type === 'task.completed'));
      // 本轮映射仍正常清理
      await waitFor(() => !fs.existsSync(sessionFile('ses_reuse')));
    } finally {
      release();
      await exec.stop();
    }
  });

  it('映射写失败只 warn 不阻断执行（仍 task.completed，无 error 事件）', async () => {
    const { driver } = mockDriver();
    const { sender, sent } = createSender();
    const warns: string[] = [];
    // workDir 指向已存在文件 → sessions mkdir 必败，写映射必抛
    const fileAsDir = join(workDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    const taskDir = join(workDir, 'tasks', 't_9');
    const exec = new ExecServer({
      port: 0,
      driver,
      sender,
      firstTokenTimeoutMs: 1000,
      workDir: fileAsDir,
      logger: {
        info: () => undefined,
        warn: (m: string) => warns.push(m),
        error: () => undefined,
      },
    });
    const bound = await exec.start();
    try {
      const res = await postExecute(bound, {
        taskId: 't_1',
        sessionId: 'ses_writefail',
        agent: 'vteam-developer',
        directory: taskDir,
        prompt: 'go',
      });
      expect(res.status).toBe(202);
      await waitFor(() => sent.some((s) => s.type === 'task.completed'));
      expect(
        sent.some((s) => s.type === 'agent.status' && s.payload.status === 'error'),
      ).toBe(false);
      expect(warns.some((m) => m.includes('session policy'))).toBe(true);
    } finally {
      await exec.stop();
    }
  });
});

