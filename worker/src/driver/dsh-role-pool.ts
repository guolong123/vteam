/**
 * 角色运行时池（P6）——**每个 vteam Agent 角色一个独立 DSH 运行时进程**。
 *
 * ## 为什么必须这样做（实测证据）
 *
 * DSH 的 system prompt 注入有两条路径，只有一条可靠：
 *
 * | 路径 | 可行性 | 证据 |
 * |---|---|---|
 * | `system-prompt.personaPrefix` + 进程 env（`DSH_SYSTEM_PROMPT`） | ✅ **可用** | 隔离实测：system 消息里出现 persona 标记 |
 * | preset 内 `dsh-persona` 行（会话级） | ❌ **不可用** | `dsh-persona` README："requires an **agent scope**"；`registry.register()` 建的是普通 scope ⇒ 挂载失败（logger.warn 静默） |
 *
 * 而 env 是**进程级**的 ⇒ 同一进程无法同时承载多个不同角色。
 *
 * ## 设计：一个角色 = 一个运行时
 *
 * - 每个 `agentPreset`（= vteam agentKey）对应一个 `DshDriver` 实例（独立子进程）
 * - 该进程的 env 在 spawn 时带上该角色的 `DSH_SYSTEM_PROMPT`
 * - 同一个角色的多个会话**共享**该角色的运行时（会话级隔离仍在进程内）
 *
 * 代价：N 个角色 = N 个进程（每个 ~350MB）。vteam 的 maxInstances 需要按此配置。
 * 收益：persona 真正生效；环境隔离（一个角色的崩溃不影响其它角色）。
 *
 * ## 与「单运行时 + preset」的取舍
 *
 * preset 方案的宣称收益是"一个进程多个组合"，但其 persona 通道在 registry.register()
 * 场景下不可用（见上）。在没有更好的通道前，**进程隔离是唯一可靠手段**。
 * 若未来 DSH 修复 registry.register() 的 agent scope 问题，可切回单进程方案
 * （本池的接口不变，只换内部实现）。
 *
 * @module driver/dsh-role-pool
 */

import { DshDriver, type DshDriverOptions } from './dsh-driver';
import type { Logger } from './opencode-driver';

/** 池内单个角色运行时。 */
interface RoleRuntime {
  /** 该角色的运行时驱动（独立子进程）。 */
  driver: DshDriver;
  /** 该角色绑定的会话集合（便于诊断）。 */
  sessions: Set<string>;
  /** 最近使用时间（供空闲回收）。 */
  lastUsedAt: number;
}

/** 池配置。 */
export interface DshRolePoolOptions extends DshDriverOptions {
  /** 日志。 */
  logger?: Logger;
  /** 空闲回收毫秒（缺省 10 分钟；0 = 不回收）。 */
  idleTimeoutMs?: number;
}

/**
 * 角色运行时池。
 *
 * 对外暴露与单个 `DshDriver` 相同的会话 API 形状（由调用方按会话路由到正确实例），
 * 但内部为每个角色维护独立的运行时进程。
 */
export class DshRolePool {
  private readonly options: DshRolePoolOptions;
  private readonly logger: Logger;
  /** agentPreset（角色）→ 运行时。 */
  private readonly runtimes = new Map<string, RoleRuntime>();
  /** sessionId → agentPreset（会话归属，供路由）。 */
  private readonly sessionOwners = new Map<string, string>();
  /** 空闲回收定时器。 */
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: DshRolePoolOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? console;
    const idle = options.idleTimeoutMs ?? 10 * 60 * 1000;
    if (idle > 0) {
      this.sweeper = setInterval(() => {
        void this.reapIdle(idle);
      }, Math.min(idle, 60_000));
      this.sweeper.unref?.();
    }
  }

  /** 当前角色数（诊断用）。 */
  get roleCount(): number {
    return this.runtimes.size;
  }

  /** 列出活跃角色（诊断用）。 */
  listRoles(): string[] {
    return [...this.runtimes.keys()];
  }

  /**
   * 为会话创建/获取所属角色运行时。
   *
   * @param agentPreset - vteam agentKey（= 角色身份）。
   * @param agentSystem - 该角色的**完整系统提示词**（进进程 env）。
   * @returns 该角色的驱动实例。
   */
  async runtimeFor(agentPreset: string, agentSystem?: string): Promise<DshDriver> {
    const existing = this.runtimes.get(agentPreset);
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing.driver;
    }

    // 首次为该角色创建运行时：把 persona 注入 spawn env
    this.logger.info(
      `[dsh-role-pool] 为角色 ${agentPreset} 创建独立运行时（persona ` +
        `${agentSystem === undefined ? 0 : agentSystem.length} 字）`,
    );
    const driver = new DshDriver({
      ...this.options,
      env: {
        ...(this.options.env ?? {}),
        ...(agentSystem === undefined || agentSystem === ''
          ? {}
          : { DSH_SYSTEM_PROMPT: agentSystem }),
        // 让 patch 的 system-prompt 行读到该角色的 persona（缺省回落到空）
        DSH_VTEAM_ROLE: agentPreset,
      },
      logger: this.logger,
    });
    const runtime: RoleRuntime = { driver, sessions: new Set(), lastUsedAt: Date.now() };
    this.runtimes.set(agentPreset, runtime);
    return driver;
  }

  /** 记录会话归属（供路由与诊断）。 */
  bindSession(sessionId: string, agentPreset: string): void {
    this.sessionOwners.set(sessionId, agentPreset);
    this.runtimes.get(agentPreset)?.sessions.add(sessionId);
  }

  /** 按会话反查所属角色的驱动（未绑定返回 undefined）。 */
  driverForSession(sessionId: string): DshDriver | undefined {
    const role = this.sessionOwners.get(sessionId);
    return role === undefined ? undefined : this.runtimes.get(role)?.driver;
  }

  /** 关闭全部运行时（worker 停机时）。 */
  async closeAll(): Promise<void> {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const drivers = [...this.runtimes.values()].map((r) => r.driver.close());
    this.runtimes.clear();
    this.sessionOwners.clear();
    await Promise.allSettled(drivers);
  }

  /** 回收空闲运行时（角色无活跃会话且超时未用）。 */
  private async reapIdle(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const [role, runtime] of [...this.runtimes.entries()]) {
      if (runtime.sessions.size > 0) continue;
      if (now - runtime.lastUsedAt < idleMs) continue;
      this.logger.info(`[dsh-role-pool] 回收空闲角色运行时：${role}`);
      this.runtimes.delete(role);
      await runtime.driver.close().catch(() => undefined);
    }
  }
}
