-- DropForeignKey
ALTER TABLE `integration_channel_deliveries` DROP FOREIGN KEY `integration_channel_deliveries_channel_id_fkey`;

-- DropForeignKey
ALTER TABLE `integration_channels` DROP FOREIGN KEY `integration_channels_task_id_fkey`;

-- DropTable
DROP TABLE `integration_channels`;

-- DropTable
DROP TABLE `integration_channel_deliveries`;

-- CreateTable
CREATE TABLE `message_channels` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `config` JSON NOT NULL,
    `secrets` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `last_status` VARCHAR(16) NULL,
    `last_error` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_channels` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `config` JSON NOT NULL,
    `secrets` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `last_status` VARCHAR(16) NULL,
    `last_error` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `channel_id` VARCHAR(191) NOT NULL,
    `external_id` VARCHAR(128) NULL,
    `direction` VARCHAR(8) NOT NULL DEFAULT 'inbound',
    `status` VARCHAR(16) NOT NULL,
    `kind` VARCHAR(32) NULL,
    `error` VARCHAR(512) NULL,
    `payload` JSON NULL,
    `meta` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `message_deliveries_channel_id_created_at_idx`(`channel_id`, `created_at`),
    UNIQUE INDEX `message_deliveries_channel_id_external_id_key`(`channel_id`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_deliveries` (
    `id` VARCHAR(191) NOT NULL,
    `channel_id` VARCHAR(191) NOT NULL,
    `external_id` VARCHAR(128) NULL,
    `direction` VARCHAR(8) NOT NULL DEFAULT 'outbound',
    `status` VARCHAR(16) NOT NULL,
    `kind` VARCHAR(32) NULL,
    `error` VARCHAR(512) NULL,
    `payload` JSON NULL,
    `meta` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `notification_deliveries_channel_id_created_at_idx`(`channel_id`, `created_at`),
    UNIQUE INDEX `notification_deliveries_channel_id_external_id_key`(`channel_id`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_message_channels` (
    `task_id` VARCHAR(191) NOT NULL,
    `message_channel_id` VARCHAR(191) NOT NULL,
    INDEX `task_message_channels_task_id_idx`(`task_id`),
    UNIQUE INDEX `task_message_channels_task_id_message_channel_id_key`(`task_id`, `message_channel_id`),
    PRIMARY KEY (`task_id`, `message_channel_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_notification_channels` (
    `task_id` VARCHAR(191) NOT NULL,
    `notification_channel_id` VARCHAR(191) NOT NULL,
    INDEX `task_notification_channels_task_id_idx`(`task_id`),
    UNIQUE INDEX `task_notification_channels_task_id_notification_channel_id_key`(`task_id`, `notification_channel_id`),
    PRIMARY KEY (`task_id`, `notification_channel_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `message_deliveries` ADD CONSTRAINT `message_deliveries_channel_id_fkey` FOREIGN KEY (`channel_id`) REFERENCES `message_channels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `notification_deliveries_channel_id_fkey` FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_message_channels` ADD CONSTRAINT `task_message_channels_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_message_channels` ADD CONSTRAINT `task_message_channels_message_channel_id_fkey` FOREIGN KEY (`message_channel_id`) REFERENCES `message_channels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_notification_channels` ADD CONSTRAINT `task_notification_channels_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_notification_channels` ADD CONSTRAINT `task_notification_channels_notification_channel_id_fkey` FOREIGN KEY (`notification_channel_id`) REFERENCES `notification_channels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
