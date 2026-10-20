/**
 * V2Driver 接入共享契约套件（计划 T8 的套件，T9 的 v2 实现）。
 *
 * 作用：证明「v2 实现满足接缝契约」——套件是**实现无关**的（假服务端同时提供 v1 无前缀面
 * 与 v2 `/api` 面），v1 与 v2 两个实现跑的是**同一套断言**。
 *
 * 注意：本文件**不得**修改共享套件（`opencode-driver.conformance.ts`）——套件一改，
 * 「接缝是一份契约」这件事就没了。
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { describeOpencodeDriverConformance } from './opencode-driver.conformance';
import { V2Driver } from './v2-driver';

describeOpencodeDriverConformance('V2Driver', ({ baseUrl, serverPassword }) =>
  new V2Driver({ baseUrl, serverPassword }),
);

/**
 * 共享套件之外的补充断言：**内容 id 契约**。
 *
 * 共享套件断言的是**接口契约**（形状、错误语义、幂等空操作），不断言 part id 的口径
 * ——那是 v2 的实现细节（由 `v2-part-id.ts` 单源定义，v2 自己的 spec 逐条钉住）。
 * 但「驱动产出的 part 形状必须满足套件隐含的形状要求」是**跨实现**的要求：
 * - 每个 part 都带**非空 id**（server 按 id 合并 parts；空 id → 合并退化成追加）；
 * - 同一条消息内 id **互不相同**（否则两段内容会被合并成一张卡）；
 * - **重复轮询 id 不变**（server 的合并是 last-write-wins，id 漂移 = 内容重复落库）。
 *
 * 共享套件（`opencode-driver.conformance.ts`）**本身不改**——这里只是补一条针对 v2 wire
 * 形态的断言（套件自带的假服务端返回的是 v1 形态消息，v2 驱动会按契约丢弃它）。
 */
describe('V2Driver 的驱动输出满足共享契约套件的形状要求', () => {
  /** v2 wire 形态的 assistant 消息（多段文本 + 思考 + 工具）。 */
  const WIRE_MESSAGE = {
    id: 'msg_1',
    type: 'assistant',
    time: { created: 1100, completed: 1300 },
    content: [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '想一想' },
      { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed' } },
      { type: 'text', text: '第二段' },
    ],
    finish: 'stop',
  };

  /** 起一个只提供 v2 消息路由的假服务端。 */
  async function startV2MessageServer(): Promise<{
    baseUrl: string;
    close(): Promise<void>;
  }> {
    const server = http.createServer((req, res) => {
      const payload = JSON.stringify({ data: [WIRE_MESSAGE], cursor: { previous: null, next: null } });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      void req;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('part id 非空、消息内唯一，且重复轮询保持不变', async () => {
    const server = await startV2MessageServer();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    try {
      const first = await driver.getMessages('ses_1');
      const second = await driver.getMessages('ses_1');
      expect(Array.isArray(first)).toBe(true);
      expect(first).toHaveLength(1);
      const ids = first[0].parts.map((p) => p.id ?? '');
      // 每个 part 都有非空 id
      expect(ids.every((id) => id.length > 0)).toBe(true);
      // 消息内 id 互不相同
      expect(new Set(ids).size).toBe(ids.length);
      // 重复轮询 id 不变（server 按 id 合并 parts）
      expect(second[0].parts.map((p) => p.id)).toEqual(ids);
    } finally {
      await server.close();
    }
  });
});
