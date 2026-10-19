-- 并行任务退役 FIFO 队列（parallel-tasks 计划 §4.1，2026-10-19）
--
-- 背景：团队任务执行从「单槽 FIFO 串行」（teams.current_task_id + team_queues 排队）
-- 改为并行执行：同一团队允许多个任务同时 in_progress，并发上限由
-- `teams.max_concurrent_tasks`（NULL = 不限）在 start 前置校验。旧串行链路的三件事实
-- —— queued 状态、team_queues 行、teams.current_task_id 调度语义——在此迁移里收敛：
--
--   1) 存量 queued → pending：创建/转移路径不再写 queued（D2），queued 只保留为
--      历史读取兼容的字面值；迁移后 pending 即「待开始」的等待态。
--   2) team_queues 数据清空但**表保留**（D3）：schema.prisma 的 TeamQueue model 与
--      teams/tasks 关系字段保留，管理与既有库结构一致；代码路径已全部摘除。
--      队列位置只存在于 team_queues.position；tasks 表没有 queue_position 列
--      （baseline 从未建过该列），故无需也无法对其 UPDATE——真库执行
--      `UPDATE tasks SET queue_position` 会因列不存在而 1054，该语句不写。
--   4) teams.current_task_id 不动（D4）：调度语义退役，列保留为「最后交互任务指针」。
--   5) teams 新增 max_concurrent_tasks INT NULL：可空而非 NOT NULL——NULL = 不限，
--      存量团队一行都不该被追认成任何上限，NOT NULL 会逼出一次假回填（与
--      20260925000000 对 preferred_worker_id 的口径一致）。
--
-- 迁移语句顺序：先清态（queued → pending）再清表数据，最后加列；
-- UPDATE/DELETE 为幂等安全的数据操作（失败重跑无副作用），ALTER 加可空列为一次性 DDL。
--
-- 单向 DDL 回滚契约（沿用 20261014000000 的写法）：本迁移含 DELETE FROM team_queues，
-- 无法仅靠代码回退恢复排队数据。回滚 = 两步，顺序不可颠倒：
--     1) 代码：`git reset --hard <last-green>`（回到迁移前的绿色提交）
--     2) 数据：恢复**迁移前**的全库 dump
-- 本机/CI 无 MySQL（见 jest.config.js 无 globalSetup），DDL 由部署方在目标环境执行。

UPDATE `tasks` SET `status` = 'pending' WHERE `status` = 'queued';
DELETE FROM `team_queues`;
ALTER TABLE `teams` ADD COLUMN `max_concurrent_tasks` int NULL;
