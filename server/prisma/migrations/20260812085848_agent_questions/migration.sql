-- CreateTable
CREATE TABLE `agent_questions` (
    `id` VARCHAR(191) NOT NULL,
    `request_id` VARCHAR(191) NOT NULL,
    `session_id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NOT NULL,
    `agent_id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `content` JSON NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `answers` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `agent_questions_request_id_key`(`request_id`),
    INDEX `idx_agent_questions_task_status`(`task_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
