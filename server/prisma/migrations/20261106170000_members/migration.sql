-- 成员库域（vteam-member-decouple P0 / 37 篇 §3.2-3.4）
--
-- 纯 expand 迁移：新增 members、member_notification_channels，并在
-- team_members / chat_channels 上补可空的 member_id 指针。不回填、不改旧列，
-- 旧代码只读既有列即可运行（新列全部可空）。
--
-- 双库说明：迁移链只跑 MySQL；SQLite 测试库走 prisma db push，无 FK/索引差异。

-- ------------------------------------------------------------------
-- 1) members：平台级成员（主键前缀 mbr_，应用层序号生成）
-- ------------------------------------------------------------------
CREATE TABLE `members` (
  `id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `default_role_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `agent_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `default_model_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `preferred_worker_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `private_work_dir` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `origin_team_member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_by` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `members_name_key` (`name`),
  UNIQUE KEY `members_origin_team_member_id_key` (`origin_team_member_id`),
  KEY `idx_members_default_role` (`default_role_id`),
  KEY `idx_members_agent` (`agent_id`),
  KEY `idx_members_status` (`status`),
  CONSTRAINT `members_default_role_id_fkey` FOREIGN KEY (`default_role_id`) REFERENCES `agent_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `members_agent_id_fkey` FOREIGN KEY (`agent_id`) REFERENCES `agents` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `members_default_model_id_fkey` FOREIGN KEY (`default_model_id`) REFERENCES `models` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `members_preferred_worker_id_fkey` FOREIGN KEY (`preferred_worker_id`) REFERENCES `workers` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `members_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 2) member_notification_channels：成员 × 通知渠道（归属唯一）
-- ------------------------------------------------------------------
CREATE TABLE `member_notification_channels` (
  `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `notification_channel_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`member_id`,`notification_channel_id`),
  UNIQUE KEY `uk_member_notif_channel` (`notification_channel_id`),
  CONSTRAINT `member_notification_channels_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT `member_notification_channels_notification_channel_id_fkey` FOREIGN KEY (`notification_channel_id`) REFERENCES `notification_channels` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 3) 席位 / 私聊频道补成员指针（nullable，回填在后续阶段）
-- ------------------------------------------------------------------
ALTER TABLE `team_members` ADD COLUMN `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
CREATE INDEX `idx_team_members_member` ON `team_members`(`member_id`);
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `chat_channels` ADD COLUMN `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
CREATE INDEX `idx_chat_channels_member` ON `chat_channels`(`member_id`);
ALTER TABLE `chat_channels` ADD CONSTRAINT `chat_channels_member_id_fkey` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
