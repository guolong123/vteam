-- 多附件：一条消息可带 N 个文件（[{url,name,size,ext}]）
-- 旧三字段 attachment_url/name/type 保留（= 首个附件的兼容读路径），新链路以 attachments 为主。
ALTER TABLE `messages` ADD COLUMN `attachments` JSON NULL;
