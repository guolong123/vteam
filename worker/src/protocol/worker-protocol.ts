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
}

/** 负载快照（对齐 schema Worker.load Json 与 server WorkerLoadDto）。 */
export interface WorkerLoad {
  instances: number;
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
}

/** POST /worker/events 请求体（对齐 server WorkerEventDto）。 */
export interface WorkerEventPayload {
  workerId: string;
  eventId: string;
  type: WorkerEventType;
  payload: Record<string, unknown>;
  seq: number;
}
