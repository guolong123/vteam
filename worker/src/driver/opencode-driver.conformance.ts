/**
 * 共享契约套件（计划 T8）：**任何** OpenCodeDriver 实现都必须跑通同一套断言。
 *
 * 为什么要有共享套件：
 * - 接缝的价值全在「下一版实现能被验证」。若每个实现各写各的单测，接缝就退化成
 *   「一个名字」而不是「一份契约」——新实现照样可能悄悄违约（返回形状变了、404 不带
 *   status、abort 对未知会话抛错……）。
 * - 本套件断言的是**接口契约**（业务层真正依赖的行为），**不是**某一版实现的 HTTP 细节：
 *   路径、body 形状、返回包装由各自实现的单测负责。
 *
 * 用法（实现方各自写一个 spec 引入本套件）：
 * ```ts
 * import { describeOpencodeDriverConformance } from './opencode-driver.conformance';
 * describeOpencodeDriverConformance('V1Driver', ({ baseUrl, serverPassword }) =>
 *   new V1Driver({ baseUrl, serverPassword }));
 * ```
 *
 * 假服务端（`startFakeDriverServer`）同时提供**两代**路由形态（v1 的无前缀面 + v2 的
 * `/api` 面），故同一套件可原样复用于下一版实现——这也是「套件与实现解耦」的前提。
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { OpenCodeDriver } from './opencode-driver';

/** 假服务端口令（强制 Basic 鉴权，用于验证 401 归一）。 */
export const FAKE_SERVER_PASSWORD = 'fake-pass';

/** 假服务端会话 id（存在）。 */
export const FAKE_SESSION_ID = 'ses_fake_1';

/** 假服务端「不存在」的会话 id（消息端点对其返回 404）。 */
export const FAKE_MISSING_SESSION_ID = 'ses_missing';

/** 假服务端句柄。 */
export interface FakeDriverServer {
  /** 基址（如 http://127.0.0.1:41234） */
  baseUrl: string;
  /** 收到的请求（诊断用） */
  requests: Array<{ method: string; path: string }>;
  /** 关闭服务端 */
  close(): Promise<void>;
}

/** 构造被测驱动的入参。 */
export interface DriverConformanceContext {
  baseUrl: string;
  serverPassword: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 启动假服务端（同时提供 v1 无前缀面与 v2 `/api` 面）。
 *
 * 鉴权：配置了口令时校验 Basic（username=opencode）；不匹配 → 401。
 */
export async function startFakeDriverServer(
  options: { serverPassword?: string } = {},
): Promise<FakeDriverServer> {
  const serverPassword = options.serverPassword ?? FAKE_SERVER_PASSWORD;
  const requests: Array<{ method: string; path: string }> = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    requests.push({ method, path });

    const expected = `Basic ${Buffer.from(`opencode:${serverPassword}`, 'utf8').toString('base64')}`;
    if (req.headers.authorization !== expected) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // 请求体先读完再应答（否则客户端 socket 可能挂起）。
    void readBody(req).then(() => handle(method, path, res));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  function handle(method: string, path: string, res: http.ServerResponse): void {
    // —— v1 形态（无前缀）——
    if (method === 'POST' && path === '/session') {
      sendJson(res, 200, { id: FAKE_SESSION_ID });
      return;
    }
    if (method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(path)) {
      res.writeHead(204).end();
      return;
    }
    if (method === 'GET' && /^\/session\/[^/]+\/message$/.test(path)) {
      if (path.includes(FAKE_MISSING_SESSION_ID)) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      sendJson(res, 200, [
        {
          info: { id: 'msg_fake_1', role: 'assistant', providerID: 'opencode', modelID: 'free-model' },
          parts: [{ id: 'prt_fake_1', type: 'text', text: 'hello' }],
        },
      ]);
      return;
    }
    if (method === 'POST' && /^\/session\/[^/]+\/abort$/.test(path)) {
      // abort 是幂等空操作：对未知/已结束会话也返回 2xx（契约要求 abort 不抛错）。
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && /^\/session\/[^/]+\/todo$/.test(path)) {
      sendJson(res, 200, [{ id: 'todo_1', content: '做点事', status: 'pending' }]);
      return;
    }
    if (method === 'GET' && path === '/question') {
      sendJson(res, 200, [
        {
          id: 'que_fake_1',
          sessionID: FAKE_SESSION_ID,
          questions: [{ question: '继续吗？', header: '确认', options: [{ label: '继续', description: 'go' }] }],
        },
      ]);
      return;
    }
    if (method === 'POST' && /^\/question\/[^/]+\/reply$/.test(path)) {
      sendJson(res, 200, true);
      return;
    }
    if (method === 'POST' && /^\/question\/[^/]+\/reject$/.test(path)) {
      sendJson(res, 200, true);
      return;
    }
    if (method === 'GET' && path === '/permission') {
      sendJson(res, 200, [
        {
          id: 'per_fake_1',
          sessionID: FAKE_SESSION_ID,
          permission: 'bash',
          patterns: ['/data/*'],
        },
      ]);
      return;
    }
    if (method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(path)) {
      sendJson(res, 200, true);
      return;
    }
    if (method === 'GET' && path === '/agent') {
      sendJson(res, 200, [{ name: 'build', mode: 'all', native: true }]);
      return;
    }
    if (method === 'GET' && path === '/provider') {
      sendJson(res, 200, {
        all: [{ id: 'opencode', key: '', models: { 'free-model': { name: 'Free Model' } } }],
      });
      return;
    }
    if (method === 'GET' && path === '/api/model') {
      sendJson(res, 200, {
        data: [{ id: 'free-model', providerID: 'opencode', name: 'Free Model', status: 'active' }],
      });
      return;
    }
    if (method === 'GET' && path === '/api/integration') {
      // 集成注册表（可配置 provider 全集）：含**没有模型行**的内置集成——
      // 驱动必须归一成 `{id,name,apiKey,envNames?}` 且**丢掉 id 为空的脏项**。
      sendJson(res, 200, {
        data: [
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            methods: [{ type: 'key' }, { type: 'env', names: ['OPENCODE_API_KEY'] }],
            connections: [],
          },
          { id: 'env-only', name: 'Env Only', methods: [{ type: 'env', names: ['ENV_ONLY_TOKEN'] }] },
          { id: '', name: 'broken-no-id', methods: [{ type: 'key' }] },
        ],
      });
      return;
    }
    if (method === 'GET' && path === '/') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // —— v2 形态（`/api` 前缀）——
    if (method === 'POST' && path === '/api/session') {
      sendJson(res, 200, { data: { id: FAKE_SESSION_ID } });
      return;
    }
    if (method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(path)) {
      sendJson(res, 200, { data: { id: 'msg_fake_1', delivery: 'queue' } });
      return;
    }
    if (method === 'GET' && /^\/api\/session\/[^/]+\/message$/.test(path)) {
      // v2 契约：会话不存在 → 404（实测真 v2：`{"_tag":"SessionNotFoundError"}` + HTTP 404）。
      // v1 形态的同名路由已有该分支——两代路由必须**同样**对"会话不存在"回 404，
      // 否则共享套件里那条「上游 404 → status=404」的断言只对 v1 成立（套件就废了一半）。
      if (path.includes(FAKE_MISSING_SESSION_ID)) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      sendJson(res, 200, {
        data: [
          {
            info: { id: 'msg_fake_1', role: 'assistant', providerID: 'opencode', modelID: 'free-model' },
            parts: [{ id: 'prt_fake_1', type: 'text', text: 'hello' }],
          },
        ],
        cursor: { previous: null, next: null },
      });
      return;
    }
    if (method === 'GET' && /^\/api\/session\/[^/]+\/form$/.test(path)) {
      // v2 的 form 形状：`{id,sessionID,title,fields[]}`（**字段带类型**，不是 v1 的 questions[]）。
      sendJson(res, 200, {
        data: [
          {
            id: 'frm_fake_1',
            sessionID: FAKE_SESSION_ID,
            title: '确认',
            fields: [
              {
                key: 'choice',
                title: '继续吗？',
                type: 'multiselect',
                options: [{ value: 'go', label: '继续', description: 'go' }],
              },
            ],
          },
        ],
      });
      return;
    }
    if (method === 'POST' && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(path)) {
      sendJson(res, 200, { data: { id: 'frm_fake_1' } });
      return;
    }
    if (method === 'DELETE' && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path)) {
      res.writeHead(204).end();
      return;
    }
    if (method === 'GET' && /^\/api\/session\/[^/]+\/permission$/.test(path)) {
      sendJson(res, 200, {
        data: [{ id: 'per_fake_1', sessionID: FAKE_SESSION_ID, action: 'bash', resources: ['/data/*'] }],
      });
      return;
    }
    if (method === 'POST' && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path)) {
      sendJson(res, 200, { data: { id: 'per_fake_1' } });
      return;
    }
    if (method === 'POST' && /^\/api\/session\/[^/]+\/interrupt$/.test(path)) {
      sendJson(res, 200, { interrupted: false });
      return;
    }
    if (method === 'GET' && path === '/api/agent') {
      sendJson(res, 200, { data: [{ name: 'build', mode: 'all' }] });
      return;
    }
    if (method === 'GET' && path === '/api/provider') {
      sendJson(res, 200, {
        data: [{ id: 'opencode', models: { 'free-model': { name: 'Free Model' } } }],
      });
      return;
    }
    if (method === 'GET' && path === '/api/info') {
      sendJson(res, 200, { version: '2.0.32', pid: 1 });
      return;
    }

    sendJson(res, 404, { error: `fake server: no route for ${method} ${path}` });
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * 注册共享契约套件。
 *
 * @param label 实现名（出现在测试标题里）
 * @param createDriver 构造被测驱动（指向套件自带的假服务端）
 */
export function describeOpencodeDriverConformance(
  label: string,
  createDriver: (ctx: DriverConformanceContext) => OpenCodeDriver,
): void {
  describe(`${label}：OpenCodeDriver 共享契约套件`, () => {
    let server: FakeDriverServer;
    let driver: OpenCodeDriver;

    beforeAll(async () => {
      server = await startFakeDriverServer({ serverPassword: FAKE_SERVER_PASSWORD });
      driver = createDriver({
        baseUrl: server.baseUrl,
        serverPassword: FAKE_SERVER_PASSWORD,
      });
    });

    afterAll(async () => {
      await server.close();
    });

    it('createSession 返回非空会话 id', async () => {
      const id = await driver.createSession();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('baseUrl 是字符串（空串 = 尚未注入）', () => {
      expect(typeof driver.baseUrl).toBe('string');
    });

    it('authPassword 暴露被驱动端口令（空 = 不鉴权）', () => {
      expect(typeof driver.authPassword).toBe('string');
    });

    it('listModels 返回数组，且每项含 id/name/providerID/modelID', async () => {
      const models = await driver.listModels();
      expect(Array.isArray(models)).toBe(true);
      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(typeof model.providerID).toBe('string');
        expect(typeof model.modelID).toBe('string');
      }
    });

    it('listIntegrations 归一集成注册表：非空 id/name、apiKey 布尔、丢脏项、无 secret', async () => {
      const items = await driver.listIntegrations();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      // id 为空的脏项被丢弃
      expect(items.some((item) => item.id === '')).toBe(false);
      for (const item of items) {
        expect(typeof item.id).toBe('string');
        expect(item.id.length).toBeGreaterThan(0);
        expect(typeof item.name).toBe('string');
        expect(typeof item.apiKey).toBe('boolean');
        expect(Array.isArray(item.envNames ?? [])).toBe(true);
      }
      // 「怎么配」的声明可以有，**已配的值绝不出现**（输出里没有任何 key 形态的串）
      expect(JSON.stringify(items)).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(JSON.stringify(items)).toContain('opencode-go');
    });

    it('listAgents 返回数组', async () => {
      expect(Array.isArray(await driver.listAgents('/tmp'))).toBe(true);
    });

    it('listTodos 返回数组（无待办 = 空数组，非错误）', async () => {
      expect(Array.isArray(await driver.listTodos(FAKE_SESSION_ID, '/tmp'))).toBe(true);
    });

    it('getMessages 返回数组', async () => {
      expect(Array.isArray(await driver.getMessages(FAKE_SESSION_ID))).toBe(true);
    });

    it('listQuestions 返回数组', async () => {
      expect(Array.isArray(await driver.listQuestions(FAKE_SESSION_ID))).toBe(true);
    });

    it('listPermissions 返回数组', async () => {
      expect(Array.isArray(await driver.listPermissions(FAKE_SESSION_ID))).toBe(true);
    });

    it('sendMessage 成功返回（不抛错；回执 messageId 可缺省）', async () => {
      const result = await driver.sendMessage(FAKE_SESSION_ID, {
        parts: [{ type: 'text', text: 'hi' }],
      });
      expect(typeof result).toBe('object');
    });

    it('replyQuestion / rejectQuestion / replyPermission 成功返回（不抛错）', async () => {
      await expect(
        driver.replyQuestion(FAKE_SESSION_ID, 'que_fake_1', [['继续']]),
      ).resolves.toBeUndefined();
      await expect(driver.rejectQuestion(FAKE_SESSION_ID, 'que_fake_1')).resolves.toBeUndefined();
      await expect(
        driver.replyPermission(FAKE_SESSION_ID, 'per_fake_1', 'once'),
      ).resolves.toBeUndefined();
    });

    it('abort 对未知/已结束会话是幂等空操作（**不抛错**）', async () => {
      await expect(driver.abort('ses_unknown_session')).resolves.toBeUndefined();
    });

    it('isHealthy 返回布尔（不抛错）', async () => {
      expect(typeof (await driver.isHealthy())).toBe('boolean');
    });

    it('上游 404 → 抛错且错误携带 status=404（会话失效判定依赖它）', async () => {
      await expect(driver.getMessages(FAKE_MISSING_SESSION_ID)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('上游 401 → 抛错且错误携带 status=401（配置错误判定依赖它）', async () => {
      const wrongAuth = createDriver({
        baseUrl: server.baseUrl,
        serverPassword: 'wrong-password',
      });
      await expect(wrongAuth.getMessages(FAKE_SESSION_ID)).rejects.toMatchObject({
        status: 401,
      });
    });
  });
}
