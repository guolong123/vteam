/**
 * 消息渠道领域常量（integrations-refactor D2：领域拆分 — inbound-only）。
 */

export const MESSAGE_CHANNEL_TYPES = {
  generic_webhook: 'generic_webhook',
  wecom_aibot: 'wecom_aibot',
  github_webhook: 'github_webhook',
  gitee_webhook: 'gitee_webhook',
} as const;
export type MessageChannelType =
  (typeof MESSAGE_CHANNEL_TYPES)[keyof typeof MESSAGE_CHANNEL_TYPES];

export const MESSAGE_CHANNEL_ID_PREFIX = 'mc_';
export const MESSAGE_DELIVERY_ID_PREFIX = 'md_';
export const MESSAGE_DELIVERY_PREFIX = 'md_';
export const MESSAGE_CHANNEL_PREFIX = 'mc_';

export const MESSAGE_ADAPTERS = Symbol('MESSAGE_ADAPTERS');

// 兼容旧 integrations.constants 的投递/错误常量（供旧 integrations 残留代码在 Todo8 清理前仍可编译）
export const CHANNEL_TYPES = MESSAGE_CHANNEL_TYPES;
export const CHANNEL_DIRECTIONS = {
  in: 'in',
  out: 'out',
  inout: 'inout',
} as const;
export const CHANNEL_ID_PREFIX = MESSAGE_CHANNEL_ID_PREFIX;
export const DELIVERY_ID_PREFIX = MESSAGE_DELIVERY_ID_PREFIX;
export const OUTBOUND_EVENTS = {
  TASK_STATUS_CHANGED: 'task.status_changed',
  AGENT_REPLY: 'agent.reply',
  AGENT_QUESTION: 'agent.question',
} as const;
export const DELIVERY_DIRECTIONS = {
  inbound: 'inbound',
  outbound: 'outbound',
} as const;
export type DeliveryDirection =
  (typeof DELIVERY_DIRECTIONS)[keyof typeof DELIVERY_DIRECTIONS];

export const DELIVERY_STATUS = {
  ok: 'ok',
  failed: 'failed',
  rejected: 'rejected',
  skipped: 'skipped',
} as const;
export type DeliveryStatus =
  (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

export const INTEGRATIONS_ERRORS = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_TYPE_INVALID: 'CHANNEL_TYPE_INVALID',
  TASK_NOT_BOUND: 'TASK_NOT_BOUND',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  CHANNEL_DISABLED: 'CHANNEL_DISABLED',
  DELIVERY_DUPLICATE: 'DELIVERY_DUPLICATE',
} as const;
export type IntegrationsErrorCode =
  (typeof INTEGRATIONS_ERRORS)[keyof typeof INTEGRATIONS_ERRORS];
