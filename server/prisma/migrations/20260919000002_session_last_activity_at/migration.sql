-- Session.lastActivityAt 空闲判死 DB sidecar（trigger-unification todo-7，加法-only）
-- 双写：ingress touchSessionActivity + dispatcher handleSessionActivity/watchdog 起点；
-- scanIdleSessions 按 status='running' AND last_activity_at < cutoff 检出，重启后内存
-- map 为空仍可判死。存量行全 NULL（NULL 不命中 lt 比较，不误杀）；
-- 内存 pendingBySession/activeExecutions 否决保留（todo-21 前不删内存 map）。
ALTER TABLE `sessions` ADD COLUMN `last_activity_at` DATETIME(3) NULL;
CREATE INDEX `idx_sessions_status_last_activity` ON `sessions`(`status`, `last_activity_at`);
