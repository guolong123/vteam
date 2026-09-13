-- 添加 tasks.plan_mode（计划模式开关，默认 false=直接执行）
--
-- 语义：true=主 Agent 先出计划文档（submit_artifact type:'plan'），其他成员只评审不起草；
-- false=全员默认 build 直接开干。开启路径：用户在会话输入框切计划开关 / 主 Agent 调
-- plan_mode MCP 工具。与已废弃的 execution_mode 列正交（该列恒写 'direct'）。
-- 带 DEFAULT false → 存量行自动 false，行为与迁移前一致。
ALTER TABLE `tasks` ADD COLUMN `plan_mode` BOOLEAN NOT NULL DEFAULT false;
