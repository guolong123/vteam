-- 内置岗位能力矩阵拉平到「出厂默认」（2026-09-21 用户决策：「内置角色拉平到出厂默认」= 是）。
--
-- 背景：20260921000006 首次引入 capabilities 时，为避免 default-allow 默认翻转带来新授权，
--   7 个内置岗位按「当前生效工具集 / 常量回退」保守派生（能力点全组工具放行才授予）。
--   经用户决策，现将内置岗位**统一覆盖为出厂矩阵**：目录 defaultDeny 的 10 个敏感能力点为
--   false，其余 11 个为 true（21 键全量落库，可审计形状；缺失键 ⇒ 允许语义不变）。
--
-- 范围与不变量（幂等：整列常量覆盖，重跑零变化）：
--   1) 仅覆盖 type='builtin' 且 key ∈ 7 个内置岗位。**外部 3 岗（sisyphus/prometheus/atlas）
--      的 8 工具最小矩阵不触碰**——第三方执行器最小权限为有意设计；ar_general 及其余角色
--      已在 000006 写出厂矩阵，本迁移同样不触碰。
--   2) MySQL JSON 陷阱：JSON_SET/JSON_REMOVE 对**不存在的路径**返回 NULL（会把整列置 NULL）。
--      本迁移**不使用**任何 JSON 路径增改函数（故 JSON_CONTAINS_PATH 守卫不适用）——直接
--      整列 CAST('<21 键字面量>' AS JSON) 覆盖，写入值恒非 NULL；WHERE 子句即范围守卫，
--      对当前值为 NULL 的内置行同样覆盖 ⇒ 迁移后 7 内置行 capabilities 必非 NULL
--      （scratch 证明跑 SELECT COUNT(*) WHERE capabilities IS NULL = 0 断言全表无 NULL）。
--   3) 不读 execution_policies / policy_id（000006 已删该间接层），纯常量覆盖。
--
-- 有意变更（需 review 的授权翻转，逐岗差集见 notepad learnings 本 slice 条目）：
--   与 000006 保守派生相比，拉平同时产生 deny→allow 的**扩大**（如各内置岗 git.repos、
--   plan/librarian 的 memory.manage、librarian 的 chat.notify 等）与 allow→deny 的**收窄**
--   （如 product/project_manager 的 task.create 等敏感点回归出厂拒绝）。
--
-- ⚠️ 单向迁移：无反向 SQL，回滚 = 恢复迁移前全库 dump。
-- ⚠️ MySQL JSON 路径键含点号须写 $."task.create"（本迁移不用路径函数，仅沿用 000006 注释提醒）。

-- ---------------------------------------------------------------------------
-- 1) 7 个内置岗位 → 出厂矩阵（21 键字面量；整列覆盖，恒非 NULL；范围守卫 =
--    type='builtin' AND key IN（7 内置 key），外部岗 / ar_general 不在集合内）。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"plan.steps":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` IN ('product', 'project_manager', 'architect', 'developer', 'tester', 'plan', 'librarian');
