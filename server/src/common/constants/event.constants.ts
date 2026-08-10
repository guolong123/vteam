/**
 * 事件与消息契约常量（对齐 09 篇 §4.2 事件表、10 篇 消息/频道/会话字段）。
 *
 * 事件名一律使用**点号**命名（chat.message.new / task.status.changed），
 * 禁止下划线变体（task.status_changed）——SSE 帧 type 与 09 篇 §4.2 严格一致。
 */

export const EVENT_TYPES = {
  CHAT_MESSAGE_NEW: 'chat.message.new',
  AGENT_LOADING: 'agent.loading',
  AGENT_ERROR: 'agent.error',
  TASK_STATUS_CHANGED: 'task.status.changed',
  TEAM_CHANGED: 'team.changed',
  ARTIFACT_SUBMITTED: 'artifact.submitted',
  // Phase 4 worker 回流事件（T1 契约基座，与 worker 协议 WORKER_EVENT_TYPES 值对齐，
  // 用于 server 落库后 SSE 广播 /chat.message.new 等既有事件同名语义）。
  SESSION_UPDATED: 'session.updated',
  MESSAGE_PART_DELTA: 'message.part.delta',
  TASK_COMPLETED: 'task.completed',
  AGENT_STATUS: 'agent.status',
  WORKER_HEARTBEAT: 'worker.heartbeat',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const MESSAGE_STATUS = {
  sending: 'sending',
  sent: 'sent',
  pending: 'pending',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
} as const;

export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];

export const CHANNEL_TYPE = {
  task_group: 'task_group',
  private: 'private',
} as const;

export type ChannelType = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

export const SENDER_TYPE = {
  user: 'user',
  agent: 'agent',
  system: 'system',
} as const;

export type SenderType = (typeof SENDER_TYPE)[keyof typeof SENDER_TYPE];

export const SESSION_STATUS = {
  created: 'created',
  active: 'active',
  /** Phase 4 流式：任务执行中（worker 回流 running/idle，任务在跑 / 等待下一条消息）。 */
  running: 'running',
  idle: 'idle',
  frozen: 'frozen',
  archived: 'archived',
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const ACTOR_TYPE = {
  user: 'user',
  system: 'system',
} as const;

export type ActorType = (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];
