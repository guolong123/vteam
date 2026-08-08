/**
 * 模型目录域错误码常量（C3 目录 CRUD + C4 凭据；对齐 mcp-server.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标模型不存在（GET/PATCH/DELETE :id 路由先查 model）→ 404 MODEL_NOT_FOUND
 * - providerID+modelID 撞 @@unique（POST/PATCH 目录冲突）→ 409 MODEL_EXISTS
 * - 目标凭据不存在（DELETE 吊销但未配置）→ 404 MODEL_CREDENTIAL_NOT_FOUND
 * - body.providerID 与 model.providerID 不一致（POST 校验一致策略）→ 400 MODEL_PROVIDER_MISMATCH
 */
export const MODEL_ERRORS = {
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_EXISTS: 'MODEL_EXISTS',
  MODEL_CREDENTIAL_NOT_FOUND: 'MODEL_CREDENTIAL_NOT_FOUND',
  MODEL_PROVIDER_MISMATCH: 'MODEL_PROVIDER_MISMATCH',
} as const;

export type ModelErrorCode =
  (typeof MODEL_ERRORS)[keyof typeof MODEL_ERRORS];
