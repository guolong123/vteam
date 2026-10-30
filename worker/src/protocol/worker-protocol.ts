/**
 * worker 协议双写类型（T1 契约基座）。
 *
 * 与 server/src/workers/dto/ 下三 DTO 结构完全一致，但 worker 为独立进程
 * （架构决策 1B），不得 import server 代码——此处用 interface 双写，
 * 一致性由 contract.spec.ts 通过 JSON 序列化/反序列化互通验证。
 *
 * 事件 id 约定：eventId 格式 `evw_<bootId>_<seq>`（w_ 前缀区分 worker 域；
 * bootId = 进程启动标识，F2 M1：重启后 seq 归零但 bootId 变化，server 侧
 * (workerId, eventId) 内存去重不会把新进程事件误判为重复丢弃）。
 * seq 单调递增（进程内），server 侧按 (workerId, eventId) 内存去重（D4）。
 */
export const WORKER_EVENT_TYPES = {
  HEARTBEAT: 'worker.heartbeat',
  INSTANCE_CREATED: 'instance.created',
  SESSION_UPDATED: 'session.updated',
  MESSAGE_PART_DELTA: 'message.part.delta',
  AGENT_STATUS: 'agent.status',
  TASK_COMPLETED: 'task.completed',
  /** T6：git 工具执行审计（17 篇 §8.2：eventType=git.op，metadata=agent/repo_url/action/结果）。 */
  GIT_OP: 'git.op',
  /** 模型 question / 工具权限确认待用户处理：worker 轮询检测到 pending 后上送（不 abort，serve 继续等）。 */
  SESSION_QUESTION: 'session.question',
  SESSION_PERMISSION: 'session.permission',
} as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[keyof typeof WORKER_EVENT_TYPES];

/** 心跳健康状态（与 server HeartbeatWorkerDto.health 对齐）。 */
export type WorkerHealth = 'ok' | 'degraded';

/** 能力声明（对齐 schema Worker.capabilities Json 与 server WorkerCapabilitiesDto）。 */
export interface WorkerCapabilities {
  maxInstances: number;
  skills: string[];
  tools: string[];
  /**
   * C2：serve 实际可用模型 id 列表（listModels 成功上报，id 格式 providerID/modelID；
   * listModels 失败降级缺省——server 侧 C3 据此合并入库，C7 调度按模型可用过滤）。
   */
  models?: string[];
  /**
   * worker 可执行模型 id 列表（**读 worker 自己那个 serve 的 `GET /api/model`**，
   * serve 作用域 = 与 agent 实际执行同一份配置；id 格式 providerID/modelID；
   * 探测失败/为空时缺省——server 侧 sync 以此为 live 真值优先采用，缺省回退
   * serve /api/model 拉取）。
   *
   * ⚠️ **v2 下不再是 `opencode models` CLI 的输出**：v2 的 CLI 子命令绑**共享后台服务**
   * （端口 49374），读的是**另一个配置作用域** ⇒ CLI 的答案既不含 vteam 自配模型，
   * 也与 serve 的真实状态不一致（且实测退出码 1 ⇒ 注册降级不带本字段）。
   */
  executableModels?: string[];
  /**
   * serve 实际监听端口（F2 C2：随机端口场景上报，便于详情页展示与排障）。
   * ⚠️ v2：控制面**不**用它拨号——它只连 worker 执行端点（见 `execPort`）。
   */
  port?: number;
  /**
   * serve 对控制面公布的基址（D2：`${WORKER_ADVERTISE_HOST}:${port}`，容器内 http://worker:port）。
   * ⚠️ v2：控制面**只取其中的主机部分**（server 侧 `resolveAdvertiseOrigin`）——它连的是
   * 执行端点（`execPort`），**不连** serve 端口。
   */
  baseUrl?: string;
  /**
   * T10：worker 执行端点端口（POST /execute，node:http 独立监听，env WORKER_EXEC_PORT 默认 4198）。
   * 随注册上报——server 据此发现 worker 执行端点（方案 A：server 下发 prompt → worker 驱动 serve 主动上送事件）。
   */
  execPort?: number;
  /**
   * 角色 agent 策略能力位（Todo 14：由 injector `injectAll()` 结果驱动）。
   * - 成功写入 agent 节 → `{ enabled: true, names: 本次写入名 }`（**不带** `stale` = 新鲜）；
   * - 拉取失败/形状非法/角色集为空（本轮**未刷新**）→
   *   `{ enabled: false, names: <上次已知名>, stale: true }`（批次 D-2）。
   * 旧 worker 无此字段 → server 视为 false（向后兼容，加法可选字段）。
   *
   * ⚠️ 批次 D-1：`enabled:false` **不再**意味着「受管块被删除」——中性化路径改为**保留**
   * 上次受管块（权限集不变），`enabled:false` 只表示「本轮**未刷新**」。
   *
   * ⚠️ 批次 D-2（**修正批次 D 注释里那句不成立的保护**）：批次 D 的注释写「陈旧即不派发」，
   * 但代码**从来不是**这样——派发照旧发生，只是能力位门把 **agent 名丢掉** ⇒ opencode 跑
   * **引擎默认 agent** ⇒ 角色的 `permissions[]`（edit deny / bash ask / MCP deny）**对该轮
   * 完全不生效** ⇒ 权限被**放大**（fail-open）。批次 D-2 的实际行为：
   * - `names` = **上次已知**的 agent 名（受管块仍在 worker 本地，内容未改写），
   *   `stale: true` 明示「这是上次已知的权限集，不是本轮的」；
   * - server 的能力位门（`workerSupportsAgentPolicies`）在 `stale:true` 且候选名在
   *   `names` 内时**放行** ⇒ 该轮仍点名角色 agent ⇒ 跑在**保留的**（上次已知）角色权限集上，
   *   既不收窄也不放大；派发侧另有日志留痕（批次 D-3）。
   * - `names` 不含候选名（该 agent 从未被定义给它）→ 门仍不放行。
   */
  agentPolicies?: {
    enabled: boolean;
    names: string[];
    /** true = 本轮未刷新且受管块**保留在本地**（缺席/false = 本轮新鲜）。 */
    stale?: boolean;
    generatedAt?: string;
  };
}

/** 负载快照（对齐 schema Worker.load Json 与 server WorkerLoadDto）。 */
export interface WorkerLoad {
  instances: number;
}

/**
 * MCP 服务器可用性状态（**v2 的五态**，随心跳上报控制面）。
 *
 * ⚠️ **v2 线契约扩展（两端同步）**：v2 的 `GET /api/mcp` 有五个状态
 * （`connected` / `failed` / `needs_auth` / **`pending`** / **`disabled`**），
 * 后两个在旧三态里**无法忠实表达**（`pending`=还在连接中、`disabled`=已配置但停用，
 * 都不是 `failed`）⇒ 折叠进旧三态等于谎报 ⇒ 线契约**两端同时**扩到五态：
 * 本类型 ↔ server 的 `MCP_STATUS`（mcp-servers/dto/mcp-status.dto.ts 的 `@IsIn`）。
 * **server 侧不同步 ⇒ 整个心跳被 400 拒（worker 掉线）**——升级顺序：先 server 后 worker。
 *
 * worker 侧的数据源：**worker 自己那个 serve** 的 `GET /api/mcp`（不是 opencode CLI——
 * v2 的 CLI 绑共享后台服务，读的是另一个配置作用域）。
 */
export type McpServerStatus =
  | 'connected'
  | 'failed'
  | 'needs_auth'
  | 'pending'
  | 'disabled';

/** 单台 MCP 服务器状态上报条目（serverName 与 mcp_servers.name 对应）。 */
export interface McpStatusEntry {
  serverName: string;
  status: McpServerStatus;
}

/** POST /workers/register 请求体（对齐 server RegisterWorkerDto）。 */
export interface RegisterWorkerPayload {
  workerId: string;
  name?: string;
  opencodeVersion: string;
  capabilities: WorkerCapabilities;
  load: WorkerLoad;
  /** C2：worker 配置的默认模型（env WORKER_DEFAULT_MODEL，可选；id 格式 providerID/modelID，C7 兜底用） */
  defaultModelId?: string;
  /** 内置 vteam MCP 地址覆盖（env WORKER_MCP_URL，可选；server 按 worker 覆盖下发） */
  mcpUrl?: string;
  /**
   * worker 代码版本（worker-self-update Todo 2）：`resolveCodeVersion()` 的解析结果
   * （env WORKER_CODE_VERSION > dist/version.js > 'dev'）。可选——旧 worker 不携带，
   * server 按「缺席 = 保留已有值」处理，不会因为缺这个键报错或清空。
   */
  codeVersion?: string;
  /**
   * 自更新执行状态（worker-self-update Todo 3 ↔ Todo 4 共享契约，字段名逐字对齐）：
   * pending/downloading/restarting/ready-manual/rolledback。可选——缺席 = 「本次没上报」，
   * 旧 worker 不携带，server 不写该列、不报错。
   */
  updateState?: WorkerUpdateState;
  /**
   * 最近一次自更新是否已被自动回滚（一次性结果标志，可保持 true 供 UI 展示「已回滚」）。
   * 缺席 = 未上报（server 不覆盖已有值）；显式 false 才落 false。
   */
  rolledBack?: boolean;
}

/** POST /workers/:id/heartbeat 请求体（对齐 server HeartbeatWorkerDto）。 */
export interface HeartbeatWorkerPayload {
  workerId: string;
  load: WorkerLoad;
  health: WorkerHealth;
  /** T8c：MCP 服务器三态快照（节流探测结果；可选，兼容旧 server 不携带） */
  mcpStatus?: McpStatusEntry[];
  /**
   * worker 代码版本（worker-self-update Todo 2）：与 register 同字段同口径；可选，
   * 旧 worker 心跳不携带（server 按「缺席 = 保留上次上报值」处理）。
   */
  codeVersion?: string;
  /**
   * 自更新执行状态（共享契约，与 register 同字段同口径）。
   * server 据此收敛 update 指令（对齐/已回滚即清 pending，见 workers.service.ts
   * convergePendingUpdateCommand），并落库供 UI 展示状态行。
   */
  updateState?: WorkerUpdateState;
  /** 最近一次自更新是否已被自动回滚（共享契约，与 register 同字段同口径）。 */
  rolledBack?: boolean;
}
/** 下行命令 type 枚举（T4a：对齐 server WORKER_COMMAND_TYPES）。 */
export const WORKER_COMMAND_TYPES = {
  /** 资源（skills/tools/mcp 配置）变更：重拉 + 注入 + 重启（T4b/T4c 执行） */
  RELOAD_CONFIG: 'reload-config',
  /**
   * C5b：模型凭据下发——worker 写 $HOME/.local/share/opencode/auth.json
   * （opencode 1.18.16 实测固定读取路径，XDG_DATA_HOME 不参与）注入 + 重启生效。
   * 命令一次有效（心跳取出即清空）；token 只经下行命令明文传输，不落 worker 日志。
   */
  MODEL_CREDENTIALS: 'model-credentials',
  /**
   * UX-01：管理员远程重启（对齐 server WORKER_COMMAND_TYPES.RESTART）——经
   * RestartCoordinator 重启 serve（无活跃会话立即 + reRegister，有则挂起）。
   */
  RESTART: 'restart',
  /**
   * UX-01：管理员远程下线（对齐 server WORKER_COMMAND_TYPES.SHUTDOWN）——优雅
   * 退出进程（停心跳 + flush 事件 + stop serve + exit），心跳停止后 server 标 offline。
   */
  SHUTDOWN: 'shutdown',
  /**
   * 仓库凭证下发——worker 幂等写 ~/.keta-git-creds.json（600 权限，**不重启 serve**，
   * git 工具每次执行读文件）。命令一次有效（心跳取出即清空）；key 只经下行命令
   * 明文传输，不落 worker 日志。按 worker 承载活跃 agent 的授权仓库过滤打包。
   */
  GIT_CREDENTIALS: 'git-credentials',
  /**
   * worker-self-update：管理员点【更新】→ server 经既有 commands 通道下发（对齐
   * server workers.constants.ts WORKER_COMMAND_TYPES.UPDATE_WORKER = 'update-worker'）。
   * **目标版本走 `resourceVersion`**（server 侧 requestUpdate 入队时写的就是期望版本，
   * 见 workers.service.ts `enqueueCommand({type: UPDATE_WORKER, resourceVersion: expectedVersion})`）；
   * worker 侧同时兼容 payload.version 形态（未来若 server 改成显式负载）。
   * 执行器见 update/worker-updater.ts；命令一次有效，取出后由 server 侧收敛规则清理。
   */
  UPDATE_WORKER: 'update-worker',
  /**
   * 动态并发上限下发：server 经下行命令把新的 maxInstances 推给 worker，worker 立即
   * 生效（后续注册/心跳 capabilities.maxInstances 与新容量据此）并**本地持久化**
   * （<workDir>/.worker-runtime-config.json，重启后本地优先 env，见 index.ts），
   * **不重启 serve**。旧 worker 不识别本 type → 静默忽略（向后兼容）。
   */
  SET_MAX_INSTANCES: 'set-max-instances',
} as const;

/**
 * 自更新执行状态机取值（worker-self-update **两端共享契约**，逐字对齐 server
 * `src/workers/worker-update-state.ts` 的 WORKER_UPDATE_STATES —— worker 为独立进程
 * 不得 import server 代码，故此处双写，改任一端必须同步另一端）。
 *
 * 状态流转（worker 上报，server 只透传 + 展示，不做推断）：
 *   pending（收到指令，等空闲）→ downloading（下载 + sha256 校验）
 *   → restarting（已覆盖新码，systemd 重启中）/ ready-manual（已下载但无 systemd，等人工重启）
 *   → rolledback（自动回滚已生效）。
 * 失败路径（校验不过 / 下载失败 / 依赖安装失败后回滚）**停在 pending** 等待下轮心跳重试，
 * 或落到 rolledback；绝不会出现「校验失败却报已重启」这种撒谎状态。
 */
export const WORKER_UPDATE_STATES = {
  /** 指令已收到，等待空闲（有活跃会话时保持此态，下轮心跳再试）。 */
  PENDING: 'pending',
  /** 正在下载 tarball 并做 sha256 校验（校验不过即放弃，绝不覆盖旧码）。 */
  DOWNLOADING: 'downloading',
  /** 新码已覆盖，systemd 重启执行中（重启后 worker 进程即换新码）。 */
  RESTARTING: 'restarting',
  /** 新码已覆盖但无 systemd：等人工重启（worker 绝不自杀、不 process.exit）。 */
  READY_MANUAL: 'ready-manual',
  /** 自动回滚已生效（新版本注册不上，已恢复 dist.prev 并上报）。 */
  ROLLEDBACK: 'rolledback',
} as const;

export type WorkerUpdateState =
  (typeof WORKER_UPDATE_STATES)[keyof typeof WORKER_UPDATE_STATES];

export type WorkerCommandType =
  (typeof WORKER_COMMAND_TYPES)[keyof typeof WORKER_COMMAND_TYPES];

/**
 * C5：模型凭据下发条目（provider → 明文 API key）。
 * token 仅存在于下行命令（心跳取出即清空，一次性），worker 侧只写入 auth.json。
 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/**
 * C8：per-model 能力声明（对齐 server ModelCapabilities 双写，内部 camelCase）。
 *
 * 本类型是**下行负载的输入契约**（server → worker，字段仍是 camelCase，不变）；
 * 翻译为 opencode 配置的**输出形状**发生在
 * `credentials/model-credential-injector.ts` 的 buildModelEntry / buildV2Capabilities
 * ——**v2 目标形状**（opencode v2.0.28 实测）：
 * - `toolCall` → `capabilities.tools`（未声明 → true）
 * - `modalities.input` / `modalities.output` → `capabilities.input` / `capabilities.output`
 * - `attachment: true` → 并入 `capabilities.input`（v2 无附件布尔键）
 * - `options` → `settings`（v2 把 SDK 选项改叫 settings）
 * - `limit` → `limit`（v2 要求 context+output 同时存在，残缺则整体丢弃）
 * - `reasoning` / `temperature` → **不写**（v2 归一化会把这两个键剥掉，写出去只会
 *   造成「看着声明了、实际没生效」的假象；思考强度经 options.reasoningEffort →
 *   settings.reasoningEffort 生效）
 * ⚠️ v2 会**静默丢弃** v1 的 legacy 键（tool_call / attachment / modalities 等），
 * 只留一行 `configuration normalization diagnostic` WARN——故输出必须直接写成 v2 形状。
 *
 * 字段取舍依据见 server models.constants.ts 同名类型注释（wire 契约来源）。
 */
export interface ModelCapabilities {
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  toolCall?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  options?: Record<string, unknown>;
}

/** provider 配置条目内的单模型项。 */
export interface ProviderModelEntry {
  name?: string;
  capabilities?: ModelCapabilities;
}

/**
 * C6/C8：baseUrl provider 的 opencode 配置条目（对齐 server ModelProviderConfigEntry 双写）。
 * server 是事实源：每次下发/回放都携带当前全量（非增量）；worker 侧写入
 * opencode.json 的 `provider` 段（local/custom 及带自定义 baseUrl 的 cloud provider，
 * 否则 opencode 只认内置端点，自定义 baseUrl 永远不可达）。
 * `models` 形态双形状兼容：**旧 server 下发 string[]（仅模型 id）**、
 * 新 server 下发 Record<modelID, ProviderModelEntry>（含 per-model 能力）。
 */
export interface ModelProviderConfigEntry {
  /** OpenAI 兼容根（SDK 自行追加 /models 与 /chat/completions 路径） */
  baseUrl: string;
  /** 该 provider 在 server 目录中的模型集合（opencode 1.18.31 实测：custom
   * provider 不自动发现 `{baseURL}/models`，必须显式 models map，否则静默不出现） */
  models: string[] | Record<string, ProviderModelEntry>;
}

/**
 * C5：model-credentials 命令负载（对齐 server ModelCredentialsPayload）。
 * targetWorkerIds 空 = 全量（server 侧已按广播/定向分好——定向走 enqueueCommand、
 * 全量走 broadcastCommand；worker 侧仅消费 providerKeys + providerConfigs，
 * targetWorkerIds 为元数据）。
 */
export interface ModelCredentialsPayload {
  providerKeys: ModelCredentialEntry[];
  /** 定向 worker id 列表；空 = 全量下发 */
  targetWorkerIds?: string[];
  /**
   * C6：opencode.json `provider` 段全量状态（providerID → baseUrl + models）。
   * undefined = 不触碰配置文件（旧 server 下发的负载，向后兼容）；
   * {} = 清空全部 provider 配置（所有 baseUrl provider 已移除）。
   */
  providerConfigs?: Record<string, ModelProviderConfigEntry>;
  /**
   * v2：**已吊销**凭据的 providerID 全量清单（integration 维度的删除信号）。
   * worker 据此删除 serve credential store 里对应的行——否则 vteam 侧删了 key、
   * serve 还拿旧 key 继续跑（吊销不同步 = 凭据泄漏面）。
   * undefined = 旧 server（无吊销同步语义，忽略）；[] = 明确没有吊销项。
   * 配置段 provider 的吊销仍走 opencode.json（buildProviderSection 摘掉 settings.apiKey），
   * worker 侧会把它们从本清单里过滤掉。
   */
  revokedProviderIDs?: string[];
}

/**
 * 仓库凭证下发条目（repoUrl → 明文 SSH 私钥/HTTPS token，来自下行 git-credentials 命令）。
 * 凭证面=worker 级：同 worker 承载的活跃 agent 共享已下发凭证（工具层按 repoUrl 白名单校验）。
 * key 仅存在于下行命令（心跳取出即清空，一次性），worker 侧只写入 .keta-git-creds.json。
 */
export interface GitCredentialEntry {
  repoUrl: string;
  /** 认证类型：ssh_key=SSH 私钥、https_token=HTTPS token（对齐 server GitCredentialEntry.authType）。 */
  authType: 'ssh_key' | 'https_token';
  /** 明文 SSH 私钥或 HTTPS token（600 权限落盘，绝不进日志）。 */
  key: string;
  /** 脱敏标识（透传，worker 落盘供审计比对，不含明文）。 */
  fingerprint: string;
  /** 该仓库在 worker 凭证面上的最高授权权限（write > read；git.ts push 工具据此校验 write）。 */
  permission?: string;
}

/**
 * git-credentials 命令负载（对齐 server GitCredentialsPayload，todo 3 双写）。
 * targetWorkerIds 空 = 全量；credentials 为空数组 = 清下发（吊销后 worker 移除条目）。
 */
export interface GitCredentialsPayload {
  credentials: GitCredentialEntry[];
  /** 定向 worker id 列表；空 = 全量下发 */
  targetWorkerIds?: string[];
}

/**
 * update-worker 命令负载（可选形态）。
 *
 * 现网 server（Todo 3 已落地）把目标版本写在命令的 `resourceVersion` 上、**不带** payload；
 * 本接口是为了让「将来 server 若改成显式负载」时 worker 无需改代码即可工作，故执行器
 * 读 `payload?.version ?? command.resourceVersion`（两者都缺 → 放弃本次执行并告警）。
 */
export interface UpdateWorkerCommandPayload {
  version: string;
}

/**
 * set-max-instances 命令负载：动态并发上限（正整数）。
 * worker 收到后立即生效并本地持久化；非法值（非整数/<1）忽略。
 */
export interface SetMaxInstancesPayload {
  maxInstances: number;
}

/**
 * 心跳响应携带的下行命令（T4a，对齐 server WorkerCommand）。
 * 设计为通用 commands 数组（复用点：AgentsModule 配置变更重启也走此通道）。
 */
export interface WorkerCommand {
  type: WorkerCommandType;
  /** 资源版本号：T1/T2 变更时递增，worker 侧据此判断是否需重拉注入 */
  resourceVersion: string;
  /** C5/T6：model-credentials 或 git-credentials 命令携带的凭据负载（仅该两 type 携带；reload-config 等不携带） */
  payload?:
    | ModelCredentialsPayload
    | GitCredentialsPayload
    | UpdateWorkerCommandPayload
    | SetMaxInstancesPayload;
}

/** POST /workers/:id/heartbeat 成功响应（对齐 server workers.service.ts heartbeat 返回）。 */
export interface HeartbeatResponse {
  workerId: string;
  status: string;
  lastHeartbeatAt: string;
  /** T4a：待执行下行命令；无命令时不携带 */
  commands?: WorkerCommand[];
  /**
   * worker-self-update Todo 2：server 侧的期望代码版本（env CODE_VERSION = deploy TAG）。
   * **纯信息字段**——server 不因它的存在产生任何更新语义（更新指令走上面既有的
   * commands 通道）。env 未配置时 server 整字段省略，故此处也可缺省。
   * 本轮 worker 只接收不执行（执行器属更新执行任务）。
   */
  expectedVersion?: string;
}

export interface ExecutionConfig {
  permissions: Record<string, 'allow' | 'ask' | 'deny'>;
  writePaths: string[];
}

/**
 * 用量统计口径的模型缺失哨兵串。
 *
 * `task.completed` 事件体的 `model` 字段语义：`providerID/modelID` 组合串（与
 * WorkerCapabilities.models 的 id 格式一致）；payload.model 缺省/null 时落本串，
 * 使"模型未知"与"真实模型名"在下游聚合时可区分。server 侧 usage 落库
 * （worker-event.ingress TaskCompletedPayload.model → model_usage.model）采用
 * 同一口径，两端常量各自定义但值必须一致。
 */
export const UNKNOWN_MODEL_KEY = 'unknown';

/**
 * 上游身份（v2 事件去重身份；T12 引入）。
 *
 * 为什么需要：worker→server 的传输 id（`evw_<bootId>_<seq>`）是**进程内**的——
 * worker 重启后 bootId 变化、seq 归零，同一个上游事件会被当成新事件再发一遍。
 * 而 v2 事件自带**跨进程稳定**的身份：帧 id（`evt_…`）、durable 游标
 * （`aggregateID` + `seq`）、内容序号（`ordinal`）。把这层身份随事件体带上去，
 * server 侧就能按「上游身份」而不是「传输 id」去重——**跨 worker 重启也成立**。
 *
 * 载体：`WorkerEventPayload.payload.upstream`（**载荷内**的附加字段，不改信封形状）。
 */
export interface UpstreamEventIdentity {
  /**
   * 上游事件 id（v2 帧的 `id`，形如 `evt_…`）。
   *
   * 例外：**拉取派生**的事件（权限/问题的 pending 列表拉取）没有自己的事件帧，
   * 此时填**上游对象 id**（权限请求 id / 表单 id）——那才是该事件在服务端可去重的
   * 稳定标识（一次触发可能拉取出多条请求，用触发事件 id 会把它们折叠成一条）。
   */
  eventId: string;
  /** durable 聚合 id（v2 帧 `durable.aggregateID`；会话级事件即会话 id）。 */
  aggregateId?: string;
  /** durable 序号（v2 帧 `durable.seq`）：同一聚合内单调递增 → 可作幂等键。 */
  seq?: number;
  /**
   * 内容序号（v2 帧 `data.ordinal`）。
   *
   * ⚠️ **不是逐帧计数器**（opencode v2.0.28 实机抓帧：同一条 assistant 消息的
   * 多帧 `session.text.delta` 全是同一个 ordinal）——它是「同类内容流」的序号。
   * ⇒ 只作参考信息，**不得**当逐帧单调量用（否则同一消息的多帧会被折叠成一条）。
   */
  ordinal?: number;
}

/**
 * POST /worker/events 请求体（对齐 server WorkerEventDto）。
 *
 * `payload` 为各事件自定义负载（逐事件形状由 exec-server 构造处与 server
 * WorkerEventDto/dto 约定）；`task.completed` 额外携带 `model`
 * （`providerID/modelID`，缺失为 `UNKNOWN_MODEL_KEY`）与 step-finish 实测的
 * `tokens`/`cost`。
 *
 * ⚠️ **上游身份**：v2 事件映射出的事件会在 `payload.upstream` 里附带
 * `UpstreamEventIdentity`（见上）——传输 id（`eventId` 字段）是 worker 进程内
 * 的，跨重启不复用；上游身份才跨重启稳定。
 */
export interface WorkerEventPayload {
  workerId: string;
  eventId: string;
  type: WorkerEventType;
  payload: Record<string, unknown>;
  seq: number;
}

/** serve question 选项（GET /api/session/{id}/question data[].questions[].options）。 */
export interface SessionQuestionOption {
  label: string;
  description: string;
}

/** serve question 单条（对齐 QuestionV2Info：question/header/options/multiple?/custom?）。 */
export interface SessionQuestionInfo {
  question: string;
  header: string;
  options: SessionQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** session.question 事件负载（server AgentQuestion.content.questions 透传形状）。 */
export interface SessionQuestionPayload {
  /** opencode 会话 id（ses_ 前缀，server 经 instanceRef 反查平台 Session）。 */
  sessionId: string;
  /** serve question request id（que_ 前缀，reply 时回传）。 */
  requestId: string;
  taskId?: string;
  agentId?: string;
  questions: SessionQuestionInfo[];
}

/**
 * 敏感命令执行输入（POST /secret-command 业务体，todo 3 双写）。
 *
 * 独立于 question/answers 明文回显通道：`secrets` 明文只经此请求体进入 worker，
 * 不落日志、不进错误 message、不回写任何事件。`commandTemplate` 为原始模板
 * （含 `{{NAME}}` 占位符），渲染结果只在 worker 进程内存中短暂存在。
 */
export interface SensitiveCommandInput {
  /** 命令模板（shell 命令行，`{{NAME}}` 占位符由 secrets 精确替换）。 */
  commandTemplate: string;
  /** 变量名 → 明文值（secret，绝不进日志/错误 message/响应）。 */
  secrets: Record<string, string>;
  /**
   * 相对 worker workDir 的执行目录（缺省 = workDir 根）。绝对路径、`..`、
   * NUL 与符号链接逃逸一律拒绝（由 runSensitiveCommand 校验）。
   */
  cwd?: string;
  /** 执行超时 ms（缺省 60000，硬上限 600000）；超时/取消对进程组 SIGKILL。 */
  timeoutMs?: number;
}

/**
 * 敏感命令执行结果（脱敏 + 截断之后的形状，worker 唯一对外出口）。
 *
 * 约束：本结构任何字段都不得包含渲染后命令、argv、cwd 或未脱敏文本；
 * `stdout`/`stderr` 已做精确值替换 → 残留占位符掩码 → 每流 32KB 截断。
 */
export interface SensitiveCommandOutput {
  /** succeeded=exit 0；failed=非 0 或启动失败；timeout=超时/取消后进程组被杀。 */
  status: 'succeeded' | 'failed' | 'timeout';
  /** 进程退出码（被信号杀死或启动失败为 null）。 */
  exitCode: number | null;
  /** 端到端耗时 ms。 */
  durationMs: number;
  /** 脱敏 + 截断后的标准输出。 */
  stdout: string;
  /** 脱敏 + 截断后的标准错误。 */
  stderr: string;
  /** stdout 是否被截断到 MAX_SENSITIVE_OUTPUT_BYTES。 */
  stdoutTruncated: boolean;
  /** stderr 是否被截断到 MAX_SENSITIVE_OUTPUT_BYTES。 */
  stderrTruncated: boolean;
  /**
   * 基础设施级失败原因（已脱敏；仅 spawn/启动失败等场景填写）。
   * 命令自身非 0 退出不填——原因看脱敏后的 stderr，避免把命令输出折进 error。
   */
  error?: string;
}

/** POST /secret-command 请求体（todo 4 路由契约，server SecretCommandRequestDto 双写）。 */
export interface SecretCommandRequestPayload extends SensitiveCommandInput {
  /** 幂等键：同 requestId + 同归属 → 返回既有结果；不同归属 → 409。 */
  requestId: string;
  /** 平台 Task 主键（t_ 前缀，幂等归属判定）。 */
  taskId?: string;
  /** opencode 会话 id（ses_ 前缀，幂等归属判定）。 */
  sessionId?: string;
}

/** POST /secret-command 响应体（todo 4 路由契约；不回显 commandTemplate/argv/cwd）。 */
export interface SecretCommandResponsePayload extends SensitiveCommandOutput {
  /** 回显幂等键，便于调用方配对。 */
  requestId: string;
}

/** session.permission 事件负载（server AgentQuestion.content.permission 透传形状）。 */
export interface SessionPermissionPayload {
  /** opencode 会话 id（ses_ 前缀，server 经 instanceRef 反查平台 Session）。 */
  sessionId: string;
  /** serve permission request id（per_ 前缀，reply 时回传）。 */
  permissionId: string;
  taskId?: string;
  agentId?: string;
  /** 权限类型（对齐 PermissionV2Request.action，如 bash/edit/webfetch）。 */
  type: string;
  /** 权限目标 pattern（对齐 PermissionV2Request.resources，如 /data/*）。 */
  pattern?: string | string[];
  /** 权限标题（对齐 Permission.title）。 */
  title: string;
}

/* ============================================================================
 * T10 worker exec 端点契约（计划 T10 / 决策 D3：控制面彻底不直连 opencode）
 * ============================================================================
 *
 * 这组类型描述 **worker 执行端点**（`worker/src/exec/exec-server.ts`）新挂的五个
 * 会话/模型端点：
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | POST | `/sessions` | 创建会话 |
 * | POST | `/sessions/:id/prompt` | 下发提示（**入队式**，非同步执行） |
 * | POST | `/sessions/:id/abort` | 中断会话（**幂等**） |
 * | GET  | `/sessions/:id/messages` | 读会话消息（可分页） |
 * | GET  | `/models` | 模型目录 |
 *
 * 为什么要有它们（决策 D3）：
 * - 此前控制面（`server/src/workers/worker.client.ts`）**直连 opencode 的 HTTP 面**
 *   （5 个调用点），违反架构决策 07 §11.5「控制面从不直连 opencode」。
 * - 直连的代价已经兑现过一次：控制面拼的 prompt body **漏了 `system` 字段**
 *   （worker 的驱动拼了）——两处 prompt 构造器静默分叉；收进 worker 后全仓只剩
 *   **一个** prompt 构造点。
 * - 收进 worker 之后，控制面只认**本文件这组 vteam 自有形状**，不再知道被驱动端的
 *   任何 wire 细节（`{location,data}` 包装、`parts[]` vs `content[]`、
 *   `abort` vs `interrupt` …）。
 *
 * ⚠️ **双写提醒**：server 侧的同形状副本由 **T18** 落地（`server/src/workers/` 一侧）。
 * 本文件是 **worker 侧的一半**；改任一端必须同步另一端。
 */

/**
 * 模型目录项（vteam 口径；`GET /models` 的返回项）。
 *
 * ⚠️ 刻意**不是**被驱动端的原始包装（v2 是 `{location, data}`，v1 是 `{data}`）——
 * 那是被驱动端的 wire 形状，控制面不该知道它（D3）。worker 在此把驱动层的模型
 * 条目归一成**这个**形状。
 */
export interface WorkerModelInfo {
  /** 模型 id（`providerID/modelID`）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** provider 段。 */
  providerID: string;
  /** model 段。 */
  modelID: string;
  /** 可用状态（缺失视为可用）。 */
  status?: string;
}

/**
 * GET /models 响应体（模型目录**信封**）。
 *
 * ⚠️ 信封**只有一个键** `models`（刻意**不**返回被驱动端的 `{location,data}` 包装——
 * 那是被驱动端的 wire 形状，控制面不该知道它，见 `WorkerModelInfo` 的说明）。
 *
 * 此前这个信封**只在运行时断言**、不在双写类型里 ⇒ 形状漂移（例如控制面读 `model`）
 * 不会被任何静态检查发现。现在它是**双写契约**的一部分（server 侧同形状副本见
 * `server/src/workers/worker-session-protocol.ts`）。
 */
export interface WorkerModelsResponsePayload {
  /** 模型目录（vteam 口径的条目数组）。 */
  models: WorkerModelInfo[];
}

/**
 * 集成注册表项（vteam 口径；`GET /integrations` 的返回项）。
 *
 * ⚠️ 同 `WorkerModelInfo` 的 D3 口径：只留页面/控制面用得到的字段，**不透传被驱动端的
 * `methods`/`connections` 包装**；输出**不含任何已配的 secret**（`apiKey`/`envNames` 是
 * 「怎么配」的声明，不是「配了什么」的值）。
 */
export interface WorkerIntegrationInfo {
  /** 集成 id（= providerID，如 `opencode-go`）。 */
  id: string;
  /** 展示名（如 `OpenCode Go`）。 */
  name: string;
  /** 是否支持直接填 apikey（`methods` 含 `{type:"key"}`）。 */
  apiKey: boolean;
  /** 该集成识别的环境变量名（仅作提示展示；缺失省略）。 */
  envNames?: string[];
}

/**
 * GET /integrations 响应体（集成注册表**信封**：单键 `integrations`）。
 *
 * 这是「可配置 provider 全集」——像 `opencode-go` 这类没有模型行的内置集成
 * 只能从这里被发现（`GET /models/providers` 查不到它们）。
 * server 侧同形状副本见 `server/src/workers/worker-session-protocol.ts`。
 */
export interface WorkerIntegrationsResponsePayload {
  /** 集成注册表（vteam 口径的条目数组；id 升序由 server 侧排，此处不排序）。 */
  integrations: WorkerIntegrationInfo[];
}

/** 模型引用（vteam 口径：`providerID/modelID`）。 */
export interface WorkerModelRef {
  providerID: string;
  modelID: string;
}

/**
 * 投递策略（vteam 侧语义）。
 *
 * - `steer`：插队（打断当前轮，按新指令重跑）；
 * - `queue`：排队（当前轮结束后再消化）。
 *
 * ⚠️ 被驱动端若无此概念则**忽略**该字段（v1 即如此）——调用方不得依赖它一定生效。
 */
export type WorkerDeliveryMode = 'steer' | 'queue';

/** POST /sessions 请求体（创建会话；body 可为空）。 */
export interface CreateSessionRequestPayload {
  /** 模型选择（可选；缺省用被驱动端默认模型）。 */
  model?: WorkerModelRef | null;
}

/** POST /sessions 响应体（创建会话）。 */
export interface CreateSessionResponsePayload {
  /** 新建的会话 id（被驱动端会话 id）。 */
  sessionId: string;
}

/** POST /sessions/:id/prompt 请求体（下发提示）。 */
export interface SessionPromptRequestPayload {
  /** 提示内容：字符串（归一为单条文本内容单元）或内容单元数组。 */
  prompt: string | unknown[];
  /** 模型选择（可选；缺省用被驱动端默认模型）。 */
  model?: WorkerModelRef | null;
  /** agent 选择（可选；缺省用被驱动端默认 agent）。 */
  agent?: string;
  /** 会话工作目录（可选）。 */
  directory?: string;
  /** 顶层系统提示（产出物协议/@机制等；可选）。 */
  system?: string;
  /** 投递策略（可选；缺省 = 被驱动端默认）。 */
  delivery?: WorkerDeliveryMode;
}

/**
 * POST /sessions/:id/prompt 响应体。
 *
 * ⚠️ **语义边界**：本端点是「**持久化入队**」，**不是**「同步执行」——响应里
 * **没有任何**「agent 已答复」的含义。终态只能看事件（`session.execution.*`）
 * 或再读 `GET /sessions/:id/messages`。
 */
export interface SessionPromptResponsePayload {
  /** 目标会话 id。 */
  sessionId: string;
  /**
   * 被驱动端回执的**收件条目 id**（被驱动端的 inbox item id）。
   * 被驱动端无回执概念时**缺席**（不编造）。
   */
  messageId?: string;
  /**
   * **实际生效**的投递策略（以驱动回执为准——被驱动端可能调整过；驱动不回报时
   * 退回本次请求的值；两者都无 → 缺席 = 被驱动端默认）。
   */
  delivery?: WorkerDeliveryMode;
  /**
   * true = 已被**持久化入队**（admitted）。
   * ⚠️ 它**不代表** agent 已答复，更不代表本轮已完成。
   */
  admitted: boolean;
}

/**
 * POST /sessions/:id/abort 响应体。
 *
 * `interrupted`：true = 确实打断了一轮正在执行的 run；false = 没有（会话空闲/未知）。
 *
 * ⚠️ 驱动契约的 `abort` **无回执细节**（被驱动端的中断结果由驱动内部消化），
 * 故该字段多数情况为 false——它是**弱信号**，**幂等语义不依赖它**
 * （对未知/已结束的会话调用一律 200 成功）。
 */
export interface SessionAbortResponsePayload {
  sessionId: string;
  interrupted: boolean;
}

/** token 用量（vteam 上报口径）。 */
export interface SessionTokenUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * 会话消息内容单元（vteam 侧渲染模型）。
 *
 * 字段口径 = vteam 渲染层/事件信封的 part 形状（`messageID`/`type`/`text`/
 * `summary`/`thoughts`/`detail`/`state`/`tool`/`synthetic`/`time`）——**不是**某一版
 * 被驱动端 wire 字段名的照搬。
 */
export interface SessionMessageContent {
  /** 内容单元 id（增量去重键）。 */
  id?: string;
  /** 所属会话 id。 */
  sessionID?: string;
  /** 所属消息 id（控制面按此关联消息，勿改名）。 */
  messageID?: string;
  /** 内容类别（text/reasoning/tool/error/…）。 */
  type: string;
  /** 文本正文。 */
  text?: string;
  /** 思考摘要。 */
  summary?: string;
  /** 思考明细。 */
  thoughts?: string;
  /** 明细。 */
  detail?: string;
  /** 结算/结束原因（stop / tool-calls / error）。 */
  reason?: string;
  /** 成本。 */
  cost?: number;
  /** token 用量。 */
  tokens?: SessionTokenUsage;
  /** 时间戳（部分内容为 null）。 */
  time?: { start?: number; end?: number; created?: number } | null;
  /** true = 合成文本（工具调用占位，非模型真实输出），聚合时排除。 */
  synthetic?: boolean;
  /** 工具名（tool 类内容）。 */
  tool?: string;
  /** 工具执行状态（tool 类内容），原样透传。 */
  state?: unknown;
  /** 错误详情（error 类内容），原样透传。 */
  error?: unknown;
  /** 其余原始字段原样透传（渲染兜底/诊断用；vteam 不解释其语义）。 */
  [key: string]: unknown;
}

/** 会话消息元信息（vteam 侧）。 */
export interface SessionMessageInfo {
  id: string;
  role: 'user' | 'assistant';
  /** 消息时间戳。 */
  time?: { created?: number; completed?: number };
  /** 消息级错误（模型调用失败等）。 */
  error?: unknown;
  /** 实际使用模型的 provider 段（缺失 = 未回报）。 */
  providerID?: string;
  /** 实际使用模型的 model 段（缺失 = 未回报）。 */
  modelID?: string;
  [key: string]: unknown;
}

/** 一条会话消息（vteam 侧）。 */
export interface SessionMessage {
  info: SessionMessageInfo;
  parts: SessionMessageContent[];
}

/**
 * GET /sessions/:id/messages 的分页 query（vteam 口径）。
 *
 * 与被驱动端上游的 `limit` / `order` / `cursor` 三个参数同名同义——但**形状是
 * vteam 自己的**：控制面只需要能翻页，不需要知道上游的分页返回体长什么样。
 */
export interface SessionMessagesQuery {
  /** 单页条数上限（缺省 = 被驱动端默认）。 */
  limit?: number;
  /** 排序方向（缺省 = 被驱动端默认）。 */
  order?: 'asc' | 'desc';
  /** 游标（缺省 = 从头翻）。 */
  cursor?: string;
}

/** GET /sessions/:id/messages 响应体（读会话消息）。 */
export interface SessionMessagesResponsePayload {
  /** 目标会话 id。 */
  sessionId: string;
  /** 消息列表（vteam 渲染模型形状）。 */
  messages: SessionMessage[];
}
