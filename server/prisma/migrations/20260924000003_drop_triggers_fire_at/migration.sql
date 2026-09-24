-- tech-debt-remediation Todo 41 + 42（同一不可分割原子变更）：停止双写后，删除
-- triggers.fire_at 与旧复合索引，并把 triggers.due_at 收紧为 NOT NULL（单向不可逆）。
--
-- 前置门：
--   - Todo 39 W7 preflight 已通过；既有恢复点 .omo/evidence/ddl-W7-20260924.sql 不得覆盖。
--     工作树现存 W6 恢复点也全部保留：.omo/evidence/ddl-W6-20260924.sql、
--     .omo/evidence/ddl-W6-20260924-pre.sql、.omo/evidence/ddl-W6-task38-20260924.sql。
--     目录实测只有上述 3 份 W6 dump；“四份 W6”与当前文件清单不一致，故不虚构第四个路径。
--   - Todo 40 已删除全部 fire_at 读路径；Todo 41 已删除 schedule、两条 interval 重排、
--     hook fire 与 reconciler direction-A 共 5 个双写点。Todo 41 + 本 DDL 必须同批落地：
--     旧代码仍写 fire_at 时新 schema 会拒绝 unknown argument，新代码不再写 fire_at 时旧
--     schema 又会因 NOT NULL 无默认值而拒绝 INSERT；任一单侧提交都不是可运行状态。
--   - 本迁移 apply 前另取全库恢复点 .omo/evidence/ddl-W7-todo42-20260924-pre.sql：
--     26,249,259 bytes / 1,737 lines /
--     SHA-256 5dc22a365718f1b46c23c3ee0a57935e0ec5490962f9099ab447aff77bef0220；不得覆盖。
--   - 本迁移不回填、不改业务行；明确保留 idx_triggers_status_due_at，不触碰 Hook 模型、
--     hooks 表或任何 hook_fire 触发器行。禁止 migrate dev/reset/db push，禁止编辑历史迁移。
--
-- Todo 39 数据证据（2026-09-24，live aiagents，原始值逐字转录）：
--   triggers.due_at IS NULL = 0
--   triggers.fire_at <> due_at = 0
--   interval sanity probe = 0
--   total 78
--   kind/status census:
--   hook_poll	pending	1
--   session_idle_scan	cancelled	53
--   receipt_nudge	fired	23
--   progression_patrol	cancelled	1
--   补充：triggers.fire_at IS NOT NULL = 78。
--
-- 为什么必须把代码与 DDL 原子落地：
--   fire_at 的物理定义是 DATETIME(3) NOT NULL 且没有 DEFAULT；会话 sql_mode 包含
--   STRICT_TRANS_TABLES。Todo 39 之后曾在同定义 scratch 表上实证：INSERT 省略 fire_at
--   时返回 `ERROR 1364 (HY000): Field 'fire_at' doesn't have a default value`；同时提供
--   fire_at 与 due_at 时 INSERT 成功。因此 Todo 41 一旦先停止写 fire_at，在本 DDL 删除列前，
--   所有新 trigger 创建都会在运行时失败。三个临时 `as unknown as Prisma.TriggerCreateInput`
--   仅为掩盖这个缺列编译错误而存在；删除列后已全部移除，没有改成 `as any`。
--
-- migrate diff QA / review verdict：
--   使用独立 shadow schema vteam_w7_diff_raw_todo42_20260924 执行
--   `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --script`。
--   原始 from-migrations diff 除本迁移三个目标对象外，还包含既有 schema 漂移：artifacts FK /
--   category index、memories indexes、agent_roles.default_opencode_agent_name nullable、
--   agents.agent_key nullable、artifacts.category nullable、hooks.updated_at DEFAULT、
--   triggers.updated_at DEFAULT、team_members FK，以及 agents / team_message_channels /
--   team_notification_channels / triggers 的索引改名；其中 triggers 的同一 ALTER 还夹带
--   `updated_at DROP DEFAULT`。该原始脚本含无关预存漂移，review verdict=REJECT，未执行、
--   未应用，也未吸收任何额外对象。shadow schema 随后删除，information_schema 残留计数=0。
--   另以 HEAD 的迁移前 schema datamodel 对比本版 schema datamodel，隔离 diff 恰好只有：
--     DROP INDEX `idx_timers_status_fire_at` ON `triggers`;
--     ALTER TABLE `triggers` DROP COLUMN `fire_at`, MODIFY `due_at` DATETIME(3) NOT NULL;
--   隔离 review verdict=PASS；最终迁移仅重排为 index → column → NOT NULL，并补目标版本的
--   ALGORITHM/LOCK 子句，SQL 主体严格只有三个对象变更。
--
-- INSTANT / fallback（目标 MySQL 8.4.11）：
--   Todo 36/38 已实证该服务器把 `ALGORITHM=INSTANT, LOCK=NONE` 组合以 ERROR 1221 拒绝，
--   所以不得写该组合。DROP INDEX 是 metadata-only 操作，不附加不受支持的 INSTANT 子句；
--   删除 fire_at 使用已在本目标 scratch 通过的 `ALGORITHM=INSTANT`。
--   本目标 8.4.11 的独立 scratch 进一步证明，把 nullable due_at 改为 NOT NULL 时显式
--   `ALGORITHM=INSTANT` 会返回 ERROR 1845，因此实际采用已文档化且实测通过的 fallback：
--   `ALGORITHM=INPLACE, LOCK=NONE`。INPLACE 仍会取得 metadata/data lock：LOCK=NONE 只表示
--   能力允许时并发 DML，不代表全程无锁；必须放在维护窗口，观察 metadata lock 等待与 DML
--   冲突。任一步失败立即停止，不在 live 库盲目重试或 fix forward。
--
-- 回滚 = 恢复迁移前全库 dump（仓库无 down-migration；host/port/user/db 为部署占位符）。
-- mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p<db> > .omo/evidence/ddl-W7-20260924.sql
-- mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-W7-20260924.sql
--
-- (1) 先删依赖 fire_at 的旧复合索引；该步骤 metadata-only，并明确保留 due_at 索引。
ALTER TABLE `triggers`
  DROP INDEX `idx_timers_status_fire_at`;

-- (2) 再删历史兼容列；显式 INSTANT，且不回填、不提供 DEFAULT。
ALTER TABLE `triggers`
  DROP COLUMN `fire_at`,
  ALGORITHM=INSTANT;

-- (3) 最后收紧唯一到期时刻；Todo 39 已证明 0 个 NULL，目标 8.4.11 使用 INPLACE fallback。
ALTER TABLE `triggers`
  MODIFY COLUMN `due_at` DATETIME(3) NOT NULL,
  ALGORITHM=INPLACE,
  LOCK=NONE;
