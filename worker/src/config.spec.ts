/**
 * config.ts 环境配置解析测试（F4：WORKER_MAX_INSTANCES 并发上限配置化 + 自动探测上报地址）。
 * 仅测 loadConfig/detectLocalIPv4 纯函数；X_WORKER_TOKEN 必填（与协议约定一致）。
 * WORKER_ADVERTISE_HOST 缺省走 detectLocalIPv4 自动探测——jest 环境 os.networkInterfaces
 * 为不可重定义的 getter（jest.spyOn 抛 Cannot redefine property），故模块级 jest.mock('os')
 * 部分 mock networkInterfaces，稳定探测结果避免真实网卡干扰缺省断言。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  detectLocalIPv4,
  ensureIsolationScope,
  loadConfig,
  resolveIsolationScope,
} from './config';

jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os');
  // 默认返回空接口表：未显式 mock 的用例探测结果为 undefined（回落 127.0.0.1）
  return {
    ...actual,
    networkInterfaces: jest.fn().mockReturnValue({}),
    homedir: jest.fn(actual.homedir),
  };
});

const mockNetworkInterfaces = os.networkInterfaces as jest.Mock;
const mockHomedir = os.homedir as jest.Mock;

const BASE_ENV = {
  X_WORKER_TOKEN: 'tok',
};

const LOOPBACK = [
  { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
];

/** mock os.networkInterfaces：全回环（无可用非回环 IPv4），探测必失败回退 127.0.0.1。 */
function mockAllLoopback(): void {
  mockNetworkInterfaces.mockReturnValue({ lo: LOOPBACK });
}

describe('WORKER_MAX_INSTANCES（F4：worker 并发上限配置化）', () => {
  it('缺省：默认 5（合理并发上限，env 可覆盖）', () => {
    expect(loadConfig(BASE_ENV).workerMaxInstances).toBe(5);
    expect(loadConfig({ ...BASE_ENV, WORKER_MAX_INSTANCES: '' }).workerMaxInstances).toBe(5);
  });

  it('env 覆盖：WORKER_MAX_INSTANCES=3 → 3', () => {
    expect(loadConfig({ ...BASE_ENV, WORKER_MAX_INSTANCES: '3' }).workerMaxInstances).toBe(3);
  });

  it('env 覆盖：大并发上限合法（如 10）', () => {
    expect(loadConfig({ ...BASE_ENV, WORKER_MAX_INSTANCES: '10' }).workerMaxInstances).toBe(10);
  });

  it('非法值（≤0/NaN/非整数）兜底默认 5 并打 warn（不抛错，防回归单实例）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const raw of ['0', '-1', 'abc', '1.5', '   ']) {
        expect(loadConfig({ ...BASE_ENV, WORKER_MAX_INSTANCES: raw }).workerMaxInstances).toBe(5);
      }
      expect(warnSpy).toHaveBeenCalledTimes(4); // 空串 '' 在缺省分支直接回落，不打 warn
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('WORKER_TOTAL_TIMEOUT_MS（CHANGE 2：执行总时长上限，opt-in）', () => {
  it('缺省/空串/空白：默认 0（禁用——保持「首字后无完成超时」契约）', () => {
    expect(loadConfig(BASE_ENV).workerTotalTimeoutMs).toBe(0);
    expect(loadConfig({ ...BASE_ENV, WORKER_TOTAL_TIMEOUT_MS: '' }).workerTotalTimeoutMs).toBe(0);
    expect(loadConfig({ ...BASE_ENV, WORKER_TOTAL_TIMEOUT_MS: '   ' }).workerTotalTimeoutMs).toBe(0);
  });

  it('env 覆盖：WORKER_TOTAL_TIMEOUT_MS=600000 → 600000', () => {
    expect(
      loadConfig({ ...BASE_ENV, WORKER_TOTAL_TIMEOUT_MS: '600000' }).workerTotalTimeoutMs,
    ).toBe(600000);
  });

  it('显式 0 = 禁用（合法值，非缺省兜底）', () => {
    expect(loadConfig({ ...BASE_ENV, WORKER_TOTAL_TIMEOUT_MS: '0' }).workerTotalTimeoutMs).toBe(0);
  });

  it('非法值（负数/NaN/非整数）抛错（parseNonNegativeInt 快速失败语义，区别于并发上限的兜底语义）', () => {
    for (const raw of ['-1', 'abc', '1.5']) {
      expect(() =>
        loadConfig({ ...BASE_ENV, WORKER_TOTAL_TIMEOUT_MS: raw }),
      ).toThrow(/WORKER_TOTAL_TIMEOUT_MS/);
    }
  });
});

describe('WORKER_FIRST_TOKEN_TIMEOUT_MS（执行端点首字超时，缺省禁用）', () => {
  it('缺省/空串：默认 0（禁用首字超时——长脚本/等权限不误杀；env 可 opt-in）', () => {
    expect(loadConfig(BASE_ENV).workerFirstTokenTimeoutMs).toBe(0);
    expect(loadConfig({ ...BASE_ENV, WORKER_FIRST_TOKEN_TIMEOUT_MS: '' }).workerFirstTokenTimeoutMs).toBe(0);
  });

  it('env 覆盖：WORKER_FIRST_TOKEN_TIMEOUT_MS=300000 → 300000', () => {
    expect(
      loadConfig({ ...BASE_ENV, WORKER_FIRST_TOKEN_TIMEOUT_MS: '300000' })
        .workerFirstTokenTimeoutMs,
    ).toBe(300000);
  });

  it('显式 0 = 禁用（合法值，非缺省兜底）', () => {
    expect(
      loadConfig({ ...BASE_ENV, WORKER_FIRST_TOKEN_TIMEOUT_MS: '0' })
        .workerFirstTokenTimeoutMs,
    ).toBe(0);
  });
});

describe('WORKER_ADVERTISE_HOST 显式标记（外部/跨机 worker 可达地址引导）', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('缺省（未设置）+ 自动探测失败（全回环）：workerAdvertiseHostExplicit=false 且回落 http://127.0.0.1', () => {
    mockAllLoopback();
    const config = loadConfig(BASE_ENV);
    expect(config.workerAdvertiseHostExplicit).toBe(false);
    expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
  });

  it('缺省（未设置）+ 自动探测命中：workerAdvertiseHostExplicit=false 且上报地址为探测到的 http://<ip>', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: LOOPBACK,
      eth0: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.10/24' }],
    });
    const config = loadConfig(BASE_ENV);
    expect(config.workerAdvertiseHostExplicit).toBe(false);
    expect(config.workerAdvertiseHost).toBe('http://192.168.1.10');
  });

  it('显式设置（即使值恰好为 http://127.0.0.1 的本地开发场景）：workerAdvertiseHostExplicit=true 不误报，且不触发自动探测', () => {
    const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: 'http://127.0.0.1' });
    expect(config.workerAdvertiseHostExplicit).toBe(true);
    expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
    expect(mockNetworkInterfaces).not.toHaveBeenCalled();
  });

  it('显式设置非回环地址：workerAdvertiseHostExplicit=true', () => {
    const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: 'http://192.168.1.10' });
    expect(config.workerAdvertiseHostExplicit).toBe(true);
    expect(config.workerAdvertiseHost).toBe('http://192.168.1.10');
  });

  it('显式设置空串/空白：视为未设置（自动探测失败时回落默认 + 标记 false，启动告警仍触发）', () => {
    mockAllLoopback();
    for (const raw of ['', '   ']) {
      const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: raw });
      expect(config.workerAdvertiseHostExplicit).toBe(false);
      expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
    }
  });
});

describe('WORKER_STANDALONE（独立模式：跳过注册/心跳/资源拉取）', () => {
  it('缺省/空串：standalone=false（默认现行注册模式）', () => {
    expect(loadConfig(BASE_ENV).standalone).toBe(false);
    expect(loadConfig({ ...BASE_ENV, WORKER_STANDALONE: '' }).standalone).toBe(false);
    expect(loadConfig({ ...BASE_ENV, WORKER_STANDALONE: '   ' }).standalone).toBe(false);
  });

  it('true 分支：true/1/yes/on（忽略大小写）→ standalone=true', () => {
    for (const raw of ['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'On', ' true ']) {
      expect(loadConfig({ ...BASE_ENV, WORKER_STANDALONE: raw }).standalone).toBe(true);
    }
  });

  it('false 分支：false/0/no/off（忽略大小写）→ standalone=false', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'NO', 'off']) {
      expect(loadConfig({ ...BASE_ENV, WORKER_STANDALONE: raw }).standalone).toBe(false);
    }
  });

  it('非法值（如 maybe/2）：打 warn 回落默认 false（不抛错，误配不阻断启动）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig({ ...BASE_ENV, WORKER_STANDALONE: 'maybe' }).standalone).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WORKER_STANDALONE'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('OPENCODE_V2_ENABLED（T18：vteam 侧驱动模式开关已单轨）', () => {
  it('缺省/空串：默认 true（目标契约 v2）', () => {
    expect(loadConfig(BASE_ENV).opencodeV2Enabled).toBe(true);
    expect(loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: '' }).opencodeV2Enabled).toBe(true);
    expect(loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: '   ' }).opencodeV2Enabled).toBe(true);
  });

  it('true 分支：true/1/yes/on（忽略大小写）→ true', () => {
    for (const raw of ['true', 'TRUE', '1', 'yes', 'YES', 'on', ' true ']) {
      expect(loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: raw }).opencodeV2Enabled).toBe(true);
    }
  });

  it('T18：false 分支 → **响亮失败**（v1 驱动已删除；回退只能回滚镜像/代码到 v1.0.x）', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'NO', 'off']) {
      expect(() => loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: raw })).toThrow(
        /OPENCODE_V2_ENABLED=false 已不再支持/,
      );
      expect(() => loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: raw })).toThrow(
        /v1 驱动已随 v2 切换移除/,
      );
      // 文案必须指向真正的回退手段（回滚镜像/代码 + 回滚数据卷）。
      expect(() => loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: raw })).toThrow(
        /v1\.0\.x/,
      );
    }
  });

  it('非法值（如 maybe）：打 warn 回落默认 true（不抛错，误配不阻断启动）', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadConfig({ ...BASE_ENV, OPENCODE_V2_ENABLED: 'maybe' }).opencodeV2Enabled).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPENCODE_V2_ENABLED'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('detectLocalIPv4（自动探测本机非回环 IPv4）', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('正常命中：跳过回环，取第一个非 internal 的 IPv4（按 networkInterfaces 返回顺序）', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: LOOPBACK,
      eth0: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.10/24' }],
    });
    expect(detectLocalIPv4()).toBe('192.168.1.10');
  });

  it('跳过虚拟网卡（docker/veth/br-/vnic/virbr/cni/flannel 前缀）：取真实网卡地址', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: LOOPBACK,
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:xx:xx:xx:xx', internal: false, cidr: '172.17.0.1/16' }],
      veth1a2b: [{ address: '172.18.0.2', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:xx:xx:xx:xx', internal: false, cidr: '172.18.0.2/16' }],
      'br-abc123': [{ address: '172.19.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:xx:xx:xx:xx', internal: false, cidr: '172.19.0.1/16' }],
      vnic0: [{ address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '10.0.0.1/24' }],
      virbr0: [{ address: '192.168.122.1', netmask: '255.255.255.0', family: 'IPv4', mac: '52:54:00:xx:xx:xx', internal: false, cidr: '192.168.122.1/24' }],
      eth0: [{ address: '10.88.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:01', internal: false, cidr: '10.88.1.5/24' }],
    });
    expect(detectLocalIPv4()).toBe('10.88.1.5');
  });

  it('全回环/仅 IPv6：无命中返回 undefined', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo: LOOPBACK,
      eth0: [
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, scopeid: 2, cidr: 'fe80::1/64' },
        { address: '::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, scopeid: 0, cidr: '::1/128' },
      ],
    });
    expect(detectLocalIPv4()).toBeUndefined();
  });
});

describe('T16b：resolveIsolationScope（隔离配置域布局）', () => {
  beforeEach(() => {
    mockHomedir.mockReturnValue('/data/root');
  });

  afterEach(() => {
    mockHomedir.mockRestore();
  });

  it('缺省根 = <HOME>/.opencode-iso，五个 XDG/HOME 落点全在根下', () => {
    const scope = resolveIsolationScope({});
    expect(scope.root).toBe(path.join('/data/root', '.opencode-iso'));
    expect(scope.home).toBe(path.join(scope.root, 'home'));
    expect(scope.configHome).toBe(path.join(scope.root, 'config'));
    expect(scope.dataHome).toBe(path.join(scope.root, 'data'));
    expect(scope.stateHome).toBe(path.join(scope.root, 'state'));
    expect(scope.cacheHome).toBe(path.join(scope.root, 'cache'));
  });

  it('配置/凭据/日志/会话库的落点与 v2 的目录约定一致', () => {
    const scope = resolveIsolationScope({});
    expect(scope.configFile).toBe(
      path.join(scope.root, 'config', 'opencode', 'opencode.json'),
    );
    expect(scope.authJsonFile).toBe(
      path.join(scope.root, 'data', 'opencode', 'auth.json'),
    );
    expect(scope.logFile).toBe(
      path.join(scope.root, 'data', 'opencode', 'log', 'opencode.log'),
    );
    expect(scope.dbFile).toBe(
      path.join(scope.root, 'data', 'opencode', 'opencode.db'),
    );
  });

  it('会话库与凭据同目录（D11：同一持久化卷，重启不丢会话历史）', () => {
    const scope = resolveIsolationScope({});
    expect(path.dirname(scope.dbFile)).toBe(path.dirname(scope.authJsonFile));
  });

  it('OPENCODE_ISOLATION_ROOT 可覆盖根目录（运维把隔离域挪到别的卷）', () => {
    const scope = resolveIsolationScope({
      OPENCODE_ISOLATION_ROOT: '/mnt/persist/opencode-iso',
    });
    expect(scope.root).toBe('/mnt/persist/opencode-iso');
    expect(scope.dataHome).toBe(path.join('/mnt/persist/opencode-iso', 'data'));
  });

  it('loadConfig 带上隔离配置域（worker 启动即用同一块作用域）', () => {
    const config = loadConfig({ X_WORKER_TOKEN: 'tok' });
    expect(config.isolationScope.root).toBe(
      path.join('/data/root', '.opencode-iso'),
    );
  });

  it('ensureIsolationScope：五个落点目录都被建出来（serve 的 HOME/XDG_* 都要存在）', () => {
    const root = path.join(os.tmpdir(), `vteam-iso-${process.pid}-${Date.now()}`);
    const scope = resolveIsolationScope({ OPENCODE_ISOLATION_ROOT: root });
    const created = ensureIsolationScope(scope);
    expect(created.length).toBe(6);
    for (const dir of [
      scope.root,
      scope.home,
      scope.configHome,
      scope.dataHome,
      scope.stateHome,
      scope.cacheHome,
    ]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
