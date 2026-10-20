/**
 * V2Driver 单元测试 + **真 v2 server 契约测试**（计划 T9）。
 *
 * 分两层：
 * 1. **单元层**（假 v2 server）：断言 vteam ↔ v2 的**形状翻译**——最容易错的几处：
 *    `parts[]` → `text` 拼接、文件 part → `files[]`、`state.content[]`（数组）→ vteam 的
 *    `state.output`（字符串）、**合成的 `step-finish` part**、权限答复的 `decision`（v1 是
 *    `reply`）、`{interrupted:false}` 是成功而非错误、模型列表的 `{location,data}` 包装与
 *    裸数组两种形态。
 * 2. **契约层**（真 opencode v2 二进制）：起真的 serve，跑只读路径 + 建会话 + 读消息。
 *    二进制不在时**跳过**（不失败）——CI 镜像未必装 opencode。
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { getRandomFreePort } from '../runtime/port-probe';
import { DriverRequestError } from './opencode-driver';
import {
  V2Driver,
  buildV2FormAnswer,
  mapV2FormField,
  normalizeV2ToolState,
  translateV2PromptParts,
  unwrapV2List,
  unwrapV2Object,
} from './v2-driver';
import { SystemHandoffPort } from './v2-system-handoff';

// ───────────────────────────── 假 v2 server（单元层） ─────────────────────────────

interface FakeV2Request {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface FakeV2Server {
  baseUrl: string;
  requests: FakeV2Request[];
  close(): Promise<void>;
}

/** 假 v2 server 的可配置响应（按 "METHOD /path 前缀" 匹配）。 */
type FakeV2Overrides = Record<string, { status?: number; body?: unknown }>;

async function startFakeV2Server(overrides: FakeV2Overrides = {}): Promise<FakeV2Server> {
  const requests: FakeV2Request[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      });
      const key = `${method} ${url.pathname}`;
      const override = Object.entries(overrides).find(([pattern]) => key.startsWith(pattern));
      if (override) {
        const value = override[1];
        const status = value.status ?? 200;
        const payload = value.body === undefined ? '' : JSON.stringify(value.body);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (method === 'POST' && url.pathname === '/api/session') {
        send(200, { data: { id: 'ses_fake_v2' } });
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        send(200, { data: { id: 'msg_inbox_1', sessionID: 'ses_fake_v2', delivery: 'steer' } });
        return;
      }
      if (method === 'GET' && /^\/api\/session\/[^/]+\/message$/.test(url.pathname)) {
        send(200, { data: [], cursor: { previous: null, next: null } });
        return;
      }
      if (method === 'GET' && /^\/api\/session\/[^/]+\/form$/.test(url.pathname)) {
        send(200, { data: [] });
        return;
      }
      if (method === 'GET' && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(url.pathname)) {
        send(200, { data: { id: 'frm_1', sessionID: 'ses_fake_v2', title: '确认', fields: [] } });
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'DELETE' && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'GET' && /^\/api\/session\/[^/]+\/permission$/.test(url.pathname)) {
        send(200, { data: [] });
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/interrupt$/.test(url.pathname)) {
        send(200, { interrupted: false });
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/model$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/agent$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && /^\/api\/session\/[^/]+\/move$/.test(url.pathname)) {
        res.writeHead(204).end();
        return;
      }
      if (method === 'GET' && url.pathname === '/api/agent') {
        send(200, { location: { directory: '/tmp' }, data: [] });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/model') {
        send(200, { location: { directory: '/tmp' }, data: [] });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/info') {
        send(200, { version: '2.0.28', pid: 1, urls: [], paths: { tmp: '/tmp' } });
        return;
      }
      send(404, { _tag: 'NotFoundError' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 找出一条请求（按 method + 路径片段）。 */
function findRequest(
  requests: FakeV2Request[],
  method: string,
  pathPart: string,
): FakeV2Request | undefined {
  return requests.find((r) => r.method === method && r.path.includes(pathPart));
}

// ───────────────────────────── 单元层 ─────────────────────────────

describe('V2Driver.createSession', () => {
  it('POST /api/session → 取 data.id；body 带 location（目录是会话属性）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl, directory: '/data/work' });
    const id = await driver.createSession();
    expect(id).toBe('ses_fake_v2');
    const req = findRequest(server.requests, 'POST', '/api/session');
    expect(req?.body).toEqual({ location: { directory: '/data/work' } });
    await server.close();
  });

  it('带 model → body.model 用 Model.Ref 形状（字段名是 id，不是 modelID）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.createSession({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash' });
    const req = findRequest(server.requests, 'POST', '/api/session');
    expect(req?.body).toEqual({ model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' } });
    await server.close();
  });

  it('响应缺 id → DriverRequestError', async () => {
    const server = await startFakeV2Server({ 'POST /api/session': { body: { data: {} } } });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.createSession()).rejects.toBeInstanceOf(DriverRequestError);
    await server.close();
  });
});

describe('V2Driver.sendMessage（v2 prompt body 的形状翻译）', () => {
  it('多个文本 part → 拼成 v2 的 text（换行分隔）；文件 part → files[]（url→uri）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', {
      parts: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
        { type: 'file', mime: 'image/png', filename: 'a.png', url: 'file:///tmp/a.png' },
      ],
    });
    const req = findRequest(server.requests, 'POST', '/prompt');
    expect(req?.body).toEqual({
      text: '第一段\n第二段',
      files: [{ uri: 'file:///tmp/a.png', name: 'a.png' }],
      delivery: 'steer',
    });
    await server.close();
  });

  it('delivery 缺省 = steer；显式 queue 原样透传', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { parts: [{ type: 'text', text: 'hi' }] });
    expect(findRequest(server.requests, 'POST', '/prompt')?.body).toMatchObject({ delivery: 'steer' });
    await driver.sendMessage('ses_1', { parts: [], delivery: 'queue' });
    const queued = server.requests.filter((r) => r.path.includes('/prompt'));
    expect(queued[1]?.body).toMatchObject({ delivery: 'queue' });
    await server.close();
  });

  it('model → 会话级 POST /api/session/{id}/model（v2 的 prompt body 无 model 字段）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', {
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      parts: [],
    });
    const modelReq = findRequest(server.requests, 'POST', '/model');
    expect(modelReq?.path).toBe('/api/session/ses_1/model');
    expect(modelReq?.body).toEqual({
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
    });
    // prompt body 里**不得**出现 model
    expect(findRequest(server.requests, 'POST', '/prompt')?.body).not.toHaveProperty('model');
    await server.close();
  });

  it('agent → POST /api/session/{id}/agent（角色提示的激活机制；不用 prompt 的 agents[] 附件）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { agent: 'vteam-plan', parts: [] });
    const agentReq = findRequest(server.requests, 'POST', '/agent');
    expect(agentReq?.path).toBe('/api/session/ses_1/agent');
    expect(agentReq?.body).toEqual({ agent: 'vteam-plan' });
    expect(findRequest(server.requests, 'POST', '/prompt')?.body).not.toHaveProperty('agents');
    await server.close();
  });

  it('顶层 system 提示：v2 无 system 字段 → 落文本前缀 + 显式告警（不静默丢弃）', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const driver = new V2Driver({ baseUrl: server.baseUrl, logger: { info: jest.fn(), warn, error: jest.fn() } });
    await driver.sendMessage('ses_1', { system: '产出物协议', parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('system');
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('**防重复注入**：已激活 agent 带配置化 system → 顶层 system **不再**拼进正文', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: {
          data: [
            {
              id: 'vteam-plan',
              name: 'vteam-plan',
              mode: 'primary',
              system: 'ROLE_PROMPT_MARKER',
            },
          ],
        },
      },
    });
    const warn = jest.fn();
    const info = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info, warn, error: jest.fn() },
    });
    await driver.sendMessage('ses_1', {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    // agent 的 system 已在模型 system 段里 → 正文里不得再出现同一段提示
    expect(body.text).toBe('干活');
    expect(String(body.text)).not.toContain('产出物协议');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('配置化 system'));
    // 这不是"降级"路径 → 不打 warn
    expect(warn).not.toHaveBeenCalled();
    await server.close();
  });

  it('**防重复注入**：agent 无配置化 system → 仍走文本前缀兜底（+ 告警）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary' }] },
      },
    });
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    await driver.sendMessage('ses_1', {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('**防重复注入**：agent 列表**只查一次**（缓存；不产生逐 prompt 的网络往返）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: {
          data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'X' }],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { agent: 'vteam-plan', system: 'blob', parts: [] });
    await driver.sendMessage('ses_1', { agent: 'vteam-plan', system: 'blob', parts: [] });
    await driver.sendMessage('ses_1', { agent: 'vteam-plan', system: 'blob', parts: [] });
    expect(server.requests.filter((r) => r.method === 'GET' && r.path === '/api/agent')).toHaveLength(1);
    await server.close();
  });

  it('**防重复注入**：agent 列表取不到 → 降级为文本前缀（不抛错、不中断下发）', async () => {
    const server = await startFakeV2Server({ 'GET /api/agent': { status: 500, body: { error: 'boom' } } });
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    await driver.sendMessage('ses_1', {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent 列表失败'));
    await server.close();
  });

  it('目录：v2 的 prompt 无 directory 参数 → 会话级 POST /api/session/{id}/move', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { directory: '/data/tasks/t_1', parts: [] });
    const moveReq = findRequest(server.requests, 'POST', '/move');
    expect(moveReq?.body).toEqual({ directory: '/data/tasks/t_1' });
    expect(findRequest(server.requests, 'POST', '/prompt')?.query.directory).toBeUndefined();
    await server.close();
  });

  it('同一会话同目录不重复 move（幂等）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { directory: '/data/tasks/t_1', parts: [] });
    await driver.sendMessage('ses_1', { directory: '/data/tasks/t_1', parts: [] });
    expect(server.requests.filter((r) => r.path.includes('/move'))).toHaveLength(1);
    await server.close();
  });

  it('在飞注入（同一会话的第二次下发）**不再 move**（会话正在跑，不能改它的工作目录）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.sendMessage('ses_1', { directory: '/data/tasks/t_1', parts: [] });
    await driver.sendMessage('ses_1', { directory: '/data/tasks/t_2', parts: [] });
    expect(server.requests.filter((r) => r.path.includes('/move'))).toHaveLength(1);
    await server.close();
  });

  it('回执是收件条目 → messageId + delivery（不是"执行完成"）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const result = await driver.sendMessage('ses_1', { parts: [] });
    expect(result.messageId).toBe('msg_inbox_1');
    expect(result.delivery).toBe('steer');
    await server.close();
  });
});

describe('V2Driver 不重复注入闸门（agent 查询按**会话目录**作用域）', () => {
  /**
   * 真 v2.0.28 实测：`GET /api/agent`（不带 location）解析的是 serve 的**默认 location**，
   * 冷启动时还返回空数组 ⇒ 用它判「agent 有没有配置化 system」会**恒判没有** ⇒ 逐消息 blob
   * 被重复注入。闸门必须按**会话目录**作用域查。
   */
  it('agent 查询带 location[directory]=<会话目录>（不带 location 的是另一个 location）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE' }] },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl, directory: '/data/work' });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const agentRequests = server.requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/agent',
    );
    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0].query['location[directory]']).toBe('/data/work');
    // 反向：**不带 location** 的形态（那正是修复前的写法）一次都不该出现
    expect(agentRequests.some((r) => r.query['location[directory]'] === undefined)).toBe(false);
    await server.close();
  });

  it('会话被 move 到任务目录后 → agent 查询跟着换目录', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE' }] },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl, directory: '/data/work' });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      directory: '/data/tasks/t_1',
      parts: [],
    });
    const agentRequest = server.requests.find(
      (r) => r.method === 'GET' && r.path === '/api/agent',
    );
    expect(agentRequest?.query['location[directory]']).toBe('/data/tasks/t_1');
    await server.close();
  });

  it('agent 带配置化 system → 顶层 system **不再**拼进正文（闸门生效）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: {
          data: [
            { id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE_PROMPT_MARKER' },
          ],
        },
      },
    });
    const info = jest.fn();
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      directory: '/data/work',
      logger: { info, warn, error: jest.fn() },
    });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('干活');
    expect(String(body.text)).not.toContain('产出物协议');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('配置化 system'));
    expect(warn).not.toHaveBeenCalled();
    await server.close();
  });

  it('agent 列表为空 → 仍走文本前缀兜底（+ 告警）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': { body: { location: { directory: '/data/work' }, data: [] } },
    });
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      directory: '/data/work',
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('agent 没有配置化 system → 仍走文本前缀兜底（+ 告警）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary' }] },
      },
    });
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      directory: '/data/work',
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('agent 列表取不到 → 降级为文本前缀（不抛错、不中断下发）+ 告警', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': { status: 500, body: { error: 'boom' } },
    });
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      directory: '/data/work',
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const sessionID = await driver.createSession();
    await driver.sendMessage(sessionID, {
      agent: 'vteam-plan',
      system: '产出物协议',
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('产出物协议\n\n干活');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent 列表失败'));
    await server.close();
  });

  it('同一 (目录, agent) 的多次提示只查一次（缓存；无逐 prompt 网络往返）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE' }] },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl, directory: '/data/work' });
    const sessionID = await driver.createSession();
    for (let i = 0; i < 3; i++) {
      await driver.sendMessage(sessionID, {
        agent: 'vteam-plan',
        system: '产出物协议',
        parts: [],
      });
    }
    expect(server.requests.filter((r) => r.method === 'GET' && r.path === '/api/agent')).toHaveLength(1);
    await server.close();
  });

  it('缓存键含目录：换目录的会话各自查一次（结论不跨目录串用）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: { data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE' }] },
      },
    });
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl, directory: '/data/work' });
      const sessionID = await driver.createSession();
      await driver.sendMessage(sessionID, { agent: 'vteam-plan', system: 'blob', parts: [] });
      // 另一个**未创建过**的会话 id ⇒ 驱动会走 move 路径（假 server 的 createSession 恒返回同一个 id）
      await driver.sendMessage('ses_other', {
        agent: 'vteam-plan',
        system: 'blob',
        directory: '/data/tasks/t_1',
        parts: [],
      });
      const locations = server.requests
        .filter((r) => r.method === 'GET' && r.path === '/api/agent')
        .map((r) => r.query['location[directory]']);
      expect(locations).toEqual(['/data/work', '/data/tasks/t_1']);
    } finally {
      await server.close();
    }
  });
});

describe('V2Driver 逐消息 blob 的载体选择（D6 (f) 插件交接 vs 文本前缀兜底）', () => {
  const BLOB = '产出物协议';

  interface FakeHandoff extends SystemHandoffPort {
    delivered: Array<{ sessionID: string; blob: string }>;
    cleared: string[];
    installed: boolean;
    ready: boolean;
    deliverOk: boolean;
  }

  function makeFakeHandoff(
    init: Partial<Pick<FakeHandoff, 'installed' | 'ready' | 'deliverOk'>> = {},
  ): FakeHandoff {
    const fake: FakeHandoff = {
      delivered: [],
      cleared: [],
      installed: init.installed ?? true,
      ready: init.ready ?? true,
      deliverOk: init.deliverOk ?? true,
      pluginInstalled: () => fake.installed,
      locationReady: () => fake.ready,
      awaitLocationReady: async () => fake.ready,
      deliver: (sessionID: string, blob: string) => {
        if (!fake.deliverOk) {
          return false;
        }
        fake.delivered.push({ sessionID, blob });
        return true;
      },
      clear: (sessionID: string) => {
        fake.cleared.push(sessionID);
      },
    };
    return fake;
  }

  it('插件已就位 → blob 走交接文件（system 段），正文**不**拼前缀，也不告警', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const info = jest.fn();
    const handoff = makeFakeHandoff();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info, warn, error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('干活');
    expect(String(body.text)).not.toContain(BLOB);
    expect(handoff.delivered).toEqual([{ sessionID: 'ses_1', blob: BLOB }]);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('插件未注入（老镜像）→ 退回文本前缀（与插件方案落地前逐字节一致）+ 告警', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const handoff = makeFakeHandoff({ installed: false });
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe(`${BLOB}\n\n干活`);
    expect(handoff.delivered).toHaveLength(0);
    // 走前缀兜底 ⇒ 必须清掉交接文件（否则插件会把同一段 blob 也推进 system 段）
    expect(handoff.cleared).toContain('ses_1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('插件已注入但**未被 serve 加载**（就绪标记缺失）→ 退回文本前缀 + 告警', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const handoff = makeFakeHandoff({ ready: false });
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe(`${BLOB}\n\n干活`);
    expect(handoff.delivered).toHaveLength(0);
    expect(handoff.cleared).toContain('ses_1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('交接写盘失败 → 退回文本前缀（**不抛错**、不中断下发）+ 告警', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const handoff = makeFakeHandoff({ deliverOk: false });
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe(`${BLOB}\n\n干活`);
    expect(handoff.cleared).toContain('ses_1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('agent 自带配置化 system → 逐消息 blob **整体不注入**（两条路都不走）', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: {
          data: [{ id: 'vteam-plan', name: 'vteam-plan', mode: 'primary', system: 'ROLE_PROMPT' }],
        },
      },
    });
    const handoff = makeFakeHandoff();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', {
      agent: 'vteam-plan',
      system: BLOB,
      parts: [{ type: 'text', text: '干活' }],
    });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe('干活');
    expect(String(body.text)).not.toContain(BLOB);
    expect(handoff.delivered).toHaveLength(0);
    // 残留的交接文件必须清掉（否则插件会把旧 blob 也推进 system 段 = 重复注入）
    expect(handoff.cleared).toContain('ses_1');
    await server.close();
  });

  it('**互斥**：走前缀兜底时清掉交接文件 ⇒ 同一段 blob 绝不同时出现在两段', async () => {
    const server = await startFakeV2Server();
    const handoff = makeFakeHandoff({ ready: false });
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(String(body.text)).toContain(BLOB);
    expect(handoff.delivered).toHaveLength(0);
    expect(handoff.cleared).toEqual(['ses_1']);
    await server.close();
  });

  it('没有交接通道（未注入该能力）→ 文本前缀兜底，行为与插件方案落地前完全一致', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    await driver.sendMessage('ses_1', { system: BLOB, parts: [{ type: 'text', text: '干活' }] });
    const body = findRequest(server.requests, 'POST', '/prompt')?.body as Record<string, unknown>;
    expect(body.text).toBe(`${BLOB}\n\n干活`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system'));
    await server.close();
  });

  it('abort（会话生命周期终点）→ 清掉该会话的交接文件（交接目录保持有界）', async () => {
    const server = await startFakeV2Server();
    const handoff = makeFakeHandoff();
    const driver = new V2Driver({
      baseUrl: server.baseUrl,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemHandoff: handoff,
    });
    await driver.abort('ses_1');
    expect(handoff.cleared).toContain('ses_1');
    await server.close();
  });
});

describe('V2Driver.getMessages（消息联合体 → vteam 消息）', () => {
  const userMessage = {
    id: 'msg_u1',
    type: 'user',
    time: { created: 1000 },
    text: '用户输入',
  };
  const assistantMessage = {
    id: 'msg_a1',
    type: 'assistant',
    time: { created: 1100, streamed: 1200, completed: 1300 },
    agent: 'build',
    model: { id: 'free-model', providerID: 'opencode' },
    content: [
      { type: 'text', text: '思考后的正文' },
      { type: 'reasoning', text: '先这样想', time: { created: 1110, completed: 1150 } },
      {
        type: 'tool',
        id: 'call_1',
        name: 'read',
        executed: true,
        state: {
          status: 'completed',
          input: { path: 'a.txt' },
          content: [{ type: 'text', text: '文件内容' }],
          metadata: { duration: 12 },
        },
        time: { created: 1160, ran: 1165, completed: 1180 },
      },
    ],
    finish: 'stop',
    rawFinish: 'stop',
    cost: 0.25,
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
  };

  it('user 消息无 parts → 合成一个文本 part；role 由 type 决定', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': { body: { data: [userMessage], cursor: { next: null } } },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    expect(messages).toHaveLength(1);
    expect(messages[0].info.role).toBe('user');
    expect(messages[0].parts).toHaveLength(1);
    expect(messages[0].parts[0].type).toBe('text');
    expect(messages[0].parts[0].text).toBe('用户输入');
    // part id = 统一口径 `${messageID}:text`（旧口径是下标形态 `${messageID}:0`）
    expect(messages[0].parts[0].id).toBe('msg_u1:text');
    await server.close();
  });

  it('assistant 的 content[] → text/reasoning/tool 三类 part（1:1）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [assistantMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    const parts = messages[0].parts;
    expect(parts.map((p) => p.type)).toEqual(['text', 'reasoning', 'tool', 'step-finish']);
    expect(parts[0].text).toBe('思考后的正文');
    expect(parts[1].text).toBe('先这样想');
    expect(parts[2].tool).toBe('read');
    // part id = 统一口径（`v2-part-id.ts`；旧口径是下标形态 `${messageID}:${index}`）
    expect(parts.map((p) => p.id)).toEqual([
      'msg_a1:text',
      'msg_a1:reasoning',
      'msg_a1:tool:call_1',
      'msg_a1:step-finish',
    ]);
    // provider 侧 call id 落在透传字段
    expect(parts[2].callID).toBe('call_1');
    // 模型信息映射到 info（prompt-await 的 findAssistantModel 读这两个字段）
    expect(messages[0].info.providerID).toBe('opencode');
    expect(messages[0].info.modelID).toBe('free-model');
    await server.close();
  });

  it('tool 的 state.content[]（数组）→ 归一成 vteam 的 state.output（字符串）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [assistantMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    const toolPart = messages[0].parts.find((p) => p.type === 'tool');
    const state = toolPart?.state as { status: string; output: string; input: unknown };
    expect(state.status).toBe('completed');
    expect(state.output).toBe('文件内容');
    expect(state.input).toEqual({ path: 'a.txt' });
    await server.close();
  });

  it('合成的 step-finish part：reason/finish + tokens + cost（控制面靠它做完成幂等键）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [assistantMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    const finish = messages[0].parts.find((p) => p.type === 'step-finish');
    expect(finish?.reason).toBe('stop');
    expect(finish?.cost).toBe(0.25);
    expect(finish?.tokens).toEqual({
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 1, write: 2 },
    });
    await server.close();
  });

  it('tool-calls 结束 → step-finish.reason = tool-calls（vteam 的工具循环诊断分支）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: {
          data: [{ ...assistantMessage, finish: 'tool-calls', rawFinish: 'tool_calls' }],
          cursor: { next: null },
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    expect(messages[0].parts.find((p) => p.type === 'step-finish')?.reason).toBe('tool-calls');
    await server.close();
  });

  it('非 user/assistant 的消息类型（idle 等）丢弃（不污染 role 二值模型）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: {
          data: [
            { id: 'msg_i1', type: 'idle', time: { created: 900 }, outcome: 'succeeded' },
            userMessage,
            { id: 'msg_s1', type: 'system', time: { created: 950 }, text: 'sys' },
          ],
          cursor: { next: null },
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const messages = await driver.getMessages('ses_1');
    expect(messages.map((m) => m.info.id)).toEqual(['msg_u1']);
    await server.close();
  });

  it('默认请求 order=asc（与 v1 的整会话列表等价）并按游标翻页（长会话不丢消息）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': { body: { data: [], cursor: { next: null } } },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.getMessages('ses_1');
    const first = findRequest(server.requests, 'GET', '/message');
    expect(first?.query.order).toBe('asc');
    expect(first?.query.limit).toBe('200');
    await server.close();
  });

  it('翻页请求**不带 order**（游标已编码方向，同传会被 400 InvalidCursorError）', async () => {
    let page = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      page += 1;
      const payload =
        page === 1
          ? { data: [{ id: 'm1', type: 'user', time: { created: 1 }, text: 'a' }], cursor: { next: 'CUR1' } }
          : { data: [{ id: 'm2', type: 'user', time: { created: 2 }, text: 'b' }], cursor: { next: null } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      void url;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const driver = new V2Driver({ baseUrl: `http://127.0.0.1:${port}` });
    const messages = await driver.getMessages('ses_1');
    expect(messages.map((m) => m.info.id)).toEqual(['m1', 'm2']);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('V2Driver 的 part id 契约（单源：口径见 v2-part-id.ts）', () => {
  /** 一条含多段文本 + 思考 + 工具的 assistant 消息（v2 wire 形态）。 */
  const multiContentMessage = {
    id: 'msg_m1',
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

  it('同一条 assistant 消息重复轮询 → part id 完全一致（server 按 id 合并 parts）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [multiContentMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const first = await driver.getMessages('ses_1');
    const second = await driver.getMessages('ses_1');
    expect(first[0].parts.map((p) => p.id)).toEqual(second[0].parts.map((p) => p.id));
    await server.close();
  });

  it('一条消息多段同类内容 → id 互不相同（同类第 k 段加 `:k`）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [multiContentMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const ids = (await driver.getMessages('ses_1'))[0].parts.map((p) => p.id);
    expect(ids).toEqual([
      'msg_m1:text',
      'msg_m1:reasoning',
      'msg_m1:tool:call_1',
      'msg_m1:text:1',
      'msg_m1:step-finish',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    await server.close();
  });

  it('多段同类内容的 id 在两次轮询之间不变（序号只按同类别计，不随其它类别漂移）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [multiContentMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const first = (await driver.getMessages('ses_1'))[0].parts.map((p) => p.id);
    const second = (await driver.getMessages('ses_1'))[0].parts.map((p) => p.id);
    expect(first).toEqual(second);
    // 第二段文本的序号与「前面有没有别的类别」无关 → 与内容下标形态不同（那是 `:2`）
    expect(first).toContain('msg_m1:text:1');
    await server.close();
  });

  it('内容追加式增长（v2 的 content[] 只增不改）→ 已有内容的 id 不变', async () => {
    let grown = false;
    const server = http.createServer((req, res) => {
      const data = grown
        ? [
            ...multiContentMessage.content,
            { type: 'text', text: '第三段' },
          ]
        : multiContentMessage.content;
      const payload = JSON.stringify({
        data: [{ ...multiContentMessage, content: data }],
        cursor: { next: null },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const driver = new V2Driver({ baseUrl: `http://127.0.0.1:${port}` });
    const before = (await driver.getMessages('ses_1'))[0].parts;
    grown = true;
    const after = (await driver.getMessages('ses_1'))[0].parts;
    // 已有内容的 id 全部保持不变（只有新段拿到新 id）
    const beforeIds = before.filter((p) => p.type !== 'step-finish').map((p) => p.id ?? '');
    const afterIds = after.filter((p) => p.type !== 'step-finish').map((p) => p.id ?? '');
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
    expect(afterIds).toContain('msg_m1:text:2');
    // 合成的 step-finish id 也不变（它永远排在内容之后，故只比 id 不比位置）
    expect(after.find((p) => p.type === 'step-finish')?.id).toBe('msg_m1:step-finish');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('step-finish 的 id 是 `${messageID}:step-finish`，且不与任何内容 id 相撞', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/message': {
        body: { data: [multiContentMessage], cursor: { next: null } },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const parts = (await driver.getMessages('ses_1'))[0].parts;
    const ids = parts.map((p) => p.id ?? '');
    expect(ids).toContain('msg_m1:step-finish');
    // 内容 id 里不得出现 step-finish 段（否则会与合成 part 撞 id）
    const contentIds = ids.filter((id) => id !== 'msg_m1:step-finish');
    expect(contentIds.some((id) => id.includes(':step-finish'))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    await server.close();
  });
});

describe('V2Driver question / permission 通道', () => {
  it('form 的字段 → vteam 的问题条目（一个字段 = 一个问题）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/form': {
        body: {
          data: [
            {
              id: 'frm_1',
              sessionID: 'ses_1',
              title: '执行确认',
              fields: [
                {
                  key: 'choice',
                  title: '继续吗？',
                  type: 'multiselect',
                  options: [{ value: 'go', label: '继续', description: '放行' }],
                },
                { key: 'note', title: '备注', type: 'string', custom: true },
              ],
            },
          ],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const questions = await driver.listQuestions('ses_1');
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe('frm_1');
    expect(questions[0].questions).toHaveLength(2);
    expect(questions[0].questions[0]).toEqual({
      question: '继续吗？',
      header: '执行确认',
      options: [{ label: '继续', description: '放行' }],
      multiple: true,
    });
    expect(questions[0].questions[1]).toEqual({
      question: '备注',
      header: '执行确认',
      options: [],
      custom: true,
    });
    await server.close();
  });

  it('答复 body 是 {answer:{key:value}}（v2 键名/形状），**不是** v1 的 {answers:[[…]]}', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/form': {
        body: {
          data: [
            {
              id: 'frm_1',
              sessionID: 'ses_1',
              title: '执行确认',
              fields: [
                {
                  key: 'choice',
                  title: '继续吗？',
                  type: 'multiselect',
                  options: [{ value: 'go', label: '继续' }],
                },
              ],
            },
          ],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.listQuestions('ses_1');
    await driver.replyQuestion('ses_1', 'frm_1', [['继续']]);
    const req = findRequest(server.requests, 'POST', '/form/frm_1/reply');
    expect(req?.body).toEqual({ answer: { choice: ['go'] } });
    expect(JSON.stringify(req?.body)).not.toContain('answers');
    await server.close();
  });

  it('拒绝问题 → DELETE /api/session/{id}/form/{formID}', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.rejectQuestion('ses_1', 'frm_1');
    const req = findRequest(server.requests, 'DELETE', '/form/frm_1');
    expect(req?.path).toBe('/api/session/ses_1/form/frm_1');
    await server.close();
  });

  it('权限列表：v2 的 action/resources 与 vteam 同名，直接映射', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_1/permission': {
        body: {
          data: [
            {
              id: 'per_1',
              sessionID: 'ses_1',
              action: 'bash',
              resources: ['/data/*'],
              save: ['/data/x'],
              metadata: { tool: 'bash' },
            },
          ],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const permissions = await driver.listPermissions('ses_1');
    expect(permissions).toEqual([
      {
        id: 'per_1',
        sessionId: 'ses_1',
        action: 'bash',
        resources: ['/data/*'],
        save: ['/data/x'],
        metadata: { tool: 'bash' },
      },
    ]);
    await server.close();
  });

  it('权限答复 body 是 {decision}（v2 键名），**不是** v1 的 {reply}', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.replyPermission('ses_1', 'per_1', 'always');
    const req = findRequest(server.requests, 'POST', '/permission/per_1/reply');
    expect(req?.body).toEqual({ decision: 'always' });
    expect(JSON.stringify(req?.body)).not.toContain('reply');
    await server.close();
  });
});

describe('V2Driver abort / listAgents / listModels / listTodos / isHealthy', () => {
  it('abort：{interrupted:false}（空闲）是成功，不抛错', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.abort('ses_1')).resolves.toBeUndefined();
    const req = findRequest(server.requests, 'POST', '/interrupt');
    expect(req?.path).toBe('/api/session/ses_1/interrupt');
    await server.close();
  });

  it('abort：会话不存在（404）→ 幂等空操作，不抛错', async () => {
    const server = await startFakeV2Server({
      'POST /api/session/ses_gone/interrupt': { status: 404, body: { _tag: 'SessionNotFoundError' } },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.abort('ses_gone')).resolves.toBeUndefined();
    await server.close();
  });

  it('listAgents：目录参数用 deepObject 风格（location[directory]），扁平写法会被 400', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await driver.listAgents('/data/work');
    const req = findRequest(server.requests, 'GET', '/api/agent');
    expect(req?.query['location[directory]']).toBe('/data/work');
    expect(req?.query.location).toBeUndefined();
    await server.close();
  });

  it('listAgents：name ← v2 的 id；native 按内置 id 判定；permission ← permissions[]；prompt ← system', async () => {
    const server = await startFakeV2Server({
      'GET /api/agent': {
        body: {
          location: { directory: '/data/work' },
          data: [
            {
              id: 'build',
              name: 'Build',
              description: '默认 agent',
              mode: 'primary',
              hidden: false,
              request: { settings: {}, headers: {}, body: {} },
              permissions: [{ action: '*', resource: '*', effect: 'allow' }],
            },
            {
              id: 'vteam-plan',
              name: 'vteam-plan',
              mode: 'all',
              hidden: false,
              system: '角色提示全文',
              permissions: [],
            },
          ],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const agents = await driver.listAgents('/data/work');
    expect(agents.map((a) => a.name)).toEqual(['build', 'vteam-plan']);
    expect(agents[0].native).toBe(true);
    expect(agents[0].hidden).toBe(false);
    expect(agents[0].permission).toEqual([{ action: '*', resource: '*', effect: 'allow' }]);
    expect(agents[1].native).toBe(false);
    expect(agents[1].prompt).toBe('角色提示全文');
    expect(agents[1].mode).toBe('all');
    await server.close();
  });

  it('listModels：{location,data} 包装解包；enabled:false 的模型不列出', async () => {
    const server = await startFakeV2Server({
      'GET /api/model': {
        body: {
          location: { directory: '/data/work' },
          data: [
            { id: 'm1', modelID: 'm1', providerID: 'opencode', name: 'M1', status: 'active', enabled: true },
            { id: 'm2', modelID: 'm2', providerID: 'opencode', name: 'M2', status: 'active', enabled: false },
          ],
        },
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: 'opencode/m1', name: 'M1', providerID: 'opencode', modelID: 'm1', status: 'active' },
    ]);
    await server.close();
  });

  it('listModels：裸数组形态（2.0.32 spec）同样容忍', async () => {
    const server = await startFakeV2Server({
      'GET /api/model': {
        body: [{ id: 'm1', modelID: 'm1', providerID: 'opencode', name: 'M1', status: 'active' }],
      },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    const models = await driver.listModels();
    expect(models.map((m) => m.id)).toEqual(['opencode/m1']);
    await server.close();
  });

  it('listTodos：v2 无端点 → 空数组 + 限频告警（不刷屏）', async () => {
    const server = await startFakeV2Server();
    const warn = jest.fn();
    const driver = new V2Driver({ baseUrl: server.baseUrl, logger: { info: jest.fn(), warn, error: jest.fn() } });
    await expect(driver.listTodos('ses_1', '/data/work')).resolves.toEqual([]);
    await driver.listTodos('ses_1', '/data/work');
    await driver.listTodos('ses_1', '/data/work');
    expect(warn).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it('isHealthy：打 /api/info（不是 / —— v2 的 / 是 web SPA，未鉴权也 200）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.isHealthy()).resolves.toBe(true);
    expect(findRequest(server.requests, 'GET', '/api/info')).toBeDefined();
    expect(findRequest(server.requests, 'GET', '/api/info')?.path).toBe('/api/info');
    await server.close();
  });

  it('isHealthy：200 但是 HTML（不是 JSON）→ false（不因错误的原因判"在线"）', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html></html>');
      void req;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const driver = new V2Driver({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(driver.isHealthy()).resolves.toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('V2Driver 鉴权 / 错误归一', () => {
  it('口令非空 → Basic Auth（username=opencode）', async () => {
    const server = await startFakeV2Server();
    const driver = new V2Driver({ baseUrl: server.baseUrl, serverPassword: 'pw' });
    await driver.listModels();
    expect(driver.authPassword).toBe('pw');
    await server.close();
  });

  it('404 → err.status === 404（会话失效重建路径依赖它）', async () => {
    const server = await startFakeV2Server({
      'GET /api/session/ses_gone/message': { status: 404, body: { _tag: 'SessionNotFoundError' } },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.getMessages('ses_gone')).rejects.toMatchObject({ status: 404 });
    await server.close();
  });

  it('401 → err.status === 401（配置错误判定依赖它）', async () => {
    const server = await startFakeV2Server({
      'GET /api/model': { status: 401, body: { _tag: 'UnauthorizedError' } },
    });
    const driver = new V2Driver({ baseUrl: server.baseUrl });
    await expect(driver.listModels()).rejects.toMatchObject({ status: 401 });
    await server.close();
  });

  it('baseUrl 未设置 → DriverRequestError', async () => {
    const driver = new V2Driver({ baseUrl: '' });
    await expect(driver.listModels()).rejects.toThrow(/baseUrl 未设置/);
  });
});

describe('V2 形状翻译纯函数', () => {
  it('unwrapV2List：{data:[…]} 与裸数组都认；其余 → []', () => {
    expect(unwrapV2List({ data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapV2List([1, 2])).toEqual([1, 2]);
    expect(unwrapV2List({ data: 'x' })).toEqual([]);
    expect(unwrapV2List(null)).toEqual([]);
  });

  it('unwrapV2Object：{data:{…}} → 内层对象', () => {
    expect(unwrapV2Object<{ id: string }>({ data: { id: 'x' } })).toEqual({ id: 'x' });
    expect(unwrapV2Object<{ id: string }>({ id: 'y' })).toEqual({ id: 'y' });
    expect(unwrapV2Object(null)).toBeUndefined();
  });

  it('translateV2PromptParts：文本拼接 + 文件 url→uri（非 file 的 url 不进 files）', () => {
    const result = translateV2PromptParts([
      { type: 'text', text: 'a' },
      { type: 'file', mime: 'image/png', filename: 'x.png', url: 'file:///tmp/x.png' },
      { type: 'file', mime: 'image/png', filename: 'y.png', url: '' },
      { type: 'text', text: 'b' },
    ]);
    expect(result.text).toBe('a\nb');
    expect(result.files).toEqual([{ uri: 'file:///tmp/x.png', name: 'x.png' }]);
  });

  it('normalizeV2ToolState：content[] → output 字符串；error 对象 → error 字符串', () => {
    const state = normalizeV2ToolState(
      {
        status: 'error',
        input: { a: 1 },
        content: [{ type: 'text', text: 'out' }, { type: 'file', uri: 'file:///a', name: 'a' }],
        error: { type: 'tool.execution', message: '炸了' },
      },
      { created: 1, completed: 2 },
    ) as Record<string, unknown>;
    expect(state.status).toBe('error');
    expect(state.output).toBe('out\n[文件] a');
    expect(state.error).toBe('炸了');
    expect(state.errorDetail).toEqual({ type: 'tool.execution', message: '炸了' });
    expect(state.time).toEqual({ start: 1, end: 2 });
  });

  it('mapV2FormField：字段 → 问题（options/multiple/custom）', () => {
    const mapped = mapV2FormField(
      { title: '表单标题' },
      { key: 'k', title: '问题', type: 'string', options: [{ value: 'v', label: 'L' }], custom: true },
    );
    expect(mapped.header).toBe('表单标题');
    expect(mapped.question).toBe('问题');
    expect(mapped.options).toEqual([{ label: 'L', description: '' }]);
    expect(mapped.custom).toBe(true);
    expect(mapped.multiple).toBeUndefined();
  });

  it('buildV2FormAnswer：label → value；multiselect 保留数组；字段未知时按序号的 key 兜底', () => {
    expect(
      buildV2FormAnswer(
        [{ key: 'k', type: 'multiselect', options: [{ value: 'v1', label: 'L1' }] }],
        [['L1']],
      ),
    ).toEqual({ k: ['v1'] });
    expect(buildV2FormAnswer(undefined, [['L1']])).toEqual({ '0': 'L1' });
  });
});

// ───────────────────────────── 契约层（真 opencode v2） ─────────────────────────────

/** 找 opencode v2 二进制：环境变量 → 固定路径 → PATH。 */
function findOpencodeBinary(): string | null {
  const candidates = [
    process.env.OPENCODE_BIN,
    '/Users/mac/.opencode/bin/opencode',
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

const opencodeBinary = findOpencodeBinary();

/** 真 serve 的 boot 结果。 */
interface BootedServer {
  baseUrl: string;
  /** serve 的 Basic Auth 口令（username 固定 opencode）。 */
  password: string;
  stop(): Promise<void>;
}

/**
 * 起真的 opencode v2 serve（独立进程组），解析 banner 取端口。
 *
 * 清理：`process.kill(-pid)` 杀**整个进程组**（与 `runtime/opencode-server.ts` 同款），
 * 3s 后 SIGKILL 兜底——测试绝不能留下孤儿 serve。
 *
 * `options.cwd` = serve 的工作目录（= serve 的**默认 location**）；`options.env` 追加到子进程
 * 环境（隔离配置域用：把 HOME / XDG_* 指到临时目录 ⇒ 宿主的全局配置不在作用域内）。
 */
async function bootRealV2Server(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; password?: string } = {},
): Promise<BootedServer> {
  if (!opencodeBinary) {
    throw new Error('opencode 二进制不存在');
  }
  const port = await getRandomFreePort();
  const password = options.password ?? 't9-contract-test-pw';
  const child: ChildProcess = spawn(
    opencodeBinary,
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, ...(options.env ?? {}) },
      cwd: options.cwd,
      // detached → 独立进程组，kill(-pid) 整体清理
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      const match = /listening on http:\/\/[^:\s/]+:(\d+)/.exec(output);
      if (match) {
        clearInterval(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`opencode serve 提前退出（exit=${child.exitCode}）:\n${output}`));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`opencode serve 启动超时:\n${output}`));
      }
    }, 100);
  });
  return {
    baseUrl,
    password,
    stop: async () => {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // 已退出
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // 已退出
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

const describeReal = opencodeBinary ? describe : describe.skip;

describeReal('V2Driver 对真 opencode v2 server 的契约测试', () => {
  jest.setTimeout(90_000);
  let server: BootedServer;
  let driver: V2Driver;

  beforeAll(async () => {
    server = await bootRealV2Server();
    driver = new V2Driver({ baseUrl: server.baseUrl, serverPassword: 't9-contract-test-pw' });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('isHealthy：/api/info 鉴权后 200（未鉴权的 / 是 web SPA，不能用来判健康）', async () => {
    await expect(driver.isHealthy()).resolves.toBe(true);
  });

  it('listModels：非空且 id 形如 providerID/modelID', async () => {
    const models = await driver.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.id).toBe(`${model.providerID}/${model.modelID}`);
      expect(typeof model.name).toBe('string');
    }
  });

  it('listAgents：返回数组（agent 的 name 是键，不是展示名）', async () => {
    const agents = await driver.listAgents();
    expect(Array.isArray(agents)).toBe(true);
  });

  it('createSession：返回 ses_ 开头的会话 id', async () => {
    const sessionID = await driver.createSession();
    expect(sessionID).toMatch(/^ses_/);
  });

  it('getMessages：新会话的消息列表为空且结构正确（{data,cursor} 已解包）', async () => {
    const sessionID = await driver.createSession();
    const messages = await driver.getMessages(sessionID);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(0);
  });

  it('listTodos：v2 无端点 → 空数组（不抛错）', async () => {
    const sessionID = await driver.createSession();
    await expect(driver.listTodos(sessionID)).resolves.toEqual([]);
  });

  it('abort：空闲会话返回 {interrupted:false} 且**不抛错**', async () => {
    const sessionID = await driver.createSession();
    await expect(driver.abort(sessionID)).resolves.toBeUndefined();
  });

  it('abort：不存在的会话（404）也是幂等空操作', async () => {
    await expect(driver.abort('ses_definitely_not_exist')).resolves.toBeUndefined();
  });
});

/* ───────────────── 真二进制属性：agent 目录查询的 location 作用域 ───────────────── */

/** 真 serve 的 agent 列表项（只取本测试断言用到的字段）。 */
interface RealAgent {
  id?: string;
  system?: string;
}

/** 带 Basic Auth 的 agent 列表查询（location 为空 = 不带参数）。 */
async function fetchRealAgents(
  baseUrl: string,
  password: string,
  location?: string,
): Promise<RealAgent[]> {
  const url = new URL('/api/agent', baseUrl);
  if (location) {
    url.searchParams.set('location[directory]', location);
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GET /api/agent → HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: RealAgent[] };
  return Array.isArray(body.data) ? body.data : [];
}

describeReal('真 v2：agent 目录查询的 location 作用域（上游行为钉死）', () => {
  jest.setTimeout(120_000);
  let scratch = '';
  let server: BootedServer | undefined;
  let serveCwd = '';
  let projectDir = '';

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-agent-location-'));
    serveCwd = path.join(scratch, 'serve-cwd');
    projectDir = path.join(scratch, 'project');
    fs.mkdirSync(serveCwd, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    // 项目配置：带**配置化 system** 的自定义 agent（闸门要认的就是它）
    fs.writeFileSync(
      path.join(projectDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        agents: {
          'vteam-probe': {
            description: '真实二进制属性测试用的 agent',
            mode: 'primary',
            system: 'PROBE_ROLE_MARKER',
          },
        },
      }),
      'utf8',
    );
    // 隔离配置域：宿主的全局配置/凭据不在作用域内（与 worker 的隔离方案同款）
    const iso = path.join(scratch, 'iso');
    for (const sub of ['home', 'config', 'data', 'state', 'cache']) {
      fs.mkdirSync(path.join(iso, sub), { recursive: true });
    }
    server = await bootRealV2Server({
      cwd: serveCwd,
      password: 't9-agent-location-pw',
      env: {
        HOME: path.join(iso, 'home'),
        XDG_CONFIG_HOME: path.join(iso, 'config'),
        XDG_DATA_HOME: path.join(iso, 'data'),
        XDG_STATE_HOME: path.join(iso, 'state'),
        XDG_CACHE_HOME: path.join(iso, 'cache'),
      },
    });
  });

  afterAll(async () => {
    await server?.stop();
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('不带 location 的查询拿不到目标 location 的 agent（冷启动为空数组；预热后也只是默认 location 的集合）', async () => {
    // 冷启动的第一次 agent 查询 = 空数组（上游实测；项目配置是异步加载的）
    const cold = await fetchRealAgents(server!.baseUrl, server!.password);
    expect(cold).toEqual([]);
    // 预热之后：不带 location 的查询返回的是 **serve 默认 location**（= serve 的 cwd）的 agent，
    // **绝不是**目标 location（projectDir）的那个带 system 的自定义 agent
    await fetchRealAgents(server!.baseUrl, server!.password);
    const warm = await fetchRealAgents(server!.baseUrl, server!.password);
    expect(warm.some((a) => a.id === 'vteam-probe')).toBe(false);
  });

  it('带 location[directory]= 的查询返回该 location 的 agent（含项目配置 agent 的 system）', async () => {
    // 上游的项目配置是异步加载的 ⇒ 轮询到它出现为止（最多 ~10s）
    let agents: RealAgent[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      agents = await fetchRealAgents(server!.baseUrl, server!.password, projectDir);
      if (agents.some((a) => a.id === 'vteam-probe')) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    const probe = agents.find((a) => a.id === 'vteam-probe');
    expect(probe).toBeDefined();
    expect(probe?.system).toBe('PROBE_ROLE_MARKER');
  });
});
