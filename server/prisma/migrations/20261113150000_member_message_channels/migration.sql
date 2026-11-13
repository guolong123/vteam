-- 入站消息渠道 → 成员绑定（2026-11-13）
--
-- 背景：此前入站消息渠道只能绑定到**团队**（team_message_channels），
-- 企微消息统一进团队群聊。用户需要「企微消息直达某个成员」：
-- 渠道绑定到**人**（members.id）后，消息直接进这个人的私聊（全局一条 DM，
-- 与团队无关）并触发其执行，不再进群聊。
--
-- 为什么按 member 而不是 team_member：用户心智是「发给这个人」，不关心他在
-- 哪个团队任职；线上存在一个成员在 3 个团队都有席位的场景，按席位绑会出现
-- 「绑了却选错团队」的歧义。
--
-- 渠道独占：同一渠道只能绑一个团队或一个成员（应用层 409 冲突检查）。
--
-- 迁移链只跑 MySQL（SQLite 测试库走 `prisma db push`，不写兼容逻辑）；
-- 本仓库无 down-migration 约定（docs/tech-debt-rollback.md）。

CREATE TABLE `member_message_channels` (
  `member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `message_channel_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`member_id`, `message_channel_id`),
  -- 索引名必须 ≤64 字符（MySQL 限制）：Prisma 默认拼出的长名会超限导致迁移失败
  UNIQUE INDEX `uk_mmc_member_channel`(`member_id`, `message_channel_id`),
  INDEX `idx_mmc_member`(`member_id`),
  INDEX `idx_mmc_channel`(`message_channel_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `member_message_channels`
  ADD CONSTRAINT `member_message_channels_member_id_fkey`
    FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_message_channels`
  ADD CONSTRAINT `member_message_channels_message_channel_id_fkey`
    FOREIGN KEY (`message_channel_id`) REFERENCES `message_channels`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
