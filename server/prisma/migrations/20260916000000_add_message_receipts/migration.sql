-- CreateTable
CREATE TABLE `message_receipts` (
    `id` VARCHAR(191) NOT NULL,
    `message_id` VARCHAR(191) NOT NULL,
    `from_instance_id` VARCHAR(191) NOT NULL,
    `to_instance_id` VARCHAR(191) NOT NULL,
    `task_id` VARCHAR(191) NULL,
    `team_id` VARCHAR(191) NOT NULL,
    `summary` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `dedup_key` VARCHAR(191) NOT NULL,
    `issue_id` VARCHAR(191) NULL,
    `nudge_count` INTEGER NOT NULL DEFAULT 0,
    `last_nudged_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'dispatch',
    `force_reason` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acked_at` DATETIME(3) NULL,

    UNIQUE INDEX `message_receipts_dedup_key_key`(`dedup_key`),
    INDEX `idx_message_receipts_to_status`(`to_instance_id`, `status`),
    INDEX `idx_message_receipts_team_status`(`team_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
