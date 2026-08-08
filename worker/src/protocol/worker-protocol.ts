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
   * serve 实际监听端口（F2 C2：随机端口场景必须上报，否则 server 回退连死端口 4199）。
   * 对齐 server worker.client.ts resolveBaseUrl：capabilities.port → http://localhost:{port}。
   */
  port?: number;
  /**
   * serve 对 server 公布的基址（D2：`${WORKER_ADVERTISE_HOST}:${port}`，容器内 http://worker:port）。
   * 对齐 server worker.client.ts resolveBaseUrl：capabilities.baseUrl 优先于 port。
   */
  baseUrl?: string;
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
} as const;

export type WorkerCommandType =
  (typeof WORKER_COMMAND_TYPES)[keyof typeof WORKER_COMMAND_TYPES];

/**
 * 心跳响应携带的下行命令（T4a，对齐 server WorkerCommand）。
 * 设计为通用 commands 数组（复用点：AgentsModule 配置变更重启也走此通道）。
 */
export interface WorkerCommand {
  type: WorkerCommandType;
  /** 资源版本号：T1/T2 变更时递增，worker 侧据此判断是否需重拉注入 */
  resourceVersion: string;
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
