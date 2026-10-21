import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as ts from 'typescript';
import { EventSender } from '../client/event-client';
import type {
  DriverMessage,
  DriverModelInfo,
  OpenCodeDriver,
} from '../driver/opencode-driver';
import { ExecServer } from '../exec/exec-server';
import {
  WORKER_EVENT_TYPES,
  WorkerEventPayload,
  HeartbeatWorkerPayload,
  RegisterWorkerPayload,
  WORKER_COMMAND_TYPES,
  WorkerCommand,
  ModelCredentialsPayload,
  GitCredentialsPayload,
  SecretCommandRequestPayload,
  SecretCommandResponsePayload,
  CreateSessionRequestPayload,
  CreateSessionResponsePayload,
  SessionAbortResponsePayload,
  SessionMessagesQuery,
  SessionMessagesResponsePayload,
  SessionPromptRequestPayload,
  SessionPromptResponsePayload,
  WorkerModelInfo,
  WorkerModelRef,
  WorkerModelsResponsePayload,
  WorkerDeliveryMode,
  SessionMessage,
} from './worker-protocol';

/**
 * worker 协议契约测试（T1 契约基座）。
 * 模拟双端 JSON 互通：worker 侧类型构造完整对象 → JSON.stringify → JSON.parse
 * 反序列化后可完整读取（server 侧 DTO 反序列化同路径）。断言字段结构完整、
 * 事件 type 枚举点号命名、可选字段缺省语义。
 */
describe('worker 协议契约（T1 双端 JSON 互通）', () => {  it('RegisterWorkerPayload 序列化/反序列化后字段完整（对齐 POST /workers/register）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000001',
      name: 'worker-1',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 2, skills: ['coding'], tools: ['git'] },
      load: { instances: 1 },
    };

    const wire = JSON.stringify(registration);
    const parsed = JSON.parse(wire) as RegisterWorkerPayload;

    expect(parsed.workerId).toBe('w_0000000001');
    expect(parsed.name).toBe('worker-1');
    expect(parsed.opencodeVersion).toBe('1.18.14');
    expect(parsed.capabilities).toEqual({
      maxInstances: 2,
      skills: ['coding'],
      tools: ['git'],
    });
    expect(parsed.load).toEqual({ instances: 1 });
  });

  it('RegisterWorkerPayload capabilities 支持可选 port（F2 C2：随机端口上报链路）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000001',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 1, skills: [], tools: ['git_clone'], port: 53001 },
      load: { instances: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.capabilities.port).toBe(53001);
  });

  it('RegisterWorkerPayload 可选 name 缺省时反序列化不丢其余字段', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000002',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.workerId).toBe('w_0000000002');
    expect(parsed.name).toBeUndefined();
    expect(parsed.capabilities).toEqual({ maxInstances: 1, skills: [], tools: [] });
  });

  it('C2：capabilities.models 序列化/反序列化后字段完整（真实模型列表上报）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000003',
      opencodeVersion: '1.18.15',
      capabilities: {
        maxInstances: 1,
        skills: [],
        tools: [],
        models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
      },
      load: { instances: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.capabilities.models).toEqual(['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1']);
  });

  it('models-truth：capabilities.executableModels 序列化/反序列化后完整（CLI 可执行集上报）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000005',
      opencodeVersion: '1.18.29',
      capabilities: {
        maxInstances: 1,
        skills: [],
        tools: [],
        executableModels: ['opencode/big-pickle', 'opencode/nemotron-3.5-lightning-free'],
      },
      load: { instances: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.capabilities.executableModels).toEqual([
      'opencode/big-pickle',
      'opencode/nemotron-3.5-lightning-free',
    ]);
  });

  it('C2：defaultModelId 序列化/反序列化后完整（配置 WORKER_DEFAULT_MODEL 上报链路）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000004',
      opencodeVersion: '1.18.15',
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
      defaultModelId: 'opencode-go/deepseek-v4-flash',
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
  });

  it('C2：defaultModelId 未配置时缺省（反序列化 undefined）', () => {
    const registration: RegisterWorkerPayload = {
      workerId: 'w_0000000005',
      opencodeVersion: '1.18.15',
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
    };

    const parsed = JSON.parse(JSON.stringify(registration)) as RegisterWorkerPayload;
    expect(parsed.defaultModelId).toBeUndefined();
  });

  it('HeartbeatWorkerPayload 序列化/反序列化后字段完整（对齐 POST /workers/:id/heartbeat）', () => {
    const heartbeat: HeartbeatWorkerPayload = {
      workerId: 'w_0000000001',
      load: { instances: 1 },
      health: 'degraded',
    };

    const parsed = JSON.parse(JSON.stringify(heartbeat)) as HeartbeatWorkerPayload;
    expect(parsed.workerId).toBe('w_0000000001');
    expect(parsed.load).toEqual({ instances: 1 });
    expect(parsed.health).toBe('degraded');
  });

  it('WorkerEventPayload 序列化/反序列化后字段完整（对齐 POST /worker/events，含 seq）', () => {
    const event: WorkerEventPayload = {
      workerId: 'w_0000000001',
      eventId: 'evw_0000000042',
      type: 'message.part.delta',
      payload: { sessionId: 's_0000000001', text: '你好' },
      seq: 42,
    };

    const parsed = JSON.parse(JSON.stringify(event)) as WorkerEventPayload;
    expect(parsed.workerId).toBe('w_0000000001');
    expect(parsed.eventId).toBe('evw_0000000042');
    expect(parsed.type).toBe('message.part.delta');
    expect(parsed.payload).toEqual({ sessionId: 's_0000000001', text: '你好' });
    expect(parsed.seq).toBe(42);
  });

  it('WorkerEventPayload.type 受 WorkerEventType 枚举约束（编译期），枚举 9 事件点号命名', () => {
    expect(Object.values(WORKER_EVENT_TYPES)).toHaveLength(9);
    for (const name of Object.values(WORKER_EVENT_TYPES)) {
      expect(name.includes('_')).toBe(false);
    }
    const typed: WorkerEventPayload = {
      workerId: 'w_0000000001',
      eventId: 'evw_0000000001',
      type: WORKER_EVENT_TYPES.TASK_COMPLETED,
      payload: { taskId: 't_0000000001' },
      seq: 1,
    };
    expect(typed.type).toBe('task.completed');
    expect(WORKER_EVENT_TYPES.GIT_OP).toBe('git.op');
    expect(WORKER_EVENT_TYPES.SESSION_QUESTION).toBe('session.question');
    expect(WORKER_EVENT_TYPES.SESSION_PERMISSION).toBe('session.permission');
  });

  it('T4a：WorkerCommand 序列化/反序列化后字段完整（对齐心跳响应 commands）', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
      resourceVersion: 'v2',
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    expect(parsed.type).toBe('reload-config');
    expect(parsed.resourceVersion).toBe('v2');
  });

  it('C5：model-credentials 命令携带 payload（providerKeys + 可选 targetWorkerIds），round-trip 完整', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.MODEL_CREDENTIALS,
      resourceVersion: 'model-credentials',
      payload: {
        providerKeys: [
          { providerID: 'opencode-go', key: 'sk-a' },
          { providerID: 'opencode', key: 'sk-b' },
        ],
        targetWorkerIds: ['w_0000000001'],
      },
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    expect(parsed.type).toBe('model-credentials');
    expect(parsed.payload).toEqual({
      providerKeys: [
        { providerID: 'opencode-go', key: 'sk-a' },
        { providerID: 'opencode', key: 'sk-b' },
      ],
      targetWorkerIds: ['w_0000000001'],
    });
  });

  it('C5：model-credentials 命令 targetWorkerIds 缺省时 payload 不含该字段（全量语义）', () => {    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.MODEL_CREDENTIALS,
      resourceVersion: 'model-credentials',
      payload: { providerKeys: [{ providerID: 'opencode-go', key: 'sk-a' }] },
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    expect(parsed.type).toBe('model-credentials');
    const modelPayload = parsed.payload as ModelCredentialsPayload | undefined;
    expect(modelPayload?.providerKeys).toEqual([
      { providerID: 'opencode-go', key: 'sk-a' },
    ]);
    expect(modelPayload?.targetWorkerIds).toBeUndefined();
  });

  it('C8：model-credentials 的 providerConfigs 带 per-model 能力 → round-trip 字段完整（camelCase 内部形状）', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.MODEL_CREDENTIALS,
      resourceVersion: 'model-credentials',
      payload: {
        providerKeys: [{ providerID: 'qwen-27b', key: 'local-noop' }],
        providerConfigs: {
          'qwen-27b': {
            baseUrl: 'http://192.168.10.10:18020/v1',
            models: {
              'qwen3.8-27b': {
                name: 'Qwen3.8 27B',
                capabilities: {
                  limit: { context: 262144, output: 16384 },
                  reasoning: true,
                  toolCall: true,
                  modalities: { input: ['text', 'image'], output: ['text'] },
                  options: { reasoningEffort: 'high' },
                },
              },
            },
          },
        },
      },
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;
    const payload = parsed.payload as ModelCredentialsPayload | undefined;
    const entry = payload?.providerConfigs?.['qwen-27b'];
    const models = entry?.models as Record<
      string,
      { name?: string; capabilities?: { limit?: { context?: number }; options?: Record<string, unknown> } }
    >;

    expect(entry?.baseUrl).toBe('http://192.168.10.10:18020/v1');
    expect(models['qwen3.8-27b'].name).toBe('Qwen3.8 27B');
    expect(models['qwen3.8-27b'].capabilities?.limit?.context).toBe(262144);
    expect(models['qwen3.8-27b'].capabilities?.options).toEqual({
      reasoningEffort: 'high',
    });
  });

  it('git-credentials：命令携带 payload（credentials + 可选 targetWorkerIds），round-trip 完整', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.GIT_CREDENTIALS,
      resourceVersion: 'git-credentials',
      payload: {
        credentials: [
          {
            repoUrl: 'git@github.com:xishuhq/vteam.git',
            authType: 'ssh_key',
            key: '-----BEGIN OPENSSH PRIVATE KEY-----',
            fingerprint: 'sha256:abcd1234',
          },
          {
            repoUrl: 'https://github.com/xishuhq/tools.git',
            authType: 'https_token',
            key: 'ghp_secret',
            fingerprint: 'ghp_s****ret',
          },
        ],
        targetWorkerIds: ['w_0000000001'],
      },
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    expect(parsed.type).toBe('git-credentials');
    const gitPayload = parsed.payload as GitCredentialsPayload | undefined;
    expect(gitPayload?.credentials).toEqual([
      {
        repoUrl: 'git@github.com:xishuhq/vteam.git',
        authType: 'ssh_key',
        key: '-----BEGIN OPENSSH PRIVATE KEY-----',
        fingerprint: 'sha256:abcd1234',
      },
      {
        repoUrl: 'https://github.com/xishuhq/tools.git',
        authType: 'https_token',
        key: 'ghp_secret',
        fingerprint: 'ghp_s****ret',
      },
    ]);
    expect(gitPayload?.targetWorkerIds).toEqual(['w_0000000001']);
  });

  it('git-credentials：targetWorkerIds 缺省时 payload 不含该字段（全量语义）', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.GIT_CREDENTIALS,
      resourceVersion: 'git-credentials',
      payload: {
        credentials: [
          {
            repoUrl: 'https://github.com/xishuhq/tools.git',
            authType: 'https_token',
            key: 'ghp_secret',
            fingerprint: 'ghp_s****ret',
          },
        ],
      },
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    const gitPayload = parsed.payload as GitCredentialsPayload | undefined;
    expect(gitPayload?.credentials).toHaveLength(1);
    expect(gitPayload?.targetWorkerIds).toBeUndefined();
  });

  it('secret-command：请求体 round-trip 携带模板/secrets/cwd/timeout 与幂等归属字段', () => {
    const request: SecretCommandRequestPayload = {
      requestId: 'req_0000000001',
      taskId: 't_0000000001',
      sessionId: 'ses_0000000001',
      commandTemplate: 'mysql -h db -u root -p{{PASSWORD}} -e "select 1"',
      secrets: { PASSWORD: 's3cr3t-A9f' },
      cwd: 'repo',
      timeoutMs: 120000,
    };

    const parsed = JSON.parse(JSON.stringify(request)) as SecretCommandRequestPayload;

    expect(parsed.requestId).toBe('req_0000000001');
    expect(parsed.taskId).toBe('t_0000000001');
    expect(parsed.sessionId).toBe('ses_0000000001');
    expect(parsed.commandTemplate).toBe(
      'mysql -h db -u root -p{{PASSWORD}} -e "select 1"',
    );
    expect(parsed.secrets).toEqual({ PASSWORD: 's3cr3t-A9f' });
    expect(parsed.cwd).toBe('repo');
    expect(parsed.timeoutMs).toBe(120000);
  });

  it('secret-command：可选 cwd/timeoutMs/taskId/sessionId 缺省时不落进 wire（反序列化 undefined）', () => {
    const request: SecretCommandRequestPayload = {
      requestId: 'req_0000000002',
      commandTemplate: 'echo {{TOKEN}}',
      secrets: { TOKEN: 'tok' },
    };

    const parsed = JSON.parse(JSON.stringify(request)) as SecretCommandRequestPayload;

    expect(parsed.requestId).toBe('req_0000000002');
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.timeoutMs).toBeUndefined();
    expect(parsed.taskId).toBeUndefined();
    expect(parsed.sessionId).toBeUndefined();
  });

  it('secret-command：响应体 round-trip 含状态/exitCode/durationMs/双流截断 flag，且不含渲染命令', () => {
    const response: SecretCommandResponsePayload = {
      requestId: 'req_0000000001',
      status: 'failed',
      exitCode: 1,
      durationMs: 42,
      stdout: 'ok {{REDACTED}}',
      stderr: 'denied {{REDACTED}}',
      stdoutTruncated: false,
      stderrTruncated: true,
      error: 'failed to start command process',
    };

    const wire = JSON.stringify(response);
    const parsed = JSON.parse(wire) as SecretCommandResponsePayload;

    expect(parsed.requestId).toBe('req_0000000001');
    expect(parsed.status).toBe('failed');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.durationMs).toBe(42);
    expect(parsed.stdout).toBe('ok {{REDACTED}}');
    expect(parsed.stderr).toBe('denied {{REDACTED}}');
    expect(parsed.stdoutTruncated).toBe(false);
    expect(parsed.stderrTruncated).toBe(true);
    expect(parsed.error).toBe('failed to start command process');
    expect('commandTemplate' in parsed).toBe(false);
    expect('secrets' in parsed).toBe(false);
    expect('cwd' in parsed).toBe(false);
    expect('argv' in parsed).toBe(false);
    expect(wire).not.toContain('s3cr3t-A9f');
  });

  it('C5：reload-config 命令不携带 payload（向后兼容既有命令结构）', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
      resourceVersion: 'v2',
    };

    const parsed = JSON.parse(JSON.stringify(command)) as WorkerCommand;

    expect(parsed.type).toBe('reload-config');
    expect(parsed.payload).toBeUndefined();
  });
});

/**
 * T10 会话/模型端点的 worker 侧契约（计划 T10 / 决策 D3）。
 *
 * ⚠️ **只断言 worker 侧**：server 侧的同形状副本由 **T18** 落地
 * （`server/src/workers/` 一侧 + 改写 `worker.client.ts` 去调这五个端点）。
 * 本组断言覆盖 worker 侧形状的完整性与「可选字段缺省不落 wire」语义，
 * 等 T18 的 server 侧副本到位后，应再补一组**双端逐字段一致**的断言。
 */
describe('T10 会话/模型端点契约（worker 侧；server 侧副本见 T18）', () => {
  it('POST /sessions：请求体/响应体 round-trip 字段完整', () => {
    const request: CreateSessionRequestPayload = {
      model: { providerID: 'opencode', modelID: 'gpt-5' },
    };
    const response: CreateSessionResponsePayload = { sessionId: 'ses_0000000001' };

    expect(JSON.parse(JSON.stringify(request))).toEqual({
      model: { providerID: 'opencode', modelID: 'gpt-5' },
    });
    expect(JSON.parse(JSON.stringify(response))).toEqual({
      sessionId: 'ses_0000000001',
    });
  });

  it('POST /sessions：model 缺省时不落进 wire（反序列化 undefined）', () => {
    const request: CreateSessionRequestPayload = {};

    const parsed = JSON.parse(JSON.stringify(request)) as CreateSessionRequestPayload;

    expect(parsed.model).toBeUndefined();
  });

  it('POST /sessions/:id/prompt：请求体 round-trip 含 delivery/system/目录', () => {
    const request: SessionPromptRequestPayload = {
      prompt: '你好',
      model: { providerID: 'opencode', modelID: 'gpt-5' },
      agent: 'build',
      directory: '/work',
      system: 'SYS',
      delivery: 'queue',
    };

    const parsed = JSON.parse(JSON.stringify(request)) as SessionPromptRequestPayload;

    expect(parsed.prompt).toBe('你好');
    expect(parsed.model).toEqual({ providerID: 'opencode', modelID: 'gpt-5' });
    expect(parsed.agent).toBe('build');
    expect(parsed.directory).toBe('/work');
    expect(parsed.system).toBe('SYS');
    expect(parsed.delivery).toBe('queue');
  });

  it('POST /sessions/:id/prompt：响应体 round-trip 含收件条目 id + admitted（语义=已入队）', () => {
    const response: SessionPromptResponsePayload = {
      sessionId: 'ses_0000000001',
      messageId: 'inbox_0000000001',
      delivery: 'steer',
      admitted: true,
    };

    const parsed = JSON.parse(JSON.stringify(response)) as SessionPromptResponsePayload;

    expect(parsed.sessionId).toBe('ses_0000000001');
    expect(parsed.messageId).toBe('inbox_0000000001');
    expect(parsed.delivery).toBe('steer');
    expect(parsed.admitted).toBe(true);
    // 「已入队」≠「agent 已答复」：响应里不得出现完成类字段
    expect('completed' in parsed).toBe(false);
    expect('answered' in parsed).toBe(false);
  });

  it('POST /sessions/:id/prompt：驱动无回执时 messageId 缺省（不落进 wire）', () => {
    const response: SessionPromptResponsePayload = {
      sessionId: 'ses_0000000001',
      admitted: true,
    };

    const parsed = JSON.parse(JSON.stringify(response)) as SessionPromptResponsePayload;

    expect(parsed.messageId).toBeUndefined();
    expect(parsed.delivery).toBeUndefined();
  });

  it('POST /sessions/:id/abort：响应体 round-trip（interrupted=false 是幂等成功）', () => {
    const response: SessionAbortResponsePayload = {
      sessionId: 'ses_0000000001',
      interrupted: false,
    };

    const parsed = JSON.parse(JSON.stringify(response)) as SessionAbortResponsePayload;

    expect(parsed.sessionId).toBe('ses_0000000001');
    expect(parsed.interrupted).toBe(false);
  });

  it('GET /sessions/:id/messages：分页 query round-trip（limit/order/cursor）', () => {
    const query: SessionMessagesQuery = { limit: 20, order: 'desc', cursor: 'cur_1' };

    const parsed = JSON.parse(JSON.stringify(query)) as SessionMessagesQuery;

    expect(parsed.limit).toBe(20);
    expect(parsed.order).toBe('desc');
    expect(parsed.cursor).toBe('cur_1');
  });

  it('GET /sessions/:id/messages：响应体 round-trip 含 vteam 渲染模型形状的消息', () => {
    const response: SessionMessagesResponsePayload = {
      sessionId: 'ses_0000000001',
      messages: [
        {
          info: { id: 'msg_1', role: 'assistant', providerID: 'opencode', modelID: 'gpt-5' },
          parts: [{ id: 'prt_1', type: 'text', text: '你好' }],
        },
      ],
    };

    const parsed = JSON.parse(JSON.stringify(response)) as SessionMessagesResponsePayload;

    expect(parsed.sessionId).toBe('ses_0000000001');
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].info.id).toBe('msg_1');
    expect(parsed.messages[0].info.role).toBe('assistant');
    expect(parsed.messages[0].parts[0]).toEqual({ id: 'prt_1', type: 'text', text: '你好' });
  });

  it('GET /models：模型目录项 round-trip，且**不是**被驱动端的 {location,data} 包装', () => {
    const models: WorkerModelInfo[] = [
      {
        id: 'opencode/gpt-5',
        name: 'GPT-5',
        providerID: 'opencode',
        modelID: 'gpt-5',
        status: 'active',
      },
    ];

    const parsed = JSON.parse(JSON.stringify(models)) as WorkerModelInfo[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('opencode/gpt-5');
    expect(parsed[0].providerID).toBe('opencode');
    expect(parsed[0].modelID).toBe('gpt-5');
    expect(parsed[0].status).toBe('active');
    expect('location' in parsed[0]).toBe(false);
    expect('data' in parsed[0]).toBe(false);
  });
});

/* ============================================================================
 * T21 双端契约一致性（worker 侧副本 ↔ server 侧副本）
 * ============================================================================
 *
 * 背景：五个会话/模型端点的协议类型在仓库里是**双写**的——
 * - worker 侧：`worker/src/protocol/worker-protocol.ts`（本文件 import 的那一份）
 * - server 侧：`server/src/workers/worker-session-protocol.ts`（T18 落地）
 *
 * 双写的固有风险是**形状漂移**（字段名/可选性/类型任一不一致）：控制面按自己的那份
 * 读字段，读不到就是**静默丢字段**（例如 `sessionId` 拼成 `sessionID` ⇒ 会话 id 丢失）。
 * 之前**没有任何断言**说这两份必须一致——本组补上这一条。
 *
 * 三层断言：
 * 1. **源码级逐字段对照**（本组第 1 个用例）：用 TS 编译器 API 抽出两侧每个 interface
 *    的成员（**成员名 + 是否可选 + 类型文本**），逐项相等。
 *    ⚠️ 为什么不用「类型相等」断言：server 包的 tsconfig 是 `strictNullChecks: false`
 *    ⇒ 可选性差异（`model?` vs `model`）在类型层**看不出来**（`undefined` 到处可赋）。
 *    源码级对照是唯一能把**可选性**也钉死的手段。
 * 2. **编译期键集/可选性**（本组第 2 个用例）：本文件的 manifest 与 worker 侧类型
 *    逐键对齐（键名 + 必填/可选），manifest 漂了 → tsc 报错。
 * 3. **运行时对称**（本组第 3 个 describe）：起**真实的** ExecServer，
 *    断言「server 发的 body 键 == worker 解析后交给驱动的键」、
 *    「worker 回的 body 键 == server 读的键」。
 */

/** 双写副本的形状对照清单（两侧都必须声明同名 interface）。 */
const PROTOCOL_SHAPE_NAMES = [
  'WorkerModelRef',
  'WorkerModelInfo',
  'WorkerModelsResponsePayload',
  'CreateSessionRequestPayload',
  'CreateSessionResponsePayload',
  'SessionPromptRequestPayload',
  'SessionPromptResponsePayload',
  'SessionAbortResponsePayload',
  'SessionTokenUsage',
  'SessionMessageContent',
  'SessionMessageInfo',
  'SessionMessage',
  'SessionMessagesQuery',
  'SessionMessagesResponsePayload',
] as const;

const WORKER_PROTOCOL_FILE = path.join(__dirname, 'worker-protocol.ts');
const SERVER_PROTOCOL_FILE = path.join(
  __dirname,
  '../../../server/src/workers/worker-session-protocol.ts',
);

/** interface 成员形状：成员名 + 是否可选 + 类型文本（归一化空白）。 */
interface ProtocolMember {
  name: string;
  optional: boolean;
  type: string;
}

/**
 * 抽出一个 .ts 文件里指定 interface 的成员列表（源码级，不依赖类型系统）。
 *
 * ⚠️ 为什么不 import 两侧类型再比类型：server 包 `strictNullChecks: false`
 * ⇒ 可选性差异在类型层不可见（见本组注释）。源码级抽取能看见 `?`。
 */
function readInterfaceMembers(file: string): Map<string, ProtocolMember[]> {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const result = new Map<string, ProtocolMember[]>();
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) {
      continue;
    }
    const members: ProtocolMember[] = statement.members.map((member) => {
      const name =
        member.name && ts.isIdentifier(member.name)
          ? member.name.text
          : member.getText(source);
      const typeNode =
        'type' in member && member.type ? (member.type as ts.TypeNode) : undefined;
      return {
        name,
        optional: member.questionToken !== undefined,
        type: typeNode
          ? typeNode.getText(source).replace(/\s+/g, ' ').trim()
          : '',
      };
    });
    result.set(statement.name.text, members);
  }
  return result;
}

/** 键集（编译期）：`keyof T` 的可枚举成员（不含 index signature）。 */
type KeySet<T> = Extract<keyof T, string>;
/** 可选键集（编译期）：`T[K]` 允许 undefined 的键。 */
type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];
/** 必填键集（编译期）。 */
type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

/** 编译期断言：两个键集必须完全相等（否则该行 tsc 报错）。 */
type Expect<T extends true> = T;
/** 编译期断言：两个键集必须完全相等。 */
type SameKeys<A, B> = [KeySet<A>] extends [KeySet<B>]
  ? [KeySet<B>] extends [KeySet<A>]
    ? true
    : false
  : false;

/** 协议形状 manifest（键名 + 可选性）——两侧副本与运行时 wire 的**唯一口径**。 */
const PROTOCOL_MANIFEST = {
  WorkerModelRef: { required: ['providerID', 'modelID'], optional: [] },
  WorkerModelInfo: {
    required: ['id', 'name', 'providerID', 'modelID'],
    optional: ['status'],
  },
  WorkerModelsResponsePayload: { required: ['models'], optional: [] },
  CreateSessionRequestPayload: { required: [], optional: ['model'] },
  CreateSessionResponsePayload: { required: ['sessionId'], optional: [] },
  SessionPromptRequestPayload: {
    required: ['prompt'],
    optional: ['model', 'agent', 'directory', 'system', 'delivery'],
  },
  SessionPromptResponsePayload: {
    required: ['sessionId', 'admitted'],
    optional: ['messageId', 'delivery'],
  },
  SessionAbortResponsePayload: {
    required: ['sessionId', 'interrupted'],
    optional: [],
  },
  SessionMessagesQuery: {
    required: [],
    optional: ['limit', 'order', 'cursor'],
  },
  SessionMessagesResponsePayload: {
    required: ['sessionId', 'messages'],
    optional: [],
  },
} as const;

/* 编译期：manifest 的键集必须与 worker 侧类型逐键对齐（键名 + 必填/可选）。 */
type _M1 = Expect<
  SameKeys<
    CreateSessionRequestPayload,
    {
      model?: WorkerModelRef | null;
    }
  >
>;
type _M2 = Expect<
  SameKeys<
    CreateSessionResponsePayload,
    {
      sessionId: string;
    }
  >
>;
type _M3 = Expect<
  SameKeys<
    SessionPromptRequestPayload,
    {
      prompt: string | unknown[];
      model?: WorkerModelRef | null;
      agent?: string;
      directory?: string;
      system?: string;
      delivery?: WorkerDeliveryMode;
    }
  >
>;
type _M4 = Expect<
  SameKeys<
    SessionPromptResponsePayload,
    {
      sessionId: string;
      messageId?: string;
      delivery?: WorkerDeliveryMode;
      admitted: boolean;
    }
  >
>;
type _M5 = Expect<
  SameKeys<
    SessionAbortResponsePayload,
    {
      sessionId: string;
      interrupted: boolean;
    }
  >
>;
type _M6 = Expect<
  SameKeys<
    SessionMessagesQuery,
    {
      limit?: number;
      order?: 'asc' | 'desc';
      cursor?: string;
    }
  >
>;
type _M7 = Expect<
  SameKeys<
    SessionMessagesResponsePayload,
    {
      sessionId: string;
      messages: SessionMessage[];
    }
  >
>;
type _M8 = Expect<
  SameKeys<
    WorkerModelInfo,
    {
      id: string;
      name: string;
      providerID: string;
      modelID: string;
      status?: string;
    }
  >
>;
type _M9 = Expect<
  SameKeys<
    WorkerModelRef,
    {
      providerID: string;
      modelID: string;
    }
  >
>;
type _M10 = Expect<
  SameKeys<
    WorkerModelsResponsePayload,
    {
      models: WorkerModelInfo[];
    }
  >
>;
/* 编译期：可选键集必须与 manifest 一致（`model?` 变成必填 = 契约漂移）。 */
type _O1 = Expect<
  [OptionalKeys<CreateSessionRequestPayload>] extends ['model'] ? true : false
>;
type _O2 = Expect<
  [OptionalKeys<SessionPromptRequestPayload>] extends [
    'model' | 'agent' | 'directory' | 'system' | 'delivery',
  ]
    ? true
    : false
>;
type _O3 = Expect<
  [OptionalKeys<SessionPromptResponsePayload>] extends ['messageId' | 'delivery']
    ? true
    : false
>;
type _O4 = Expect<
  [OptionalKeys<SessionMessagesQuery>] extends ['limit' | 'order' | 'cursor']
    ? true
    : false
>;
type _O5 = Expect<
  [RequiredKeys<SessionPromptRequestPayload>] extends ['prompt'] ? true : false
>;
type _O6 = Expect<
  [RequiredKeys<SessionPromptResponsePayload>] extends [
    'sessionId' | 'admitted',
  ]
    ? true
    : false
>;

describe('T21 双端契约一致性（worker 侧副本 ↔ server 侧副本）', () => {
  it('两份副本逐字段一致：同名 interface 的成员名/可选性/类型逐项相等', () => {
    const worker = readInterfaceMembers(WORKER_PROTOCOL_FILE);
    const server = readInterfaceMembers(SERVER_PROTOCOL_FILE);

    for (const name of PROTOCOL_SHAPE_NAMES) {
      const workerMembers = worker.get(name);
      const serverMembers = server.get(name);
      expect(workerMembers).toBeDefined();
      expect(serverMembers).toBeDefined();
      // 逐成员对照：成员名 + 是否可选 + 类型文本（任一不同即失败，差异直接显示在断言里）
      expect(serverMembers).toEqual(workerMembers);
    }
  });

  it('两份副本的成员数一致（防止一侧多出成员而被上面的逐项对照漏看）', () => {
    const worker = readInterfaceMembers(WORKER_PROTOCOL_FILE);
    const server = readInterfaceMembers(SERVER_PROTOCOL_FILE);
    for (const name of PROTOCOL_SHAPE_NAMES) {
      expect(server.get(name)?.length).toBe(worker.get(name)?.length);
    }
  });

  it('manifest 与两侧副本的键集/可选性一致（编译期断言 + 运行时复核）', () => {
    const worker = readInterfaceMembers(WORKER_PROTOCOL_FILE);
    const server = readInterfaceMembers(SERVER_PROTOCOL_FILE);
    for (const [name, shape] of Object.entries(PROTOCOL_MANIFEST)) {
      const expected = [
        ...shape.required.map((key) => ({ name: key, optional: false })),
        ...shape.optional.map((key) => ({ name: key, optional: true })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      for (const source of [worker, server]) {
        const members = source.get(name);
        expect(members).toBeDefined();
        expect(
          members!.map((m) => ({ name: m.name, optional: m.optional })).sort(
            (a, b) => a.name.localeCompare(b.name),
          ),
        ).toEqual(expected);
      }
    }
  });

  describe('运行时对称（worker 解析/回执 ↔ server 发送/读取）', () => {
    const WORKER_TOKEN = 'tok-t21';
    const SILENT_LOGGER = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    /** mock 驱动：记录被调用的参数。 */
    function mockDriver(): {
      driver: OpenCodeDriver;
      createSession: jest.Mock;
      sendMessage: jest.Mock;
      getMessages: jest.Mock;
      abort: jest.Mock;
      listModels: jest.Mock;
    } {
      const createSession = jest.fn().mockResolvedValue('ses_t21');
      const sendMessage = jest
        .fn()
        .mockResolvedValue({ messageId: 'inbox_t21', delivery: 'steer' });
      const getMessages = jest.fn().mockResolvedValue([]);
      const abort = jest.fn().mockResolvedValue({ interrupted: true });
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

    /** 起一个真实的 ExecServer（port 0 = 随机）。 */
    async function startExec(driver: OpenCodeDriver): Promise<{
      port: number;
      stop: () => Promise<void>;
    }> {
      const sender = new EventSender({
        serverUrl: 'http://server:3000',
        workerId: 'w_t21',
        workerToken: WORKER_TOKEN,
        startSeq: 0,
        bootId: 'boot',
        maxRetries: 0,
        fetchImpl: (async () =>
          ({
            ok: true,
            status: 202,
            statusText: 'Accepted',
          }) as Response) as typeof fetch,
      });
      const exec = new ExecServer({
        port: 0,
        driver,
        sender,
        workerToken: WORKER_TOKEN,
        logger: SILENT_LOGGER,
      });
      const port = await exec.start();
      return { port, stop: () => exec.stop() };
    }

    /** 发一个请求（带 X-Worker-Token）。 */
    function request(
      port: number,
      method: string,
      requestPath: string,
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          'X-Worker-Token': WORKER_TOKEN,
        };
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
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(chunks || '{}') as Record<string, unknown>,
              }),
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

    it('POST /sessions/:id/prompt：server 发的 6 个键被 worker 逐键解析并透传给驱动', async () => {
      const { driver, sendMessage } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        // 形状 = server 侧 `promptSession` 实际发送的 body（键集见 worker.client.ts）
        const serverBody = {
          prompt: '你好',
          model: { providerID: 'opencode', modelID: 'gpt-5' },
          agent: 'build',
          directory: '/work',
          system: 'SYS',
          delivery: 'steer',
        };
        const res = await request(port, 'POST', '/sessions/ses_t21/prompt', serverBody);
        expect(res.status).toBe(200);
        // worker 解析出的键 → 驱动入参（parts 是 worker 内部的归一，不是 wire 键）
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const call = sendMessage.mock.calls[0][1] as {
          model: unknown;
          agent: unknown;
          parts: unknown;
          directory: unknown;
          system: unknown;
          delivery: unknown;
        };
        expect(call.model).toEqual({ providerID: 'opencode', modelID: 'gpt-5' });
        expect(call.agent).toBe('build');
        expect(call.directory).toBe('/work');
        expect(call.system).toBe('SYS');
        expect(call.delivery).toBe('steer');
        expect(call.parts).toEqual([{ type: 'text', text: '你好' }]);
        // 响应键 = server 侧读的键（sessionId / messageId / delivery / admitted）
        expect(Object.keys(res.body).sort()).toEqual([
          'admitted',
          'delivery',
          'messageId',
          'sessionId',
        ]);
        expect(res.body.admitted).toBe(true);
        expect(res.body.delivery).toBe('steer');
        expect(res.body.messageId).toBe('inbox_t21');
      } finally {
        await stop();
      }
    });

    it('POST /sessions/:id/prompt：驱动不回执时响应只有 sessionId + admitted（可选键不落 wire）', async () => {
      const { driver, sendMessage } = mockDriver();
      sendMessage.mockResolvedValue({});
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_t21/prompt', {
          prompt: 'x',
        });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['admitted', 'sessionId']);
      } finally {
        await stop();
      }
    });

    it('POST /sessions：请求体只认 model；响应只回 sessionId', async () => {
      const { driver, createSession } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions', {
          model: { providerID: 'opencode', modelID: 'gpt-5' },
        });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(['sessionId']);
        expect(createSession).toHaveBeenCalledWith({
          providerID: 'opencode',
          modelID: 'gpt-5',
        });
      } finally {
        await stop();
      }
    });

    it('POST /sessions/:id/abort：响应只有 sessionId + interrupted 两个键', async () => {
      const { driver, abort } = mockDriver();
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(port, 'POST', '/sessions/ses_t21/abort');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['interrupted', 'sessionId']);
        expect(res.body.interrupted).toBe(true);
        expect(abort).toHaveBeenCalledWith('ses_t21');
      } finally {
        await stop();
      }
    });

    it('GET /sessions/:id/messages：limit/order/cursor 三键透传；响应只有 sessionId + messages', async () => {
      const { driver, getMessages } = mockDriver();
      const messages: DriverMessage[] = [
        {
          info: { id: 'msg_1', role: 'assistant' },
          parts: [{ id: 'prt_1', type: 'text', text: '你好' }],
        },
      ];
      getMessages.mockResolvedValue(messages);
      const { port, stop } = await startExec(driver);
      try {
        const res = await request(
          port,
          'GET',
          '/sessions/ses_t21/messages?limit=20&order=asc&cursor=cur_1',
        );
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['messages', 'sessionId']);
        expect(getMessages).toHaveBeenCalledWith('ses_t21', {
          limit: 20,
          order: 'asc',
          cursor: 'cur_1',
        });
      } finally {
        await stop();
      }
    });

    it('GET /models：响应信封只有 models 一个键（信封已是双写类型 → 静态对照 + 运行时复核）', async () => {
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
        const res = await request(port, 'GET', '/models');
        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(['models']);
        expect(res.body.models).toEqual(models);
      } finally {
        await stop();
      }
    });
  });
});

/* ============================================================================
 * MCP 状态线契约的双写一致性（worker 侧类型别名 ↔ server 侧 @IsIn 取值集合）
 * ============================================================================
 *
 * v2 的 `/api/mcp` 有**五个**状态（connected / failed / needs_auth / pending / disabled）。
 * `pending`（还在连接中）与 `disabled`（已配置但停用）在旧三态里**无法忠实表达**
 * ⇒ 线契约**两端同时**扩到五态。
 *
 * ⚠️ 两端**必须同步**：server 的 `@IsIn` 只认三值时，worker 发出的五态心跳会被
 * **400 拒收**（整个心跳失败 → worker 被判离线）。本组断言把这条双写契约钉死：
 * 任一侧单独改 ⇒ 本用例失败。
 */

/** server 侧 MCP 状态 DTO（`@IsIn` 的取值集合来源）。 */
const SERVER_MCP_STATUS_FILE = path.join(
  __dirname,
  '../../../server/src/mcp-servers/dto/mcp-status.dto.ts',
);

/** worker 侧探针的状态类型别名（第三份副本）。 */
const WORKER_MCP_PROBE_FILE = path.join(__dirname, '../mcp-status/mcp-status-probe.ts');

/** 抽出一个字符串字面量联合类型别名的成员（源码级）。 */
function readStringUnionMembers(file: string, typeName: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName) {
      const members: string[] = [];
      const visit = (node: ts.TypeNode): void => {
        if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
          members.push(node.literal.text);
        } else if (ts.isUnionTypeNode(node)) {
          node.types.forEach(visit);
        }
      };
      visit(statement.type);
      return members;
    }
  }
  return [];
}

/** 抽出一个 `as const` 对象常量的字符串值（源码级）。 */
function readConstObjectValues(file: string, constName: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const decl of statement.declarationList.declarations) {
      if (decl.name.getText(source) !== constName || !decl.initializer) {
        continue;
      }
      // `as const` 会把对象字面量包进 AsExpression —— 先剥掉再取属性。
      const initializer = ts.isAsExpression(decl.initializer)
        ? decl.initializer.expression
        : decl.initializer;
      if (!ts.isObjectLiteralExpression(initializer)) {
        return [];
      }
      return initializer.properties
        .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
        .map((p) => (p.initializer as ts.StringLiteral).text);
    }
  }
  return [];
}

describe('MCP 状态线契约双写一致性（worker ↔ server）', () => {
  it('worker 的 McpServerStatus 取值集合 == server 的 MCP_STATUS 取值集合（v2 五态）', () => {
    const worker = readStringUnionMembers(WORKER_PROTOCOL_FILE, 'McpServerStatus').sort();
    const server = readConstObjectValues(SERVER_MCP_STATUS_FILE, 'MCP_STATUS').sort();

    expect(worker).toEqual(['connected', 'disabled', 'failed', 'needs_auth', 'pending']);
    expect(server).toEqual(worker);
  });

  it('探针侧的 McpStatus 也与线契约同值（第三份副本不许漂）', () => {
    const protocol = readStringUnionMembers(WORKER_PROTOCOL_FILE, 'McpServerStatus').sort();
    const probe = readStringUnionMembers(WORKER_MCP_PROBE_FILE, 'McpStatus').sort();

    expect(probe).toEqual(protocol);
  });
});
