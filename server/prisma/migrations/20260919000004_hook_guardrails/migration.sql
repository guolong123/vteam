-- Hook anti-runaway guardrails（trigger-unification todo-19，加法-only）
-- 用途：给 todo-19 的 6 道 guardrail 落库支撑，无一列删除/改名：
-- 1) `busy_retries`：busy 否决/分派失败重试计数（fire 路径每次否决 +1，
--    满 HOOK_BUSY_MAX_RETRIES（10）次改判 expired；mind：trigger 表的
--    busy_retries 是 claim 争用计数，语义不同，不复用）。
-- 2) `(root_task_id, status)` 索引：per-task wake 预算与血缘链查询走此列，
--    无索引会全表扫（hooks 表随 agent 自助注册增长）。
-- 永不 DELETE hook 行（cycle 检测链不断，见 expireTaskHooks 只标不删）。
ALTER TABLE `hooks` ADD COLUMN `busy_retries` INTEGER NOT NULL DEFAULT 0;
CREATE INDEX `idx_hooks_root_task_status` ON `hooks`(`root_task_id`, `status`);
