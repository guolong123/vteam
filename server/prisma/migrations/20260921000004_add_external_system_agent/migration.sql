-- 外部绑定岗位成员的平台占位 Agent（系统行，2026-09-21，opencode-native-permissions-and-fixes）。
--
-- 背景：`team_members.agent_id` 为 NOT NULL 的 `agents.id` 外键。此前外部绑定岗位
--   （`agent_roles.default_opencode_agent_name` 非空、`default_agent_id` 为空）要求用户
--   在团队/成员创建时再显式选一个内部执行 Agent，否则 `resolveMemberBinding` 抛
--   `ROLE_DEFAULT_AGENT_MISSING`。本次移除该要求：服务端在外部绑定路径直接把成员落到本
--   迁移新建的固定占位行 `a_external`，用户只选岗位（`roleId`）即可。
--
-- 占位行定位（**只记账，不承载能力**）：
--   - `type = 'system'`：与 template/custom/clone 并列的第四类，仅平台内部使用；
--   - `agent_key` / `policy_id` 均为 NULL：`buildAgentPolicies()` 的自定义块只收
--     `agent_key IS NOT NULL AND policy_id IS NOT NULL` 的行，故天然忽略本行；
--   - 成员的平台 `vteam_*` 工具权限来自岗位（`AgentRole.policy_id`，role-owned authority），
--     与本占位行无关；
--   - `GET /agents` 列表已显式排除 `type='system'`（agents.service.findAll 默认 where），
--     不污染 Agent 管理页与岗位编辑器的内部 Agent 下拉。
--
-- 为什么不回填 `AgentRole.default_agent_id`：外部岗位的「外部槽位」语义由
--   `default_opencode_agent_name` 表达，且该列与 `default_agent_id` 互斥（service 层强制
--   `AGENT_ROLE_DEFAULT_SLOT_CONFLICT`，设置其一自动清空另一个）。写 `default_agent_id`
--   会让角色在 UI 上被误读为「内部绑定」，故保持 NULL，由 resolveMemberBinding 在解析时
--   落到 `a_external`。
--
-- 幂等 + 兼容两条初始化路径：
--   1) 全新库：`migrate deploy` 先于 seed，`users` 尚空 → 本 INSERT 的选择子查询无行 →
--      不插入（避免触碰 `created_by` 外键）；随后 seed 的 upsert 以 admin 为 created_by 建行。
--   2) 存量库：`users` 已有行 → 选一名用户（优先 admin）作为 `created_by` 落行；
--      重跑时 `NOT EXISTS` 守卫保证零变化。
--
-- ⚠️ 单向迁移：无反向 SQL。回滚 = 删除 `a_external` 前须先清理引用它的 `team_members`
--   行（FK ON DELETE RESTRICT），生产回滚请恢复迁移前全库 dump。

INSERT INTO `agents` (
  `id`, `name`, `type`, `agent_key`, `prompt`,
  `base_agent_id`, `default_model_id`, `worker_id`, `policy_id`,
  `created_by`, `created_at`, `updated_at`
)
SELECT
  'a_external',
  '外部执行',
  'system',
  NULL,
  '平台占位执行身份：外部绑定岗位成员的成员行落点（无实际执行语义，执行由该岗位绑定的外部引擎 Agent 承担）。',
  NULL, NULL, NULL, NULL,
  u.`id`, NOW(3), NOW(3)
FROM (
  SELECT `id` FROM `users`
   ORDER BY (`username` = 'admin') DESC, `created_at` ASC
   LIMIT 1
) AS u
WHERE NOT EXISTS (
  SELECT 1 FROM `agents` WHERE `id` = 'a_external'
);
