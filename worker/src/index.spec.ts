/**
 * index.ts 注册能力组装测试（T3 D2：baseUrl 上报 + T4c：重启后重新注册数据源）。
 * 仅测 buildCapabilities/buildRegisterOptions 纯函数；main() 由 require.main 守卫隔离，import 不触发 worker 启动。
 */
// agent-browser 可用性探测是 spawnSync('agent-browser', ['--version'])——随宿主环境变化
// （本机装了 agent-browser 的机器上恒 true → tools 变 8 个 → 断言炸）。固定为 false，
// 保持本套件「未注入时 skills/tools 只有内置项」的确定性口径。
jest.mock('./browser/browser-tools', () => {
  const actual: Record<string, unknown> = jest.requireActual('./browser/browser-tools');
  return { ...actual, isAgentBrowserAvailable: () => false };
});
// os.homedir 在 Node 中是只读 getter，jest.spyOn 换不掉 → 模块级部分 mock
// （默认代理真实实现，beforeAll 再指向临时 HOME）：git 凭证会双写 worker 自己的 HOME，
// 不能碰开发机的真实 $HOME。
jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof os;
  return { ...actual, homedir: jest.fn(actual.homedir) };
});
import { WorkerConfig } from './config';
import { GIT_TOOLS } from './git/git-tools';
import {
  buildGitCredsFile,
  GIT_CREDS_FILE,
  GitCredentialEntry,
} from './git/git-credential-injector';
import { WorkerCommand } from './protocol/worker-protocol';
import { InjectReport, ResourceInjector } from './resources/injector';
import { resolveIsolationScope } from './config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAuthJson,
  buildProviderSection,
  DEFAULT_OPENCODE_CONFIG_PATH,
  mergeProviderSection,
} from './credentials/model-credential-injector';
import {
  applySetMaxInstances,
  buildCapabilities,
  buildRegisterOptions,
  buildServePasswordProvider,
  createResourceInjector,
  createEventSender,
  dispatchCommands,
  DEFAULT_AUTH_JSON_PATH,
  ensureStandaloneProjectConfig,
  formatToolInjectionSummary,
  handleGitCredentials,
  handleModelCredentials,
  handleModelCredentialsCommand,
  handleReloadConfigCommand,
  onCommands,
  persistRuntimeMaxInstances,
  ReloadConfigCommandDeps,
  resolveExecutableModels,
  resolveModels,
  resolveRuntimeMaxInstances,
  RUNTIME_CONFIG_FILE,
  warnLoopbackAdvertiseHost,
  writeGitCredsToServeScope,
} from './index';
import { readUpdateCommandVersion } from './update/worker-updater';

/** 最小 WorkerConfig（buildRegisterOptions 全字段）。 */
const CONFIG: WorkerConfig = {
  workerToken: 'tok',
  serverUrl: 'http://server:3000',
  workerId: 'w_host',
  workerName: 'host',
  opencodeServePort: 0,
  serverPassword: '',
  allowGeneratedPassword: false,
  opencodeV2Enabled: true,
  heartbeatIntervalMs: 10000,
  logLevel: 'info',
  workDir: '/tmp/w',
  gitSshKeyPath: '',
  workerAdvertiseHost: 'http://worker',
  workerAdvertiseHostExplicit: true,
  opencodeServeHostname: '127.0.0.1',
  defaultModelId: '',
  workerExecPort: 4198,
  workerFirstTokenTimeoutMs: 300000,
  workerMaxInstances: 5,
  workerTotalTimeoutMs: 0,
  standalone: false,
  isolationScope: resolveIsolationScope({ HOME: '/tmp/worker-home' }),
};

/** 临时 HOME（os.homedir 被 mock 到这里：git 凭证双写会落到 worker 自己的 HOME）。 */
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-worker-index-test-'));

beforeAll(() => {
  (os.homedir as jest.Mock).mockReturnValue(TMP_HOME);
});

afterAll(() => {
  (os.homedir as jest.Mock).mockRestore();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

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
      agentPolicies: { enabled: false, names: [] },
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
      agentPolicies: { enabled: false, names: [] },
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

  it('T10：传入 execPort 时 capabilities 携带执行端点端口（server 据此发现执行端点）', async () => {
    const caps = await buildCapabilities(4199, 'http://worker', undefined, undefined, 4198);
    expect(caps.execPort).toBe(4198);
  });

  it('T10：execPort 未传（端点启动失败）时不携带（server 不连不可用端点）', async () => {
    expect((await buildCapabilities(4199, 'http://worker')).execPort).toBeUndefined();
  });

  it('F4：未传 maxInstances 时默认 5（并发上限配置化兜底）', async () => {
    expect((await buildCapabilities(4199, 'http://worker')).maxInstances).toBe(5);
  });

  it('F4：显式传入 maxInstances 时按传入值上报（替代硬编码 1）', async () => {
    expect((await buildCapabilities(4199, 'http://worker', undefined, undefined, undefined, 3)).maxInstances).toBe(3);
  });

  it('Todo 14：注入成功 → capabilities.agentPolicies.enabled=true 且 names=写入名（6 agent）', async () => {
    const names = ['vteam-plan', 'vteam-product', 'vteam-architect', 'vteam-developer', 'vteam-tester', 'vteam-project_manager'];
    const report: InjectReport = { skills: [], tools: [], mcpServers: [], agentPolicies: { enabled: true, names } };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    expect(caps.agentPolicies).toEqual({ enabled: true, names });
  });

  it('Todo 14：注入失败/中性化 → enabled=false 且 names=[]', async () => {
    const report: InjectReport = { skills: [], tools: [], mcpServers: [], agentPolicies: { enabled: false, names: [] } };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    expect(caps.agentPolicies).toEqual({ enabled: false, names: [] });
  });

  it('Todo 14：未传注入报告（默认空报告）→ agentPolicies 缺省为 enabled=false/[]（旧 worker 兼容）', async () => {
    const caps = await buildCapabilities(4199, 'http://worker');
    expect(caps.agentPolicies).toEqual({ enabled: false, names: [] });
  });

  it('Todo 14：names 防御式拷贝（调用方篡改注入报告不影响已组装 capabilities）', async () => {
    const names = ['vteam-plan'];
    const report: InjectReport = { skills: [], tools: [], mcpServers: [], agentPolicies: { enabled: true, names } };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    names.push('vteam-evil');
    expect(caps.agentPolicies?.names).toEqual(['vteam-plan']);
  });

  it('批次 D-2：中性化报告的 stale + 上次已知名**透传**进 capabilities（server 的门靠它放行点名）', async () => {
    const report: InjectReport = {
      skills: [],
      tools: [],
      mcpServers: [],
      agentPolicies: { enabled: false, names: ['vteam-developer'], stale: true },
    };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    expect(caps.agentPolicies).toEqual({
      enabled: false,
      names: ['vteam-developer'],
      stale: true,
    });
  });

  it('批次 D-2：新鲜报告**不带** stale 键（缺席 = 新鲜）', async () => {
    const report: InjectReport = {
      skills: [],
      tools: [],
      mcpServers: [],
      agentPolicies: { enabled: true, names: ['vteam-developer'] },
    };
    const caps = await buildCapabilities(4199, 'http://worker', report);
    expect('stale' in (caps.agentPolicies ?? {})).toBe(false);
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

describe('resolveExecutableModels（models-truth：读 **worker 自己那个 serve** 的模型目录）', () => {
  /**
   * v2 serve 的 `GET /api/model` 实测响应（**2.0.28 包裹形态**：`{location, data:[...]}`）。
   * ⚠️ v2 的 CLI 不是真值源——CLI 绑共享后台服务（49374），读的是另一个配置作用域。
   */
  const WRAPPED_PAYLOAD = {
    location: { directory: '/data/vteam-worker' },
    data: [
      { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', enabled: true },
      { id: 'ling-3.0-flash-fin-free', modelID: 'ling-3.0-flash-fin-free', providerID: 'opencode', enabled: true },
      { id: 'mimo-v2.5-free', modelID: 'mimo-v2.5-free', providerID: 'opencode', enabled: true },
      { id: 'nemotron-3-ultra-free', modelID: 'nemotron-3-ultra-free', providerID: 'opencode', enabled: true },
      { id: 'nemotron-3.5-lightning-free', modelID: 'nemotron-3.5-lightning-free', providerID: 'opencode', enabled: true },
    ],
  };

  const EXPECTED_IDS = [
    'opencode/big-pickle',
    'opencode/ling-3.0-flash-fin-free',
    'opencode/mimo-v2.5-free',
    'opencode/nemotron-3-ultra-free',
    'opencode/nemotron-3.5-lightning-free',
  ];

  it('2.0.28 包裹形态 `{location, data}` → providerID/modelID 列表', async () => {
    expect(await resolveExecutableModels(async () => WRAPPED_PAYLOAD)).toEqual(EXPECTED_IDS);
  });

  it('裸数组形态 → 同样解析（防御性容忍；2.0.28 与 2.0.32 实为同一形态）', async () => {
    expect(await resolveExecutableModels(async () => WRAPPED_PAYLOAD.data)).toEqual(EXPECTED_IDS);
  });

  it('生产数据源（driver 的 listModels() 输出）同样解析', async () => {
    const driverModels = [
      { id: 'opencode/big-pickle', name: 'Big Pickle', providerID: 'opencode', modelID: 'big-pickle', status: 'active' },
      { id: 'opencode/mimo-v2.5-free', name: 'MIMO', providerID: 'opencode', modelID: 'mimo-v2.5-free', status: 'active' },
    ];
    expect(await resolveExecutableModels(async () => driverModels)).toEqual([
      'opencode/big-pickle',
      'opencode/mimo-v2.5-free',
    ]);
  });

  it('去重保序（重复项只留首次出现的位置）', async () => {
    const payload = {
      data: [
        { modelID: 'a', providerID: 'p' },
        { modelID: 'b', providerID: 'p' },
        { modelID: 'a', providerID: 'p' },
      ],
    };
    expect(await resolveExecutableModels(async () => payload)).toEqual(['p/a', 'p/b']);
  });

  it('非法行丢弃：无 provider 段 / 无 model 段 / 含空白不进上报', async () => {
    const payload = {
      data: [
        { modelID: 'ok', providerID: 'p' },
        { modelID: 'no-provider' },
        { providerID: 'p' },
        { modelID: 'has space', providerID: 'p' },
      ],
    };
    expect(await resolveExecutableModels(async () => payload)).toEqual(['p/ok']);
  });

  it('`enabled:false` 的模型不算可执行（v2 的"该模型不可用"标记）', async () => {
    const payload = {
      data: [
        { modelID: 'usable', providerID: 'p', enabled: true },
        { modelID: 'unusable', providerID: 'p', enabled: false },
      ],
    };
    expect(await resolveExecutableModels(async () => payload)).toEqual(['p/usable']);
  });

  it('空响应/非法响应 → undefined（**不断言零可用**）', async () => {
    expect(await resolveExecutableModels(async () => undefined)).toBeUndefined();
    expect(await resolveExecutableModels(async () => ({ location: {}, data: [] }))).toBeUndefined();
    expect(await resolveExecutableModels(async () => ({}))).toBeUndefined();
    expect(await resolveExecutableModels(async () => 'not a payload')).toBeUndefined();
    expect(
      await resolveExecutableModels(async () => ({ data: [{ modelID: 'no-provider' }] })),
    ).toBeUndefined();
  });

  it('探测抛错 → undefined（不携带，server 回退拉取，不阻断注册）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        await resolveExecutableModels(async () => {
          throw new Error('serve 未就绪');
        }),
      ).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('可执行模型探测失败'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('buildCapabilities 透传 executableModels；缺省不携带', async () => {
    const caps = await buildCapabilities(
      4199,
      'http://worker',
      undefined,
      undefined,
      undefined,
      5,
      ['opencode/big-pickle'],
    );
    expect(caps.executableModels).toEqual(['opencode/big-pickle']);
    expect((await buildCapabilities(4199, 'http://worker')).executableModels).toBeUndefined();
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

  it('git-credentials 命令打 repoUrl 清单日志（不含 key 明文）并透传回调', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      {
        type: 'git-credentials',
        resourceVersion: 'git-credentials',
        payload: {
          credentials: [
            {
              repoUrl: 'git@github.com:xishuhq/vteam.git',
              authType: 'ssh_key',
              key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret',
              fingerprint: 'sha256:abcd',
            },
            {
              repoUrl: 'https://github.com/xishuhq/tools.git',
              authType: 'https_token',
              key: 'ghp_topsecret',
              fingerprint: 'ghp_t****et',
            },
          ],
        },
      },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    const logArgs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logArgs).toContain('git-credentials');
    expect(logArgs).toContain(
      'git@github.com:xishuhq/vteam.git, https://github.com/xishuhq/tools.git',
    );
    // 安全：key 明文绝不进日志
    expect(logArgs).not.toContain('secret');
    expect(logArgs).not.toContain('ghp_topsecret');
  });

  it('git-credentials 命令缺 payload 时仍透传回调且日志不含敏感信息', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands = [
      { type: 'git-credentials', resourceVersion: 'git-credentials' },
    ] as unknown as WorkerCommand[];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('git-credentials'),
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

  it('worker-self-update：update-worker 命令打目标版本日志并透传回调', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      { type: 'update-worker', resourceVersion: 'a1b2c3d' },
    ];

    dispatchCommands(commands);

    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('update-worker'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('a1b2c3d'));
  });

  it('worker-self-update：payload.version 优先于 resourceVersion（server 换负载形态也不炸）', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands: WorkerCommand[] = [
      { type: 'update-worker', resourceVersion: 'rv-1', payload: { version: 'pv-2' } },
    ];

    dispatchCommands(commands);

    expect(readUpdateCommandVersion(commands[0])).toBe('pv-2');
    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('目标版本=pv-2'),
    );
  });

  it('worker-self-update：缺目标版本时日志标注未携带（执行器侧放弃本轮）', () => {
    const handler = jest.fn();
    onCommands(handler);
    const commands = [
      { type: 'update-worker', resourceVersion: '   ' },
    ] as unknown as WorkerCommand[];

    dispatchCommands(commands);

    expect(readUpdateCommandVersion(commands[0])).toBeUndefined();
    expect(handler).toHaveBeenCalledWith(commands);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('目标版本=未携带'),
    );
  });

  it('worker-self-update：非 update-worker 命令不打印自更新日志（其它 kind 行为零变化）', () => {
    onCommands(jest.fn());

    dispatchCommands([{ type: 'restart', resourceVersion: 'v1' }]);

    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('update-worker'),
    );
  });
});

describe('CHANGE 3：set-max-instances 动态并发上限（本地持久化 + 重启优先）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runtime-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('合法负载：更新有效值并持久化（resolveRuntimeMaxInstances 可读回）', () => {
    const next = applySetMaxInstances({ maxInstances: 8 }, 5, dir, () => {});
    expect(next).toBe(8);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dir, RUNTIME_CONFIG_FILE), 'utf8'),
    ) as { maxInstances: number };
    expect(persisted).toEqual({ maxInstances: 8 });
    expect(resolveRuntimeMaxInstances(dir, 5)).toBe(8);
  });

  it('非法负载（缺失/≤0/非整数/非数字）：忽略并保持当前值，不落盘', () => {
    const cases = [
      undefined,
      { maxInstances: 0 },
      { maxInstances: -1 },
      { maxInstances: 1.5 },
      { maxInstances: 'x' as unknown as number },
    ];
    for (const payload of cases) {
      expect(
        applySetMaxInstances(payload as { maxInstances: number } | undefined, 5, dir, () => {}),
      ).toBe(5);
    }
    expect(fs.existsSync(path.join(dir, RUNTIME_CONFIG_FILE))).toBe(false);
  });

  it('启动时本地运行时文件优先于 env（server 下发落盘后重启仍生效）', () => {
    persistRuntimeMaxInstances(dir, 9);
    expect(resolveRuntimeMaxInstances(dir, 3)).toBe(9);
  });

  it('本地文件缺失：回落 env 值（不抛错）', () => {
    expect(resolveRuntimeMaxInstances(dir, 7)).toBe(7);
  });

  it('本地文件损坏/值非法：回落 env 值并 warn（不抛错）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fs.writeFileSync(path.join(dir, RUNTIME_CONFIG_FILE), 'not-json', 'utf8');
      expect(resolveRuntimeMaxInstances(dir, 3)).toBe(3);
      fs.writeFileSync(
        path.join(dir, RUNTIME_CONFIG_FILE),
        JSON.stringify({ maxInstances: 0 }),
        'utf8',
      );
      expect(resolveRuntimeMaxInstances(dir, 3)).toBe(3);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('dispatchCommands：set-max-instances 打命令日志并透传回调', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = jest.fn();
      onCommands(handler);
      const commands: WorkerCommand[] = [
        { type: 'set-max-instances', resourceVersion: 'v1', payload: { maxInstances: 6 } },
      ];
      dispatchCommands(commands);
      expect(handler).toHaveBeenCalledWith(commands);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('set-max-instances'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('buildRegisterOptions：显式 maxInstances 覆盖 env（运行时有效值随注册上报）', async () => {
    const opts = await buildRegisterOptions(
      CONFIG,
      4199,
      '1.18.15',
      'cli-version',
      undefined,
      undefined,
      undefined,
      undefined,
      9,
    );
    expect(opts.capabilities.maxInstances).toBe(9);
  });
});

describe('handleModelCredentials（F3 防循环 + C6：auth.json/opencode.json 双文件幂等）', () => {
  const KEY = [{ providerID: 'opencode-go', key: 'sk-secret' }];

  function makeDeps() {
    return {
      readContent: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      writeAuthJson: jest.fn().mockReturnValue({
        authJsonPath: DEFAULT_AUTH_JSON_PATH,
      }),
      cleanupAuthJson: jest.fn(),
      readConfig: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
      writeOpencodeConfig: jest
        .fn()
        .mockReturnValue({ changed: false, path: DEFAULT_OPENCODE_CONFIG_PATH }),
      /**
       * 生效动作（**热重载优先**）。原实现这里是 `requestRestart`——配置类变更不再
       * 重启 serve（热重载路径见 reload/config-reloader.ts）。
       */
      applyConfigChange: jest.fn().mockResolvedValue('reloaded'),
      log: jest.fn(),
      warn: jest.fn(),
    };
  }

  it('auth.json 与 opencode.json 均未变化 → 不写盘、不做生效动作（切断回放循环）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(buildAuthJson(KEY));
    // 现有 config 已含相同 provider 段 → merge 结果与现有内容一致
    // （必须与 mergeProviderSection 的 JSON.stringify(base, null, 2) 字节一致才判未变化）
    // 现有内容由生产构造器派生（不硬编码 provider 段形态）——provider 段形态随 opencode
    // 版本演进（v1 npm/options → v2 package/settings），硬编码会让本用例与契约无关地失败。
    const providerPayload = {
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    };
    deps.readConfig.mockResolvedValue(
      mergeProviderSection(null, buildProviderSection(providerPayload))!,
    );

    const result = await handleModelCredentials(
      KEY,
      providerPayload,
      DEFAULT_AUTH_JSON_PATH,
      DEFAULT_OPENCODE_CONFIG_PATH,
      deps,
    );

    expect(deps.writeAuthJson).not.toHaveBeenCalled();
    expect(deps.writeOpencodeConfig).not.toHaveBeenCalled();
    expect(deps.applyConfigChange).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.configChanged).toBe(false);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('凭据未变化，跳过注入与生效动作'),
    );
  });

  it('现有 auth.json 内容不同 → 清理旧文件 + 写盘 + **热重载**（凭据变更，不再重启 serve）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(
      buildAuthJson([{ providerID: 'opencode-go', key: 'sk-old-secret' }]),
    );

    const result = await handleModelCredentials(
      KEY,
      undefined,
      DEFAULT_AUTH_JSON_PATH,
      DEFAULT_OPENCODE_CONFIG_PATH,
      deps,
    );

    expect(deps.writeAuthJson).toHaveBeenCalledWith(KEY);
    expect(deps.cleanupAuthJson).toHaveBeenCalledWith(DEFAULT_AUTH_JSON_PATH);
    expect(deps.writeOpencodeConfig).not.toHaveBeenCalled();
    expect(deps.applyConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('model-credentials') }),
    );
    expect(result.changed).toBe(true);
  });

  it('无现有 auth.json（容器重启后）→ 写盘 + 热重载（恢复路径，不清理）', async () => {
    const deps = makeDeps();

    const result = await handleModelCredentials(
      KEY,
      undefined,
      null,
      null,
      deps,
    );

    expect(deps.writeAuthJson).toHaveBeenCalledWith(KEY);
    expect(deps.cleanupAuthJson).not.toHaveBeenCalled();
    expect(deps.applyConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('model-credentials') }),
    );
    expect(result.changed).toBe(true);
    expect(result.authJsonPath).toBe(DEFAULT_AUTH_JSON_PATH);
  });

  it('C6：providerConfigs 携带且 config 缺失 → 写 opencode.json + 热重载（auth 同变只生效一次）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(buildAuthJson([{ providerID: 'a', key: 'old' }]));
    const providerPayload = {
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    };

    const result = await handleModelCredentials(
      [{ providerID: 'a', key: 'new' }],
      providerPayload,
      DEFAULT_AUTH_JSON_PATH,
      null,
      deps,
    );

    expect(deps.writeAuthJson).toHaveBeenCalledTimes(1);
    // 写入内容 = 生产构造器产出的 provider 段（形态随 opencode 版本演进，不在本用例硬编码）
    expect(deps.writeOpencodeConfig).toHaveBeenCalledWith(
      null,
      buildProviderSection(providerPayload),
    );
    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(true);
    expect(result.configPath).toBe(DEFAULT_OPENCODE_CONFIG_PATH);
  });

  it('C6：auth 未变、config 变化 → 只写 opencode.json + 热重载', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(buildAuthJson(KEY));

    const result = await handleModelCredentials(
      KEY,
      { 'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] } },
      DEFAULT_AUTH_JSON_PATH,
      DEFAULT_OPENCODE_CONFIG_PATH,
      deps,
    );

    expect(deps.writeAuthJson).not.toHaveBeenCalled();
    expect(deps.writeOpencodeConfig).toHaveBeenCalled();
    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(true);
    expect(result.configChanged).toBe(true);
  });

  it('C6：providerConfigs 为空对象 → 删除现有 provider 段（清空）+ 热重载', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(buildAuthJson(KEY));
    deps.readConfig.mockResolvedValue(
      JSON.stringify({
        mcp: { x: {} },
        provider: { 'old-local': { npm: 'n', options: { baseURL: 'http://x' } } },
      }),
    );

    const result = await handleModelCredentials(
      KEY,
      {},
      DEFAULT_AUTH_JSON_PATH,
      DEFAULT_OPENCODE_CONFIG_PATH,
      deps,
    );

    expect(deps.writeOpencodeConfig).toHaveBeenCalledWith(
      expect.stringContaining('"provider"'),
      {},
    );
    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1);
  });

  it('C6：providerConfigs=undefined（旧 server 负载）→ 不触碰 opencode.json', async () => {
    const deps = makeDeps();
    deps.readConfig.mockResolvedValue(JSON.stringify({ mcp: { x: {} } }));

    const result = await handleModelCredentials(
      KEY,
      undefined,
      DEFAULT_AUTH_JSON_PATH,
      null,
      deps,
    );

    expect(deps.writeOpencodeConfig).not.toHaveBeenCalled();
    expect(result.configPath).toBe(DEFAULT_OPENCODE_CONFIG_PATH);
  });

  it('**不重启 serve**：生效动作走 applyConfigChange（热重载），依赖面里没有重启钩子', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(buildAuthJson([{ providerID: 'a', key: 'old' }]));

    await handleModelCredentials(
      [{ providerID: 'a', key: 'new' }],
      undefined,
      DEFAULT_AUTH_JSON_PATH,
      DEFAULT_OPENCODE_CONFIG_PATH,
      deps,
    );

    // 依赖面里**不存在** requestRestart（类型层面就杜绝了「加凭据即重启 serve」）
    expect(Object.keys(deps)).not.toContain('requestRestart');
    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1);
  });
});

describe('handleReloadConfigCommand（配置变更走**热重载**，不重启 serve）', () => {
  const COMMAND: WorkerCommand = {
    type: 'reload-config',
    resourceVersion: 'rv-7',
  } as WorkerCommand;

  function makeDeps() {
    return {
      injectAll: jest.fn().mockResolvedValue({
        skills: ['skill-a'],
        tools: ['tool-a'],
        mcpServers: ['mcp-a'],
        agentPolicies: { enabled: true, names: ['agent-a'] },
      } as InjectReport),
      onInjectReport: jest.fn(),
      applyConfigChange: jest.fn().mockResolvedValue('reloaded'),
      serveEndpoint: jest.fn().mockReturnValue({ baseUrl: 'http://127.0.0.1:4000', password: 'pw' }),
      log: jest.fn(),
      warn: jest.fn(),
    };
  }

  it('重注入后走 applyConfigChange（热重载），**没有**任何重启钩子', async () => {
    const deps = makeDeps();
    await handleReloadConfigCommand(COMMAND, deps as unknown as ReloadConfigCommandDeps);

    expect(deps.injectAll).toHaveBeenCalledTimes(1);
    expect(deps.onInjectReport).toHaveBeenCalledTimes(1);
    expect(deps.applyConfigChange).toHaveBeenCalledTimes(1);
    expect(deps.applyConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('reload-config') }),
      expect.any(Function),
    );
    // 依赖面里没有 requestRestart（类型层面杜绝「配置变更即重启 serve」）
    expect(Object.keys(deps)).not.toContain('requestRestart');
  });

  it('效果确认交给调用方注入的校验器（MCP server + skill 可见性）', async () => {
    const deps = makeDeps();
    await handleReloadConfigCommand(COMMAND, deps as unknown as ReloadConfigCommandDeps);
    const verify = deps.applyConfigChange.mock.calls[0][1] as () => Promise<{
      ok: boolean;
      detail: string;
    }>;
    expect(typeof verify).toBe('function');
  });

  it('注入失败 → warn 且不触发生效动作', async () => {
    const deps = makeDeps();
    deps.injectAll.mockRejectedValue(new Error('拉取失败'));
    await handleReloadConfigCommand(COMMAND, deps as unknown as ReloadConfigCommandDeps);
    expect(deps.applyConfigChange).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('资源重注入失败'));
  });
});

describe('handleModelCredentialsCommand（加凭据走**热重载**，不重启 serve）', () => {
  const COMMAND: WorkerCommand = {
    type: 'model-credentials',
    resourceVersion: 'rv-8',
    payload: {
      providerKeys: [{ providerID: 'p1', key: 'k1' }],
      providerConfigs: { p1: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['m1'] } },
    },
  } as WorkerCommand;

  function makeDeps() {
    return {
      injectCredentials: jest.fn().mockResolvedValue({
        authJsonPath: '/iso/auth.json',
        configPath: '/iso/opencode.json',
        configChanged: true,
      }),
      onInjectedPaths: jest.fn(),
      onProviderConfigChanged: jest.fn(),
      /** v2 credential store 同步（integration 维度）；与文件注入解耦、失败不阻断。 */
      syncIntegrationCredentials: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };
  }

  it('注入后走注入回调（内部热重载），**没有**重启钩子', async () => {
    const deps = makeDeps();
    await handleModelCredentialsCommand(COMMAND, null, null, deps);

    expect(deps.injectCredentials).toHaveBeenCalledTimes(1);
    expect(deps.injectCredentials).toHaveBeenCalledWith(
      [{ providerID: 'p1', key: 'k1' }],
      { p1: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['m1'] } },
      null,
      null,
    );
    expect(deps.onInjectedPaths).toHaveBeenCalledWith('/iso/auth.json', '/iso/opencode.json');
    expect(deps.onProviderConfigChanged).toHaveBeenCalledTimes(1);
    expect(Object.keys(deps)).not.toContain('requestRestart');
  });

  it('缺 providerKeys 负载 → warn 跳过', async () => {
    const deps = makeDeps();
    await handleModelCredentialsCommand(
      { type: 'model-credentials', payload: {} } as WorkerCommand,
      null,
      null,
      deps,
    );
    expect(deps.injectCredentials).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('缺少 providerKeys 负载'));
  });

  it('注入抛错 → warn 吞掉（不让 worker 下线）', async () => {
    const deps = makeDeps();
    deps.injectCredentials.mockRejectedValue(new Error('写盘失败'));
    await handleModelCredentialsCommand(COMMAND, null, null, deps);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('注入失败'));
  });

  it('注入完成后**总是**调 credential store 同步（providerKeys/providerConfigs/revokedProviderIDs 全透传）', async () => {
    const deps = makeDeps();
    deps.syncIntegrationCredentials.mockResolvedValue({
      changed: true,
      missing: [],
      failures: [],
    });

    await handleModelCredentialsCommand(
      {
        type: 'model-credentials',
        resourceVersion: 'rv-9',
        payload: {
          providerKeys: [{ providerID: 'opencode-go', key: 'k1' }],
          providerConfigs: { p1: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['m1'] } },
          revokedProviderIDs: ['old-provider'],
        },
      } as WorkerCommand,
      null,
      null,
      deps,
    );

    expect(deps.syncIntegrationCredentials).toHaveBeenCalledTimes(1);
    expect(deps.syncIntegrationCredentials).toHaveBeenCalledWith({
      providerKeys: [{ providerID: 'opencode-go', key: 'k1' }],
      providerConfigs: { p1: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['m1'] } },
      revokedProviderIDs: ['old-provider'],
    });
    // 两条路径互不影响：文件注入照常执行（本例 auth.json 也会被注入）
    expect(deps.injectCredentials).toHaveBeenCalledTimes(1);
  });

  it('credential store 同步抛错 → warn 吞掉（文件注入已完成，worker 不下线）', async () => {
    const deps = makeDeps();
    deps.syncIntegrationCredentials.mockRejectedValue(new Error('serve 端点未就绪'));

    await handleModelCredentialsCommand(COMMAND, null, null, deps);

    expect(deps.injectCredentials).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('credential store 同步失败'),
    );
    expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining('注入失败'));
  });

  it('注入抛错时 store 同步仍执行（两面各自自愈，互不短路）', async () => {
    const deps = makeDeps();
    deps.injectCredentials.mockRejectedValue(new Error('写盘失败'));

    await handleModelCredentialsCommand(COMMAND, null, null, deps);

    expect(deps.syncIntegrationCredentials).toHaveBeenCalledTimes(1);
  });
});

describe('handleGitCredentials（todo 3：凭证文件幂等落盘，不重启 serve）', () => {
  const KEY: GitCredentialEntry[] = [
    {
      repoUrl: 'git@github.com:xishuhq/vteam.git',
      authType: 'ssh_key',
      key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret',
      fingerprint: 'sha256:abcd',
    },
    {
      repoUrl: 'https://github.com/xishuhq/tools.git',
      authType: 'https_token',
      key: 'ghp_topsecret',
      fingerprint: 'ghp_t****et',
    },
  ];

  function makeDeps() {
    return {
      readContent: jest.fn<Promise<string | null>, [string]>(),
      writeContent: jest.fn().mockReturnValue({ path: GIT_CREDS_FILE }),
      log: jest.fn(),
      warn: jest.fn(),
    };
  }

  it('现有凭证文件内容不同 → 写盘 + 更新日志（凭证变更，不重启 serve）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(
      buildGitCredsFile(
        [
          {
            repoUrl: 'https://github.com/xishuhq/old.git',
            authType: 'https_token',
            key: 'ghp_oldsecret',
            fingerprint: 'ghp_o****et',
          },
        ],
        '2026-08-12T08:00:00.000Z',
      ),
    );

    const result = await handleGitCredentials(KEY, deps);

    expect(deps.writeContent).toHaveBeenCalledWith(KEY);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(GIT_CREDS_FILE);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('凭证文件已更新（2 条）'),
    );
    // 关键断言：deps 无 requestRestart（git 工具每次执行读文件，写盘即生效，不重启 serve）
    expect((deps as Record<string, unknown>).requestRestart).toBeUndefined();
  });

  it('幂等：现有内容一致（复用 updatedAt）→ 不写盘、mtime 不变', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(
      buildGitCredsFile(KEY, '2026-08-12T08:00:00.000Z'),
    );

    const result = await handleGitCredentials(KEY, deps);

    expect(deps.writeContent).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('凭证文件未变化，跳过写入'),
    );
  });

  it('无现有凭证文件（容器重启后）→ 写盘（恢复路径）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(null);

    const result = await handleGitCredentials(KEY, deps);

    expect(deps.writeContent).toHaveBeenCalledWith(KEY);
    expect(result.changed).toBe(true);
  });

  it('credentials 负载缺失（非数组）→ warn 跳过，不写盘', async () => {
    const deps = makeDeps();

    const result = await handleGitCredentials(
      undefined as unknown as GitCredentialEntry[],
      deps,
    );

    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('credentials 负载缺失'),
    );
    expect(deps.writeContent).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });

  it('条目全部无效（空 repoUrl/key）→ 仍写盘但 warn 提示已过滤', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(null);
    const dirty = [
      { repoUrl: '  ', authType: 'ssh_key', key: 'sk', fingerprint: '' },
    ] as GitCredentialEntry[];

    const result = await handleGitCredentials(dirty, deps);

    expect(deps.warn).toHaveBeenCalledWith(
      expect.stringContaining('条目全部无效'),
    );
    expect(deps.writeContent).toHaveBeenCalledWith(dirty);
    expect(result.changed).toBe(true);
  });

  it('空数组 → 写空 credentials 数组（清下发语义）', async () => {
    const deps = makeDeps();
    deps.readContent.mockResolvedValue(null);

    const result = await handleGitCredentials([], deps);

    expect(deps.writeContent).toHaveBeenCalledWith([]);
    expect(result.changed).toBe(true);
    expect(deps.warn).not.toHaveBeenCalled();
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

  it('T1：上报值规范化为 semver 串（控制面按精确串相等过滤 worker）', async () => {
    // v2 原始输出全文 → 2.0.28（不能上报 `opencode v2.0.28` 全文）
    expect((await buildRegisterOptions(CONFIG, null, 'opencode v2.0.28', 'cli')).opencodeVersion).toBe('2.0.28');
    expect((await buildRegisterOptions(CONFIG, null, 'unknown', 'opencode v2.0.28')).opencodeVersion).toBe('2.0.28');
    expect((await buildRegisterOptions(CONFIG, null, '2.0.28', 'cli')).opencodeVersion).toBe('2.0.28');
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
      agentPolicies: { enabled: false, names: [] },
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

  it('T10：execPort 显式传入 → capabilities.execPort 上报（server 据此发现执行端点）', async () => {
    const opts = await buildRegisterOptions(
      CONFIG,
      4199,
      '1.18.15',
      'cli-version',
      undefined,
      undefined,
      4198,
    );
    expect(opts.capabilities.execPort).toBe(4198);
  });

  it('T10：execPort 缺省/undefined（端点启动失败）→ 注册不带 execPort', async () => {
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    expect(opts.capabilities.execPort).toBeUndefined();
    const overridden = await buildRegisterOptions(
      CONFIG,
      4199,
      '1.18.15',
      'cli-version',
      undefined,
      undefined,
      undefined,
    );
    expect(overridden.capabilities.execPort).toBeUndefined();
  });

  it('F4：capabilities.maxInstances 取 config.workerMaxInstances（默认配置 5）', async () => {
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    expect(opts.capabilities.maxInstances).toBe(5);
  });

  it('F4：config.workerMaxInstances 覆盖（env WORKER_MAX_INSTANCES=3 → 上报 3）', async () => {
    const opts = await buildRegisterOptions(
      { ...CONFIG, workerMaxInstances: 3 },
      4199,
      '1.18.15',
      'cli-version',
    );
    expect(opts.capabilities.maxInstances).toBe(3);
  });

  it('Todo 14：注入报告透传——注册选项携带 agentPolicies 能力位（成功：enabled=true + 6 名）', async () => {
    const names = ['vteam-plan', 'vteam-product', 'vteam-architect', 'vteam-developer', 'vteam-tester', 'vteam-project_manager'];
    const report: InjectReport = { skills: [], tools: [], mcpServers: [], agentPolicies: { enabled: true, names } };
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version', report);
    expect(opts.capabilities.agentPolicies).toEqual({ enabled: true, names });
  });

  it('Todo 14：注入失败/中性化——注册选项携带 enabled=false/names=[]', async () => {
    const report: InjectReport = { skills: [], tools: [], mcpServers: [], agentPolicies: { enabled: false, names: [] } };
    const opts = await buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version', report);
    expect(opts.capabilities.agentPolicies).toEqual({ enabled: false, names: [] });
  });
});

describe('warnLoopbackAdvertiseHost（上报地址启动提示）', () => {
  it('未显式设置 + 自动探测失败（回退 127.0.0.1）：输出一次醒目告警（含 baseUrl=127.0.0.1 与 WORKER_ADVERTISE_HOST 引导）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost({ ...CONFIG, workerAdvertiseHostExplicit: false, workerAdvertiseHost: 'http://127.0.0.1' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain('baseUrl=127.0.0.1');
      expect(message).toContain('WORKER_ADVERTISE_HOST=<控制面可达的 worker 地址>');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('告警指向**执行端点**（控制面真正拨的地址：<主机>:4198，鉴权 X-Worker-Token）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost({ ...CONFIG, workerAdvertiseHostExplicit: false, workerAdvertiseHost: 'http://127.0.0.1' });
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain('执行端点');
      expect(message).toContain('X-Worker-Token');
      expect(message).toContain(`:${CONFIG.workerExecPort}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('告警**不再**让运维为控制面把 serve 改成 0.0.0.0（v2 下控制面只连执行端点）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost({ ...CONFIG, workerAdvertiseHostExplicit: false, workerAdvertiseHost: 'http://127.0.0.1' });
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).not.toContain('OPENCODE_SERVE_HOSTNAME=0.0.0.0');
      expect(message).not.toContain('server 才能连上');
      expect(message).toContain('无需为控制面把 OPENCODE_SERVE_HOSTNAME 改成 0.0.0.0');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('未显式设置 + 自动探测成功（上报地址非 127.0.0.1）：console.log 输出已自动探测提示，不含 127.0.0.1 告警', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost({ ...CONFIG, workerAdvertiseHostExplicit: false, workerAdvertiseHost: 'http://192.168.1.10' });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const message = logSpy.mock.calls[0][0] as string;
      expect(message).toContain('已自动探测上报地址');
      expect(message).toContain('http://192.168.1.10');
      expect(message).toContain('WORKER_ADVERTISE_HOST=<控制面可达的 worker 地址>');
      // 控制面连的是执行端点（<主机>:4198），不是 serve 端口
      expect(message).toContain(`http://192.168.1.10:${CONFIG.workerExecPort}`);
      expect(message).toContain('执行端点');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('已显式设置（值恰好 http://127.0.0.1 的本地开发场景）：不提示（防误报）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost({ ...CONFIG, workerAdvertiseHost: 'http://127.0.0.1' });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('已显式设置非回环地址：不提示', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      warnLoopbackAdvertiseHost(CONFIG);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('T18：独立模式补写项目配置（防 browser 工具被内置插件静默遮蔽）', () => {
  /** 独立模式跳过控制面注入 ⇒ 注入器不写 `plugins` 段 ⇒ 必须由启动链补写。 */
  it('ensureStandaloneProjectConfig 把 "-opencode.browser" 写进 <workDir>/opencode.json 的 plugins 段', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-standalone-'));
    const injector = new ResourceInjector({
      serverUrl: 'http://server:3000',
      workerToken: 'tok',
      workerId: 'w_1',
      workDir,
    });
    ensureStandaloneProjectConfig(injector);

    const cfg = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { plugins?: string[] };
    expect(cfg.plugins).toContain('-opencode.browser');
  });

  it('补写失败只告警、不抛错（配置问题不阻断 worker 启动）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const broken = {
        applyMcpServers: () => {
          throw new Error('boom');
        },
      } as unknown as ResourceInjector;
      expect(() => ensureStandaloneProjectConfig(broken)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('独立模式：项目配置补写失败'),
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('注入工具数口径（「0 tools」可解释，不与拉取失败混淆）', () => {
  const report = (patch: Partial<InjectReport>): InjectReport => ({
    skills: [],
    tools: [],
    mcpServers: [],
    agentPolicies: { enabled: false, names: [] },
    ...patch,
  });

  it('目录有 232 条、实际渲染 0 条：日志同时报出两个数与跳过原因', () => {
    const text = formatToolInjectionSummary(
      report({
        tools: [],
        toolBreakdown: {
          fetched: 232,
          mcpType: 225,
          builtin: 6,
          missingExecution: 0,
          injected: 0,
        },
      }),
    );

    expect(text).toContain('0 个自定义工具插件');
    expect(text).toContain('控制面工具目录 232 条');
    expect(text).toContain('mcp 型 225 条');
    expect(text).toContain('builtin 6 条');
  });

  it('目录为空：明说"平台没有启用的工具定义"，且声明这不是拉取失败', () => {
    const text = formatToolInjectionSummary(
      report({
        tools: [],
        toolBreakdown: {
          fetched: 0,
          mcpType: 0,
          builtin: 0,
          missingExecution: 0,
          injected: 0,
        },
      }),
    );

    expect(text).toContain('控制面工具目录 0 条');
    expect(text).toContain('平台当前没有启用的工具定义');
    expect(text).toContain('不是拉取失败');
  });

  it('有工具被跳过：报出缺执行细节的条数（真实缺口）', () => {
    const text = formatToolInjectionSummary(
      report({
        tools: ['gitee-issue'],
        toolBreakdown: {
          fetched: 3,
          mcpType: 1,
          builtin: 0,
          missingExecution: 1,
          injected: 1,
        },
      }),
    );

    expect(text).toContain('1 个自定义工具插件');
    expect(text).toContain('缺少执行细节 1 条未渲染');
  });

  it('旧形态报告（无明细）：只报渲染数，不炸', () => {
    const text = formatToolInjectionSummary(report({ tools: ['a', 'b'] }));
    expect(text).toBe('2 个自定义工具插件');
  });
});

describe('注入器必须接日志出口（否则注入器自身的告警被静默丢弃）', () => {
  it('createResourceInjector 产出的注入器带 logger', () => {
    const injector = createResourceInjector({
      serverUrl: 'http://server:3000',
      workerToken: 'tok',
      workerId: 'w_1',
      workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-injector-logger-')),
    });

    expect(injector.hasLogger).toBe(true);
  });

  it('注入器的告警真的会打到 console（不是被吞掉的闭包）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-injector-warn-'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const injector = createResourceInjector({
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_1',
        workDir,
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            items: [
              {
                id: 'tl_1',
                action: 'jenkins-build',
                name: 'Jenkins 构建',
                source: 'custom',
                execution: 'cli',
                schema: { type: 'object', properties: {} },
              },
            ],
            total: 1,
            page: 1,
            pageSize: 100,
          }),
        })) as unknown as typeof fetch,
      });

      await injector.injectToolsDetailed();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('缺少执行细节'),
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('事件上送必须接日志出口（否则事件丢失完全无声）', () => {
  it('投递失败会告警并报出事件 id（EventSender 只记日志不抛 ⇒ 日志是唯一信号）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sender = createEventSender({
        serverUrl: 'http://server:3000',
        workerId: 'w_1',
        workerToken: 'tok',
        maxRetries: 1,
        retryBaseDelayMs: 1,
        fetchImpl: jest.fn(async () => {
          throw new Error('network down');
        }) as unknown as typeof fetch,
      });

      await sender.send('task.completed', { taskId: 't_1' });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[event]'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('重试 1 次仍失败，丢弃'),
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('B1：驱动鉴权口令必须取 serve 的**实际**口令（effectiveServerPassword）', () => {
  it('口令来源现取 serve 的 effectiveServerPassword（自动生成的那份也拿得到）', () => {
    // 构造那一刻 serve 还没起来 ⇒ 自动生成的密码尚不存在（effectiveServerPassword = null）
    const serve: { effectiveServerPassword: string | null } = { effectiveServerPassword: null };
    const GENERATED_VALUE = 'generated-pw';
    const provider = buildServePasswordProvider(serve);
    expect(provider()).toBeNull();

    // serve 起来、捕获到 v2 自动生成的密码后 ⇒ 口令来源立刻跟着变
    serve.effectiveServerPassword = GENERATED_VALUE;
    expect(provider()).toBe(GENERATED_VALUE);
  });

  it('口令来源是**函数**（每次请求时现取），不是构造那一刻固化的字符串', () => {
    // 两个**明显是假的**、彼此不同的口令值；常量绑定 ⇒ 字面量不直接贴在 *Password 键上（否则会被密钥扫描器当成真实口令误报）
    const INITIAL_VALUE = 'initial-pw';
    const UPDATED_VALUE = 'updated-pw';
    const serve: { effectiveServerPassword: string | null } = { effectiveServerPassword: INITIAL_VALUE };
    const provider = buildServePasswordProvider(serve);
    expect(provider()).toBe(INITIAL_VALUE);
    serve.effectiveServerPassword = UPDATED_VALUE;
    expect(provider()).toBe(UPDATED_VALUE);
  });
});

describe('B2：git 凭证必须落到**插件可见**的 HOME（opencode 隔离配置域）', () => {
  const ENTRY: GitCredentialEntry = {
    repoUrl: 'git@github.com:xishuhq/vteam.git',
    authType: 'ssh_key',
    key: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret',
    fingerprint: 'sha256:abcd',
  };

  it('写入隔离配置域 HOME ⇒ 插件（serve 子进程，HOME 被重定向）读得到', () => {
    const scope = resolveIsolationScope({
      OPENCODE_ISOLATION_ROOT: path.join(TMP_HOME, 'iso'),
    });
    const result = writeGitCredsToServeScope([ENTRY], scope);

    // 插件里的路径 = path.join(os.homedir(), '.keta-git-creds.json')，而 serve 子进程的
    // HOME = scope.home ⇒ 插件读的就是这一份
    const pluginPath = path.join(scope.home, '.keta-git-creds.json');
    expect(result.path).toBe(pluginPath);
    expect(fs.existsSync(pluginPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(pluginPath, 'utf8')) as {
      credentials: GitCredentialEntry[];
    };
    expect(parsed.credentials.map((c) => c.repoUrl)).toEqual([ENTRY.repoUrl]);
    expect(fs.statSync(pluginPath).mode & 0o777).toBe(0o600);
  });

  it('worker 自己的 HOME 那份也写（幂等对比的读取面 + 兼容既有读法）', () => {
    const scope = resolveIsolationScope({
      OPENCODE_ISOLATION_ROOT: path.join(TMP_HOME, 'iso'),
    });
    writeGitCredsToServeScope([ENTRY], scope);

    const workerHomePath = path.join(TMP_HOME, '.keta-git-creds.json');
    expect(fs.existsSync(workerHomePath)).toBe(true);
    expect(fs.readFileSync(workerHomePath, 'utf8')).toBe(
      fs.readFileSync(path.join(scope.home, '.keta-git-creds.json'), 'utf8'),
    );
  });
});
