-- artifacts 表分类元数据（docs-artifacts-merge todo 1，加法-only）：可空分类列 category。
-- 与 `type` 正交（ARTIFACT_TYPES 三态锁定，不许加第 4 种 type）；未分类用 NULL，
-- 不写 '其他'（'其他' 留给人/Agent 显式选）。存量行全 NULL，读/写语义不变。
-- TEXT 列建索引需前缀长度（MySQL 1170），故复合索引 category 侧取 (191)。
ALTER TABLE `artifacts` ADD COLUMN `category` TEXT NULL;
CREATE INDEX `idx_artifacts_task_category` ON `artifacts`(`task_id`, `category`(191));
