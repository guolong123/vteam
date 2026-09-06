# Diagnostic: Question card not sent via wecom_aibot

Date: 2026-08-26 04:30 UTC
Target task: `t_0000000014` (vteamxxx, status=completed, managed_mode=1)
Question: `aq_0000000001` / `que_03c4d4e3f001S6fxZ1eMGQf8VT` (kind=question, status=pending)

## 1. Evidence Collected

### 1.1 agent_questions
```
id=aq_0000000001 requestId=que_03c4d4e3f001S6fxZ1eMGQf8VT
taskId=t_0000000014 agentId=a_project_manager sessionId=s_0000000017
kind=question status=pending
content={"questions":[{"header":"WeCom…","question":"…","options":[…]}]}
created_at 2026-08-26 04:21:34 (UTC)
task managed_mode=1, main_agent_instance_id=ta_0000000017 (a_project_manager)
session s_0000000017 status=running, worker w_compose_worker, task_agent_id=ta_0000000017
```

### 1.2 Bindings
```
message_channels: mc_0000000007 glbot type=wecom_aibot enabled=1 last_status=connected
  config={"lastChatid":"GuoLong","lastChattype":"single","lastSenderExternalId":"GuoLong"}
  secrets botId=aibhpIfrHaWxk1RpBT-1MEsY03BlnahCQTK
task_message_channels: t_0000000014 -> mc_0000000007 (exactly 1 binding) ✅
notification_channels: nc_0000000001 wecom_group_robot enabled=1 events=[task.status_changed,agent.question,agent.reply]
task_notification_channels: t_0000000014 -> nc_0000000001 (1 binding) ✅
```

### 1.3 Deliveries (card attempt?)
```
message_deliveries WHERE channel_id=mc_0000000007 ORDER BY created_at DESC:
  only inbound ok rows (md_0000007406 at 04:21:05, md_0000007399 etc) — no outbound, no kind=question_card/template_card.
  No rows after 04:21:34 (question time). Query `WHERE created_at >= 04:20` returns 1 inbound row only.

notification_deliveries ORDER BY created_at DESC:
  nd_0000000006 markdown ok at 04:15:13 (channel_send text via MCP), older markdown only.
  Zero deliveries of kind question_card/template_card, zero deliveries for agent.question after 04:21.

realtime_events type=agent.question:
  ev_0000003281 payload={"managed":true,"question":{"managedMode":true,"status":"pending",...},"taskId":"t_0000000014"}
  → confirms ingress emitted managed=true.
```
**Conclusion: No card delivery was attempted on either channel.**

### 1.4 Server logs (docker logs aiagents-compose-server --since 3h | grep question/wecom)

```
[ingress] session.question 落库 requestId=que_03c4d4e3f001S6fxZ1eMGQf8VT session=s_0000000017 kind=question (workerId=w_compose_worker)  @ 04:21:34
[progression] 托管确认跳过自环 taskId=t_0000000014 requestId=que_03c4d4e3f001S6fxZ1eMGQf8VT 自身主实例权限请求不转发  (TaskProgressionScheduler.routeManagedQuestion)
```
No log containing `sendQuestionCard`, `wecom.*card`, `handleAgentQuestion` (except the ingress log above) — outbound card code never executed.

### 1.5 Code paths checked

| File | Finding |
|------|---------|
| `server/src/workers/worker-event.ingress.ts:handleAgentQuestion` | Correctly persists question + emits `EVENT_TYPES.AGENT_QUESTION` with `managedMode=true` when `tasks.managed_mode=1`. Emits `{managed:true, question:{managedMode:true, ...}}` at scope `task:t_0000000014`. No direct WeCom send. |
| `server/src/notifications/notification-dispatcher.service.ts:handleAgentQuestion` | Guards: `if (isManaged) return; if (autoPushEnabled==false) return` at `handle()`. Default `NOTIFICATION_AUTO_PUSH` unset → `autoPushEnabled=false` → entire `handle()` is no-op (tested in spec: 3 tests assert no dispatch). Even if enabled, would early-return on `isManaged`. Also fallback is text-only, not card. |
| `server/src/message-channels/adapters/wecom-aibot.adapter.ts` | Header: *Keeps WS inbound text + template_card_event handling, removes outbound question_card.* Spec asserts `sendQuestionCard` and `sendOutbound` are `undefined` (`wecom-aibot.adapter.spec.ts:14`). No `sendQuestionCard`, no `sendOutbound`, no subscription to `AGENT_QUESTION`. Adapter is inbound-only (WS `message.text` → `submitInbound` `post_message`, `template_card_event` → `card_action`). |
| `server/src/message-channels/message-registry.service.ts` | Only lifecycle (`startEnabled`/`stop`) + inbound delegate. No outbound question dispatch. |
| `server/src/message-channels/message-channels.module.ts` | No provider subscribing to `RealtimeService` for `AGENT_QUESTION`. |
| `server/src/tasks/task-progression.scheduler.ts:routeManagedQuestion` | Subscribes to `AGENT_QUESTION`, filters `managed==true && resolved!=true`, looks up `agent_questions` pending, then **self-loop guard** lines 357-372: if `row.sessionId.taskAgentId == task.mainAgentInstanceId` → log skip and `return` (do not dispatch to main agent). For t_0000000014, `s_0000000017.taskAgentId = ta_0000000017 = mainAgentInstanceId`, so it skips. No further dispatch, no card fallback. |
| `server/src/message-channels/message-inbound.service.ts` | Handles `card_action` inbound (user clicks card) → `questionsService.reply`. Not the outbound direction. |
| `web/app/(main)/tasks/[id]/page.tsx:3155 + 3433` | Frontend deliberately hides managed questions: `pending[0]?.managedMode ? null : pending[0]` and `if (payload.question.managedMode) return` in `onAgentQuestion`. So managed question does NOT show `QuestionModal`. User sees nothing in vteam web task page. |
| `docker-compose.yml` | No `NOTIFICATION_AUTO_PUSH` env set → defaults to disabled. |

## 2. Root Cause (3-layer discard, observed for question aq_0000000001)

```
opencode ask/question tool → worker session.question event
        → WorkerEventIngress.handleAgentQuestion → DB pending + realtime emit managed:true
               ↓                          ↓                          ↓
   TaskProgressionScheduler    NotificationDispatcher      (no MessageChannel outbound)
   sees managed=true           sees managed=true
   checks session s_0000000017  autoPushEnabled=false  → handle() no-op
   is main instance itself       plus isManaged → return
   → SKIP (log 托管确认跳过自环)   → no webhook send
   result: no dispatch to main agent
               ↓
   No WeCom card sender exists:
   WecomAibotAdapter is inbound-only, sendQuestionCard removed (spec enforces undefined).
   No MessageChannel dispatcher subscribes to AGENT_QUESTION.
   → zero message_deliveries outbound / notification_deliveries for question
               ↓
   Frontend filters managedMode:
   page.tsx 3155 `managedMode ? null : pending[0]` + 3433 `if managedMode return`
   → QuestionModal never opens for managed question.
   → Question stays pending forever, visible only via raw GET /questions?status=pending (768 bytes)
     or SSE payload inspection, not via UI modal.

   User reports "stuck waiting for reply visible in opencode web page":
   - That page is likely the vteam task web (QuestionModal hidden) OR opencode's own
     serve pending question UI (opencode serve exposes GET /question lag). Our card path
     never triggered, so WeCom user never receives template_card to approve.
```

**Channel binding is NOT the cause** — `task_message_channels` is correctly bound. `managedMode + self-loop skip + no outbound card adapter` is the cause.

## 3. Why opencode web page still shows "waiting"

Worker holds opencode session `ses_fcd282cacffertLnMpt6oyf22A` (instanceRef of s_0000000017, status running) blocked on `question` tool. Serve's `GET /sessions/:id/question` returns pending `que_…`, worker polls and re-emits `session.question` (idempotent update). Opencode's own UI (if exposed at `:14000`) will show that pending question. vteam web hides it due to `managedMode` filter. Neither forwards to WeCom.

## 4. Fix Recommendation (in priority order)

### P0 — Restore WeCom question card path for MessageChannel (required for user-visible card)

Wecom_aibot was refactored to inbound-only, but outbound card is needed when `managed_mode=0` (and arguably when `managed_mode=1` but main self-loop). Two options:

**Option A (preferred): Add dedicated QuestionCardDispatcher for MessageChannels**

- New service `MessageQuestionDispatcher` (parallel to `NotificationDispatcher` but for `message_channels`):
  - `onModuleInit` subscribe to `RealtimeService` bus, handle `AGENT_QUESTION` (check `status==pending`, respect `managedMode?` decide).
  - `resolveChannelsForTask(taskId, AGENT_QUESTION)` via `task_message_channels` → `message_channels` (enabled, type=wecom_aibot).
  - For each `wecom_aibot` channel, call adapter `sendQuestionCard` (to be re-added) that sends WeCom template_card via WS `sendMessage`/template_card API with `aqId:action` event_key.
  - Delivery logging via `MessageDeliveryService` (log pending → ok/failed, kind=question_card).

- Re-add `WecomAibotAdapter.sendQuestionCard(channel, {aqId, kind, content})`:
  ```ts
  // uses WSClient.sendMessage(chatId, {msgtype:'template_card', template_card: {...}})
  // chatId from channel.config.lastChatid || fallback group
  // card buttons encode event_key `${aqId}:${action}` for inbound card_action handling
  ```
  Keep spec updated (remove `expect(sendQuestionCard).toBeUndefined()`).

- Scope decision:
  - If `managedMode==true` and not self-loop → still send card? Product decision. Current progression scheduler forwards to main agent via private chat (`dispatchToMainAgent`) for non-self cases. For self-loop case, card to WeCom is the only user-escape hatch, so **should still send card** when `taskAgentId == mainAgentInstanceId` (i.e., bypass skip and send card instead of private dispatch).

**Option B (quick hack): Re-enable NotificationDispatcher for AGENT_QUESTION only**

- Set `NOTIFICATION_AUTO_PUSH=true` in compose, or change `NotificationDispatcherService.handle()` to not early-return for `AGENT_QUESTION` even when `autoPushEnabled==false`. However current wecom_group_robot adapter only sends text fallback, not card, so UX is degraded (user gets plain text, must go web to answer). Not recommended vs Option A.

### P1 — Fix managed self-loop deadlock

`TaskProgressionScheduler.routeManagedQuestion` current logic for `taskAgentId == mainAgentInstanceId` just logs and drops. For main's own question, neither main dispatch nor card happens. Add fallback:

```ts
if (reqSession?.taskAgentId === task.mainAgentInstanceId) {
  // Main asked itself — can't dispatch to itself.
  // Fallback: send WeCom card if task_message_channels has wecom_aibot binding,
  // otherwise let QuestionModal show (remove managedMode filter for this case) or emit resolved? 
  this.logger.log(`...自环，改发企业微信卡片...`);
  await this.sendFallbackQuestionCard(taskId, row); // or delegate to MessageQuestionDispatcher
  return;
}
```

Alternatively, change `WorkerEventIngress` to emit `managedMode=false` when `agentId == main_agent_id` AND session is main instance (question from main should go to user, not to main). But that breaks "托管模式由主 Agent 确认" invariant for non-main agents.

### P2 — Frontend visibility fix (if card not available)

If no card, at least make managed pending question visible somewhere: Change `page.tsx:3155` from `managedMode ? null : pending[0]` to show a read-only banner "托管模式下问题已转主 Agent (或待人工处理)" with link to `/questions` list, or allow admin to see managed questions. Currently user has zero visibility.

### P3 — Add delivery observability

- Ensure `message_deliveries` logs `kind=question_card` attempts (already done in NotificationDispatcher pattern).
- Add server log line in `WorkerEventIngress` after emit: `emit AGENT_QUESTION managed=${managedMode} taskId=...`.
- Add log in new `MessageQuestionDispatcher` on each card send attempt.

## 5. Minimal patch sketch (if choosing Option A)

```ts
// server/src/message-channels/message-question.dispatcher.ts (new)
@Injectable()
export class MessageQuestionDispatcher implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (()=>void)|null=null;
  async onModuleInit(){
    this.unsubscribe = this.realtime.subscribe(e=> {
      if(e.type!==EVENT_TYPES.AGENT_QUESTION) return;
      void this.handle(e).catch(err=>this.logger.error(err.message));
    });
  }
  private async handle(event:RealtimeEvent){
    const payload=event.payload as any;
    const q=payload.question; if(!q||q.status!=='pending') return;
    // For managedMode self-loop, still send card (don't skip)
    // Resolve wecom_aibot channels bound to task
    const links=await this.prisma.taskMessageChannel.findMany({where:{taskId:q.taskId}});
    if(!links.length) return;
    const ids=links.map(l=>l.messageChannelId);
    const channels=await this.prisma.messageChannel.findMany({where:{id:{in:ids}, enabled:true, type:'wecom_aibot'}});
    for(const ch of channels){
      const adapter=this.registry.get('wecom_aibot') as WecomAibotAdapter;
      // delivery log + adapter.sendQuestionCard
    }
  }
}

// wecom-aibot.adapter.ts: re-add
async sendQuestionCard(channel: MessageChannelResolved, q: {id:string, kind:string, content:any}):Promise<void>{
  const chatId = (channel.config as any).lastChatid ?? (channel.config as any).lastSenderExternalId;
  if(!chatId) throw new Error('no chatId');
  const card = buildTemplateCard(q); // template_card with buttons aqId:label
  await this.clients.get(channel.id)?.sendMessage(chatId, {msgtype:'template_card', template_card: card});
}

// task-progression.scheduler.ts: add fallback before return
if(reqSession?.taskAgentId === task.mainAgentInstanceId){
  this.logger.log(`自环，回退发卡`);
  // delegate to MessageQuestionDispatcher or direct send
  await this.fallbackCard(taskId, row);
  return;
}
```

## 6. Verification checklist after fix

- [ ] Insert a test question via `POST /worker/events` `session.question` for t_0000000014 (managed=1, main instance) → `message_deliveries` gets `direction=outbound|inbound?` `kind=question_card` `status=ok`, server log shows `wecom sendQuestionCard` ok.
- [ ] WeCom user receives template_card (buttons approve/reject or question options), clicking triggers `template_card_event` → `MessageInboundService` `card_action` → `questionsService.reply` → `requestId` resolved, opencode serve resumes.
- [ ] `GET /questions?taskId=t_0000000014&status=pending` goes empty, session s_0000000017 transitions idle/running as expected.
- [ ] Non-managed task question still sends card and also shows `QuestionModal` (managedMode false).
- [ ] Logs: `docker logs server --since 5m | grep -E "question|wecom.*card|MessageQuestion"` shows send attempt and result.

## 7. Current state summary (for handoff)

- DB bindings OK, adapter connected, no outbound attempt made → not a binding/config error.
- AutoPush disabled + wecom_aibot inbound-only + progression self-loop skip = triple cause.
- Task t_0000000014 completed but s_0000000017 still running blocked on question — needs manual `POST /questions/aq_0000000001/reply` or fix then retry to unblock.
- Report file: `.omo/diagnostic-question-card.md`
