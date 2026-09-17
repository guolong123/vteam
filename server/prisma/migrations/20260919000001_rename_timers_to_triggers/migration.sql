-- timers -> triggers 单表改名（trigger-unification todo-2；存量行原地保留，不建并行表）
ALTER TABLE `timers` RENAME TO `triggers`;

-- 加列（全 nullable / 带默认，additive only；fire_at 本次不 drop，后续清理任务再动）
ALTER TABLE `triggers` ADD COLUMN `due_at` DATETIME(3) NULL;
ALTER TABLE `triggers` ADD COLUMN `scope_type` VARCHAR(191) NULL;
ALTER TABLE `triggers` ADD COLUMN `scope_id` VARCHAR(191) NULL;
ALTER TABLE `triggers` ADD COLUMN `owner_instance_id` VARCHAR(191) NULL;
ALTER TABLE `triggers` ADD COLUMN `interval_ms` INTEGER NULL;
ALTER TABLE `triggers` ADD COLUMN `next_fire_at` DATETIME(3) NULL;
ALTER TABLE `triggers` ADD COLUMN `guard_key` VARCHAR(191) NULL;
ALTER TABLE `triggers` ADD COLUMN `fire_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `triggers` ADD COLUMN `max_fires` INTEGER NULL;
ALTER TABLE `triggers` ADD COLUMN `expires_at` DATETIME(3) NULL;
ALTER TABLE `triggers` ADD COLUMN `skip_reason` VARCHAR(191) NULL;
ALTER TABLE `triggers` ADD COLUMN `busy_retries` INTEGER NOT NULL DEFAULT 0;

-- 回填：one-shot 存量行 fire_at -> due_at（同迁移内，保证新读路径可见）
UPDATE `triggers` SET `due_at` = `fire_at` WHERE `due_at` IS NULL;

-- 新读路径索引（旧 idx_timers_status_fire_at 随改名保留，不删）
CREATE INDEX `idx_triggers_status_due_at` ON `triggers`(`status`, `due_at`);
