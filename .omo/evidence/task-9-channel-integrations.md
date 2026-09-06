# Task 9 Evidence — 审批卡片闭环

## Summary
Implemented AGENT_QUESTION → button_interaction card → card_action → reply → updateTemplateCard within 5s. Non-managed pending questions trigger wecom sendQuestionCard, managedMode skips, card clicks validated and replied.

## Files Modified
- `server/src/integrations/outbound-dispatcher.service.ts` — handleAgentQuestion now filters pending && !managedMode, delegates to registered handler else queries enabled out/inout channels where events default true for agent.question, dispatches via dispatchQuestionCard with per-channel serial queue + delivery log (pending→ok/failed)
- `server/src/integrations/adapters/wecom-aibot.adapter.ts` — added `sendQuestionCard(channel, question)` building permission (2 buttons approve/reject) and question (options→buttons, fallback markdown "请前往Web处理" when no options or >1 question), via WSClient.sendMessage(template_card), added `event` + `event.template_card_event` listeners parsing event_key `<aqId>:<action>` → card_action submitInbound → updateTemplateCard(text_notice) within 5s silent fallback, updated header doc
- `server/src/integrations/inbound.service.ts` — verified card_action validation: exists, pending, taskId match (cross-channel rejected), TTL via QUESTION_PENDING_TTL_MS, kind/action mismatch, reply mapping (permission once/reject, question answers)
- `server/src/integrations/question-card.spec.ts` — 19 tests covering managedMode skip, pending trigger, default events, handler delegation, permission/question card building, fallback, TASK_NOT_BOUND, template_card_event parsing + update, expired, cross-channel, invalid action
- `server/src/integrations/adapters/wecom-aibot.adapter.spec.ts` — updated must-handle test to expect template_card_event

## Verification
```
npm run build
# > nest build  (pass)

npm test -- question-card
# PASS 19/19
# OutboundDispatcher trigger / managed skip / pending skip / events filter / default true / handler delegation
# Wecom sendQuestionCard permission/question/fallback/TASK_NOT_BOUND
# template_card_event parse + update within 5s / expired → 已失效 / timeout silent
# Inbound validation approve/question/cross-channel/expired/invalid

npm test -- wecom-aibot|outbound|inbound|question-card
# 4 suites 79 tests PASS

npm test -- wecom-aibot  # 24/24 green (updated welcome/template_card_event expectation)
npm test -- outbound-dispatcher  # 20/20
npm test -- inbound  # 16/16
```

## Design Notes
- Outbound hasQuestionEvent returns true when config.events missing (default open per spec)
- Wecom adapter uses WSClient.sendMessage(aibot_send_msg) for active push, updateTemplateCard for 5s window (task_id must match original)
- Inbound TTL uses QUESTION_PENDING_TTL_MS (30min) via Date.now() - createdAt
- Button key encoding `<aqId>:<action>` within 1024B, label truncated to 10 chars
- Fallback markdown "请前往Web处理" when question has no options or multiple questions

## Commits
- feat(integrations): 审批卡片闭环 AGENT_QUESTION→按钮卡片→card_action→reply→卡片回写
