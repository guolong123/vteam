-- Team execution context (expand): sessions 解绑 task + team 维度 + team_user_members + task_group_instances 扩展
-- uk_sessions_task_agent 保持不动；team-mode 幂等键为新增 uk_sessions_team_member(team_id, team_member_id)
-- MySQL 唯一索引对 NULL 不冲突，存量 NULL 行不受新唯一键影响（同 20260813130000_role_instance_separation 说明）

-- AlterTable: sessions - task_id / task_agent_id 改为可空（team-mode 解绑；Restrict 语义由可空 FK 保留）
ALTER TABLE `sessions` MODIFY `task_id` VARCHAR(191) NULL;
ALTER TABLE `sessions` MODIFY `task_agent_id` VARCHAR(191) NULL;

-- AlterTable: sessions - 新增 team_id（nullable 便于存量回填；业务层 team-mode 必填）
ALTER TABLE `sessions` ADD COLUMN `team_id` VARCHAR(191) NULL;
CREATE INDEX `idx_sessions_team_id` ON `sessions`(`team_id`);
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
-- team-mode 幂等键 uk_sessions_team_member：仅 task_id 为空的行参与唯一约束（task 绑定行沿用 uk_sessions_task_agent）。
-- MySQL 无部分唯一索引，以 STORED 生成列承载 (team_id, team_member_id) 对（NULL 行不参与冲突判定；同 20260901000004 team_group_key 手法）。
-- 注：存量为一成员多任务多会话（task 复用模型），裸 UNIQUE(team_id, team_member_id) 会在回填时报 1062，故必须加 task_id IS NULL 作用域。
ALTER TABLE `sessions` ADD COLUMN `team_member_key` VARCHAR(384) GENERATED ALWAYS AS (CASE WHEN `task_id` IS NULL THEN CONCAT(`team_id`, '|', `team_member_id`) ELSE NULL END) STORED;
CREATE UNIQUE INDEX `uk_sessions_team_member` ON `sessions`(`team_member_key`);

-- AlterTable: task_group_instances - task_id 改为可空 + 新增 team 维度（team-mode 复用幂等行经新维度，task-mode 不变）
ALTER TABLE `task_group_instances` MODIFY `task_id` VARCHAR(191) NULL;
ALTER TABLE `task_group_instances` ADD COLUMN `team_id` VARCHAR(191) NULL;
ALTER TABLE `task_group_instances` ADD COLUMN `team_member_id` VARCHAR(191) NULL;
ALTER TABLE `task_group_instances` ADD CONSTRAINT `task_group_instances_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `task_group_instances` ADD CONSTRAINT `task_group_instances_team_member_id_fkey` FOREIGN KEY (`team_member_id`) REFERENCES `team_members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable: team_user_members - 团队用户成员（创建团队时写入 owner 行）
CREATE TABLE `team_user_members` (
    `id` VARCHAR(191) NOT NULL,
    `team_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `uk_team_user_members_team_user`(`team_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `team_user_members` ADD CONSTRAINT `team_user_members_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `team_user_members` ADD CONSTRAINT `team_user_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Backfill: sessions.team_id 经 teamMember 维度回填
UPDATE `sessions` AS `s`
INNER JOIN `team_members` AS `tm` ON `s`.`team_member_id` = `tm`.`id`
SET `s`.`team_id` = `tm`.`team_id`
WHERE `s`.`team_member_id` IS NOT NULL AND `s`.`team_id` IS NULL;

-- Backfill: sessions.team_id 经 taskAgent -> task -> team 回填（仅 task 侧 team_id 非空行；无归属历史行保持原绑定不动）
UPDATE `sessions` AS `s`
INNER JOIN `task_agents` AS `ta` ON `s`.`task_agent_id` = `ta`.`id`
INNER JOIN `tasks` AS `t` ON `ta`.`task_id` = `t`.`id`
SET `s`.`team_id` = `t`.`team_id`
WHERE `s`.`team_id` IS NULL AND `s`.`task_agent_id` IS NOT NULL AND `t`.`team_id` IS NOT NULL;
