-- 升级路径：为存量部署补写「记忆整理」两个能力点/工具键（memory-enhancement Todo 8a）。
--
-- 缺陷背景（生产实证）：`vteam_memory_archive` / `vteam_memory_merge` 两个 MCP 工具的
-- **注册面**齐备（`tools` 目录行、`tools/list` 全量、`PLATFORM_CAPABILITIES` 目录项、
-- `VTEAM_MCP_TOOL_NAMES`、seed create 路径的出厂矩阵），但**存量数据面**从未被回填：
--   - fresh install：seed 首次 create 写入完整矩阵 ⇒ 两个工具可用（本地 F3 实测 34 工具）；
--   - upgrade：seed 对 ExecutionPolicy 刻意 `update: {}`（config 是页面可编辑的运行时
--     来源，升级仅在首次 create 时生效），而 `agent_roles` 的出厂矩阵只在
--     `capabilities IS NULL` 时补齐 ⇒ 存量行两个键**都缺失**。
-- 生产 Agent 如实上报「当前工具集只有 memory_search/save/update，没有 merge/archive」。
--
-- ── 缺失键语义（本次回填的全部理由，逐层分述）────────────────────────────
--
-- 【层② guard allowlist：`execution_policies.config.tools`】
-- `resolveGuardTools(agentName, tools)`（execution-policy.service.ts）的语义是
-- **整体胜出、绝不逐键合并**：`canonicalizeTools` 过滤掉非法值后，只要剩下 ≥1 条合法项，
-- 就直接返回该对象，**不会**与 `ROLE_BOUNDARIES[name].toolAllows` 常量按键合并。
-- 故「非空对象缺某键」在该层等价于**该工具不在 allowlist 内**（`toolAllowed()` 视为 deny），
-- 而非回退到常量。存量 `ep_project_manager` 行有 30 条合法项、恰好缺这两个键 ⇒
-- 解析出的 allowlist 里没有它们。消费面：`resolveByAgent()/resolveManyByAgents()`
-- → `agents.service` 的 `effectivePermission.tools`（页面展示/运维编辑面），以及
-- worker-dispatcher **未绑岗位**的存量回退路径（`resolveBoundaryAndTools`）。
-- 注意：本层对**已绑岗位**成员不再是运行时权威（权威已迁至 `AgentRole.capabilities`，
-- 见 platform-capability.constants.ts 文件头），但它仍是运维在页面上编辑与观察的
-- 「工具权限」来源，缺键会让页面与真实能力**不一致** ⇒ 必须回填。
--
-- 【平台能力权威（服务端 `tools/call` 唯一门）：`agent_roles.capabilities`】
-- `PlatformToolPermissionService.assertToolAllowed`（platform-tool-permission.service.ts）
-- 读岗位矩阵：能力点**显式 false ⇒ 403**，**键缺失 ⇒ 放行**。
-- 两个方向的后果都要说清：
--   1. PM 缺 `memory.archive`/`memory.merge` ⇒ default-allow 放行，**调用本身不被拦**；
--      但 `vteam_my_profile` 的 `effectivePermission` 直接回显该矩阵（Agent 自 introspect
--      的唯一权威来源），缺键即向模型呈现「我没有这两个能力点」——这正是生产 Agent
--      如实上报的直接成因（default-allow 是「没关门」，不是「装上了门」）。
--   2. 另外 6 个内置岗同样缺键 ⇒ default-allow 让**它们也能调**整理入口，与代码意图
--      （仅 PM 持整理权）相反。**default-ALLOW 语义下这些 false 是安全相关的**，
--      必须显式回填，不能依赖「以后收紧」。
--
-- ── 本迁移写什么 / 不写什么 ────────────────────────────────────────────
--
-- 写：
--   1. `execution_policies.config.tools`：**仅** `ep_project_manager`（type='template'）
--      补 `"vteam_memory_archive":"allow"` + `"vteam_memory_merge":"allow"`。
--      其余 6 个内置策略行**一个键都不写**——它们的出厂 `toolAllows` 本就不含这两个工具，
--      而本层「缺键 = 不在 allowlist」已经等价于 factory 意图的 deny；写显式 `'deny'`
--      反而与 fresh install 落库值（= `toolAllows` 拷贝）分裂。
--      `type='custom'`（运维克隆/自建）**绝不触碰**：那是纯运营者数据。
--   2. `agent_roles.capabilities`：按出厂矩阵逐键回填（见下三类）。
--
-- 不写（逐条给出理由，避免后来者按「新工具就该全表回填」的直觉补回来）：
--   - `execution_policies.config.permission` 的 `vteam_*` 键：`agents[].permission` 经
--     `projectNativePermission` 只投影 `edit/read/bash/task` 四个原生键，`vteam_*` 在
--     发射前被丢弃（T10 订正：平台保守只投影这 4 键，vteam_* 才落到服务端裁决）。
--     该处缺键**结构上不产生任何授权面**，回填只会制造「改了不生效」的假开关。
--   - `tools` 目录表 / `mcp_servers`：注册面，Todo 8a 已随 seed 落库且生产已存在。
--
-- ── 外部岗与自定义行的处置（与 20260929000000 的差异，逐条说明）──────────
--
-- 20260929000000_capability_git_web_tier 把 3 个外部岗（sisyphus/prometheus/atlas）
-- 整组豁免（一个键都不写），理由是**用户决定 2026-09-29**：外部助手保留自身 git 操作
-- 与浏览能力，故不能写 false。该豁免是通过 `EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS`
-- 实现的，而该名单已于 2026-09-30 随三键退役**整组清空为 `[]`**——即外部岗的矩阵如今
-- **是全量受管的**（9 项 allowlist 派生的最小矩阵，其余能力点一律显式 false，见
-- `EXTERNAL_AGENT_ROLE_CAPABILITIES` 与 agent-role-capabilities-git-web-retire spec
-- 的 9 true / 22 false 断言）。
--
-- 记忆整理两个键**从无任何用户豁免决定**，且出厂矩阵对外部岗就是 `false`
-- （9 工具 allowlist 不含 archive/merge ⇒ `buildCapabilityMatrixFromTools` 记 false）。
-- 故本迁移对外部岗写 `false` 而非「不写」：不写会让它们因 default-allow 拿到整理入口，
-- 与出厂矩阵分裂——这与 factory intent 相反，且这两个工具是本次新加、外部助手无任何
-- 既有依赖（Todo 8a 尚未在存量部署生效），收紧无回归风险。
--
-- `ar_general` 与任意历史自定义行的非 NULL 矩阵：写入出厂取值（`true`，因两个能力点
-- `defaultDeny: false`）。注意这**不是放大授权**——default-allow 下它们当前本就被放行，
-- 写 true 只是把隐式放行变成显式可审计（与 20260929000000 对该组写 `read=true` 同策）。
--
-- ── 只增不改 / 幂等 ────────────────────────────────────────────────────
-- 每个键一条独立 UPDATE，且仅当该键缺失时才写：运营者已显式的值（含 false / 'deny'）
-- 原样保留。为什么逐键拆开：`JSON_CONTAINS_PATH(doc,'one',a,b)=0` 只在两键**全部**缺失
-- 时为真，若某行已有其中一键，整行会被跳过、另一键永久留空（default-allow 下即永久
-- 放行 / 层② guard allowlist 永久不含该工具）。拆开后每键独立幂等，重跑
-- `prisma migrate deploy` 安全 no-op。
--
-- 无 DDL：`capabilities` / `capabilities_configured_at` 两列均已存在
-- （前者 squashed_baseline 建表即有，后者由 20260929000000 的 `ADD COLUMN` 建立，
-- 且早于本迁移执行）——契约 spec 逐项断言这条不变量，防止重演 PR #36 的 `ERROR 1054`。

-- ── 1) execution_policies：仅 PM 补两个工具键（层② guard allowlist 的 DB 来源）────
-- 只增不改守卫：`$.tools.vteam_memory_archive` 缺失才写；运营者显式的
-- 'deny'/'ask'/'allow' 一律原样保留。
--
-- 额外守卫 `vteam_memory_update` 必须已存在：这是**防误建 tools 对象**的硬条件。
-- 若某行的 `config` 里根本没有 `tools`（或 `tools` 不含任何既有记忆工具），本 UPDATE
-- 会用 JSON_SET 新建一个只含这两个键的 `tools` 对象；而 `resolveGuardTools` 是
-- 「整体胜出」语义——那个只有 2 项的对象会**顶掉** `ROLE_BOUNDARIES` 的整份常量
-- allowlist，把 PM 其余 28 个工具全部赶出 allowlist。要求既有记忆工具在场，
-- 等价于要求「这是一个真实的出厂形状 tools 矩阵」，从而杜绝该灾难。
UPDATE `execution_policies`
SET `config` = JSON_SET(`config`, '$."tools"."vteam_memory_archive"', 'allow')
WHERE `id` = 'ep_project_manager'
  AND `type` = 'template'
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_update"') = 1
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_archive"') = 0;

UPDATE `execution_policies`
SET `config` = JSON_SET(`config`, '$."tools"."vteam_memory_merge"', 'allow')
WHERE `id` = 'ep_project_manager'
  AND `type` = 'template'
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_update"') = 1
  AND JSON_CONTAINS_PATH(`config`, 'one', '$."tools"."vteam_memory_merge"') = 0;

-- ── 2) agent_roles.capabilities：7 内置岗（派生取值）────────────────────────
-- memory.archive = true：仅 project_manager（团队主 Agent，记忆整理权的唯一持有者）。
-- 与 seed 的 `builtinRoleCapabilityMap` 同口径：PM 显式全量 true，其余 6 岗按
-- `ROLE_BOUNDARIES[*].toolAllows` 派生（archive/merge 不在任何一个 toolAllows 里 ⇒ false）。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.archive"', true)
WHERE `key` = 'project_manager'
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.archive"') = 0;

-- memory.archive = false：product / architect / developer / tester / plan / librarian。
-- default-allow 下不写 false 就等于「放行」，与 factory intent 相反 ⇒ 必须显式写。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.archive"', false)
WHERE `key` IN ('product', 'architect', 'developer', 'tester', 'plan', 'librarian')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.archive"') = 0;

-- memory.merge = true：仅 project_manager（与 archive 同权，同理由）。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.merge"', true)
WHERE `key` = 'project_manager'
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.merge"') = 0;

-- memory.merge = false：其余 6 个内置岗（同 archive 的 default-allow 理由）。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.merge"', false)
WHERE `key` IN ('product', 'architect', 'developer', 'tester', 'plan', 'librarian')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.merge"') = 0;

-- ── 3) 外部岗（sisyphus / prometheus / atlas）：false ───────────────────────
-- 与 20260929000000 的差异已在文件头逐条论证：三键豁免名单已清空，外部岗矩阵全量受管，
-- 且这两个键从无用户豁免决定、出厂矩阵即为 false（9 工具 allowlist 不含它们）。
-- default-allow 下不写即放行 ⇒ 写 false 才是与出厂矩阵对齐。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.archive"', false)
WHERE `key` IN ('sisyphus', 'prometheus', 'atlas')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.archive"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.merge"', false)
WHERE `key` IN ('sisyphus', 'prometheus', 'atlas')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.merge"') = 0;

-- ── 4) 其余行（ar_general + 任意历史自定义行的非 NULL 矩阵）：出厂取值 true ──
-- 两个能力点 `defaultDeny: false` ⇒ `buildFactoryCapabilityMatrix()` 给 true。
-- 非放大授权：default-allow 下这些行本就被放行，写 true 只把隐式放行显式化。
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.archive"', true)
WHERE `key` NOT IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian',
      'sisyphus', 'prometheus', 'atlas'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.archive"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."memory.merge"', true)
WHERE `key` NOT IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian',
      'sisyphus', 'prometheus', 'atlas'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."memory.merge"') = 0;

-- ── 5) 打戳（只补 NULL，不覆盖运营者已有戳）────────────────────────────────
-- `capabilities_configured_at` 表达「该矩阵被显式配置的时刻」，用来区分「从未配过」
-- 与「配过但目录又扩了键」——本次正是后者。列已存在（20260929000000 建立），无需 DDL。
-- 只在 NULL 时写：已有戳的行不覆盖（戳是审计信息，不是本次迁移的产物）。
-- `capabilities` 仍为 NULL 的行不在覆盖范围：seed 的出厂矩阵会补齐（同一 defaultDeny
-- 语义 ⇒ 两个键皆 true），且刻意不打戳（对 NULL 行无意义）。
-- 用 CURRENT_TIMESTAMP(3) 而非 NOW()：与本仓既有 DDL 方言一致。
UPDATE `agent_roles`
SET `capabilities_configured_at` = CURRENT_TIMESTAMP(3)
WHERE `capabilities` IS NOT NULL
  AND `capabilities_configured_at` IS NULL;