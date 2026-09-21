-- AlterTable
-- Tool.description 后端权威文案：MCP sync 物化 tools/list 的 description（可空 TEXT）；
-- 存量行全 NULL（下次 sync 回填），GET /tools 直接返回该列。
ALTER TABLE `tools` ADD COLUMN `description` TEXT NULL;
