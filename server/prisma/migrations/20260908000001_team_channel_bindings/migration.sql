-- 团队渠道绑定：消息渠道 + 通知渠道从任务迁移到团队
CREATE TABLE `team_message_channels` (
  `team_id` VARCHAR(191) NOT NULL,
  `message_channel_id` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`team_id`, `message_channel_id`),
  UNIQUE KEY `team_message_channels_team_id_message_channel_id_key` (`team_id`, `message_channel_id`),
  KEY `team_message_channels_team_id_index` (`team_id`),
  CONSTRAINT `team_message_channels_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `team_message_channels_message_channel_id_fkey` FOREIGN KEY (`message_channel_id`) REFERENCES `message_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `team_notification_channels` (
  `team_id` VARCHAR(191) NOT NULL,
  `notification_channel_id` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`team_id`, `notification_channel_id`),
  UNIQUE KEY `team_notification_channels_team_id_notification_channel_id_key` (`team_id`, `notification_channel_id`),
  KEY `team_notification_channels_team_id_index` (`team_id`),
  CONSTRAINT `team_notification_channels_team_id_fkey` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `team_notification_channels_notification_channel_id_fkey` FOREIGN KEY (`notification_channel_id`) REFERENCES `notification_channels` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
