-- 计划签署工具（plan_finalize / plan_confirm）补齐到岗位策略行（2026-09-23）。
--
-- 背景：新增两个 MCP 工具（托管模式下由主 Agent 代用户签署计划），并入既有能力点
-- task.complete——能力点键集与 true/false 值均不变，故 agent_roles 无需改动；
-- 但 execution_policies 是**运行时来源**（页面可编辑），seed 为 create-if-absent
-- （update:{}），已应用库必须由本迁移补齐，否则：
--   - ep_plan / ep_project_manager 的 config.tools 缺这两个工具 → worker guard 白名单
--     不放行，主 Agent 即使满足托管模式门禁也调不动；
--   - 其余角色的 config.permission 缺 deny 键 → 与常量派生发射不一致（功能上仍 deny，
--     因白名单未列即 deny；此处仅补齐口径）。
--
-- 字段约定（与 20260923000001 同口径）：
--   config.tools      —— 只列**放行**（值为 'allow'）→ JSON_SET 增该键；
--   config.permission —— 只列**拒绝**（值为 'deny'），放行的**不出现** → 放行角色 JSON_REMOVE。
UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.tools.vteam_plan_finalize', 'allow')
 WHERE `id` IN ('ep_plan', 'ep_project_manager');

UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.tools.vteam_plan_confirm', 'allow')
 WHERE `id` IN ('ep_plan', 'ep_project_manager');

UPDATE `execution_policies`
   SET `config` = JSON_REMOVE(`config`, '$.permission.vteam_plan_finalize')
 WHERE `id` IN ('ep_plan', 'ep_project_manager');

UPDATE `execution_policies`
   SET `config` = JSON_REMOVE(`config`, '$.permission.vteam_plan_confirm')
 WHERE `id` IN ('ep_plan', 'ep_project_manager');

UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.permission.vteam_plan_finalize', 'deny')
 WHERE `id` IN ('ep_product', 'ep_architect', 'ep_developer', 'ep_tester', 'ep_librarian');

UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.permission.vteam_plan_confirm', 'deny')
 WHERE `id` IN ('ep_product', 'ep_architect', 'ep_developer', 'ep_tester', 'ep_librarian');
