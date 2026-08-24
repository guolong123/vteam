ALTER TABLE `memories` ADD COLUMN `source_agent_id` VARCHAR(191) NULL;
ALTER TABLE `memories` ADD COLUMN `source_instance_id` VARCHAR(191) NULL;
ALTER TABLE `memories` ADD COLUMN `source_type` VARCHAR(191) NULL;
ALTER TABLE `memories` ADD COLUMN `session_id` VARCHAR(191) NULL;
ALTER TABLE `memories` ADD COLUMN `session_title` VARCHAR(512) NULL;
ALTER TABLE `memories` ADD COLUMN `channel_id` VARCHAR(191) NULL;
CREATE INDEX `idx_memories_source_instance` ON `memories`(`source_instance_id`);
CREATE INDEX `idx_memories_session` ON `memories`(`session_id`);
