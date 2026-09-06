# Task 6 Evidence — WecomAibot adapter (上) SDK lifecycle + 收指令 + 流式占位

## Files
- server/package.json + package-lock.json (dependency @wecom/aibot-node-sdk@1.0.7)
- server/src/integrations/adapters/wecom-aibot.adapter.ts (type='wecom_aibot', supportsInbound/outbound, Map<channelId,WSClient>, start/stop, listeners, registerStreamCorrelation LRU 100)
- server/src/integrations/adapters/wecom-aibot.adapter.spec.ts (jest.mock SDK, 13 tests)
- server/src/integrations/integrations.module.ts (register WecomAibotAdapter in CHANNEL_ADAPTERS)

## SDK verification
- `npm i @wecom/aibot-node-sdk` → 1.0.7 installed, 8 packages
- `dist/index.d.ts` confirms: `WSClient` with `WSClientOptions{botId,secret,maxReconnectAttempts,heartbeatInterval}`, `WSClient.connect()/disconnect()/on()/replyStream()/sendMessage()`, `generateReqId(prefix)`, `WsFrame{headers:{req_id},body}`, `TextMessage{msgid,chatid,chattype,from, text:{content}}`, MessageType enums
- Import used: `import { WSClient, generateReqId } from '@wecom/aibot-node-sdk'` (named exports per SDK d.ts)

## Adapter behavior
- start(ctx): resolve channelIds via prisma.findMany {type: wecom_aibot, enabled:true}; guard clients.has(channelId) throw 'already started'; new WSClient({botId, secret, maxReconnectAttempts:-1, heartbeatInterval:30000}); store Map; bind listeners before connect(); connect(); updateChannelRuntime lastStatus connected
- message.text: strip @prefix via /^@[^ ]+\s*/, build InboundCommand post_message {text, senderExternalId=from.userid, dedupKey=msgid}, immediate replyStream placeholder '✅ 已收到，开始处理…' false with generateReqId('stream'), submitInbound, registerStreamCorrelation(internalMessageId, {channelId, frameHeaders, streamId}), delegate to ctx.registerStreamCorrelation if exists, updateChannelRuntime configMerge {lastChatid, lastChattype}
- image/mixed/voice/file fallback: replyStream '暂不支持该消息类型，请发送文本。' true, log skipped, still update lastChatid
- health listeners: connected/authenticated → lastStatus connected; disconnected → disconnected; reconnecting → reconnecting; error → error
- stop(): disconnect() + clear maps
- LRU: Map size limit 100, evict oldest
- No welcome/template_card_event handlers (Todo9)

## Verification
```
npm test -- wecom-aibot
PASS src/integrations/adapters/wecom-aibot.adapter.spec.ts (13 tests)
npm run build
nest build — success, no errors
```

## Tests summary (13)
- metadata type/supports
- start creates WSClient with correct opts + connect
- duplicate start throws already started
- registers 6 listeners
- message.text strips @, dedupKey=msgid, submitInbound, correlation, placeholder, configMerge
- fallback types replyStream finish true
- connected/authenticated/disconnected/reconnecting/error → updateChannelRuntime
- stop cleanup
- LRU eviction after 100
- no welcome/template_card_event handlers
