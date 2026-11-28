/** 压缩终态真实事件消费的回归测试（替代 lastActivityAt 轮询）。 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { V2Driver } from './v2-driver';

describe('V2Driver.beginCompactionWatch', () => {
  const startSse = (
    frames: unknown[],
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const frame of frames) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        setTimeout(() => res.end(), 300);
        return;
      }
      res.writeHead(404).end();
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  };

  it('消费 session.compaction.failed，直接拿到 opencode 的真实失败原因', async () => {
    const now = Date.now();
    const sse = await startSse([
      {
        id: 'evt_1',
        created: now,
        type: 'session.compaction.failed',
        data: {
          sessionID: 'ses_watch',
          reason: 'manual',
          error: {
            type: 'compaction.unavailable',
            message: 'Nothing to compact yet',
          },
        },
      },
    ]);
    const driver = new V2Driver({ baseUrl: sse.baseUrl });
    const watcher = driver.beginCompactionWatch('ses_watch', now - 1_000);
    try {
      const result = await watcher.wait(3_000);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('compaction.unavailable');
      expect(result.reason).toContain('Nothing to compact yet');
    } finally {
      watcher.cancel();
      await sse.close();
    }
  });

  it('session.compaction.ended → ended；非本会话的事件被忽略', async () => {
    const now = Date.now();
    const sse = await startSse([
      {
        id: 'evt_other',
        created: now,
        type: 'session.compaction.ended',
        data: { sessionID: 'ses_other' },
      },
      {
        id: 'evt_2',
        created: now + 1,
        type: 'session.compaction.ended',
        data: { sessionID: 'ses_watch' },
      },
    ]);
    const driver = new V2Driver({ baseUrl: sse.baseUrl });
    const watcher = driver.beginCompactionWatch('ses_watch', now - 1_000);
    try {
      const result = await watcher.wait(3_000);
      expect(result.status).toBe('ended');
    } finally {
      watcher.cancel();
      await sse.close();
    }
  });
});
