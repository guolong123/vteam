-- 拆分组能力点：`issue.manage` → 5 点、`memory.manage` → 3 点（2026-09-22 用户决策
-- 选项 (b)：拆分组，消除「组塌缩」缺陷——能力点「全部成员工具放行才 true」的派生规则
-- 在岗位只放行组内部分工具时会把整点记 false，连已放行的工具一并丢失）。
--
-- 背景：能力目录由 21 点升至 **27 点**（27 键覆盖 28 个 vteam_* 工具，仅 `hook.manage`
--   仍成组覆盖 2 工具——本迁移不改 hook.manage）。组塌缩曾丢失的 4 格：
--   architect × issue.manage（3/5 放行）、tester × issue.manage（4/5）、
--   plan × memory.manage（1/3 = 仅检索）、librarian × memory.manage（1/3 = 仅检索，
--   其职责恰是只读检索）。拆分后各点按其单工具放行判定，上述格全部恢复。
--
-- 单一事实来源：`src/common/constants/agent-role.constants.ts` 的
--   `BUILTIN_ROLE_CAPABILITY_MAPS`（7 内置岗，27 键字面量）+
--   `EXTERNAL_AGENT_ROLE_CAPABILITIES`（外部 3 岗 8 工具最小矩阵，8 true / 19 false）+
--   `buildFactoryCapabilityMatrix()`（`ar_general` 出厂矩阵，13 allow / 14 deny）。
--   逐键相等由契约 spec `src/prisma/agent-role-capabilities-split-grouped.migration.spec.ts`
--   锁定（SQL↔TS 防漂移，同 000007/000008 契约形状）；字面量由 ts-node 从上述常量
--   生成（零手抄）。`project_manager` 仍为显式全 27 点 true（覆盖，不按边界派生）。
--
-- 范围与不变量（幂等：整列常量覆盖，重跑零变化）：
--   1) 恰 11 条 UPDATE = 7 内置岗（守卫 type='builtin' AND key=单个内置 key）+
--      外部 3 岗 sisyphus/prometheus/atlas（守卫 key=单值；8 工具最小矩阵不放宽）+
--      `ar_general`（守卫 key='general'；落 27 键出厂矩阵）。全部角色改写后
--      每行 capabilities 恰 27 键，不含 issue.manage/memory.manage，恒非 NULL。
--   2) MySQL JSON 陷阱：JSON_SET/JSON_REMOVE 对**不存在的路径**返回 NULL（会把整列
--      置 NULL）。本迁移**不使用**任何 JSON 路径增改函数——直接整列
--      CAST('<27 键字面量>' AS JSON) 覆盖，写入值恒非 NULL；WHERE 子句即范围守卫，
--      对当前值为 NULL 的行同样覆盖 ⇒ 迁移后全表 capabilities IS NULL = 0。
--   3) 只拆点、不放大授权：非 PM 岗每个 true 点仍 ⊆ 其 ROLE_BOUNDARIES 工具放行集
--      （拆分只是把「组内部分放行 → 整点 false」细化为逐工具判定）；外部 3 岗保持
--      8 工具最小权限（8 true / 19 false）。逐岗前后差集见 notepad learnings 本 slice 条目。
--
-- ⚠️ 单向迁移：无反向 SQL，回滚 = 恢复迁移前全库 dump。
-- ⚠️ MySQL JSON 路径键含点号须写 $."issue.create"（本迁移不用路径函数，仅沿用邻近迁移注释提醒）。

-- ---------------------------------------------------------------------------
-- 1) 7 个内置岗位 → 拆分后的按角色定制矩阵（27 键字面量；整列覆盖，恒非 NULL；
--    范围守卫 = type='builtin' AND key = 单个内置 key）。常量右值、不引用列自身 ⇒ 幂等。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":true,"issue.get":true,"issue.list":true,"issue.update":true,"issue.transition":true,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":false,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":false}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'product';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":true,"task.transition":true,"task.complete":true,"task.context":true,"team.view":true,"team.add_member":true,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":true,"issue.get":true,"issue.list":true,"issue.update":true,"issue.transition":true,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":true,"question.confirm":true,"my_profile":true,"hook.manage":true,"git.repos":true}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'project_manager';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":true,"issue.get":true,"issue.list":true,"issue.update":false,"issue.transition":false,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'architect';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":true,"issue.get":true,"issue.list":true,"issue.update":true,"issue.transition":true,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'developer';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":true,"wecom.reply":true,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":true,"issue.get":true,"issue.list":true,"issue.update":false,"issue.transition":true,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'tester';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":true,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":true,"doc.read":true,"doc.submit":false,"file.read":true,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":true,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'plan';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":false,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":false,"file.read":true,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":true,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON)
  WHERE `type` = 'builtin'
   AND `key` = 'librarian';

-- ---------------------------------------------------------------------------
-- 2) 外部 3 岗（sisyphus/prometheus/atlas）→ 27 键版 8 工具最小矩阵
--    （8 true / 19 false：拆分只细化键，不放宽第三方执行器最小权限）。
--    守卫 = key 单值（key 全表唯一，外部岗行精确命中）。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":false,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":false,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `key` = 'sisyphus';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":false,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":false,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `key` = 'prometheus';

UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":false,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":false,"memory.search":false,"memory.update":false,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":false}' AS JSON)
  WHERE `key` = 'atlas';

-- ---------------------------------------------------------------------------
-- 3) ar_general → 27 键出厂矩阵（13 allow / 14 deny：defaultDeny 出厂预置拒绝）。
-- ---------------------------------------------------------------------------
UPDATE `agent_roles`
   SET `capabilities` = CAST('{"task.create":false,"task.transition":false,"task.complete":false,"task.context":true,"team.view":true,"team.add_member":false,"chat.post":true,"chat.read":true,"chat.notify":true,"chat.channel_send":false,"wecom.reply":false,"doc.read":true,"doc.submit":true,"file.read":true,"issue.create":false,"issue.get":false,"issue.list":false,"issue.update":false,"issue.transition":false,"memory.save":true,"memory.search":true,"memory.update":true,"skill.create":false,"question.confirm":false,"my_profile":true,"hook.manage":false,"git.repos":true}' AS JSON)
  WHERE `key` = 'general';
