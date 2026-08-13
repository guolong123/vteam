-- AlterTable 任务：角色/实例分离（T1 Schema 迁移）
-- 说明：task_agent_id / sender_instance_id / assignee_instance_id 等新列对存量数据
--       不加回填（用户已确认不兼容）；sessions/chat_channels 存量行 task_agent_id 为 NULL，
--       MySQL 唯一索引对 NULL 不冲突，uk_sessions_task_agent / uk_channels_task_agent 语义与现状一致。
--
-- 注意：sessions/chat_channels 的 task_id 首列同时支撑 task_id 外键，agent_id 外键绑定原复合索引
--       （ERROR 1553）。正确顺序：先建独立 task_id / agent_id 索引 → DROP FOREIGN KEY →
--       换 UNIQUE 索引 → 重建外键。

-- AlterTable `task_agents`：加 alias + seq（同 agent 同任务内序号）
ALTER TABLE `task_agents` ADD COLUMN `alias` VARCHAR(191) NULL;
ALTER TABLE `task_agents` ADD COLUMN `seq` INTEGER NOT NULL DEFAULT 1;

-- 唯一约束 [taskId, agentId] → [taskId, agentId, seq]
ALTER TABLE `task_agents` DROP INDEX `uk_task_agents_task_agent`;
ALTER TABLE `task_agents` ADD UNIQUE INDEX `uk_task_agents_task_agent_seq`(`task_id`, `agent_id`, `seq`);

-- AlterTable `sessions`：绑实例（必填语义，迁移期可空先加列）
ALTER TABLE `sessions` ADD COLUMN `task_agent_id` VARCHAR(191) NULL;

-- 唯一约束 [taskId, agentId] → [taskId, taskAgentId]
ALTER TABLE `sessions` ADD INDEX `idx_sessions_task_id`(`task_id`);
ALTER TABLE `sessions` ADD INDEX `idx_sessions_agent_id`(`agent_id`);
ALTER TABLE `sessions` DROP FOREIGN KEY `sessions_agent_id_fkey`;
ALTER TABLE `sessions` DROP INDEX `uk_sessions_task_agent`;
ALTER TABLE `sessions` ADD UNIQUE INDEX `uk_sessions_task_agent`(`task_id`, `task_agent_id`);
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_agent_id_fkey` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable `chat_channels`：私聊频道按实例；task_group 频道 agent_id/task_agent_id 均为 NULL
ALTER TABLE `chat_channels` ADD COLUMN `task_agent_id` VARCHAR(191) NULL;

-- 唯一约束 [taskId, agentId] → [taskId, taskAgentId]
ALTER TABLE `chat_channels` ADD INDEX `idx_channels_task_id`(`task_id`);
ALTER TABLE `chat_channels` ADD INDEX `idx_channels_agent_id`(`agent_id`);
ALTER TABLE `chat_channels` DROP FOREIGN KEY `chat_channels_agent_id_fkey`;
ALTER TABLE `chat_channels` DROP INDEX `uk_channels_task_agent`;
ALTER TABLE `chat_channels` ADD UNIQUE INDEX `uk_channels_task_agent`(`task_id`, `task_agent_id`);
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_agent_id_fkey` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable `messages`：消息精确归属实例
ALTER TABLE `messages` ADD COLUMN `sender_instance_id` VARCHAR(191) NULL;

-- AlterTable `tasks`：主 Agent 实例（决策依据）
ALTER TABLE `tasks` ADD COLUMN `main_agent_instance_id` VARCHAR(191) NULL;

-- AlterTable `issues`：指派到具体实例
ALTER TABLE `issues` ADD COLUMN `assignee_instance_id` VARCHAR(191) NULL;
