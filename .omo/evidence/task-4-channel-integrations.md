# Task 4 — 入站管道与路由：InboundService Evidence

**Date:** 2026-08-25  
**Checkbox:** `- [ ] 4. 入站管道与路由：InboundService + SENDER_TYPE.external + ChatService 可选 actor`

## Files Modified/Created
- `server/src/common/constants/event.constants.ts` — added `external:'external'` to `SENDER_TYPE` (now 4 types)
- `server/src/chat/chat.service.ts` — extended `createMessage(channelId, userId, dto, actor?)` with optional trailing `actor?:{senderType:string; senderId:string|null}`; external bypasses `resolveChannelAccess` project-member check, writes `senderType`/`senderId` from actor, retains mention dispatch + main-agent auto-route
- `server/src/integrations/inbound.service.ts` — `Injectable` implements `AdapterHost`; `submitInbound` handles `post_message` (channel validation → task_group lookup → tryBeginIngest dedup → chatService.createMessage with external sender → delivery ok + wecom_aibot stream correlation) and `card_action` (pending/kind/taskId/TTL validation → questionsService.reply); skipped/rejected cases logged via `ChannelDeliveryService.log` and no reply called; `getChannel`/`updateChannelRuntime`/`requestStop` delegated via Prisma/registry
- `server/src/integrations/inbound.service.spec.ts` — 16 tests mocking prisma/delivery/chat/questions/registry; covers post_message success/duplicate/missing group/skipped/disabled/wecom correlation and card_action permission/question/pending/task-mismatch/expired/invalid kind
- `server/src/integrations/integrations.module.ts` — added `ChannelDeliveryService` + `InboundService` providers/exports
- `server/src/common/constants/event.constants.spec.ts` — updated expectation to 4 types

## Verification
```
cd server && npm run build   → PASS (nest build)
cd server && npm test -- inbound → 16 passed, 0 failed
cd server && npm test -- chat.service → 58 passed
cd server && npm test -- event.constants → 6 passed
grep -rn SENDER_TYPE → no whitelist rejects external (only new check SENDER_TYPE.external bypass)
```

## Functionality
- `post_message` creates external message in bound `task_group` channel and triggers main agent via existing dispatcher (no @ → main trigger)
- `card_action` validates aqId pending, kind match (permission approve/reject only, question label), taskId match, TTL not expired, then calls `questionsService.reply` (permission: `once`/`reject`, question: `answers:[[action]]`)
- Skipped/rejected logged with `DELIVERY_STATUS.skipped/rejected`; `requestStop` on deleted/disabled channel orphan cleanup
- `SENDER_TYPE.external` accepted end-to-end

## Notes
- Delivery dedup via `(channelId, externalId)` unique → `tryBeginIngest` P2002 capture
- `InboundService` binds to `ChannelRegistryService.bindInboundDelegate` in constructor to wire AdapterHost without circular ctor
