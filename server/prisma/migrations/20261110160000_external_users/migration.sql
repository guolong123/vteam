-- 外部渠道用户目录（external-users）：数据模型 + 历史消息回填
--
-- 背景：企微/通用 webhook 入站消息的外部发送者此前只以
-- `messages.sender_type='external' + sender_id=展示名` 的形式存在 —— 无法管理、
-- 无法按人回看消息。本迁移把「外部发送者」提升为独立实体 external_users，
-- 并给消息行补 external_user_id 指针（expand：新表 + 可空列，旧代码不受影响）。
--
-- 迁移链只跑 MySQL（SQLite 测试库走 `prisma db push`，不写兼容逻辑）；
-- 本仓库无 down-migration 约定（docs/tech-debt-rollback.md）。
--
-- 顺序：建表 → messages 加列/加索引 → 历史回填（先插实体，再回填指针）
--       → 最后加外键（回填完成后再约束，避免逐行校验失败/全表扫描期间锁表）。

-- ------------------------------------------------------------------
-- 1) external_users：外部用户目录
--
-- id 为应用层 IdGeneratorService 生成（eu_ 前缀 + 零填充序号），
-- varchar(191) 与全库域前缀主键一致；external_id 是「外部平台稳定标识」
-- 唯一键（id:<企微 userid>，无 userid 时回退 name:<展示名>），入站幂等靠它。
-- ------------------------------------------------------------------
CREATE TABLE `external_users` (
  `id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `external_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `position` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `company` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `contact` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'wecom_aibot',
  `first_message_at` datetime(3) DEFAULT NULL,
  `last_message_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `external_users_external_id_key` (`external_id`),
  KEY `idx_external_users_display_name` (`display_name`),
  KEY `idx_external_users_last_message_at` (`last_message_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 2) messages 增加 external_user_id（可空 expand 列）与复合索引
--
-- 索引 (external_user_id, id)：目录列表的「按人统计/按人倒序取消息」、
-- 详情页的 groupBy channel_id、消息回看游标（id < cursor）都走它。
-- ------------------------------------------------------------------
ALTER TABLE `messages`
  ADD COLUMN `external_user_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;

CREATE INDEX `idx_messages_external_user_id` ON `messages`(`external_user_id`, `id`);

-- ------------------------------------------------------------------
-- 3) 历史回填：把现有 sender_type='external' 的消息接上实体
--
-- 历史消息只记录了 sender_id（渠道展示名），没有稳定 userid ⇒ 按展示名分组、
-- 以 `name:<展示名>` 作为 external_id（与服务层无 userid 时的回退规则一致）。
-- 同名不同人会被合并成一条目录记录（契约 §5 已接受的取舍）。
--
-- id 用 `eu_bk_` + SHA2 前 16 位：确定性（可重跑/可追溯）、非数字尾段，
-- 服务的 resyncIdPrefix 只统计纯数字序号 ⇒ 回填 id 不会把新 id 计数器顶高。
-- 长度：'eu_bk_' (6) + 16 = 22，远小于 191。
--
-- first/last_message_at 取该展示名历史消息的 MIN/MAX(created_at)；created_at/
-- updated_at 同源，保证目录时间字段与消息事实一致（updated_at 无默认值，必须显式给）。
-- ------------------------------------------------------------------
INSERT INTO `external_users`
  (`id`, `external_id`, `display_name`, `source`, `first_message_at`, `last_message_at`, `created_at`, `updated_at`)
SELECT
  CONCAT('eu_bk_', LEFT(SHA2(CONCAT('legacy:', `sender_id`), 256), 16)),
  LEFT(CONCAT('name:', `sender_id`), 191),
  LEFT(`sender_id`, 191),
  'legacy',
  MIN(`created_at`),
  MAX(`created_at`),
  MIN(`created_at`),
  MAX(`created_at`)
FROM `messages`
WHERE `sender_type` = 'external'
  AND `sender_id` IS NOT NULL
  AND `sender_id` <> ''
GROUP BY `sender_id`;

-- 回填消息指针：按与上面完全一致的 external_id 派生规则 JOIN，只认 source='legacy'
-- （防止误连未来可能存在的 name: 实体行；迁移期间不会有新写入，仍显式收窄）。
UPDATE `messages` `m`
JOIN `external_users` `eu`
  ON `eu`.`external_id` = LEFT(CONCAT('name:', `m`.`sender_id`), 191)
SET `m`.`external_user_id` = `eu`.`id`
WHERE `m`.`sender_type` = 'external'
  AND `m`.`sender_id` IS NOT NULL
  AND `m`.`sender_id` <> ''
  AND `eu`.`source` = 'legacy';

-- ------------------------------------------------------------------
-- 4) 最后加外键：messages.external_user_id → external_users.id
--
-- ON DELETE SET NULL：删除目录行时消息保留（消息是业务事实，不能级联删）；
-- ON UPDATE RESTRICT：主键即标识，不允许改（与全库 FK 约定一致）。
-- ------------------------------------------------------------------
ALTER TABLE `messages`
  ADD CONSTRAINT `messages_external_user_id_fkey`
  FOREIGN KEY (`external_user_id`) REFERENCES `external_users` (`id`)
  ON DELETE SET NULL ON UPDATE RESTRICT;
