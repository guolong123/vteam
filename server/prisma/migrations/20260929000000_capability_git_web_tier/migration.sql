-- 升级路径：为存量岗位补写 T11 新增的三个能力点，并打上 capabilities_configured_at 戳。
--
-- 背景（T11 交付的强制决策点）：default-allow 语义下「键缺失 ⇒ 允许」。这三个键是
-- cf6229d 才引入的，此前已写过矩阵的存量行**不会**被 seed 覆盖（seed 的 updateMany
-- 只填 `capabilities IS NULL` 的行）⇒ 存量行缺这三个键 ⇒ 升级后**自动获得**
-- git.repo.write 与 web.browse。这正是「看起来有门实则敞开」，必须显式回填堵住。
--
-- 三类行按**不同策略**处理，刻意不一致：
--
--   1) 7 个内置岗：写入按 ROLE_BOUNDARIES.toolAllows 派生的取值。
--      只增不改：每个键一条独立 UPDATE，且仅当该键缺失时才写 ——
--      运营者已显式的值（含 false）原样保留。
--
--   2) 3 个外部岗（sisyphus / prometheus / atlas）：**一个键都不写**。
--      用户决定 2026-09-29：外部助手不纳入这三档开关，保留自身 git 操作与浏览
--      能力。这里绝不能写 false —— default-allow 下缺失即允许，写 false 恰好会
--      拒绝它们，与决定相反。写 false 是收紧，本次不做。
--
--   3) ar_general 与任意历史自定义行的非 NULL 矩阵：写入出厂取值
--      （read=true / write=false / browse=false），与 buildFactoryCapabilityMatrix
--      的 defaultDeny 语义一致（M1 安全要求：后两者出厂即拒）。
--
-- capabilities 仍为 NULL 的行不在覆盖范围：seed 的出厂矩阵会补齐，
-- 且刻意**不**打戳（capabilities_configured_at 只对非 NULL 矩阵有意义 ——
-- 它用来区分「从未配过」与「配过但目录又扩了」）。
--
-- 为什么每个键一条语句：`JSON_CONTAINS_PATH(doc,'one',a,b,c)=0` 只在三个键
-- **全部**缺失时为真，若某行已有其中一键，整行会被跳过、另外两键永久留空
-- （default-allow 下即永久放行）。拆开后每键独立幂等。

-- ── 0) DDL：新增 capabilities_configured_at 列 ───────────────────────────
-- 必须自带且必须排在末尾打戳之前：`agent_roles` 建表于 squashed_baseline，列清单
-- 里没有这一列（schema.prisma 本次才加），否则打戳报 ERROR 1054 Unknown column。
-- 配套契约测试是**文本解析**（readFileSync → 剥 `--` → 正则），从不执行 SQL，
-- 结构上发现不了缺失的 DDL —— 勿以「测试全绿」推断本语句可删。
ALTER TABLE `agent_roles`
  ADD COLUMN `capabilities_configured_at` datetime(3) DEFAULT NULL;

-- ── 1) 7 个内置岗：派生取值 ──────────────────────────────────────────────
-- git.repo.read = true：developer / tester / project_manager / librarian
--   （architect 缺 git_fetch，六个读工具不齐 ⇒ false）
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.read"', true)
WHERE `key` IN ('developer', 'tester', 'project_manager', 'librarian')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.read"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.read"', false)
WHERE `key` IN ('product', 'architect', 'plan')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.read"') = 0;

-- git.repo.write = true：仅 developer / project_manager
--   （project_manager 是**声明偏离**：其 ROLE_BOUNDARIES 未给 git_*，但矩阵既有
--    不变量是「全量授权」，沿用该不变量而非改写它；用户已接受此代价）
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.write"', true)
WHERE `key` IN ('developer', 'project_manager')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.write"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.write"', false)
WHERE `key` IN ('product', 'architect', 'tester', 'plan', 'librarian')
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.write"') = 0;

-- web.browse = true：7 个内置岗**全部**为 true（7 岗 toolAllows 均含 browser；
--   project_manager 的 browser 同样来自「全量授权」不变量而非 ROLE_BOUNDARIES）
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."web.browse"', true)
WHERE `key` IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."web.browse"') = 0;

-- ── 2) 外部岗：三个键一个都不写 ─────────────────────────────────────────
-- 用户决定：外部助手保留自身 git 操作与浏览网页能力。default-allow 下缺失即允许，
-- 写 false 恰好会拒绝它们。此处**故意不 UPDATE**，留注释作为「此处本有逻辑、
-- 被有意移除」的显式记录，避免后来者按「三个新键就该全表回填」的直觉补回来。
-- WHERE `key` IN ('sisyphus', 'prometheus', 'atlas') → 无操作。

-- ── 3) 其余行（ar_general + 历史自定义）：出厂取值 ───────────────────────
UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.read"', true)
WHERE `key` NOT IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian',
      'sisyphus', 'prometheus', 'atlas'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.read"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."git.repo.write"', false)
WHERE `key` NOT IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian',
      'sisyphus', 'prometheus', 'atlas'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."git.repo.write"') = 0;

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."web.browse"', false)
WHERE `key` NOT IN (
      'product', 'architect', 'developer', 'tester',
      'project_manager', 'plan', 'librarian',
      'sisyphus', 'prometheus', 'atlas'
    )
  AND `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."web.browse"') = 0;

-- ── 4) 打戳 ────────────────────────────────────────────────────────────
-- 非 NULL 矩阵的行都记下「配过」的时刻。外部岗也打戳（它们确实配过矩阵，
-- 只是这三键不在其管控范围内）—— 戳表达的是矩阵的来源时间，不是键集大小。
-- 用 CURRENT_TIMESTAMP(3) 而非 NOW()：与本仓既有 DDL 方言一致。
UPDATE `agent_roles`
SET `capabilities_configured_at` = CURRENT_TIMESTAMP(3)
WHERE `capabilities` IS NOT NULL
  AND `capabilities_configured_at` IS NULL;
