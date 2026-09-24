-- tech-debt-remediation Todo 38：删除 execution_mode 与 task_agent_id 兼容列及其复合唯一索引（单向不可逆）。
--
-- 前置门：
--   - Todo 32 W6 preflight 已通过阻塞阈值探针、全库 dump 与恢复演练；既有恢复点仍保留在
--     .omo/evidence/ddl-W6-20260924.sql 与 .omo/evidence/ddl-W6-20260924-pre.sql，二者不得覆盖。
--   - Todo 33/34/35 已迁走所有 live reader/writer 并确认 execution_mode 无 live reader；
--     Todo 37 已通过真实 UI 与真实 HTTP task_context MCP 工具验证 team-derived 主身份。
--   - Todo 38 已在 live aiagents 重新执行探针；三个阻塞值均为 0。uk_channels_task_agent
--     自有探针 chat_channels.task_agent_id IS NOT NULL=0，故其列与索引均获准删除。
--   - 本迁移不回填、不改业务行；另保留 Todo 37 之后的当前态恢复点
--     .omo/evidence/ddl-W6-task38-20260924.sql。
--
-- 数据面实证（Todo 32 原始记录逐字转录；Todo 38 预迁移重新实测）：
--   Todo 32（2026-09-24，live aiagents）：
--   - tasks WHERE main_agent_id IS NOT NULL ............ 1
--   - tasks WHERE main_agent_instance_id IS NOT NULL ... 1
--   - tasks WHERE execution_mode <> 'direct' ........... 0
--   - sessions WHERE task_id IS NOT NULL (BLOCKING) .... 0
--   - chat_channels WHERE task_agent_id IS NOT NULL (BLOCKING) ... 0
--
--   Todo 38（2026-09-24，live aiagents，migrate deploy 前）：
--   - chat_channels WHERE task_agent_id IS NOT NULL = 0
--   - sessions WHERE task_id IS NOT NULL = 0
--   - chat_channels WHERE task_id IS NOT NULL AND task_agent_id IS NOT NULL = 0
--   - tasks WHERE execution_mode <> 'direct' = 0
--
--   live 数据库在 Todo 32 后已有新增数据：Todo 37 functional walk 新增 team
--   tm_0000000002、task t_0000000002 及关联 plan pl_0000000002 等行。当前精确行数为
--   tasks=2, sessions=7, chat_channels=9, triggers=78, messages=158, agents=8, users=3,
--   plans=2, plan_tasks=2。计划交接中的 post-walk 简写 plans=1 已过时；plans 多出的 1 行
--   已由只读查询定位为 Todo 37 于 2026-09-24 08:31:41.977 创建的 pl_0000000002，不是迁移偏差。
--
-- 顺序钉死（只删不回填）：
--   (0) 重新执行数据/FK/index 探针 → (1) 先删两个依赖 task_agent_id 的复合 UNIQUE 索引
--   → (2) 再用 ALGORITHM=INSTANT 删除 execution_mode 与两个 task_agent_id 列。
--   复合索引删除是 metadata-only；列删除前必须先删所有覆盖该列的索引。
--   任何前置门或 apply 步骤失败都立即停止；禁止 migrate dev/reset/db push，禁止盲目重试或 fix forward。
--
-- FK / index 实证（2026-09-24，aiagents，MySQL 8.4.11；information_schema 实际查询）：
--   - tasks.execution_mode：COLUMNS 实测 varchar(191) NOT NULL DEFAULT 'direct'，COLUMN_KEY 为空；
--     KEY_COLUMN_USAGE 无 FK 行，STATISTICS 无任何以该列组成的索引。
--   - sessions.task_id：COLUMNS 实测存在且 COLUMN_KEY=MUL；物理 FK sessions_task_id_fkey
--     → tasks.id，ON DELETE RESTRICT / ON UPDATE RESTRICT；另有单列支撑索引 idx_sessions_task_id。
--   - sessions.task_agent_id：COLUMNS 实测 varchar(191) NULL，COLUMN_KEY 为空；
--     KEY_COLUMN_USAGE 无 FK 行；仅由 uk_sessions_task_agent(task_id, task_agent_id) 覆盖。
--   - chat_channels.task_id：COLUMNS 实测存在且 COLUMN_KEY=MUL；物理 FK
--     chat_channels_task_id_fkey → tasks.id，ON DELETE RESTRICT / ON UPDATE RESTRICT；
--     另有单列支撑索引 idx_channels_task_id。
--   - chat_channels.task_agent_id：COLUMNS 实测 varchar(191) NULL，COLUMN_KEY 为空；
--     KEY_COLUMN_USAGE 无 FK 行；仅由 uk_channels_task_agent(task_id, task_agent_id) 覆盖。
--   - uk_sessions_task_agent：NON_UNIQUE=0，BTREE，SEQ 1=task_id、SEQ 2=task_agent_id。
--   - uk_channels_task_agent：NON_UNIQUE=0，BTREE，SEQ 1=task_id、SEQ 2=task_agent_id。
--
-- migrate diff QA / review verdict：
--   原始 `--from-migrations`（含 shadow database）输出除本迁移五个对象外，还提出 artifacts /
--   memories / agents / agent_roles / hooks / triggers / team_members / team_queues 的 FK、
--   index、nullability、DEFAULT 与 rename 漂移，并错误提议删除 sessions/chat_channels 的
--   task_id FK；该原始脚本判定 FAIL / REJECT，未执行，也未吸收任何漂移。shadow database
--   vteam_w6_diff_raw_task38_20260924 随后已删除，information_schema 残留计数=0。
--   另以只含 tasks/sessions/chat_channels 目标形状的 pre/post datamodel fixture 执行
--   `prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel ... --script`；
--   两个 fixture 均先通过 prisma validate，生成 SQL 恰好只有下列五个对象：
--     DROP INDEX uk_sessions_task_agent ON sessions
--     DROP INDEX uk_channels_task_agent ON chat_channels
--     DROP COLUMN tasks.execution_mode
--     DROP COLUMN sessions.task_agent_id
--     DROP COLUMN chat_channels.task_agent_id
--   review verdict=PASS；最终迁移只补充 MySQL 8.4.11 的 ALGORITHM=INSTANT 子句，不改对象范围。
--
-- INSTANT / fallback（目标 MySQL 8.4.11；沿用 Todo 36 已建立的实测，不重复试错）：
--   首选语义原为 `ALGORITHM=INSTANT, LOCK=NONE`，但目标服务器会以 ERROR 1221 拒绝该组合；
--   因此本迁移使用 `ALGORITHM=INSTANT`，且先删两个复合索引。若部署前维护窗口确认 INSTANT
--   不可用，DDL 回退为 `ALGORITHM=INPLACE, LOCK=NONE`；INPLACE 会取得 metadata/data lock，
--   必须在维护窗口执行，不能宣称无锁。本次 apply 若任一步报错即停止，不在 live 库自动重试。
--
-- 回滚 = 恢复迁移前全库 dump（仓库无 down-migration；以下 host/port/user/db 为部署占位符）。
-- 既有 Todo 32 恢复点（不得覆盖）：
-- mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p<db> > .omo/evidence/ddl-W6-20260924.sql
-- mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-W6-20260924.sql
-- Todo 38 当前态恢复点（包含 Todo 37 新增行；同样不得覆盖）：
-- mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p<db> > .omo/evidence/ddl-W6-task38-20260924.sql
-- mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-W6-task38-20260924.sql

-- (1) 先删依赖 task_agent_id 的两个 UNIQUE 索引；DROP INDEX 为 metadata-only。
ALTER TABLE `sessions` DROP INDEX `uk_sessions_task_agent`;
ALTER TABLE `chat_channels` DROP INDEX `uk_channels_task_agent`;

-- (2) 三个兼容列只删不回填；显式 INSTANT，禁止吸收历史 schema drift。
ALTER TABLE `tasks`
  DROP COLUMN `execution_mode`,
  ALGORITHM=INSTANT;

ALTER TABLE `sessions`
  DROP COLUMN `task_agent_id`,
  ALGORITHM=INSTANT;

ALTER TABLE `chat_channels`
  DROP COLUMN `task_agent_id`,
  ALGORITHM=INSTANT;
