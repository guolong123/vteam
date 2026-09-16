/**
 * 产出物分类词表 web 侧镜像（docs-artifacts-merge T4）。
 * 唯一源是 server `server/src/artifacts/artifacts.constants.ts` 的
 * `ARTIFACT_CATEGORIES` —— 此处仅镜像同字面量七类，不许各自演进；
 * 一致性由词表 parity grep 门保证（见 task-4 证据）。
 */
export const ARTIFACT_CATEGORIES = [
  '需求',
  '设计',
  '实现',
  '测试用例',
  '测试报告',
  '运维',
  '其他',
] as const;

export type ArtifactCategory = (typeof ARTIFACT_CATEGORIES)[number];
