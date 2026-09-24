-- tech-debt-remediation Todo 36：删除 tasks 主 Agent 兼容列（单向不可逆）。
--
-- 前置门：
--   - Todo 32 W6 preflight 已完成全库 dump、阻塞阈值探针与恢复演练；恢复点仍保留在
--     .omo/evidence/ddl-W6-20260924.sql 与 .omo/evidence/ddl-W6-20260924-pre.sql。
--   - Todo 33/34 已把主 Agent 读/写路径迁到 Team.mainAgentMemberId 并移除 DTO 写入；
--     Todo 35 已确认 execution_mode 只留待 Todo 38 删除。
--   - 本迁移不回填、不改任何业务行；只处理 tasks 的两个兼容列及其物理 FK/index。
--
-- 顺序钉死（只删不回填）：
--   (0) FK/index 实证 → (1) 删除 tasks.main_agent_id 的物理 FK 与其单列支撑索引
--   → (2) 删除 tasks.main_agent_id 与 tasks.main_agent_instance_id 两列。
--   任何前置门失败都不得执行后续 DDL；禁止 migrate dev/reset/db push。
--
-- FK 实证（2026-09-24，aiagents，MySQL 8.4.11；information_schema 实际查询）：
--   - tasks_main_agent_id_fkey：tasks.main_agent_id → agents.id，ON DELETE RESTRICT，
--     ON UPDATE RESTRICT；这是真实物理 FK，不是 schema.prisma 的声明推断。
--   - tasks.main_agent_instance_id：KEY_COLUMN_USAGE 无任何行；纯字符串列，无物理 FK。
--   - tasks_main_agent_id_fkey 单列索引实际存在于 tasks(main_agent_id)，删除 FK 后仍需
--     显式删除该支撑索引，MySQL 8.4.11 才能对后续 DROP COLUMN 使用 INSTANT。
--
-- 数据面实证（Todo 32 实测值逐字转录；本次授权销毁的兼容值如下）：
--   tasks.main_agent_id IS NOT NULL = 1
--   tasks.main_agent_instance_id IS NOT NULL = 1
--   tasks.execution_mode <> 'direct' = 0（该列属于 Todo 38，本迁移不动）
--   阻塞探针：sessions.task_id IS NOT NULL = 0；chat_channels.task_agent_id IS NOT NULL = 0。
--
-- migrate diff QA：从既有迁移目录到本版 schema 的原始输出还包含历史遗留漂移
--   （artifacts、memories、agents、agent_roles、triggers、team_members 等）；该原始脚本
--   未执行。隔离复核 diff（迁移前 Task schema → 本版 Task schema）只给出下列
--   tasks FK + 两列删除；本迁移不吸收任何其他表/列/index 的漂移。
--
-- INSTANT / fallback（目标 MySQL 8.4.11）：
--   首选语义是 `ALGORITHM=INSTANT, LOCK=NONE`。该服务器对 INSTANT 搭配显式
--   `LOCK=NONE` 返回 1221（已在本版本 scratch 证实）；因此可执行的列删除使用
--   `ALGORITHM=INSTANT`（其隐式锁行为等价于计划要求的无 DML 锁），并先移除 FK 支撑索引。
--   若服务器拒绝 INSTANT，回退为 `ALGORITHM=INPLACE, LOCK=NONE`；INPLACE 会取得
--   metadata/data lock，必须在维护窗口执行，不能假装是无锁操作。
--
-- 回滚 = 恢复迁移前全库 dump.
-- 迁移前备份（host/port/user/db 为部署占位符；本文件不记录密码）：
-- mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p<db> > .omo/evidence/ddl-W6-20260924.sql
-- 恢复（与上面备份配套，日期固定为 20260924）：
-- mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-W6-20260924.sql

-- (1) 物理 FK 实证命中，先删 FK；不触碰 agents 或其他表。
ALTER TABLE `tasks` DROP FOREIGN KEY `tasks_main_agent_id_fkey`;

-- (2) FK 的单列支撑索引仍留在 tasks；显式移除它，才能让下一步 DROP COLUMN 走 INSTANT。
ALTER TABLE `tasks` DROP INDEX `tasks_main_agent_id_fkey`;

-- (3) 两个兼容列只删不回填；execution_mode 明确保留给 Todo 38。
ALTER TABLE `tasks`
  DROP COLUMN `main_agent_id`,
  DROP COLUMN `main_agent_instance_id`,
  ALGORITHM=INSTANT;
