# channel-integrations - Work Plan

## TL;DR (For humans)

**What you'll get:** vteam 获得一套「外部渠道集成」能力：管理员在设置页创建两类渠道——通用 Webhook 和企业微信智能机器人（微信长连接模式，无需公网 IP）。之后团队成员可以直接在企微群里 @机器人 给任务下指令、收到流式进度与最终结果；Agent 执行中遇到的权限确认和提问会以可点击按钮的卡片推到群里，点一下即可远程批准；任务状态变更可自动推送通知；任何外部系统（Jenkins、监控）都能通过带签名的 webhook 收发指令。Agent 自己也能在对话中主动通过 `channel_send` 工具向渠道喊人。

**Why this approach:** 类型判别式配置 + 双形态适配器注册表（HTTP 端点型/连接生命周期型），新增钉钉/飞书只需加一个适配器类；入站统一归一化后走既有群聊分派链路、出站订阅既有实时事件流——核心业务模块零改动。

**What it will NOT do:** 不做逐字打字机式流式输出；不做投票卡片/语音视频等其它富交互；不做规则引擎与 `/task` 命令语法；不做插件热加载市场。

**Effort:** Large
**Risk:** Medium - 依赖企微官方 SDK 的长连接稳定性与单连接约束（已内置单例守护与降级路径）
**Decisions to sanity-check:** ①企微仅做长连接模式（回调 URL 模式不做）；②managedMode 任务不推审批卡（主 Agent 自动确认）；③出站事件默认只开「状态变更+审批卡片」，Agent 回复推送默认关闭可在渠道配置打开。

Your next move: approve 后用 `$start-work` 启动执行。Full execution detail follows below.

---

> TL;DR (machine): effort=Large, risk=medium; deliverables=integrations 模块（schema×2 表+迁移、适配器框架、入站管道、出站分发器、审批卡片闭环）、2 个适配器（generic-webhook、wecom-aibot 长连接）、admin REST+前端设置页、platform-mcp channel_send 工具、SENDER_TYPE.external、设计文档 27 篇。

## Scope

### Must have

- Prisma 新表 `IntegrationChannel`（ic_ 前缀）与 `IntegrationChannelDelivery`（cd_ 前缀）+ 迁移 + Task 反向关系 + id 前缀续号种子
- 渠道适配器框架：`ChannelAdapter` 抽象（双能力面 verifyInbound/normalizeInbound 与 start/stop）+ DI 注册表 + host 注入
- 入站管道：验签 → 归一化命令（post_message / card_action）→ (channelId, externalId) 幂等去重 → 路由执行
- 适配器① generic-webhook：HMAC-SHA256 验签入站 + 出站带签 POST targetUrl
- 适配器② wecom-aibot：`@wecom/aibot-node-sdk` WebSocket 长连接（BotID+Secret），收指令即时回流式占位、终态 finish=true 替换、sendMessage 主动推送、模板卡片按钮交互、连接健康上报、per-channel 单例守护
- 出站分发器：订阅 RealtimeService 总线，按渠道 events 开关过滤（task.status_changed / agent.reply / agent.question），每渠道路由到适配器发送并写投递日志
- 审批卡片闭环：AGENT_QUESTION → button_interaction 卡片（!managedMode 且 pending 且任务有绑定渠道）→ 卡片按钮事件 → 校验 → 复用 QuestionsService.reply 解除阻塞 → 5s 窗内 updateTemplateCard 回写
- 平台 MCP 新工具 `channel_send(channelIdOrName, text)`
- 管理 REST API：CRUD/启停/test-send/投递日志分页（secrets 全程脱敏，写合并读掩码）
- 前端「集成渠道」设置页（对齐 skills 页 MCP 区块形态）：列表/新建/编辑凭据/启停/测试发送/投递日志查看；群聊 external 消息来源徽章
- `SENDER_TYPE.external` 枚举扩展（服务端常量+校验链路审计+web 徽章渲染）
- 设计文档 `docs/agent-platform/27-外部渠道集成设计.md` + `_meta.md` 索引

### Must NOT have (guardrails, anti-slop, scope boundaries)

- ❌ 不修改 ChatService/TasksService/QuestionsService 的既有行为语义（仅允许 ChatService.createMessage 增加可选 actor 参数且缺省行为不变；其余为旁路订阅/前置适配层）
- ❌ 不做插件热加载、插件包机制、插件市场
- ❌ 不做逐字 LLM 流转发到 IM（replyStream 仅用于占位 ACK 与终态替换两帧）
- ❌ 不做 button_interaction 以外的卡型、不做投票/图文混排/媒体消息收发
- ❌ 不做 n8n 式规则引擎、不做 `/task create` 命令语法解析器、不做项目级 bindings 规则表
- ❌ 不做企微回调 URL 模式（Token/AESKey/echostr 一律不实现）、不做经典群机器人适配器（roadmap）
- ❌ 不做多副本分布式选主实现（仅代码注释记录约束与扩展点）
- ❌ 不引入新数据库之外的存储（内存映射允许，重启丢失走降级路径）

## Verification strategy

> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after（纯函数逻辑优先 TDD：签名验算、button key 解析、事件过滤）；框架=jest（对齐现有 `*.spec.ts` 同目录惯例）+ supertest e2e（对齐 `server/test/app.e2e-spec.ts`）
- Evidence: `.omo/evidence/task-<N>-channel-integrations.md`（每任务记录执行的命令与关键断言输出摘要）
- 全量回归门槛：`cd server && npm run lint && npm test && npm run build`；涉及 web 的任务加 `cd web && npm run build`

## Execution strategy

### Parallel execution waves

- Wave 1（地基）: Todo 1（schema/迁移/常量）
- Wave 2（框架+webhook 闭环）: Todo 2、3、4、5（2→3/4 并行，5 依赖 2+3+4）
- Wave 3（企微适配器）: Todo 6、7（串行）
- Wave 4（出站+卡片）: Todo 8、9（9 依赖 7+8）
- Wave 5（管理面+生态）: Todo 10、11、12（并行）、13（收尾）

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,4,5,6,7,8,9,10,11,12 | — |
| 2 | 1 | 5,6,7,8,9 | 3,4 |
| 3 | 1 | 5,6,8,9 | 2,4 |
| 4 | 1 | 5,9 | 2,3 |
| 5 | 2,3,4 | 13 | 6 |
| 6 | 2,3,4 | 7,9 | 5 |
| 7 | 6 | 9 | 10 |
| 8 | 2,3 | 9,12 | 5,6 |
| 9 | 4,7,8 | 13 | 10,11,12 |
| 10 | 1,3 | 11 | 5,6,7,8,12 |
| 11 | 10 | — | 其余全部 |
| 12 | 8 | 13 | 其余全部 |
| 13 | 5,9,12 | — | — |

## Todos

- [x] 1. 数据模型与领域常量：IntegrationChannel/Delivery 两表 + 迁移 + 常量基座
  What to do / Must NOT do: 在 `server/prisma/schema.prisma` 追加两个模型（字段定义见下），Task 模型追加反向关系 `integrationChannels IntegrationChannel[]`；生成迁移 `npx prisma migrate dev --name integration_channels`；新建 `server/src/integrations/integrations.constants.ts` 导出：`CHANNEL_TYPES={generic_webhook,wecom_aibot}`、`CHANNEL_DIRECTIONS={in,out,inout}`、`DELIVERY_DIRECTIONS={inbound,outbound}`、`DELIVERY_STATUS={ok,failed,rejected,skipped}`、`COMMAND_KINDS={post_message,card_action}`、`OUTBOUND_EVENTS={TASK_STATUS_CHANGED:'task.status_changed',AGENT_REPLY:'agent.reply',AGENT_QUESTION:'agent.question'}`、`INTEGRATIONS_ERRORS`（CHANNEL_NOT_FOUND/CHANNEL_TYPE_INVALID/TASK_NOT_BOUND/SIGNATURE_INVALID/RATE_LIMITED 等）、adapter DI token 常量 `CHANNEL_ADAPTERS`。Must NOT do: 不改任何既有表的列。
  字段规格：IntegrationChannel{id String @id, name VarChar(64), type VarChar(32), direction VarChar(8) 默认'in', taskId String?（FK tasks, onDelete Cascade）, config Json @default("{}"), secrets Json @default("{}"), enabled Boolean 默认 true, lastStatus VarChar(16)?, lastError VarChar(512)?, createdAt/updatedAt}，索引 @@index([taskId])；IntegrationChannelDelivery{id String @id, channelId String FK, direction VarChar(8), externalId String?, status VarChar(16), kind VarChar(32)?, error VarChar(512)?, payload Json?, meta Json?, createdAt}，约束 @@unique([channelId, externalId])（注意 MySQL 唯一键对 NULL 不去重——externalId 为空的行不参与幂等，属预期）、@@index([channelId, createdAt])。
  Parallelization: Wave 1 | Blocked by: — | Blocks: 全部
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:42(Task 起)/602(McpServer 判别式先例)/758(AgentQuestion)；server/src/common/id-generator.ts:17-46（前缀约定）；server/src/chat/chat.service.ts:159-163（onModuleInit seedPrefix 续号先例）；server/src/common/id-resync.ts（resyncIdPrefix 若存在则复用）
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate dev --name integration_channels` 成功产出迁移且 `npx prisma validate` 通过；`npm run build` 通过。
  QA scenarios (name the exact tool + invocation): happy=`npx prisma migrate dev` 后 `npx prisma studio` 不可用时改用 `node -e` 经 PrismaClient 建删各一行验证列存在；failure=插入重复 (channelId,externalId) 断言 P2002。Evidence `.omo/evidence/task-1-channel-integrations.md`
  Commit: Y | feat(integrations): 渠道与投递日志数据模型及领域常量

- [x] 2. 适配器框架：ChannelAdapter 抽象、DI 注册表与 host 注入
  What to do / Must NOT do: 新建 `server/src/integrations/channel-adapter.ts`：导出 `ChannelResolved`（{id,type,direction,taskId,config:Record<string,any>,secrets:Record<string,any>,enabled}）、`OutboundMessage`（{kind:'markdown'|'text'|'question_card'; title?; text; actions?:{key,label}[]; aqId?}）、`InboundCommand` 联合类型（post_message{text,senderExternalId?,senderName?,dedupKey} | card_action{aqId,action,operatorExternalId?}）、抽象类 `ChannelAdapter`（abstract readonly type; supportsInbound/supportsOutbound 标志位; 可选 `verifyInbound(req,channel)`、`handleHandshake(req,res,channel):Promise<boolean>` 缺省 false、abstract `normalizeInbound(req,channel)`、可选 `start(ctx:AdapterHost)`/`stop()`、abstract `sendOutbound(channel,msg):Promise<{externalId:string|null;meta?}>`）、`AdapterHost` 接口（{submitInbound(channelId,commands):Promise<{results:Array<{ok:boolean;internalMessageId?:string}>}>; getChannel(id):Promise<ChannelResolved|null>; updateChannelRuntime(id,patch:{lastStatus?,lastError?,configMerge?}):Promise<void>; requestStop(channelId):Promise<void>}）；抽象类另含可选 `registerStreamCorrelation?(internalMessageId:string, ref:{channelId:string; frameHeaders:unknown; streamId:string}):void`（generic-webhook 无需实现）。新建 `server/src/integrations/channel-registry.service.ts`：`@Inject(CHANNEL_ADAPTERS) adapters: ChannelAdapter[]` 注入收集，`OnModuleInit` 中按 type 建 Map 并对每个适配器调用 `attach(host)`（构造注入会形成环——注册表实现 AdapterHost 并提供 `bind(adapter)` 方法把 host 交给适配器，禁止适配器构造器注入 InboundService）；暴露 `get(type)`/`all()`/`async startEnabled()`（查库 enabled=true 且有 start 的适配器逐个 start，单个失败记日志不中断）/`onModuleDestroy` 逆序 stop。在 `IntegrationsModule`（Todo 10 建文件，本任务先建空壳 module 仅含本 provider）providers 中以 `{provide:CHANNEL_ADAPTERS,useFactory:()=>[new GenericWebhookAdapter(),new WecomAibotAdapter()]...}` 占位注释标注后续接入。Must NOT do: 适配器内不得直接注入 PrismaService/RealtimeService（一律经 host/ctx）。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,6,7,8,9
  References: server/src/chat/message-dispatcher.ts:73-123（抽象类+DI token 替换先例）；server/src/chat/chat.module.ts（providers 绑定方式）；server/src/tasks/tasks.module.ts:27-33
  Acceptance criteria: `cd server && npm test -- channel-registry` 绿：注册表收集、type 冲突报错、startEnabled 对 disabled/start 异常的容错（fake adapters 单测）。
  QA scenarios: happy=两个 fake adapter 注册并 start 被调；failure=start 抛错时其余仍启动且错误入日志。Evidence `.omo/evidence/task-2-channel-integrations.md`
  Commit: Y | feat(integrations): 渠道适配器抽象与注册表

- [x] 3. 投递日志服务：幂等去重 + 记录 + 分页查询
  What to do / Must NOT do: 新建 `server/src/integrations/channel-delivery.service.ts`：方法 `tryBeginIngest(channelId, externalId): Promise<{duplicate:boolean}>`（externalId 非空时 insert status=in_progress 行捕获 P2002 → duplicate=true；空 externalId 直接放行）、`finish(id,status,error?,payload?,meta?)`、`log(direction,kind,status,{channelId,externalId?,error?,payload?,meta?})`（一次性记录，用于 outbound/rejected）、`listByChannel(channelId,{cursor,limit})`（id 游标倒序，复用 messages 分页模式）；onModuleInit 用 resync/seedPrefix 对齐 `ic_`/`cd_` 最大序号（若采用 common/id-resync.ts 则复用，否则仿 ChatService.seedPrefix 查 max）。Must NOT do: 不在服务外散落 Prisma.delivery 直写。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,6,8,9
  References: server/prisma/schema.prisma:253(Message)/660(RealtimeEvent)；server/src/chat/chat.service.ts:224-244（游标分页先例）；server/src/common/id-resync.ts；server/src/realtime/realtime.service.ts:66-75（seed 先例）
  Acceptance criteria: `npm test -- channel-delivery` 绿：同 externalId 二次 tryBeginIngest 返回 duplicate=true；不同 channelId 相同 externalId 不冲突；finish 更新状态。
  QA scenarios: happy+failure 如上；Evidence `.omo/evidence/task-3-channel-integrations.md`
  Commit: Y | feat(integrations): 投递日志与幂等服务

- [x] 4. 入站管道与路由：InboundService + SENDER_TYPE.external + ChatService 可选 actor
  What to do / Must NOT do: 新建 `server/src/integrations/inbound.service.ts` 实现 AdapterHost.submitInbound：遍历命令 → 先 getChannel 校验（null 或 !enabled → 记 skipped 日志并调 `requestStop(channelId)` 清理孤儿连接——覆盖任务级联删除渠道后 WS 仍挂着的边界）→ post_message：解析绑定任务的群聊频道（prisma.chatChannel.findFirst({where:{taskId,type:'task_group'},orderBy:{createdAt:'asc'}})，缺失→rejected 日志）→ 调 `chatService.createMessage(channelId, actor…)`（见下）content={text}, senderType='external', senderId=null；card_action：`prisma.agentQuestion.findUnique({where:{id:aqId}})` 校验存在/status=pending/kind 与 action 匹配/question 未过 QUESTION_PENDING_TTL_MS/所属任务===channel.taskId，然后调 `questionsService.reply(...)`（执行时以该服务实际签名为准：permission approve/reject → 对应 PermissionResponse；question 选项 → answers 结构），成功后经 host 回调让适配器更新卡片（通过 delivery.meta 存 {cardUpdate:{frameReqId,streamTaskId}} 由 Todo 9 消费）。`server/src/common/constants/event.constants.ts:48-54` SENDER_TYPE 增加 `external:'external'`，并 grep 全部 SENDER_TYPE 引用点逐一确认无枚举白名单拒绝（重点 workers/worker-event.ingress、plans、tasks 的 sysMessage 生成处——只读确认，不改行为）。`server/src/chat/chat.service.ts` createMessage 增加末尾可选参数 `actor?: {senderType:'user'|'external'; senderId:string|null}`，缺省行为完全不变（现调用方零改动）；其内部写库与分派目标计算照旧。Must NOT do: 不改 createMessage 既有参数顺序/默认行为；不动 QuestionsService 内部逻辑（只调用其公开方法）。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,9
  References: server/src/common/constants/event.constants.ts:48-54；server/src/chat/chat.service.ts（createMessage 及分派触发段）；server/src/questions/questions.service.ts（reply 公开方法、ReplyQuestionDto、PermissionResponse、QUESTION_PENDING_TTL_MS）；server/src/workers/worker-event.ingress.ts:703-817（aqId/requestId 语义）
  Acceptance criteria: `npm test -- inbound` 绿（mock prisma/questionsService）：post_message 落群聊并以 external 发件人建消息；card_action 命中 pending 时调用了 reply；非 pending/跨任务/过期 → rejected 日志且未调 reply。
  QA scenarios: happy=合法 card_action 调 reply 一次；failure=aq 已 answered → rejected。Evidence `.omo/evidence/task-4-channel-integrations.md`
  Commit: Y | feat(integrations): 入站命令管道与 external 发件人支持

- [x] 5. GenericWebhook 适配器 + @Public 入站端点（首个渠道全链路贯通）
  What to do / Must NOT do: 新建 `server/src/integrations/adapters/generic-webhook.adapter.ts`（type='generic_webhook', supportsInbound=supportsOutbound=true；config:{targetUrl?,events?:string[]}；secrets:{secret}）。verifyInbound：读原始 body 文本——**原始字节获取是硬前提**：检查 `server/src/main.ts` 的 HTTP 适配器，若为 Express（Nest 默认）则将启动改为 `NestFactory.create(AppModule, { rawBody: true })` 并在控制器经 `request.rawBody` 取原始字节；若为 Fastify 则经 `contentTypeParser` 为 `application/json` 添加 raw 缓冲（二选一，以 main.ts 实际为准；签名 e2e 是最终兜底验证）。比对 `x-vteam-signature` 头 === `sha256=<hmacSha256Hex(secret, rawBody)>` 且 `x-vteam-timestamp` 与服务器时间差 ≤300 秒，失败抛 UnauthorizedException(INTEGRATIONS_ERRORS.SIGNATURE_INVALID)。normalizeInbound：JSON {text:string(≤8000字), sender?{id?,name?}} → post_message 命令，dedupKey=请求头 `x-vteam-event-id` ?? sha1(rawBody)。sendOutbound：POST config.targetUrl，body {event:msg.kind, taskId, title?, text, ts}，头 `x-vteam-signature` 同算法（secret 为 key），targetUrl 未配置→抛错记 failed；单次尝试不重试（注释注明对接方应幂等）。新建 `server/src/integrations/integrations-inbound.controller.ts`：`@Public()` 路由 `ALL /api/v1/integrations/channels/:id/inbound`（GET→handleHandshake 无实现返回 405；POST→registry 取 channel→adapter.verifyInbound→normalizeInbound→host.submitInbound→200 {ok:true}；全程异常→401/400 并 rejected 日志）。注意该控制器需绕过 ProjectMembershipGuard（全局守卫叠加检查 main.ts/AppModule 实际挂载方式后用 @Skip 守卫装饰器或独立 HostModule 挂载——以仓内 @Public 同级机制为准，勿新造机制）。Must NOT do: 不实现重试队列；不在响应体回显 secret。
  Parallelization: Wave 2 | Blocked by: 2,3,4 | Blocks: 13
  References: server/src/auth/guards/jwt-auth.guard.ts:22-31（@Public 放行）；server/src/auth/decorators/public.decorator.ts；server/src/main.ts（全局管线/bodyParser 配置——rawBody 获取方式据此定）；server/test/app.e2e-spec.ts（e2e 样板）
  Acceptance criteria: e2e `npm run test:e2e -- inbound-webhook` 绿：正确签名+时间戳→200 且任务群聊出现 external 消息（断言 mock Dispatcher.dispatch 被调或消息落库）；错签→401；过期时间戳→401；重复 x-vteam-event-id→200 且消息仅一条。单测覆盖签名向量（固定 secret/body 的已知 HMAC hex）。
  QA scenarios: happy/failure 如上；Evidence `.omo/evidence/task-5-channel-integrations.md`
  Commit: Y | feat(integrations): 通用 webhook 渠道适配器与入站端点

- [x] 6. WecomAibot 适配器（上）：SDK 长连接生命周期 + 收指令 + 流式占位
  What to do / Must NOT do: `cd server && npm i @wecom/aibot-node-sdk`。新建 `server/src/integrations/adapters/wecom-aibot.adapter.ts`（type='wecom_aibot', supportsInbound=supportsOutbound=true；config:{}；secrets:{botId,secret}）。start(ctx)：单例守护（实例 Map<channelId,WSClient>，已存在即抛错防踢线）→ `new AiBot.WSClient({botId,secret,maxReconnectAttempts:-1})` → connect() → 监听 `message.text`（image/mixed/voice/file v1 忽略并回执"暂不支持的消息类型"流式终态）→ 组装 post_message{text:frame.body.text.content 去除 @机器人前缀, senderExternalId:frame.body.from.userid, senderName:'', dedupKey:frame.body.msgid} → `const {results} = await ctx.submitInbound(...)` → 取首个成功结果的 internalMessageId 调用 `this.registerStreamCorrelation(internalMessageId, {channelId, frameHeaders:frame.headers, streamId})`（pendingStreams Map 以内部消息 id 为 key，LRU 上限 100 条，溢出丢弃并降级）；监听 `connected/authenticated/disconnected/reconnecting/error` → ctx.updateChannelRuntime(lastStatus: connected|reconnecting|error,lastError)。stop()：disconnect() + 清 Map。入站消息同时把 frame.body.chatid/chattype 合并入 channel.config（updateChannelRuntime configMerge:{lastChatid,lastChattype}）。Must NOT do: 不实现 welcome/template_card_event（Todo 9）；不为同一 channel 创建第二个 client。
  Parallelization: Wave 3 | Blocked by: 2,3,4 | Blocks: 7,9
  References: https://www.npmjs.com/package/@wecom/aibot-node-sdk （WSClient/connect/disconnect/on/replyStream/generateReqId API）；server/src/workers/session-lifecycle.service.ts（运行态管理参照）；D11/D13（.omo/drafts/channel-integrations.md）
  Acceptance criteria: `npm test -- wecom-aibot` 绿（mock SDK 模块 jest.mock）：message.text 触发 submitInbound 且 replyStream 占位被调一次；同一 channel 二次 start 抛错；disconnect 后 stop 清理完成。真实连通用性属人工验收项，计划内以单测+类型编译为准。
  QA scenarios: happy=文本消息→命令+占位；failure=SDK connect reject→lastStatus=error 且不阻断其它渠道。Evidence `.omo/evidence/task-6-channel-integrations.md`
  Commit: Y | feat(integrations): 企微智能机器人长连接适配器（接收与占位回复）

- [x] 7. WecomAibot 适配器（下）：主动推送 + 终态替换关联 + 健康上报完善
  What to do / Must NOT do: 实现 sendOutbound：question_card→`replyTemplateCard/updateTemplateCard` 场景由 Todo 9 专用通道处理（本任务只做 markdown/text）→ 读 channel.config.lastChatid（缺失→抛 INTEGRATIONS_ERRORS.TASK_NOT_BOUND 语义错误记 failed）→ `wsClient.sendMessage(chatid,{msgtype:'markdown',markdown:{content}})`，errcode!==0→抛错；返回 externalId=res.headers.req_id。新增公开方法 `finishStream(internalMessageId,text)`：registerStreamCorrelation 登记的 Map 命中→`replyStream(frame,streamId,text,true)` 并删除条目（未命中→返回 false，调用方降级 sendMessage(chatid)）。Todo 8 的 agent 回复 final 处理：优先调 wecom 适配器 finishStream(内部消息 id)，false 时降级 sendMessage。补健康上报：连续 reconnecting>N 次写 lastError 摘要。Must NOT do: 不做逐字中间帧（只有占位+终态两次）；不缓存超过 100 条 pendingStreams（LRU 上限防泄漏，溢出直接丢弃并降级）。
  Parallelization: Wave 3 | Blocked by: 6 | Blocks: 9
  References: SDK README 方法表（sendMessage/replyStream finish 语义）；.omo/drafts D11/D12/D13
  Acceptance criteria: `npm test -- wecom-aibot` 增绿：sendMessage 参数拼装（chatid/markdown）正确；errcode 非 0 抛错；finishStream 命中/未命中两分支。
  QA scenarios: happy=finishStream 替换终态；failure=lastChatid 缺失→failed 投递日志。Evidence `.omo/evidence/task-7-channel-integrations.md`
  Commit: Y | feat(integrations): 企微适配器主动推送与流式终态关联

- [x] 8. 出站分发器：实时事件订阅 + 渠道事件开关 + 发送管道
  What to do / Must NOT do: 新建 `server/src/integrations/outbound-dispatcher.service.ts`：OnModuleInit 中 `realtime.subscribe(listener)`（global，参照 TaskProgressionScheduler 订阅总线的方式）按 type 分派：`EVENT_TYPES.TASK_STATUS_CHANGED`→对每个 enabled 且 direction 含 out 且 config.events 含 'task.status_changed' 且 channel.taskId===payload.taskId 的渠道发送 markdown（标题=任务名，正文=from→to+操作者）；`EVENT_TYPES.AGENT_QUESTION`→交给 Todo 9 的钩子接口（本任务留 `registerQuestionHandler(fn)` 扩展点）；agent 回复 final（WorkerDispatcher.emitFinal 已回调链路之外，直接订阅总线对应事件类型——以 EVENT_TYPES 中实际存在的最终回复事件为准，若无独立事件则订阅 chat.message.new 且过滤 payload.message.senderType==='agent'&&status==='sent'）→ config.events 含 'agent.reply' 才发（默认不开）。发送统一走私有 `dispatchToChannel(channel,msg)`：delivery.log(outbound) + 适配器异常吞并记 failed；每渠道串行队列（promise chain）防乱序，企微侧限频由适配器 errcode 兜底。公开 `sendTestSend(channel)`（构造样例 markdown）与 `sendToChannelByIdOrName(taskScope, idOrName, text)`（供 Todo 12 MCP 工具；校验渠道绑定任务的 projectId 与入参任务一致）。Must NOT do: 不改 RealtimeService；不引入定时轮询。
  Parallelization: Wave 4 | Blocked by: 2,3 | Blocks: 9,12
  References: server/src/realtime/realtime.service.ts:180-204（subscribe）；server/src/tasks/task-progression.scheduler.ts（总线订阅先例）；server/src/common/constants/event.constants.ts:8-37（EVENT_TYPES）；server/src/chat/worker-dispatcher.ts（emitFinal 语义）
  Acceptance criteria: `npm test -- outbound-dispatcher` 绿：fake realtime bus 推 TASK_STATUS_CHANGED→绑定渠道适配器 sendOutbound 收到格式化 markdown；未订阅该事件的渠道不被调；适配器抛错→failed 日志且不影响其它渠道。
  QA scenarios: happy/failure 如上；Evidence `.omo/evidence/task-8-channel-integrations.md`
  Commit: Y | feat(integrations): 出站事件分发器与渠道事件开关

- [x] 9. 审批卡片闭环：AGENT_QUESTION→按钮卡片→card_action→reply→卡片回写
  What to do / Must NOT do: 在 OutboundDispatcher 注册 question handler：命中 `AGENT_QUESTION` 且 payload.question.status==='pending' && !payload.question.managedMode && 存在 direction 含 out/inout 且 events 含 'agent.question'（默认开）的绑定渠道 → wecom 适配器新增 `sendQuestionCard(channel, q:AgentQuestionDto): Promise<{meta}>`：kind=permission→button_interaction 卡片两按钮 key `${q.id}:approve`/`${q.id}:reject`；kind=question→取 content.questions[0].options 渲染选项按钮（多问题/无 options→降级发 markdown 文本提示去 web 处理）；投递 meta 存 {aqId,chatid}。wecom 适配器监听 `event` 帧（template_card_event）：解析 EventCallback 按钮 key→组 card_action 命令交 host.submitInbound；受理成功（Todo 4 回调）后在事件帧 5s 内 `updateTemplateCard(frame, 文本通知卡"已批准/已拒绝/已选择 by userid")`，超时静默。InboundService 的 card_action 校验链补齐：aq.requestId 存在、kind 匹配 action（approve/reject↔permission；选项 label↔question）。过期问题（QUESTION_PENDING_TTL_MS）点击→rejected 日志+尽力更新卡片"已失效"。Must NOT do: managedMode 任务绝不推卡；不改 questions.constants 的 TTL/状态值。
  Parallelization: Wave 4 | Blocked by: 4,7,8 | Blocks: 13
  References: server/src/workers/worker-event.ingress.ts:703-817（AGENT_QUESTION payload 结构）；server/src/questions/questions.service.ts:31-45(DTO)/180(confirmByAgent)/462(resolvePlatformQuestion)；server/src/questions/questions.constants.ts（KINDS/STATUS/TTL/PermissionResponse）；SDK replyTemplateCard/updateTemplateCard（5s 窗）
  Acceptance criteria: `npm test -- question-card` 绿：pending 非托管问题触发 sendQuestionCard 且按钮 key 正确；managedMode 不触发；card_action approve 调用了 reply 并产生 ok 投递；过期→rejected。
  QA scenarios: happy=权限卡批准→reply(PermissionResponse.approve)；failure=跨渠道 aqId 点击→rejected。Evidence `.omo/evidence/task-9-channel-integrations.md`
  Commit: Y | feat(integrations): 权限与提问的企微卡片远程处理闭环

- [x] 10. 管理 REST API + 权限点
  What to do / Must NOT do: 新建 `server/src/integrations/integrations.module.ts`（imports TasksModule? 不需要——只读 task 校验经 prisma；providers：上述全部服务+适配器工厂+ProjectMembershipGuard 按需）与 `integrations.controller.ts`（Swagger 装饰齐全）：
  `GET /api/v1/integrations/channels`（登录即可，secrets 掩码为 "***"）、`GET /channels/:id`（含最近 20 条投递摘要）、`POST /channels`（admin）、`PATCH /channels/:id`（admin；secrets 合并语义：请求含某键则覆盖，缺省保留原值）、`DELETE /channels/:id`（admin；先 adapter.stop 再删）、`POST /channels/:id/enable`/`disable`（admin；联动 start/stop）、`GET /channels/:id/deliveries?cursor&limit`、`POST /channels/:id/test-send`（admin）。
  权限：仿 tasks 的 PermissionGuard 用法新增权限点 `channels.manage`（角色矩阵 admin=true/member=false——按仓内权限矩阵实际配置位置同步登记）。DTO 校验（class-validator）：type∈CHANNEL_TYPES、direction∈枚举、taskId 可选但存在性校验、config/secrets 为对象。AppModule imports 加入 IntegrationsModule。Must NOT do: 任何响应不得包含 secrets 明文；不给 member 开写口子。
  Parallelization: Wave 5 | Blocked by: 1,3 | Blocks: 11
  References: server/src/tasks/tasks.controller.ts + permission.guard 用法与权限点声明处（grep 'tasks.review' 定位矩阵登记文件）；server/src/mcp-servers/mcp-servers.controller.ts（CRUD+启停样板）；server/src/app.module.ts:31-74
  Acceptance criteria: e2e `npm run test:e2e -- integrations-admin` 绿：member 建/改/删/启停/test-send 全 403；admin 全流程 2xx；GET 响应 JSON 断言不含 secret 值（固定种子里放可识别字符串搜索为空）；PATCH 只改传入的 secret 键。
  QA scenarios: happy=admin 全 CRUD+test-send；failure=非法 type 400、越权 403。Evidence `.omo/evidence/task-10-channel-integrations.md`
  Commit: Y | feat(integrations): 渠道管理 API 与权限点

- [x] 11. 前端设置页 + external 消息徽章
  What to do / Must NOT do: 新建 `web/app/(main)/integrations/page.tsx`（对齐 skills 页区块形态：渠道行卡片[名称/type 徽章/方向徽章/enabled 开关(admin)/endpoint 或绑定任务摘要/操作 查看·编辑·删除·测试发送] + 新建弹窗[类型单选→动态表单：webhook=secret+targetUrl+events 多选；wecom=BotID+Secret+events 多选+绑定任务（优先下拉选择既有任务列表接口；若无全局任务列表端点则文本输入 taskId，服务端校验存在性并在详情回显任务标题）] + 投递日志抽屉[时间/方向/状态/错误]）。编辑回显时 secret 显示占位符"保持不变"（提交空=不改）。`api` 封装走 `@/lib/api`。群聊消息渲染处：senderType==='external' 时气泡旁加来源徽章「外部渠道」（定位任务群聊消息渲染组件——grep web 端 senderType 使用处），样式遵循页面内扩展 token 范式不扩散共享层。Must NOT do: 不把 secret 写进任何 state 持久化/localStorage；不改既有 user/agent/system 消息样式路径。
  Parallelization: Wave 5 | Blocked by: 10 | Blocks: —
  References: web/app/(main)/skills/page.tsx:1179-1430（MCP 区块形态/徽章/开关范式）；web/src/lib/api.ts、web/src/lib/errors.ts、web/src/theme/tokens；web 群聊渲染组件（grep senderType 于 web/src 与 web/app/(main)/tasks）
  Acceptance criteria: `cd web && npm run build` 通过；`npm run lint`（若有）通过。组件级验证以构建+关键 data-testid 存在为准：`data-testid="integration-channel-item"`、`create-integration-channel-button`、`integration-delivery-drawer`。
  QA scenarios: happy=渲染 3 种状态渠道行+新建弹窗动态表单切换；failure=删除确认弹窗存在。Evidence `.omo/evidence/task-11-channel-integrations.md`
  Commit: Y | feat(web): 集成渠道设置页与外部消息来源标识

- [x] 12. 平台 MCP 工具 channel_send
  What to do / Must NOT do: 在 `server/src/platform-mcp/platform-mcp.tools.ts` 注册工具 `channel_send`（inputSchema：{target:string(channelId 或渠道名), text:string(≤4000)}），`platform-mcp.service.ts` 增加 handler：解析当前会话 taskId→projectId 边界→调 OutboundDispatcher.sendToChannelByIdOrName→成功返回"已发送至渠道 X"；失败返回结构化错误文本（不抛断会话）。工具 effect 沿用既有平台工具的 AgentToolEffect 生效链路（确认注册即纳入 allow/ask/deny，无需额外代码则注释说明）。Must NOT do: 不接受 URL/任意渠道外参数；不绕过 direction 校验（direction 含 out 才可发）。
  Parallelization: Wave 5 | Blocked by: 8 | Blocks: 13
  References: server/src/platform-mcp/platform-mcp.tools.ts、platform-mcp.service.ts（notify_agent/group_post 工具注册与 handler 样板）、platform-mcp.constants.ts
  Acceptance criteria: `npm test -- platform-mcp` 增绿：handler 调 dispatcher 且边界外渠道被拒；tools 清单含 channel_send（快照断言）。
  QA scenarios: happy=发送成功文案；failure=渠道不存在/out 方向不符→错误文案。Evidence `.omo/evidence/task-12-channel-integrations.md`
  Commit: Y | feat(platform-mcp): channel_send 渠道通知工具

- [x] 13. 设计文档与索引 + 全量回归
  What to do / Must NOT do: 新建 `docs/agent-platform/27-外部渠道集成设计.md`：概述/场景（企微双向+webhook）/架构图（ASCII）/数据模型/适配器契约（双能力面）/安全基线（HMAC、msgid 幂等、单连接守护、secret 脱敏）/企微时序契约（占位-终态-24h 窗-限频-前置交互前提）/审批卡片闭环时序/roadmap（经典群机器人冷推送、钉钉 Stream、飞书事件、多副本选主、媒体消息）；`docs/agent-platform/_meta.md` 登记第 27 篇。跑全量门禁并记录证据：`cd server && npm run lint && npm test && npm run build`、`cd web && npm run build`。Must NOT do: 不改动 01-26 任何既有文档内容。
  Parallelization: Wave 5 | Blocked by: 5,9,12 | Blocks: —
  References: docs/agent-platform/_meta.md；docs/agent-platform/21-平台MCP-Server设计方案.md（文档结构参照）；README.md 功能特性段落（评估是否值得一句提及——允许最小增量）
  Acceptance criteria: 门禁命令全部退出码 0；文档存在且 `_meta.md` 含 27 篇链接。
  QA scenarios: happy=门禁绿；failure=任一红→修复后重跑并在证据文件记录。Evidence `.omo/evidence/task-13-channel-integrations.md`
  Commit: Y | docs(agent-platform): 外部渠道集成设计与索引

## Final verification wave

> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy

- 每 Todo 一个原子 commit（信息见各行尾）；类型 feat/docs，scope=integrations/web/platform-mcp/agent-platform
- 不做整体 squash；执行分支建议 `feat/channel-integrations`，由用户决定合入时机
- 提交前每任务必须通过其 Acceptance criteria 命令；禁止 `--no-verify`

## Success criteria

1. 管理员可创建/启停 generic_webhook 与 wecom_aibot 两类渠道，secrets 任何时候不出现在 API 响应
2. 向 webhook 渠道 POST 错误签名请求被拒并留痕；正确请求使消息落入绑定任务群聊并触发主 Agent 分派
3. 企微群里 @机器人发文本：5s 内收到占位回复，消息进任务群聊触发分派；Agent 完成后占位被替换为结果（重启丢失映射时降级为主动推送）
4. 任务状态变更按渠道开关自动推送；Agent 可经 channel_send 主动向绑定渠道发文本
5. 非托管任务的权限/提问以按钮卡片出现在企微群，点击批准/拒绝后 Agent 解除阻塞且卡片状态更新；过期/重复点击被拒并留痕
6. 投递日志可查每次出入站结果，重复 externalId 不产生重复副作用
7. 全量门禁（lint/test/build × server+web）绿
