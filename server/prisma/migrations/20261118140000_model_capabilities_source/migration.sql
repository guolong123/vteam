-- capabilities 的来源标记（2026-11-18）
--
-- 让自动同步能区分「机器从 models.dev 同步的」与「管理员手工填的」：
--   modelsdev → 每次同步都刷新（models.dev 更新后旧值可能过时）
--   manual    → 默认不动
--   NULL      → 未知（历史数据）
--
-- 历史数据（含被错误模板污染的 20 个模型）统一置 NULL，随后由一次
-- `overwrite` 同步纠正并把来源标成 modelsdev。

ALTER TABLE `models`
  ADD COLUMN `capabilities_source` VARCHAR(32) NULL;
