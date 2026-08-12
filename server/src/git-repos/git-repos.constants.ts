/**
 * 仓库凭证域常量（17 篇《仓库权限与凭证机制》§3.1/§3.2，B 方案落地）。
 *
 * 域主键前缀（对齐 resyncIdPrefix 模式，仿 MODEL_CREDENTIAL_ID_PREFIX='mc'）：
 * - `gc_<零填充序号>`：GitCredential（git_credentials 表）
 * - `gr_<零填充序号>`：GitRepoGrant（git_repo_grants 表）
 */
export const GIT_CREDENTIAL_ID_PREFIX = 'gc';

export const GIT_REPO_GRANT_ID_PREFIX = 'gr';

/** 认证方式枚举（GitCredential.authType）。 */
export const GIT_AUTH_TYPES = {
  SSH_KEY: 'ssh_key',
  HTTPS_TOKEN: 'https_token',
} as const;

export type GitAuthType = (typeof GIT_AUTH_TYPES)[keyof typeof GIT_AUTH_TYPES];

/** 授权 permission 枚举（GitRepoGrant.permission；write 含 read 能力，git_push 需 write）。 */
export const GIT_PERMISSIONS = {
  READ: 'read',
  WRITE: 'write',
} as const;

export type GitPermission = (typeof GIT_PERMISSIONS)[keyof typeof GIT_PERMISSIONS];

/** 授权 effect 枚举（GitRepoGrant.effect；缺省 read→allow、write→ask）。 */
export const GIT_EFFECTS = {
  ALLOW: 'allow',
  ASK: 'ask',
} as const;

export type GitEffect = (typeof GIT_EFFECTS)[keyof typeof GIT_EFFECTS];

/**
 * 仓库凭证域错误码常量（对齐 models.constants 命名约定：大写 SNAKE，
 * 随异常响应的 code 字段返回）。
 *
 * - 目标仓库凭证不存在（PATCH/DELETE :id 先查未吊销凭证）→ 404 REPO_NOT_FOUND
 * - repoUrl+authType 撞 @@unique 且未吊销（POST 冲突）→ 409 REPO_EXISTS
 * - authType 非法（非 ssh_key/https_token）→ 400 AUTH_TYPE_INVALID
 * - 授权参数非法（agent 不存在 / permission/effect 越界）→ 400 GRANT_INVALID
 */
export const GIT_REPOS_ERRORS = {
  REPO_NOT_FOUND: 'REPO_NOT_FOUND',
  REPO_EXISTS: 'REPO_EXISTS',
  AUTH_TYPE_INVALID: 'AUTH_TYPE_INVALID',
  GRANT_INVALID: 'GRANT_INVALID',
} as const;

export type GitReposErrorCode =
  (typeof GIT_REPOS_ERRORS)[keyof typeof GIT_REPOS_ERRORS];
