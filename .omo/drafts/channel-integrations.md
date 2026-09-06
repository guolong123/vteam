---
slug: channel-integrations
status: review-in-progress
intent: clear
review_required: true
pending-action: review .omo/plans/channel-integrations.md
review_round_id: rr-20260825-channel-integrations-r1
review:
  momus:
    status: degraded-self-review-completed
    workspace_root: /Users/mac/01work/git-project/vteam
    runtime_home: null
    target: .omo/plans/channel-integrations.md
    round_id: rr-20260825-channel-integrations-r1
    plan_sha256: not-computable-no-exec-tool-in-planner
    launch_id: launch-momus-r1-001
    session: null
    result: |
      派发失败（harness：agents.some is not a function）。降级由 planner 执行对抗式
      结构清单：语法/依赖矩阵/决策完备性/矛盾/scope 漂移/QA 现实性——产出 MAJOR-1、
      MINOR-3/4/5（详见 independent.result），已全部修复并复验。
  independent:
    status: degraded-self-review-completed
    workspace_root: /Users/mac/01work/git-project/vteam
    runtime_home: null
    target: .omo/plans/channel-integrations.md
    round_id: rr-20260825-channel-integrations-r1
    plan_sha256: not-computable-no-exec-tool-in-planner
    launch_id: launch-oracle-r1-001
    session: null
    result: |
      原生双通道评审不可用（harness 缺陷，证据：momus/oracle/explore 派发均报
      "agents.some is not a function"；category 派发报 session lineage 解析失败）。
      降级执行：planner 自跑两套清单（对抗式结构审查 + 独立技术审查），发现并修复：
      [MAJOR-1] webhook HMAC 的 rawBody 获取未定死实现路径 → Todo 5 固化为
        Express {rawBody:true} / Fastify contentTypeParser 二选一 + e2e 兜底；
      [MAJOR-2] 流式终态关联断链：pendingStreams 以外部 msgid 为 key，而出站事件
        携带内部消息 id → 新增 registerStreamCorrelation(internalMessageId, ref)
        接口（Todo 2/6/7/8 四处贯通），LRU 100 上限防泄漏；
      [MINOR-3] dedupKey 冗余拼接 channelId → 统一为 externalId=msgid；
      [MINOR-4] 任务级联删除后孤儿 WS 连接 → submitInbound 前置校验 + requestStop；
      [MINOR-5] 前端绑定任务下拉依赖不存在的全局任务端点风险 → 下拉/文本输入双轨。
      复检：结构语法 13 todos + F1-F4 全部合规；两套清单复验无未决 BLOCKER/MAJOR。
      verdict(降级模式): OKAY —— 不等同于原生 momus+oracle 双签；委派机制修复后建议重跑。
approach: 在 server 新增 integrations 模块：渠道配置实体（type 判别式 + 分类型 config/secrets JSON + direction 能力标记）+ 双形态渠道适配器注册表（HTTP 端点型 / 连接生命周期型，NestJS DI 注入）。入站统一归一化后走既有 ChatService 管道；出站一条发送管道三个触发源（RealtimeService 事件订阅 / 平台 MCP channel_send 工具 / 测试发送）。首批两适配器：generic-webhook（HTTP 端点型，双向）+ wecom-aibot（企微智能机器人 WebSocket 长连接模式，官方 @wecom/aibot-node-sdk，免公网 IP/免加解密，收指令+流式回复+主动推送全覆盖）。
---

# Draft: channel-integrations

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

- C1 渠道配置存储 | IntegrationChannel 表（type 判别式 + config/secrets Json + 绑定 + enabled）| active | server/prisma/schema.prisma（McpServer 先例 :602）
- C2 适配器框架 | ChannelAdapter 抽象 + DI 注册表，新渠道=新增一个 adapter 类 + 配置 schema | active | 待定（参考 chat/message-dispatcher.ts 的抽象-DI 替换模式）
- C3 入站管道 | 统一回调端点/长连接事件 → 验签 → 归一化命令（post_message / card_action）→ 去重路由 | active | server/src/auth/guards/jwt-auth.guard.ts:22（@Public 放行）、server/src/chat/chat.service.ts（createMessage→dispatcher）
- C4 出站分发 | 订阅 RealtimeService 事件（状态变更/Agent 回复/**AGENT_QUESTION**）→ 适配器 formatOutbound → send；卡片交互回写 | active | server/src/realtime/realtime.service.ts:86-204、server/src/workers/worker-event.ingress.ts:795
- C7 阻塞交互闭环 | AGENT_QUESTION→推卡→按钮点击→QuestionsService.reply 解除阻塞→updateTemplateCard | active | server/src/questions/questions.service.ts（reply/confirmByAgent :180）、worker-event.ingress.ts:703-817
- C5 管理 API + 前端设置页 | 渠道 CRUD + 启停 + 测试发送 + 投递日志查看（admin）| active | 参照 mcp-servers 模块与 web/app/(main)/skills 页面模式
- C6 安全基线 | 各渠道签名/时间戳防重放/msgid 去重/allowlist；secrets 只写不回读 | active | 调研记录（Slack/GitHub/Telegram/企微）

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 管理权限 | 仅 admin 可管理渠道（新增权限点 channels.manage），member 只读 | 对齐 MCP servers/skills 管理惯例 | 是 |
| 密钥存储 | secrets 存 Json 列、API 返回时脱敏（write-only），不做额外加密层 | 单机自部署场景，对齐 ModelCredential/GitCredential 既有做法 | 是 |
| 幂等去重 | 以渠道侧 msgid/event id 做投递日志唯一键去重 | 企微/钉钉均可能重复回调 | 是 |
| 设计文档 | 新增 docs/agent-platform/27-外部渠道集成设计.md | 项目编号文档惯例（01~26 已占） | 是 |

## Findings (cited - path:lines)

### 本地代码事实
- 全局 JWT 守卫为 APP_GUARD，`@Public()` 显式放行 → 外部回调端点须走此通道并自带验签：server/src/auth/guards/jwt-auth.guard.ts:22-31
- 消息发送者类型仅 user/agent/system 三种（SENDER_TYPE）：server/src/common/constants/event.constants.ts:48-54；CHANNEL_TYPE 仅 task_group/private：同文件 :41-46 —— 外部指令落库需要决定身份映射
- 消息→Agent 触发链路：ChatService 依赖 MessageDispatcher 抽象（DI token 可替换）：server/src/chat/message-dispatcher.ts:73-123（DispatchRequest :26-35）；真实实现 WorkerDispatcher：server/src/chat/worker-dispatcher.ts:656；MCP notify_agent 入口 dispatchAgentMention：同文件 :888-911 —— 「外部指令进群聊并触发 Agent」可直接复用该链路
- 实时事件：RealtimeService.emit/broadcast 先落库 realtime_events 再走 EventBus，支持按 task/channel/global scope 订阅：server/src/realtime/realtime.service.ts:86-204 —— 出站推送的天然挂载点
- 任务五态状态机表驱动（TASK_TRANSITIONS）：server/src/common/constants/task.constants.ts:39-48 —— 外部动作指令可映射为状态机动作
- 类型判别式配置的既有先例：McpServer（type local/remote + enabled + 内置/自定义）：server/prisma/schema.prisma:602；前端管理页先例：web/app/(main)/skills/page.tsx（MCP 区块 :1179-1430）
- ID 生成器按域前缀（m_/c_/ev_...）零填充可排序：server/src/common/id-generator.ts:17-46 —— 新实体需取未占用前缀
- 全仓无既有 webhook/通知渠道设施（grep webhook|notification 仅命中 notify_agent MCP 工具相关文件）——全新建设

### 外部产品调研
- **OpenClaw**（docs.openclaw.ai/plugins/sdk-channel-plugins、/plugins/architecture、/channels/channel-routing、/concepts/architecture）：
  - 渠道=插件：manifest 声明 `channels:["id"]` + `channelConfigs.<id>.schema`（JSON Schema 定义每渠道配置，uiHints 标记 sensitive 字段）；核心拥有共享 message 工具/会话簿记/策略，插件拥有配置解析、安全（DM policy + allowFrom 名单）、配对、outbound 发送、线程语法
  - 入站：插件经 `api.registerHttpRoute({path, auth:"plugin"})` 注册自己的 webhook 并自行验签后派发；不同渠道有 ack-gated / awaited-polling 两类接收确认策略
  - 路由：确定性 bindings 规则表（match channel/accountId/peer/guild/team → agentId），回复路由回原渠道；幂等键必填于副作用方法，服务端短期去重缓存
- **企业微信**（developer.work.weixin.qq.com/document/path/100719、90930、90968、101033）：
  - ⚠️ 经典「群机器人 webhook」只能往群里推消息（outbound-only），不能接收
  - 「智能机器人」（新版）：群里 @机器人 或单聊发消息 → 加密 JSON 回调到开发者 URL；GET 验证握手（msg_signature=sha1(sort(token,timestamp,nonce,echostr))，AES 解密 echostr，≤1s 明文回包）；POST `{encrypt}` 解密得 msgid/chatid/chattype/from/response_url/text 等；msgid 用于排重；receiveid 传空串
  - 智能机器人双模式（官方 100719/101031/101138/101463，2026-03~05 更新）：API 模式二选一——回调 URL（Token+EncodingAESKey+企业主体域名+AES 加解密；response_url 主动回复有效期 1h 且一次性；流式刷新窗 ≤6min）vs **WebSocket 长连接**（wss://openws.work.weixin.qq.com，BotID+Secret 鉴权，免公网 IP/免加解密；心跳 30s；单机器人仅一条长连接，新连踢旧连；回复窗 24h；主动推送 sendMessage 前提=该会话曾有用户消息；限频 30 条/分、1000 条/时每会话）
  - 官方 Node SDK `@wecom/aibot-node-sdk`（npm）：自动认证/心跳/指数退避重连、事件订阅（message.text 等）、replyStream 流式原位替换、sendMessage 主动推送、replyWelcome/updateTemplateCard 5s 窗、uploadMedia 分片上传；社区 NestJS 同构先例（xpert-ai wecom integration，含多实例 Redis 选主守护单连接）
  - roadmap 发现：智能机器人长连接已定稿进首批；经典群机器人 webhook（out-only 冷推送）与钉钉 Stream Mode、飞书事件订阅为后续扩展
  - 自建应用回调（经典）：XML 格式、receiveid=corpid、同一套签名/AES 方案、5s 超时重试 3 次
- **告警类产品**：Prometheus Alertmanager receiver 按 type 判别式配置块（webhook_configs/wechat_configs…）；Grafana contact points 同构且 secure 字段单独存储 + Test 按钮 —— 「类型判别式 + 分类型配置 + 测试发送」是行业通用形态
- **自动化平台**：n8n Webhook 触发器区分 test/prod URL，认证支持 none/basic/header/HMAC —— 每个集成实例独立 URL + 可选认证
- **签名方案速查**：GitHub X-Hub-Signature-256=HMAC-SHA256(secret,body)；Slack HMAC-SHA256(secret, "v0:ts:body")+5min 时间窗；Telegram setWebhook secret_token 头比对；通用做法=时间戳容差+nonce/序号防重放

## Decisions (with rationale)

- D1 采用「类型判别式配置 + 适配器接口 + DI 注册表」而非每渠道硬编码分支：与 Alertmanager/Grafana/OpenClaw 同构，新增渠道只需新增 adapter 类 + 配置 schema，核心管道零改动（对齐项目内 MessageDispatcher 的抽象替换惯例）
- D2 入站归一化为「渠道命令」（post-to-task-chat / create-task / task-action …）再进入既有 ChatService/TasksService，而不是直接操作 DB：复用分派/SSE 广播/状态机校验全链路，外部消息在 web 端可见可审计
- D3 回调端点统一挂在 `/api/v1/integrations/channels/:id/inbound`（@Public + adapter.verifyInbound 验签），企微 GET 握手由 wecom-aibot 适配器在同一路由内处理
- D4 【用户已确认】方向=双向：入站命令管道 + 出站事件分发（RealtimeService 订阅 → adapter.formatOutbound → adapter.send）；出站事件范围首期限定核心集合（任务状态变更 TASK_STATUS_CHANGED / Agent 回复 final），每渠道在 config 中以事件类型开关列表配置，不做规则引擎
- D5 【用户已确认，长连接模式定稿】首批适配器=两个：① generic-webhook（HTTP 端点型：入站 HMAC-SHA256 验签；出站 POST 至渠道配置的 targetUrl 并带签名头）；② wecom-aibot（企微智能机器人 **WebSocket 长连接模式**：官方 `@wecom/aibot-node-sdk`，配置仅 BotID+Secret，免公网 IP/域名/加解密；收指令 aibot_msg_callback + 流式回复 replyStream + 主动推送 sendMessage 全覆盖）。经典群机器人移入 roadmap（唯一剩余价值=向从未与机器人交互的会话冷推送）；钉钉/飞书 roadmap 占位。企微回调 URL 模式（Token+AESKey）不做——API 模式二选一，选定长连接
- D6 【用户已确认】路由模型=任务群聊绑定为主：IntegrationChannel 绑定到具体 taskId，外部消息以 senderType=external 身份落入该任务群聊并按现有 @ 规则触发分派；出站默认推送该任务的事件。不引入命令语法解析器与项目级 bindings 规则表（留扩展点）
- D7 外部身份：SENDER_TYPE 增加 `external` 枚举值（server 常量 + 校验放行），消息 content Json 内附 `{source:{channelId,channelType,externalUser}}` 来源元数据；web 群聊气泡对 external 消息渲染「渠道」来源徽章（改动面：常量文件 + chat 渲染分支）
- D8 幂等与安全基线：ChannelDelivery 表以 (channelId, externalId) 唯一键去重；generic-webhook 入站校验 HMAC-SHA256(secret, body)+X-Signature 头+时间戳容差；wecom-aibot 按 msg_signature=sha1(sort(token,timestamp,nonce,encrypt))+EncodingAESKey AES-CBC 解密；所有密钥类字段 API 返回脱敏（write-only）
- D9 【用户确认】出站=三触发路径共用一条发送管道（adapter.formatOutbound→send→投递日志）：①事件订阅（OutboundDispatcher 订阅 RealtimeService，每渠道事件开关列表）；②平台 MCP 新增 channel_send 工具（Agent 会话中主动推送；参数仅 channelId+text，禁止裸 URL 防注入外泄；纳入 AgentToolEffect allow/ask/deny 权限）；③管理页测试发送。generic-webhook 渠道的出站目标为渠道内单独配置的 targetUrl，出站请求带 HMAC 签名头供对端校验
- D10 渠道方向属性：每个渠道实例带 direction 标记（in/out/inout），适配器声明能力集（supportsInbound/supportsOutbound），管理页按能力渲染配置表单；企微智能机器人被动回复窗口有限（response_url 临时、流式≤6min），异步通知依赖 out-only 渠道
- D11 入站时序契约（长连接模式定稿）：收到 aibot_msg_callback 后立即 replyStream 占位「已收到，开始处理…」（满足 5s 时效）→ msgid 去重 → 指令落任务群聊 → 触发分派；Agent 完成后以同一 stream.id `finish=true` 原位替换最终结果；超出会话回复窗（24h）或需中途推送 → `sendMessage(chatid, markdown)` 主动推送（前提：该会话曾有用户给机器人发过消息，vteam 场景天然满足）；限频 30 条/分、1000 条/时每会话，出站分发器超限时排队丢弃并记投递日志
- D12 channel_send 工具路由规则：参数仅 channelId+text；按目标渠道能力分发——generic-webhook 随时可发（POST targetUrl）；wecom-aibot 走 sendMessage 至绑定会话 chatid（无前置交互导致失败则记投递日志，不静默降级到其它渠道）
- D13 适配器双形态与连接守护：ChannelAdapter 接口拆两个可选能力面——HTTP 端点型实现 verifyInbound/normalize(req)；连接生命周期型实现 start/stop（NestJS onModuleInit/onModuleDestroy + 渠道启停联动启断 WS）。企微单机器人同时仅允许一条长连接（新连踢旧连）：服务内 per-channel 单例守护 + 启停互斥；多副本部署需分布式选主（当前单实例设计下仅记约束不做）；SDK 断线自动重连（指数退避），连接状态事件上报渠道健康状态（管理页展示 connected/reconnecting/error）
- D14 【用户要求】模板卡片支持阻塞型交互（权限/question）：①出站新增触发源——OutboundDispatcher 订阅实时事件 `AGENT_QUESTION`（worker-event.ingress.ts:795 emit，payload 含完整 AgentQuestion DTO），命中「taskId 有启用渠道绑定 && status=pending && !managedMode」时推 button_interaction 模板卡片（权限=批准/拒绝按钮；question=选项按钮），按钮 key 编码 `<aqId>:<action>`（≤1024B）；②入站归一化新增命令 kind=`card_action`——适配器处理 `aibot_event_callback` 的模板卡片点击事件，解析 button key 校验（问题存在/pending/渠道匹配/未过期）后路由至既有 QuestionsService.reply 路径解除 Agent 阻塞；③卡片回写——动作受理后在事件帧 5s 窗内 updateTemplateCard 显示「已批准/拒绝 by <userid>」，超时静默跳过；④卡片与问题的映射存投递日志扩展字段（chatid+card task_id+aqId）；⑤managedMode 任务不推卡（主 Agent 自动确认，避免双路径抢答）；操作人 userid 可能为加密态（机器人非超管创建），审计原样记录

## Scope IN

- server 新增 integrations 模块：
  - Prisma 模型 IntegrationChannel（ic_ 前缀）+ ChannelDelivery（cd_ 前缀）+ 迁移
  - ChannelAdapter 抽象接口 + DI 注册表（CHANNEL_ADAPTERS 注入 token 收集全部适配器）
  - 入站管道：@Public 统一路由（GET 握手 + POST 回调同路径）→ verifyInbound → normalize → 去重 → ChannelCommandService 执行（post-to-task-chat 复用 ChatService.createMessage→dispatcher 全链路）
  - 出站分发：OutboundDispatcher 订阅 RealtimeService（task scope：TASK_STATUS_CHANGED / Agent 回复 final / AGENT_QUESTION）→ 按渠道事件开关过滤 → formatOutbound → send → 写投递日志；question/permission 推 button_interaction 卡片
- 入站卡片动作：aibot_event_callback（template_card_event）→ card_action 命令 → QuestionsService.reply 解除阻塞 → updateTemplateCard 状态回写
  - 管理 REST API：CRUD + 启停 + 测试发送（test-send）+ 投递日志分页查询（admin 权限点 channels.manage）
- 首批适配器：GenericWebhookAdapter、WecomAibotAdapter、WecomGroupRobotAdapter（out-only）
- 平台 MCP 新增 channel_send 工具（platform-mcp 模块：工具注册 + handler 走出站发送管道；AgentToolEffect 权限联动）
- web 管理页：渠道列表/新建/编辑凭据（脱敏回显）/启停/测试发送/投递日志查看（对齐 skills 页 MCP 区块形态，admin 可管、member 只读）
- SENDER_TYPE 扩展 external + web 群聊渲染来源徽章
- 测试：适配器单测（验签/归一化/AES 解密 fixture）、入站管道 e2e、出站分发单测
- 设计文档 docs/agent-platform/27-外部渠道集成设计.md（编号顺延惯例）

## Resolved answers (原 Open questions)

1. 方向 → 双向（D4）
2. 首批渠道 → generic-webhook + 企微智能机器人长连接（D5/D9；经典群机器人移入 roadmap）
3. 路由模型 → 任务群聊绑定为主（D6）
4. 连接方式 → 企微走 WebSocket 长连接模式（用户指定，官方 SDK 支撑）
5. 阻塞型交互 → 模板卡片（button_interaction）承载权限/question 的远程批准，闭环经既有 QuestionsService.reply（D14）

## Scope OUT (Must NOT have)

- 不做渠道插件的热加载/第三方插件包机制（进程内 DI 注册即可，OpenClaw 式插件市场明确不做）
- 不做流式逐字输出（打字机式 LLM 流转发到企微；仅用 replyStream 做「已收到」占位与终态替换）
- 不做模板卡片以外的富交互（投票卡片、图文混排、语音/视频/文件消息收发——SDK 已具备，留后续）
- 不做工作流编排（n8n 式可视化规则引擎）
- 不改动既有 ChatService/TasksService/QuestionsService 行为（只在其入口前加适配层、旁路订阅其事件）

## Approval gate
status: approved
approach: 双向渠道集成框架（类型判别式配置 + DI 适配器注册表 + 统一入站验签管道 + RealtimeService 出站分发），首批 generic-webhook 与企微智能机器人（WebSocket 长连接）两适配器，含权限/question 模板卡片远程批准闭环，任务群聊绑定路由，admin 管理页 + 投递日志。
next-workflow-action: 计划已获用户批准并写入 .omo/plans/channel-integrations.md（13 todos + F1-F4）。执行由用户另行启动工作会话（$start-work）。
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
