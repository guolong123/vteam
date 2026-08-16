/*
  说明：sessions.task_agent_id / task_agents.work_dir 的类型漂移与 sessions FK 是历史迁移遗留
  （role_instance_separation 建列可空、agent_work_dir 建列 VARCHAR(255)），与本迁移无关，
  已从本迁移剔除——本次仅新增 plans/plan_tasks 表 + tasks.execution_mode + agents.persona，
  不做任何现有表结构变更。
*/
-- AlterTable
ALTER TABLE `agents` ADD COLUMN `persona` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `execution_mode` VARCHAR(191) NOT NULL DEFAULT 'direct';

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `summary` TEXT NULL,
    `scopeIn` TEXT NULL,
    `scopeOut` TEXT NULL,
    `status` VARCHAR(191) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `reviewer_instance_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plans_task_id_key`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_tasks` (
    `id` VARCHAR(191) NOT NULL,
    `plan_id` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `content` JSON NOT NULL,
    `assignee_instance_id` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_plan_tasks_plan`(`plan_id`),
    UNIQUE INDEX `uk_plan_tasks_plan_seq`(`plan_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `plans` ADD CONSTRAINT `plans_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `plan_tasks` ADD CONSTRAINT `plan_tasks_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
