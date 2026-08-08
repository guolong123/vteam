import {
  WORKER_EVENT_TYPES,
  WorkerEventPayload,
  HeartbeatWorkerPayload,
  RegisterWorkerPayload,
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

  it('WorkerEventPayload.type 受 WorkerEventType 枚举约束（编译期），枚举 6 事件点号命名', () => {
    expect(Object.values(WORKER_EVENT_TYPES)).toHaveLength(6);
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
  });
});
