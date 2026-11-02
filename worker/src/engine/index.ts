/**
 * 引擎工厂——`WORKER_ENGINE` → 具体引擎实现的选择决策（P1 / 计划 D1）。
 *
 * 设计对齐 driver 工厂（`src/driver/index.ts`）的既有做法：
 * - **选择决策与实现落地分离**：`resolveWorkerEngine()` 是纯函数（可单测），
 *   `createEngineRuntime()` 才碰实现。这样"再加一版引擎" = 加实现 + 这里登记一行。
 * - **不做静默回退**：opencode 是默认值；未知值**响亮失败**（避免运维以为切了引擎、
 *   实际跑的仍是另一个）。
 *
 * @module engine/index
 */

import type {
  CredentialApplier,
  EngineRuntimeController,
  ResourceInjector,
  WorkerEngineKind,
  WorkspaceLayout,
} from './types';

/** 重导出引擎类型与接缝接口（调用方从 `../engine` 一处取全，无需知道内部文件名）。 */
export type {
  CredentialApplier,
  EngineAgentPolicy,
  EngineCapabilities,
  EngineConfigSnapshot,
  EngineLogger,
  EngineMcpServerSpec,
  EngineMcpServerStatus,
  EngineMcpStatus,
  EngineModelCredential,
  EnginePermissionRule,
  EngineRuntimeController,
  EngineSkillSpec,
  EngineToolExecution,
  EngineToolSpec,
  ResourceInjector,
  WorkerEngineKind,
  WorkspaceLayout,
} from './types';

/** 支持的引擎取值（`WORKER_ENGINE` 的合法集合）。 */
export const SUPPORTED_ENGINES: readonly WorkerEngineKind[] = ['opencode', 'dsh'];

/** 默认引擎（未设置 `WORKER_ENGINE` 时）。 */
export const DEFAULT_WORKER_ENGINE: WorkerEngineKind = 'opencode';

/** `WORKER_ENGINE` 环境变量名。 */
export const WORKER_ENGINE_ENV = 'WORKER_ENGINE';

/**
 * 引擎取值命中未知值时**可操作**的错误文案。
 *
 * 为什么必须响亮：留一个"看起来能配、实际跑的还是 opencode"的入口，等于让运维在
 * 故障时按错误方向排查（P0 报告同样记录过这类坑）。
 */
export function unsupportedEngineMessage(raw: string): string {
  return (
    `[engine] 不支持的 WORKER_ENGINE=${JSON.stringify(raw)}；` +
    `合法取值：${SUPPORTED_ENGINES.join(' / ')}（缺省 ${DEFAULT_WORKER_ENGINE}）。`
  );
}

/**
 * 解析引擎类型（纯函数）。
 *
 * - 缺省/空串 → 默认 opencode；
 * - 大小写不敏感（部署脚本常写成 `DSH`）；
 * - 未知值 → **抛错**（不静默回落）。
 *
 * @param raw - `WORKER_ENGINE` 原始值（未设置传 undefined）。
 */
export function resolveWorkerEngine(raw: string | undefined | null): WorkerEngineKind {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return DEFAULT_WORKER_ENGINE;
  const hit = SUPPORTED_ENGINES.find((k) => k === trimmed);
  if (hit === undefined) throw new Error(unsupportedEngineMessage(raw ?? ''));
  return hit;
}

/**
 * 从环境变量解析引擎类型（`resolveWorkerEngine` 的便捷包装）。
 * 读 `process.env[WORKER_ENGINE_ENV]`；未知值抛错。
 */
export function resolveWorkerEngineFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerEngineKind {
  return resolveWorkerEngine(env[WORKER_ENGINE_ENV]);
}

/**
 * 引擎实现集合（一个引擎的全部接缝实现）。
 *
 * 为什么打包成一个对象而不是四个独立工厂：四个接缝必须**同一引擎**，
 * 分开注入容易配错（例如用 opencode 的 injector 配 dsh 的 runtime）。
 */
export interface EngineImplementation {
  kind: WorkerEngineKind;
  runtime: EngineRuntimeController;
  injector: ResourceInjector;
  credentials: CredentialApplier;
  layout: WorkspaceLayout;
}

/** 引擎实现的构造入口（测试可注入桩实现）。 */
export type EngineFactory = (engine: WorkerEngineKind) => EngineImplementation;

/**
 * 构造引擎实现（**唯一选择点**；新增引擎在此登记）。
 *
 * ⚠️ 本函数**延迟加载**实现模块：dsh 相关依赖（vendored 插件等）只在 dsh 模式下才碰，
 * opencode 模式的分发体积与加载路径保持原样。
 *
 * @param engine - 引擎类型（来自 `resolveWorkerEngineFromEnv` 等）。
 * @param factory - 实现工厂（缺省按引擎类型分发到真实实现；测试传桩）。
 */
export function createEngine(
  engine: WorkerEngineKind,
  factory?: EngineFactory,
): EngineImplementation {
  if (factory !== undefined) {
    const impl = factory(engine);
    if (impl.kind !== engine) {
      throw new Error(
        `[engine] 工厂返回的实现 kind=${JSON.stringify(impl.kind)} 与请求的 ${JSON.stringify(engine)} 不一致`,
      );
    }
    return impl;
  }
  throw new Error(
    `[engine] 尚未登记引擎实现：${engine}（P1 只落地 opencode 适配与选择决策；` +
      `dsh 实现在 P2/P4 接入后登记到本函数）`,
  );
}
