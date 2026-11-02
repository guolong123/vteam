/**
 * dsh 引擎的 `EngineRuntimeController` / `ResourceInjector` / `CredentialApplier`（P2 骨架）。
 *
 * 与 opencode 的 `OpencodeRuntime` 结构对齐，但**进程模型不同**：
 * - opencode：**一个 serve 承载全部会话**（`OpencodeServer` 单实例）；
 * - dsh：**一个 SDK 运行时承载多个会话**（P0 报告 C6 —— RSS 341MB/进程，故默认共享），
 *   `DshRuntime` 内部持有 `DshRpcClient`，会话由 driver 侧按 sessionId 分派。
 *
 * P2 只落地"能起运行时 + 能拿驱动 + 能力位"，注入与凭据在 P4 补齐（这里给明确占位，
 * 不假装已实现——虚报能力比缺失更危险）。
 *
 * @module engine/dsh/runtime
 */

import type { Logger } from '../../driver/opencode-driver';
import { DshDriver, type DshDriverOptions } from '../../driver/dsh-driver';

import type {
  EngineCapabilities,
  EngineConfigSnapshot,
  EngineMcpServerStatus,
  EngineModelCredential,
  EngineRuntimeController,
  WorkerEngineKind,
  WorkspaceLayout,
} from '../types';

/** dsh 运行时构造参数。 */
export interface DshRuntimeOptions extends DshDriverOptions {
  /**
   * 每个会话是否独占运行时（缺省 false = 共享）。
   *
   * P0 报告 C6：单运行时 RSS 341–362MB，10 并发若独占 = ~3.6GB → 不可接受。
   * 共享模式下所有 vteam 会话用同一个 DshRpcClient（服务端本就支持多 session）。
   */
  perSessionRuntime?: boolean;
  /** 引擎版本串（缺省 `dsh-unknown`；P7 由镜像构建期写入，供控制面展示与调度比对）。 */
  engineVersion?: string;
  logger?: Logger;
}

/**
 * dsh 的能力位。
 *
 * **全部为 false 的项都是"DSH 确实没有"**，不是"尚未实现"：
 * - `todos`: SDK 协议不暴露计划步骤（P0 报告）
 * - `externalAgents`: 无 agent 目录概念（角色由提示词承载）
 * - `integrations`: 无集成注册表
 * - `omoConfig`: OmO 是 opencode 生态插件
 * - `planFiles`: DSH 不读 `.opencode/plans`（vteam 改用 `.vteam/plans`，见 WorkspaceLayout）
 * - `mcpStatusProbe`: SDK 协议无 MCP 状态查询
 * - `steer`: 需 vendored 插件（P5），P2 阶段按 queue 降级
 * - `perMessageModelSwitch`: 模型路由在 initialize 固定，换模型需重启运行时
 */
export function dshCapabilities(engineVersion: string): EngineCapabilities {
  return {
    engineVersion,
    perMessageModelSwitch: false,
    todos: false,
    externalAgents: false,
    integrations: false,
    omoConfig: false,
    planFiles: false,
    steer: false,
    mcpStatusProbe: false,
  };
}

/**
 * dsh 运行时控制器。
 *
 * P2 职责：持有 DshDriver（驱动 + 事件映射 + pending 表已在 driver 内），
 * 对外提供引擎接缝的启动/停止/健康/能力位。
 *
 * P4 会在这里接：cordis patch 生成（provider/mcp/skills 注入）、凭据 env 注入。
 */
export class DshRuntime implements EngineRuntimeController {
  readonly kind: WorkerEngineKind = 'dsh';

  private readonly driver: DshDriver;
  private readonly options: DshRuntimeOptions;
  private readonly logger: Logger;
  private started = false;
  private readonly fatalHandlers = new Set<(reason: string) => void>();

  constructor(options: DshRuntimeOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.driver = new DshDriver(options);
  }

  /** 底层驱动（exec-server 通过它下发/拉消息/答复）。 */
  get dshDriver(): DshDriver {
    return this.driver;
  }

  get isRunning(): boolean {
    return this.started && this.driver.rpc.isRunning;
  }

  async start(): Promise<void> {
    // P2：驱动懒启动（首次 sendMessage 才握手）；这里只标记已启用。
    // 为什么不在 start 就握手：initialize 固定 provider/model——P4 注入产生 patch 后才知道
    // 真实路由，过早握手会锁死在默认值上。
    this.started = true;
    this.logger.info('[engine/dsh] 运行时已启用（驱动懒启动：首次下发时握手）');
  }

  async stop(_timeoutMs = 3000): Promise<void> {
    this.started = false;
    this.fatalHandlers.clear();
    await this.driver.close();
  }

  async isHealthy(): Promise<boolean> {
    return this.driver.isHealthy();
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
   * P2 阶段：**明确不做**（不假装生效）。DSH 的配置变更需重启运行时（patch 是启动期注入，
   * P0 报告已记录"配置变更需重启"）。P4 实现：重生成 patch → 重启空闲运行时。
   */
  async applyConfig(_snapshot: EngineConfigSnapshot): Promise<void> {
    this.logger.warn(
      '[engine/dsh] applyConfig 尚未实现（P4）：DSH 配置为启动期注入，变更需重启运行时',
    );
  }

  /** MCP 状态：DSH SDK 协议无查询接口 → null（不编造"无服务器"）。 */
  async probeMcpStatus(): Promise<EngineMcpServerStatus[] | null> {
    return null;
  }

  capabilities(): EngineCapabilities {
    return dshCapabilities(this.currentVersion());
  }

  /** 引擎版本（从 package 版本读不到时用占位；P7 由镜像构建期写入）。 */
  private currentVersion(): string {
    return this.options.engineVersion ?? 'dsh-unknown';
  }
}

/** dsh 的 `ResourceInjector` 占位（P4 实现 cordis patch 生成）。 */
export class DshResourceInjector {
  readonly kind: WorkerEngineKind = 'dsh';

  async apply(_snapshot: EngineConfigSnapshot, _workDir: string): Promise<void> {
    throw new Error('[engine/dsh] 注入器尚未实现（P4：cordis patch 的 insert: 形态生成）');
  }

  async cleanup(_workDir: string): Promise<void> {
    throw new Error('[engine/dsh] 注入清理尚未实现（P4）');
  }
}

/** dsh 的 `CredentialApplier` 占位（P4 实现 env + provider patch 行）。 */
export class DshCredentialApplier {
  readonly kind: WorkerEngineKind = 'dsh';

  async apply(_credentials: EngineModelCredential[]): Promise<void> {
    throw new Error('[engine/dsh] 凭据下发尚未实现（P4：spawn env + llm-pi-ai provider 行）');
  }

  async clear(_providerIDs?: string[]): Promise<void> {
    throw new Error('[engine/dsh] 凭据清理尚未实现（P4）');
  }
}

/** dsh 的 `WorkspaceLayout`（与 opencode 共用同一实现——布局本身引擎无关）。 */
export type { WorkspaceLayout };
