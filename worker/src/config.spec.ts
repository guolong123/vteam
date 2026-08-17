/**
 * config.ts 环境配置解析测试（F4：WORKER_MAX_INSTANCES 并发上限配置化 + 自动探测上报地址）。
 * 仅测 loadConfig/detectLocalIPv4 纯函数；X_WORKER_TOKEN 必填（与协议约定一致）。
 * WORKER_ADVERTISE_HOST 缺省走 detectLocalIPv4 自动探测——jest 环境 os.networkInterfaces
 * 为不可重定义的 getter（jest.spyOn 抛 Cannot redefine property），故模块级 jest.mock('os')
 * 部分 mock networkInterfaces，稳定探测结果避免真实网卡干扰缺省断言。
 */
import * as os from 'os';
import { detectLocalIPv4, loadConfig } from './config';

jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os');
  // 默认返回空接口表：未显式 mock 的用例探测结果为 undefined（回落 127.0.0.1）
  return { ...actual, networkInterfaces: jest.fn().mockReturnValue({}) };
});

const mockNetworkInterfaces = os.networkInterfaces as jest.Mock;

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
