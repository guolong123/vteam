-- 移除已退役的 per-agent 权限机制（Lane S：agent tool-permission align）。
--
-- 背景：agent_tool_effects 表 0 行、无有效运行时消费；权限唯一事实来源为
-- ExecutionPolicy（agent.policyId 绑定 + ExecutionPolicyService.resolveByAgent 解析）。
-- 本迁移直接删除表与列，不做数据迁移、不留兼容：
--   1. DROP TABLE `agent_tool_effects`（含 uk_agent_tool_effects 唯一键与外键约束随表删除）；
--   2. ALTER TABLE `agents` DROP COLUMN `permission_scope`。
DROP TABLE `agent_tool_effects`;
ALTER TABLE `agents` DROP COLUMN `permission_scope`;
