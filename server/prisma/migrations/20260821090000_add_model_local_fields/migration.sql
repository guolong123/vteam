ALTER TABLE `models` ADD COLUMN `base_url` TEXT NULL;
ALTER TABLE `models` ADD COLUMN `provider_type` VARCHAR(191) NOT NULL DEFAULT 'cloud';
