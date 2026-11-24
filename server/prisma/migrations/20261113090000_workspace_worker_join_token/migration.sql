-- 非默认空间的 worker 注册加入码（SHA-256）；默认空间保持单租户兼容（无需加入码）。
ALTER TABLE `workspaces`
  ADD COLUMN `worker_join_token_hash` VARCHAR(64) NULL;
