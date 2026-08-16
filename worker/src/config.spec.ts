/**
 * config.ts 环境配置解析测试（F4：WORKER_MAX_INSTANCES 并发上限配置化）。
 * 仅测 loadConfig 纯函数；X_WORKER_TOKEN 必填（与协议约定一致）。
 */
import { loadConfig } from './config';

const BASE_ENV = {
  X_WORKER_TOKEN: 'tok',
};

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
  it('缺省（未设置）：workerAdvertiseHostExplicit=false 且回落 http://127.0.0.1', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.workerAdvertiseHostExplicit).toBe(false);
    expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
  });

  it('显式设置（即使值恰好为 http://127.0.0.1 的本地开发场景）：workerAdvertiseHostExplicit=true 不误报', () => {
    const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: 'http://127.0.0.1' });
    expect(config.workerAdvertiseHostExplicit).toBe(true);
    expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
  });

  it('显式设置非回环地址：workerAdvertiseHostExplicit=true', () => {
    const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: 'http://192.168.1.10' });
    expect(config.workerAdvertiseHostExplicit).toBe(true);
    expect(config.workerAdvertiseHost).toBe('http://192.168.1.10');
  });

  it('显式设置空串/空白：视为未设置（回落默认 + 标记 false，启动告警仍触发）', () => {
    for (const raw of ['', '   ']) {
      const config = loadConfig({ ...BASE_ENV, WORKER_ADVERTISE_HOST: raw });
      expect(config.workerAdvertiseHostExplicit).toBe(false);
      expect(config.workerAdvertiseHost).toBe('http://127.0.0.1');
    }
  });
});
