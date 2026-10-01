-- 长期值班任务标识（2026-10-01）
--
-- 背景：值班群这类**常驻任务**被进度巡检看门狗反复判停——「连续 3 轮（约 30 分钟）无任何
-- 进展，自动置阻塞」。但对常驻任务，「无进展」不是异常而是**正常稳态**：它按定义就在等人
-- 提问，白天无人说话恰恰说明它健康。`quietStreak` 衡量的是「主会话近 10 分钟有没有说话」，
-- 而值班任务的正确状态就是没人说话——信号选错了，不是阈值不对。
--
-- 为什么是「加一列」而不是调阈值：巡检的存在目的是把任务推向终态，而常驻任务**没有终态**。
-- 拉长间隔 / 抬高 STALL_QUIET_STREAK_LIMIT 都只是把误判变稀薄，噪音与成本仍在；
-- 心跳式巡检更糟——`buildProgressionPrompt` 明确引导 Agent「若全部工作完成，调用
-- task_transition mark-pending-review 提交验收」，每轮叫醒等于每轮递一次自杀指令。
-- 故按任务类型分流：常驻任务不排期、不唤醒、不自动置阻塞（服务层执行点，见
-- `server/src/tasks/task-progression.scheduler.ts`），人工完成通道与硬删另行放行。
--
-- 1) 新增 `long_running`：是否长期值班任务。**存量行一律 false**——列的语义是
--    「这个任务常驻」，无法从 `status`/`title`/`priority` 推断，且错标 true 会永久关掉
--    真任务的停滞保护、且不可逆。故零回填，由运维对具体任务显式设置（见 runbook）。
-- 2) 列型 `tinyint(1) NOT NULL DEFAULT false`：照既有 boolean 列（`reset_after_complete`）
--    的写法；`DEFAULT false` 保证存量行零成本成为「非长期任务」这一安全默认。
-- 3) **不建索引**：唯一读取路径是「按主键取单个任务时顺带读出该列」
--    （`prisma.task.findUnique({ where: { id }, select: { longRunning: true } })`），
--    主键已覆盖，无独立查询路径。
-- 4) **不删任何东西**：本仓库无 down-migration 约定（`docs/tech-debt-rollback.md`），
--    删列不可逆。

ALTER TABLE `tasks`
  ADD COLUMN `long_running` tinyint(1) NOT NULL DEFAULT false;
