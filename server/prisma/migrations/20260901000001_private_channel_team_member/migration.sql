-- AlterTable: chat_channels - add team_member_id, replace unique on team_id with composite unique
ALTER TABLE `chat_channels` ADD COLUMN `team_member_id` VARCHAR(191) NULL;

-- Drop FK first before dropping its index (MySQL requires index for FK)
ALTER TABLE `chat_channels` DROP FOREIGN KEY `chat_channels_team_id_fkey`;
DROP INDEX `chat_channels_team_id_key` ON `chat_channels`;

-- Create composite unique for private channel reuse per team member
CREATE UNIQUE INDEX `uk_channels_team_member` ON `chat_channels`(`team_id`, `team_member_id`);

-- Index for teamId lookups (team_group + private)
CREATE INDEX `idx_chat_channels_team_id` ON `chat_channels`(`team_id`);

-- Re-add FK for team_id and add FK for team_member_id
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_team_member_id_fkey` FOREIGN KEY (`team_member_id`) REFERENCES `team_members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
