# Task 8 Evidence — 出站分发器：实时事件订阅 + 渠道事件开关 + 发送管道

## Files Created
- `server/src/integrations/outbound-dispatcher.service.ts` — Injectable OnModuleInit/OnModuleDestroy, global RealtimeService.subscribe (no scope, disposer stored), handle switch (TASK_STATUS_CHANGED / AGENT_QUESTION / chat.message.new), per-channel serial queue Map<string,Promise<void>>, delivery log+finish with adapter error isolation, public sendTestSend/sendToChannelByIdOrName, registerQuestionHandler hook, formatTaskStatusMarkdown helper
- `server/src/integrations/outbound-dispatcher.service.spec.ts` — 20 tests with fake realtime bus capture, task status changed triggers/disabled/direction/event-filter/taskId mismatch, adapter error logged via finish failed not blocking other channel, AGENT_QUESTION delegation/managed skip/noop, agent reply final via chat.message.new (agent sender + status sent/final, event subscribed), serial queue Promise chain order, sendTestSend markdown, sendToChannelByIdOrName id/name resolution + project mismatch Forbidden + not found, format helper

## Files Modified
- `server/src/integrations/integrations.module.ts` — add OutboundDispatcherService provider + export

## Verification
- `npm test -- outbound-dispatcher` — 20/20 passed
- `npm run build` — passes (nest build)

## Functionality
- TASK_STATUS_CHANGED: findMany enabled channels filtered by taskId + direction out/inout + config.events includes task.status_changed → dispatchToChannel markdown via formatTaskStatusMarkdown (title via prisma.task, transition from/to, actor)
- AGENT_QUESTION: if payload.question exists and !managedMode and handler registered → delegate to handler (Todo9), else no-op
- chat.message.new / message_created: filter senderType agent + status sent/final + text extraction from content.text/parts/text, resolve taskId via message.taskId or chatChannel lookup or scopeId, filter enabled+out direction+events includes agent.reply → dispatch markdown
- dispatchToChannel: prev queue chain → delivery.log outbound pending → registry.get(type).sendOutbound(resolvedChannel, msg) → finish ok; catch → finish failed / log failed; queue preserved via catch, next set per channel
- sendTestSend(channel): sample `【测试推送】渠道 {name} 连通正常…` via dispatchToChannel
- sendToChannelByIdOrName(scopeTaskId, idOrName, text): findUnique id else findFirst name else scan findMany, verify projectId via prisma.task compare (mismatch Forbidden), then dispatch markdown; not found → NotFoundException
- No polling, no RealtimeService modification, Realtime subscribe global only
