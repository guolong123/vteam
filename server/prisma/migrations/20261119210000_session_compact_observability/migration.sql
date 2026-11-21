-- 会话压缩可观测列（2026-11-19）
--
-- 背景：会话长期不活跃 → 下一次发消息前主动压缩（见
-- docs/agent-platform/context-compaction-idle.md）。worker 完成压缩后
-- 经 session.compact 事件回流，把「压缩时刻 + 前后 token」写回 Session，
-- 供审计/排查与前端展示。纯观测字段，不参与空闲判死与调度。
--
-- 三列全部 nullable，存量行零回填；迁移链只跑 MySQL（测试库走 db push）。

ALTER TABLE `sessions`
  ADD COLUMN `compacted_at` datetime(3) DEFAULT NULL,
  ADD COLUMN `compact_token_before` int DEFAULT NULL,
  ADD COLUMN `compact_token_after` int DEFAULT NULL;
