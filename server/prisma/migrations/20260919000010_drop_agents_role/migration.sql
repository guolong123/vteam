-- 删除 `agents.role` 列（agent-role-decommission todo 7 —— 本计划的 contract 阶段，单向不可逆）。
--
-- 列的历史用途（为什么存在）：`Agent.role` 一个字段曾同时承担四件事——
--   1) 岗位标签：列表/头像配色/团队默认别名等展示（`ROLE_LABELS` / 别名派生）；
--   2) 能力来源：`ep_<role>` 字符串派生定位 ExecutionPolicy（`resolveByAgent` 的旧回退路径）；
--   3) opencode agent 名：`vteam-<role>`（注入 opencode.json 的执行 agent 名）；
--   4) 计划职责判定：`isPlanRole` / `roleToAgentName` / `roleNeedsIssueDetail` 等按名分支。
--
-- 各用途的替换去向（todos 1-6/10 已将全部消费方迁移完毕，本迁移只删残留列）：
--   1) → `AgentRole`（`agent_roles` 表）/ `TeamMember.roleId`（迁移 20260919000007 已回填，0 NULL）；
--   2) → `Agent.policyId`（显式绑定；本迁移把仍依赖旧回退的行回填，见 (a)）；
--   3) → `Agent.agentKey`（迁移 20260914000000 已回填 `agent_key = role`，注入名逐字节不变）；
--   4) → `agentKey`（模板行与 role 逐字节同值；自定义 key 受 AGENT_KEY_PATTERN 约束，
--        永不匹配旧实现的中文子串判据，故判定结果与旧值语义一致）。
--
-- 本迁移只做三件事，绝不与无关 schema 变更混装：
--   (a) 回填 `agents.policy_id`（两条**显式收窄**谓词，均要求目标 `execution_policies` 行
--       真实存在、且本行 `policy_id IS NULL`——不臆造 id、不覆盖用户已绑定值、天然幂等）：
--         a1. 旧 `ep_<role>` 回退（review fix m6）：`role` 非空且存在同 id 的 `ep_<role>` 行；
--         a2. todo 3 的 `ep_<agentKey>` 键路径（仅 a1 未命中的行）：存在同 id 的 `ep_<agentKey>` 行
--             ——保证 todo 8 删除该回退路径前，内置名行都已有显式绑定。
--       验收断言：`SELECT COUNT(*) FROM agents WHERE policy_id IS NULL AND type <> 'custom'` = 0。
--   (b) 孤儿守卫（验收断言的迁移内硬化）：回填后仍 `policy_id IS NULL` 且 `type <> 'custom'`
--       的行必须为 0——借「向 NOT NULL 临时列插入 NULL 必报 1048」实现条件失败（MySQL 纯 SQL
--       无 SIGNAL，仅存储程序可用，故用此等价守卫）。命中即整个迁移失败、DROP 不执行：
--       单向迁移绝不带着未解析的权限来源落库。
--   (c) 显式列出回填后仍无策略的 `type='custom'` 行（「有意无策略」绝不静默，例如
--       create/clone 装配过 deny-by-default 骨架、或历史遗留行）——清单随迁移输出，
--       并记录于本计划证据文件。
--   (d) `ALTER TABLE agents DROP COLUMN role`。
--
-- ⚠️ 单向迁移：drop 无反向 SQL，且本文件**不可原样重跑**（第二次 DROP COLUMN 必报错「1091
--   Can't DROP」，因为它不是幂等语句）——可重入性由 Prisma 迁移账本保证：`migrate deploy`
--   重跑时该迁移记为已应用、不再执行文件（见证据 task-7-drop.txt 的「已应用」实测）。
--   **回滚 = 恢复迁移前全库 dump**。dump 路径与精确命令：
--
--   dump（迁移前执行；本计划证据 .omo/evidence/agent-role-decommission/pre-migration-dump.sql）：
--     docker compose exec -T db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
--       --single-transaction --routines --triggers --default-character-set=utf8mb4 aiagents' \
--       > .omo/evidence/agent-role-decommission/pre-migration-dump.sql
--
--   回滚（丢弃迁移后的一切写入，回到迁移前状态；已按本条命令在 scratch 副本上演练过一次）：
--     docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" aiagents' \
--       < .omo/evidence/agent-role-decommission/pre-migration-dump.sql
--
-- 适用时机：全新库路径下各语句均为 no-op（migrate deploy 先于 seed，建表后 agents 为空，
-- 出厂绑定由 seed 的 ROLE_POLICY_BINDINGS 显式创建）。

-- (a1) 回填旧 `ep_<role>` 回退：role 非空 + 同名内置策略行存在 + 本行尚未绑定。
UPDATE `agents` AS `a`
INNER JOIN `execution_policies` AS `p` ON `p`.`id` = CONCAT('ep_', `a`.`role`)
SET `a`.`policy_id` = `p`.`id`
WHERE `a`.`policy_id` IS NULL
  AND `a`.`role` IS NOT NULL;

-- (a2) 回填 todo 3 的 `ep_<agentKey>` 键路径（仅 a1 未命中的行）：agentKey 命中内置命名。
UPDATE `agents` AS `a`
INNER JOIN `execution_policies` AS `p` ON `p`.`id` = CONCAT('ep_', `a`.`agent_key`)
SET `a`.`policy_id` = `p`.`id`
WHERE `a`.`policy_id` IS NULL
  AND `a`.`agent_key` IS NOT NULL;

-- (b) 孤儿守卫：非 custom 行必须已在 a1/a2 得到显式绑定，否则 INSERT NULL 报 1048、迁移失败、DROP 不执行。
CREATE TEMPORARY TABLE `_drop_agents_role_orphan_guard` (`id` VARCHAR(191) NOT NULL);
INSERT INTO `_drop_agents_role_orphan_guard` (`id`)
  SELECT NULL FROM `agents` WHERE `policy_id` IS NULL AND `type` <> 'custom' LIMIT 1;
DROP TEMPORARY TABLE `_drop_agents_role_orphan_guard`;

-- (c) 有意无策略的 custom 行清单（回填后仍 NULL 者的唯一合法解释）。
SELECT `id`, `name`, `agent_key`, `role`
FROM `agents`
WHERE `type` = 'custom' AND `policy_id` IS NULL
ORDER BY `id`;

-- (d) 单向删除：能力（policyId）/ 标签（AgentRole.roleId）/ 注入名（agentKey）/ 职责（agentKey）
-- 的唯一事实来源均已迁出本列。
ALTER TABLE `agents` DROP COLUMN `role`;
