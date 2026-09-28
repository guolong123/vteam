-- 升级路径：为存量岗位能力矩阵显式补写 `secret.command` = true（sensitive-command-tool todo 1）。
--
-- fresh install：seed 写入 29 键全量矩阵（含 secret.command）。
-- upgrade：存量 agent_roles.capabilities 已是 28 键非 NULL 矩阵，seed 只补 NULL 行，
--          故本迁移显式回填新键，避免升级后依赖「缺失键 ⇒ 允许」的隐式授权
--          （与 fresh install 的显式 true 分裂）。
-- 只增不改：仅当该键缺失时写入，运营者已显式的值（含 false）原样保留；
--          不改写其他能力点，不建 secret 表/列（JSON_REMOVE / JSON_OBJECT / DDL 均无）。
-- 覆盖面：7 内置岗、3 外部岗、ar_general 与任意历史自定义行的非 NULL 矩阵；
--          capabilities 仍为 NULL 的行由 seed 的出厂矩阵补齐（同一 defaultDeny:false 语义）。

UPDATE `agent_roles`
SET `capabilities` = JSON_SET(`capabilities`, '$."secret.command"', true)
WHERE `capabilities` IS NOT NULL
  AND JSON_CONTAINS_PATH(`capabilities`, 'one', '$."secret.command"') = 0;
