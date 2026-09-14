-- 为自定义 Agent 对接 opencode 新增 machine-safe 标识列（vteam-custom-agent-opencode Todo 1）。
--
-- 背景：自定义/克隆 Agent 将成为一等 opencode agent（opencode agent 名 = `vteam-<agentKey>`）；
-- 模板 `agentKey = role`（注入名与现状逐字节一致，如 `vteam-product`）。
-- 本迁移只加列、不改存量语义：
--   1. ALTER TABLE `agents` ADD COLUMN `agent_key` VARCHAR(63) NULL（可空：存量自定义/克隆行
--      无 key 仍合法，“必填”由 service 层强制，不在 DB 设 NOT NULL）；
--   2. 唯一索引 `uk_agents_agent_key`（NULL 互不冲突，MySQL 语义）；
--   3. 回填模板行：`agent_key = role`（仅 type='template' 且 role 非空且尚未设置者）。
ALTER TABLE `agents` ADD COLUMN `agent_key` VARCHAR(63) NULL;
CREATE UNIQUE INDEX `uk_agents_agent_key` ON `agents` (`agent_key`);
UPDATE `agents` SET `agent_key` = `role` WHERE `type` = 'template' AND `role` IS NOT NULL AND `agent_key` IS NULL;
