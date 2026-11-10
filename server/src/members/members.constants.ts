/**
 * 成员库域常量（vteam-member-decouple P0）。
 *
 * 主键前缀 mbr（避开消息 m_/me_、回执 mr_、团队 tm_/席位 tmm_）。
 * 状态用字符串列 + 应用层常量（双库兼容，不声明 Prisma enum）。
 */
export const MEMBER_ID_PREFIX = 'mbr';

export const MEMBER_STATUS = {
  active: 'active',
  disabled: 'disabled',
} as const;

export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

/**
 * 成员提示词与 Agent 提示词的关系（members.prompt_mode）。
 *
 * - `append`：在 Agent 岗位职责提示词之上追加【成员专属要求】（默认）；
 * - `override`：用成员专属提示词覆盖 Agent 的提示词段。
 *
 * 同 persona/status：字符串列 + 应用层常量（双库兼容，不声明 Prisma enum）。
 */
export const MEMBER_PROMPT_MODE = {
  append: 'append',
  override: 'override',
} as const;

export type MemberPromptMode =
  (typeof MEMBER_PROMPT_MODE)[keyof typeof MEMBER_PROMPT_MODE];

export const MEMBERS_ERRORS = {
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  MEMBER_NAME_CONFLICT: 'MEMBER_NAME_CONFLICT',
  MEMBER_IN_USE: 'MEMBER_IN_USE',
  MEMBER_ROLE_NOT_FOUND: 'MEMBER_ROLE_NOT_FOUND',
  MEMBER_AGENT_REQUIRED: 'MEMBER_AGENT_REQUIRED',
  MEMBER_AGENT_NOT_FOUND: 'MEMBER_AGENT_NOT_FOUND',
  MEMBER_MODEL_NOT_FOUND: 'MEMBER_MODEL_NOT_FOUND',
  MEMBER_WORKER_NOT_FOUND: 'MEMBER_WORKER_NOT_FOUND',
} as const;

/** P5 通知渠道绑定错误码。 */
export const NOTIFICATION_CHANNEL_ERRORS = {
  CHANNEL_NOT_FOUND: 'NOTIFICATION_CHANNEL_NOT_FOUND',
  CHANNEL_ALREADY_BOUND: 'CHANNEL_ALREADY_BOUND',
} as const;
