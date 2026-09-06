# integrations-refactor - Work Plan

## TL;DR (For humans)

**What you'll get:** 把当前“一个 IntegrationChannel 靠 direction 切入/出站”的混血模型推倒，按你提的思路拆成两个独立域：**渠道（怎么收消息进群）** 与 **通知（怎么把事件推出去）** 各自独立表、独立配置、独立前端 Tab。一个任务可配多个渠道（多个 webhook/企微机器人同时进群）也可配多个通知（同时推企微群 + 运维平台），互不耦合。

**Why this approach:** 入站是“被调”（vteam 提供 inbound URL + 验签），出站是“主调”（vteam POST targetUrl + 加签），安全模型、配置项、生命周期完全不同，硬塞一个 direction 越做越拧。拆开后表单不再按 direction 显隐，渠道只展示入站地址，通知只填目标地址。

**What it will NOT do:** 不做旧数据兼容迁移（旧表直接删重建，开发环境 `prisma migrate reset` 级别推倒）；不做多副本选主；不做除 button_interaction 外的卡型。

**Effort:** Large
**Risk:** Medium - 涉及删表重建 + 前后端大面积替换，需保证迁移后旧渠道/通知一律清空可重建
**Decisions to sanity-check:** ①旧 IntegrationChannel/Delivery 表直接删（不做兼容）；②MessageChannel 仅 generic_webhook/wecom_aibot/github/gitee 四类（inbound-only），NotificationChannel 仅 webhook/wecom_group_robot 两类（outbound-only）；③MessageChannel 与 NotificationChannel 各自独立 id 前缀与投递表。

Your next move: 批准后用 `$start-work integrations-refactor` 执行。

---

> TL;DR (machine): effort=Large, risk=medium; deliverables=删重建两套模型（MessageChannel mc_/NotificationChannel nc_ + 各自投递表）、拆分适配器/服务/控制器/前端双Tab、旧 direction 彻底移除

## Scope

### Must have

- Prisma 推倒重建：删 `IntegrationChannel` / `IntegrationChannelDelivery`（含 20260828000000_integration_channels 迁移回滚语义），新建 `MessageChannel(mc_ 前缀)`（id, name, type[generic_webhook|wecom_aibot|github_webhook|gitee_webhook], config Json, secrets Json, enabled Boolean, lastStatus/lastError, createdAt/updatedAt）与 `NotificationChannel(nc_ 前缀)`（id, name, type[webhook|wecom_group_robot], config Json{targetUrl, events}, secrets Json{secret}, enabled, lastStatus/lastError, createdAt/updatedAt）及各自投递表 `MessageDelivery(md_)/NotificationDelivery(nd_)`（id, channelId FK Cascade, externalId? unique[channelId,externalId], direction 固定, status, kind, error, payload/meta Json, createdAt, @@index [channelId, createdAt]）；新增关联表 `TaskMessageChannel`（taskId FK tasks Cascade, messageChannelId FK message_channels Cascade, @@unique([taskId, messageChannelId])）与 `TaskNotificationChannel`（taskId, notificationChannelId），Task 通过关联表实现任务级多选绑定，渠道/通知本身不再持有 taskId
- 领域常量拆分：`message-channel.constants.ts`（MESSAGE_CHANNEL_TYPES, MESSAGE_CHANNEL_ID_PREFIX=mc_）与 `notification-channel.constants.ts`（NOTIFICATION_TYPES, events 枚举），旧 `integrations.constants.ts` 删除
- 适配器框架拆分：`MessageAdapter` 抽象（verifyInbound/normalizeInbound/start/stop 仅 inbound）与 `NotificationAdapter` 抽象（sendOutbound 仅 outbound），各自独立 Registry（MESSAGE_ADAPTERS / NOTIFICATION_ADAPTERS token），各自独立 host
- 入站管道仅对 MessageChannel：`MessageInboundService`（原 InboundService 重命名瘦身，删 direction 分支，仅 post_message/card_action → task_group）
- 出站分发仅对 NotificationChannel：`NotificationDispatcherService`（原 OutboundDispatcher 重命名，仅订阅 TASK_STATUS_CHANGED/agent.reply/agent.question，查 notification_channels）
- 适配器拆分：`GenericWebhookInboundAdapter`（仅验 x-vteam-signature + 支持字段抽取模板 `fieldMapping: {content, source, user}` 将来源 JSON 按 `{{ path }}` 提取为固定三字段后拼装入群）与 `WebhookNotificationAdapter`（仅 POST targetUrl + 签名）；`WecomAibotAdapter` 保留为 MessageAdapter（WS 长连接收 + replyStream占位/finish），新增 `WecomGroupRobotAdapter` 作为 NotificationAdapter（POST 群机器人 webhook）；`Github/GiteeWebhookAdapter` 内置同款抽取逻辑（默认映射）+ 通用 webhook 可自定义覆盖
- REST API 拆分：`MessageChannelsController` (`/api/v1/message-channels`) 与 `NotificationChannelsController` (`/api/v1/notification-channels`) 各自 CRUD/启停/test-send/deliveries，DTO 中 taskId 均为必填，`AppModule` 注册新 Module
- 前端拆分：`/integrations` 改为双 Tab 布局（`Tabs: 渠道 | 通知`），`MessageChannelsTab`（类型 generic/wecom/github/gitee，表单展示入站地址只读+复制，secret，任务级联必选）与 `NotificationChannelsTab`（类型 webhook/wecom_robot，表单展示 targetUrl + events 多选，secret），各自独立列表/弹窗/抽屉，`AppShell` NAV 保留单入口 “集成渠道” 但页内分 Tab
- 清理：删旧 `server/src/integrations` 下所有 `integrations.*` 旧文件（controller/module/constants 混血版）、旧 `IntegrationChannel` 相关前端条件 `direction !== 'in'` 分支
- 设计文档：`docs/agent-platform/27-外部渠道集成设计.md` 重写为拆分后架构，`_meta.md` 保持

### Must NOT have (guardrails, anti-slop, scope boundaries)

- ❌ 不做旧表数据的兼容迁移或双写（直接删，环境重置可接受）
- ❌ 不做插件热加载/市场、规则引擎、除 button_interaction 外的卡型、媒体消息
- ❌ 不做回调 URL 模式（Token/AESKey 企微回调）、不做多副本选主
- ❌ 不做 MessageChannel 的 outbound 能力、不做 NotificationChannel 的 inbound 能力（彻底单向）
- ❌ 不引入 DB 外存储，内存 LRU 100 保持

## Verification strategy

> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after，jest + supertest
- Evidence: `.omo/evidence/task-<N>-integrations-refactor.md`
- 全量门槛：`cd server && npm run lint && npm test && npm run build`；`cd web && npm run build`

## Execution strategy

### Parallel execution waves

- Wave 1（地基推倒）: Todo 1（Prisma 删重建 + 新常量）
- Wave 2（后端拆分）: Todo 2、3、4、5（2 适配器框架拆分与 3 入站瘦身并行，4 出站瘦身并行，5 适配器拆分并行）
- Wave 3（接口与前端）: Todo 6、7（6 双控制器 + 7 双 Tab 前端并行）
- Wave 4（收尾）: Todo 8（清理旧文件 + 文档重写 + 全量回归）

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,4,5,6,7,8 | — |
| 2 | 1 | 5,6,7 | 3,4 |
| 3 | 1 | 5,6,7 | 2,4 |
| 4 | 1 | 5,6,7 | 2,3 |
| 5 | 2,3,4 | 6,7,8 | — |
| 6 | 1,2,3,4,5 | 7,8 | 7 |
| 7 | 1,2,3,4,5 | 8 | 6 |
| 8 | 5,6,7 | — | — |

## Todos

- [x] 1. Prisma 推倒重建：MessageChannel/NotificationChannel 双模型及投递表 + 迁移
  What to do / Must NOT do: 在 `server/prisma/schema.prisma` 删 `model IntegrationChannel` / `IntegrationChannelDelivery` 及 `Task.integrationChannels` 关系；新增 `model MessageChannel`（id String @id, name VarChar64, type VarChar32, config Json @default("{}"), secrets Json @default("{}"), enabled Boolean @default(true), lastStatus VarChar16? @map("last_status"), lastError VarChar512? @map("last_error"), createdAt @default(now()) @map("created_at"), updatedAt @updatedAt @map("updated_at"), @@map("message_channels")）与 `model MessageDelivery`（id, channelId FK message_channels Cascade, externalId VarChar128? @map("external_id"), direction VarChar8 @default("inbound"), status VarChar16, kind VarChar32?, error VarChar512?, payload Json?, meta Json?, createdAt @default(now()) @map("created_at"), @@unique([channelId, externalId]), @@index([channelId, createdAt]), @@map("message_deliveries")）；新增 `model NotificationChannel`（id, name, type[webhook|wecom_group_robot], config Json{targetUrl,events}, secrets Json{secret}, enabled, lastStatus/lastError, createdAt/updatedAt, @@map("notification_channels")）与 `model NotificationDelivery`（同 MessageDelivery 结构，direction @default("outbound"), @@map("notification_deliveries")）；新增关联表 `model TaskMessageChannel`（taskId String FK tasks Cascade, messageChannelId String FK message_channels Cascade, @@unique([taskId, messageChannelId]), @@index([taskId]), @@map("task_message_channels")）与 `model TaskNotificationChannel`（taskId, notificationChannelId, @@unique([taskId, notificationChannelId]), @@map("task_notification_channels")）；Task 通过关联表多对多关联，不再直连 channel。新建迁移 `npx prisma migrate dev --name split_channels_notifications`（含删旧表重建新表）。Must NOT do: 不保留旧 IntegrationChannel 表/字段，不做数据迁移脚本，不在渠道/通知表上存 taskId。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 全部
  References: server/prisma/schema.prisma:782-824（旧模型待删）、server/src/common/id-generator.ts:17-46（mc_/nc_/md_/nd_ 前缀约定）、docs/agent-platform/15-数据模型细化
  Acceptance criteria: `npx prisma validate` 通过；`npx prisma migrate dev` 生成含 DropTable/CreateTable 的迁移；`npm run build` 通过。
  QA scenarios: happy=迁移后 `prisma.messageChannel` / `notificationChannel` delegate 可建删；failure=旧表名查询 404。Evidence `.omo/evidence/task-1-integrations-refactor.md`
  Commit: Y | feat(prisma): 推倒重建 MessageChannel/NotificationChannel 双模型

- [x] 2. 领域常量与适配器框架拆分
  What to do / Must NOT do: 删 `server/src/integrations/integrations.constants.ts`；新建 `server/src/message-channels/message-channel.constants.ts`（MESSAGE_CHANNEL_TYPES={generic_webhook,wecom_aibot,github_webhook,gitee_webhook} as const, MESSAGE_CHANNEL_ID_PREFIX='mc_', MESSAGE_DELIVERY_PREFIX='md_') 与 `server/src/notifications/notification.constants.ts`（NOTIFICATION_TYPES={webhook:'webhook', wecom_group_robot:'wecom_group_robot'} as const, NOTIFICATION_ID_PREFIX='nc_', NOTIFICATION_DELIVERY_PREFIX='nd_', NOTIFICATION_EVENTS={TASK_STATUS_CHANGED:'task.status_changed', AGENT_REPLY:'agent.reply', AGENT_QUESTION:'agent.question'} as const）。新建 `server/src/message-channels/message-adapter.ts`（export interface MessageChannelResolved, type InboundCommand=post_message|card_action, abstract class MessageAdapter {abstract readonly type; verifyInbound?(req, ch):Promise<void>; abstract normalizeInbound(req,ch):Promise<InboundCommand[]>; start?(ctx:MessageHost):Promise<void>; stop?():Promise<void>; registerStreamCorrelation?(...)}；interface MessageHost {submitInbound(channelId, cmds):Promise<...>; getChannel(id):Promise<MessageChannelResolved|null>; updateChannelRuntime(...); requestStop(...)}）与 `server/src/notifications/notification-adapter.ts`（interface NotificationChannelResolved, interface OutboundMessage{kind,text,title?,actions?}, abstract class NotificationAdapter {abstract readonly type; abstract sendOutbound(ch, msg):Promise<{externalId} >}）。各自独立 DI token `MESSAGE_ADAPTERS` / `NOTIFICATION_ADAPTERS`。新建 `MessageRegistry` / `NotificationRegistry`（仿旧 ChannelRegistry 但各自 Map<type,Adapter>，各自 startEnabled 仅查各自表）。Must NOT do: 不保留旧 CHANNEL_ADAPTERS token。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,6,7
  References: server/src/chat/message-dispatcher.ts:73-123（抽象 DI 先例）、server/src/integrations/channel-adapter.ts（旧版待删，作反例）
  Acceptance criteria: `npm run build` 通过；`grep -r "MESSAGE_ADAPTERS.*NOTIFICATION_ADAPTERS" server/src` 均存在且旧 CHANNEL_ADAPTERS 不再被引用。
  QA scenarios: happy=各自 Registry type 冲突抛错；failure=启动时 enabled=false 不 start。Evidence `.omo/evidence/task-2-integrations-refactor.md`
  Commit: Y | feat(integrations): 拆分消息/通知常量与适配器抽象及双注册表

- [x] 3. 入站管道瘦身为 MessageInboundService（仅收，任务绑定改为关联表）
  What to do / Must NOT do: 新建 `server/src/message-channels/message-inbound.service.ts`（原 inbound.service.ts 瘦身版）：仅处理 MessageChannel，删所有 direction/taskId 直连分支，`submitInbound` 仅 post_message/card_action → 先查 `TaskMessageChannel` 关联表 `findMany where messageChannelId=channel.id` 取得所有绑定 taskIds（若为空则 log skipped “no tasks bound”），对每个 taskId 循环：MessageDelivery.tryBeginIngest(md_, dedupKey+taskId 组合去重) → MessageDelivery.finish/log → chatService.createMessage(对应 task 的 task_group 频道, external) / questionsService.reply；`SENDER_TYPE.external` 保留（已加）。配套 `server/src/message-channels/message-delivery.service.ts`（仅 md_ 前缀，isUniqueViolation 保留 external_id 判定 + log 的 P2002 吞并）。删旧 `server/src/integrations/inbound.service.ts` / `channel-delivery.service.ts` 的 outbound 相关逻辑。Must NOT do: 不读 MessageChannel.taskId（已删），不触及 Notification 侧。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,6,7
  References: server/src/integrations/inbound.service.ts:138-310（旧版待重构）、server/src/integrations/channel-delivery.service.ts:51-130
  Acceptance criteria: `npm test -- message-inbound` 绿：post_message 落群聊 external，card_action 权限校验，重复幂等。
  QA scenarios: happy=合法 inbound ok；failure=重复 externalId skipped。Evidence `.omo/evidence/task-3-integrations-refactor.md`
  Commit: Y | feat(message-channels): 入站管道瘦身仅收

- [x] 4. 出站分发瘦身为 NotificationDispatcher（仅发，任务绑定改为关联表）
  What to do / Must NOT do: 新建 `server/src/notifications/notification-dispatcher.service.ts`（原 outbound-dispatcher 瘦身）：仅订阅 RealtimeService bus，过滤 `TASK_STATUS_CHANGED/agent.reply/agent.question`，对事件中的 `payload.taskId` 查 `TaskNotificationChannel` 关联表取得该任务绑定的 notificationChannelIds，再查 `notification_channels` where id IN (ids) && enabled && config.events 命中，按 per-channel 串行队列调 `NotificationAdapter.sendOutbound`，写 `NotificationDelivery` log。删 outbound 中对 MessageChannel 的查询与 registerQuestionHandler 中对 MessageChannel 的适配，question 卡片改为经 NotificationAdapter（wecom_group_robot 暂不支持卡片则降级文本）。配套 `notification-delivery.service.ts`（nd_ 前缀，listByChannel 游标分页）。Must NOT do: 不再查 NotificationChannel.taskId（已删），不再处理 direction。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,6,7
  References: server/src/integrations/outbound-dispatcher.service.ts:1-80、server/src/realtime/realtime.service.ts:180-204
  Acceptance criteria: `npm test -- notification-dispatcher` 绿：task статус 变更仅推订阅的 notification 渠道。
  QA scenarios: happy=事件推 webhook 收到签名头；failure=未订阅事件不推。Evidence `.omo/evidence/task-4-integrations-refactor.md`
  Commit: Y | feat(notifications): 出站分发仅发

- [x] 5. 适配器拆分：入站四适配器与出站两适配器
  What to do / Must NOT do: 新建 `server/src/message-channels/adapters/generic-webhook-inbound.adapter.ts`（type=generic_webhook, 仅 inbound verify x-vteam-signature + normalize：支持 `config.fieldMapping: {content: string, source: string, user: string}` 三字段模板，模板内 `{{ path }}` 按 JSONPath 从来源 JSON 提取（如 `{{ body.content }}`, `{{ user.name }}`），渲染后 `text = [source] user: content` 拼装），并新增工具 `server/src/message-channels/field-template.util.ts`（`renderFieldTemplate(template: string, data: any): string` 实现 `{{ path }}` 提取，支持嵌套路径 `a.b.c`，缺失返回空串）、`github-webhook.adapter.ts`（验 X-Hub-Signature-256 + X-Github-Event 分支拼 text）、`gitee-webhook.adapter.ts`（验 X-Gitee-Token + X-Gitee-Event）、`wecom-aibot.adapter.ts`（WS 长连接收 + replyStream占位/finish，保留原 wecom 逻辑仅删 sendOutbound 的 question_card 分支中对 MessageChannel 的依赖）；新建 `server/src/notifications/adapters/webhook-notification.adapter.ts`（type=webhook, 仅 POST targetUrl + HMAC）、`wecom-group-robot.adapter.ts`（POST 群机器人 webhook）。删旧 `server/src/integrations/adapters/generic-webhook.adapter.ts` / `wecom-aibot.adapter.ts` 的混合逻辑。更新 `IdGenerator` 前缀使用 `mc_/md_/nc_/nd_`。Must NOT do: 不在 MessageAdapter 中实现 sendOutbound，不在 NotificationAdapter 中实现 verifyInbound。
  Parallelization: Wave 2 | Blocked by: 2,3,4 | Blocks: 6,7,8
  References: server/src/integrations/adapters/generic-webhook.adapter.ts:36-120、server/src/integrations/adapters/wecom-aibot.adapter.ts:1-100、https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries（hmac sha256= 前缀）
  Acceptance criteria: `npm test -- github-webhook`（向量 secret=It's a Secret... payload=Hello,World! → sha256=757107...）绿；`npm test -- gitee-webhook` 绿；`npm test -- generic-webhook` 字段模板 `{{ body.content }}` 抽取渲染绿；`npm test -- webhook-notification` 出站签名头正确。
  QA scenarios: happy=GitHub push 事件验签通过拼出文本；failure=错签 401。Evidence `.omo/evidence/task-5-integrations-refactor.md`
  Commit: Y | feat(adapters): 拆分入站/出站适配器

- [x] 6. REST API 拆分：双控制器与任务级绑定接口
  What to do / Must NOT do: 新建 `server/src/message-channels/message-channels.controller.ts`（路由 `/api/v1/message-channels`，GET list/detail（secrets 掩码 ***）、POST/PATCH/DELETE/POST :id/enable|:id/disable/GET :id/deliveries/POST :id/test-send，DTO 中不再含 taskId，type 限四类，secrets 掩码），`server/src/message-channels/message-channels.module.ts`（imports [RealtimeModule, ChatModule, QuestionsModule]，providers 消息侧四适配器 + 双服务 + 双注册表）；新建 `server/src/notifications/notification-channels.controller.ts`（路由 `/api/v1/notification-channels`，同上但 config 含 targetUrl/events 必填校验，type 限 webhook/wecom_group_robot），`notification-channels.module.ts`。新增任务级绑定接口：`POST /api/v1/tasks/:taskId/message-channels`（body {messageChannelIds: string[]} 批量覆盖式绑定，校验每个 channel 存在）与 `GET /api/v1/tasks/:taskId/message-channels`（查询已绑定渠道）、同理 `POST/GET /api/v1/tasks/:taskId/notification-channels`，由 `TasksModule` 或各自 Module 提供，操作 `TaskMessageChannel` / `TaskNotificationChannel` 关联表。删旧 `server/src/integrations/integrations.controller.ts` / `integrations-inbound.controller.ts` / `integrations.module.ts` 的混血路由（inbound 统一路由改为 `/api/v1/message-channels/:id/inbound` 仅消息侧）。`AppModule` 改注册 `MessageChannelsModule` + `NotificationChannelsModule`。旧 `/api/v1/integrations/channels` 路由徹底移除（不做兼容重定向）。
  Parallelization: Wave 3 | Blocked by: 1,2,3,4,5 | Blocks: 7,8
  References: server/src/mcp-servers/mcp-servers.controller.ts（CRUD 样板）、server/src/integrations/integrations.controller.ts（旧版待删）
  Acceptance criteria: `npm run build` 通过；`npm test -- message-channels` 与 `notification-channels` 各自 CRUD 掩码校验绿（message-channels 创建无需 taskId，notification 创建需 targetUrl）；`POST /api/v1/tasks/:taskId/message-channels` 绑定与查询绿；旧 /integrations 路由 404。
  QA scenarios: happy=message channel 创建无需 taskId 成功，notification 未填 targetUrl 400；failure=绑定不存在的 channelId 404。Evidence `.omo/evidence/task-6-integrations-refactor.md`
  Commit: Y | feat(api): 拆分消息/通知双控制器与必填校验

- [x] 7. 前端双 Tab 重做 + 任务侧绑定入口
  What to do / Must NOT do: 重写 `web/app/(main)/integrations/page.tsx` 为双 Tab 布局（Tabs 组件或自制 pill 切换，state activeTab: 'channels'|'notifications'）：`MessageChannelsTab`（列表卡片 name/type/enabled，入站地址只读行 `POST /api/v1/message-channels/{id}/inbound` + 复制按钮，secret 输入，type 下拉四类，通用 webhook 类型时显示字段抽取配置 `fieldMapping: {content, source, user}` 三输入框（`{{ path }}` 模板，如 `{{ body.content }}`），创建/编辑不再含任务选择，deliveries 抽屉）与 `NotificationChannelsTab`（列表卡片 name/type/targetUrl 掩码/enabled，表单字段 targetUrl 必填 + events 多选 + secret）。删旧 direction 切换、旧 targetUrl 条件显隐、旧任务级联必选。新增任务侧入口：`web/app/(main)/tasks/new/page.tsx`（创建表单右侧或底部增加“消息渠道 / 通知渠道”多选区，GET /message-channels 与 /notification-channels 拉取全局列表，提交时随任务创建后调 POST /tasks/:id/message-channels 与 notification-channels 批量绑定）与 `web/app/(main)/tasks/[id]/page.tsx` 右侧边栏（或设置抽屉）增加“渠道与通知”设置入口（显示已绑定渠道/通知，支持多选变更，调同一绑定接口，变更后提示“已更新绑定”）。`AppShell` 侧边栏保持单入口 “集成渠道” 指向 /integrations（页内再分 Tab），无需新增导航项。Must NOT do: 不再出现 direction 字段，不在渠道/通知创建表单中出现任务选择。
  Parallelization: Wave 3 | Blocked by: 1,2,3,4,5 | Blocks: 8
  References: web/app/(main)/integrations/page.tsx（旧版 1276 行待重写）、web/app/(main)/skills/page.tsx（MCP 区块形态）、web/src/components/layout/nav-dock.tsx（单入口保持）
  Acceptance criteria: `cd web && npm run build` 通过且 `/integrations` 11kB 左右；`grep -c "message-channels" integrations/page.tsx` 与 `notification-channels` 均 >0；`data-testid` 保留 `integration-channel-item` 并新增 `notification-channel-item`。
  QA scenarios: happy=切换 Tab 各自列表空态正确；failure=渠道 Tab 不出现 targetUrl 输入。Evidence `.omo/evidence/task-7-integrations-refactor.md`
  Commit: Y | feat(web): 集成页拆双 Tab

- [x] 8. 清理旧代码 + 文档重写 + 全量回归
  What to do / Must NOT do: 删 `server/src/integrations` 整个旧目录（若已迁则确认无残留 `integrations.constants.ts` 引用）、删旧前端 `direction` 相关残留分支、跑 `grep -r "integrations/channels" server --include="*.ts"` 应仅剩历史注释或 0；重写 `docs/agent-platform/27-外部渠道集成设计.md` 为拆分后架构（双模型 ER 图、双适配器契约、双时序图），`_meta.md` 标题不变；跑全量门禁 `cd server && npm run lint && npm test && npm run build`、`cd web && npm run build` 绿。Must NOT do: 不改 01-26 文档，不保留旧 direction 兼容代码。
  Parallelization: Wave 4 | Blocked by: 5,6,7 | Blocks: —
  References: docs/agent-platform/27-外部渠道集成设计.md（旧版 34kB 待重写）、docs/agent-platform/_meta.md
  Acceptance criteria: 旧 `integrations/channels` 路由彻底 404，`grep` 无残留；门禁全绿。
  QA scenarios: happy=门禁绿；failure=任一红修复。Evidence `.omo/evidence/task-8-integrations-refactor.md`
  Commit: Y | chore(integrations): 清理旧混血代码并重写设计文档

## Final verification wave

> Runs in parallel after ALL todos. ALL must APPROVE.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy

- 每 Todo 一个原子 commit；类型 feat/docs/chore，scope=prisma/message-channels/notifications/adapters/api/web
- 不做 squash；分支建议 `refactor/split-channels-notifications`

## Success criteria

1. `POST /api/v1/message-channels` 无需 taskId 即可创建（渠道全局定义），`POST /api/v1/tasks/:taskId/message-channels` 批量绑定生效，旧 `/api/v1/integrations/channels` 404
2. `POST /api/v1/notification-channels` 未填 targetUrl 400，绑定同上通过任务关联表生效
3. GitHub webhook 用官方向量验签通过且 push 事件落群聊 external 消息，Gitee 同理；通用 webhook 按 `fieldMapping` 抽取 `content/source/user` 模板渲染后落群聊（`{{ body.content }}` 等）
4. 任务创建页与任务详情右侧均可多选绑定消息渠道/通知渠道，互不干扰，出站仅按任务绑定的 notification 的 events 推送
5. 前端 /integrations 双 Tab 各自可用（不再出现任务选择），入站 Tab 只展示入站地址，出站 Tab 只填目标地址
6. 全量门禁绿
