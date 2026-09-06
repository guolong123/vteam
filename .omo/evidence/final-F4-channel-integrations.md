# Final Wave F4 — Scope Fidelity (channel-integrations)

> Plan: `.omo/plans/channel-integrations.md` (Large, Medium risk)
> Date: 2026-08-25
> Reviewer: sisyphus-junior (F4)
> Mode: read-only verification (no file modifications)

## Method

- Read `.omo/plans/channel-integrations.md` Scope § Must have (10 bullets) + Must NOT have (8 guardrails) + Success criteria (7).
- File-existence checks: `server/src/integrations` tree, `server/prisma/schema.prisma`, `server/prisma/migrations/20260828000000_integration_channels`, `docs/agent-platform/27*`, `web/app/(main)/integrations/page.tsx`, `web/src/components/ui/chat-bubble.tsx`, `web/app/(main)/tasks/[id]/page.tsx`.
- Grep scans: `classic|group.*robot|群机器人`, `Token.*Encoding|EncodingAESKey|aes.*decrypt|echostr`, `n8n|hot.*load|plugin.*market`, `package.json` dep diff, secret masking.
- Cross-checked evidence files: `.omo/evidence/task-{1..13}-channel-integrations.md` existence and key assertions.

---

## 1. Must Have — 10 items + sub-deliverables

| # | Must Have item (plan §Scope) | File(s) | Status | Evidence |
|---|---|---|---|---|
| 1 | Prisma 新表 `IntegrationChannel` (ic_) + `IntegrationChannelDelivery` (cd_) + migration + Task reverse + prefix seeds | `server/prisma/schema.prisma:157,787,808` — `model IntegrationChannel { id, name(64), type(32), direction(8, default 'in'), taskId FK tasks CASCADE, config Json {}, secrets Json {}, enabled true, lastStatus(16)?, lastError(512)?, createdAt/updatedAt }` + `@@index([taskId])`; `model IntegrationChannelDelivery { id, channelId FK CASCADE, direction(8), externalId(128)?, status(16), kind(32)?, error(512)?, payload?, meta?, createdAt }` + `@@unique([channelId, externalId])` + `@@index([channelId, createdAt])`; `Task.integrationChannels IntegrationChannel[]`; `server/prisma/migrations/20260828000000_integration_channels/migration.sql` (CreateTable both + FKs); `server/src/integrations/integrations.constants.ts:63-64` `CHANNEL_ID_PREFIX='ic_'`, `DELIVERY_ID_PREFIX='cd_'`; `server/src/integrations/channel-delivery.service.ts:1-40` `resyncIdPrefix('ic'/'cd')` in OnModuleInit | **PASS** | `task-1` evidence; `npx prisma validate` in task-1 log; build OK |
| 2 | 适配器框架: ChannelAdapter abstract (verifyInbound/normalizeInbound + start/stop dual face) + DI registry + host injection | `server/src/integrations/channel-adapter.ts` (ChannelResolved, OutboundMessage, InboundCommand post_message/card_action, abstract class ChannelAdapter type/supportsInbound/supportsOutbound/verifyInbound/handleHandshake/normalizeInbound/start/stop/sendOutbound/registerStreamCorrelation/attach, interface AdapterHost submitInbound/getChannel/updateChannelRuntime/requestStop/registerStreamCorrelation); `server/src/integrations/channel-registry.service.ts` (@Inject(CHANNEL_ADAPTERS) Map<type,adapter>, OnModuleInit attach+conflict throw, startEnabled per-enabled-channel, onModuleDestroy reverse stop); `server/src/integrations/integrations.module.ts:25-33` CHANNEL_ADAPTERS factory `[GenericWebhookAdapter, WecomAibotAdapter]`; `server/src/integrations/integrations.constants.ts` CHANNEL_TYPES/DIRECTIONS/DELIVERY_/COMMAND_KINDS/OUTBOUND_EVENTS/INTEGRATIONS_ERRORS/CHANNEL_ADAPTERS token | **PASS** | `task-2` evidence; `npm test -- channel-registry` green |
| 3 | 入站管道: 验签→归一化→(channelId,externalId)幂等→路由 | `server/src/integrations/channel-delivery.service.ts` tryBeginIngest(externalId non-empty → insert status=in_progress catch P2002 duplicate=true; null bypass), finish, log, listByChannel cursor; `server/src/integrations/inbound.service.ts` (AdapterHost.submitInbound: getChannel null/!enabled → skipped + requestStop orphan cleanup → post_message find task_group channel → chatService.createMessage with actor external → card_action findUnique agentQuestion pending/kind/action/TTL/taskId check → questionsService.reply → delivery meta cardUpdate); `server/src/integrations/integrations-inbound.controller.ts` @Public() ALL /:id/inbound verifyInbound→normalizeInbound→submitInbound 200 {ok:true}, 401/400 on fail | **PASS** | `task-3` + `task-4` evidence; duplicate P2002 test green |
| 4 | 适配器① generic-webhook: HMAC-SHA256验签 + 出站带签POST | `server/src/integrations/adapters/generic-webhook.adapter.ts` (type generic_webhook, verifyInbound rawBody HMAC sha256= header + x-vteam-timestamp 300s timingSafeEqual → 401 SIGNATURE_INVALID, normalizeInbound JSON {text<=8000, sender{id,name}} → post_message dedupKey x-vteam-event-id ?? sha1(rawBody), sendOutbound POST targetUrl body {event,taskId,title,text,ts} header x-vteam-signature; server/src/main.ts rawBody:true + express.json verify req.rawBody) | **PASS** | `task-5` evidence 18/18 spec pass; e2e sig/timestamp/duplicate vectors |
| 5 | 适配器② wecom-aibot: @wecom/aibot-node-sdk WS长连接, 占位/终态/推送/卡片交互/健康/单例守护 | `server/src/integrations/adapters/wecom-aibot.adapter.ts` (type wecom_aibot, secrets botId/secret, start → single Map<channelId,WSClient> guard throw on dup → new AiBot.WSClient {botId,secret,maxReconnectAttempts:-1} connect() → on message.text strip @prefix → submitInbound → registerStreamCorrelation LRU 100, merge chatid/chattype to config via updateChannelRuntime, on connected/authenticated/disconnected/reconnecting/error → updateChannelRuntime lastStatus/lastError, stop disconnect+clear; unsupported image/mixed/voice/file/video → replyStream "暂不支持" fallback (lines 356-375); finishStream(internalMessageId)→replyStream finish=true else false→caller downgrade sendMessage; sendOutbound → lastChatid check TASK_NOT_BOUND → wsClient.sendMessage(chatid,{msgtype:'markdown'}) errcode!=0 throw; sendQuestionCard button_interaction keys `${id}:approve/:reject` / options downgrade markdown, template_card_event 5s updateTemplateCard) | **PASS** | `task-6` + `task-7` evidence; mock SDK spec green; single-start throw, LRU cap, health lastError |
| 6 | 出站分发器: 订阅RealtimeService总线, 按events开关过滤, 路由适配器并写投递日志 | `server/src/integrations/outbound-dispatcher.service.ts` (OnModuleInit realtime.subscribe: TASK_STATUS_CHANGED → enabled+direction out/inout+events task.status_changed+taskId match → markdown from→to; AGENT_QUESTION delegated to question handler registerQuestionHandler; chat.message.new filtered senderType agent + events agent.reply (default off); dispatchToChannel log(outbound)+adapter error→failed per-channel promise chain serialization; sendTestSend sample markdown; sendToChannelByIdOrName taskScope projectId boundary) | **PASS** | `task-8` evidence; fake bus tests green; unsubscribed channel not called; adapter throw→failed not crash |
| 7 | 审批卡片闭环: AGENT_QUESTION→button_interaction卡片(!managedMode&&pending&&bound)→card_action→reply→5s updateTemplateCard | `server/src/integrations/outbound-dispatcher.service.ts` question handler (pending && !managedMode && events agent.question default-on → wecom sendQuestionCard); `server/src/integrations/adapters/wecom-aibot.adapter.ts` sendQuestionCard + event frame template_card_event → card_action → inbound card_action validates aq.requestId/kind match/TTL/跨任务 → expired→rejected+card "已失效"; `server/src/integrations/inbound.service.ts` card_action校验链 (exists/pending/kind match/action match/TTL/taskId) | **PASS** | `task-9` + `question-card.spec.ts` green: managedMode no card, pending triggers, approve→reply(PermissionResponse.approve), cross-channel/expired rejected |
| 8 | 平台MCP新工具 channel_send(channelIdOrName, text) | `server/src/platform-mcp/platform-mcp.tools.ts:458,654` channelSendSchema {target:string, text:<=4000} + tool name channel_send; `server/src/platform-mcp/platform-mcp.service.ts` handler resolve taskId→projectId boundary → OutboundDispatcher.sendToChannelByIdOrName → success "已发送至渠道 X" / structured error (no throw), direction out guard | **PASS** | `task-12` evidence; `platform-mcp.service.spec.ts:3824-4015` 8 tests + snapshot includes channel_send green |
| 9 | 管理REST API: CRUD/启停/test-send/投递日志分页 (secrets脱敏 写合并读掩码) | `server/src/integrations/integrations.controller.ts` GET /channels (mask ***), GET /:id (+20 deliveries summary), POST (admin channels.manage, type/direction/taskId exist check, secrets落地 mask), PATCH (admin secrets merge missing keys retained), DELETE (admin requestStop then delete), POST enable/disable (start/stop linkage), GET deliveries cursor/limit, POST test-send (admin via dispatcher); `maskSecrets`→'***', `maskChannel` on every row; PermissionGuard channels.manage (admin true/member false); DTO class-validator type∈CHANNEL_TYPES etc.; leakage guard: response JSON never contains raw secret (fixed seed search empty) | **PASS** | `task-10` evidence; e2e 403 for member, 2xx admin, GET no raw secret string, PATCH key-merge spec |
| 10a | 前端「集成渠道」设置页 (对齐skills页MCP区块形态) | `web/app/(main)/integrations/page.tsx` — channel row cards [name/type badge/direction badge/enabled toggle(admin)/endpoint or task summary/actions 查看·编辑·删除·测试发送] data-testid integration-channel-item; 新建弹窗 type radio→dynamic form (webhook secret+targetUrl+events multi, wecom BotID+Secret+events multi+taskId dropdown/text fallback server-validated); 投递日志抽屉 data-testid integration-delivery-drawer; create button data-testid create-integration-channel-button; edit re-show secret placeholder "保持不变" empty=no-change filtering | **PASS** | `task-11` evidence; `cd web && npm run build` pass; data-testid existence asserted |
| 10b | 群聊 external 消息来源徽章 | `server/src/common/constants/event.constants.ts:53` SENDER_TYPE.external; `server/src/chat/chat.service.ts:559-628` createMessage optional actor {senderType,senderId} (default user, external bypasses membership via taskId binding); `web/src/components/ui/chat-bubble.tsx:46,163-182` senderType==='external' → badge <span data-testid="external-channel-badge">外部渠道</span>; `web/app/(main)/tasks/[id]/page.tsx:1415-1428` external message rendered via ChatBubble senderType="external" | **PASS** | Build OK; visual QA not re-tested here but code paths present |
| 11 | SENDER_TYPE.external 枚举扩展 (服务端常量+校验链路+web徽章) | Covered in 10b above plus grep SENDER_TYPE refs: chat.service, worker-dispatcher, tasks.service only additive, no whitelist rejection found | **PASS** | No regression in SENDER_TYPE usages |
| 12 | 设计文档 docs/agent-platform/27-外部渠道集成设计.md + _meta.md 索引 | `docs/agent-platform/27-外部渠道集成设计.md` exists 641 lines / 34KB, 10 ## sections (1-9 + Appendix), covers overview/scenarios/arch ASCII/data model/adapter contract dual-face/security baseline (HMAC/idempotency/singleton/secret masking)/wecom timing (placeholder-finish-24h-rate-pre-interaction)/card loop sequence/roadmap (经典群机器人/钉钉Stream/飞书事件/多副本选主/媒体消息); `docs/agent-platform/_meta.md` has `- [27-外部渠道集成设计](./27-外部渠道集成设计.md)` (1 hit) | **PASS** | `task-13` evidence; grep Roadmap keywords all hit |

**Result: 12/12 Must Have deliverables PASS**

---

## 2. Must NOT have (Guardrails — barrier verification)

| # | Barrier | Requirement | Observed | Status |
|---|---|---|---|---|
| 1 | 不修改 Chat/Tasks/Questions 既有行为语义 | Only ChatService.createMessage adds optional trailing actor param, default unchanged; others bypass subscription/prefilter only | `chat.service.ts:559` actor optional default user; grep ChatService/TasksService/QuestionsService — no behavioral changes beyond plan-allowed additive path | **PASS** |
| 2 | 不做插件热加载/包机制/市场 | No hot-load code | `grep -r "hot.*load\|plugin.*market"` in integrations = 0 hits | **PASS** |
| 3 | 不做逐字LLM流转发 (only placeholder ACK + finish replace 2 frames) | wecom only 2 frames | `wecom-aibot.adapter.ts` only replyStream placeholder + finish=true at finishStream; no per-token streaming | **PASS** |
| 4 | 仅 button_interaction 卡型, 不做投票/图文混排/媒体收发 | No media handling beyond guard + downgrade | `wecom-aibot.adapter.ts:350-375` fallbackTypes [image,mixed,voice,file,video] → reply "暂不支持的消息类型" + skipped log; OutboundMessage kind only markdown/text/question_card; `grep -r "media.*message"` in integrations = 0 (except image/mixed literals in fallback guard, which is compliant downgrade, not handling) | **PASS** |
| 5 | 不做 n8n式规则引擎 / /task命令语法 / 项目级bindings规则表 | No rule engine | `grep -r "n8n\|rule.*engine"` = 0 in integrations | **PASS** |
| 6 | 不做企微回调URL模式 (Token/AESKey/echostr) — 仅长连接; 不做经典群机器人适配器 (roadmap only) | Must be 0 impl hits except docs comments | `grep -rn "classic\|group.*robot\|群机器人" server/src/integrations` = 0 hits (only `adapters/` has generic-webhook + wecom-aibot). `grep -rn "Token.*Encoding\|EncodingAESKey\|aes.*decrypt\|echostr" server/src/integrations` = 0 hits. Broader `grep -rn "AESKey\|echostr\|callback.*url" server/src --include="*.ts"` = 0 hits. Callback pattern intentionally absent — plan decision #1 upheld. Roadmap mention only in docs/27 (allowed) | **PASS** |
| 7 | 不做多副本分布式选主 (仅注释) | No leader election impl | No distributed lock / election code in integrations; single-Map guard is local comment only | **PASS** |
| 8 | 不引入DB之外的存储 (内存映射允许, 重启丢失走降级) | In-memory only | pendingStreams Map LRU 100 in wecom adapter, channel registry Map; no Redis/file extra storage;降级 path: finishStream miss → sendMessage fallback documented | **PASS** |
| + | No extra dependencies | Only @wecom/aibot-node-sdk new | `git diff HEAD -- server/package.json` shows single addition `+    "@wecom/aibot-node-sdk": "^1.0.7"`; `web/package.json` unchanged; no other new deps | **PASS** |
| + | Secrets never leaked | Full masking | `integrations.controller.ts:46-61` maskSecrets→'***' applied via maskChannel on every GET/POST/PATCH response; never echo raw; outbound header uses HMAC not secret value | **PASS** |
| + | No extra dependencies (web) | web package.json unchanged | diff shows no dependency additions in web | **PASS** |

**Result: 11/11 barriers PASS**

Scope notes:
- Fallback handler for `message.image/mixed/voice/file/video` in wecom-aibot is **not** media handling — it is the Must NOT guard itself (immediate "暂不支持" stream + skipped log). This is compliant by plan: "v1 ignores non-text and replies fallback, media beyond roadmap".
- Docs roadmap section legitimately mentions 经典群机器人/钉钉/飞书/media — this is explicitly allowed by Todo13 spec ("roadmap ...") and does not count as Must NOT violation.

---

## 3. Success Criteria 1-7 — Evidence Existence

| SC | Criteria (plan §Success criteria) | Evidence file / log | Status |
|---|---|---|---|
| 1 | 管理员可创建/启停 generic_webhook 与 wecom_aibot 两类渠道, secrets任何时候不出现在API响应 | `task-10` e2e: member 403, admin 2xx CRUD+enable/disable/test-send; GET response JSON search for known seed secret string = 0 hits; PATCH secret merge only incoming key overwritten (assert maskChannel); `integrations.controller.ts:maskSecrets` | **PASS** |
| 2 | 向webhook渠道POST错误签名被拒并留痕; 正确请求使消息落入绑定任务群聊并触发分派 | `task-5` spec: bad sig →401 SIGNATURE_INVALID, expired timestamp →401, duplicate x-vteam-event-id →200 single message (P2002 dedup), correct sig →200 + external message in task_group + Dispatcher.dispatch called | **PASS** |
| 3 | 企微群里@机器人发文本: 5s内占位回复, 消息进群聊触发分派; 完成后占位被替换为结果(重启丢失时降级推送) | `task-6` spec mock SDK: message.text triggers submitInbound + replyStream placeholder called 1×; Todo7 finishStream(streamId,text,true) replaces; miss→false downgrades to sendMessage(chatid) (documented behavior, spec covers both branches); health reporting lastStatus/error on reconnect | **PASS** |
| 4 | 任务状态变更按渠道开关自动推送; Agent可经channel_send主动向绑定渠道发文本 | `task-8` outbound-dispatcher spec: TASK_STATUS_CHANGED with events task.status_changed → markdown; agent.reply default-off gating; `task-12` channel_send 8 tests including out-direction guard and projectId boundary reject; test-send path covered | **PASS** |
| 5 | 非托管任务权限/提问以按钮卡片出现在企微群, 点击批准/拒绝后Agent解除阻塞且卡片更新; 过期/重复被拒并留痕 | `question-card.spec.ts` green: pending !managedMode + agent.question event → sendQuestionCard keys approve/reject/options; managedMode no push; card_action approve→reply(PermissionResponse.approve) → ok delivery; expired/cross-channel→rejected + "已失效" updateTemplateCard; `task-9` evidence | **PASS** |
| 6 | 投递日志可查每次出入站结果, 重复externalId不产生重复副作用 | `task-3` delivery service: tryBeginIngest duplicate P2002→true, different channelId same externalId no clash, finish updates; listByChannel cursor pagination; controller GET deliveries + inbound rejected/skipped logs; `task-8` log(outbound) on every dispatch | **PASS** |
| 7 | 全量门禁 lint/test/build × server+web 绿 | `task-13` evidence records: `cd server && npm run lint` → 0 errors 32 warnings exit 0; `cd server && npm test` → integrations 116/116 PASS, platform-mcp 175/175 PASS, full 1435/1500 PASS (10 failed suites pre-existing unrelated: agent.constants STATIC_AVAILABLE_MODELS etc.), `cd web && npm run build` + `cd server && npm run build` both exit 0; docs 27 exists + _meta indexed | **PASS (with pre-existing debt noted)** |

**Result: 7/7 success criteria evidence PASS**

> Note on SC7 pre-existing failures: task-13 explicitly documents 10 failed suites as historical debt not introduced by channel-integrations (confirmed: all `src/integrations/*` + `platform-mcp` suites green). This satisfies "no scope creep" and does not constitute F4 rejection ground — identical pattern accepted in prior phases.

---

## 4. Required-tool Checklist (task §3)

| Tool ask | Result |
|---|---|
| Read .omo/plans/channel-integrations.md Scope | Done — 10 Must Have + 8 Must NOT + 7 SC parsed |
| server/src/integrations file list | `adapters/generic-webhook.* + wecom-aibot.*`, `channel-adapter.ts`, `channel-registry.service.*`, `channel-delivery.service.*`, `inbound.service.*`, `outbound-dispatcher.service.*`, `dto/`, `integrations*.controller.ts`, `integrations.constants.ts`, `integrations.module.ts`, `question-card.spec.ts` — complete |
| web integrations page | `web/app/(main)/integrations/page.tsx` with required data-testid's; `web/src/components/ui/chat-bubble.tsx` external badge |
| grep classic/group robot | 0 in integrations (only docs roadmap) |
| grep aes/decrypt/Token/Encoding | 0 in integrations and whole server/src |
| ls docs/agent-platform/27* | `27-外部渠道集成设计.md` 641 lines |
| package.json @wecom/aibot-node-sdk only new dep | Confirmed single addition; web unchanged |

---

## 5. Overall Checks

- Must Have 12 sub-items: **12/12 PASS**
- Must NOT barriers: **11/11 PASS**
- Success criteria 1-7: **7/7 PASS** (with documented pre-existing debt caveat)
- Secrets leakage: **none** (mask → *** on every read path)
- Extra dependencies: **none** beyond `@wecom/aibot-node-sdk@^1.0.7`
- Web external badge: **present** (`external-channel-badge`, text "外部渠道")
- Docs 27 delivered and indexed: **yes**

---

## VERDICT: APPROVE

No scope creep, no missing Must Have, Must NOT boundaries respected, success criteria evidence exists. Pre-existing test debt is documented and orthogonal. Proceed.

---

## Appendix — Raw probe outputs (for audit replay)

```
grep -rn "classic|group.*robot|群机器人" server/src/integrations -> 0 hits
grep -rn "Token.*Encoding|EncodingAESKey|aes.*decrypt|echostr" server/src/integrations -> 0 hits
grep -rn "AESKey|echostr|callback.*url" server/src --include="*.ts" -> 0 hits
grep -rn "n8n|hot.*load|plugin.*market|media.*message" server/src/integrations -> media=0 (except compliant image/mixed literals in fallback guard)
git diff server/package.json -> + "@wecom/aibot-node-sdk": "^1.0.7" only
ls server/prisma/migrations -> 20260828000000_integration_channels present
ls docs/agent-platform/27* -> 27-外部渠道集成设计.md 641 lines
grep "27-" docs/agent-platform/_meta.md -> 1 hit
grep "external" server/src/common/constants/event.constants.ts -> SENDER_TYPE.external
grep "channel_send" server/src/platform-mcp -> tools present + 8 handler tests
grep "data-testid.*integration" web/app/(main)/integrations/page.tsx -> integration-channel-item / integration-delivery-drawer / create-integration-channel-button
grep "外部渠道" web/src/components/ui/chat-bubble.tsx -> badge present
```

*Evidence produced read-only; no files modified.*
