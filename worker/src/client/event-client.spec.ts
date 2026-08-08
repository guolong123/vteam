import { EventSender, getEventBootId, resetEventSeq } from './event-client';
import { WORKER_TOKEN_HEADER } from './registry-client';

/**
 * T6 EventSender 测试（mock fetch）。
 * 覆盖：seq 单调递增（evw_<bootId>_1/2/3，与 seq 同步）；bootId 区分重启（F2 M1）；
 * 失败重试（指数退避）；最终失败不抛仅记日志（事件可丢，D4 at-least-once 边界）；
 * flush 等待在途发送。
 */

const fetchMock = jest.fn();

function mockFetch(): void {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;
}

function okJson(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { workerId: string; eventId: string; type: string; seq: number; payload: Record<string, unknown> };
}

function lastRequest(index = 0): CapturedRequest {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

const OPTIONS = {
  serverUrl: 'http://localhost:3000',
  workerId: 'w_test-1',
  workerToken: 'dev-worker-token',
  startSeq: 0,
  // F2 M1：固定 bootId 隔离断言（生产默认模块级进程启动标识）
  bootId: 'boot-test-1',
};

describe('EventSender：seq 单调递增（D4，evw_<bootId>_<seq> 与 seq 同步）', () => {
  beforeEach(() => {
    mockFetch();
    resetEventSeq();
  });

  it('连续发送 3 次：eventId 依次 evw_boot-test-1_1/2/3，seq 1/2/3，URL/header 正确', async () => {
    fetchMock.mockResolvedValue(okJson());
    const sender = new EventSender(OPTIONS);

    await sender.send('instance.created', { instanceId: 'inst-1' });
    await sender.send('session.updated', { sessionId: 's-1' });
    await sender.send('task.completed', { taskId: 't-1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const req = lastRequest(i);
      expect(req.url).toBe('http://localhost:3000/api/v1/worker/events');
      expect(req.headers[WORKER_TOKEN_HEADER]).toBe('dev-worker-token');
      expect(req.body.workerId).toBe('w_test-1');
      expect(req.body.eventId).toBe(`evw_boot-test-1_${i + 1}`);
      expect(req.body.seq).toBe(i + 1);
    }
    expect(lastRequest(0).body.type).toBe('instance.created');
    expect(lastRequest(1).body.type).toBe('session.updated');
    expect(lastRequest(2).body.type).toBe('task.completed');
    expect(sender.lastSeq).toBe(3);
  });

  it('默认 bootId 接模块级进程启动标识（getEventBootId 可断言）', async () => {
    fetchMock.mockResolvedValue(okJson());
    await new EventSender({
      serverUrl: OPTIONS.serverUrl,
      workerId: OPTIONS.workerId,
      workerToken: OPTIONS.workerToken,
      startSeq: 0,
    }).send('worker.heartbeat', {});
    expect(lastRequest(0).body.eventId).toBe(`evw_${getEventBootId()}_1`);
  });

  it('F2 M1：相同 seq 不同 bootId → eventId 不同（重启后 seq 归零不误去重）', async () => {
    fetchMock.mockResolvedValue(okJson());
    // 模拟两次进程启动：同 workerId 同 seq，但 bootId 不同（进程重启标识变化）
    await new EventSender({ ...OPTIONS, bootId: 'boot-before-restart' }).send('session.updated', {});
    await new EventSender({ ...OPTIONS, bootId: 'boot-after-restart' }).send('session.updated', {});
    expect(lastRequest(0).body.eventId).toBe('evw_boot-before-restart_1');
    expect(lastRequest(1).body.eventId).toBe('evw_boot-after-restart_1');
    expect(lastRequest(0).body.eventId).not.toBe(lastRequest(1).body.eventId);
    expect(lastRequest(0).body.seq).toBe(1);
    expect(lastRequest(1).body.seq).toBe(1);
  });

  it('startSeq 缺省时接续模块级计数器（进程内多实例严格递增）', async () => {
    fetchMock.mockResolvedValue(okJson());
    const first = new EventSender({ ...OPTIONS, startSeq: 0 });
    await first.send('worker.heartbeat', {});
    // 不传 startSeq：应从模块级当前值（1）接续 → seq 2
    const second = new EventSender({ serverUrl: OPTIONS.serverUrl, workerId: OPTIONS.workerId, workerToken: OPTIONS.workerToken, bootId: OPTIONS.bootId });
    await second.send('agent.status', {});
    expect(lastRequest(1).body.eventId).toBe('evw_boot-test-1_2');
    expect(lastRequest(1).body.seq).toBe(2);
  });

  it('payload 透传原样（不修改调用方对象）', async () => {
    fetchMock.mockResolvedValue(okJson());
    const payload = { sessionId: 's-1', text: '你好' };
    await new EventSender(OPTIONS).send('message.part.delta', payload);
    expect(lastRequest(0).body.payload).toEqual({ sessionId: 's-1', text: '你好' });
    expect(payload).toEqual({ sessionId: 's-1', text: '你好' });
  });
});

describe('EventSender：失败重试 + 最终失败不抛', () => {
  beforeEach(() => {
    mockFetch();
    resetEventSeq();
  });

  it('前 2 次网络错第 3 次成功：重试 2 次（指数退避 500ms/1000ms），send 正常 resolve', async () => {
    jest.useFakeTimers();
    try {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(okJson());
      const sender = new EventSender({ ...OPTIONS, retryBaseDelayMs: 500 });

      const promise = sender.send('agent.status', { status: 'thinking' });
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      await promise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      // 三次都发同一事件（eventId 不变，含 bootId）
      for (let i = 0; i < 3; i++) {
        expect(lastRequest(i).body.eventId).toBe('evw_boot-test-1_1');
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('非 2xx（500）同样触发重试，最终成功', async () => {
    jest.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(okJson());
      const sender = new EventSender(OPTIONS);

      const promise = sender.send('session.updated', {});
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      await promise;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('重试耗尽仍失败：send 不抛错，仅记录 error 日志（事件丢弃不阻塞）', async () => {
    jest.useFakeTimers();
    try {
      const logger = { warn: jest.fn(), error: jest.fn() };
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const sender = new EventSender({ ...OPTIONS, maxRetries: 3, retryBaseDelayMs: 500, logger });

      const promise = sender.send('task.completed', {});
      // 退避 500/1000/2000
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toBeUndefined(); // 不抛

      expect(fetchMock).toHaveBeenCalledTimes(4); // 首次 + 3 次重试
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(String(logger.error.mock.calls[0][0])).toContain('evw_boot-test-1_1');
      expect(String(logger.error.mock.calls[0][0])).toContain('丢弃');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('EventSender：flush', () => {
  beforeEach(() => {
    mockFetch();
    resetEventSeq();
  });

  it('并发发送时 flush 等待全部在途事件送达', async () => {
    fetchMock.mockResolvedValue(okJson());
    const sender = new EventSender(OPTIONS);

    const p1 = sender.send('instance.created', {});
    const p2 = sender.send('agent.status', {});
    await sender.flush();
    await Promise.all([p1, p2]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRequest(0).body.eventId).toBe('evw_boot-test-1_1');
    expect(lastRequest(1).body.eventId).toBe('evw_boot-test-1_2');
    expect(sender.lastSeq).toBe(2);
  });

  it('无在途事件时 flush 立即返回', async () => {
    await expect(new EventSender(OPTIONS).flush()).resolves.toBeUndefined();
  });
});
