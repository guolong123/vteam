-- CreateTable
CREATE TABLE `teams` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `reuse_session` BOOLEAN NOT NULL DEFAULT true,
    `current_task_id` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `created_by` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    UNIQUE INDEX `teams_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `team_members` (
    `id` VARCHAR(191) NOT NULL,
    `team_id` VARCHAR(191) NOT NULL,
    `agent_id` VARCHAR(191) NOT NULL,
    `alias` VARCHAR(191) NULL,
    `seq` INTEGER NOT NULL DEFAULT 1,
    `work_dir` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `uk_team_members_team_agent_seq`(`team_id`, `agent_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `team_queues` (
    `id` VARCHAR(191) NOT NULL,
    `team_id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `enqueued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `idx_team_queues_team_position`(`team_id`, `position`),
    UNIQUE INDEX `team_queues_task_id_key`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `tasks` ADD COLUMN `team_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `chat_channels` ADD COLUMN `team_id` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `chat_channels_team_id_key` ON `chat_channels`(`team_id`);

-- AlterTable
ALTER TABLE `chat_channels` MODIFY `task_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `team_member_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `messages` ADD COLUMN `task_id` VARCHAR(191) NULL;
CREATE INDEX `idx_messages_task_created` ON `messages`(`task_id`, `created_at`);
CREATE INDEX `idx_messages_channel_task` ON `messages`(`channel_id`, `task_id`);

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `teams` ADD CONSTRAINT `teams_current_task_id_fkey` FOREIGN KEY (`current_task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_agent_id_fkey` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_queues` ADD CONSTRAINT `team_queues_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `team_queues` ADD CONSTRAINT `team_queues_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_team_member_id_fkey` FOREIGN KEY (`team_member_id`) REFERENCES `team_members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
