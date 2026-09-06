# Task 8 证据 — 清理旧代码 + 文档重写 + 全量回归

日期: 2026-08-25
分支: `feat/integrations-refactor` 拆分后清理

## 1 删除旧 integrations 残留

```bash
rm -rf server/src/integrations
ls server/src/integrations  # No such file or directory ✅
```

旧目录含单模型 `IntegrationChannel(direction)` + 单适配器 `ChannelAdapter` + `IntegrationsController(@integrations/channels)` + `OutboundDispatcherService(direction 过滤)`，已由 `message-channels` (inbound-only, `mc_`) 与 `notifications` (outbound-only, `nc_`) 双域替代。`server/src/app.module.ts` 已仅导入 `MessageChannelsModule` + `NotificationChannelsModule`，无 `IntegrationsModule` 引用（删除前即已迁移）。

修复 `server/src/platform-mcp/platform-mcp.module.ts` 与 `platform-mcp.service.ts`：

- `IntegrationsModule` → `NotificationChannelsModule`
- `OutboundDispatcherService (integrations)` → `NotificationDispatcherService (notifications)`，并为 `channel_send` 兼容新增 `NotificationDispatcherService.sendToChannelByIdOrName(taskId, target, text)`（join-table 内按 id/name 解析后经 `dispatchToChannel` 串行队列发送）。

## 2 残留 grep 验证

```bash
grep -r "integrations/channels" server --include="*.ts"  # 0 ✅ (仅注释已随目录删除清零)
grep -r "from.*integrations" server/src --include="*.ts" # 0 ✅
grep -r "CHANNEL_ADAPTERS" server/src --include="*.ts"    # 0 ✅

grep -r "direction" server/src/message-channels --include="*.ts"
# 仅 message-delivery.service.ts / spec.ts 的 delivery 方向常量：
#   direction: DELIVERY_DIRECTIONS.inbound  (固定 inbound)
#   direction: string (方法参数透传 delivery 模型)
#   # 0 条 MessageChannel 渠道方向字段 —— MessageChannel 模型无 direction 列 ✅
# 旧 IntegrationChannel.direction (in|out|inout) 已随目录删除彻底移除。
```

`MessageChannel` / `NotificationChannel` Prisma 模型均无 `direction` 列；任务绑定经 `TaskMessageChannel` / `TaskNotificationChannel` join-table，`grep direction` 在 `message-channels` 域仅命中 `MessageDelivery.direction = "inbound"` 常量。

## 3 文档重写

- `docs/agent-platform/27-外部渠道集成设计.md` 全量重写为 v2 拆分架构：
  - §1 概述（旧单域→双域拆分动机与收益）
  - §2 双模型 ER（`MessageChannel(mc_)/MessageDelivery(md_)` + `NotificationChannel(nc_)/NotificationDelivery(nd_)` + 双 join-table，含 config 示例 fieldMapping / events）
  - §3 双适配器契约（`MessageAdapter` inbound-only + `MessageHost` vs `NotificationAdapter` outbound-only，注册表分治）
  - §4 入站链路（含 `field-template.util.ts` 的 `{{ body.path }}` fieldMapping 渲染 → `[source] user: content`）
  - §5 出站链路（`NotificationDispatcher` join-table 路由 + per-channel 串行队列 + Realtime 订阅）
  - §6 任务绑定（join-table CRUD 与校验）
  - §7 安全基线（HMAC-SHA256 + 300s 窗口、`externalId` 唯一去重、`secrets` 遮蔽、单 WS 守卫）
  - §8 路由与权限（`message-channels`/`notification-channels` + `POST /:id/inbound @Public`，旧 `integrations/channels` 0 命中）
  - §9 路线图 + 附录常量/文件索引
- `docs/agent-platform/_meta.md` 标题行未改动：`- [27-外部渠道集成设计](./27-外部渠道集成设计.md) - 外部渠道双向集成…` ✅
- `docs 01-26` 零改动（`git diff --stat` 仅 27 篇与本证据）。

## 4 全量回归闸门

### server lint

```bash
npm run lint  # server/
# ✖ 35 problems (0 errors, 35 warnings) ✅
```

### server test

```bash
npm test  # server --runInBand
# 新域 5 套件 187 用例全绿：
#   PASS src/notifications/notification-dispatcher.service.spec.ts
#   PASS src/platform-mcp/platform-mcp.service.spec.ts
#   PASS src/message-channels/message-channels.controller.spec.ts
#   PASS src/notifications/notification-channels.controller.spec.ts
#   PASS src/message-channels/message-inbound.service.spec.ts
# 全量 80 套件：70 passed, 10 failed（1437/1502 用例通过）
# 10 失败为历史预存（agent.constants/model/seed/worker-dispatcher 等与本拆分无关），
# 新增拆分模块零失败，符合“新模块绿、历史失败有记录”验收。
```

### server build

```bash
npm run build  # server: nest build → 0 错误 ✅
```

### web build

```bash
npm run build  # web: next build → ○/ƒ 全部静态/动态页生成成功 ✅
```

## 5 清单

- [x] `server/src/integrations` 目录已删除，`from.*integrations` 0 命中（仅通知/消息双域保留）
- [x] `grep integrations/channels` 0，`CHANNEL_ADAPTERS` 0
- [x] `message-channels` 域无渠道 `direction` 字段（仅 `MessageDelivery.direction=inbound` 常量）
- [x] 文档 27 按 split 架构重写，`_meta.md` 标题未改，01-26 零改动
- [x] `lint 0 errors` / `新域 test 187 passed` / `server build` / `web build` 全绿
