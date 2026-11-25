-- 多工作空间（租户）改造 · expand 阶段。
-- 由 prisma migrate diff 差量脚本生成后人工重排：先建表 → 加可空列 → 回填 → 收紧 NOT NULL → 索引 → 外键。
-- 本仓无 down-migration 约定；回滚按「重建库」口径（生产先 mysqldump）。

-- ============ 1) 新建工作空间表 ============

-- CreateTable
CREATE TABLE `workspaces` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `owner_user_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workspaces_slug_key`(`slug`),
    INDEX `idx_workspaces_owner`(`owner_user_id`),
    INDEX `idx_workspaces_is_system`(`is_system`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_members` (
    `workspace_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'member',
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_workspace_members_user`(`user_id`),
    PRIMARY KEY (`workspace_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ============ 1.5) 基础空间：系统空间（平台内置资源，全员隐式可读）+ 默认空间（存量数据） ============

INSERT INTO `workspaces` (`id`, `name`, `slug`, `is_system`, `status`, `owner_user_id`, `created_at`, `updated_at`)
VALUES
  ('ws_system', '平台空间', 'system', TRUE, 'active', NULL, NOW(3), NOW(3)),
  ('ws_default', '默认空间', 'default', FALSE, 'active',
   (SELECT `id` FROM `users` WHERE `username` = 'admin' LIMIT 1), NOW(3), NOW(3));

-- ============ 2) 拆除旧的全局唯一索引（随后在回填后重建为含 workspace_id 的复合索引） ============

-- DropForeignKey
ALTER TABLE `member_notification_channels` DROP FOREIGN KEY `member_notification_channels_notification_channel_id_fkey`;

-- DropIndex
DROP INDEX `uk_agent_roles_key` ON `agent_roles`;

-- DropIndex
DROP INDEX `uk_agents_agent_key` ON `agents`;

-- DropIndex
DROP INDEX `external_users_external_id_key` ON `external_users`;

-- DropIndex
DROP INDEX `git_credentials_name_key` ON `git_credentials`;

-- DropIndex
DROP INDEX `uk_git_repo_grants_agent_repo` ON `git_repo_grants`;

-- DropIndex
DROP INDEX `git_repos_repo_url_key` ON `git_repos`;

-- DropIndex
DROP INDEX `mcp_servers_name_key` ON `mcp_servers`;

-- DropIndex
DROP INDEX `uk_member_notif_channel` ON `member_notification_channels`;

-- DropIndex
DROP INDEX `members_name_key` ON `members`;

-- DropIndex
DROP INDEX `uk_model_credentials_provider` ON `model_credentials`;

-- DropIndex
DROP INDEX `uk_models_provider_model` ON `models`;

-- DropIndex
DROP INDEX `skills_name_key` ON `skills`;

-- DropIndex
DROP INDEX `teams_name_key` ON `teams`;

-- DropIndex
DROP INDEX `tools_action_key` ON `tools`;

-- ============ 3) 各资源表加 workspace_id（NOT NULL DEFAULT ws_default，随后回填平台资源到 ws_system） ============

-- AlterTable
-- ⚠️ 不再 MODIFY `default_opencode_agent_name`：该列已被后序迁移
-- `20261121220000_drop_external_agent_columns` 删除（外部 agent 功能下线）。
-- 本迁移时间戳（11-12）早于那次删列（11-21），但文件是后写的 —— 保留该 MODIFY 会让
-- `migrate deploy` 在任何已应用删列迁移的库上以 1054 Unknown column 失败
-- （2026-11-25 生产 v1.7.0 升级即因此回滚）。只增列即可。
ALTER TABLE `agent_roles` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `agents` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default',
    MODIFY `agent_key` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `artifacts` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default',
    MODIFY `category` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `chat_channels` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `execution_policies` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `external_users` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `git_credentials` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `git_repo_grants` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `git_repos` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `hooks` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default',
    ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `issues` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `mcp_servers` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `member_notification_channels` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `members` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `message_channels` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `message_receipts` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `messages` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `model_credentials` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `model_usages` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `models` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `notification_channels` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `provider_tombstones` DROP PRIMARY KEY,
    ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `realtime_events` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `skills` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `task_group_instances` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `teams` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `tools` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `triggers` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default',
    ALTER COLUMN `updated_at` DROP DEFAULT;

-- AlterTable
ALTER TABLE `workers` ADD COLUMN `workspace_id` VARCHAR(191) NOT NULL DEFAULT 'ws_default';

-- AlterTable
ALTER TABLE `users` ADD COLUMN `last_workspace_id` VARCHAR(191) NULL;

-- ============ 4) 回填：系统空间承载平台资源，其余归默认空间 ============

-- 3) 存量用户挂到默认空间；last_workspace_id 指向默认空间
UPDATE `users` SET `last_workspace_id` = 'ws_default';
INSERT INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `joined_at`)
SELECT 'ws_default', `id`, IF(`username` = 'admin', 'owner', 'member'), NOW(3) FROM `users`;

UPDATE `agent_roles` SET `workspace_id` = 'ws_system';

UPDATE `agents` SET `workspace_id` = IF(`type` = 'template', 'ws_system', 'ws_default');

UPDATE `artifacts` SET `workspace_id` = 'ws_default';

UPDATE `chat_channels` SET `workspace_id` = 'ws_default';

UPDATE `execution_policies` SET `workspace_id` = 'ws_system';

UPDATE `external_users` SET `workspace_id` = 'ws_default';

UPDATE `git_credentials` SET `workspace_id` = 'ws_default';

UPDATE `git_repo_grants` SET `workspace_id` = 'ws_default';

UPDATE `git_repos` SET `workspace_id` = 'ws_default';

UPDATE `hooks` SET `workspace_id` = 'ws_default';

UPDATE `issues` SET `workspace_id` = 'ws_default';

UPDATE `mcp_servers` SET `workspace_id` = IF(`name` IN ('vteam','vteam-api'), 'ws_system', 'ws_default');

UPDATE `member_notification_channels` SET `workspace_id` = 'ws_default';

UPDATE `members` SET `workspace_id` = 'ws_default';

UPDATE `message_channels` SET `workspace_id` = 'ws_default';

UPDATE `message_receipts` SET `workspace_id` = 'ws_default';

UPDATE `messages` SET `workspace_id` = 'ws_default';

UPDATE `model_credentials` SET `workspace_id` = 'ws_default';

UPDATE `model_usages` SET `workspace_id` = 'ws_default';

UPDATE `models` SET `workspace_id` = 'ws_default';

UPDATE `notification_channels` SET `workspace_id` = 'ws_default';

UPDATE `plans` SET `workspace_id` = 'ws_default';

UPDATE `provider_tombstones` SET `workspace_id` = 'ws_default';

UPDATE `realtime_events` SET `workspace_id` = 'ws_default';

UPDATE `sessions` SET `workspace_id` = 'ws_default';

UPDATE `skills` SET `workspace_id` = 'ws_system';

UPDATE `task_group_instances` SET `workspace_id` = 'ws_default';

UPDATE `tasks` SET `workspace_id` = 'ws_default';

UPDATE `teams` SET `workspace_id` = 'ws_default';

UPDATE `tools` SET `workspace_id` = 'ws_system';

UPDATE `triggers` SET `workspace_id` = 'ws_default';

UPDATE `workers` SET `workspace_id` = 'ws_default';

-- ============ 5) 重建 provider_tombstones 复合主键 ============

ALTER TABLE `provider_tombstones` ADD PRIMARY KEY (`workspace_id`, `provider_id`);

-- ============ 6) 复合唯一索引 + workspace_id 索引 ============

-- CreateIndex
CREATE INDEX `idx_agent_roles_workspace` ON `agent_roles`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_agent_roles_workspace_key` ON `agent_roles`(`workspace_id`, `key`);

-- CreateIndex
CREATE INDEX `idx_agents_workspace` ON `agents`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_agents_workspace_key` ON `agents`(`workspace_id`, `agent_key`);

-- CreateIndex
CREATE INDEX `idx_artifacts_workspace` ON `artifacts`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_chat_channels_workspace` ON `chat_channels`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_execution_policies_workspace` ON `execution_policies`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_external_users_workspace` ON `external_users`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_external_users_workspace_external` ON `external_users`(`workspace_id`, `external_id`);

-- CreateIndex
CREATE INDEX `idx_git_credentials_workspace` ON `git_credentials`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_git_credentials_workspace_name` ON `git_credentials`(`workspace_id`, `name`);

-- CreateIndex
CREATE INDEX `idx_git_repo_grants_workspace` ON `git_repo_grants`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_git_repo_grants_workspace_agent_repo` ON `git_repo_grants`(`workspace_id`, `agent_id`, `repo_id`);

-- CreateIndex
CREATE INDEX `idx_git_repos_workspace` ON `git_repos`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_git_repos_workspace_repo_url` ON `git_repos`(`workspace_id`, `repo_url`);

-- CreateIndex
CREATE INDEX `idx_hooks_workspace` ON `hooks`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_issues_workspace` ON `issues`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_mcp_servers_workspace` ON `mcp_servers`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_mcp_servers_workspace_name` ON `mcp_servers`(`workspace_id`, `name`);

-- CreateIndex
CREATE INDEX `idx_member_notification_channels_workspace` ON `member_notification_channels`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_member_notif_workspace_channel` ON `member_notification_channels`(`workspace_id`, `notification_channel_id`);

-- CreateIndex
CREATE INDEX `idx_members_workspace` ON `members`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_members_workspace_name` ON `members`(`workspace_id`, `name`);

-- CreateIndex
CREATE INDEX `idx_message_channels_workspace` ON `message_channels`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_message_receipts_workspace` ON `message_receipts`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_messages_workspace` ON `messages`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_model_credentials_workspace` ON `model_credentials`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_model_credentials_workspace_provider` ON `model_credentials`(`workspace_id`, `provider_id`);

-- CreateIndex
CREATE INDEX `idx_model_usages_workspace` ON `model_usages`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_models_workspace` ON `models`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_models_workspace_provider_model` ON `models`(`workspace_id`, `provider_id`, `model_id`);

-- CreateIndex
CREATE INDEX `idx_notification_channels_workspace` ON `notification_channels`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_plans_workspace` ON `plans`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_provider_tombstones_workspace` ON `provider_tombstones`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_realtime_events_workspace` ON `realtime_events`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_sessions_workspace` ON `sessions`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_skills_workspace` ON `skills`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_skills_workspace_name` ON `skills`(`workspace_id`, `name`);

-- CreateIndex
CREATE INDEX `idx_task_group_instances_workspace` ON `task_group_instances`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_tasks_workspace` ON `tasks`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_teams_workspace` ON `teams`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_teams_workspace_name` ON `teams`(`workspace_id`, `name`);

-- CreateIndex
CREATE INDEX `idx_tools_workspace` ON `tools`(`workspace_id`);

-- CreateIndex
CREATE UNIQUE INDEX `uk_tools_workspace_action` ON `tools`(`workspace_id`, `action`);

-- CreateIndex
CREATE INDEX `idx_triggers_workspace` ON `triggers`(`workspace_id`);

-- CreateIndex
CREATE INDEX `idx_workers_workspace` ON `workers`(`workspace_id`);

-- ============ 7) 外键 ============

-- AddForeignKey
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agent_roles` ADD CONSTRAINT `agent_roles_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `members` ADD CONSTRAINT `members_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `member_notification_channels` ADD CONSTRAINT `member_notification_channels_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `external_users` ADD CONSTRAINT `external_users_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `message_receipts` ADD CONSTRAINT `message_receipts_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `triggers` ADD CONSTRAINT `triggers_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `hooks` ADD CONSTRAINT `hooks_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `artifacts` ADD CONSTRAINT `artifacts_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `issues` ADD CONSTRAINT `issues_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `agents` ADD CONSTRAINT `agents_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `execution_policies` ADD CONSTRAINT `execution_policies_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `skills` ADD CONSTRAINT `skills_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tools` ADD CONSTRAINT `tools_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `models` ADD CONSTRAINT `models_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `model_credentials` ADD CONSTRAINT `model_credentials_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `provider_tombstones` ADD CONSTRAINT `provider_tombstones_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `git_credentials` ADD CONSTRAINT `git_credentials_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `git_repos` ADD CONSTRAINT `git_repos_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `git_repo_grants` ADD CONSTRAINT `git_repo_grants_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `mcp_servers` ADD CONSTRAINT `mcp_servers_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `workers` ADD CONSTRAINT `workers_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `task_group_instances` ADD CONSTRAINT `task_group_instances_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `realtime_events` ADD CONSTRAINT `realtime_events_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `plans` ADD CONSTRAINT `plans_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `message_channels` ADD CONSTRAINT `message_channels_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_channels` ADD CONSTRAINT `notification_channels_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `model_usages` ADD CONSTRAINT `model_usages_workspace_id_fkey` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============ 8) 补回外键（索引重建/历史漂移） ============

ALTER TABLE `member_notification_channels` ADD CONSTRAINT `member_notification_channels_notification_channel_id_fkey` FOREIGN KEY (`notification_channel_id`) REFERENCES `notification_channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `sessions` ADD CONSTRAINT `sessions_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
