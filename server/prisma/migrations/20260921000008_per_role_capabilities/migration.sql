-- 内置岗位能力矩阵按角色定制（2026-09-22 用户决策：「项目经理默认所有 vteam 权限开放，
-- 其他角色也需要按照角色需要针对性开放，并内置为 seed」）。
--
-- 背景：20260921000007 曾把 7 个内置岗位**拉平到出厂默认**；本迁移替换为**按角色定制矩阵**
--   （单一事实来源 = `src/common/constants/agent-role.constants.ts` 的
--   `BUILTIN_ROLE_CAPABILITY_MAPS`，逐键相等由契约 spec
--   `src/prisma/agent-role-capabilities-per-role.migration.spec.ts` 锁定，防 SQL↔TS 漂移；
--   全新库同批矩阵由 seed 的 create/NULL 补齐分支落库，同一契约 spec 断言相等）。
--
-- 派生规则（只收窄、绝不放大授权）：
--   1) `project_manager` = **全 21 点 true**（显式覆盖，不按 ROLE_BOUNDARIES 派生）；
--   2) 其余 6 内置岗 = `ROLE_BOUNDARIES['vteam-<key>'].toolAllows` 全组放行才 true
--      （能力点的全部成员工具均放行才授予；成员工具仅部分放行时该能力点记 false——
--       即「组塌缩」，如 architect/tester 的 issue.manage、plan/librarian 的 memory.manage）。
--
-- 范围与不变量（幂等：整列常量覆盖，重跑零变化）：
--   1) 仅覆盖 type='builtin' 且 key ∈ 7 个内置岗位的单行。**外部 3 岗
--      （sisyphus/prometheus/atlas）的 8 工具最小矩阵不触碰**——第三方执行器最小权限为
--      有意设计（守卫 key 单值相等，外部岗 key 不在集合内不可能命中）；`ar_general` 保持
--      出厂矩阵（key='general' 不在集合内）。
--   2) MySQL JSON 陷阱：JSON_SET/JSON_REMOVE 对**不存在的路径**返回 NULL（会把整列置 NULL）。
--      本迁移**不使用**任何 JSON 路径增改函数（故 JSON_CONTAINS_PATH 守卫不适用）——直接
--      整列 CAST('<21 键字面量>' AS JSON) 覆盖，写入值恒非 NULL；WHERE 子句即范围守卫，
--      对当前值为 NULL 的内置行同样覆盖 ⇒ 迁移后 7 内置行 capabilities 必非 NULL
--      （scratch 证明跑 SELECT COUNT(*) WHERE capabilities IS NULL = 0 断言全表无 NULL）。
--   3) 不读 execution_policies / policy_id，纯常量覆盖。
--
-- 有意变更（需 review 的授权翻转，逐岗差集见 notepad learnings 本 slice 条目）：
--   相对 000007 出厂矩阵：project_manager 放开全部 21 点（含出厂拒绝的 10 个敏感点 +
--   doc.submit/git.repos）；其余 6 岗按各自 ROLE_BOUNDARIES 收窄/放宽（如 product 放开
--   task.create 等边界内工具、librarian 收窄 chat.notify 等）。
--
-- ⚠️ 单向迁移：无反向 SQL，回滚 = 恢复迁移前全库 dump。
-- ⚠️ MySQL JSON 路径键含点号须写 $."task.create"（本迁移不用路径函数，仅沿用邻近迁移注释提醒）。

-- ---------------------------------------------------------------------------
-- 1) 7 个内置岗位 → 按角色定制矩阵（21 键字面量；整列覆盖，恒非 NULL；范围守卫 =
--    type='builtin' AND key = 单个内置 key，外部岗 / ar_general 不在集合内）。
--    常量右值、不引用列自身 ⇒ 幂等（重跑零变化）。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":false,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'product';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":true,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":true,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":true}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'project_manager';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'architect';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'developer';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'tester';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":true,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'plan';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":false,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":false,"file.read":true,"issue.manage":false,"memory.manage":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'librarian';
