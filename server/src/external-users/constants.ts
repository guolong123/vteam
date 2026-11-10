/**
 * 外部渠道用户目录域常量（external-users）。
 *
 * 主键前缀 `eu`（避开消息 m_/me_、团队 tm_/席位 tmm_、频道 c_、成员 mbr_）。
 * 外部用户的「业务标识」是 external_id（唯一）：`id:<企微 userid>` 优先，
 * 无 userid 时回退 `name:<展示名>`——入站沉淀的幂等键，见 ExternalUsersService。
 */
export const EXTERNAL_USER_ID_PREFIX = 'eu';

/** 入站无 source（渠道类型）时的兜底来源值（与 schema 默认值一致）。 */
export const EXTERNAL_USER_DEFAULT_SOURCE = 'wecom_aibot';

/** 列表默认每页条数（契约 §2.1）。 */
export const EXTERNAL_USERS_DEFAULT_PAGE_SIZE = 50;

/** 消息回看默认每页条数（契约 §2.4）。 */
export const EXTERNAL_USERS_DEFAULT_MESSAGE_LIMIT = 30;

/**
 * 候选外部用户上限（防御）：外部用户量级小，但消息 groupBy 结果会随历史增长；
 * 超过上限的候选按最近发言时间截断，避免一次把全表外部用户读进内存。
 */
export const EXTERNAL_USERS_MAX_CANDIDATES = 1000;

/**
 * 管理字段白名单（PATCH 只允许改这四个；空串 → null 清空）。
 * 之所以不把 displayName/externalId/source 放进来：前者由入站自动维护，
 * 后两者是身份键——人工改名走 name（展示时 name 优先于 displayName）。
 */
export const EXTERNAL_USER_EDITABLE_FIELDS = [
  'name',
  'position',
  'company',
  'contact',
] as const;

export type ExternalUserEditableField =
  (typeof EXTERNAL_USER_EDITABLE_FIELDS)[number];

export const EXTERNAL_USERS_ERRORS = {
  EXTERNAL_USER_NOT_FOUND: 'EXTERNAL_USER_NOT_FOUND',
} as const;
