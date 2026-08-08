import { EVENT_TYPES } from '../../common/constants/event.constants';
import { HeartbeatWorkerDto } from './heartbeat-worker.dto';
import { RegisterWorkerDto } from './register-worker.dto';
import { WORKER_EVENT_TYPES, WorkerEventDto } from './worker-event.dto';

/**
 * worker 协议 DTO 契约测试（T1 契约基座，server 侧视角）。
 * 双端 JSON 互通由 worker/src/protocol/contract.spec.ts 守护；此处验证
 * server DTO 序列化结构完整 + worker 协议事件枚举与 server 前端事件字典对齐。
 */
describe('workers 协议 DTO（T1 契约基座）', () => {
  it('RegisterWorkerDto 序列化后字段完整（workerId/name/opencodeVersion/capabilities/load）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.name = 'worker-1';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 2, skills: ['coding'], tools: ['git'] };
    dto.load = { instances: 1 };

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      workerId: 'w_0000000001',
      name: 'worker-1',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 2, skills: ['coding'], tools: ['git'] },
      load: { instances: 1 },
    });
  });

  it('RegisterWorkerDto 允许 name 省略（可选字段反序列化为 undefined 不丢键）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000002';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 1, skills: [], tools: [] };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.workerId).toBe('w_0000000002');
    expect(wire.name).toBeUndefined();
    expect(wire.capabilities).toEqual({ maxInstances: 1, skills: [], tools: [] });
  });

  it('WorkerCapabilitiesDto 支持可选 port（F2 C2：随机端口上报，whitelist 不剔除）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000003';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 1, skills: [], tools: [], port: 53001 };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.capabilities).toEqual({ maxInstances: 1, skills: [], tools: [], port: 53001 });
  });

  it('WorkerCapabilitiesDto 支持可选 baseUrl（D2：容器内 http://worker:port 上报，whitelist 不剔除）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000004';
    dto.opencodeVersion = '1.18.15';
    dto.capabilities = {
      maxInstances: 1,
      skills: [],
      tools: [],
      port: 53001,
      baseUrl: 'http://worker:53001',
    };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.capabilities).toEqual({
      maxInstances: 1,
      skills: [],
      tools: [],
      port: 53001,
      baseUrl: 'http://worker:53001',
    });
  });

  it('C2：WorkerCapabilitiesDto 支持可选 models（真实模型 id 列表，whitelist 不剔除）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000005';
    dto.opencodeVersion = '1.18.15';
    dto.capabilities = {
      maxInstances: 1,
      skills: [],
      tools: [],
      models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
    };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.capabilities).toEqual({
      maxInstances: 1,
      skills: [],
      tools: [],
      models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
    });
  });

  it('C2：RegisterWorkerDto 支持可选 defaultModelId（配置 WORKER_DEFAULT_MODEL 上报）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000006';
    dto.opencodeVersion = '1.18.15';
    dto.capabilities = { maxInstances: 1, skills: [], tools: [] };
    dto.load = { instances: 0 };
    dto.defaultModelId = 'opencode-go/deepseek-v4-flash';

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
  });

  it('C2：RegisterWorkerDto 未设 defaultModelId 时序列化不丢键（兼容旧 worker）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000007';
    dto.opencodeVersion = '1.18.15';
    dto.capabilities = { maxInstances: 1, skills: [], tools: [] };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.defaultModelId).toBeUndefined();
  });

  it('HeartbeatWorkerDto 序列化后字段完整（workerId/load/health）', () => {
    const dto = new HeartbeatWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.load = { instances: 1 };
    dto.health = 'degraded';

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      workerId: 'w_0000000001',
      load: { instances: 1 },
      health: 'degraded',
    });
  });

  it('T8c：HeartbeatWorkerDto 可选 mcpStatus（三态快照序列化完整）', () => {
    const dto = new HeartbeatWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.load = { instances: 1 };
    dto.health = 'ok';
    dto.mcpStatus = [
      { serverName: 'gitee-ent', status: 'connected' },
      { serverName: 'github-remote', status: 'needs_auth' },
      { serverName: 'test-bad-local', status: 'failed' },
    ];

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      workerId: 'w_0000000001',
      load: { instances: 1 },
      health: 'ok',
      mcpStatus: [
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'github-remote', status: 'needs_auth' },
        { serverName: 'test-bad-local', status: 'failed' },
      ],
    });
  });

  it('T8c：HeartbeatWorkerDto 未设 mcpStatus 时序列化不丢键（兼容旧 worker）', () => {
    const dto = new HeartbeatWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.load = { instances: 0 };
    dto.health = 'ok';

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.mcpStatus).toBeUndefined();
  });

  it('WorkerEventDto 序列化后字段完整（workerId/eventId/type/payload/seq）', () => {
    const dto = new WorkerEventDto();
    dto.workerId = 'w_0000000001';
    dto.eventId = 'evw_0000000042';
    dto.type = 'message.part.delta';
    dto.payload = { sessionId: 's_0000000001', text: '你好' };
    dto.seq = 42;

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      workerId: 'w_0000000001',
      eventId: 'evw_0000000042',
      type: 'message.part.delta',
      payload: { sessionId: 's_0000000001', text: '你好' },
      seq: 42,
    });
  });

  it('WORKER_EVENT_TYPES 7 事件点号命名（无下划线变体）', () => {
    expect(Object.values(WORKER_EVENT_TYPES)).toHaveLength(7);
    for (const name of Object.values(WORKER_EVENT_TYPES)) {
      expect(name.includes('_')).toBe(false);
    }
    expect(WORKER_EVENT_TYPES.GIT_OP).toBe('git.op');
  });

  it('worker 协议事件与 server EVENT_TYPES 同名事件值对齐', () => {
    expect(WORKER_EVENT_TYPES.HEARTBEAT).toBe(EVENT_TYPES.WORKER_HEARTBEAT);
    expect(WORKER_EVENT_TYPES.SESSION_UPDATED).toBe(EVENT_TYPES.SESSION_UPDATED);
    expect(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA).toBe(EVENT_TYPES.MESSAGE_PART_DELTA);
    expect(WORKER_EVENT_TYPES.TASK_COMPLETED).toBe(EVENT_TYPES.TASK_COMPLETED);
    expect(WORKER_EVENT_TYPES.AGENT_STATUS).toBe(EVENT_TYPES.AGENT_STATUS);
  });
});
