/**
 * index.ts 注册能力组装测试（T3 D2：baseUrl 上报 + T4c：重启后重新注册数据源）。
 * 仅测 buildCapabilities/buildRegisterOptions 纯函数；main() 由 require.main 守卫隔离，import 不触发 worker 启动。
 */
import { WorkerConfig } from './config';
import { GIT_TOOLS } from './git/git-tools';
import { WorkerCommand } from './protocol/worker-protocol';
import { InjectReport } from './resources/injector';
import {
  buildCapabilities,
  buildRegisterOptions,
  dispatchCommands,
  onCommands,
  resolveModels,
} from './index';

/** 最小 WorkerConfig（buildRegisterOptions 全字段）。 */
const CONFIG: WorkerConfig = {
  workerToken: 'tok',
  serverUrl: 'http://server:3000',
  workerId: 'w_host',
  workerName: 'host',
  opencodeServePort: 0,
  serverPassword: '',
  heartbeatIntervalMs: 10000,
  logLevel: 'info',
  workDir: '/tmp/w',
  gitSshKeyPath: '',
  workerAdvertiseHost: 'http://worker',
  opencodeServeHostname: '127.0.0.1',
  defaultModelId: '',
};

describe('buildCapabilities（D2：serve 对 server 公布 baseUrl）', () => {
  it('serve 启动后 port 已知：上报 port + baseUrl = advertiseHost:port', async () => {
    const caps = await buildCapabilities(4199, 'http://worker');
    expect(caps.port).toBe(4199);
    expect(caps.baseUrl).toBe('http://worker:4199');
  });

  it('advertiseHost 尾斜杠容忍（容器 compose 写 http://worker/ 不产生双斜杠）', async () => {
    expect((await buildCapabilities(4199, 'http://worker/')).baseUrl).toBe('http://worker:4199');
    expect((await buildCapabilities(4199, 'http://worker')).baseUrl).toBe('http://worker:4199');
  });

  it('serve 未就绪（port=null）：不报 port/baseUrl（避免 server 连死地址）', async () => {
    const caps = await buildCapabilities(null, 'http://worker');
    expect(caps.port).toBeUndefined();
    expect(caps.baseUrl).toBeUndefined();
  });

  it('本地默认 advertiseHost=http://127.0.0.1：baseUrl 指向回环', async () => {
    expect((await buildCapabilities(4199, 'http://127.0.0.1')).baseUrl).toBe('http://127.0.0.1:4199');
  });

  it('T9：未注入时 skills 为空、tools 仅内置 git 工具族（7 个）', async () => {
    const caps = await buildCapabilities(4199, 'http://worker');
    expect(caps.skills).toEqual([]);
    expect(caps.tools).toEqual(GIT_TOOLS.map((tool) => tool.name));
    expect(caps.tools).toHaveLength(7);
  });

  it('T9：注入清单接入——skills 上报注入的 skill 名，tools 合并内置 git + 注入自定义工具', async () => {
    const report: InjectReport = {
      skills: ['audit-log-analysis', 'review'],
      tools: ['jira-query', 'echo-hello'],
      mcpServers: ['gitee-ent'],
    };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    expect(caps.skills).toEqual(['audit-log-analysis', 'review']);
    expect(caps.tools).toEqual([...GIT_TOOLS.map((t) => t.name), 'jira-query', 'echo-hello']);
  });

  it('T9：注入工具与内置 git 工具同名时去重（不重复上报）', async () => {
    const report: InjectReport = {
      skills: [],
      tools: ['git_status', 'jira-query', 'git_clone'],
      mcpServers: [],
    };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    const expected = [...new Set([...GIT_TOOLS.map((t) => t.name), 'git_status', 'jira-query', 'git_clone'])];
    expect(caps.tools).toEqual(expected);
    expect(caps.tools).toHaveLength(GIT_TOOLS.length + 1);
  });

  it('C2：传入 models 时 capabilities 携带真实模型 id 列表（providerID/modelID）', async () => {
    const caps = await buildCapabilities(4199, 'http://worker', undefined, [
      'opencode-go/deepseek-v4-flash',
      'opencode/glm-5.1',
    ]);
    expect(caps.models).toEqual(['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1']);
  });

  it('C2：models 为空数组时携带（已探测但无模型）；undefined（探测失败）不携带', async () => {
    expect((await buildCapabilities(4199, 'http://worker', undefined, [])).models).toEqual([]);
    expect((await buildCapabilities(4199, 'http://worker')).models).toBeUndefined();
  });
});

describe('resolveModels（C2：serve 模型列表探测与降级）', () => {
  it('成功：映射为 providerID/modelID 上报格式', async () => {
    const models = await resolveModels({
      listModels: async () => [
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        { id: 'opencode/glm-5.1', name: 'GLM 5.1', providerID: 'opencode', modelID: 'glm-5.1' },
      ],
    });
    expect(models).toEqual(['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1']);
  });

  it('首次探测非空：只探测一次，不触发重试', async () => {
    const listModels = jest.fn().mockResolvedValue([
      { id: 'opencode-go/deepseek-v4-flash', name: 'D', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    ]);
    const models = await resolveModels({ listModels }, { delay: async () => {} });
    expect(models).toEqual(['opencode-go/deepseek-v4-flash']);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('B2 空列表重试：前两次为空，第三次非空 → 返回模型（serve 预热）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listModels = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'opencode-go/deepseek-v4-flash', name: 'D', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        ]);
      const models = await resolveModels({ listModels }, { delay: async () => {} });
      expect(models).toEqual(['opencode-go/deepseek-v4-flash']);
      expect(listModels).toHaveBeenCalledTimes(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('B2 空列表重试耗尽：持续为空 → 降级 undefined（不阻断注册）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listModels = jest.fn().mockResolvedValue([]);
      const models = await resolveModels({ listModels }, { retries: 2, delay: async () => {} });
      expect(models).toBeUndefined();
      expect(listModels).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('失败（listModels 抛错）：立即降级返回 undefined（注册不阻断）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listModels = jest.fn().mockImplementation(async () => {
        throw new Error('serve 未就绪');
      });
      const models = await resolveModels({ listModels }, { delay: async () => {} });
      expect(models).toBeUndefined();
      expect(listModels).toHaveBeenCalledTimes(1); // 抛错不重试
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('C3 稳定性校验：预热中间态假列表变化后，连续 stability 次一致才上报真实列表', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 探测序列：假列表（中间态）→ 真实列表 ×2 → 第 2/3 次一致，通过稳定性确认
      const listModels = jest
        .fn()
        .mockResolvedValueOnce([
          { id: 'opencode-go/ling-3.0-flash-free', name: '假', providerID: 'opencode-go', modelID: 'ling-3.0-flash-free' },
          { id: 'opencode-go/hy3-free', name: '假', providerID: 'opencode-go', modelID: 'hy3-free' },
        ])
        .mockResolvedValueOnce([
          { id: 'opencode-go/deepseek-v4-flash-free', name: '真', providerID: 'opencode-go', modelID: 'deepseek-v4-flash-free' },
        ])
        .mockResolvedValueOnce([
          { id: 'opencode-go/deepseek-v4-flash-free', name: '真', providerID: 'opencode-go', modelID: 'deepseek-v4-flash-free' },
        ]);
      const models = await resolveModels(
        { listModels },
        { stability: 2, delay: async () => {} },
      );
      expect(models).toEqual(['opencode-go/deepseek-v4-flash-free']);
      expect(listModels).toHaveBeenCalledTimes(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('C3 稳定性校验：探测始终不一致 → 降级 undefined（宁可不带 models 也不上报假列表）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const listModels = jest
        .fn()
        .mockResolvedValueOnce([{ id: 'a/fake-1', name: 'x', providerID: 'a', modelID: 'fake-1' }])
        .mockResolvedValueOnce([{ id: 'a/fake-2', name: 'x', providerID: 'a', modelID: 'fake-2' }])
        .mockResolvedValueOnce([{ id: 'a/fake-3', name: 'x', providerID: 'a', modelID: 'fake-3' }])
        .mockResolvedValueOnce([{ id: 'a/fake-4', name: 'x', providerID: 'a', modelID: 'fake-4' }]);
      const models = await resolveModels(
        { listModels },
        { stability: 2, retries: 3, delay: async () => {} },
      );
      expect(models).toBeUndefined();
      expect(listModels).toHaveBeenCalledTimes(4);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('T4a 命令分派（onCommands + dispatchCommands）', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('reload-config 命令打占位日志并透传已注册回调（T4b 挂载点）', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      { type: 'reload-config', resourceVersion: 'v2' },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('reload-config'),
    );
  });

  it('未注册回调时仅打占位日志，不抛错（本任务范围：打日志/占位）', () => {
    onCommands(null as never);

    expect(() =>
      dispatchCommands([
        { type: 'reload-config', resourceVersion: 'v1' },
      ]),
    ).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('reload-config'),
    );
  });

  it('空命令/无命令不触发回调', () => {
    const handler = jest.fn();
    onCommands(handler);

    dispatchCommands([]);
    dispatchCommands(undefined as never);

    expect(handler).not.toHaveBeenCalled();
  });

  it('命令 type 非 reload-config 时透传回调但不打占位日志', () => {
    const handler = jest.fn();
    onCommands(handler);
    // 协议 type 可扩展（09 §3.9 预留 stop/kill）：未知 type 仅透传不特殊处理
    const commands = [
      { type: 'stop', resourceVersion: 'v1' },
    ] as unknown as WorkerCommand[];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('reload-config'),
    );
  });

  it('C5：model-credentials 命令打 providerID 清单日志（不含 token）并透传回调', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      {
        type: 'model-credentials',
        resourceVersion: 'model-credentials',
        payload: {
          providerKeys: [
            { providerID: 'opencode-go', key: 'sk-secret' },
            { providerID: 'opencode', key: 'sk-secret-2' },
          ],
        },
      },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    const logArgs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logArgs).toContain('model-credentials');
    expect(logArgs).toContain('opencode-go, opencode');
    // 安全：token 绝不进日志
    expect(logArgs).not.toContain('sk-secret');
    expect(logArgs).not.toContain('sk-secret-2');
  });

  it('C5：model-credentials 命令缺 payload 时仍透传回调且日志不含敏感信息', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands = [
      { type: 'model-credentials', resourceVersion: 'model-credentials' },
    ] as unknown as WorkerCommand[];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('model-credentials'),
    );
  });

  it('UX-01：restart 命令打远程重启日志并透传回调（RESTART 分支）', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      { type: 'restart', resourceVersion: 'remote-restart' },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('restart'),
    );
  });

  it('UX-01：shutdown 命令打优雅退出日志并透传回调（SHUTDOWN 分支）', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      { type: 'shutdown', resourceVersion: 'remote-shutdown' },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('shutdown'),
    );
  });
});

describe('buildRegisterOptions（T4c：重启后重新注册携带新端口）', () => {
  it('端口变化 → capabilities.port/baseUrl 更新（重启后重新注册数据源）', async () => {
    const before = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    const after = await buildRegisterOptions(CONFIG, 53001, '1.18.15', 'cli-version');

    expect(before.capabilities.port).toBe(4199);
    expect(before.capabilities.baseUrl).toBe('http://worker:4199');
    // 重启后随机端口变化：重新组装注册选项即携带新端口（T4c reRegister 复用）
    expect(after.capabilities.port).toBe(53001);
    expect(after.capabilities.baseUrl).toBe('http://worker:53001');
    expect(after.workerId).toBe('w_host');
  });

  it('serveVersion 非 unknown 优先，否则回退 CLI 版本', async () => {
    expect((await buildRegisterOptions(CONFIG, null, '1.18.15', 'fallback')).opencodeVersion).toBe('1.18.15');
    expect((await buildRegisterOptions(CONFIG, null, 'unknown', 'fallback')).opencodeVersion).toBe('fallback');
  });

  it('serve 未就绪（port=null）：capabilities 不含 port/baseUrl（不报死地址）', async () => {
    const opts = await buildRegisterOptions(CONFIG, null, 'unknown', 'cli-version');
    expect(opts.capabilities.port).toBeUndefined();
    expect(opts.capabilities.baseUrl).toBeUndefined();
  });

  it('T9：注入报告透传——注册选项携带真实 skills/tools 清单（reload-config 后 reRegister 复用）', async () => {
    const report: InjectReport = {
      skills: ['audit-log-analysis'],
      tools: ['jira-query'],
      mcpServers: ['gitee-ent'],
    };
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version', report);
    expect(opts.capabilities.skills).toEqual(['audit-log-analysis']);
    expect(opts.capabilities.tools).toEqual([...GIT_TOOLS.map((t) => t.name), 'jira-query']);
    expect(opts.capabilities.port).toBe(4199);
  });

  it('T9：未传注入报告时默认空清单（skills=[]、tools 仅内置 git）', async () => {
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    expect(opts.capabilities.skills).toEqual([]);
    expect(opts.capabilities.tools).toEqual(GIT_TOOLS.map((t) => t.name));
  });

  it('C2：models 透传——capabilities.models 携带真实模型 id 列表', async () => {
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version', undefined, [
      'opencode-go/deepseek-v4-flash',
    ]);
    expect(opts.capabilities.models).toEqual(['opencode-go/deepseek-v4-flash']);
  });

  it('C2：defaultModelId 配置后随注册选项上报', async () => {
    const opts = await buildRegisterOptions(
      { ...CONFIG, defaultModelId: 'opencode-go/deepseek-v4-flash' },
      4199,
      '1.18.15',
      'cli-version',
    );
    expect(opts.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
  });

  it('C2：defaultModelId 未配置（空串）不携带', async () => {
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    expect(opts.defaultModelId).toBeUndefined();
  });
});
