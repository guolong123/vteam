/**
 * 产出物域常量（对齐 12 篇 §3.1 声明协议 + 09 篇 §3.6 错误码）。
 */

/** 产出物类型三态（12 篇 §2.1 / FR-39：text 结论文本 / doc 文档 / file 文件）。 */
export const ARTIFACT_TYPES = ['text', 'doc', 'file'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * 产出物分类词表（docs-artifacts-merge T4，server 唯一源）。
 * 与 `type` 正交的可空元数据：未分类用 NULL（不写 `其他`，`其他` 留给人/Agent 显式选）。
 * web 侧镜像见 `web/src/lib/artifact-categories.ts`（同字面量八类，不许各自演进，
 * 一致性由词表 parity grep 门保证）。
 */
export const ARTIFACT_CATEGORIES = [
  '需求',
  '设计',
  '实现',
  '测试用例',
  '测试报告',
  '运维',
  '计划',
  '其他',
] as const;

export const ARTIFACT_ERRORS = {
  /** 非法声明：type/title/content/fileRef 不满足协议 → 回退普通消息、不产生归档（12 篇 §3.1）。 */
  INVALID_DECLARATION: 'ARTIFACT_INVALID_DECLARATION',
  /** 产出物不存在（09 篇 §3.6 GET /artifacts/:id）。 */
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  /** 版本不存在（09 篇 §3.6 GET /artifacts/:id/versions/:version）。 */
  ARTIFACT_VERSION_NOT_FOUND: 'ARTIFACT_VERSION_NOT_FOUND',
  /** 已验收版本不可覆盖（T7 验收联动；本任务预留不触发，09 篇 §3.6 409）。 */
  ARTIFACT_ACCEPTED_IMMUTABLE: 'ARTIFACT_ACCEPTED_IMMUTABLE',
} as const;
