/**
 * 引擎接缝（Engine Seams）——worker 的**执行引擎抽象层**（P1 / 计划 D1）。
 *
 * 为什么需要这一层（而不是把 opencode 逻辑散在各处）：
 * worker 里有一批能力**深度绑定 opencode 的形态**，但它们并非同一个层次：
 * - 有的管**进程**（spawn serve / 端口探测 / 健康检查 / 热重载 / MCP 状态探测）；
 * - 有的管**注入**（把 skills/tools/mcp/agent-policies 落成 opencode 的配置文件）；
 * - 有的管**凭据**（写 auth.json / provider settings / credential store）；
 * - 有的管**工作区目录约定**（`.opencode/plans`、`.opencode/skills`、`.omo/*`）。
 *
 * 不抽象的代价：接第二个引擎时每一处都要 `if (engine === 'dsh')`，第三个引擎再翻一遍
 * （这正是本次重构的直接动机）。抽象之后，新增引擎 = 实现这些接口 + 写一个 patch 生成器。
 *
 * 分层铁律（与本仓库既有约定一致）：
 * 1. **本文件不得 import 任何引擎实现**（只描述形状）——避免类型层把 opencode 类型带进来。
 * 2. **接口只表达业务层真正消费的信息**：不镜像上游形状（opencode 的 `/api/session`
 *    路径、dsh 的 `session/prompt` 方法名都不许出现在这里）。
 * 3. driver（`src/driver/`）与被驱动端 API 翻译有关；engine（本目录）与**进程与注入治理**
 *    有关。两者职责不同，**不合并**（driver 的 15 方法契约保持稳定）。
 *
 * @module engine/types
 */

/** 最小日志接口（duck typing，与 driver 的 Logger 同形状但独立声明，避免跨层耦合）。 */
export interface EngineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 引擎类型（部署参数 `WORKER_ENGINE` 的取值）。 */
export type WorkerEngineKind = 'opencode' | 'dsh';

/** 引擎能力位——**防止 `if (engine === ...)` 扩散的唯一手段**（P6 在 server 侧消费）。 */
export interface EngineCapabilities {
  /**
   * 引擎版本串（上报给控制面；opencode 模式语义 = 既有 `opencodeVersion` 精确匹配口径）。
   * dsh 模式填 `dsh-<version>`。
   */
  engineVersion: string;
  /** 是否支持逐消息/逐会话切换模型（opencode 支持；dsh 需重启运行时，语义等价但不廉价）。 */
  perMessageModelSwitch: boolean;
  /** 是否暴露计划步骤（todos）给控制面。 */
  todos: boolean;
  /** 是否暴露外部 agent 目录（/agents 端点有意义）。 */
  externalAgents: boolean;
  /** 是否暴露集成注册表（/integrations 端点有意义）。 */
  integrations: boolean;
  /** 是否支持 OmO 相关配置面（/omo-config 端点有意义）。 */
  omoConfig: boolean;
  /** 是否支持计划文档发现（/plan-files 端点有意义）。 */
  planFiles: boolean;
  /** 是否支持在途 steer 注入（否则降级为排队）。 */
  steer: boolean;
  /** 是否支持引擎内 MCP 状态探测（否则上报"未知/配置态"）。 */
  mcpStatusProbe: boolean;
}

/**
 * MCP 服务器连接状态（**vteam 线契约五态**，worker-protocol 的 `McpServerStatus` 同源）。
 *
 * 引擎探测不到时不许编造结论：`probe_failed` 与"无服务器"是两件事（既有实现已踩过坑）。
 */
export type EngineMcpStatus = 'connected' | 'failed' | 'needs_auth' | 'pending' | 'disabled';

/** 单个 MCP 服务器的状态快照。 */
export interface EngineMcpServerStatus {
  name: string;
  status: EngineMcpStatus;
  error?: string;
}

/**
 * 引擎运行时控制器——**引擎进程生命周期与运行态治理**的接缝。
 *
 * opencode 实现 = 现有 `OpencodeServer` + `ServeLog` + `ConfigReloader` + `McpStatusProbe`；
 * dsh 实现 = 每个活跃会话一个 `dsh --profile sdk` 运行时（或共享运行时，见 P0 报告 C6）。
 */
export interface EngineRuntimeController {
  /** 引擎类型标识。 */
  readonly kind: WorkerEngineKind;

  /**
   * 启动引擎（供执行会话使用）。返回引擎基址/会话路由所需的句柄信息。
   * 幂等：已启动时直接返回。
   */
  start(): Promise<void>;

  /** 停止引擎（停掉全部子进程；已停止时幂等）。 */
  stop(timeoutMs?: number): Promise<void>;

  /** 运行态健康检查（不抛异常；不可用返回 false）。 */
  isHealthy(): Promise<boolean>;

  /**
   * 当前引擎是否可用（同步快照，供心跳上报与容量计算）。
   * `start()` 未完成或已失败时为 false。
   */
  readonly isRunning: boolean;

  /**
   * 注册"引擎致命错误"回调：引擎进程意外退出/日志出现致命指纹时通知上层
   * （上层据此上送 health=degraded 并可能触发重启）。
   * 返回取消订阅函数。
   */
  onFatal(handler: (reason: string) => void): () => void;

  /**
   * 应用配置变更（模型凭据 / MCP 配置 / agent-policies / skills / tools 等注入快照）。
   *
   * 语义：**尽量不中断在跑的工作**。opencode 实现走 serve 热重载；dsh 实现对空闲运行时
   * 重启、忙运行时排队到本轮结束（P4 落地细节）。
   */
  applyConfig(snapshot: EngineConfigSnapshot): Promise<void>;

  /** 探测引擎内 MCP 服务器状态；引擎不支持时返回 `null`（上层按配置态降级）。 */
  probeMcpStatus(): Promise<EngineMcpServerStatus[] | null>;

  /** 引擎能力位（心跳/注册上报）。 */
  capabilities(): EngineCapabilities;
}

/**
 * 注入快照——**引擎无关的配置真相**（各引擎自行决定落成什么形态）。
 *
 * 这一层是本次抽象的关键：注入数据本身（skills/tools/mcp/agentPolicies）本来就是
 * 引擎无关的，耦合只发生在"落盘成 opencode 配置文件"这一步（→ ResourceInjector）。
 */
export interface EngineConfigSnapshot {
  /** 工作目录（vteam 平台下发的注入根）。 */
  workDir: string;
  /** 技能清单（名称 + 说明 + 正文；opencode 落 `.opencode/skills/<n>/SKILL.md`）。 */
  skills: EngineSkillSpec[];
  /** 工具清单（引擎自带的工具族，如 git/browser/数据库工具）。 */
  tools: EngineToolSpec[];
  /** MCP 服务器声明（vteam 平台 MCP + 其他）。 */
  mcpServers: EngineMcpServerSpec[];
  /** 角色 agent 策略（提示词 + 权限）。 */
  agentPolicies: EngineAgentPolicy[];
  /** 模型凭据（providerID → 凭据与端点）。 */
  modelCredentials: EngineModelCredential[];
}

/** 技能声明（引擎无关形态）。 */
export interface EngineSkillSpec {
  name: string;
  description: string;
  /** SKILL.md 正文（frontmatter 之外）。 */
  body: string;
}

/** 自定义工具声明（引擎无关形态；与 `resources/custom-tool.ts` 的 ToolSpec 同源）。 */
export interface EngineToolSpec {
  /** 工具名（= 权限 action，契约不可变）。 */
  name: string;
  description: string;
  /** JSON Schema 参数（两引擎都接受 JSON Schema）。 */
  parameters: Record<string, unknown>;
  /** 执行方式：本地命令 / HTTP 转发 / 内联脚本。 */
  execution: EngineToolExecution;
}

/**
 * 工具执行方式（与既有 `custom-tool.ts` 的三分支一致）。
 * 注意：dsh 侧工具必须经 MCP 暴露（P4 的 mcp-tool-server），execution 语义由该 server 实现。
 */
export type EngineToolExecution =
  | { kind: 'cli'; command: string[] }
  | { kind: 'http'; method: string; url: string; headers?: Record<string, string> }
  | { kind: 'code'; body: string };

/** MCP 服务器声明（引擎无关形态）。 */
export interface EngineMcpServerSpec {
  /** 命名空间（工具名前缀来源；`[A-Za-z0-9_-]{1,32}`）。 */
  name: string;
  /** 传输方式。 */
  transport: 'stdio' | 'streamable-http';
  /** stdio：可执行文件与参数。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable-http：端点与请求头。 */
  url?: string;
  headers?: Record<string, string>;
}

/** 角色 agent 策略（提示词 + 权限规则）。 */
export interface EngineAgentPolicy {
  /** agent 名（vteam 口径 `vteam-<agentKey>`）。 */
  name: string;
  /** 系统提示词（角色人设）。 */
  system: string;
  /** 权限规则（引擎无关表述：工具名 + 允许/询问/拒绝）。 */
  permissions: EnginePermissionRule[];
}

/** 权限规则（引擎无关表述；落成 opencode 的 `{action,resource,effect}` 或 dsh 的 preset）。 */
export interface EnginePermissionRule {
  /** 工具名或通配（`*`）。 */
  action: string;
  /** 决策。 */
  effect: 'allow' | 'ask' | 'deny';
}

/** 模型凭据（引擎无关形态；落点由各引擎决定：auth.json / env / patch）。 */
export interface EngineModelCredential {
  /** providerID（vteam 口径）。 */
  providerID: string;
  /** modelID（vteam 口径；引擎需要它来声明"这条凭据服务哪个模型"）。 */
  modelID?: string;
  /** API key（明文只在内存与受限 env 中存在，绝不进日志）。 */
  apiKey: string;
  /** 自定义端点（可选；OpenAI 兼容网关需要）。 */
  baseUrl?: string;
  /**
   * 该 provider 下**平台已配置的全部模型**（可选）。
   *
   * dsh 的 cordis patch 必须逐模型声明，运行时才认识、才切得动（`session/selectModel`）。
   * 缺省时退化为「只声明凭据里的那一个 modelID」——那也是把平台模型挡在门外的原因：
   * 平台配了 N 个模型，运行时只认得 1 个。
   */
  models?: Array<{ id: string; name: string }>;
}

/**
 * 资源注入器——**注入快照 → 引擎落地产物**的接缝。
 *
 * opencode 实现 = 现有 `injector.ts` + `opencode-config-builder.ts` + `custom-tool.ts` 渲染；
 * dsh 实现 = 生成 `insert:` 形态的 cordis patch（P0 报告约束 C1）。
 */
export interface ResourceInjector {
  /** 引擎类型标识。 */
  readonly kind: WorkerEngineKind;

  /**
   * 应用注入快照（把 skills/tools/mcp/agentPolicies 落成该引擎的配置产物）。
   *
   * 铁律（既有实现已确立）：**注入失败时保留上次受管块**，避免"权限放大"
   * （拉取失败若清空配置，模型会回落到该引擎的默认全权限）。
   *
   * @returns 产物路径（引擎需要在启动时引用它，如 dsh 的 `--patch <file>`；
   *   opencode 无此概念时返回 undefined）。
   * @param snapshot - 引擎无关快照。
   * @param workDir - 注入根目录。
   */
  apply(snapshot: EngineConfigSnapshot, workDir: string): Promise<string | void>;

  /** 清理受管块（worker 卸载/会话结束时；不删引擎自身配置）。 */
  cleanup(workDir: string): Promise<void>;
}

/**
 * 凭据应用器——**模型凭据 → 引擎落点**的接缝。
 *
 * opencode 实现 = 现有 `model-credential-injector.ts` + `integration-credential-sync.ts`；
 * dsh 实现 = spawn env（`DEEPSEEK_API_KEY` / provider 对应 apiKeyEnv）+ patch 内 provider 行
 * （P0 报告约束 C3：必须显式 baseURL + api）。
 */
export interface CredentialApplier {
  /** 引擎类型标识。 */
  readonly kind: WorkerEngineKind;

  /** 应用模型凭据快照（幂等；可重复调用）。 */
  apply(credentials: EngineModelCredential[]): Promise<void>;

  /** 清理已下发凭据（worker 下线/凭据撤销时）。 */
  clear(providerIDs?: string[]): Promise<void>;
}

/**
 * 工作区目录布局——**vteam 自有资产**与**引擎私有目录**的解耦点。
 *
 * 现状耦合：`.opencode/plans/*.md`（计划文档）、`.opencode/skills/`、`.omo/*` 这些
 * **引擎的目录约定**散落在 server/worker 多处；接第二个引擎时又要一份约定。
 *
 * 抽象后：vteam 自有资产固定放 `.vteam/`（引擎无关），各引擎在注入时决定如何挂载/读取。
 */
export interface WorkspaceLayout {
  /** vteam 自有资产根（`.vteam`）。 */
  readonly vteamRoot: string;
  /** 计划文档目录（`.vteam/plans`）——server 的 /plan-files 端点读这里。 */
  readonly plansDir: string;
  /** 系统提示词交接目录（`.vteam/system-handoff`）——各引擎自取。 */
  readonly systemHandoffDir: string;
  /** 技能源目录（`.vteam/skills`）——注入时复制/挂载到引擎侧。 */
  readonly skillsSourceDir: string;
}
