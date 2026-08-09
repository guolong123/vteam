-- AlterTable
ALTER TABLE `chat_channels` ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `last_read_at` DATETIME(3) NULL,
    ADD COLUMN `pinned` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `messages` ADD COLUMN `attachment_name` VARCHAR(191) NULL,
    ADD COLUMN `attachment_type` VARCHAR(191) NULL,
    ADD COLUMN `attachment_url` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `reset_token` VARCHAR(191) NULL,
    ADD COLUMN `reset_token_expires` DATETIME(3) NULL;
