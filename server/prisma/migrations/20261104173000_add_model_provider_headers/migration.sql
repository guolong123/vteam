-- provider 级固定请求头（opencode-go 网关要求 x-opencode-session 等）
ALTER TABLE `models` ADD COLUMN `headers` JSON NULL;
