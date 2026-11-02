/**
 * opencode 引擎的注入与凭据适配（P1）。
 *
 * **薄包装，行为零变化**：
 * - 注入：既有 `ResourceInjector` 是**拉取式**（自己从 server 拉 skills/tools/mcp/agent-policies，
 *   再落成 opencode 文件形态）。P1 不改变这个拉取模型（改它 = 改行为），只把
 *   "构造 + 调用 injectAll" 收口到 `ResourceInjector` 接缝后面。
 * - 凭据：既有 `model-credential-injector` / `integration-credential-sync` 同理。
 *
 * P4 接入 dsh 时，dsh 的实现会消费**同一份 `EngineConfigSnapshot`**（拉取逻辑复用），
 * 只是落地形态不同（cordis patch 的 `insert:` 形态，见 P0 报告约束 C1）。
 *
 * @module engine/opencode/resources
 */

import {
  ResourceInjector,
  type InjectReport,
  type ResourceInjectorOptions,
} from '../../resources/injector';

import type {
  EngineConfigSnapshot,
  EngineModelCredential,
  ResourceInjector as ResourceInjectorSeam,
  WorkerEngineKind,
} from '../types';

/** opencode 注入器适配参数（含拉取所需鉴权；与 `ResourceInjectorOptions` 一致）。 */
export type OpencodeResourceOptions = ResourceInjectorOptions;

/**
 * opencode 的 `ResourceInjector` 接缝实现。
 *
 * `apply(snapshot, workDir)` 的语义映射：
 * - `snapshot` 的**内容**仍由既有 `injectAll()` 从 server 拉取（P1 保持拉取式）；
 * - `workDir` 覆盖构造时的落点（多会话共享 worker 时需要）。
 *
 * 之所以不把 `snapshot` 直接写进 opencode 文件：那会**改变既有注入语义**
 * （快照是三段式的引擎无关视图，而既有落盘逻辑包含 manifest 合并、失败中性化、
 * 受管块保留等一整套策略）。P1 的纪律是"只搬家不改行为"，故快照参数在 opencode
 * 实现里暂时忽略并记录——P4 再统一切换到快照驱动。
 */
export class OpencodeResourceInjector implements ResourceInjectorSeam {
  readonly kind: WorkerEngineKind = 'opencode';

  private readonly options: OpencodeResourceOptions;
  private current: ResourceInjector | null = null;
  private currentWorkDir: string | null = null;

  constructor(options: OpencodeResourceOptions) {
    this.options = options;
  }

  /**
   * 应用注入快照。
   *
   * P1 行为：按 `workDir` 构造（或复用）既有 `ResourceInjector`，跑 `injectAll()`。
   * 返回报告通过 `lastReport` 暴露（`index.ts` 上报 agentPolicies 能力位仍需要它）。
   */
  async apply(_snapshot: EngineConfigSnapshot, workDir: string): Promise<void> {
    const injector = this.ensure(workDir);
    this.lastReportValue = await injector.injectAll();
  }

  /** 清理受管块（worker 卸载时；P1 未实现——既有实现也没有等价清理入口）。 */
  async cleanup(_workDir: string): Promise<void> {
    // 既有 `ResourceInjector` 没有"清理受管块"的公开方法（它靠 manifest 逐轮覆盖）。
    // P1 保持原样：不引入新行为。P4 若需要（dsh 的 profile 目录清理）再补。
  }

  /** 最近一次注入报告（供 `index.ts` 上报 agentPolicies 能力位）。 */
  get lastReport(): InjectReport | null {
    return this.lastReportValue;
  }

  /** 当前使用的既有注入器（迁移期供 `index.ts` 继续调用既有私有入口）。 */
  get injector(): ResourceInjector | null {
    return this.current;
  }

  private lastReportValue: InjectReport | null = null;

  /** 按 workDir 复用（同一 workDir 复用同一实例，保持既有 manifest 状态）。 */
  private ensure(workDir: string): ResourceInjector {
    if (this.current !== null && this.currentWorkDir === workDir) {
      return this.current;
    }
    this.current = new ResourceInjector({ ...this.options, workDir });
    this.currentWorkDir = workDir;
    return this.current;
  }
}

/**
 * opencode 的 `CredentialApplier` 接缝实现（P1 占位：**转发到既有函数式 API**）。
 *
 * 既有凭据链路是"server 下发 → worker 写 auth.json / provider settings / integration store"，
 * 由 `index.ts` 的命令处理路径直接调用函数。P1 不搬动这条链路（搬动 = 改行为），
 * 只提供接缝形状，供 P2/P4 的 dsh 实现并列存在。
 */
export class OpencodeCredentialApplier {
  readonly kind: WorkerEngineKind = 'opencode';

  /** P1：不实现（既有链路由 index.ts 的命令处理直接驱动，见 applyConfig 注释）。 */
  async apply(_credentials: EngineModelCredential[]): Promise<void> {
    throw new Error(
      '[engine/opencode] 凭据下发尚未迁移到接缝：P1 阶段仍由 index.ts 的下行命令路径' +
        '（model-credentials / integration-credential-sync）直接处理；P4 统一切换',
    );
  }

  async clear(_providerIDs?: string[]): Promise<void> {
    throw new Error('[engine/opencode] 凭据清理尚未迁移到接缝（P4 统一切换）');
  }
}
