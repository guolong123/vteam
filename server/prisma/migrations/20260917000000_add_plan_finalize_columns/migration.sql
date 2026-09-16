-- plans 表定稿门审计（加法-only）：用户定稿确认两可空列（finalize pending_final→approved 消费）。
-- 存量行两列全 NULL，读/写语义不变；命名锁定（finalizedBy/finalizedAt）勿改。
ALTER TABLE `plans` ADD COLUMN `finalized_by` VARCHAR(191) NULL;
ALTER TABLE `plans` ADD COLUMN `finalized_at` DATETIME(3) NULL;
