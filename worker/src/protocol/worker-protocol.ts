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
   * worker 可执行模型 id 列表（`opencode models` CLI 输出解析，Provider.list() 鉴权过滤后
   * 的真实可用集，id 格式 providerID/modelID；探测失败/为空时缺省——server 侧 sync 以此为
   * live 真值优先采用，缺省回退 serve /api/model 拉取）。
   */
  executableModels?: string[];
  /**
   * serve 实际监听端口（F2 C2：随机端口场景必须上报，否则 server 回退连死端口 4199）。
   * 对齐 server worker.client.ts resolveBaseUrl：capabilities.port → http://localhost:{port}。
   */
  port?: number;
  /**
   * serve 对 server 公布的基址（D2：`${WORKER_ADVERTISE_HOST}:${port}`，容器内 http://worker:port）。
   * 对齐 server worker.client.ts resolveBaseUrl：capabilities.baseUrl 优先于 port。
   */
  baseUrl?: string;
  /**
   * T10：worker 执行端点端口（POST /execute，node:http 独立监听，env WORKER_EXEC_PORT 默认 4198）。
   * 随注册上报——server 据此发现 worker 执行端点（方案 A：server 下发 prompt → worker 驱动 serve 主动上送事件）。
   */
  execPort?: number;
  /**
   * 角色 agent 策略能力位（Todo 14：由 injector `injectAll()` 结果驱动）。
   * - 成功写入 agent 节 → `{ enabled: true, names: 本次写入名 }`；
   * - 拉取失败/角色集为空（中性化）→ `{ enabled: false, names: [] }`。
   * 旧 worker 无此字段 → server 视为 false（向后兼容，加法可选字段）。
   */
  agentPolicies?: { enabled: boolean; names: string[]; generatedAt?: string };
}

/** 负载快照（对齐 schema Worker.load Json 与 server WorkerLoadDto）。 */
export interface WorkerLoad {
  instances: number;
}

/**
 * MCP 服务器可用性三态（11 篇 §5.8：needs_auth / connected / failed）。
 * worker 经 `opencode mcp list --pure` 探测（30-60s 节流），随心跳上报控制面。
 */
export type McpServerStatus = 'connected' | 'failed' | 'needs_auth';

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
 * worker 在 buildProviderSection 里翻译为 opencode 配置的 snake_case 输出形状
 * （limit → limit{context,output}；toolCall → tool_call；options 原样透传）。
 * 字段取舍依据见 server models.constants.ts 同名类型注释（v1.18.31 实测）。
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
    | UpdateWorkerCommandPayload;
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
 * POST /worker/events 请求体（对齐 server WorkerEventDto）。
 *
 * `payload` 为各事件自定义负载（逐事件形状由 exec-server 构造处与 server
 * WorkerEventDto/dto 约定）；`task.completed` 额外携带 `model`
 * （`providerID/modelID`，缺失为 `UNKNOWN_MODEL_KEY`）与 step-finish 实测的
 * `tokens`/`cost`。
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
