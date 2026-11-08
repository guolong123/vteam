ALTER TABLE `teams` ADD COLUMN `default_model_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
CREATE INDEX `idx_teams_default_model` ON `teams`(`default_model_id`);
ALTER TABLE `teams` ADD CONSTRAINT `teams_default_model_id_fkey` FOREIGN KEY (`default_model_id`) REFERENCES `models` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
