-- 项目经理 bash 放开（2026-09-23 实证决策，用户确认从平台源头改）。
--
-- 背景：opencode agent 节点的 permission.bash=deny 会让 OpenCode 免费模型（opencode/*）
-- 返回 403「free tier can only be used from within OpenCode」——单变量实验证实：同名
-- 同配置的 agent 只翻该字段，即由 403 变为正常（vteam-pm2：bash=deny → 403；
-- bash=allow → step=1 完成）。vteam-project_manager 曾是唯一 bash=deny 的角色，
-- 于是线上表现为「只有项目经理派发失败，其他成员都正常」。
--
-- 字段口径：permission 的取值是 allow|ask|deny 显式三值（与 vteam_<action> 只列拒绝项
-- 不同），故用 JSON_SET 显式置为 allow，而非 JSON_REMOVE。
UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.permission.bash', 'allow')
 WHERE `id` = 'ep_project_manager';
