-- 绑定服务端平台工具授权到「岗位」而非「执行 Agent」（role-owned authority，2026-09-21）。
--
-- 背景（为什么需要新列）：服务端 `vteam_*` 工具门（platform-tool-permission.service
--   `assertToolAllowed`）原按 `TeamMember.agentId → Agent.policyId` 解析权限矩阵；本次
--   改按 `TeamMember.roleId → AgentRole.policyId`。授权属于岗位（post），不随该岗位当前
--   选用的执行 Agent 改变。为此 `agent_roles` 新增可空列 `policy_id`（无 FK，与
--   `Agent.policy_id` 同风格）并回填。
--
-- 回填策略（确定性 + 幂等，全部带 `policy_id IS NULL` 守卫）：
--   1) 外部引擎岗位（key ∈ sisyphus/prometheus/atlas）绑定到本迁移新建的**最小权限策略**
--      `ep_external`（仅 8 个协作/取证/产出工具 allow，其余未列入即 deny）——先于通用 JOIN，
--      保证不落入后面按 key 的继承路径；
--   2) 7 个内置角色：从 `default_agent_id` 指向的模板 Agent 继承其 `policy_id`（等价 `ep_<key>`）；
--   3) 兜底第二 JOIN：`agents.agent_key = agent_roles.key`（部分库 default_agent_id 为空时仍能解析）。
--   回填后内置角色的 policy_id 等于该岗位成员当前 Agent 的 policy_id ⇒ **存量成员门禁结果不变**。
--   外部岗位此前按其执行 Agent 的策略裁决，现统一收敛到最小权限 allowlist（有意变更）。
--   `ar_general`（无默认 Agent、无匹配 key）保持 NULL ⇒ 工具门 fail-closed 403（有意变更：
--   通用/自定义岗位须显式绑定策略才有平台工具权限）。
--
-- ⚠️ `Agent.policy_id` **不删**：仍喂 worker injector（buildAgentPolicies）/ 原生 layer①
--   permission / resolveTemplateSource / toAgentDto / myProfile / agents CRUD / seed，
--   只是不再是本服务端门禁的权威来源。
--
-- ⚠️ 单向迁移：无反向 SQL，回滚 = 恢复迁移前全库 dump。
--   可重入性：DDL 由 Prisma 迁移账本保证只执行一次；三条 UPDATE 均带 NULL 守卫，
--   手工重跑零变化（重复执行不改变任何非 NULL 绑定）。

-- 1) 新增列 + 索引。
ALTER TABLE `agent_roles` ADD COLUMN `policy_id` VARCHAR(191) NULL;
CREATE INDEX `idx_agent_roles_policy` ON `agent_roles`(`policy_id`);

-- 2) 新建外部岗位最小权限策略（幂等：不存在才插入）。
--    config 形状与 seed 的 `EXTERNAL_AGENT_ROLE_*` 逐字节一致：permission/correction 为
--    对象（解析路径要求），tools 即服务端门读取的 8 项 allowlist。
INSERT INTO `execution_policies` (`id`, `name`, `description`, `type`, `config`, `updated_at`)
SELECT
  'ep_external',
  '外部引擎岗位（最小权限）',
  '外部引擎岗位专用策略：仅放行协作/取证/产出所需的平台工具。',
  'template',
  JSON_OBJECT(
    'permission', JSON_OBJECT(
      'edit', JSON_OBJECT('*', 'deny'),
      'read', JSON_OBJECT('*', 'allow'),
      'bash', 'deny'
    ),
    'correction', JSON_OBJECT(
      'scopeSummary', '外部引擎岗位：只协作、取证与产出，不做平台治理动作（建任务/加成员/流转/建技能/确认提问/外发）。'
    ),
    'tools', JSON_OBJECT(
      'vteam_group_post', 'allow',
      'vteam_chat_history', 'allow',
      'vteam_doclib', 'allow',
      'vteam_submit_artifact', 'allow',
      'vteam_notify_agent', 'allow',
      'vteam_task_context', 'allow',
      'vteam_my_profile', 'allow',
      'vteam_team_view', 'allow'
    )
  ),
  NOW(3)
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `execution_policies` WHERE `id` = 'ep_external'
);

-- 3) 外部引擎岗位绑定到 ep_external（仅 NULL 行；先于通用 JOIN）。
UPDATE `agent_roles`
   SET `policy_id` = 'ep_external'
 WHERE `policy_id` IS NULL
   AND `key` IN ('sisyphus', 'prometheus', 'atlas');

-- 4) 内置角色继承默认 Agent 的策略（default_agent_id 路径）。
UPDATE `agent_roles` AS `r`
  INNER JOIN `agents` AS `a` ON `a`.`id` = `r`.`default_agent_id`
   SET `r`.`policy_id` = `a`.`policy_id`
 WHERE `r`.`policy_id` IS NULL
   AND `a`.`policy_id` IS NOT NULL;

-- 5) 兜底：按 key = agent_key 继承（default_agent_id 为空的部分库路径）。
UPDATE `agent_roles` AS `r`
  INNER JOIN `agents` AS `a` ON `a`.`agent_key` = `r`.`key`
   SET `r`.`policy_id` = `a`.`policy_id`
 WHERE `r`.`policy_id` IS NULL
   AND `a`.`policy_id` IS NOT NULL;
