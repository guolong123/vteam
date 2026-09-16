-- plans 表定稿冻结（plan-finalize-actions todo 2，加法-only）：冻结版本双锚两可空列
-- （finalize pending_final→approved 消费，与 finalizedBy/finalizedAt 同行落库）。
-- 存量行两列全 NULL，读/写语义不变；命名锁定（frozenVersion/frozenHash）勿改。
ALTER TABLE `plans` ADD COLUMN `frozen_version` VARCHAR(191) NULL;
ALTER TABLE `plans` ADD COLUMN `frozen_hash` VARCHAR(191) NULL;
