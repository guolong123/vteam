-- 清除已下线 `vteam_plan_mode` 开关在**持久化数据**中的残留（contract 阶段，单向不可逆）。
--
-- 背景（为什么还有残留）：20260921000001 已 drop `tasks.plan_mode` 列，代码侧也已删除
--   `vteam_plan_mode` MCP 工具的注册与 `VTEAM_MCP_TOOL_NAMES`/seed 项（server 侧零引用）。
--   但工具注册表 `tools` 表与执行策略 `execution_policies.config`（JSON）是**数据行**，
--   不由列删除/代码删除覆盖，故仍留存：
--     1) `tools` 表：`name='vteam_plan_mode'` 的注册行（source='mcp'）。
--     2) `execution_policies.config`：两个 section 各持有该键——
--        - `$.tools.vteam_plan_mode`（值为 "allow"），命中 ep_product / ep_project_manager；
--        - `$.permission.vteam_plan_mode`（值为 "deny"），命中 ep_architect / ep_developer /
--          ep_librarian / ep_plan / ep_tester。
--        （8 行策略中 7 行命中；live `GET /api/v1/agent-policies` 因此仍回显 5 处
--          `permission` 投影的 `vteam_plan_mode`。）
--
-- 与「活计划域」的关系：`plans` 表 / `PlanTask` / `PlanLifecycleService` / plan-docs /
--   计划评审轮次 / `vteam_plan_complete` 是独立且**仍在用**的计划域，均不读上述残留，
--   本迁移只清 `vteam_plan_mode` 这一个已删除开关的注册与权限键，对活计划域零影响。
--
-- ⚠️ 单向迁移：DELETE 无反向 SQL，JSON_REMOVE 亦不可逆，回滚 = 恢复迁移前全库 dump。
--   可重入性由 Prisma 迁移账本保证（已应用则不再执行）；文件内两条 UPDATE 本身可安全重跑。
--
-- ⚠️ MySQL JSON_REMOVE 陷阱：当路径不存在时 JSON_REMOVE 返回 NULL，直接写回会把整列
--   `config` 置空（数据损毁）。故每条 UPDATE 都以 JSON_CONTAINS_PATH(...) 为守卫，
--   仅当该键确实存在时才修剪——不存在则整行不匹配、零写入。

-- 1) 删除已下线的 MCP 工具注册行。
DELETE FROM `tools` WHERE `name` = 'vteam_plan_mode';

-- 2) 修剪 `$.tools.vteam_plan_mode`（守卫：仅命中含该键的行）。
UPDATE `execution_policies`
   SET `config` = JSON_REMOVE(`config`, '$.tools.vteam_plan_mode')
 WHERE JSON_CONTAINS_PATH(`config`, 'one', '$.tools.vteam_plan_mode');

-- 3) 修剪 `$.permission.vteam_plan_mode`（守卫：仅命中含该键的行）。
UPDATE `execution_policies`
   SET `config` = JSON_REMOVE(`config`, '$.permission.vteam_plan_mode')
 WHERE JSON_CONTAINS_PATH(`config`, 'one', '$.permission.vteam_plan_mode');
