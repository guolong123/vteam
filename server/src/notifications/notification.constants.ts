/**
 * 通知渠道领域常量（integrations-refactor D2：领域拆分 — outbound-only）。
 */

export const NOTIFICATION_TYPES = {
  webhook: 'webhook',
  wecom_group_robot: 'wecom_group_robot',
} as const;
export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_CHANNEL_TYPES = NOTIFICATION_TYPES;

export const NOTIFICATION_ID_PREFIX = 'nc_';
export const NOTIFICATION_CHANNEL_ID_PREFIX = 'nc_';
export const NOTIFICATION_DELIVERY_ID_PREFIX = 'nd_';
export const NOTIFICATION_DELIVERY_PREFIX = 'nd_';
export const NOTIFICATION_CHANNEL_PREFIX = 'nc_';

export const NOTIFICATION_ADAPTERS = Symbol('NOTIFICATION_ADAPTERS');

export const NOTIFICATION_EVENTS = {
  TASK_STATUS_CHANGED: 'task.status_changed',
  AGENT_REPLY: 'agent.reply',
  AGENT_QUESTION: 'agent.question',
} as const;
export type NotificationEvent =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

// Alias for old OUTBOUND_EVENTS name
export const OUTBOUND_EVENTS = NOTIFICATION_EVENTS;
export type OutboundEvent = NotificationEvent;

export const DELIVERY_DIRECTIONS = {
  outbound: 'outbound',
} as const;

export const DELIVERY_STATUS = {
  ok: 'ok',
  failed: 'failed',
  rejected: 'rejected',
  skipped: 'skipped',
} as const;

export const INTEGRATIONS_ERRORS = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_TYPE_INVALID: 'CHANNEL_TYPE_INVALID',
  TASK_NOT_BOUND: 'TASK_NOT_BOUND',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  CHANNEL_DISABLED: 'CHANNEL_DISABLED',
  DELIVERY_DUPLICATE: 'DELIVERY_DUPLICATE',
} as const;
