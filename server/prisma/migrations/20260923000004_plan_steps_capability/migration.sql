-- 计划执行步骤能力位（vteam_todo / plan.steps）补齐存量行（2026-09-23 设计评审后实施）。
--
-- 背景：执行步骤卡读 opencode todos 恒 0 项——平台没有注入 todo 写入工具（tools 表 0 条），
-- 且 todos 是会话级（换会话/重置即丢、跨成员不可见）。故用 `plan_tasks` 表承载结构化步骤
-- （表早已建好、0 行），新增 MCP 工具 vteam_todo（action=write/done/list）。
--
-- 新增能力点 plan.steps（defaultDeny=false、tools=['vteam_todo']），授权口径（用户决策）：
--   · 7 内置角色 = true —— 任何成员都能写/完成自己的执行步骤
--   · 外部 3 岗   = false —— 守住「最小权限不放宽」（其矩阵由 8 工具 allowlist 派生，
--     本键不在其中；但 defaultDeny=false 下**缺失键即允许**，故必须显式写 false 才能守住）
--
-- 两处补齐（与 20260923000001 同口径）：
--   agent_roles.capabilities        → JSON_SET '$."plan.steps"'（键含点，须引号路径）
--   execution_policies.config.tools → JSON_SET '$.tools.vteam_todo'（guard 白名单只列放行项）
-- 未内置/未外部的角色（如 general）按 factory：plan.steps defaultDeny=false → true。
UPDATE `agent_roles`
   SET `capabilities` = JSON_SET(`capabilities`, '$."plan.steps"', true)
 WHERE `type` = 'builtin';

UPDATE `agent_roles`
   SET `capabilities` = JSON_SET(`capabilities`, '$."plan.steps"', false)
 WHERE `key` IN ('sisyphus', 'prometheus', 'atlas');

UPDATE `agent_roles`
   SET `capabilities` = JSON_SET(`capabilities`, '$."plan.steps"', true)
 WHERE `key` = 'general';

UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.tools.vteam_todo', 'allow')
 WHERE `id` IN ('ep_product', 'ep_project_manager', 'ep_architect', 'ep_developer',
                'ep_tester', 'ep_plan', 'ep_librarian');
