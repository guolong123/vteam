import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EVENT_TYPES } from '../../common/constants/event.constants';
import { HeartbeatWorkerDto } from './heartbeat-worker.dto';
import { RegisterWorkerDto } from './register-worker.dto';
import { WORKER_EVENT_TYPES, WorkerEventDto } from './worker-event.dto';
import { WORKER_UPDATE_STATES } from '../worker-update-state';

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
    expect(wire.capabilities).toEqual({
      maxInstances: 1,
      skills: [],
      tools: [],
    });
  });

  it('WorkerCapabilitiesDto 支持可选 port（F2 C2：随机端口上报，whitelist 不剔除）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000003';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 1, skills: [], tools: [], port: 53001 };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.capabilities).toEqual({
      maxInstances: 1,
      skills: [],
      tools: [],
      port: 53001,
    });
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

  it('T10：WorkerCapabilitiesDto 支持可选 execPort（执行端点端口上报，whitelist 不剔除）', () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000008';
    dto.opencodeVersion = '1.18.15';
    dto.capabilities = {
      maxInstances: 1,
      skills: [],
      tools: [],
      port: 53001,
      execPort: 4198,
    };
    dto.load = { instances: 0 };

    const wire = JSON.parse(JSON.stringify(dto));
    expect(wire.capabilities).toEqual({
      maxInstances: 1,
      skills: [],
      tools: [],
      port: 53001,
      execPort: 4198,
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

  // worker-self-update Todo 2：codeVersion 是**加法可选**字段——旧 worker 不携带时
  // 序列化结果必须与加字段之前逐键相同（否则旧 worker 的报文本身会变形）。
  describe('codeVersion（worker-self-update Todo 2：可选，旧 worker 缺席不炸）', () => {
    const registerBase = () => {
      const dto = new RegisterWorkerDto();
      dto.workerId = 'w_0000000001';
      dto.opencodeVersion = '1.18.14';
      dto.capabilities = { maxInstances: 1, skills: [], tools: [] };
      dto.load = { instances: 0 };
      return dto;
    };

    const heartbeatBase = () => {
      const dto = new HeartbeatWorkerDto();
      dto.workerId = 'w_0000000001';
      dto.load = { instances: 0 };
      dto.health = 'ok';
      return dto;
    };

    it('RegisterWorkerDto 携带 codeVersion 时序列化出去（短 SHA 原样）', () => {
      const dto = registerBase();
      dto.codeVersion = 'abc1234';

      const wire = JSON.parse(JSON.stringify(dto));
      expect(wire.codeVersion).toBe('abc1234');
    });

    it('RegisterWorkerDto 未携带时序列化不产生 codeVersion 键（旧载荷逐字兼容）', () => {
      const wire = JSON.parse(JSON.stringify(registerBase()));
      expect('codeVersion' in wire).toBe(false);
      expect(wire).toEqual({
        workerId: 'w_0000000001',
        opencodeVersion: '1.18.14',
        capabilities: { maxInstances: 1, skills: [], tools: [] },
        load: { instances: 0 },
      });
    });

    it('HeartbeatWorkerDto 携带 codeVersion 时序列化出去', () => {
      const dto = heartbeatBase();
      dto.codeVersion = 'manual-20261010';

      expect(JSON.parse(JSON.stringify(dto)).codeVersion).toBe(
        'manual-20261010',
      );
    });

    it('HeartbeatWorkerDto 未携带时不产生 codeVersion 键（旧心跳载荷逐字兼容）', () => {
      const wire = JSON.parse(JSON.stringify(heartbeatBase()));
      expect('codeVersion' in wire).toBe(false);
      expect(wire).toEqual({
        workerId: 'w_0000000001',
        load: { instances: 0 },
        health: 'ok',
      });
    });

    it('codeVersion 非字符串 → 校验失败（@IsString），不静默落脏值', async () => {
      const errors = await validate(
        plainToInstance(RegisterWorkerDto, {
          workerId: 'w_0000000001',
          opencodeVersion: '1.18.14',
          capabilities: { maxInstances: 1, skills: [], tools: [] },
          load: { instances: 0 },
          codeVersion: 123,
        }),
      );
      expect(errors.some((e) => e.property === 'codeVersion')).toBe(true);
    });

    it('codeVersion 为字符串 → 校验通过（旧 worker 路径与新 worker 路径同规则）', async () => {
      const errors = await validate(
        plainToInstance(HeartbeatWorkerDto, {
          workerId: 'w_0000000001',
          load: { instances: 0 },
          health: 'ok',
          codeVersion: 'abc1234',
        }),
      );
      expect(errors).toHaveLength(0);
    });
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

  it('WORKER_EVENT_TYPES 9 事件点号命名（无下划线变体）', () => {
    expect(Object.values(WORKER_EVENT_TYPES)).toHaveLength(9);
    for (const name of Object.values(WORKER_EVENT_TYPES)) {
      expect(name.includes('_')).toBe(false);
    }
    expect(WORKER_EVENT_TYPES.GIT_OP).toBe('git.op');
    expect(WORKER_EVENT_TYPES.SESSION_QUESTION).toBe('session.question');
    expect(WORKER_EVENT_TYPES.SESSION_PERMISSION).toBe('session.permission');
  });

  it('worker 协议事件与 server EVENT_TYPES 同名事件值对齐', () => {
    expect(WORKER_EVENT_TYPES.HEARTBEAT).toBe(EVENT_TYPES.WORKER_HEARTBEAT);
    expect(WORKER_EVENT_TYPES.SESSION_UPDATED).toBe(
      EVENT_TYPES.SESSION_UPDATED,
    );
    expect(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA).toBe(
      EVENT_TYPES.MESSAGE_PART_DELTA,
    );
    expect(WORKER_EVENT_TYPES.TASK_COMPLETED).toBe(EVENT_TYPES.TASK_COMPLETED);
    expect(WORKER_EVENT_TYPES.AGENT_STATUS).toBe(EVENT_TYPES.AGENT_STATUS);
  });

  describe('RegisterWorkerDto 必填校验（QA ISSUE-010 缺 capabilities 500）', () => {
    const errorsOf = async (obj: object) =>
      validate(plainToInstance(RegisterWorkerDto, obj));

    const base = {
      workerId: 'w_0000000001',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
    };

    it('缺 capabilities → 校验失败（@IsNotEmpty，400 非 500）', async () => {
      const { capabilities, ...rest } = base;
      expect(await errorsOf(rest)).not.toHaveLength(0);
    });

    it('缺 load → 校验失败（@IsNotEmpty）', async () => {
      const { load, ...rest } = base;
      expect(await errorsOf(rest)).not.toHaveLength(0);
    });

    it('capabilities 为标量 → 校验失败（@IsObject）', async () => {
      expect(
        await errorsOf({ ...base, capabilities: 'string' }),
      ).not.toHaveLength(0);
    });

    it('完整对象 → 校验通过', async () => {
      expect(await errorsOf(base)).toHaveLength(0);
    });
  });

  /**
   * worker-self-update Todo 3/4 共享契约：`updateState` + `rolledBack` 两个可选上报字段。
   * 两端靠它们对齐（worker 执行器上报 → server 落库 → web 展示），故此处钉死
   * 「可选 + 取值枚举 + 缺席不报错」三条：任一条漂移，Todo 4 的执行器或 Todo 5 的
   * UI 就会静默收不到/收错值。
   */
  describe('自更新状态字段（updateState/rolledBack）', () => {
    const base = {
      workerId: 'w_0000000009',
      opencodeVersion: '1.18.14',
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
    };
    const errorsOf = async (cls: new () => object, obj: object) =>
      (await validate(plainToInstance(cls, obj)))
        .map((e) => e.property)
        .filter(Boolean);

    for (const [name, cls] of [
      ['RegisterWorkerDto', RegisterWorkerDto],
      ['HeartbeatWorkerDto', HeartbeatWorkerDto],
    ] as const) {
      it(`${name}：updateState 接受全部 5 个状态取值`, async () => {
        for (const state of Object.values(WORKER_UPDATE_STATES)) {
          expect(
            await errorsOf(cls as new () => object, {
              ...base,
              health: 'ok',
              updateState: state,
            }),
          ).toEqual([]);
        }
      });

      it(`${name}：updateState 缺席（旧 worker）→ 校验通过且键不进 wire`, async () => {
        const wire = JSON.parse(
          JSON.stringify(
            plainToInstance(cls as new () => object, { ...base, health: 'ok' }),
          ),
        );
        expect(
          await errorsOf(cls as new () => object, { ...base, health: 'ok' }),
        ).toEqual([]);
        expect(wire.updateState).toBeUndefined();
        expect(wire.rolledBack).toBeUndefined();
      });

      it(`${name}：非法 updateState 取值 → 400 拒绝（不把脏值写进 UI 会展示的列）`, async () => {
        expect(
          await errorsOf(cls as new () => object, {
            ...base,
            health: 'ok',
            updateState: 'weird-state',
          }),
        ).toContain('updateState');
      });

      it(`${name}：rolledBack 布尔可用；非布尔值被拒`, async () => {
        expect(
          await errorsOf(cls as new () => object, {
            ...base,
            health: 'ok',
            rolledBack: true,
          }),
        ).toEqual([]);
        expect(
          await errorsOf(cls as new () => object, {
            ...base,
            health: 'ok',
            rolledBack: 'yes',
          }),
        ).toContain('rolledBack');
      });
    }

    it('register 与心跳两侧字段名逐字一致（Todo 4 按这两个名字发，server 按这两个名字收）', () => {
      const CONTRACT_FIELDS = ['updateState', 'rolledBack'];
      const regWire = JSON.parse(
        JSON.stringify(
          plainToInstance(RegisterWorkerDto, {
            ...base,
            updateState: 'downloading',
            rolledBack: true,
          }),
        ),
      );
      const hbWire = JSON.parse(
        JSON.stringify(
          plainToInstance(HeartbeatWorkerDto, {
            ...base,
            health: 'ok',
            updateState: 'downloading',
            rolledBack: true,
          }),
        ),
      );
      for (const field of CONTRACT_FIELDS) {
        expect(regWire).toHaveProperty(field);
        expect(hbWire).toHaveProperty(field);
        expect(hbWire[field]).toBe(regWire[field]);
      }
    });
  });
});
