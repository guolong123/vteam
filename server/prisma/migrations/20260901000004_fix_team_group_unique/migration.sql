-- Fix team_group singleton: team_group_key generated column + unique index
-- MySQL UNIQUE allows multiple NULLs so uk_channels_team_member cannot enforce single team_group per team.
-- Add generated column that is team_id only for active team_group, else NULL, with UNIQUE constraint.
ALTER TABLE `chat_channels` ADD COLUMN `team_group_key` VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN `type` = 'team_group' AND `team_member_id` IS NULL AND `deleted_at` IS NULL THEN `team_id` ELSE NULL END) STORED;
CREATE UNIQUE INDEX `uk_channels_team_group_single` ON `chat_channels`(`team_group_key`);
CREATE INDEX `idx_chat_channels_team_type` ON `chat_channels`(`team_id`, `type`);
