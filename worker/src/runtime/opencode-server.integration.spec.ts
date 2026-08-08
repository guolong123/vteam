/**
 * OpencodeServer 集成测试（真实 spawn，不 mock）。
 *
 * 用假 serve 脚本（bash 解析 --port + node 起 HTTP 200 服务）验证：
 * - 真实 spawn → 健康检查真实 HTTP 200 → start() 返回 baseUrl
 * - stop() 后进程组无残留（kill(-pid) 同时清 bash 与 node）、端口释放
 * - 真实 net 端口占用 → +1 重试
 * 脚本写在 os.tmpdir()，测试结束清理；不得残留孤儿进程。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { OpencodeServer } from './opencode-server';

/** 假 serve 脚本：解析 --port/--version，起 HTTP 200 服务（bash fork node，验证进程组清理）。 */
const FAKE_SERVE_SCRIPT = `#!/usr/bin/env bash
PORT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --version) echo "1.18.15-fake"; exit 0 ;;
    *) shift ;;
  esac
done
echo "opencode server listening on http://127.0.0.1:\${PORT}"
node -e "const http=require('http');http.createServer((q,r)=>{r.writeHead(200);r.end('ok');}).listen(\${PORT},'127.0.0.1');" &
wait
`;

const tmpFiles: string[] = [];

function writeFakeServeScript(): string {
  const file = path.join(os.tmpdir(), `fake-serve-${process.pid}-${Date.now()}-${tmpFiles.length}.sh`);
  fs.writeFileSync(file, FAKE_SERVE_SCRIPT);
  fs.chmodSync(file, 0o755);
  tmpFiles.push(file);
  return file;
}

function httpStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
  });
}

/** 占用一个端口并返回释放函数。 */
function occupyPort(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(() => server.close());
    });
  });
}

afterAll(() => {
  for (const file of tmpFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 忽略
    }
  }
});

describe('OpencodeServer 真实 spawn 集成', () => {
  jest.setTimeout(15_000);

  it('start 返回 baseUrl，健康检查真实 200；stop 后进程组无残留、端口释放', async () => {
    const script = writeFakeServeScript();
    const server = new OpencodeServer({
      command: script,
      port: 0,
      healthCheckTimeoutMs: 8000,
      healthCheckIntervalMs: 100,
    });

    const baseUrl = await server.start();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.isRunning).toBe(true);
    expect(server.pid).not.toBeNull();
    expect(server.version).toBe('1.18.15-fake');

    const port = server.port!;
    expect(await httpStatus(port)).toBe(200);
    const groupLeaderPid = server.pid!;

    await server.stop();
    expect(server.isRunning).toBe(false);
    expect(server.baseUrl).toBeNull();

    // 进程组组长已不存在（kill(-pid) 已清进程组）
    expect(() => process.kill(groupLeaderPid, 0)).toThrow();
    // 端口已释放（连接被拒）
    expect(await httpStatus(port)).toBe(0);
  });

  it('真实端口占用：basePort 被占 → +1 重试', async () => {
    const basePort = 42500;
    let release: (() => void) | undefined;
    try {
      release = await occupyPort(basePort);
    } catch {
      // 端口已被环境占用（EADDRINUSE），测试前提依然成立
    }
    try {
      const script = writeFakeServeScript();
      const server = new OpencodeServer({
        command: script,
        port: basePort,
        healthCheckTimeoutMs: 8000,
        healthCheckIntervalMs: 100,
      });
      const baseUrl = await server.start();
      expect(baseUrl).toBe(`http://127.0.0.1:${basePort + 1}`);
      expect(server.port).toBe(basePort + 1);
      expect(await httpStatus(basePort + 1)).toBe(200);
      await server.stop();
      expect(() => process.kill(server.pid!, 0)).toThrow();
    } finally {
      release?.();
    }
  });

  it('stop 幂等：重复调用无副作用', async () => {
    const script = writeFakeServeScript();
    const server = new OpencodeServer({ command: script, port: 0 });
    await server.start();
    await server.stop();
    await server.stop();
    expect(server.isRunning).toBe(false);
  });
});
