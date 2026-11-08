-- 会话列表预览/未读统计只需要正文 text，但 content JSON 里带着大量工具输出（单条可达 MB 级）。
-- 生成列在写入时由 DB 计算好，读取时无需解析 JSON，避免 /conversations 拉取上百 MB。
ALTER TABLE `messages`
  ADD COLUMN `body_text` TEXT
  GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(`content`, '$.text'))) STORED;
