-- P3 skill 版本（T0 先行 migration，.omo/plans/learning-mode-private-knowledge.md §3-P3/§4-T0）：
--   1. `skills` 加 `current_version`（INT NOT NULL DEFAULT 1，存量行默认 v1）；
--   2. 新建 `skill_versions` 历史表（append-only，skill 删除级联清历史，唯一键 (skill_id, version)）；
--   3. 存量回填不在本 SQL 内：由一次性脚本 server/prisma/backfill-skill-versions.ts 完成
--     （取 live content/file_meta 记 v1，幂等 WHERE NOT EXISTS；回填脚本与本迁移同批次执行，顺序见 T0）。
--
-- 本文件 DDL 由 `prisma migrate diff` 生成（shadow DB），仅剔除 3 组与本次无关的存量漂移
-- （memories DROP INDEX ×2、agents.agent_key 改型、RENAME INDEX ×3，均保持现状不动，
--  以保持本次迁移作用域为 skill 版本；生成原文见 /tmp/skills_diff_raw.sql）。
-- AlterTable
ALTER TABLE `skills` ADD COLUMN `current_version` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `skill_versions` (
    `id` VARCHAR(191) NOT NULL,
    `skill_id` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `content` TEXT NOT NULL,
    `file_meta` JSON NULL,
    `created_by` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_skill_versions_skill`(`skill_id`),
    UNIQUE INDEX `uk_skill_versions_skill_version`(`skill_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `skill_versions` ADD CONSTRAINT `skill_versions_skill_id_fkey` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
