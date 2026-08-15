/*
  说明：sessions.task_agent_id / task_agents.work_dir 与 schema 的类型漂移是历史迁移遗留
  （role_instance_separation 建列可空、agent_work_dir 建列 VARCHAR(255)），与本迁移无关，
  已从本迁移剔除——本次仅新增 memories 表 + 反向 relation，不做任何现有表结构变更。
*/
-- CreateTable
CREATE TABLE `memories` (
    `id` VARCHAR(191) NOT NULL,
    `level` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NULL,
    `project_id` VARCHAR(191) NULL,
    `content` TEXT NOT NULL,
    `tags` JSON NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_memories_level`(`level`),
    INDEX `idx_memories_task_time`(`task_id`, `created_at`),
    INDEX `idx_memories_project_time`(`project_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `memories` ADD CONSTRAINT `memories_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `memories` ADD CONSTRAINT `memories_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
