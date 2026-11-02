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
 * ⚠️ **延迟加载**：dsh 的实现模块（含 vendored 插件路径、DshDriver）只在 dsh 模式下 import，
 * opencode 模式的加载路径与分发体积保持原样。
 *
 * @param engine - 引擎类型（来自 `resolveWorkerEngineFromEnv` 等）。
 * @param options - 各引擎的构造参数（由调用方按引擎类型准备；缺省用各自默认值）。
 * @param factory - 实现工厂（**测试注入桩用**；生产不传）。
 */
export function createEngine(
  engine: WorkerEngineKind,
  options: EngineConstructOptions = {},
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
  switch (engine) {
    case 'opencode':
      return createOpencodeEngine(options);
    case 'dsh':
      return createDshEngine(options);
  }
}

/** 引擎构造参数（按引擎类型取用；未用到的字段被忽略）。 */
export interface EngineConstructOptions {
  /** opencode：serve 选项 + 可选的注入/凭据配置。 */
  opencode?: {
    serve: import('../runtime/opencode-server').OpencodeServerOptions;
    reloader?: import('../reload/config-reloader').ConfigReloaderOptions;
    mcpProbe?: import('../mcp-status/mcp-status-probe').McpStatusProbeOptions;
  };
  /** dsh：驱动/运行时选项。 */
  dsh?: import('./dsh/runtime').DshRuntimeOptions;
  /** 工作目录（布局与注入根；缺省 process.cwd()）。 */
  workDir?: string;
}

/** opencode 实现装配（延迟 import 避免 dsh 模式加载 opencode 依赖）。 */
function createOpencodeEngine(options: EngineConstructOptions): EngineImplementation {
  const serveOptions = options.opencode?.serve;
  if (serveOptions === undefined) {
    throw new Error('[engine] opencode 引擎缺少 serve 选项（opencode.serve 必填）');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OpencodeRuntime } = require('./opencode/runtime') as typeof import('./opencode/runtime');
  const { OpencodeResourceInjector, OpencodeCredentialApplier } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./opencode/resources') as typeof import('./opencode/resources');
  const { createWorkspaceLayout } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./workspace-layout') as typeof import('./workspace-layout');

  const workDir = options.workDir ?? process.cwd();
  return {
    kind: 'opencode',
    runtime: new OpencodeRuntime({
      serve: serveOptions,
      ...(options.opencode?.reloader === undefined ? {} : { reloader: options.opencode.reloader }),
      ...(options.opencode?.mcpProbe === undefined ? {} : { mcpProbe: options.opencode.mcpProbe }),
    }),
    injector: new OpencodeResourceInjector({
      serverUrl: '',
      workerToken: '',
      workerId: '',
      workDir,
    }),
    credentials: new OpencodeCredentialApplier(),
    layout: createWorkspaceLayout(workDir),
  };
}

/** dsh 实现装配。 */
function createDshEngine(options: EngineConstructOptions): EngineImplementation {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DshRuntime, DshResourceInjector, DshCredentialApplier } =
    require('./dsh/runtime') as typeof import('./dsh/runtime');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createWorkspaceLayout } =
    require('./workspace-layout') as typeof import('./workspace-layout');

  const workDir = options.workDir ?? process.cwd();
  return {
    kind: 'dsh',
    runtime: new DshRuntime(options.dsh ?? {}),
    injector: new DshResourceInjector(),
    credentials: new DshCredentialApplier(),
    layout: createWorkspaceLayout(workDir),
  };
}
