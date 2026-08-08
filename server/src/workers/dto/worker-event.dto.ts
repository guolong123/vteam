import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsObject, IsString, Min } from 'class-validator';

/**
 * worker 协议事件 type 枚举（T1 契约基座，架构决策 D4）。
 * 值一律点号命名，与 event.constants.ts EVENT_TYPES 中同名事件对齐（如 session.updated）；
 * instance.created 仅存在于 worker 协议层（worker 自身上报实例生命周期）。
 */
export const WORKER_EVENT_TYPES = {
  HEARTBEAT: 'worker.heartbeat',
  INSTANCE_CREATED: 'instance.created',
  SESSION_UPDATED: 'session.updated',
  MESSAGE_PART_DELTA: 'message.part.delta',
  AGENT_STATUS: 'agent.status',
  TASK_COMPLETED: 'task.completed',
  GIT_OP: 'git.op',
} as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[keyof typeof WORKER_EVENT_TYPES];

/**
 * POST /worker/events 请求体（架构决策 D1：事件上送全 push 回调）。
 * eventId 为 worker 侧单调递增标识（格式 evw_<seq>）；seq 与 eventId 同步单调递增，
 * server 侧按 (workerId, eventId) 内存去重（D4，at-least-once 边界）。
 */
export class WorkerEventDto {
  @ApiProperty({ description: 'worker 全局唯一 id（w_ 前缀）' })
  @IsString()
  @IsNotEmpty()
  workerId: string;

  @ApiProperty({ description: 'worker 侧单调递增事件 id（evw_<seq> 格式）' })
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @ApiProperty({ description: '事件类型', enum: Object.values(WORKER_EVENT_TYPES) })
  @IsIn(Object.values(WORKER_EVENT_TYPES))
  type: WorkerEventType;

  @ApiProperty({ description: '事件负载（语义随 type 变化）', type: Object })
  @IsObject()
  payload: Record<string, unknown>;

  @ApiProperty({ description: 'worker 侧单调递增序号（与 eventId 同步）' })
  @IsInt()
  @Min(0)
  seq: number;
}
