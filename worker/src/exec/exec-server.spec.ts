/**
 * T10 执行端点测试（node:http POST /execute）。
 *
 * mock V1Driver + EventSender（fetch 注入收集），真实启动 ExecServer（port 0 随机），
 * 覆盖：
 * - /execute 返回 202 {accepted:true} 且驱动 serve（createSession + sendMessage + awaitCompletion）
 * - 事件按序上送：session.updated(running) → message.part.delta（增量去重）→
 *   session.updated(idle) → task.completed
 * - 失败路径：awaitCompletion 首字超时 → agent.status(error) + session.updated(failed) + abort
 * - trackInstance 计数增减（执行期间 = 1，完成后归零）
 * - 请求校验：非 /execute 404、非 POST 405、缺 prompt 400
 */

import * as http from 'http';
import { EventSender } from '../client/event-client';
import {
  V1Driver,
  ServeMessage,
  ServePart,
  DriverRequestError,
} from '../driver/v1-driver';
import { getLoad, resetInstanceCount } from '../instance-tracker';
import { ExecServer } from './exec-server';

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
  const getMessages = jest.fn().mockResolvedValue(FINISH_MSGS) as jest.Mock;
  const abort = jest.fn().mockResolvedValue(undefined);
  const driver = { createSession, sendMessage, getMessages, abort } as unknown as V1Driver;
  return { driver, createSession, sendMessage, getMessages, abort };
}

/** 收集事件 sender（复用 git-op-reporter.spec 模式：send 包装同步 push）。 */
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
      await waitFor(() => sent.length >= 4);
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
      await waitFor(() => sent.length >= 4);
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
      await waitFor(() => sent.length >= 4);
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
      await waitFor(() => sent.length >= 3);
      // createSession 失败 → 不重试 sendMessage，直接走 error 收敛（sessionId 仍为复用的旧 id）
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[0].payload).toMatchObject({ sessionId: 'ses_existing', status: 'running' });
      expect(terminal[1].payload).toMatchObject({ sessionId: 'ses_existing', status: 'error' });
      expect(String(terminal[1].payload.error)).toContain('serve 未就绪');
      expect(terminal[2].payload).toMatchObject({ sessionId: 'ses_existing', status: 'failed' });
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
      await waitFor(() => sent.length >= 3);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('ses_1', expect.anything());
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[1].payload.status).toBe('error');
      expect(terminal[2].payload).toMatchObject({ sessionId: 'ses_1', status: 'failed' });
    } finally {
      await exec.stop();
    }
  });

  it('事件按序上送：running → delta（增量去重）→ idle → task.completed', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages
      .mockResolvedValueOnce(PARTIAL_MSGS)
      .mockResolvedValueOnce(FINISH_MSGS_2);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, pollMs: 5, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', channelId: 'ch_1', prompt: 'go' });
      await waitFor(() => sent.length >= 5);
      expect(sent.map((s) => s.type)).toEqual([
        'session.updated',
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
      // 增量 delta：第一轮只含消息 a1 的 parts，第二轮只含新消息 a2 的 parts（按消息 id 去重）
      expect(sent[1].payload).toMatchObject({ status: 'streaming' });
      expect((sent[1].payload.parts as ServePart[]).map((p) => p.type)).toEqual(['step-start', 'text']);
      expect((sent[2].payload.parts as ServePart[]).map((p) => p.type)).toEqual(['text', 'step-finish']);
      // idle + completed（text 聚合 Hello done）
      expect(sent[3].payload).toMatchObject({ sessionId: 'ses_1', status: 'idle' });
      expect(sent[4].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        channelId: 'ch_1',
        text: 'Hello done',
      });
      expect(sent[4].payload.cost).toBe(0.5);
    } finally {
      await exec.stop();
    }
  });

  it('失败路径（awaitCompletion 首字超时）→ agent.status(error) + session.updated(failed) + abort', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue(STEP_START_ONLY);
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 60, pollMs: 5, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      await postExecute(bound, { taskId: 't_1', agentId: 'a_1', prompt: 'go' });
      await waitFor(() => sent.length >= 4);
      // 超时前 onPoll 会先上送流式 delta（step-start）；核心终态序列不受影响
      const terminal = sent.filter((s) => s.type !== 'message.part.delta');
      expect(terminal.map((s) => s.type)).toEqual([
        'session.updated',
        'agent.status',
        'session.updated',
      ]);
      expect(terminal[0].payload).toMatchObject({ status: 'running' });
      expect(terminal[1].payload).toMatchObject({
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        status: 'error',
      });
      expect(String(terminal[1].payload.error)).toContain('超时');
      expect(terminal[2].payload).toMatchObject({ status: 'failed' });
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
    getMessages.mockImplementation(async () => {
      expect(getLoad().instances).toBe(1);
      return FINISH_MSGS;
    });
    const { sender, sent } = createSender();
    const exec = new ExecServer({ port: 0, driver, sender, firstTokenTimeoutMs: 1000, logger: SILENT_LOGGER });
    const bound = await exec.start();
    try {
      expect(getLoad().instances).toBe(0);
      await postExecute(bound, { taskId: 't_1', prompt: 'go' });
      await waitFor(() => getLoad().instances === 0);
      await waitFor(() => sent.length >= 4);
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
