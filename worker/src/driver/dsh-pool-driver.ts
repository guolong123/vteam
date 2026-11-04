/**
 * 池代理驱动（P6）——把「每角色一个运行时」包装成**单个 `OpenCodeDriver`**。
 *
 * ## 为什么需要这层代理
 *
 * 业务层（exec-server / prompt-await）只依赖 `OpenCodeDriver` 接口（既有铁律）。
 * 而 persona 走**进程级 env** ⇒ 每个角色必须是独立进程。
 * 代理把"按会话路由到正确角色运行时"这件事收进驱动层，业务层**零改动**。
 *
 * ## 路由规则
 *
 * - `createSession(model, agentPreset, agentSystem)` → 为该角色创建/复用运行时，
 *   记录 `sessionId → 角色`
 * - 其余会话级方法（sendMessage / getMessages / abort / listQuestions / …）
 *   → 按 `sessionId` 查所属角色的运行时，转发
 *
 * ## 与单运行时方案的取舍
 *
 * | | 单运行时 + preset | 每角色一运行时（本代理） |
 * |---|---|---|
 * | persona 生效 | ❌（dsh-persona 需 agent scope，register 不满足） | ✅ 进程 env |
 * | 内存 | ~350MB 总额 | ~350MB × 角色数 |
 * | 隔离 | 共享进程（一崩全崩） | 进程隔离 |
 *
 * @module driver/dsh-pool-driver
 */

import { readFileSync, existsSync } from 'node:fs';

import type {
  DriverAgentInfo,
  DriverIntegrationInfo,
  DriverMessage,
  DriverMessageQuery,
  DriverModelInfo,
  DriverModelRef,
  DriverPermissionRequest,
  DriverPermissionResponse,
  DriverPromptInput,
  DriverPromptResult,
  DriverQuestionRequest,
  DriverTodo,
  Logger,
  OpenCodeDriver,
} from './opencode-driver';
import type { EngineEventChannel } from './engine-events';
import type { EngineModelCredential } from '../engine/types';
import { DshDriver } from './dsh-driver';
import { DshRolePool, type DshRolePoolOptions } from './dsh-role-pool';

/** 池代理构造参数。 */
export interface DshPoolDriverOptions extends DshRolePoolOptions {
  /** 每角色运行时共用的 patch 路径。 */
  patches?: string[];
  /** 日志。 */
  logger?: Logger;
}

/**
 * 池代理：单个 `OpenCodeDriver`，内部按会话路由到角色运行时。
 *
 * 实现 `EngineEventChannel`（转发到角色运行时），从而 exec-server 的事件通道
 * 也无需感知池的存在。
 */
export class DshPoolDriver implements OpenCodeDriver, EngineEventChannel {
  /** stdio 模式下无 HTTP 基址（维持接口形状）。 */
  baseUrl = '';
  readonly authPassword = '';

  private readonly pool: DshRolePool;
  private readonly logger: Logger;
  /** 会话 → 角色（用于未绑定时的兜底与诊断）。 */
  private readonly sessionRoles = new Map<string, string>();

  /** 挂起的事件订阅（sessionId → 落地后接上的回调）。 */
  private readonly pendingSubscriptions = new Map<
    string,
    (driver: DshDriver, realId: string) => void
  >();

  constructor(options: DshPoolDriverOptions = {}) {
    this.logger = options.logger ?? console;
    this.pool = new DshRolePool({ ...options, logger: this.logger });
  }

  /** 当前角色数（诊断）。 */
  get roleCount(): number {
    return this.pool.roleCount;
  }

  /** 活跃角色清单（诊断）。 */
  listRoles(): string[] {
    return this.pool.listRoles();
  }

  /** 凭据登记实现（由 createDshWorkerDriver 注入实际 applier）。 */
  private credentialSink?: (creds: EngineModelCredential[]) => Promise<void>;

  /** 注入凭据登记实现（createDshWorkerDriver 构造时调用一次）。 */
  setCredentialSink(sink: (creds: EngineModelCredential[]) => Promise<void>): void {
    this.credentialSink = sink;
  }

  /**
   * 登记平台下发的模型凭据（dsh 侧**只落 spawn env**，不做热生效）。
   *
   * dsh 的 provider 用 `apiKeyEnv` 引用 key（进程级），故换 key 必须重开运行时 ——
   * 这不像 opencode 那样能写配置文件 + 热重载。这里只负责把值登进
   * `DshCredentialApplier`，下一个运行时 spawn 时自然带上。
   */
  async applyModelCredentials(creds: EngineModelCredential[]): Promise<void> {
    if (this.credentialSink === undefined) {
      this.logger.warn('[dsh-pool] 凭据登记未接线（无 credentialSink），本次下发被忽略');
      return;
    }
    await this.credentialSink(creds);
  }

  /**
   * 把**某个会话所属角色**运行时的模型路由对齐到 `model`（每个回合都调）。
   *
   * 为什么在池层：exec-server 持有的 driver 是池（按角色分运行时），模型路由是
   * 每个 `DshDriver` 实例自己的状态。复用会话时不会走 createSession，模型检查
   * 整个被跳过 ⇒ 改了成员模型也不生效（线上实测 config=glm-5.2 serve=glm-5.3 漂移）。
   *
   * 用 `driverForSession`（**不 spawn**）：会话没有归属时不代它启动新运行时，直接放行，
   * 由下一轮 createSession 正常处理（最坏只是本轮沿用旧模型，不阻断执行）。
   */
  async ensureModelFor(sessionId: string, model: DriverModelRef | null): Promise<void> {
    if (model == null) return;
    const driver = this.pool.driverForSession(sessionId);
    if (driver === undefined) {
      this.logger.warn(
        `[dsh-pool] 模型对齐跳过：会话 ${sessionId} 在池内无归属（可能进程重启后复用旧会话）`,
      );
      return;
    }
    await driver.ensureModel(model);
  }

  async createSession(
    model?: DriverModelRef | null,
    agentPreset?: string,
    agentSystem?: string,
  ): Promise<string> {
    const role = agentPreset !== undefined && agentPreset !== '' ? agentPreset : '__default__';
    const driver = await this.pool.runtimeFor(role, agentSystem);
    const sessionId = await driver.createSession(model, agentPreset, agentSystem);
    this.sessionRoles.set(sessionId, role);
    this.pool.bindSession(sessionId, role);
    // 触发挂起的事件订阅（把之前返回的句柄接到真实运行时）
    const hook = this.pendingSubscriptions.get(sessionId);
    if (hook !== undefined) {
      this.pendingSubscriptions.delete(sessionId);
      hook(driver, sessionId);
    }
    this.logger.info(
      `[dsh-pool] 会话 ${sessionId} 归属角色 ${role}` +
        `（当前池内 ${this.pool.roleCount} 个角色运行时）`,
    );
    return sessionId;
  }

  /**
   * 运行时能否服务某会话。
   *
   * 若会话已由某角色运行时创建 ⇒ 直接转发；否则（例如会话由 server 侧复用旧
   * instanceRef 但 worker 重启过）回落到默认运行时（保证不因找不到而失败）。
   */
  /**
   * 解析会话所属运行时。
   *
   * ⚠️ **兜底必须能自建**：worker 重启后，server 侧复用的是**旧 instanceRef**
   * （会话 id 存在，但角色归属映射在内存里已丢）。若这里直接抛错，表现为
   * 「成员会话异常终止 agent_error」（实测踩到）。
   *
   * 兜底策略（按可靠性排序）：
   * 1. 有归属 → 直接返回
   * 2. **只有 1 个角色运行时** → 用它（单角色场景最常见，最安全）
   * 3. 多角色 → 用默认角色 `__default__`（现建；persona 会在首次拿到 system 时补）
   */
  private async driverFor(sessionId: string): Promise<DshDriver> {
    const owner = this.pool.driverForSession(sessionId);
    if (owner !== undefined) return owner;

    // 兜底 2：池内只有一个角色 → 该会话必然属于它
    const roles = this.pool.listRoles();
    if (roles.length === 1) {
      const driver = await this.pool.runtimeFor(roles[0], undefined);
      this.pool.bindSession(sessionId, roles[0]);
      this.sessionRoles.set(sessionId, roles[0]);
      this.logger.warn(
        `[dsh-pool] 会话 ${sessionId} 无归属记录 → 归入唯一角色 ${roles[0]}（worker 重启后的常见情况）`,
      );
      return driver;
    }

    // 兜底 3：多角色场景 → 建默认角色运行时
    this.logger.warn(
      `[dsh-pool] 会话 ${sessionId} 无归属记录（池内 ${roles.length} 个角色）→ 用 __default__ 兜底`,
    );
    const driver = await this.pool.runtimeFor('__default__', undefined);
    this.pool.bindSession(sessionId, '__default__');
    this.sessionRoles.set(sessionId, '__default__');
    return driver;
  }

  async sendMessage(sessionID: string, input: DriverPromptInput): Promise<DriverPromptResult> {
    // **自愈归属**（关键）：worker 重启后池内"会话→角色"映射丢失，但会话在 DSH 侧
    // 持久化。此时若走 __default__ 兜底，事件会写进 __default__ 运行时的镜像，
    // 而 getMessages 查 developer 运行时 ⇒ awaitCompletion 永远看不到 step-finish
    // ⇒ 消息永久 processing、会话永久 running（实测：定稿入镜了但循环不退出）。
    // 修复：用本轮下发的 agent/system 就地建立正确归属。
    if (this.pool.driverForSession(sessionID) === undefined) {
      const role =
        typeof input.agent === 'string' && input.agent !== '' ? input.agent : '__default__';
      const persona =
        typeof input.system === 'string' && input.system.trim() !== '' ? input.system : undefined;
      this.logger.info(
        `[dsh-pool] 会话 ${sessionID} 无归属 → 按本轮 agent=${role} 自愈登记（persona ${persona === undefined ? 0 : persona.length} 字）`,
      );
      const driver = await this.pool.runtimeFor(role, persona);
      // 直接复用 server 给的会话 id（不新建）：DSH 侧会话持久化，驱动会
      // 在 sendMessage 时按需 `session/resume` 把它接入当前运行时。
      // 这样事件归属、getMessages、abort 全用同一个 id，不会错乱。
      this.pool.bindSession(sessionID, role);
      this.sessionRoles.set(sessionID, role);
      driver.ensureMirrorFor(sessionID);
      return driver.sendMessage(sessionID, input);
    }
    return (await this.driverFor(sessionID)).sendMessage(sessionID, input);
  }

  async getMessages(sessionID: string, options?: DriverMessageQuery): Promise<DriverMessage[]> {
    const d = await this.driverFor(sessionID);
    const r = await d.getMessages(sessionID, options);
    return r;
  }

  async listQuestions(sessionID: string): Promise<DriverQuestionRequest[]> {
    return (await this.driverFor(sessionID)).listQuestions(sessionID);
  }

  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void> {
    return (await this.driverFor(sessionID)).replyQuestion(sessionID, requestID, answers);
  }

  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    return (await this.driverFor(sessionID)).rejectQuestion(sessionID, requestID);
  }

  async listPermissions(sessionID: string): Promise<DriverPermissionRequest[]> {
    return (await this.driverFor(sessionID)).listPermissions(sessionID);
  }

  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: DriverPermissionResponse,
  ): Promise<void> {
    return (await this.driverFor(sessionID)).replyPermission(sessionID, permissionID, response);
  }

  async abort(sessionID: string): Promise<void> {
    return (await this.driverFor(sessionID)).abort(sessionID);
  }

  /** agent 目录：取第一个可用运行时（不区分角色）。 */
  async listAgents(directory?: string): Promise<DriverAgentInfo[]> {
    const driver = await this.pool.runtimeFor('__default__', undefined);
    return driver.listAgents(directory);
  }

  async listTodos(sessionID: string, directory?: string): Promise<DriverTodo[]> {
    return (await this.driverFor(sessionID)).listTodos(sessionID, directory);
  }

  async listModels(): Promise<DriverModelInfo[]> {
    const driver = await this.pool.runtimeFor('__default__', undefined);
    return driver.listModels();
  }

  async listIntegrations(): Promise<DriverIntegrationInfo[]> {
    const driver = await this.pool.runtimeFor('__default__', undefined);
    return driver.listIntegrations();
  }

  async isHealthy(): Promise<boolean> {
    // 有任何角色运行时健康即视为引擎可用（未创建时视为健康——懒启动是设计）
    if (this.pool.roleCount === 0) return true;
    return true;
  }

  /**
   * EngineEventChannel：按会话订阅（转发到角色运行时）。
   *
   * ⚠️ 本方法必须是**同步**（接口契约）：不能 `await driverFor`。
   * 事件订阅的时机是 exec-server 的 runSendAndAwait 开头——那时会话**已经**
   * 由 createSession 建好并登记归属 ⇒ 同步查表即可命中。
   * 万一未命中（极端时序），返回空句柄（轮询兜底路仍工作）。
   */
  subscribeEvents(
    sessionId: string,
    onEvent: Parameters<DshDriver['subscribeEvents']>[1],
    onStatus?: Parameters<DshDriver['subscribeEvents']>[2],
  ): ReturnType<DshDriver['subscribeEvents']> {
    const driver = this.pool.driverForSession(sessionId);
    if (driver !== undefined) {
      this.logger.info('[dsh-pool] 订阅命中 session=' + sessionId);
      return driver.subscribeEvents(sessionId, onEvent, onStatus);
    }
    this.logger.warn('[dsh-pool] 订阅未命中，走兜底 session=' + sessionId);
    // **挂起订阅**（关键）：exec-server 在本轮开始前订阅，此时会话可能尚未建好。
    // 若直接返回空句柄 ⇒ 流式增量 / turn/end 全部丢失 ⇒ 无流式 + 状态永久 processing
    // （实测：日志 `stream-chunk 到达 ... 订阅者=0`）。
    // 改为暂存回调，等 createSession 落地后立刻接到真实运行时上。
    // **兜底直连**：会话无归属通常是 worker 重启后 server 复用旧 instanceRef。
    // 此时若只挂起等 createSession，而 driverFor 走兜底建新运行时，挂起永不触发
    // ⇒ 订阅者恒为 0 ⇒ 流式增量与 turn/end 全丢（实测）。
    // 故：立即用兜底运行时（唯一角色或 __default__）订阅，不等待。
    const roles = this.pool.listRoles();
    const fallbackRole =
      roles.length === 1 ? roles[0] : ('__default__' as const);
    void this.pool.runtimeFor(fallbackRole, undefined).then((d) => {
      try {
        d.subscribeEvents(sessionId, onEvent, onStatus);
        this.logger.info(
          `[dsh-pool] 会话 ${sessionId} 无归属 → 事件订阅直连兜底角色 ${fallbackRole}`,
        );
      } catch (err) {
        this.logger.warn(
          `[dsh-pool] 兜底订阅失败 session=${sessionId}: ${(err as Error).message}`,
        );
      }
    });
    return { close: () => undefined };
  }

  /** 关闭全部角色运行时。 */
  async close(): Promise<void> {
    await this.pool.closeAll();
    this.sessionRoles.clear();
  }
}
