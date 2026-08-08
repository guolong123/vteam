-- AlterTable
ALTER TABLE `agents` ADD COLUMN `worker_id` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `workers` ADD COLUMN `default_model_id` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `models` (
    `id` VARCHAR(191) NOT NULL,
    `provider_id` VARCHAR(191) NOT NULL,
    `model_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `capabilities` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uk_models_provider_model`(`provider_id`, `model_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `worker_model_availabilities` (
    `worker_id` VARCHAR(191) NOT NULL,
    `model_id` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`worker_id`, `model_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `worker_model_availabilities` ADD CONSTRAINT `worker_model_availabilities_worker_id_fkey` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_model_availabilities` ADD CONSTRAINT `worker_model_availabilities_model_id_fkey` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
