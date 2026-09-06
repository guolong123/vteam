# Task 7 Evidence — WecomAibot 适配器（下）：主动推送 + 终态替换关联 + 健康上报完善

## Files Modified
- `server/src/integrations/adapters/wecom-aibot.adapter.ts` — add sendOutbound (markdown/text, lastChatid from channel.config, sendMessage via WSClient, errcode throw, question_card guard), finishStream(internalMessageId,text) LRU lookup + replyStream finish true + delete, health reconnect counter (increment on reconnecting, reset on authenticated, after >3 writes error lastError), stop clears reconnectCounts
- `server/src/integrations/adapters/wecom-aibot.adapter.spec.ts` — 11 additional tests: sendOutbound success markdown/text, missing lastChatid TASK_NOT_BOUND, errcode non-zero throw, question_card guard, finishStream hit/miss/client-missing/LRU, health consecutive reconnect (>3 error) and authenticated reset

## Verification
- `npm test -- wecom-aibot` — 24/24 passed (was 13, +11)
- `npm run build` — passes (nest build)

## Functionality
- `sendOutbound(channel,msg)`: checks lastChatid else throws BadRequestException(TASK_NOT_BOUND), posts `{msgtype:'markdown', markdown:{content:msg.text}}` via `client.sendMessage(chatid, body)`, throws if errcode !=0, returns `{externalId: headers.req_id ?? null, meta:{chatid}}`
- `finishStream(internalMessageId,text)`: hit → `replyStream({headers: frameHeaders}, streamId, text, true)` deletes entry returns true; miss or missing client → delete if present returns false
- Health: private `reconnectCounts Map<string,number>`, on `reconnecting` increment and after >3 writes `updateChannelRuntime` with `lastError: reconnect failed after N attempts`, on `authenticated` reset to 0
- No middle frames, no question_card handling (Todo9), pendingStreams cap 100 LRU preserved

## Manual Checks
- SDK `WSClient.sendMessage(chatid, SendMsgBody)` and `replyStream(frame, streamId, content, finish)` signatures verified via `node_modules/@wecom/aibot-node-sdk/dist/index.d.ts`
- No welcome/template_card_event handlers added
