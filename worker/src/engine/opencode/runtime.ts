/**
 * opencode 引擎的 `EngineRuntimeController` 实现（P1）。
 *
 * **这是一层适配（adapter），不是重写**：内部完全复用既有 `OpencodeServer`（进程管理）、
 * `ConfigReloader`（热重载）、`McpStatusProbe`（MCP 状态），行为**零变化**——
 * P1 的验收标准就是"现有 spec 全绿 + opencode E2E 冒烟"。
 *
 * 为什么现在就要这层：这三件套目前由 `index.ts` 直接编排（`new OpencodeServer(...)`、
 * `new ConfigReloader(...)`、`new McpStatusProbe(...)`，见 `src/index.ts:1151/1382/1450`）。
 * 只要 `index.ts` 继续直接 `new` 这些类，第二条引擎路径就必然要复制一遍编排逻辑。
 *
 * 铁律（与既有约定一致）：
 * - 本文件**只做转发与接口适配**，不新增策略（超时/重试/降级都留在被包装类里）。
 * - 密码/凭据**绝不进日志**（沿用被包装类的做法）。
 *
 * @module engine/opencode/runtime
 */

import type { Logger as ServeLogger } from '../../runtime/opencode-server';
import { OpencodeServer, type OpencodeServerOptions } from '../../runtime/opencode-server';
import { ConfigReloader, type ConfigReloaderOptions } from '../../reload/config-reloader';
import {
  McpStatusProbe,
  type McpStatusEntry,
  type McpStatusProbeOptions,
} from '../../mcp-status/mcp-status-probe';

import type {
  EngineCapabilities,
  EngineConfigSnapshot,
  EngineMcpServerStatus,
  EngineRuntimeController,
  WorkerEngineKind,
} from '../types';
import { opencodeCapabilities } from './capabilities';

/** 适配器构造参数（与被包装类的选项一一对应，便于调用方零成本迁移）。 */
export interface OpencodeRuntimeOptions {
  /** serve 子进程选项（透传给 `OpencodeServer`）。 */
  serve: OpencodeServerOptions;
  /** 热重载器选项（缺省不启用热重载——只有显式传入时才构造）。 */
  reloader?: Partial<Omit<ConfigReloaderOptions, 'endpoint'>>;
  /** MCP 状态探针选项（缺省不启用探测）。 */
  mcpProbe?: McpStatusProbeOptions;
  /** 日志（缺省取 serve 的 logger）。 */
  logger?: ServeLogger;
}

/** 引擎致命错误原因（供上层写 health=degraded / 触发重启决策）。 */
export interface EngineFatalReason {
  /** 人类可读原因（可能包含 serve 最近日志行）。 */
  message: string;
  /** 分类：进程退出 / 健康检查失败。 */
  category: 'exit' | 'health';
}

/**
 * opencode 运行时控制器。
 *
 * 生命周期由调用方持有（`start()` 一次，`stop()` 收尾）；内部各组件均由本类统一装配，
 * 从而把"引擎怎么起、怎么算健康、配置变更怎么生效、MCP 状态怎么取"四件事收口到一处。
 */
export class OpencodeRuntime implements EngineRuntimeController {
  readonly kind: WorkerEngineKind = 'opencode';

  private readonly serve: OpencodeServer;
  private readonly reloader: ConfigReloader | null;
  private readonly probe: McpStatusProbe | null;
  private readonly logger: ServeLogger;

  /** 致命错误订阅者。 */
  private readonly fatalHandlers = new Set<(reason: string) => void>();
  /** serve 进程退出监听定时器（null = 未挂）。 */
  private exitWatch: ReturnType<typeof setInterval> | null = null;

  constructor(options: OpencodeRuntimeOptions) {
    this.serve = new OpencodeServer(options.serve);
    this.logger = options.logger ?? options.serve.logger ?? console;

    // 热重载与 MCP 探针都需要 **serve 的实际端点**（每次调用时现取——重启可能换端口）。
    const endpoint = (): { baseUrl: string; password: string | null } | undefined => {
      const baseUrl = this.serve.baseUrl;
      if (!baseUrl) return undefined;
      return { baseUrl, password: this.serve.effectiveServerPassword };
    };

    this.reloader =
      options.reloader === undefined
        ? null
        : new ConfigReloader({
            ...options.reloader,
            endpoint,
            logger: options.reloader.logger ?? this.logger,
          });

    this.probe =
      options.mcpProbe === undefined ? null : new McpStatusProbe({ ...options.mcpProbe, endpoint });
  }

  /** 被包装的 serve 实例（P1 迁移期供 `index.ts` 读取既有字段，如 baseUrl/port/version）。 */
  get serveServer(): OpencodeServer {
    return this.serve;
  }

  get isRunning(): boolean {
    return this.serve.isRunning;
  }

  /** 引擎基址（未启动为 null）。 */
  get baseUrl(): string | null {
    return this.serve.baseUrl;
  }

  /** 实际监听端口（未启动为 null）。 */
  get port(): number | null {
    return this.serve.port;
  }

  /** 引擎版本原始串（既上报口径）。 */
  get version(): string {
    return this.serve.version;
  }

  /** 最近的错误日志行（既有 `recentErrors` 转发；首字超时诊断用）。 */
  recentErrors(limit = 5, sessionID?: string): string[] {
    return this.serve.recentErrors(limit, sessionID);
  }

  async start(): Promise<void> {
    await this.serve.start();
    this.attachExitWatch();
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.fatalHandlers.clear();
    if (this.exitWatch !== null) {
      clearInterval(this.exitWatch);
      this.exitWatch = null;
    }
    await this.serve.stop(timeoutMs);
  }

  async isHealthy(): Promise<boolean> {
    if (!this.serve.isRunning) return false;
    const baseUrl = this.serve.baseUrl;
    if (!baseUrl) return false;
    try {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: basicAuthHeader(this.serve.effectiveServerPassword),
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  onFatal(handler: (reason: string) => void): () => void {
    this.fatalHandlers.add(handler);
    return () => {
      this.fatalHandlers.delete(handler);
    };
  }

  /**
   * 应用配置变更。
   *
   * 语义（P1 只做**转发**，策略留在 `ConfigReloader`）：
   * - opencode 走 `POST /api/location/reload` 热重载（不重启 serve）；
   * - 重载器未注入时：**不做任何事并记日志**——不静默重启 serve
   *   （重启会让端口漂移 + 需等会话排空，代价远高于热重载）。
   *
   * ⚠️ 注入本身（skills/tools/mcp 落盘）由 `ResourceInjector` 负责，不在本类；
   * 本类只负责"落盘之后让引擎感知变更"这一步。
   */
  async applyConfig(_snapshot: EngineConfigSnapshot): Promise<void> {
    if (this.reloader === null) {
      this.logger.warn(
        '[engine/opencode] 未配置热重载器：配置变更不会即时生效（注入由 ResourceInjector 负责）',
      );
      return;
    }
    const result = await this.reloader.reload('engine.applyConfig');
    this.logger.info(`[engine/opencode] 配置热重载：${result.outcome}`);
  }

  /**
   * 探测引擎内 MCP 状态。
   *
   * 未注入探针时返回 `null`（**不编造"无服务器"**）——上层据此上报配置态或省略该字段，
   * 而不是报一个假的空列表（既有实现已踩过这个坑，见 `mcp-status-probe.ts` 文件头）。
   */
  async probeMcpStatus(): Promise<EngineMcpServerStatus[] | null> {
    if (this.probe === null) return null;
    const snapshot = await this.probe.getSnapshot();
    if (snapshot.outcome === 'probe_failed') {
      // 探针失败 ≠ 无服务器：沿用快照里的"上次成功结果"，但让上层知道这次没探到。
      this.logger.warn(
        `[engine/opencode] MCP 探测失败（保留上次结果）：${snapshot.reason ?? '未知原因'}`,
      );
    }
    return snapshot.entries.map(toEngineMcpStatus);
  }

  capabilities(): EngineCapabilities {
    return opencodeCapabilities(this.serve.version);
  }

  /**
   * 挂 serve 进程退出监听：进程意外退出 → 通知致命错误处理器。
   *
   * 为什么用轮询而不改被包装类的私有字段：`OpencodeServer` 未暴露子进程对象，
   * P1 的纪律是"只搬家不改行为"，故用低频轮询（1s，unref 不阻塞退出）观测存活，
   * 而不是侵入性修改 `OpencodeServer`。P2 接入 dsh 时可改为显式 exit 回调。
   */
  private attachExitWatch(): void {
    if (this.exitWatch !== null) return;
    this.exitWatch = setInterval(() => {
      if (this.serve.isRunning) return;
      if (this.exitWatch !== null) {
        clearInterval(this.exitWatch);
        this.exitWatch = null;
      }
      const errors = this.serve.recentErrors(3);
      const message =
        errors.length > 0
          ? `opencode serve 已退出（最近日志：${errors.join(' | ')}）`
          : 'opencode serve 已退出';
      this.emitFatal(message, 'exit');
    }, 1_000);
    this.exitWatch.unref?.();
  }

  private emitFatal(message: string, category: EngineFatalReason['category']): void {
    this.logger.error(`[engine/opencode] 引擎致命错误（${category}）：${message}`);
    for (const handler of this.fatalHandlers) {
      try {
        handler(message);
      } catch (err) {
        this.logger.error(`[engine/opencode] 致命错误处理器抛异常：${(err as Error).message}`);
      }
    }
  }
}

/** serve 五态 → 引擎无关五态（本层是 1:1，**不折叠**——折叠等于谎报）。 */
function toEngineMcpStatus(entry: McpStatusEntry): EngineMcpServerStatus {
  return { name: entry.serverName, status: entry.status };
}

/** Basic Auth 头（username 固定 `opencode`，与既有实现一致）。 */
function basicAuthHeader(password: string | null): Record<string, string> {
  if (!password) return {};
  const raw = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${raw}` };
}
