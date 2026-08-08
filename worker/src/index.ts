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
  RegisterResponse,
  registerWorkerWithRetry,
  sendHeartbeat,
  RegistryClientOptions,
} from './client/registry-client';
import { V1Driver } from './driver/v1-driver';
import { GIT_TOOLS, installGitTools } from './git/git-tools';
import { getLoad, onActiveSessionsIdle } from './instance-tracker';
import { McpStatusProbe } from './mcp-status/mcp-status-probe';
import {
  WorkerCapabilities,
  WorkerCommand,
  WorkerCommandType,
  WorkerHealth,
  WorkerLoad,
  WORKER_COMMAND_TYPES,
} from './protocol/worker-protocol';
import { OpencodeServer } from './runtime/opencode-server';
import { ResourceInjector } from './resources/injector';
import { RestartCoordinator } from './restart/restart-coordinator';

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

/** T4b 注入执行器通过 onCommands 注册的命令处理回调（处理心跳携带的下行命令）。 */
export type CommandHandler = (commands: WorkerCommand[]) => void | Promise<void>;

let commandHandler: CommandHandler | null = null;

/**
 * T4a：注册命令处理回调（T4b 注入执行器挂载点）。
 * 未注册时命令仅打日志占位（本任务范围），T4b 接线注入/重启执行。
 */
export function onCommands(handler: CommandHandler): void {
  commandHandler = handler;
}

/** T4a：命令分派——reload-config 打入口日志 + 透传注册回调（T4b 注入 + T4c 重启执行）。 */
export function dispatchCommands(commands: WorkerCommand[]): void {
  if (!commands || commands.length === 0) {
    return;
  }
  for (const command of commands) {
    if (command.type === 'reload-config') {
      console.log(
        `[worker] 收到命令 reload-config（resourceVersion=${command.resourceVersion}），分派注入+重启`,
      );
    }
  }
  void commandHandler?.(commands);
}

function printStartup(config: WorkerConfig, opencodeVersion: string): void {
  console.log(`[worker] 启动中:
  workerId            = ${config.workerId}
  workerName          = ${config.workerName}
  serverUrl           = ${config.serverUrl}
  opencodeServePort   = ${config.opencodeServePort === 0 ? '0（OS 随机空闲端口）' : config.opencodeServePort}
  opencodeServeAuth   = ${config.serverPassword ? 'Basic Auth（已设 OPENCODE_SERVER_PASSWORD）' : '无（serve 不设鉴权）'}
  opencodeServeHost   = ${config.opencodeServeHostname}
  workerAdvertiseHost = ${config.workerAdvertiseHost}
  heartbeatIntervalMs = ${config.heartbeatIntervalMs}
  logLevel            = ${config.logLevel}
  opencodeVersion     = ${opencodeVersion}`);
}

/**
 * T6：注册能力声明（T10 细化并发上限/技能清单；当前单实例 + 已注入的 git 工具族）。
 * F2 C2：serve 实际监听端口必须随注册上报——随机端口（OPENCODE_SERVE_PORT=0）场景下
 * server 侧 WorkerClient.resolveBaseUrl 读 capabilities.port，缺失会回退死端口 4199。
 * D2：另上报 capabilities.baseUrl = ${advertiseHost}:${port}（容器内 compose 设
 * WORKER_ADVERTISE_HOST=http://worker，server resolveBaseUrl 优先读 baseUrl 直连）。
 */
export function buildCapabilities(port: number | null, advertiseHost: string): WorkerCapabilities {
  const base = advertiseHost.replace(/\/+$/, '');
  return {
    maxInstances: 1,
    skills: [],
    tools: GIT_TOOLS.map((tool) => tool.name),
    port: port ?? undefined,
    baseUrl: port !== null ? `${base}:${port}` : undefined,
  };
}

/**
 * T4c/T6：组装注册选项。T4c 重启后 serve 端口可能变化（随机端口），reRegister 用当前
 * serveServer.port 重新组装 → capabilities.baseUrl/port 随心跳后注册更新，server 才能连上新端口。
 */
export function buildRegisterOptions(
  config: WorkerConfig,
  port: number | null,
  serveVersion: string,
  cliVersion: string,
): RegistryClientOptions {
  return {
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workerId: config.workerId,
    workerName: config.workerName,
    opencodeVersion: serveVersion !== 'unknown' ? serveVersion : cliVersion,
    capabilities: buildCapabilities(port, config.workerAdvertiseHost),
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  const opencodeVersion = detectOpencodeVersion();

  printStartup(config, opencodeVersion);

  // K3 修复（T6）：serve 启动前把 git 工具族注入工作目录（<workDir>/.opencode/tools/git.ts，
  // opencode 启动时扫描该目录自动注册；注入失败不阻断启动，工具缺失由后续执行时报错暴露）。
  try {
    const gitToolsPath = installGitTools(config.workDir);
    console.log(`[worker] git 工具族已注入: ${gitToolsPath}`);
  } catch (err) {
    console.error(`[worker] git 工具族注入失败: ${(err as Error).message}`);
  }

  // T3：拉起 opencode serve（spawn detached + 健康检查；失败即退出）。
  // T6（K3）：cwd 必须对齐 workDir——serve 以 cwd 为工作区扫描 .opencode/tools/，
  // 与 installGitTools 注入落点一致，否则注入的工具永远不会被加载。
  const serveServer = new OpencodeServer({
    port: config.opencodeServePort,
    serverPassword: config.serverPassword,
    cwd: config.workDir,
  });

  // T4：V1Driver（封装 serve REST API）；serve 随机端口启动成功后在 .then 注入 baseUrl。
  // 会话执行链路（createSession 驱动 → 事件上送）待 T10 回流接线；实例计数挂钩点见
  // v1-driver.ts createSession 注释（F2 M4）。
  const driver = new V1Driver({
    serverPassword: config.serverPassword,
  });

  // T4b：资源注入执行器——serve 启动前拉取控制面 skills/tools/mcp-servers 注入
  // <workDir>（.opencode/skills/ + .opencode/tools/ + opencode.json mcp 节），
  // 心跳命令 reload-config 回调复用同一注入器重拉（T4c 重启后生效）。
  const injector = new ResourceInjector({
    serverUrl: config.serverUrl,
    workerToken: config.workerToken,
    workDir: config.workDir,
  });

  // T6/T4c：注册状态（初始注册成功/重启后重注册共享更新；心跳定时器读取 workerId 与间隔）。
  let registeredWorkerId = '';
  let heartbeatIntervalMs = config.heartbeatIntervalMs;

  // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
  // 重试耗尽返回 null（由调用方决定退出或降级）。
  const registerCurrent = (): Promise<RegisterResponse | null> =>
    registerWorkerWithRetry(
      buildRegisterOptions(config, serveServer.port, serveServer.version, opencodeVersion),
      { logger: { warn: (message: string) => console.warn(`[worker] ${message}`) } },
    ).catch((err: Error) => {
      console.error(`[worker] 注册失败（重试耗尽）: ${err.message}`);
      return null;
    });

  // T4c：重启后重新注册——serve 随机端口重启后可能变化，用当前 port 重新组装注册选项；
  // 失败不退出（serve 已在新端口运行，server 连旧端口报 degraded，再次 reload-config 可修复）。
  const reRegister = async (): Promise<void> => {
    const result = await registerCurrent();
    if (result === null) {
      console.warn(
        '[worker] 重启后重新注册失败：serve 已在新端口运行，server 可能连不上（可再次触发 reload-config 修复）',
      );
      return;
    }
    registeredWorkerId = result.workerId;
    heartbeatIntervalMs = result.heartbeatIntervalMs;
    console.log(`[worker] 重启后重新注册成功: workerId=${result.workerId}`);
  };

  // T4c：重启协调器——无活跃会话才重启（单 serve 实例，重启会中断会话）；
  // 有活跃会话则挂起，等会话归零后自动执行。
  const restartCoordinator = new RestartCoordinator({
    activeSessionCount: () => getLoad().instances,
    restart: () => serveServer.restart(),
    reRegister,
    logger: {
      info: (message: string) => console.log(`[worker] ${message}`),
      warn: (message: string) => console.warn(`[worker] ${message}`),
      error: (message: string) => console.error(`[worker] ${message}`),
    },
  });

  // T4b：注册命令处理回调（T4a 挂载点）——reload-config 触发资源重拉 + 注入 +
  // T4c 重启判定（无活跃会话立即重启 serve 使新配置生效，有活跃会话则挂起）。
  onCommands(async (commands) => {
    for (const command of commands) {
      if (command.type === WORKER_COMMAND_TYPES.RELOAD_CONFIG) {
        try {
          const report = await injector.injectAll();
          console.log(
            `[worker] reload-config：资源重注入完成（${report.skills.length} skills, ${report.tools.length} tools, ${report.mcpServers.length} mcp servers）`,
          );
          const decision = await restartCoordinator.requestRestart(
            `reload-config（resourceVersion=${command.resourceVersion}）`,
          );
          if (decision === 'pending') {
            console.log('[worker] reload-config：存在活跃会话，重启挂起（会话归零后自动执行）');
          }
        } catch (err) {
          console.warn(`[worker] reload-config 资源重注入失败: ${(err as Error).message}`);
        }
      }
    }
  });

  // T4c：活跃会话归零时检查挂起的重启（T10 会话执行接入 trackInstanceStart/End 后自动触发）
  onActiveSessionsIdle(() => restartCoordinator.checkPending());

  // T8c：MCP 三态探测器（30s 节流——不能每 10s 心跳 spawn 子进程，Metis 高优补项 7）。
  // 心跳回调携带 getStatus() 快照（节流窗口内复用缓存），首次探测失败为空数组不阻断心跳。
  const mcpStatusProbe = new McpStatusProbe({
    // cwd 对齐 workDir：opencode mcp list 基于 cwd 查找 opencode.json（注入配置落点）
    cwd: config.workDir,
    logger: {
      warn: (message: string) => console.warn(`[worker] ${message}`),
    },
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

  // T4b：启动链——先注入平台资源（serve 启动前落盘，opencode 启动时才能扫描到），
  // 再拉起 serve；注入失败不阻断启动（后续心跳 reload-config 命令可重拉修复）。
  void (async () => {
    try {
      const report = await injector.injectAll();
      console.log(
        `[worker] 平台资源注入完成: ${report.skills.length} skills, ${report.tools.length} tools, ${report.mcpServers.length} mcp servers`,
      );
    } catch (err) {
      console.warn(
        `[worker] 平台资源注入失败（继续启动 serve，心跳命令可重拉）: ${(err as Error).message}`,
      );
    }

    try {
      const baseUrl = await serveServer.start();
      // T4：serve 就绪后注入实际 baseUrl（随机端口场景，driver 后续请求才有目标地址）
      driver.baseUrl = baseUrl;
      console.log(`[worker] opencode serve 就绪: ${baseUrl} (pid=${serveServer.pid})`);

      // T6 注册（X-Worker-Token）：失败指数退避重试（1s/2s/4s/8s...封顶 30s），
      // 重试耗尽仍失败 → 清理 serve 进程组并退出（无法成为可用 worker）。
      const registerResult = await registerCurrent();

      if (registerResult === null) {
        if (serveServer.isRunning) {
          await serveServer.stop();
        }
        process.exit(1);
      }
      registeredWorkerId = registerResult.workerId;
      heartbeatIntervalMs = registerResult.heartbeatIntervalMs;

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
            const heartbeat = await sendHeartbeat({
              serverUrl: config.serverUrl,
              workerToken: config.workerToken,
              workerId: registeredWorkerId,
              load,
              health,
              // T8c：MCP 三态快照（节流缓存，30s 内复用）
              mcpStatus: mcpStatusProbe.getStatus(),
            });
            // T4a：心跳响应携带的下行命令 → 分派处理（reload-config 注入+重启）
            dispatchCommands(heartbeat.commands ?? []);
          } catch (err) {
            console.warn(`[worker] 心跳失败: ${(err as Error).message}`);
          }
        })();
      }, heartbeatIntervalMs);
    } catch (err) {
      console.error(`[worker] opencode serve 启动失败: ${(err as Error).message}`);
      process.exit(1);
    }
  })();

  // 心跳定时器保持事件循环存活（serve 为 detached 子进程，不维持父进程事件循环）。
  console.log(`[worker] 就绪（pid=${process.pid}）。`);
}

// require.main 守卫：作为入口（node dist/index.js / tsx src/index.ts）才启动 worker；
// 被 import（如 index.spec.ts 测 buildCapabilities）时不触发 main()。
if (require.main === module) {
  main();
}
