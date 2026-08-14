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
import { ExecServer, MAX_FILE_FETCH_BYTES } from './exec-server';

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
