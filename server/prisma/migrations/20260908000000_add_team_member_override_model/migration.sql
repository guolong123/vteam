-- 添加 team_members.override_model_id（实例覆盖模型，null=跟随模板默认）
ALTER TABLE `team_members` ADD COLUMN `override_model_id` VARCHAR(191) NULL;
