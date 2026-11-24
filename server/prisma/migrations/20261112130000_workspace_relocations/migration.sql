-- 资源空间迁移审计（workspace_relocations）。
-- 只存 id 串软关联，不建外键；不涉及存量回填。
-- 回滚：本仓无 down-migration 约定，按重建库口径（生产先 mysqldump）。

CREATE TABLE `workspace_relocations` (
    `id` VARCHAR(191) NOT NULL,
    `resource_type` VARCHAR(32) NOT NULL,
    `resource_id` VARCHAR(191) NOT NULL,
    `from_workspace_id` VARCHAR(191) NOT NULL,
    `to_workspace_id` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(512) NULL,
    `actor_user_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_ws_relocations_resource`(`resource_type`, `resource_id`),
    INDEX `idx_ws_relocations_created_at`(`created_at`),
    INDEX `idx_ws_relocations_to_ws`(`to_workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
