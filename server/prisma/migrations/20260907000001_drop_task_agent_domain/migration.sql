-- session-unification Todo 6：删 TaskAgent 域（表 + 存量 task 会话行），托管模式迁团队
-- 前置门：Todo 8 绿 + LANE-A（Todo 1/2/3/5/7/10）绿；备份见 su6-happy.log 首行（mysqldump，执行前已落盘）。
-- 顺序钉死（FK 安全 + 只删不回填）：
--   (0) FK 名实证 → (1) 删 task 会话行 → (2) chat_channels.task_agent_id 置空 → (3) 删 task 级记忆 →
--   (4) teams 加 managed_mode + 从 tasks 回填 → (5) tasks 删 managed_mode 列 →
--   (6) tasks.main_agent_instance_id 置空（Todo 2 遗留置空，纯字符串列无 FK）→ (7) DROP TABLE task_agents
--
-- (0) FK 名实证（2026-09-07，本地 aiagents 库，SHOW CREATE TABLE + information_schema）：
--   - 全库零 FK 引用 task_agents 表（information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME='task_agents' 零行）；
--   - sessions.task_agent_id / chat_channels.task_agent_id 均为纯字符串列，无物理 FK（SHOW CREATE TABLE 仅含
--     sessions_agent_id/task_id/team_id/team_member_id/worker_id 与 chat_channels_agent_id/task_id/team_id/team_member_id）；
--   - 故 DROP TABLE 前无需 ALTER DROP FOREIGN KEY；task_agents 自身 FK（task_agents_task_id_fkey、
--     task_agents_agent_id_fkey）随表删除而消失。
--   - uk_sessions_task_agent (task_id, task_agent_id) 物理保留（schema 冻结注释），本迁移不动。
--
-- 数据面实证（同库）：task 会话行 15（删）、task_agent_id 非空 channel 0（置空 no-op 保留语句）、
--   level='task' 记忆 0（删 no-op 保留语句）、task_agents 15 行（随表消失）、managed tasks 1（回填源）、
--   main_agent_instance_id 非空 tasks 2（置空）。
--
-- 回滚：重建库（scratch 库 down -v/up --build 演练见 su6-failure.log；共享 dev 库不动；
--   生产先有本迁移前 mysqldump 备份）。

-- (1) 删存量 task 会话行（只删不回填；团队会话 task_id IS NULL 不受影响）
DELETE FROM `sessions` WHERE `task_id` IS NOT NULL;

-- (2) 私聊频道实例绑定置空（存量兼容列保留，无 FK；当前零非空行，语句保留作防御）
UPDATE `chat_channels` SET `task_agent_id` = NULL WHERE `task_agent_id` IS NOT NULL;

-- (3) 删任务级记忆（Q3：仅保留 team/global；当前零 task 行，语句保留作防御）
DELETE FROM `memories` WHERE `level` = 'task';

-- (4) teams 加 managed_mode（默认 false）并从 tasks 回填（任一任务曾托管 → 团队托管，超集安全语义）
ALTER TABLE `teams` ADD COLUMN `managed_mode` BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE `teams` AS `t`
INNER JOIN (
  SELECT DISTINCT `team_id` FROM `tasks` WHERE `managed_mode` = 1 AND `team_id` IS NOT NULL
) AS `s` ON `s`.`team_id` = `t`.`id`
SET `t`.`managed_mode` = 1;

-- (5) tasks 删 managed_mode 列（纯布尔列，无 FK/索引）
ALTER TABLE `tasks` DROP COLUMN `managed_mode`;

-- (6) tasks.main_agent_instance_id 置空（Todo 2 停止写入遗留；纯字符串列，列保留，mainAgentId FK 保留不动）
UPDATE `tasks` SET `main_agent_instance_id` = NULL WHERE `main_agent_instance_id` IS NOT NULL;

-- (7) 删表（悬空 FK 为零已实证，直接 DROP）
DROP TABLE `task_agents`;
