# Learnings — integrations-refactor

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-08-25 Task 1: Prisma 推倒重建 MessageChannel/NotificationChannel 双模型
- Schema: 移除旧 IntegrationChannel/Delivery (但 HEAD 未提交旧模型，实际仅工作区存在 20260828000000_integration_channels 未提交迁移) + 新增 6 模型 MessageChannel(mc_)/MessageDelivery(md_)/NotificationChannel(nc_)/NotificationDelivery(nd_)/TaskMessageChannel/TaskNotificationChannel (含 @@id+@@unique双约束、@@index taskId、@map 列名、onDelete Cascade, inbound/outbound direction 默认值)。Task 改为 messageChannelLinks/notificationChannelLinks，通过关联表多对多绑定，渠道表不再含 taskId。
- Migration: DB P1001 不可达，采用手写 `20260829000000_split_channels_notifications/migration.sql` (2 Drop + 6 Create + 6 FK)，内容与 `prisma migrate diff --from-empty` 抽取的 CREATE 语句对齐 (utf8mb4, Json, 索引命名一致)。
- Verify: `npx prisma validate` ✅, `npx prisma generate` 生成 6 新 delegate 且 integrationChannel=false, `npm run build` 需修复 `channel-delivery.service.ts:153 Prisma.IntegrationChannelDeliveryWhereInput` -> `Record<string,unknown>` 否则 TS2694。
- Gotcha: shadow DB diff 需 --shadow-database-url 但仍要真实 MySQL 连接，fallback 手写；旧代码 (prisma as any).integrationChannel 因 any cast 不影响 build，仅 Prisma 命名空间类型需清理。

## 2026-08-25 Task: wecom_aibot channel secrets UI dual-field fix
- File: web/app/(main)/integrations/page.tsx MessageChannelModal: split single `secret` state into `botId` + `secret`; conditional render when type==='wecom_aibot' shows BotID (data-testid integration-botId-input, placeholder "企微后台 BotID" / edit "•••••••• (保持不变)") + Secret (data-testid integration-secret-input, placeholder "企微长连接 Secret" / edit masked) vs single Secret otherwise.
- Submit: wecom builds secrets={botId,secret} only if trimmed non-empty (omit empty => keep old on edit); generic builds {secret} alone. Create-mode validation requires both botId+secret for wecom.
- Verify: `cd web && npm run build` passes, grep confirms botId input present.

## 2026-08-26 Task: message channel auto-connect + status display
- Backend: server/src/message-channels/message-channels.controller.ts POST create now auto-starts adapter (registry.get + adapter.start + startEnabled, both catch) and re-fetches row to return populated lastStatus/lastError without throwing to client; mirrors enable logic to ensure wecom WS connects immediately after create, not only on manual enable.
- Frontend: web/app/(main)/integrations/page.tsx added messageStatusTheme (connected green/reconnecting yellow/error red/disconnected gray "未连接"), status badge (data-testid message-channel-status-badge + integration-status-badge) with lastError tooltip, error text below inboundUrl (data-testid message-channel-error-text), Connect button (data-testid message-channel-connect-button) calls POST /message-channels/:id/enable when not connected, Disconnect button (data-testid message-channel-disconnect-button) calls disable when connected; preserves existing enabled toggle and delivery/edit/delete actions.
- Verify: `server npm run build` and `web npm run build` both pass; status badge renders lastStatus from API (lastStatus/last_status handled via lastStatus field, fallback to disconnected).

## 2026-08-26 Task: WeCom spinner interval fix 400ms->500ms deploy
- File: server/src/message-channels/adapters/wecom-aibot.adapter.ts: SPINNER_INTERVAL_MS 400->500, SPINNER_FRAMES alternating ⏳\u200B/⌛\u200C zero-width suffix to bypass WeCom dedup, immediate first flush before setInterval, pendingTick guard.
- Verify: source grep SPINNER_INTERVAL_MS=500 (line 46), dist/wecom-aibot.adapter.js rebuilt shows =500, container aiagents-compose-server healthy after docker compose up -d --build server.
- Build: npm run build (nest build) pass locally; docker build stage2 RUN npm run build also passed (cached deps, rebuilt in ~9s).
- Deploy: docker compose up -d --build server completed, init prisma generate ok, server health: curl http://localhost:13000/api/v1/health 200 {"status":"ok"}, docker ps healthy.
- Spec ref: WeCom 0.5s streaming interval (AstrBot PR #6610), 400ms throttled/dropped.

## 2026-08-26 Task: wecom_reply MCP tool not showing in tools/list fix
- Root cause: platform-mcp.tools.ts correctly defines wecom_reply (26th tool, handler -> service.wecomReply) and platform-mcp.controller serves it via tools/list (verified curl returns 26 tools including wecom_reply). However server/prisma/seed.ts vteamTools array had only 25 entries (missing wecom_reply), so DB tools table (source=mcp, mcpServer=vteam) lacked tl_vteam_wecom_reply row — frontend GET /api/v1/tools?source=mcp&mcpServer=vteam would not show it, and skill/tool UI counts mismatched.
- Fix: server/prisma/seed.ts vteamTools += {action:'wecom_reply', name:'vteam_wecom_reply', description:'回复企业微信用户（仅当消息来自企微时使用）'} after channel_send. init container re-ran seed on docker compose up --build (no pending migrations, seed prints 26 MCP tools), plus manual prisma upsert confirmed id=tl_vteam_wecom_reply.
- Verify: grep -rn wecom_reply server/src/platform-mcp/ shows tools.ts:676 + service.ts:2006 handler + controller.spec expects 26; grep server/dist/ shows wecom_reply in tools.js:490; curl POST /api/v1/platform-mcp tools/list returns 26 tools with wecom_reply present; curl health 200 ok; docker ps server healthy; server npm run build pass.
