-- remove-project-dimension Todo 9：拆除项目维度，记忆转团队级
-- 顺序：先加（memories.team_id + 索引，对齐 Todo 5 已合入 schema）→ 数据回填 → 删列/删索引 → 删表
-- 前置核验（2026-09-07，本地 aiagents 库）：memories 无 team_id 列（Todo 5 仅改 schema 未落库），
--   故本迁移含 ADD COLUMN；Memory.id 为 VARCHAR(191)，CONCAT('me_mig_', UUID_SHORT())（7+至多20=27 字符）可容纳。
-- 回填兼容 T7 并行拆除：行可能仅带 project_id、仅带 team_id，或两者皆有（EITHER 值均处理）。
-- 回滚：重建库（docker compose down -v && docker compose up -d --build，
--   或 npx prisma migrate reset + npm run seed；生产先有 mysqldump 备份，见 t9-happy.log 首行）。

-- (1) 先加：memories.team_id + 索引（Todo 5 schema 已声明，本迁移落物理列）
ALTER TABLE `memories` ADD COLUMN `team_id` VARCHAR(191) NULL;
CREATE INDEX `idx_memories_team_time` ON `memories`(`team_id`, `created_at`);

-- (2) 数据回填：project 级记忆按“项目下任务 distinct teamIds”迁移
-- 2a：已带 team_id 的 project 行（T5 兼容写入）→ 原地转 team
UPDATE `memories` SET `level` = 'team' WHERE `level` = 'project' AND `team_id` IS NOT NULL;

-- 2b：单团队项目 → 直转 team（取该项目任务唯一 team_id）
UPDATE `memories` AS `m`
INNER JOIN (
  SELECT `project_id` AS `pid`, MIN(`team_id`) AS `team_id`
  FROM `tasks`
  WHERE `project_id` IS NOT NULL AND `team_id` IS NOT NULL
  GROUP BY `project_id`
  HAVING COUNT(DISTINCT `team_id`) = 1
) AS `s` ON `s`.`pid` = `m`.`project_id`
SET `m`.`level` = 'team', `m`.`team_id` = `s`.`team_id`
WHERE `m`.`level` = 'project' AND `m`.`team_id` IS NULL AND `m`.`project_id` IS NOT NULL;

-- 2c：多团队项目 → 其余团队各复制一行（先插复制行，再把原行转首团队；重复行为经验复用，可接受）
INSERT INTO `memories` (`id`, `level`, `task_id`, `team_id`, `project_id`, `content`, `tags`, `created_by`, `deleted_at`, `created_at`, `updated_at`, `description`, `source_agent_id`, `source_instance_id`, `source_type`, `session_id`, `session_title`, `channel_id`)
SELECT CONCAT('me_mig_', UUID_SHORT()), 'team', `m`.`task_id`, `t`.`team_id`, `m`.`project_id`, `m`.`content`, `m`.`tags`, `m`.`created_by`, `m`.`deleted_at`, `m`.`created_at`, `m`.`updated_at`, `m`.`description`, `m`.`source_agent_id`, `m`.`source_instance_id`, `m`.`source_type`, `m`.`session_id`, `m`.`session_title`, `m`.`channel_id`
FROM `memories` AS `m`
INNER JOIN (
  SELECT DISTINCT `project_id`, `team_id`
  FROM `tasks`
  WHERE `project_id` IS NOT NULL AND `team_id` IS NOT NULL
) AS `t` ON `t`.`project_id` = `m`.`project_id`
INNER JOIN (
  SELECT `project_id` AS `pid`, MIN(`team_id`) AS `first_team`
  FROM `tasks`
  WHERE `project_id` IS NOT NULL AND `team_id` IS NOT NULL
  GROUP BY `project_id`
  HAVING COUNT(DISTINCT `team_id`) > 1
) AS `s` ON `s`.`pid` = `m`.`project_id`
WHERE `m`.`level` = 'project' AND `m`.`team_id` IS NULL AND `m`.`project_id` IS NOT NULL
  AND `t`.`team_id` <> `s`.`first_team`;

UPDATE `memories` AS `m`
INNER JOIN (
  SELECT `project_id` AS `pid`, MIN(`team_id`) AS `team_id`
  FROM `tasks`
  WHERE `project_id` IS NOT NULL AND `team_id` IS NOT NULL
  GROUP BY `project_id`
  HAVING COUNT(DISTINCT `team_id`) > 1
) AS `s` ON `s`.`pid` = `m`.`project_id`
SET `m`.`level` = 'team', `m`.`team_id` = `s`.`team_id`
WHERE `m`.`level` = 'project' AND `m`.`team_id` IS NULL AND `m`.`project_id` IS NOT NULL;

-- 2d：0 团队（项目无任务 / 任务均无 team / project 级孤儿行）→ 降 global
UPDATE `memories` SET `level` = 'global', `team_id` = NULL WHERE `level` = 'project';

-- 2e：task 级记忆 project_id 置空（列随后删除）
UPDATE `memories` SET `project_id` = NULL WHERE `task_id` IS NOT NULL AND `project_id` IS NOT NULL;

-- 2f：残留 project_id 统一置空（已转 team/global 行的冗余值；外键随后删除）
UPDATE `memories` SET `project_id` = NULL WHERE `project_id` IS NOT NULL;

-- (3) 删列 / 删索引
-- tasks：去 project_id，idx_tasks_project_status 重建为 idx_tasks_team_status
ALTER TABLE `tasks` DROP FOREIGN KEY `tasks_project_id_fkey`;
ALTER TABLE `tasks` DROP INDEX `idx_tasks_project_status`;
ALTER TABLE `tasks` DROP COLUMN `project_id`;
CREATE INDEX `idx_tasks_team_status` ON `tasks`(`team_id`, `status`);

-- memories：去 project_id + 索引（保留 Todo 5 的 team_id + idx_memories_team_time）
ALTER TABLE `memories` DROP FOREIGN KEY `memories_project_id_fkey`;
ALTER TABLE `memories` DROP INDEX `idx_memories_project_time`;
ALTER TABLE `memories` DROP COLUMN `project_id`;

-- realtime_events：去 project_id + 索引（transient 通知流，历史事件归属丢失为可接受损失）
ALTER TABLE `realtime_events` DROP INDEX `idx_realtime_events_project_id`;
ALTER TABLE `realtime_events` DROP COLUMN `project_id`;

-- (4) 删表
DROP TABLE `project_members`;
DROP TABLE `projects`;
