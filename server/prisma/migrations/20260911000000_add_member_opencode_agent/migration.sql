-- 添加 team_members.opencode_agent_name（opencode 原生 agent 名，null=不指定用 serve 默认 agent）
--
-- 语义：非 null 时 dispatch 下发 prompt_async 的 agent 字段，由 opencode 内核按该 agent 的
-- prompt/permission 执行（vteam 只做传递，不自造 agent 语义）。
-- 可空列 → 存量行 NULL，行为与迁移前逐字节一致（不带 agent 字段）。
ALTER TABLE `team_members` ADD COLUMN `opencode_agent_name` VARCHAR(191) NULL;
