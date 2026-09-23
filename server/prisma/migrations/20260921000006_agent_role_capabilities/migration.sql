-- 岗位平台工具权威从「ExecutionPolicy 绑定（policy_id）」改为「业务能力点矩阵（capabilities）」
-- （2026-09-21 role-owned capability model）。
--
-- 背景：`vteam`/`vteam-api` MCP server 与第三方 MCP 同层，不做工具清单过滤；服务端只在
--   `tools/call` 时按**岗位**判定：工具裸名 → 业务能力点（platform-capability.constants.ts
--   目录，21 项覆盖 28 个 vteam_* 工具）→ `AgentRole.capabilities[key] === false` 则拒绝，
--   缺失键则允许（default-allow）。Q1 = 默认放行 + 出厂敏感能力点预置拒绝。
--
-- 本迁移做四件事（全部幂等；逐段 NULL 守卫，重跑零变化）：
--   1) 新增 `agent_roles.capabilities` JSON 列；
--   2) 按**当前生效工具集**回填内置角色能力矩阵——优先读其 `policy_id` 指向策略的
--      `config.tools`（现网可能被管理员编辑过），缺失时回退 ROLE_BOUNDARIES 常量口径。
--      判据：能力点的全部成员工具均放行 ⇒ true，否则 false（保守方向，绝不放大授权）。
--   3) 3 个外部岗位（sisyphus/prometheus/atlas）写入原 `ep_external` 等价矩阵
--      （8 个协作/取证/产出工具对应的能力点 true，其余 13 项显式 false）；
--      其余角色（ar_general 及任意历史行）写出厂矩阵（defaultDeny ⇒ false，其余 true）。
--      最后一条全表兜底 UPDATE 保证**无 NULL capabilities**（`null` 等同 `{}` 全放行，
--      故出厂行必须显式落矩阵）。
--   4) 删除 `agent_roles.policy_id`（+ 索引 `idx_agent_roles_policy`）与 `ep_external` 策略行
--      （DELETE 带 NOT EXISTS 守卫：若仍有 `agents.policy_id` 引用则保留，避免误删）。
--
-- 有意**不**清理 `execution_policies.config.tools` 里的 vteam_* 键：该字段仍服务
--   GET /agents 的 Agent 自身视图（引擎原生层）与 worker injector 的 guard 数据，
--   属引擎原生关注点，不在本次「岗位能力点」改造范围（brief item 8：不干净则留下并报告）。
--
-- ⚠️ 单向迁移：无反向 SQL，回滚 = 恢复迁移前全库 dump。
-- ⚠️ MySQL JSON 陷阱：JSON_OBJECT 对 NULL 值会落 JSON null（非 boolean），故每个能力点
--   表达式均用 IF(...) 显式产出 JSON true/false；不写任何可能把列置 NULL 的 JSON_REMOVE/SET。

-- ---------------------------------------------------------------------------
-- 1) 新增 capabilities 列（可空；回填后由兜底 UPDATE 保证非 NULL）。
-- ---------------------------------------------------------------------------
ALTER TABLE `agent_roles` ADD COLUMN `capabilities` JSON NULL;

-- ---------------------------------------------------------------------------
-- 2) 内置角色：从当前生效工具集派生能力矩阵。
--    临时表先物化「角色 → 现网 config.tools」，避免 UPDATE 目标表自引用（MySQL 1093）。
-- ---------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS `tmp_agent_role_tools`;
-- 列 collation 必须与 `agent_roles.id`（utf8mb4_unicode_ci）一致，否则 JOIN 报
-- "Illegal mix of collations"。
CREATE TEMPORARY TABLE `tmp_agent_role_tools` (
  `role_id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `tools_json` JSON NULL,
  PRIMARY KEY (`role_id`)
);
INSERT INTO `tmp_agent_role_tools` (`role_id`, `tools_json`)
SELECT `r`.`id`, `p`.`config` -> '$.tools'
  FROM `agent_roles` AS `r`
  INNER JOIN `execution_policies` AS `p` ON `p`.`id` = `r`.`policy_id`
 WHERE `r`.`type` = 'builtin'
   AND JSON_TYPE(`p`.`config` -> '$.tools') = 'OBJECT';

UPDATE `agent_roles` AS `r`
INNER JOIN `tmp_agent_role_tools` AS `t` ON `t`.`role_id` = `r`.`id`
SET `r`.`capabilities` = JSON_OBJECT(
  'task.create',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_task_create')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'task.transition',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_task_transition')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'task.complete',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_plan_complete')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'task.context',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_task_context')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'team.view',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_team_view')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'team.add_member',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_team_add_member')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'chat.post',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_group_post')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'chat.read',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_chat_history')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'chat.notify',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_notify_agent')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'chat.channel_send',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_channel_send')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'wecom.reply',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_wecom_reply')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'doc.read',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_doclib')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'doc.submit',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_submit_artifact')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'file.read',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_read_file')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'issue.manage',
    IF(
      JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_issue_create')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_issue_get')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_issue_list')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_issue_update')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_issue_transition')) IN ('allow', 'ask'),
      CAST('true' AS JSON), CAST('false' AS JSON)),
  'memory.manage',
    IF(
      JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_memory_save')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_memory_search')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_memory_update')) IN ('allow', 'ask'),
      CAST('true' AS JSON), CAST('false' AS JSON)),
  'skill.create',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_skill_create')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'question.confirm',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_question_confirm')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'my_profile',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_my_profile')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON)),
  'hook.manage',
    IF(
      JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_hook_register')) IN ('allow', 'ask')
      AND JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_hook_cancel')) IN ('allow', 'ask'),
      CAST('true' AS JSON), CAST('false' AS JSON)),
  'git.repos',
    IF(JSON_UNQUOTE(JSON_EXTRACT(`t`.`tools_json`, '$.vteam_git_repos_list')) IN ('allow', 'ask'), CAST('true' AS JSON), CAST('false' AS JSON))
)
WHERE `r`.`capabilities` IS NULL;

DROP TEMPORARY TABLE IF EXISTS `tmp_agent_role_tools`;

-- 2b) 无策略行/无 config.tools 的内置角色回退常量口径矩阵（与 2 的判据一致）。
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":false,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'product';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":true,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":false,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":true,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'project_manager';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'architect';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":true,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'developer';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'tester';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'plan';
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":false,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":false,"file.read":true,"issue.manage":false,"memory.manage":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON) WHERE `type` = 'builtin' AND `capabilities` IS NULL AND `key` = 'librarian';

-- ---------------------------------------------------------------------------
-- 3) 外部岗位：原 ep_external 等价的最小能力矩阵（8 协作/取证/产出能力点 true，其余显式 false）。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":false,"issue.manage":false,"memory.manage":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON) WHERE `capabilities` IS NULL AND `key` IN ('sisyphus', 'prometheus', 'atlas');

-- 3b) 其余角色（ar_general 及任意历史行）落出厂矩阵；此语句同时**兜底保证无 NULL**。
UPDATE `agent_roles` SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":true,"issue.manage":false,"memory.manage":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON) WHERE `capabilities` IS NULL;

-- ---------------------------------------------------------------------------
-- 4) 删除 policy 间接层：先删索引与列，再删 ep_external（带引用守卫）。
-- ---------------------------------------------------------------------------
DROP INDEX `idx_agent_roles_policy` ON `agent_roles`;
ALTER TABLE `agent_roles` DROP COLUMN `policy_id`;

-- ep_external 引用计数（回滚前审计）：agent_roles 列已删故无引用；仅当无 agents.policy_id
-- 指向它时才删除（存量 a_external 的 policy_id 为 NULL，故正常删除）。
DELETE FROM `execution_policies`
 WHERE `id` = 'ep_external'
   AND NOT EXISTS (SELECT 1 FROM `agents` WHERE `policy_id` = 'ep_external');
