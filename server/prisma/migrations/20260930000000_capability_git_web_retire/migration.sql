-- 摘除 `git.repo.read` / `git.repo.write` / `web.browse` 三个已退役的岗位能力键。
--
-- 背景（2026-09-30）：这三个键由上一个迁移 20260929000000_capability_git_web_tier
-- 写入，覆盖 worker 注入的 `git_*` / `browser` 工具。但那组工具**不经 platform-mcp**
-- ⇒ `PlatformToolPermissionService` 结构上拦不到；`isCapabilityGranted` 亦零运行时
-- 调用方。三个键从写入到退役**从未拦截过任何调用**，是岗位页上的假开关。
--
-- 权威源已迁至：ROLE_BOUNDARIES.toolAllows → ExecutionPolicy → NATIVE_PERMISSION_KEYS
-- 投影 → opencode 原生 permission 校验（与 bash 同一链路）。
--
-- 为什么必须删键、不能只删代码：`AgentRole.capabilities` 是 default-allow 语义
-- （`isCapabilityGranted` = `matrix?.[key] !== false`）。留着孤儿键不会改变任何行为，
-- 但会让运维误以为这三个键仍受管控——虚假安全感比没有更危险。故物理摘除。
--
-- 只删这三个键，不动其他 29 键（含 `git.repos`，那是 vteam_git_repos_list 的能力点，
-- 走 platform-mcp、真实生效，与本组无关）。JSON_REMOVE 是幂等的：键不存在时为 no-op。
-- `capabilities IS NULL` 的行（seed 出厂矩阵补齐，本就不含这三个键）不匹配，天然跳过。

UPDATE `agent_roles`
SET `capabilities` = JSON_REMOVE(
      `capabilities`,
      '$."git.repo.read"',
      '$."git.repo.write"',
      '$."web.browse"'
    )
WHERE `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(
        `capabilities`,
        'one',
        '$."git.repo.read"',
        '$."git.repo.write"',
        '$."web.browse"'
      ) = 1;
