-- 全局会话（37 篇 §3.6 / P3）：一成员一条 team-mode 会话 + 每轮不可变上下文
--
-- expand 阶段：sessions 只加可空列/索引（旧代码不读）；新增 session_turns。
-- member_key / running_key 是**应用层维护的普通列**（不是 DB 生成列）：
--   - 双库（MySQL/SQLite）行为一致，Prisma 可表达，测试库 db push 也能建；
--   - 唯一性语义：sessions.member_key 仅 team-mode 行非空；session_turns.running_key
--     仅 running 行非空。MySQL 唯一索引允许多个 NULL，因此不影响 task 行/历史行。

-- ------------------------------------------------------------------
-- 1) sessions 补全局会话字段
-- ------------------------------------------------------------------
ALTER TABLE `sessions` ADD COLUMN `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `member_key` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `seat_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `current_team_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `current_task_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `current_channel_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `turn_seq` int NOT NULL DEFAULT 0;
ALTER TABLE `sessions` ADD COLUMN `busy_state` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'idle';
ALTER TABLE `sessions` ADD COLUMN `busy_since` datetime(3) DEFAULT NULL;
ALTER TABLE `sessions` ADD COLUMN `last_turn_outcome` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
CREATE UNIQUE INDEX `uk_sessions_member` ON `sessions`(`member_key`);
CREATE INDEX `idx_sessions_member` ON `sessions`(`member_id`);

-- ------------------------------------------------------------------
-- 2) session_turns：每轮冻结 team/channel/seat（回复落点/回执/审计用）
-- ------------------------------------------------------------------
CREATE TABLE `session_turns` (
  `id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `seq` int NOT NULL,
  `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `seat_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `team_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `channel_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `task_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `message_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'user_mention',
  `status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `running_key` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `enqueued_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `started_at` datetime(3) DEFAULT NULL,
  `ended_at` datetime(3) DEFAULT NULL,
  `error` varchar(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `engine_message_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_session_turns_seq` (`session_id`,`seq`),
  UNIQUE KEY `uk_session_turns_running` (`running_key`),
  KEY `idx_session_turns_pick` (`session_id`,`status`,`seq`),
  KEY `idx_session_turns_claim` (`status`,`enqueued_at`),
  KEY `idx_session_turns_team` (`team_id`,`status`),
  CONSTRAINT `session_turns_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
