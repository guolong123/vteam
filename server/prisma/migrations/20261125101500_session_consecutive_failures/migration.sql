-- 会话连续失败计数（2026-11-25）
--
-- 背景：vteam.ketaops.cc 上「一轮执行被判失败」导致下一次派发把 instanceRef 清空、
-- 新建 opencode 会话，agent 的连续上下文随之丢失（实测 s_0000000018：
-- ses_ee68b6891ffeJ9JH3zRjqxDxWZ → ses_defb66352ffe3p97sLw2qyloQa，新会话 messages=[]）。
--
-- 修复口径：失败本身不再等于「会话已坏」。命中 failed 的会话先探活
-- （GET /sessions/:id/messages）：
--   · 探活成功 → 保留 workerId/instanceRef，仅复位状态（等价「继续」）；
--   · 探活 404（opencode 会话确实没了）→ 才清绑定重建；
--   · DSH 的坏会话不体现为 404 ⇒ 以「同一 instanceRef 连续失败 N 次」兜底。
-- 本列即那个计数器（任一轮成功归零）。
--
-- 存量行零回填（DEFAULT 0）；迁移链只跑 MySQL（测试库走 db push）。

ALTER TABLE `sessions`
  ADD COLUMN `consecutive_failures` int NOT NULL DEFAULT 0;
