-- 角色级记忆 + 自动注入开关（2026-09-30）
--
-- 1) 新增 `auto_inject`：是否参与每轮自动注入。**存量行一律回填 false**——
--    新语义是「建记忆时由 agent 自行决定」，存量 35 条 team 级记忆是在该开关存在
--    之前写入的，意图未知，不应被追认为「要自动注入」。回填 false 时它们仍可通过
--    memory_search 按需检索，只是不进 prompt；运维可在记忆页逐条打开。
-- 2) 新增 `role_id`：角色级记忆归属岗位（ar_ 前缀 → AgentRole.id）。存量行为 NULL。
-- 3) 新增复合索引 idx_memories_inject，支撑注入查询
--    （autoInject=true + teamId 定位 team/role 级，roleId 定位岗位）。
--
-- 不动 task_id / idx_memories_task_time：task 级记忆虽已废弃（服务层 400 拒收、
--    线上 0 行），但删列是不可逆 DDL，若其他环境残留 task 级数据会直接丢失。
--    保留死列零成本，清理留待独立决策。

ALTER TABLE `memories`
  ADD COLUMN `auto_inject` tinyint(1) NOT NULL DEFAULT false,
  ADD COLUMN `role_id` varchar(191) DEFAULT NULL;

CREATE INDEX `idx_memories_inject`
  ON `memories` (`auto_inject`, `team_id`, `role_id`);
