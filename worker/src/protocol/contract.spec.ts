import {
  WORKER_EVENT_TYPES,
  WorkerEventPayload,
  HeartbeatWorkerPayload,
  RegisterWorkerPayload,
  WORKER_COMMAND_TYPES,
  WorkerCommand,
  ModelCredentialsPayload,
  GitCredentialsPayload,
} from './worker-protocol';

/**
 * worker 协议契约测试（T1 契约基座）。
 * 模拟双端 JSON 互通：worker 侧类型构造完整对象 → JSON.stringify → JSON.parse
 * 反序列化后可完整读取（server 侧 DTO 反序列化同路径）。断言字段结构完整、
 * 事件 type 枚举点号命名、可选字段缺省语义。
 */
describe('worker 协议契约（T1 双端 JSON 互通）', () => {
  it('RegisterWorkerPayload 序列化/反序列化后字段完整（对齐 POST /workers/register）', () => {
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

  it('WorkerEventPayload.type 受 WorkerEventType 枚举约束（编译期），枚举 7 事件点号命名', () => {
    expect(Object.values(WORKER_EVENT_TYPES)).toHaveLength(7);
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

  it('C5：model-credentials 命令 targetWorkerIds 缺省时 payload 不含该字段（全量语义）', () => {
    const command: WorkerCommand = {
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

  it('git-credentials：命令携带 payload（credentials + 可选 targetWorkerIds），round-trip 完整', () => {
    const command: WorkerCommand = {
      type: WORKER_COMMAND_TYPES.GIT_CREDENTIALS,
      resourceVersion: 'git-credentials',
      payload: {
        credentials: [
          {
            repoUrl: 'git@github.com:xishuhq/aiagents.git',
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
        repoUrl: 'git@github.com:xishuhq/aiagents.git',
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
