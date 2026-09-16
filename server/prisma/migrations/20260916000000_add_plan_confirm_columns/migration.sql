-- plans 表复活（todo2，加法-only）：用户确认审计三可空列（todo11 确认门消费）。
-- 存量行三列全 NULL，读/写语义不变；命名锁定（confirmedBy/confirmedAt/rejectReason）勿改。
ALTER TABLE `plans` ADD COLUMN `confirmed_by` VARCHAR(191) NULL;
ALTER TABLE `plans` ADD COLUMN `confirmed_at` DATETIME(3) NULL;
ALTER TABLE `plans` ADD COLUMN `reject_reason` TEXT NULL;
