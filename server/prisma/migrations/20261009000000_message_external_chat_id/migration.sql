-- 入站消息所属企微会话 id（2026-10-09）
--
-- 背景：agent 主动出站（发文件/图片/文本）需要定位**用户发言的那个会话**。
-- 此前唯一来源是渠道级 config.lastChatid——它每条入站都覆盖一次。一个企微 bot
-- 可以同时在多个群里 + 私聊，于是存在静默错投：用户在群 A 让 agent 发报告，期间
-- 群 B 或私聊来过消息 → lastChatid 变成 B → 文件发到群 B。
--
-- 已做的第一步（7fe7890）：出站优先取**入站消息流**的 chatid（内存注册表），
-- 只在取不到时回退 lastChatid。但该注册表有两个硬限制：
--   1. 内存态——server 重启即丢；
--   2. TTL 10 分钟（WECOM_OPERATOR_TTL_MS）——超时后活动流查不到，
--      出站仍回落 lastChatid，多群错投概率只是降低、未消除。
--
-- 故把 chatid 持久化到消息行：外部消息（sender_type=external）落库时带上它，
-- 出站按「该频道最近一条外部消息」锚定会话，不受内存态与 10 分钟窗口限制。
--
-- 1) 新增 `external_chat_id`：仅 WeCom 入站消息有值，其余行（agent/user/系统消息）
--    恒为 NULL。**不做回填**——历史消息的 chatid 已不可考，且错填会把回复引到错误会话；
--    缺值时出站仍回退渠道级 lastChatid（既有行为，不劣化）。
-- 2) 列型 `varchar(191) NULL`：与 messages 其它可空 varchar（sender_id 等）一致；
--    chatid 实测形如 `wriGjxCgAAnOgUmcM9kQyW5DgnxWzUJg`（32 字符），191 富余。
-- 3) **不建索引**：唯一读取路径是「按 channelId 取最近若干条外部消息」，
--    已由 `idx_messages_channel_id` 覆盖 + ORDER BY created_at，无独立查询需求。
-- 4) **不删任何东西**：本仓库无 down-migration 约定（docs/tech-debt-rollback.md）。

ALTER TABLE `messages`
  ADD COLUMN `external_chat_id` varchar(191) NULL;
