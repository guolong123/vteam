-- AlterTable: tasks - add reset_after_complete for per-task session reset override
ALTER TABLE `tasks` ADD COLUMN `reset_after_complete` BOOLEAN NOT NULL DEFAULT false;
