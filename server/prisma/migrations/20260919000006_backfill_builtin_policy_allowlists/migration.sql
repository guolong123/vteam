-- 内置 ExecutionPolicy 行回填（server-gate-removal-tool-authority todo 5，data-only）
--
-- 背景：resolveGuardTools（src/execution-policies/execution-policy.service.ts）规定
-- config.tools 含 >=1 条合法项时胜出常量回退；resolveBuiltinPolicy / guardForAgent 亦在
-- config.permission 为 plain object 时直接读取该行。故常量翻转（defineBoundary 去掉
-- SERVER_GATED_SET 例外 + 逐角色 toolAllows 授权）不会到达运行时，除非本迁移把已存在的
-- 内置 ep_<role> 行改写到与常量逐字段一致。
--
-- 回填谓词（exact）：对 7 个内置 id（ep_product / ep_project_manager / ep_architect /
-- ep_developer / ep_tester / ep_plan / ep_librarian）逐行：
--   WHERE id = '<id>'
--     AND ( NOT (JSON_EXTRACT(config,'$.tools')      <=> <target tools>)
--        OR NOT (JSON_EXTRACT(config,'$.permission') <=> <target permission>) )
-- 目标值 = ROLE_BOUNDARIES[role].toolAllows / buildRolePermission(role) 的 canonical JSON
-- （由常量生成，随常量翻转一次性固化）。
--
-- 幂等：MySQL <=> 对 JSON 按语义比较、键序无关，仅当任一侧与目标不等才 UPDATE；
-- 重跑时谓词为假 -> 0 行受影响、updated_at 不变。JSON_SET 只写 $.tools/$.permission，
-- 保留 correction/description 等其余字段；不 DELETE/INSERT 行；仅命中 7 个内置 id，
-- 不触碰用户自定义行（如 ep_0000000001）。
--
-- 适用时机：生产存量库（seed 的 update:{} 为 create-if-absent，不升级存量行）；
-- 全新库迁移时行尚未 seed（UPDATE 0 行），出厂值由 seed.ts 镜像常量创建。

-- vteam-product -> ep_product (tools 27, permission 7)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_submit_artifact":"allow","vteam_doclib":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_task_create":"allow","vteam_task_transition":"allow","vteam_plan_mode":"allow","vteam_team_add_member":"allow","vteam_question_confirm":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_read_file":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","vteam_hook_register":"allow","vteam_hook_cancel":"allow","browser":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny","**tasks/*/prototypes/**":"allow","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_plan_complete":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_product'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_submit_artifact":"allow","vteam_doclib":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_task_create":"allow","vteam_task_transition":"allow","vteam_plan_mode":"allow","vteam_team_add_member":"allow","vteam_question_confirm":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_read_file":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","vteam_hook_register":"allow","vteam_hook_cancel":"allow","browser":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny","**tasks/*/prototypes/**":"allow","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_plan_complete":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny"}' AS JSON))
  );

-- vteam-architect -> ep_architect (tools 23, permission 16)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_submit_artifact":"allow","vteam_doclib":"allow","vteam_read_file":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_status":"allow","git_diff":"allow","git_log":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_architect'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_submit_artifact":"allow","vteam_doclib":"allow","vteam_read_file":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_status":"allow","git_diff":"allow","git_log":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON))
  );

-- vteam-developer -> ep_developer (tools 27, permission 14)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_submit_artifact":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow","git_push":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny","**tasks/*/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_developer'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_submit_artifact":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow","git_push":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny","**tasks/*/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON))
  );

-- vteam-tester -> ep_tester (tools 25, permission 15)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_submit_artifact":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_transition":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny","**tasks/*/tests/**":"allow","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_issue_update":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_tester'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_submit_artifact":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_transition":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_task_context":"allow","vteam_chat_history":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","browser":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny","**tasks/*/tests/**":"allow","**tasks/*/docs/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_issue_update":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON))
  );

-- vteam-project_manager -> ep_project_manager (tools 27, permission 6)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_task_context":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_task_create":"allow","vteam_task_transition":"allow","vteam_plan_mode":"allow","vteam_plan_complete":"allow","vteam_team_add_member":"allow","vteam_question_confirm":"allow","vteam_skill_create":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_chat_history":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","vteam_hook_register":"allow","vteam_hook_cancel":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny"},"read":{"*":"allow"},"bash":"deny","task":"deny","vteam_submit_artifact":"deny","vteam_git_repos_list":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_project_manager'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_task_context":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_issue_create":"allow","vteam_issue_list":"allow","vteam_issue_get":"allow","vteam_issue_update":"allow","vteam_issue_transition":"allow","vteam_task_create":"allow","vteam_task_transition":"allow","vteam_plan_mode":"allow","vteam_plan_complete":"allow","vteam_team_add_member":"allow","vteam_question_confirm":"allow","vteam_skill_create":"allow","vteam_memory_save":"allow","vteam_memory_search":"allow","vteam_memory_update":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_chat_history":"allow","vteam_wecom_reply":"allow","vteam_channel_send":"allow","vteam_hook_register":"allow","vteam_hook_cancel":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny"},"read":{"*":"allow"},"bash":"deny","task":"deny","vteam_submit_artifact":"deny","vteam_git_repos_list":"deny"}' AS JSON))
  );

-- vteam-plan -> ep_plan (tools 12, permission 22)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_task_context":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_chat_history":"allow","vteam_wecom_reply":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_search":"allow","vteam_plan_complete":"allow","browser":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny","**.opencode/plans/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"allow","vteam_submit_artifact":"deny","vteam_issue_create":"deny","vteam_issue_list":"deny","vteam_issue_get":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_memory_save":"deny","vteam_memory_update":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_channel_send":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_plan'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_task_context":"allow","vteam_read_file":"allow","vteam_doclib":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_chat_history":"allow","vteam_wecom_reply":"allow","vteam_group_post":"allow","vteam_notify_agent":"allow","vteam_memory_search":"allow","vteam_plan_complete":"allow","browser":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny","**.opencode/plans/**":"allow"},"read":{"*":"allow"},"bash":"allow","task":"allow","vteam_submit_artifact":"deny","vteam_issue_create":"deny","vteam_issue_list":"deny","vteam_issue_get":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_memory_save":"deny","vteam_memory_update":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_channel_send":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_git_repos_list":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON))
  );

-- vteam-librarian -> ep_librarian (tools 16, permission 24)
UPDATE `execution_policies`
SET `config` = JSON_SET(
      `config`,
      '$.tools',      CAST('{"vteam_chat_history":"allow","vteam_task_context":"allow","vteam_doclib":"allow","vteam_read_file":"allow","vteam_memory_search":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_group_post":"allow","vteam_git_repos_list":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow","browser":"allow"}' AS JSON),
      '$.permission', CAST('{"edit":{"*":"deny"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_notify_agent":"deny","vteam_submit_artifact":"deny","vteam_issue_create":"deny","vteam_issue_list":"deny","vteam_issue_get":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_memory_save":"deny","vteam_memory_update":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_channel_send":"deny","vteam_wecom_reply":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON)
    )
WHERE `id` = 'ep_librarian'
  AND (
    NOT (JSON_EXTRACT(`config`, '$.tools')      <=> CAST('{"vteam_chat_history":"allow","vteam_task_context":"allow","vteam_doclib":"allow","vteam_read_file":"allow","vteam_memory_search":"allow","vteam_team_view":"allow","vteam_my_profile":"allow","vteam_group_post":"allow","vteam_git_repos_list":"allow","git_clone":"allow","git_pull":"allow","git_fetch":"allow","git_status":"allow","git_diff":"allow","git_log":"allow","browser":"allow"}' AS JSON))
    OR
    NOT (JSON_EXTRACT(`config`, '$.permission') <=> CAST('{"edit":{"*":"deny"},"read":{"*":"allow"},"bash":"allow","task":"deny","vteam_notify_agent":"deny","vteam_submit_artifact":"deny","vteam_issue_create":"deny","vteam_issue_list":"deny","vteam_issue_get":"deny","vteam_issue_update":"deny","vteam_issue_transition":"deny","vteam_task_transition":"deny","vteam_question_confirm":"deny","vteam_memory_save":"deny","vteam_memory_update":"deny","vteam_team_add_member":"deny","vteam_plan_mode":"deny","vteam_plan_complete":"deny","vteam_channel_send":"deny","vteam_wecom_reply":"deny","vteam_task_create":"deny","vteam_skill_create":"deny","vteam_hook_register":"deny","vteam_hook_cancel":"deny"}' AS JSON))
  );
