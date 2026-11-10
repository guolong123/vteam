-- 成员级性格 + 成员专属提示词（成员平台化：性格从 Agent 迁入 Member）
--
-- 纯 expand 迁移：三列全部可空或带默认值，旧代码只读既有列即可运行。
-- 成员是平台级实例：同一 Agent/岗位的不同成员可有不同性格与行为要求。
--
-- 双库说明：迁移链只跑 MySQL；SQLite 测试库走 prisma db push，无 FK/索引差异。

-- ① 性格：PERSONA_LIBRARY key（steady/strict/aggressive/conservative/innovative）。
--    非空时优先于 agents.persona（存量 Agent 性格保留为回退，不迁移数据）。
ALTER TABLE `members` ADD COLUMN `persona` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;

-- ② 成员专属提示词：成员级特殊行为描述（TEXT 承载长文本）。
ALTER TABLE `members` ADD COLUMN `prompt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ③ 提示词关系：append（在 Agent 岗位职责之上追加，默认）/ override（覆盖 Agent 提示词段）。
ALTER TABLE `members` ADD COLUMN `prompt_mode` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'append';
