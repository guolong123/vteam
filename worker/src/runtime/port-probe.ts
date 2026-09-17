/**
 * 端口探测 + 健康检查 HTTP（从 opencode-server 拆出，单一职责：探活 ≠ 进程生命周期）。
 * 纯函数，无状态；opencode-server 只负责 spawn/stop/日志缓冲编排。
 */

import * as http from 'http';
import * as net from 'net';

/** worker 内部访问 serve 的稳定地址：恒回环（serve 绑定 0.0.0.0 时同容器回环仍可达） */
const LOOPBACK_HOSTNAME = '127.0.0.1';

/** 用 net.createServer 探测端口是否空闲（bind 成功即空闲，随即关闭）。 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, LOOPBACK_HOSTNAME, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 让 OS 分配一个随机空闲端口（bind 0，读回实际端口后关闭）。 */
export function getRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOSTNAME, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** GET 指定 URL，返回 statusCode；网络错/超时抛错。 */
export function httpGetStatus(url: string, authHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
    const req = http.get(url, { headers, timeout: 2000 }, (res) => {
      // 必须消费响应体，否则 keep-alive 连接不释放
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('健康检查请求超时')));
    req.on('error', reject);
  });
}
