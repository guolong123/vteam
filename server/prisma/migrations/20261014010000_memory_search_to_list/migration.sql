-- 升级路径：MCP 工具改名 vteam_memory_search → vteam_memory_list（Stream 4a，纯注册面改名）。
--
-- 背景（冻结契约）：memory.search 能力域的工具按「列出/检索」语义更名为
-- vteam_memory_list——**仅工具真实暴露名（及 tools.action 权限点）变更**：
--   - MCP 工具名（真实暴露名）：`vteam_memory_search` → `vteam_memory_list`；
--   - 权限点 action：`memory_search` → `memory_list`；
--   - 能力点键 `memory.search`（AgentRole.capabilities / PLATFORM_CAPABILITIES 的 key）
--     **原样不动**——能力键是业务语义命名，不是工具名；与它同轮廓的
--     `capabilityKeyForTool` 反查已在 src 常量同步更新（platform-capability.constants.ts）。
-- 语义未变：仍是同一只「列出/检索团队记忆」工具，save/update/archive/merge 不受影响。
--
-- ── 为什么需要本迁移（三层存量数据面）──────────────────────────────
--
-- 生产部署的三处 DB 状态持有旧工具名，不迁移就会出现「新代码 ↔ 旧数据」分裂：
--   1. `tools` 目录表：存量行 name='vteam_memory_search' / action='memory_search'。
--      seed 对 MCP 工具是 `update: {...}` 全量同步语义，若只改名 seed 不改存量行，会
--      因 action @unique（新 action='memory_list' 建不出新行）或 name 漂移产生
--      「管理面工具目录与 worker tools/list 不一致」；先由本迁移 rename，seed 再按新
--      action upsert 即为幂等 no-op。
--   2. `execution_policies.config.tools`：7 个内置模板策略（type='template'，ep_*）
--      的层② guard allowlist 里键名是 `vteam_memory_search`。worker guard
--      `resolveGuardTools` 按**真实暴露名**白名单判定——旧键名 = 新工具名不在 allowlist
--      内（`toolAllowed()` 视为 deny），改名后存量部署直接失去该工具的调用权，
--      必须把 JSON 键 rename（保留运营者显式的 'allow'/'ask'/'deny' 取值）。
--   3. `agent_roles.capabilities`：键是**能力点键**（`memory.search`），不是工具名 ⇒
--      **本迁移绝不触碰 agent_roles**（写了反而是破坏：会把业务键按工具名改写）。
--
-- ── 写什么 / 不写什么 ────────────────────────────────────────────
--
-- 写：
--   1. `tools`：name 与 action 两列 rename（存量部署的目录行 → 新名/新权限点）。
--   2. `execution_policies.config.tools`：type='template' 且**已含旧键**的行，把
--      JSON 键从 `vteam_memory_search` rename 为 `vteam_memory_list`（值原样保留）。
--
-- 不写（逐条理由）：
--   - `execution_policies.config.permission`：`projectNativePermission` 只投影
--     edit/read/bash/task 四个原生键，vteam_* 键在发射前被丢弃——缺键结构上无授权面，
--     且 seed 的 permission 是首次 create 快照，改名不产生新的授权语义。
--   - `type='custom'` 策略行：运维克隆/编辑的运营者数据，不在出厂升级面内
--     （与 20261009020000 对 custom 行「绝不触碰」同策）。
--   - `agent_roles.capabilities`：键是能力点键而非工具名（见上第 3 点）。
--   - `mcp_servers`：注册面已由 seed 保证，无改名需求。
--
-- ── 幂等 / no-op 契约（重跑 `prisma migrate deploy` 必须安全）──────
--
--   A. `tools` 两条 UPDATE 都以「旧值命中」为守卫：全新库（seed 已写新名/新 action）
--      与重跑（rename 后已无旧值行）均匹配 0 行 ⇒ no-op。两条语句顺序执行构成一次
--      完整 rename（先 name 后 action），不拆分批次——本文件内的语句在同一迁移内
--      原子应用，不存在「只改一半」的中间态暴露给使用者。
--   B. JSON 键 rename 拆成「先 JSON_SET 新键、后 JSON_REMOVE 旧键」两步，各自以
--      `JSON_CONTAINS_PATH(...,'$."tools"."vteam_memory_search"'` 在场为守卫：
--      - 旧键不存在的行（fresh install / 已是新键 / 无 tools 对象）一律不碰，
--        **绝不会**用 JSON_SET 新建出一个 tools 对象（守卫路径是完整嵌套路径，
--        缺失即整条不执行）；
--      - JSON_SET 额外要求「新键尚未存在」，故即使迁移在第 1 步后中断、重跑时也不会
--        覆盖已 rename 的值；第 2 步的 JSON_REMOVE 最终把旧键清掉，两步对同一行的
--      任意重跑组合均收敛到「只有新键」。
--   C. 值保全：JSON_SET 的第三个参数取 `JSON_EXTRACT(旧键)` 的 JSON 标量原样——
--      'allow'/'ask'/'deny' 甚至非标量值都逐字节保留，不重写成字面量。
--
-- 无 DDL：`tools.name` / `tools.action` / `execution_policies.config` 均建表时即存在
-- （tools 见 squashed_baseline `CREATE TABLE tools`，execution_policies.config 同），
-- 不 ADD COLUMN、不改 schema.prisma 任何模型/列——契约 spec 逐项断言该不变量。

-- ── 1) tools 目录 rename：name 与 action（存量数据面）────────────────
-- 守卫即幂等：只rename带旧 name 的行；新名行不命中。
-- name 无唯一约束；action 有 @unique（tools_action_key）——本迁移是 'memory_search'
-- 唯一的生产来源，rename 不与任何既有行冲突（'memory_list' 在本迁移前不存在）。
UPDATE `tools`
SET `name` = 'vteam_memory_list'
WHERE `name` = 'vteam_memory_search';

UPDATE `tools`
SET `action` = 'memory_list'
WHERE `action` = 'memory_search';

-- ── 2) execution_policies.config.tools：JSON 键 rename（层② guard allowlist 的 DB 来源）──
-- 先写新键（值为旧键的 JSON 标量原样，保全运营者显式的 allow/ask/deny），
-- 再删旧键。两条语句都以「旧键在场」为守卫 ⇒ 全新库/已是新键/无 tools 对象的行零写入。
UPDATE `execution_policies`
SET `config` = JSON_SET(
  `config`,
  '$."tools"."vteam_memory_list"',
  JSON_EXTRACT(`config`, '$."tools"."vteam_memory_search"')
)
WHERE `type` = 'template'
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_search"') = 1
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_list"') = 0;

UPDATE `execution_policies`
SET `config` = JSON_REMOVE(`config`, '$."tools"."vteam_memory_search"')
WHERE `type` = 'template'
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_search"') = 1;
