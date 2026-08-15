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
  /** 内置 keta-platform MCP 地址覆盖（env WORKER_MCP_URL，可选；server 按 worker 覆盖下发） */
  mcpUrl?: string;
}

/** POST /workers/:id/heartbeat 请求体（对齐 server HeartbeatWorkerDto）。 */
export interface HeartbeatWorkerPayload {
  workerId: string;
  load: WorkerLoad;
  health: WorkerHealth;
  /** T8c：MCP 服务器三态快照（节流探测结果；可选，兼容旧 server 不携带） */
  mcpStatus?: McpStatusEntry[];
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
} as const;

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
 * C5：model-credentials 命令负载（对齐 server ModelCredentialsPayload）。
 * targetWorkerIds 空 = 全量（server 侧已按广播/定向分好——定向走 enqueueCommand、
 * 全量走 broadcastCommand；worker 侧仅消费 providerKeys，targetWorkerIds 为元数据）。
 */
export interface ModelCredentialsPayload {
  providerKeys: ModelCredentialEntry[];
  /** 定向 worker id 列表；空 = 全量下发 */
  targetWorkerIds?: string[];
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
 * 心跳响应携带的下行命令（T4a，对齐 server WorkerCommand）。
 * 设计为通用 commands 数组（复用点：AgentsModule 配置变更重启也走此通道）。
 */
export interface WorkerCommand {
  type: WorkerCommandType;
  /** 资源版本号：T1/T2 变更时递增，worker 侧据此判断是否需重拉注入 */
  resourceVersion: string;
  /** C5/T6：model-credentials 或 git-credentials 命令携带的凭据负载（仅该两 type 携带；reload-config 等不携带） */
  payload?: ModelCredentialsPayload | GitCredentialsPayload;
}

/** POST /workers/:id/heartbeat 成功响应（对齐 server workers.service.ts heartbeat 返回）。 */
export interface HeartbeatResponse {
  workerId: string;
  status: string;
  lastHeartbeatAt: string;
  /** T4a：待执行下行命令；无命令时不携带 */
  commands?: WorkerCommand[];
}

/** POST /worker/events 请求体（对齐 server WorkerEventDto）。 */
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
