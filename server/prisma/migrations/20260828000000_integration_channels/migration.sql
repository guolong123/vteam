-- CreateTable
CREATE TABLE `integration_channels` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `direction` VARCHAR(8) NOT NULL DEFAULT 'in',
    `task_id` VARCHAR(36) NULL,
    `config` JSON NOT NULL,
    `secrets` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `last_status` VARCHAR(16) NULL,
    `last_error` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    INDEX `integration_channels_taskId_idx`(`task_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integration_channel_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `channel_id` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(8) NOT NULL,
    `external_id` VARCHAR(128) NULL,
    `status` VARCHAR(16) NOT NULL,
    `kind` VARCHAR(32) NULL,
    `error` VARCHAR(512) NULL,
    `payload` JSON NULL,
    `meta` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `integration_channel_deliveries_channelId_externalId_key`(`channel_id`, `external_id`),
    INDEX `integration_channel_deliveries_channelId_createdAt_idx`(`channel_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `integration_channels` ADD CONSTRAINT `integration_channels_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `integration_channel_deliveries` ADD CONSTRAINT `integration_channel_deliveries_channel_id_fkey` FOREIGN KEY (`channel_id`) REFERENCES `integration_channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
