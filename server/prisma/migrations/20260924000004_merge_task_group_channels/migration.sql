-- tech-debt-remediation Todo 44：把仍存活的 `task_group` 频道合并到 `team_group`，
-- 只迁移 live 且有 `team_id` 的频道；不丢失、不复制、不复活任何消息。
--
-- 前置门：
--   - Todo 43 W8 preflight 已通过；Todo 43 的全库恢复点是
--     `.omo/evidence/ddl-W8-task43-20260924.sql`。以下五份更早恢复点也保留且不得覆盖：
--     `.omo/evidence/ddl-W6-20260924.sql`、
--     `.omo/evidence/ddl-W6-20260924-pre.sql`、
--     `.omo/evidence/ddl-W6-task38-20260924.sql`、
--     `.omo/evidence/ddl-W7-20260924.sql`、
--     `.omo/evidence/ddl-W7-todo42-20260924-pre.sql`。
--   - Todo 43 六个 live `aiagents` 探针值逐字转录如下（数据库为 2026-09-24 的 live 快照）：
--     Probe 1 — `SELECT type, COUNT(*) FROM chat_channels GROUP BY type;`
--     private	7
--     team_group	2
--     (task_group rows on live = 0.)
--     Probe 2 — `SELECT COUNT(*) FROM chat_channels WHERE type='task_group' AND deleted_at IS NULL;`
--     0
--     Probe 3 — `SELECT team_id, COUNT(*) FROM chat_channels WHERE type='task_group' GROUP BY team_id ORDER BY 2 DESC LIMIT 50;`
--     (empty set — 0 rows)
--     Probe 4 — `SELECT COUNT(*) FROM chat_channels c WHERE c.type='task_group' AND NOT EXISTS (SELECT 1 FROM chat_channels t WHERE t.team_id=c.team_id AND t.type='team_group' AND t.deleted_at IS NULL);`
--     0
--     Probe 5 — `SELECT COUNT(*) FROM messages m JOIN chat_channels c ON m.channel_id=c.id WHERE c.type='task_group';`
--     0
--     Probe 6 — `SELECT COUNT(*) FROM chat_channels c WHERE c.type='task_group' AND c.team_id IS NULL;`
--     0
--   - 因 Probe 1/2/5 均为 0，本数据库 live apply 是**实测 no-op**：不会新增 survivor、
--     不会移动消息、不会删除频道。通用合并逻辑没有因此写成只适用于空数据的 SQL；
--     真实构造场景在 throwaway scratch schema 中验证，详见 task-44 evidence。
--
-- 生成列与碰撞：
--   - `20260901000004_fix_team_group_unique/migration.sql` 的定义是：
--       `team_group_key` VARCHAR(191) GENERATED ALWAYS AS
--       (CASE WHEN `type` = 'team_group' AND `team_member_id` IS NULL
--              AND `deleted_at` IS NULL THEN `team_id` ELSE NULL END) STORED
--     并由 `uk_channels_team_group_single` UNIQUE 约束。
--   - 因此对已有 live `team_group` 的团队直接执行
--       `UPDATE chat_channels SET type='team_group' WHERE id=...`
--     会自动计算 `team_group_key = team_id` 并撞唯一键。Todo 43 scratch 已复现字面错误：
--       ERROR 1062 (23000) at line 1: Duplicate entry 'tm_0000000001' for key
--       'chat_channels.uk_channels_team_group_single'
--     本迁移禁止 blind type flip；采用“必要时先建 survivor，再 re-point messages，
--     再 soft-delete source”的顺序。
--
-- 顺序与作用域（每个 team 都必须遵守）：
--   (1) 对有 live `task_group`、但没有 live `team_group` 的 team，创建一个
--       `type='team_group'`、`team_id=<team>`、
--       `team_member_id=NULL`、`task_id=NULL`、`deleted_at=NULL` 的 survivor。
--       `team_group_key` 是 STORED GENERATED 列，INSERT 明确不写它，由 MySQL 自动生成。
--   (2) 只把该 team 在步骤 (0) 锁定的 LIVE `task_group` source 消息的
--       `messages.channel_id` 改为 survivor；不跨 `team_id`，不碰 content/sender_id。
--   (3) 用 `NOW(3)` soft-delete 同一批 source 行。该动作把 generated key 置为 NULL，
--       消除任何后续 type flip 的唯一键碰撞风险。
--   (4) 只有在消息 guard 证明 source 消息全部已 re-point 后，才 hard-delete 步骤 (3)
--       标记的**同一批** source 行。
--
-- `Message.channel` 的物理 FK 是 `ON DELETE RESTRICT`：source 仍有消息时不能删除，
-- 所以“先移动 messages、后删除 channel”不是风格要求，而是数据约束要求。
-- source 临时表只在 `deleted_at IS NULL AND team_id IS NOT NULL` 时收录；
-- 已经 soft-deleted 的 `task_group` 与 `team_id IS NULL` orphan 从未进入 source 表，
-- 因而不会被 re-point、soft-delete 或 hard-delete：前者不能复活用户已删除的历史，
-- 后者不能凭空猜一个团队归属；它们的消息也保持原指向。
--
-- ID 生成：应用 `IdGeneratorService` 的频道域前缀是 `c`，格式为
-- `<prefix>_<零填充 10 位序号>`（例如 `c_0000000001`），启动时由
-- `resyncIdPrefix` 从库内 `c_` 纯数字 id 续号。SQL 取当前最大纯数字频道序号，
-- 按 `team_id` 排序分配连续候选 `c_<10位序号>`，不是随机值。INSERT 使用
-- `ON DUPLICATE KEY UPDATE id=chat_channels.id` 的 no-op 处理并发已创建的同一 team
-- survivor（也处理唯一键竞态），绝不覆盖已有行的 id；随后按 team 重新查实际 survivor。
-- 若候选 id 被不相关的并发行占用，宁可触发下面的 guard 使事务失败，也不产生重复 id
-- 或错误合并；不会用 `INSERT IGNORE` 吞掉非竞态错误。
--
-- 事务：步骤 (0)–(4) 全部在同一个 `START TRANSACTION` / `COMMIT` 内；临时表 DDL
-- 只针对 TEMPORARY table，不触发 MySQL implicit commit。所有消息重指向、source
-- soft-delete、source hard-delete 要么一起提交，要么在任一 guard/FK/唯一键错误时整体
-- 回滚，避免出现“消息已移动但频道未清理”或相反的半迁移状态。
--
-- 回滚 = 恢复迁移前全库 dump（host/port/user/db 为部署占位符，日期固定 20260924）：
-- mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p<db> > .omo/evidence/ddl-W8-20260924.sql
-- mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-W8-20260924.sql
--
-- 迁移 diff QA：本库存在预存 schema drift；`prisma migrate diff --from-migrations`
-- 的原始约 15 条无关 statements 已判定 FAIL/REJECT，未执行、未应用，也未吸收。
-- 本文件只包含上述数据迁移；不编辑历史迁移，不运行 migrate dev/reset/db push，
-- 不在 live `aiagents` 制造 `task_group` 行。

START TRANSACTION;

-- (0) 锁定并快照本事务要处理的 source。绝不把 NULL team 或已删除行放进快照。
DROP TEMPORARY TABLE IF EXISTS `_todo44_source_messages`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_message_guard`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_step3_guard`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_step4_guard`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_survivor_candidates`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_id_base`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_teams`;
DROP TEMPORARY TABLE IF EXISTS `_todo44_live_task_group`;

CREATE TEMPORARY TABLE `_todo44_live_task_group` (
  `source_id` VARCHAR(191) NOT NULL,
  `team_id` VARCHAR(191) NOT NULL,
  `migrated_deleted_at` DATETIME(3) NULL,
  PRIMARY KEY (`source_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_live_task_group` (`source_id`, `team_id`)
SELECT c.`id`, c.`team_id`
FROM `chat_channels` AS c
WHERE c.`type` = 'task_group'
  AND c.`deleted_at` IS NULL
  AND c.`team_id` IS NOT NULL;

-- 在创建 survivor 或移动消息前锁住 source 行；FK parent lock 也阻止并发消息
-- 在本事务快照之外悄悄挂到即将删除的 channel 上。
SELECT c.`id`
FROM `chat_channels` AS c
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = c.`id`
WHERE c.`type` = 'task_group'
  AND c.`team_id` IS NOT NULL
  AND c.`team_id` = s.`team_id`
  AND c.`deleted_at` IS NULL
FOR UPDATE;

-- 锁定前后若有并发事务已处理/删除 source，只保留当前仍满足 LIVE 谓词的快照行。
DELETE s
FROM `_todo44_live_task_group` AS s
LEFT JOIN `chat_channels` AS c ON c.`id` = s.`source_id`
WHERE c.`id` IS NULL
   OR c.`type` <> 'task_group'
   OR c.`deleted_at` IS NOT NULL
   OR c.`team_id` IS NULL
   OR c.`team_id` <> s.`team_id`;

CREATE TEMPORARY TABLE `_todo44_teams` (
  `team_id` VARCHAR(191) NOT NULL,
  `survivor_id` VARCHAR(191) NULL,
  PRIMARY KEY (`team_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_teams` (`team_id`)
SELECT DISTINCT s.`team_id`
FROM `_todo44_live_task_group` AS s;

-- 已有且仍 live 的标准 team_group 直接作为 survivor；不创建第二个同 team survivor。
UPDATE `_todo44_teams` AS t
INNER JOIN `chat_channels` AS c
  ON c.`team_id` = t.`team_id`
 AND c.`type` = 'team_group'
 AND c.`deleted_at` IS NULL
SET t.`survivor_id` = c.`id`
WHERE t.`survivor_id` IS NULL;

-- 为缺 survivor 的 team 分配确定性的 `c_<10位序号>` candidate。max 读取包含已删除
-- channel 的 c_ 纯数字 id，和应用重启续号口径一致；ROW_NUMBER 按 team_id 固定排序。
CREATE TEMPORARY TABLE `_todo44_id_base` (
  `max_channel_seq` BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_id_base` (`max_channel_seq`)
SELECT COALESCE(
  MAX(CAST(SUBSTRING(c.`id`, 3) AS UNSIGNED)),
  0
)
FROM `chat_channels` AS c
WHERE c.`id` REGEXP '^c_[0-9]+$';

CREATE TEMPORARY TABLE `_todo44_survivor_candidates` (
  `team_id` VARCHAR(191) NOT NULL,
  `candidate_id` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`team_id`),
  UNIQUE KEY `uq_todo44_candidate_id` (`candidate_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_survivor_candidates` (`team_id`, `candidate_id`)
SELECT t.`team_id`,
       CONCAT(
         'c_',
         LPAD(
           CAST(b.`max_channel_seq` + ROW_NUMBER() OVER (ORDER BY t.`team_id`) AS CHAR),
           10,
           '0'
         )
       )
FROM `_todo44_teams` AS t
CROSS JOIN `_todo44_id_base` AS b
WHERE t.`survivor_id` IS NULL;

-- (1) 创建缺失 survivor。绝不显式写 generated `team_group_key`。
-- no-op duplicate update 保留竞态中已经存在的真实 id；随后统一重查。
INSERT INTO `chat_channels`
  (`id`, `type`, `task_id`, `team_id`, `team_member_id`, `deleted_at`)
SELECT k.`candidate_id`,
       'team_group',
       NULL,
       k.`team_id`,
       NULL,
       NULL
FROM `_todo44_survivor_candidates` AS k
INNER JOIN `_todo44_teams` AS t ON t.`team_id` = k.`team_id`
WHERE t.`survivor_id` IS NULL
ON DUPLICATE KEY UPDATE `id` = `chat_channels`.`id`;

UPDATE `_todo44_teams` AS t
INNER JOIN `chat_channels` AS c
  ON c.`team_id` = t.`team_id`
 AND c.`type` = 'team_group'
 AND c.`deleted_at` IS NULL
SET t.`survivor_id` = c.`id`
WHERE t.`survivor_id` IS NULL;

-- 任一 source team 没有可用 survivor 时，把 NULL 插入 NOT NULL guard，强制失败回滚。
CREATE TEMPORARY TABLE `_todo44_step3_guard` (
  `id` VARCHAR(191) NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_step3_guard` (`id`)
SELECT t.`team_id`
FROM `_todo44_teams` AS t
WHERE t.`survivor_id` IS NULL
LIMIT 1;

DROP TEMPORARY TABLE `_todo44_step3_guard`;

-- 保存 source 上每一条消息及其目标 survivor。step (2) 只更新这些 channel_id，
-- content、sender_id、mentions、附件等列完全不写入。
CREATE TEMPORARY TABLE `_todo44_source_messages` (
  `message_id` VARCHAR(191) NOT NULL,
  `survivor_id` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`message_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_source_messages` (`message_id`, `survivor_id`)
SELECT m.`id`, t.`survivor_id`
FROM `messages` AS m
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = m.`channel_id`
INNER JOIN `_todo44_teams` AS t ON t.`team_id` = s.`team_id`
INNER JOIN `chat_channels` AS c
  ON c.`id` = s.`source_id`
 AND c.`type` = 'task_group'
 AND c.`team_id` = s.`team_id`
 AND c.`deleted_at` IS NULL
WHERE t.`survivor_id` IS NOT NULL;

-- (2) 先移动消息。JOIN 同一 source 快照与 team map，结构上禁止跨 team 合并。
UPDATE `messages` AS m
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = m.`channel_id`
INNER JOIN `_todo44_source_messages` AS sm ON sm.`message_id` = m.`id`
SET m.`channel_id` = sm.`survivor_id`
WHERE m.`channel_id` = s.`source_id`;

-- step (2) 的硬 guard：source message 不能消失、不能仍指向 source、不能指向错误 team
-- 的 survivor。命中任意一条都会因 NOT NULL 插入失败，令整个事务回滚。
CREATE TEMPORARY TABLE `_todo44_message_guard` (
  `id` VARCHAR(191) NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_message_guard` (`id`)
SELECT sm.`message_id`
FROM `_todo44_source_messages` AS sm
LEFT JOIN `messages` AS m ON m.`id` = sm.`message_id`
WHERE m.`id` IS NULL
   OR m.`channel_id` <> sm.`survivor_id`
LIMIT 1;

DROP TEMPORARY TABLE `_todo44_message_guard`;

-- (3) 再 soft-delete 同一批 LIVE source；multi-table UPDATE 同时把本次时间戳记入快照，
-- 供 step (4) 精确删除“本次步骤 (3) 改过的行”，不会误删别的 soft-deleted 行。
UPDATE `chat_channels` AS c
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = c.`id`
SET c.`deleted_at` = NOW(3),
    s.`migrated_deleted_at` = NOW(3)
WHERE c.`type` = 'task_group'
  AND c.`team_id` = s.`team_id`
  AND c.`team_id` IS NOT NULL
  AND c.`deleted_at` IS NULL;

-- source 若没有被步骤 (3) 标记，不能进入 hard-delete；guard 失败而不是静默遗留。
CREATE TEMPORARY TABLE `_todo44_step4_guard` (
  `id` VARCHAR(191) NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_step4_guard` (`id`)
SELECT s.`source_id`
FROM `_todo44_live_task_group` AS s
WHERE s.`migrated_deleted_at` IS NULL
LIMIT 1;

DROP TEMPORARY TABLE `_todo44_step4_guard`;

-- (4) 只有在上面的 message guard 通过后，才 hard-delete 步骤 (3) 标记的同一批 source。
-- 若任何 source message 仍存在，Restrict FK 会拒绝本 DELETE；不能依赖错误恢复顺序。
DELETE c
FROM `chat_channels` AS c
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = c.`id`
WHERE s.`migrated_deleted_at` IS NOT NULL
  AND c.`type` = 'task_group'
  AND c.`team_id` = s.`team_id`
  AND c.`team_id` IS NOT NULL
  AND c.`deleted_at` = s.`migrated_deleted_at`;

-- hard-delete 后仍残留 source message 也会使 guard 失败（正常路径应为空）。
CREATE TEMPORARY TABLE `_todo44_step4_guard` (
  `id` VARCHAR(191) NOT NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `_todo44_step4_guard` (`id`)
SELECT m.`id`
FROM `messages` AS m
INNER JOIN `_todo44_live_task_group` AS s ON s.`source_id` = m.`channel_id`
LIMIT 1;

DROP TEMPORARY TABLE `_todo44_step4_guard`;

DROP TEMPORARY TABLE `_todo44_source_messages`;
DROP TEMPORARY TABLE `_todo44_teams`;
DROP TEMPORARY TABLE `_todo44_survivor_candidates`;
DROP TEMPORARY TABLE `_todo44_id_base`;
DROP TEMPORARY TABLE `_todo44_live_task_group`;

COMMIT;
