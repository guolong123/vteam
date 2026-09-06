-- AlterTable: teams - add main_agent_member_id (nullable FK -> team_members, expand stage nullable)
ALTER TABLE `teams` ADD COLUMN `main_agent_member_id` VARCHAR(191) NULL;
CREATE INDEX `idx_teams_main_agent_member` ON `teams`(`main_agent_member_id`);
ALTER TABLE `teams` ADD CONSTRAINT `teams_main_agent_member_id_fkey` FOREIGN KEY (`main_agent_member_id`) REFERENCES `team_members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
