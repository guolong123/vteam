-- AlterTable `tasks`：托管模式（managedMode）
-- 开启后成员 question/permission 请求不弹窗给用户，改由主 Agent 经 question_confirm 确认。
-- 存量任务默认 false（非托管，行为不变）。
ALTER TABLE `tasks` ADD COLUMN `managed_mode` BOOLEAN NOT NULL DEFAULT false;
