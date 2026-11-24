-- 控制面按 worker 记录其注册令牌（AES-256-GCM 密文），用于派遣到该 worker 时鉴权。
-- 空值 = 旧数据/全局共享 token 模式，回退 env WORKER_TOKEN。
ALTER TABLE `workers`
  ADD COLUMN `dispatch_token_ref` TEXT NULL;
