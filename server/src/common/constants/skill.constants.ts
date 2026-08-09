/**
 * Skill 域错误码常量（Phase 5 补充，T1 重构对齐 09 篇 §3.8）。
 *
 * 错误码命名沿用现有约定（大写 SNAKE，随异常响应的 code 字段返回，对齐 agent.constants）：
 * - 目标技能不存在 → 404（SKILL_NOT_FOUND，与 AGENT_NOT_FOUND 同风格）
 * - name 唯一冲突（create）→ 409 SKILL_NAME_EXISTS（skills.name 有 @unique 约束）
 * - multipart 未携带 file 字段 → 400 SKILL_FILE_REQUIRED
 * - SKILL.md frontmatter 缺失/非法/name 格式不符 → 400 SKILL_FRONTMATTER_INVALID
 *   （09 §3.8 无 DELETE 端点，SKILL_IN_USE 语义由停用 enabled=false 替代，不再需要）
 */
export const SKILL_ERRORS = {
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  /** name 重复：POST /skills 上传 → 409。 */
  SKILL_NAME_EXISTS: 'SKILL_NAME_EXISTS',
  /** multipart 请求未携带 file 字段：POST /skills → 400。 */
  SKILL_FILE_REQUIRED: 'SKILL_FILE_REQUIRED',
  /** SKILL.md frontmatter 缺失/结束标记缺失/name 缺省或格式非法 → 400。 */
  SKILL_FRONTMATTER_INVALID: 'SKILL_FRONTMATTER_INVALID',
  /** PATCH /skills/:id 请求体未携带任何可更新字段 → 400（UX-15）。 */
  SKILL_UPDATE_EMPTY: 'SKILL_UPDATE_EMPTY',
} as const;

export type SkillErrorCode = (typeof SKILL_ERRORS)[keyof typeof SKILL_ERRORS];
