-- 计划员放开 doc.submit（2026-09-23 用户决策）。
--
-- 背景：岗位能力点矩阵 doc.submit=false 与岗位策略 ep_plan.tools 无 vteam_submit_artifact
-- 双重拒绝，但 MCP tools/list 无法按岗位过滤（MCP 连接按 worker 鉴权、拿不到成员身份），
-- 故计划员在工具清单里看得见 vteam_submit_artifact 却调不动，线上表现为
-- PLATFORM_MCP_TOOL_NOT_PERMITTED（计划员明知 403 仍尝试一次，因为它想把《实施计划》
-- 归档进产出物库）。本次两侧同时打开：能力点 doc.submit=true；岗位策略 tools 由 seed 的
-- ROLE_BOUNDARIES['vteam-plan'] 驱动（新增 vteam_submit_artifact: allow），fresh 安装由
-- seed 落库，已应用库由本迁移补齐。
--
-- 口径对齐 20260921000009（拆分后 27 键整列字面量）：只改 plan 一行、无条件覆盖 ——
-- 已有库的 000009 早已执行过，本条是「已应用库」的唯一补丁路径。
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":true,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
 WHERE `type` = 'builtin'
   AND `key` = 'plan';

-- 岗位策略同步（两个字段约定不同，都必须改）：
--   config.tools      —— 只列**放行**的工具（值为 'allow'）→ JSON_SET 增该键；
--   config.permission —— 只列**拒绝**的工具（值为 'deny'），放行的**不出现** → JSON_REMOVE 删该键
--                        （guard.roles[*].permission 直接取本字段，留着 deny 会继续挡住调用）。
UPDATE `execution_policies`
   SET `config` = JSON_SET(`config`, '$.tools.vteam_submit_artifact', 'allow')
 WHERE `id` = 'ep_plan';

UPDATE `execution_policies`
   SET `config` = JSON_REMOVE(`config`, '$.permission.vteam_submit_artifact')
 WHERE `id` = 'ep_plan';
