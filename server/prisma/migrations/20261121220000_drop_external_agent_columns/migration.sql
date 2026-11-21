-- 移除「外部 agent」功能遗留的两列（OmO / opencode 原生 agent 绑定已下线）。
--
-- 背景：该功能让角色/成员直接绑定 opencode 引擎的 agent 名（如 `Prometheus - Plan Builder`），
-- 由平台透传给 prompt_async 的 `agent` 字段执行。实际部署中该路径从未被使用
-- （生产库两列非空计数均为 0），且它把「引擎内部命名」泄露成平台数据模型的一部分：
-- 引擎的 agent 名一旦变化会静默改变派发行为。执行身份统一由平台 Agent + 岗位权限承载。
--
-- 兼容性：两列均可空、无任何索引或约束引用，DROP 对存量数据无损。
-- 回滚：如需恢复，重新建列即可（历史值不可恢复，语义上也不再被读写）。

ALTER TABLE `agent_roles` DROP COLUMN `default_opencode_agent_name`;

ALTER TABLE `team_members` DROP COLUMN `opencode_agent_name`;
