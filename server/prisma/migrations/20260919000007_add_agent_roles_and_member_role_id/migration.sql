-- Agent 角色实体（agent-role-entity 计划 todo 1，Wave-1 阻塞项）。
--
-- 背景：角色的身份与指令此前挤在 `Agent.role`（字符串标签）与 `Agent.prompt`（长文本）里。
-- 本迁移引入全局可复用的 `agent_roles` 表（**无任何能力字段**：permission/tools/model/worker
-- 仍属 ExecutionPolicy / Agent），并给 `team_members` 加 `role_id` 外键，把「成员 → 岗位」显式化。
--
-- ⚠️ 命名防冲突：本表映射 `agent_roles`，模型名 `AgentRole`；**禁止**用 `roles` / `Role`
--    （那是 account-permission 的 RBAC 表，schema.prisma 顶部 `model Role @@map("roles")`，主键前缀 `r_`）。
--    本域主键前缀 `ar`（内置命名 id `ar_<role>` / 迁移派生 `ar_c_<md5 前 16>`）。
--
-- ⚠️ `Agent.role` **不动**：本迁移既不 drop/rename 它，也不回填进它——它只是本次回填的标签来源，
--    真正的删除留待后续计划（contract 阶段）。
--
-- 作用域（仅本计划相关 DDL；与本次无关的存量漂移——artifacts FK/category、memories 索引、
-- agents.agent_key 改型、RENAME INDEX 等——保持现状不动，理由同 20260915000000_add_skill_versions）：
--   1. CREATE TABLE `agent_roles`（唯一键 `key`；`default_agent_id` FK → `agents` ON DELETE SET NULL；
--      `team_members.role_id` FK → `agent_roles` ON DELETE RESTRICT，在用角色不可静默删除）；
--   2. ALTER TABLE `team_members` ADD COLUMN `role_id` + 索引 + FK；
--   3. INSERT 7 个内置角色（key/name/default_agent_id → 对应模板 Agent；`role_prompt` 暂空，
--      todo 4 填充——列级可空，但每个内置行最终必须非空）；
--   4. 回填全部 `team_members.role_id`（三态规则，见下），使
--      `SELECT COUNT(*) FROM team_members WHERE role_id IS NULL` = 0 可达成。
--
-- ⚠️ 回填**不可逆**：本迁移会「派生并新建」自定义角色行、并给成员写入 role_id；一旦执行，
--    原始 `agents.role` 标签与成员映射关系无法从新表中逐字节还原（尤其 case ii 的派生 key 含
--    MD5，case iii 会凭空产生 `general` 兜底行）。**回滚必须依赖迁移前全库 dump，不能靠 migrate
--    down / 反向 SQL。** 迁移前 dump 与精确恢复命令：
--
--      # 迁移前（在仓库根执行，先备份；本计划实际 dump 见 .omo/evidence/agent-role-entity/）
--      docker compose exec -T db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
--        --single-transaction --routines --triggers aiagents' \
--        > .omo/evidence/agent-role-entity/pre-migration-dump.sql
--
--      # 若需恢复（丢弃迁移后的一切写入，回到迁移前状态）
--      docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" aiagents' \
--        < .omo/evidence/agent-role-entity/pre-migration-dump.sql
--
-- 回填三态规则（review fix M3；key 由 `agents.role` 决定）：
--   (i)   `agents.role` ∈ {product, project_manager, architect, developer, tester, plan, librarian}
--         → 链接同名内置行（id = `ar_<role>`）。
--   (ii)  `agents.role` 非空且非内置（如 'analyst'）→ 按确定性规则派生 key 并**新建** `type='custom'` 行，
--         再链接。派生规则（与 src/common/constants/agent-role.constants.ts 的
--         `deriveCustomAgentRoleKey`/`deriveCustomAgentRoleId` 逐字节一致）：
--             stem = COALESCE(NULLIF(LEFT(TRIM(BOTH '_' FROM REGEXP_REPLACE(LOWER(TRIM(role)),'[^a-z0-9]+','_')),32),''),'role')
--             key  = 'custom_' || stem || '_' || LEFT(MD5(role), 8)
--             id   = 'ar_c_' || LEFT(MD5(role), 16)
--         （MD5 哈希 raw 原文，与 SQL 的 MD5(role) 一致；同值恒等，重跑不产生新行。）
--   (iii) `agents.role IS NULL`（自定义 Agent 的 role 可空，agents.service.ts `role: dto.role ?? null`）
--         → 链接单一兜底自定义角色（key `general` / 名称「通用」，随本迁移新建）。

-- ── 1. 建表 ────────────────────────────────────────────────────────────────
CREATE TABLE `agent_roles` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `type` VARCHAR(191) NOT NULL,
    `default_agent_id` VARCHAR(191) NULL,
    `role_prompt` TEXT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uk_agent_roles_key`(`key`),
    INDEX `idx_agent_roles_default_agent`(`default_agent_id`),
    INDEX `idx_agent_roles_sort_order`(`sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── 2. team_members.role_id + 索引 + FK ───────────────────────────────────
ALTER TABLE `team_members` ADD COLUMN `role_id` VARCHAR(191) NULL;
CREATE INDEX `idx_team_members_role` ON `team_members`(`role_id`);
-- default_agent_id：删除被绑定 Agent 仅清空该列（SET NULL），不阻塞 Agent 删除（review fix m8）。
ALTER TABLE `agent_roles` ADD CONSTRAINT `agent_roles_default_agent_id_fkey` FOREIGN KEY (`default_agent_id`) REFERENCES `agents`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
-- role_id：在用角色不可删除（RESTRICT）；成员删除/解绑可正常置空。
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `agent_roles`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 3. 7 个内置角色（default_agent_id 由标量子查询解析）────────────────────
-- 存量库：模板 Agent 已存在 → 解析得到 id；全新库：migrate deploy 先于 seed，agents 尚空
-- → 解析为 NULL，稍后由 seed 的 create-if-absent updateMany 补齐（保持「不覆盖用户编辑」约定）。
INSERT INTO `agent_roles` (`id`, `key`, `name`, `description`, `type`, `default_agent_id`, `role_prompt`, `sort_order`, `created_at`, `updated_at`) VALUES
  ('ar_product',         'product',         '产品经理',   '内置角色：产品经理（需求分析与原型设计）。',  'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_product'),         NULL, 1, NOW(3), NOW(3)),
  ('ar_project_manager', 'project_manager', '项目经理',   '内置角色：项目经理（流程控制，不产出交付物）。', 'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_project_manager'), NULL, 2, NOW(3), NOW(3)),
  ('ar_architect',       'architect',       '架构师',     '内置角色：架构师（技术方案与设计文档）。',      'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_architect'),       NULL, 3, NOW(3), NOW(3)),
  ('ar_developer',       'developer',       '开发者',     '内置角色：开发者（编码实现与缺陷修复）。',      'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_developer'),       NULL, 4, NOW(3), NOW(3)),
  ('ar_tester',          'tester',          '测试',       '内置角色：测试（用例设计与验证）。',            'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_tester'),          NULL, 5, NOW(3), NOW(3)),
  ('ar_plan',            'plan',            '计划员',     '内置角色：计划员（计划编制与修订）。',          'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_plan'),            NULL, 6, NOW(3), NOW(3)),
  ('ar_librarian',       'librarian',       '知识管理员', '内置角色：知识管理员（只读检索与问答）。',      'builtin', (SELECT `id` FROM `agents` WHERE `id` = 'a_librarian'),       NULL, 7, NOW(3), NOW(3));

-- ── 4a. 兜底自定义角色（case iii：agent.role IS NULL 的成员）──────────────
INSERT INTO `agent_roles` (`id`, `key`, `name`, `description`, `type`, `default_agent_id`, `role_prompt`, `sort_order`, `created_at`, `updated_at`) VALUES
  ('ar_general', 'general', '通用', '通用角色（未分类）：存量成员的 Agent.role 为空时的回填兜底。', 'custom', NULL, NULL, 100, NOW(3), NOW(3));

-- ── 4b. case (ii)：为非内置的非空 role 新建自定义角色行（确定性派生）──────
-- DISTINCT 保证同值只建一行；id/key 由 role 原文派生，重跑/多成员共用同值不重复。
INSERT INTO `agent_roles` (`id`, `key`, `name`, `description`, `type`, `default_agent_id`, `role_prompt`, `sort_order`, `created_at`, `updated_at`)
SELECT
  CONCAT('ar_c_', LEFT(MD5(`d`.`role`), 16)) AS `id`,
  CONCAT(
    'custom_',
    COALESCE(NULLIF(LEFT(TRIM(BOTH '_' FROM REGEXP_REPLACE(LOWER(TRIM(`d`.`role`)), '[^a-z0-9]+', '_')), 32), ''), 'role'),
    '_',
    LEFT(MD5(`d`.`role`), 8)
  ) AS `key`,
  `d`.`role` AS `name`,
  CONCAT('迁移自 Agent.role = "', `d`.`role`, '" 的自定义角色。') AS `description`,
  'custom' AS `type`,
  NULL, NULL, 200, NOW(3), NOW(3)
FROM (
  SELECT DISTINCT `role`
  FROM `agents`
  WHERE `role` IS NOT NULL
    AND `role` NOT IN ('product', 'project_manager', 'architect', 'developer', 'tester', 'plan', 'librarian')
) AS `d`;

-- ── 4c. 回填 team_members.role_id（三态；互斥，任意顺序等价）──────────────
-- (i) 内置 key → 链接同名内置行。
UPDATE `team_members` AS `tm`
JOIN `agents` AS `a` ON `a`.`id` = `tm`.`agent_id`
SET `tm`.`role_id` = CONCAT('ar_', `a`.`role`)
WHERE `tm`.`role_id` IS NULL
  AND `a`.`role` IN ('product', 'project_manager', 'architect', 'developer', 'tester', 'plan', 'librarian');

-- (ii) 非空非内置 → 链接 4b 派生的自定义行（用同一确定性 id 重建，无需 join）。
UPDATE `team_members` AS `tm`
JOIN `agents` AS `a` ON `a`.`id` = `tm`.`agent_id`
SET `tm`.`role_id` = CONCAT('ar_c_', LEFT(MD5(`a`.`role`), 16))
WHERE `tm`.`role_id` IS NULL
  AND `a`.`role` IS NOT NULL
  AND `a`.`role` NOT IN ('product', 'project_manager', 'architect', 'developer', 'tester', 'plan', 'librarian');

-- (iii) NULL role → 链接兜底行。
UPDATE `team_members` AS `tm`
JOIN `agents` AS `a` ON `a`.`id` = `tm`.`agent_id`
SET `tm`.`role_id` = 'ar_general'
WHERE `tm`.`role_id` IS NULL
  AND `a`.`role` IS NULL;
