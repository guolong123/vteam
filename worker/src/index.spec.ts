/**
 * index.ts 注册能力组装测试（T3 D2：baseUrl 上报 + T4c：重启后重新注册数据源）。
 * 仅测 buildCapabilities/buildRegisterOptions 纯函数；main() 由 require.main 守卫隔离，import 不触发 worker 启动。
 */
import { WorkerConfig } from './config';
import { WorkerCommand } from './protocol/worker-protocol';
import { buildCapabilities, buildRegisterOptions, dispatchCommands, onCommands } from './index';

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
};

describe('buildCapabilities（D2：serve 对 server 公布 baseUrl）', () => {
  it('serve 启动后 port 已知：上报 port + baseUrl = advertiseHost:port', () => {
    const caps = buildCapabilities(4199, 'http://worker');
    expect(caps.port).toBe(4199);
    expect(caps.baseUrl).toBe('http://worker:4199');
  });

  it('advertiseHost 尾斜杠容忍（容器 compose 写 http://worker/ 不产生双斜杠）', () => {
    expect(buildCapabilities(4199, 'http://worker/').baseUrl).toBe('http://worker:4199');
    expect(buildCapabilities(4199, 'http://worker').baseUrl).toBe('http://worker:4199');
  });

  it('serve 未就绪（port=null）：不报 port/baseUrl（避免 server 连死地址）', () => {
    const caps = buildCapabilities(null, 'http://worker');
    expect(caps.port).toBeUndefined();
    expect(caps.baseUrl).toBeUndefined();
  });

  it('本地默认 advertiseHost=http://127.0.0.1：baseUrl 指向回环', () => {
    expect(buildCapabilities(4199, 'http://127.0.0.1').baseUrl).toBe('http://127.0.0.1:4199');
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
});

describe('buildRegisterOptions（T4c：重启后重新注册携带新端口）', () => {
  it('端口变化 → capabilities.port/baseUrl 更新（重启后重新注册数据源）', () => {
    const before = buildRegisterOptions(CONFIG, 4199, '1.18.15', 'cli-version');
    const after = buildRegisterOptions(CONFIG, 53001, '1.18.15', 'cli-version');

    expect(before.capabilities.port).toBe(4199);
    expect(before.capabilities.baseUrl).toBe('http://worker:4199');
    // 重启后随机端口变化：重新组装注册选项即携带新端口（T4c reRegister 复用）
    expect(after.capabilities.port).toBe(53001);
    expect(after.capabilities.baseUrl).toBe('http://worker:53001');
    expect(after.workerId).toBe('w_host');
  });

  it('serveVersion 非 unknown 优先，否则回退 CLI 版本', () => {
    expect(buildRegisterOptions(CONFIG, null, '1.18.15', 'fallback').opencodeVersion).toBe('1.18.15');
    expect(buildRegisterOptions(CONFIG, null, 'unknown', 'fallback').opencodeVersion).toBe('fallback');
  });

  it('serve 未就绪（port=null）：capabilities 不含 port/baseUrl（不报死地址）', () => {
    const opts = buildRegisterOptions(CONFIG, null, 'unknown', 'cli-version');
    expect(opts.capabilities.port).toBeUndefined();
    expect(opts.capabilities.baseUrl).toBeUndefined();
  });
});
