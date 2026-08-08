/**
 * worker 独立入口（T2 最小骨架 + T3 serve 挂载 + T4 V1Driver 暴露 + T6 注册/心跳/事件通道）。
 *
 * 职责：加载配置 → 打印启动信息（workerId / serverUrl / opencode 版本探测）→
 * 启动 OpencodeServer（spawn opencode serve，T3）→ 创建 V1Driver（T4，封装 serve
 * REST API，serve 就绪后注入 baseUrl，供 T6/T10 会话执行）→ 注册（T6：X-Worker-Token，
 * 失败指数退避重试，仍失败即退出）→ 按 server 返回的 heartbeatIntervalMs 定时心跳
 * （顺带上报 serve 健康）→ SIGTERM/SIGINT 优雅退出（先停心跳 → flush 待发事件 →
 * stop serve 进程组 → exit）。
 *
 * ⚠️ 本文件刻意不含：git 凭证注入（T5 由 T3 serve 注入点承接）、
 * 事件内容语义（T9 server 侧消费）；事件上送通道（EventSender）已就绪供会话上报。
 */

import { spawnSync } from 'child_process';
import { loadConfig, WorkerConfig } from './config';
import { EventSender } from './client/event-client';
import {
  registerWorkerWithRetry,
  sendHeartbeat,
} from './client/registry-client';
import { V1Driver } from './driver/v1-driver';
import { GIT_TOOLS } from './git/git-tools';
import { getLoad } from './instance-tracker';
import { WorkerCapabilities, WorkerHealth, WorkerLoad } from './protocol/worker-protocol';
import { OpencodeServer } from './runtime/opencode-server';

/** 探测 opencode CLI 版本（T3 前仅用于启动信息展示；失败不阻断启动）。 */
export function detectOpencodeVersion(): string {
  try {
    const result = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const version = (result.stdout ?? '').trim() || (result.stderr ?? '').trim();
    return version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printStartup(config: WorkerConfig, opencodeVersion: string): void {
  console.log(`[worker] 启动中:
  workerId            = ${config.workerId}
  workerName          = ${config.workerName}
  serverUrl           = ${config.serverUrl}
  opencodeServePort   = ${config.opencodeServePort === 0 ? '0（OS 随机空闲端口）' : config.opencodeServePort}
  opencodeServeAuth   = ${config.serverPassword ? 'Basic Auth（已设 OPENCODE_SERVER_PASSWORD）' : '无（serve 不设鉴权）'}
  heartbeatIntervalMs = ${config.heartbeatIntervalMs}
  logLevel            = ${config.logLevel}
  opencodeVersion     = ${opencodeVersion}`);
}

/**
 * T6：注册能力声明（T10 细化并发上限/技能清单；当前单实例 + 已注入的 git 工具族）。
 * F2 C2：serve 实际监听端口必须随注册上报——随机端口（OPENCODE_SERVE_PORT=0）场景下
 * server 侧 WorkerClient.resolveBaseUrl 读 capabilities.port，缺失会回退死端口 4199。
 */
function buildCapabilities(port: number | null): WorkerCapabilities {
  return {
    maxInstances: 1,
    skills: [],
    tools: GIT_TOOLS.map((tool) => tool.name),
    port: port ?? undefined,
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const opencodeVersion = detectOpencodeVersion();

  printStartup(config, opencodeVersion);

  // T3：拉起 opencode serve（spawn detached + 健康检查；失败即退出）。
  const serveServer = new OpencodeServer({
    port: config.opencodeServePort,
    serverPassword: config.serverPassword,
  });

  // T4：V1Driver（封装 serve REST API）；serve 随机端口启动成功后在 .then 注入 baseUrl。
  // 会话执行链路（createSession 驱动 → 事件上送）待 T10 回流接线；实例计数挂钩点见
  // v1-driver.ts createSession 注释（F2 M4）。
  const driver = new V1Driver({
    serverPassword: config.serverPassword,
  });

  // T6：事件上送通道（进程内单例，seq 从 1 起单调递增 + F2 M1 bootId 区分重启）。
  // 事件产生（session.updated/task.completed 等）待 T10 回流接线（C1 并行任务）。
  const eventSender = new EventSender({
    serverUrl: config.serverUrl,
    workerId: config.workerId,
    workerToken: config.workerToken,
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // 优雅退出：SIGTERM/SIGINT 统一收口，防重复处理；
  // 先停心跳 → flush 待发事件 → stop serve 进程组再 exit。
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[worker] 收到 ${signal}，正在退出...`);
    void (async () => {
      try {
        stopHeartbeat();
        await eventSender.flush();
        if (serveServer.isRunning) {
          await serveServer.stop();
        }
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  void serveServer
    .start()
    .then(async (baseUrl) => {
      // T4：serve 就绪后注入实际 baseUrl（随机端口场景，driver 后续请求才有目标地址）
      driver.baseUrl = baseUrl;
      console.log(`[worker] opencode serve 就绪: ${baseUrl} (pid=${serveServer.pid})`);

      // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
      // 重试耗尽仍失败 → 清理 serve 进程组并退出（无法成为可用 worker）。
      const registerResult = await registerWorkerWithRetry(
        {
          serverUrl: config.serverUrl,
          workerToken: config.workerToken,
          workerId: config.workerId,
          workerName: config.workerName,
          opencodeVersion: serveServer.version !== 'unknown' ? serveServer.version : opencodeVersion,
          // F2 C2：serve 启动成功后 actualPort 已确定，随注册上报（随机端口场景 server 才能连上）
          capabilities: buildCapabilities(serveServer.port),
        },
        { logger: { warn: (message: string) => console.warn(`[worker] ${message}`) } },
      ).catch((err: Error) => {
        console.error(`[worker] 注册失败（重试耗尽）: ${err.message}`);
        return null;
      });

      if (registerResult === null) {
        if (serveServer.isRunning) {
          await serveServer.stop();
        }
        process.exit(1);
      }

      console.log(
        `[worker] 注册成功: workerId=${registerResult.workerId}, heartbeatInterval=${registerResult.heartbeatIntervalMs}ms, serverTime=${registerResult.serverTime}`,
      );

      // 心跳：间隔以 server 返回为准（T7 协议 heartbeatIntervalMs），
      // 顺带上报 serve 健康（isRunning → ok，否则 degraded）。
      heartbeatTimer = setInterval(() => {
        void (async () => {
          // F2 M4：load 上报真实活动会话数（instance-tracker 计数，
          // T10 会话执行接线后由 V1Driver 调用点 trackInstanceStart/End 驱动）
          const load: WorkerLoad = getLoad();
          const health: WorkerHealth = serveServer.isRunning ? 'ok' : 'degraded';
          try {
            await sendHeartbeat({
              serverUrl: config.serverUrl,
              workerToken: config.workerToken,
              workerId: registerResult.workerId,
              load,
              health,
            });
          } catch (err) {
            console.warn(`[worker] 心跳失败: ${(err as Error).message}`);
          }
        })();
      }, registerResult.heartbeatIntervalMs);
    })
    .catch((err: Error) => {
      console.error(`[worker] opencode serve 启动失败: ${err.message}`);
      process.exit(1);
    });

  // 心跳定时器保持事件循环存活（serve 为 detached 子进程，不维持父进程事件循环）。
  console.log(`[worker] 就绪（pid=${process.pid}）。`);
}

main();
