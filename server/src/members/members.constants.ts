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
