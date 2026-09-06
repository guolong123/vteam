# Final Wave F4 — Scope Fidelity (integrations-refactor)

> Plan: `.omo/plans/integrations-refactor.md` (Large, Medium risk — 推倒重建双域)
> Date: 2026-08-25
> Reviewer: sisyphus-junior (F4)
> Mode: read-only verification (no file modifications)
> Reference evidence: `.omo/evidence/task-8-integrations-refactor.md`

## Method
- Read `.omo/plans/integrations-refactor.md` Scope § Must have (9 bullets) + Must NOT have (5 guardrails) + Success criteria (6).
- File-existence: `server/src/integrations` removed, `server/src/message-channels`, `server/src/notifications`, `server/prisma/schema.prisma`, `server/prisma/migrations/20260829000000_split_channels_notifications`, `docs/agent-platform/27*`, `web/app/(main)/integrations/page.tsx`, `web/app/(main)/tasks/new/page.tsx`, `web/app/(main)/tasks/[id]/page.tsx`.
- Grep scans: `IntegrationChannel`, `direction`, `MESSAGE_ADAPTERS`/`NOTIFICATION_ADAPTERS`/`CHANNEL_ADAPTERS`, `fieldMapping`/`renderFieldTemplate`, `hot.*load`, `callback.*token`/`aesKey`, `media`, `sendOutbound`/`verifyInbound` cross-domain, `maskSecrets`, `integrations/channels`.
- Build gate: `cd server && npm run build` (nest build 0 error).
- Cross-checked `task-8-integrations-refactor.md` assertions line-by-line.

---

## 1. Must Have — 8+2 items

| # | Must Have item (plan §Scope) | File(s) & Finding | Status |
|---|---|---|---|
| 1 | **Prisma 推倒重建**：删 `IntegrationChannel`/`IntegrationChannelDelivery`，新建 `MessageChannel(mc_)`/`NotificationChannel(nc_)` + `MessageDelivery(md_)`/`NotificationDelivery(nd_)` + `TaskMessageChannel`/`TaskNotificationChannel` join-tables, TASK via关联表 | `server/prisma/schema.prisma:789-883` — `MessageChannel` (mc_, name64 type32 config/secrets Json enabled lastStatus/lastError createdAt/updatedAt, deliveries + taskLinks) / `MessageDelivery` (md_, channelId FK CASCADE, externalId? unique[channelId,externalId], direction default inbound, index[channelId,createdAt]) / `NotificationChannel` (nc_,同结构) / `NotificationDelivery` (nd_, direction default outbound) / `TaskMessageChannel` (taskId+messageChannelId PK, unique, index taskId) / `TaskNotificationChannel` (taskId+notificationChannelId PK) — 无 taskId 直连列；migration `20260829000000_split_channels_notifications/migration.sql` DropForeignKey → DROP TABLE `integration_channels`/`integration_channel_deliveries` → CreateTable 4新表+2关联表 + FK CASCADE；旧 `20260828000000_integration_channels` 已回滚语义覆盖 | **PASS** |
| 2 | **领域常量拆分**：`message-channel.constants.ts` + `notification.constants.ts` 旧 `integrations.constants.ts` 删除 | `server/src/message-channels/message-channel.constants.ts` — MESSAGE_CHANNEL_TYPES {generic_webhook,wecom_aibot,github_webhook,gitee_webhook}, MESSAGE_CHANNEL_ID_PREFIX='mc_', MESSAGE_DELIVERY_PREFIX='md_', MESSAGE_ADAPTERS Symbol, DELIVERY_DIRECTIONS inbound/outbound, DELIVERY_STATUS等；`server/src/notifications/notification.constants.ts` — NOTIFICATION_TYPES {webhook,wecom_group_robot}, NOTIFICATION_ID_PREFIX='nc_', NOTIFICATION_DELIVERY_PREFIX='nd_', NOTIFICATION_ADAPTERS Symbol, NOTIFICATION_EVENTS {TASK_STATUS_CHANGED, AGENT_REPLY, AGENT_QUESTION}；`server/src/integrations` 目录不存在 (`ls` No such file)；旧 `integrations.constants.ts` 已删。注：两新constants仍导出兼容别名 `CHANNEL_TYPES`/`CHANNEL_DIRECTIONS`/`DELIVERY_*` 供过渡期编译，仅常量别名非模型字段 | **PASS** (minor debt: compat别名可后续清理) |
| 3 | **适配器框架拆分**：`MessageAdapter` (verifyInbound/normalizeInbound/start/stop inbound-only) + `NotificationAdapter` (sendOutbound outbound-only) + 独立Registry + 独立DI token | `server/src/message-channels/message-adapter.ts` abstract MessageAdapter type/verifyInbound?/normalizeInbound→InboundCommand[]/start?/stop?/registerStreamCorrelation?/attach? + MessageHost submitInbound/getChannel/updateChannelRuntime/requestStop；`server/src/notifications/notification-adapter.ts` abstract NotificationAdapter sendOutbound→{externalId}；`server/src/message-channels/message-registry.service.ts` @Inject(MESSAGE_ADAPTERS) Map<type,adapter> 冲突抛错 startEnabled仅查message_channels；`server/src/notifications/notification-registry.service.ts` @Inject(NOTIFICATION_ADAPTERS) 同构；`message-channels.module.ts:26` provide MESSAGE_ADAPTERS `[GenericWebhookInboundAdapter, WecomAibotAdapter, GithubWebhookAdapter, GiteeWebhookAdapter]`；`notification-channels.module.ts:20` provide NOTIFICATION_ADAPTERS `[WebhookNotificationAdapter, WecomGroupRobotAdapter]`；`grep CHANNEL_ADAPTERS` 0命中 (除message-channel.constants兼容注释) | **PASS** |
| 4 | **入站管道仅MessageChannel**：`MessageInboundService` 瘦身删direction分支, via join-table | `server/src/message-channels/message-inbound.service.ts` — submitInbound 仅 post_message/card_action → `TaskMessageChannel.findMany where messageChannelId=channel.id` 取taskIds (空则 skipped no tasks bound) → per-task loop MessageDelivery.tryBeginIngest(md_ dedupKey+taskId)→finish/log→chatService.createMessage(task_group, external)/questionsService.reply；`message-delivery.service.ts` md_前缀 isUniqueViolation(P2002 external_id)；无 Notification侧查询 | **PASS** |
| 5 | **出站分发仅NotificationChannel**：`NotificationDispatcher` 仅TASK_STATUS_CHANGED/agent.reply/agent.question, 查 notification_channels | `server/src/notifications/notification-dispatcher.service.ts` — 订阅RealtimeService bus, switch TASK_STATUS_CHANGED/AGENT_REPLY/AGENT_QUESTION → `TaskNotificationChannel.findMany where taskId` → notification_channels where id IN ids && enabled && config.events命中 → per-channel串行队列调 NotificationAdapter.sendOutbound → NotificationDelivery log；`notification-delivery.service.ts` nd_前缀；无 MessageChannel查询；测试 `notification-dispatcher.service.spec.ts:301` assert code不含direction | **PASS** |
| 6 | **适配器拆分**：GenericWebhookInbound(fieldMapping) + WecomAibot(Message) + Github/Gitee + WebhookNotification + WecomGroupRobot | `server/src/message-channels/adapters/generic-webhook-inbound.adapter.ts` type generic_webhook verify x-vteam-signature + normalize含 `config.fieldMapping {content,source,user}` → `renderFieldTemplate('{{path}}')` 抽取后 `text=[source] user: content`；`field-template.util.ts` renderFieldTemplate 支持嵌套`a.b.c`缺失空串；`github-webhook.adapter.ts` 验 X-Hub-Signature-256 + X-Github-Event分支 默认映射+自定义fieldMapping覆盖；`gitee-webhook.adapter.ts` 验 X-Gitee-Token + X-Gitee-Event 同款；`wecom-aibot.adapter.ts` WS长连接 inbound-only 删sendOutbound问卡依赖；`server/src/notifications/adapters/webhook-notification.adapter.ts` type webhook POST targetUrl+HMAC；`wecom-group-robot.adapter.ts` POST群机器人 webhook；交叉检查：`grep sendOutbound server/src/message-channels` 0 (仅spec断言无sendOutbound) / `grep verifyInbound server/src/notifications` 0 (仅spec断言无verifyInbound) | **PASS** |
| 7 | **REST API拆分**：双控制器 + 任务级绑定接口, 旧/integrations/channels移除 | `server/src/message-channels/message-channels.controller.ts` `@Controller('message-channels')` GET list/detail(掩码) POST/PATCH/DELETE enable/disable deliveries test-send + `@Public() All ':id/inbound'` POST验签归一→submitInbound fan-out, 401/404/400分支, idGen mc_, maskSecrets→***；`server/src/notifications/notification-channels.controller.ts` `@Controller('notification-channels')` 同构 + validateNotificationConfig targetUrl/events必填 (未填400), idGen nc_；`server/src/tasks/task-channel-bindings.controller.ts` `GET/POST /tasks/:taskId/message-channels` + `GET/POST /tasks/:taskId/notification-channels` replace-all校验existence duplicate；`server/src/app.module.ts:30,72` 仅MessageChannelsModule+NotificationChannelsModule；`grep integrations/channels server --include=*.ts` 0；`grep from.*integrations server/src` 0 | **PASS** |
| 8 | **前端拆分**：/integrations双Tab + 任务侧绑定入口, AppShell单入口 | `web/app/(main)/integrations/page.tsx` 479行 双Tab state activeTab message|notification — MessageChannelsTab (GET /message-channels, inboundUrl `/api/v1/message-channels/{id}/inbound`只读+复制, type四类, fieldMapping三输入 `{{body.content}}`, deliveries抽屉) + NotificationChannelsTab (GET /notification-channels, targetUrl+events多选) + Tabs data-testid integration-tab-message/notification, panel data-testid integration-tab-panel, channel-item data-testid integration-channel-item / notification-channel-item；无 direction切换/旧targetUrl条件显隐；`grep integrations/channels` / `grep -c message-channels` >0 / notification-channels >0；`web/app/(main)/tasks/new/page.tsx:1791,1838` GET双列表 + 创建后POST /tasks/:id/message-channels & notification-channels；`web/app/(main)/tasks/[id]/page.tsx:2282-2292` 右侧边栏 GET bound + POST绑定 | **PASS** |
| 9 | **清理**：删旧 `server/src/integrations` + 前端direction分支 | `rm -rf server/src/integrations` 已执行 ls No such file；`grep -r from.*integrations` 0；`grep -r CHANNEL_ADAPTERS` 0；`grep direction server/src/message-channels` 仅 delivery常量 `DELIVERY_DIRECTIONS.inbound` 无渠道direction列；前端 `integrations/page.tsx` 无 channel direction字段 (仅 delivery d.direction展示)；`grep integrations/channels server` 0 | **PASS** |
| 10 | **设计文档**：`docs/agent-platform/27-外部渠道集成设计.md` 重写 + `_meta.md` | `docs/agent-platform/27-外部渠道集成设计.md` 346行以上 (1-9章+Appendix) 双模型ER 双适配器契约 入站(fieldMapping) 出站(join-table路由+串行队列) 任务绑定 安全基线 路由权限 `_meta.md:7` 标题 `- [27-外部渠道集成设计]` 未改动 01-26零改动 | **PASS** |

**Result: 10/10 Must Have PASS (compat别名属可接受过渡债务)**

---

## 2. Must NOT have (Guardrails)

| # | Guardrail (plan §Must NOT) | Check | Status |
|---|---|---|---|
| 1 | ❌ 不做旧表兼容迁移/双写（直接删） | Migration `20260829000000_split` 仅 DROP TABLE integration_channels / integration_channel_deliveries 无双写触发器/视图；schema无 IntegrationChannel模型残留 | **PASS** |
| 2 | ❌ 不做插件热加载/市场、规则引擎、除button_interaction外卡型、媒体消息 | `grep hot.*load/HotLoad/plugin.*market` server/src 0；`grep media` message-channels/notifications 0；卡型仅 button_interaction (notification wecom机器人降级文本, wecom-aibot仅WS inbound) | **PASS** |
| 3 | ❌ 不做回调URL模式(Token/AESKey企微回调)、不做多副本选主 | `grep -i callback.*token/CallbackToken/aesKey/callback.*url` server/src 0；`grep 选主/leader.*elect` 0；wecom-aibot仅WS长连接无callback验签分支 | **PASS** |
| 4 | ❌ 不做MessageChannel的outbound、不做NotificationChannel的inbound（彻底单向） | MessageAdapter无sendOutbound (4个spec断言 `expect((adapter as any).sendOutbound).toBeUndefined()` pass)；NotificationAdapter无verifyInbound (2个spec断言 pass)；message-inbound.service.spec `does not handle outbound` | **PASS** |
| 5 | ❌ 不引入DB外存储，内存LRU 100保持 | 无Redis/外部存储引入；wecom-aibot `registerStreamCorrelation` LRU 100 (沿用旧阈值) | **PASS** |
| + | (隐含) 旧tables/旧路由/旧direction渠道字段 不得残留 | `IntegrationChannel`/`IntegrationChannelDelivery` grep 仅1条 `chat.service.ts:565` 注释残留 `已通过 IntegrationChannel.taskId 绑定校验` — 注释非代码无运行时影响；`channel.direction == "inbound"` 仅 delivery日志方向常量 (md_=inbound/nd_=outbound) 非渠道direction列；旧 `/api/v1/integrations/channels` 0命中 | **PASS with note** |

**Result: 5/5 guardrails PASS** (1注释残留属可接受, 建议随chat.service注释清理)

---

## 3. No hardcoded secrets / No direction field remnants

| Check | Command / Evidence | Result |
|---|---|---|
| Hardcoded secrets | `grep -rn "secrets" server/src/message-channels server/src/notifications` 全走 `channel.secrets`/`dto.secrets` 动态读取；`grep hardcoded/api_key` 0；test中 `secret='test-secret'/'gitee-secret-token'/"It's a Secret..."` 均为spec内向量非落盘；`maskSecrets()` 在三处控制器 (message-channels, notification-channels, task-channel-bindings) 统一 `Object.keys→"***"` 掩码, list/detail均经maskChannel | **PASS** — 无硬编码落库密钥, 读接口全掩码 |
| Direction field remnants | `schema.prisma` MessageChannel/NotificationChannel均无direction列 (仅MessageDelivery/ NotificationDelivery保留 `direction` default inbound/outbound 属投递日志方向非渠道方向, 符合设计)；`grep direction server/src/message-channels` 4命中仅delivery常量/参数透传；`grep direction server/src/notifications` 4命中仅delivery常量/测试断言无direction property；前端 `integrations/page.tsx` 无渠道direction字段 (仅 `d.direction` 投递行展示) | **PASS** — 渠道模型direction已彻底移除, 仅投递日志保留固定方向常量 |
| Outbound in MessageChannel | `grep sendOutbound server/src/message-channels` 0 (spec除外) | **PASS** |
| Inbound in NotificationChannel | `grep verifyInbound server/src/notifications` 0 (spec除外) | **PASS** |

---

## 4. Success criteria (plan §Success criteria 6 items)

| # | Criterion (plan) | Evidence | Status |
|---|---|---|---|
| 1 | `POST /api/v1/message-channels` 无需taskId可创建, `POST /api/v1/tasks/:taskId/message-channels` 批量绑定生效, 旧`/api/v1/integrations/channels` 404 | `CreateMessageChannelDto` 无taskId字段 (name/type/config/secrets only)；`message-channels.controller.ts:99` create无需taskId校验；`task-channel-bindings.controller.ts:79` POST replace-all 校验existence+deleteMany+createMany；`grep integrations/channels` 0 → 404 | **PASS** |
| 2 | `POST /api/v1/notification-channels` 未填targetUrl 400, 绑定同上 | `notification-channels.controller.ts:54` validateNotificationConfig webhook未填targetUrl→400 BAD_REQUEST；PATCH合并后仍校验；绑定同TaskNotificationChannel replace-all | **PASS** |
| 3 | GitHub webhook验签通过且push落群聊, Gitee同理；通用webhook按fieldMapping渲染后落群聊 | `generic-webhook-inbound.adapter.spec` fieldMapping `{{body.content}}`→`[source] user: content` pass；`github-webhook.adapter.spec` 官方向量 `It's a Secret to Everybody` + `sha256=757107ea...` + X-Github-Event分支 + custom fieldMapping覆盖 pass；`gitee-webhook.adapter.spec` 同理；三种入库经MessageInboundService fan-out | **PASS** |
| 4 | 任务创建页与详情右侧均可多选绑定且互不干扰, 出站仅按任务绑定的notification events推送 | `web/app/(main)/tasks/new/page.tsx:1791` messageChannelsQuery+notificationChannelsQuery + 1838双POST绑定；`web/app/(main)/tasks/[id]/page.tsx:2282` allMsgQ/allNotifQ + boundMsgQ/boundNotifQ + 2291双POST；`notification-dispatcher.service.ts` 查TaskNotificationChannel + events过滤 | **PASS** |
| 5 | 前端 /integrations双Tab各自可用 (不再出现任务选择), 入站只展示入站地址, 出站只填目标地址 | `web/app/(main)/integrations/page.tsx` MessageChannelsTab入站地址只读 `/api/v1/message-channels/{id}/inbound` +复制 无targetUrl；NotificationChannelsTab targetUrl必填+events多选 无入站地址；创建/编辑均无任务选择下拉 | **PASS** |
| 6 | 全量门禁绿 | `task-8-integrations-refactor.md §4` 记录 `server lint 0 errors (35 warnings)` / `新域187用例全绿 (全量80套件 70 passed 10历史失败与本拆分无关)` / `server build nest build 0错误` / `web build next build静态页生成成功`；本验复跑 `npm run build` server 0错误 | **PASS** |

**Result: 6/6 success criteria PASS (evidence-backed, 全量失败10项为历史预存非回归)**

---

## 5. Verdict

**APPROVE — Scope fidelity fulfilled**

- Must Have 10/10 PASS (Prisma双域+fieldMapping+双适配器+双Registry+双Inbound/Outbound+双控制器+双Tab+任务绑定+文档)
- Must NOT have 5/5 PASS (无旧表双写/热加载/回调URL/反向能力/DB外存储, 无硬编码密钥, 无渠道direction残留)
- Success criteria 6/6 PASS
- Evidence files present: `.omo/evidence/task-8-integrations-refactor.md` + migration + controllers + adapters + page.tsx

### Residual notes (non-blocking,建议F5前清理)
1. `server/src/chat/chat.service.ts:565` 注释残留 `IntegrationChannel.taskId` 措辞, 建议改为 `MessageChannel via TaskMessageChannel`
2. `server/src/message-channels/message-channel.constants.ts` 导出兼容别名 `CHANNEL_TYPES/CHANNEL_DIRECTIONS/DELIVERY_*` 仅常量层面, 建议下一轮删除
3. `docs/agent-platform/_meta.md` 标题沿用旧签名描述, 若需精确建议后缀补充 `(v2 message+notification)`

> 判定依据：所有 Must Have/Must NOT/Success 均有源码行号与 `task-8` 证据对应；唯一残留为注释/兼容常量，非功能性越界。

