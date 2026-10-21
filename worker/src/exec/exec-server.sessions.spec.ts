/**
 * T10 会话/模型端点测试（计划 T10 / 决策 D3：控制面彻底不直连 opencode）。
 *
 * 真实启动 ExecServer（port 0 随机），mock OpenCodeDriver 接缝，覆盖：
 * - 五个新端点的 happy path：响应形状 + **驱动被以正确参数调用**
 *   （delivery 透传、createSession 带模型、分页 query 透传）
 * - 鉴权：缺 / 错 X-Worker-Token → 401（**每个**端点都断言）
 * - 路径段解析：`:id` 解码正确、**段数不对不命中**
 * - 错误映射：驱动 404 → 404（会话失效）；429 → 429；其它 → 502
 * - abort 幂等：未知会话（驱动 resolve / 驱动抛 404）都返回成功
 *
 * ⚠️ 这些端点的**唯一**出口是 OpenCodeDriver 接缝——测试断言「驱动被调用成什么样」，
 * 而不是断言 HTTP 出站请求（那是被驱动端实现自己的事，T9 负责）。
 */

import * as http from 'http';
import { EventSender } from '../client/event-client';
import {
  DriverMessage,
  DriverModelInfo,
  DriverRequestError,
  OpenCodeDriver,
} from '../driver/opencode-driver';
import { ExecServer, parseSessionActionPath } from './exec-server';

const SILENT_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };
const WORKER_TOKEN = 'tok-secret';

/** mock 驱动：每个方法都是 jest.fn，便于断言调用参数。 */
function mockDriver(): {
  driver: OpenCodeDriver;
  createSession: jest.Mock;
  sendMessage: jest.Mock;
  getMessages: jest.Mock;
  abort: jest.Mock;
  listModels: jest.Mock;
} {
  const createSession = jest.fn().mockResolvedValue('ses_new');
  const sendMessage = jest.fn().mockResolvedValue({ messageId: 'inbox_1' });
  const getMessages = jest.fn().mockResolvedValue([]);
  const abort = jest.fn().mockResolvedValue(undefined);
  const listModels = jest.fn().mockResolvedValue([]);
  const driver = {
    baseUrl: 'http://127.0.0.1:4199',
    authPassword: '',
    createSession,
    sendMessage,
    getMessages,
    abort,
    listModels,
  } as unknown as OpenCodeDriver;
  return { driver, createSession, sendMessage, getMessages, abort, listModels };
}

/** 事件 sender（不发网络请求）。 */
function createSender(): EventSender {
  const fetchImpl = (async () => {
    return { ok: true, status: 202, statusText: 'Accepted' } as Response;
  }) as typeof fetch;
  return new EventSender({
    serverUrl: 'http://server:3000',
    workerId: 'w_test',
    workerToken: WORKER_TOKEN,
    startSeq: 0,
    bootId: 'boot',
    fetchImpl,
    maxRetries: 0,
    logger: { warn: () => undefined, error: () => undefined },
  });
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

/** 通用请求（可带 X-Worker-Token；body 缺省 = 不发 body）。 */
function request(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      headers['X-Worker-Token'] = opts.token;
    }
    let data: string | undefined;
    if (opts.body !== undefined) {
      data = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
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
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

/** 起一个带 mock 驱动的 ExecServer。 */
async function startExec(
  driver: OpenCodeDriver,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const exec = new ExecServer({
    port: 0,
    driver,
    sender: createSender(),
    workerToken: WORKER_TOKEN,
    logger: SILENT_LOGGER,
  });
  const port = await exec.start();
  return { port, stop: () => exec.stop() };
}

/** 让驱动的 sendMessage 回执一个指定的投递策略。 */
function driverSendMessageDelivery(driver: OpenCodeDriver, delivery: 'steer' | 'queue'): void {
  const sendMessage = driver.sendMessage as jest.Mock;
  sendMessage.mockResolvedValue({ messageId: 'inbox_1', delivery });
}

describe('T10 会话/模型端点（决策 D3：控制面不再直连 opencode）', () => {
  describe('POST /sessions（创建会话）', () => {
    it('200 {sessionId} + 驱动收到模型', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', {
          token: WORKER_TOKEN,
          body: { model: { providerID: 'opencode', modelID: 'gpt-5' } },
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sessionId: 'ses_new' });
        expect(createSession).toHaveBeenCalledWith({
          providerID: 'opencode',
          modelID: 'gpt-5',
        });
      } finally {
        await stop();
      }
    });

    it('无 body 时用被驱动端默认模型（model 缺席 → undefined）', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', { token: WORKER_TOKEN });
        expect(res.status).toBe(200);
        expect(createSession).toHaveBeenCalledWith(undefined);
      } finally {
        await stop();
      }
    });

    it('model 形状非法 → 400（不静默丢弃调用方意图）', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', {
          token: WORKER_TOKEN,
          body: { model: { providerID: 'opencode' } },
        });
        expect(res.status).toBe(400);
        expect(createSession).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('请求体不是 JSON 对象 → 400', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', {
          token: WORKER_TOKEN,
          body: 'not-an-object',
        });
        expect(res.status).toBe(400);
        expect(createSession).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('缺 / 错 X-Worker-Token → 401', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'POST', '/sessions', { body: {} });
        expect(missing.status).toBe(401);
        const wrong = await request(port, 'POST', '/sessions', {
          token: 'not-the-token',
          body: {},
        });
        expect(wrong.status).toBe(401);
        expect(createSession).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('非 POST → 405', async () => {
      const { driver } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/sessions', { token: WORKER_TOKEN });
        expect(res.status).toBe(405);
      } finally {
        await stop();
      }
    });
  });

  describe('POST /sessions/:id/prompt（下发提示，入队式）', () => {
    it('200 {sessionId, messageId, delivery, admitted} + delivery 透传给驱动', async () => {
      const { driver, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: {
            prompt: '你好',
            delivery: 'queue',
            model: { providerID: 'opencode', modelID: 'gpt-5' },
            agent: 'build',
            directory: '/work',
            system: 'SYS',
          },
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          sessionId: 'ses_1',
          messageId: 'inbox_1',
          delivery: 'queue',
          admitted: true,
        });
        // 响应里**没有**「agent 已答复」类字段——语义是「已入队」
        expect(res.body.completed).toBeUndefined();
        expect(res.body.answered).toBeUndefined();
        expect(sendMessage).toHaveBeenCalledWith('ses_1', {
          model: { providerID: 'opencode', modelID: 'gpt-5' },
          agent: 'build',
          parts: [{ type: 'text', text: '你好' }],
          directory: '/work',
          system: 'SYS',
          delivery: 'queue',
        });
      } finally {
        await stop();
      }
    });

    it('steer 投递同样透传', async () => {
      const { driver, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: { prompt: 'x', delivery: 'steer' },
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBe('steer');
        expect(sendMessage).toHaveBeenCalledWith(
          'ses_1',
          expect.objectContaining({ delivery: 'steer' }),
        );
      } finally {
        await stop();
      }
    });

    it('投递策略以**驱动回执**为准（被驱动端调整过 → 回执值）', async () => {
      const { driver } = mockDriver();
      driverSendMessageDelivery(driver, 'queue');
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: { prompt: 'x', delivery: 'steer' },
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery).toBe('queue');
      } finally {
        await stop();
      }
    });

    it('驱动无回执（v1）时 messageId 缺席（不编造）', async () => {
      const { driver, sendMessage } = mockDriver();
      sendMessage.mockResolvedValue({});
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: { prompt: 'x' },
        });
        expect(res.status).toBe(200);
        expect(res.body.messageId).toBeUndefined();
        expect(res.body.admitted).toBe(true);
      } finally {
        await stop();
      }
    });

    it('缺 prompt → 400；delivery 非法 → 400', async () => {
      const { driver, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: {},
        });
        expect(missing.status).toBe(400);
        const badDelivery = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: { prompt: 'x', delivery: 'yolo' },
        });
        expect(badDelivery.status).toBe(400);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('缺 / 错 X-Worker-Token → 401', async () => {
      const { driver, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'POST', '/sessions/ses_1/prompt', {
          body: { prompt: 'x' },
        });
        expect(missing.status).toBe(401);
        const wrong = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: 'nope',
          body: { prompt: 'x' },
        });
        expect(wrong.status).toBe(401);
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });

  describe('POST /sessions/:id/abort（中断，幂等）', () => {
    it('200 {sessionId, interrupted:false} + 驱动收到会话 id', async () => {
      const { driver, abort } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/abort', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sessionId: 'ses_1', interrupted: false });
        expect(abort).toHaveBeenCalledWith('ses_1');
      } finally {
        await stop();
      }
    });

    it('未知会话 → 成功（驱动 resolve，幂等空操作）', async () => {
      const { driver, abort } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_unknown/abort', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(200);
        expect(res.body.interrupted).toBe(false);
        expect(abort).toHaveBeenCalledWith('ses_unknown');
      } finally {
        await stop();
      }
    });

    it('驱动抛 404（会话已不存在）→ 仍是成功（幂等）', async () => {
      const { driver, abort } = mockDriver();
      abort.mockRejectedValue(new DriverRequestError('session not found', 404));
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_gone/abort', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sessionId: 'ses_gone', interrupted: false });
      } finally {
        await stop();
      }
    });

    it('缺 / 错 X-Worker-Token → 401', async () => {
      const { driver, abort } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'POST', '/sessions/ses_1/abort');
        expect(missing.status).toBe(401);
        const wrong = await request(port, 'POST', '/sessions/ses_1/abort', {
          token: 'nope',
        });
        expect(wrong.status).toBe(401);
        expect(abort).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });

  describe('GET /sessions/:id/messages（读消息，可分页）', () => {
    it('200 {sessionId, messages} + 消息是 vteam 渲染模型形状', async () => {
      const { driver, getMessages } = mockDriver();
      const messages: DriverMessage[] = [
        {
          info: { id: 'msg_1', role: 'assistant', providerID: 'opencode', modelID: 'gpt-5' },
          parts: [{ id: 'prt_1', type: 'text', text: '你好' }],
        },
      ];
      getMessages.mockResolvedValue(messages);
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/sessions/ses_1/messages', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          sessionId: 'ses_1',
          messages: [
            {
              info: {
                id: 'msg_1',
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'gpt-5',
              },
              parts: [{ id: 'prt_1', type: 'text', text: '你好' }],
            },
          ],
        });
        expect(getMessages).toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('分页 query（limit/order/cursor）透传给驱动', async () => {
      const { driver, getMessages } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(
          port,
          'GET',
          '/sessions/ses_1/messages?limit=20&order=desc&cursor=cur_9',
          { token: WORKER_TOKEN },
        );
        expect(res.status).toBe(200);
        expect(getMessages).toHaveBeenCalledWith('ses_1', {
          limit: 20,
          order: 'desc',
          cursor: 'cur_9',
        });
      } finally {
        await stop();
      }
    });

    it('分页参数非法 → 400', async () => {
      const { driver, getMessages } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const badLimit = await request(port, 'GET', '/sessions/ses_1/messages?limit=0', {
          token: WORKER_TOKEN,
        });
        expect(badLimit.status).toBe(400);
        const badOrder = await request(port, 'GET', '/sessions/ses_1/messages?order=up', {
          token: WORKER_TOKEN,
        });
        expect(badOrder.status).toBe(400);
        expect(getMessages).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('缺 / 错 X-Worker-Token → 401', async () => {
      const { driver, getMessages } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'GET', '/sessions/ses_1/messages');
        expect(missing.status).toBe(401);
        const wrong = await request(port, 'GET', '/sessions/ses_1/messages', {
          token: 'nope',
        });
        expect(wrong.status).toBe(401);
        expect(getMessages).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });

  describe('GET /models（模型目录）', () => {
    it('200 {models:[…]} + **不是**被驱动端的 {location,data} 包装', async () => {
      const { driver, listModels } = mockDriver();
      const models: DriverModelInfo[] = [
        {
          id: 'opencode/gpt-5',
          name: 'GPT-5',
          providerID: 'opencode',
          modelID: 'gpt-5',
          status: 'active',
        },
      ];
      listModels.mockResolvedValue(models);
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/models', { token: WORKER_TOKEN });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          models: [
            {
              id: 'opencode/gpt-5',
              name: 'GPT-5',
              providerID: 'opencode',
              modelID: 'gpt-5',
              status: 'active',
            },
          ],
        });
        // 上游包装形状不许漏出去
        expect(res.body.location).toBeUndefined();
        expect(res.body.data).toBeUndefined();
        expect(listModels).toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('缺 / 错 X-Worker-Token → 401', async () => {
      const { driver, listModels } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const missing = await request(port, 'GET', '/models');
        expect(missing.status).toBe(401);
        const wrong = await request(port, 'GET', '/models', { token: 'nope' });
        expect(wrong.status).toBe(401);
        expect(listModels).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });

  describe('驱动失败 → 状态码映射', () => {
    it('驱动 404 → 404 {error, code:SESSION_NOT_FOUND}（控制面据此判会话失效）', async () => {
      const { driver, getMessages } = mockDriver();
      getMessages.mockRejectedValue(new DriverRequestError('session not found', 404));
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/sessions/ses_gone/messages', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SESSION_NOT_FOUND');
        expect(typeof res.body.error).toBe('string');
      } finally {
        await stop();
      }
    });

    it('驱动 429 → 429（限流可退避重试）', async () => {
      const { driver, sendMessage } = mockDriver();
      sendMessage.mockRejectedValue(new DriverRequestError('rate limited', 429));
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_1/prompt', {
          token: WORKER_TOKEN,
          body: { prompt: 'x' },
        });
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('RATE_LIMITED');
      } finally {
        await stop();
      }
    });

    it('驱动 401 → 502 + UPSTREAM_UNAUTHORIZED（不是控制面的 token 错）', async () => {
      const { driver, listModels } = mockDriver();
      listModels.mockRejectedValue(new DriverRequestError('unauthorized', 401));
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/models', { token: WORKER_TOKEN });
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('UPSTREAM_UNAUTHORIZED');
      } finally {
        await stop();
      }
    });

    it('驱动 5xx / 网络错 → 502（不吞成 200）', async () => {
      const { driver, createSession } = mockDriver();
      createSession.mockRejectedValue(new DriverRequestError('upstream boom', 503));
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', { token: WORKER_TOKEN });
        expect(res.status).toBe(502);
        expect(typeof res.body.error).toBe('string');
      } finally {
        await stop();
      }
    });
  });

  describe('路径段解析', () => {
    it('命中：/sessions/<id>/<action>', () => {
      expect(parseSessionActionPath('/sessions/ses_1/prompt')).toEqual({
        id: 'ses_1',
        action: 'prompt',
      });
      expect(parseSessionActionPath('/sessions/ses_1/abort')).toEqual({
        id: 'ses_1',
        action: 'abort',
      });
      expect(parseSessionActionPath('/sessions/ses_1/messages')).toEqual({
        id: 'ses_1',
        action: 'messages',
      });
    });

    it('会话 id 做 URL 解码（%2F 等）', () => {
      expect(parseSessionActionPath('/sessions/ses%2Fabc%20d/prompt')).toEqual({
        id: 'ses/abc d',
        action: 'prompt',
      });
    });

    it('段数不对一律不命中（少一段 / 多一段 / 非 sessions 前缀）', () => {
      expect(parseSessionActionPath('/sessions/abc')).toBeNull();
      expect(parseSessionActionPath('/sessions')).toBeNull();
      expect(parseSessionActionPath('/sessions/abc/prompt/extra')).toBeNull();
      expect(parseSessionActionPath('/todos/abc/messages')).toBeNull();
      expect(parseSessionActionPath('/sessions//prompt')).toBeNull();
    });

    it('非法转义序列不命中', () => {
      expect(parseSessionActionPath('/sessions/%E0%A4%A/prompt')).toBeNull();
    });

    it('端点侧：段数不对的路径不被当成 messages 端点（404 且驱动未被调用）', async () => {
      const { driver, getMessages } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/sessions/ses_1', { token: WORKER_TOKEN });
        expect(res.status).toBe(404);
        expect(getMessages).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('端点侧：未知 action → 404（驱动未被调用）', async () => {
      const { driver, getMessages, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'GET', '/sessions/ses_1/unknown', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(404);
        expect(getMessages).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('端点侧：带 URL 编码 id 的请求解析出正确会话 id', async () => {
      const { driver, abort } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses%2Fabc/abort', {
          token: WORKER_TOKEN,
        });
        expect(res.status).toBe(200);
        expect(res.body.sessionId).toBe('ses/abc');
        expect(abort).toHaveBeenCalledWith('ses/abc');
      } finally {
        await stop();
      }
    });
  });

  describe('未配置 workerToken → 一律 401（fail closed）', () => {
    it('五个端点全部拒绝', async () => {
      const { driver } = mockDriver();
      const exec = new ExecServer({
        port: 0,
        driver,
        sender: createSender(),
        logger: SILENT_LOGGER,
      });
      const port = await exec.start();
      try {
        const paths: Array<[string, string]> = [
          ['POST', '/sessions'],
          ['POST', '/sessions/ses_1/prompt'],
          ['POST', '/sessions/ses_1/abort'],
          ['GET', '/sessions/ses_1/messages'],
          ['GET', '/models'],
        ];
        for (const [method, path] of paths) {
          const res = await request(port, method, path, {
            token: 'anything',
            body: method === 'POST' ? { prompt: 'x' } : undefined,
          });
          expect(res.status).toBe(401);
        }
      } finally {
        await exec.stop();
      }
    });
  });
});
