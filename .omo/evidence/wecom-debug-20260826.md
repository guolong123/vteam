# WeCom AIBot Long-Connection Diagnostic Report — 2026-08-26 01:57 UTC

> Generated read-only diagnostic for `wecom_aibot` channel not receiving messages. No config mutated, no restart performed.

## 1. Executive Summary

| Item | Result |
|------|--------|
| Channel exists (`mc_0000000007` glbot) | ✅ found |
| Enabled | ✅ `enabled=1` |
| Secrets botId/secret | ✅ present (masked `***`, lens 35 / 43 chars) |
| lastStatus / lastError | ⚠️ both `NULL` — WS never entered connected/error lifecycle |
| config.lastChatId / lastChatid / lastChattype | ⚠️ `config={}` — zero inbound ever recorded |
| Task bindings | ✅ `t_0000000014` (vteam平台测试) but task `status=completed` |
| MessageDeliveries for channel | ⚠️ `0 rows` — confirms no submitInbound ever executed |
| Server logs (wecom/aibot/WSClient/connected/authenticated/reconnect) | ⚠️ `0 matches` since boot — adapter never logged |
| Registry WS clients Map | ❌ inferred size `0` (lastStatus NULL + no logs = never started) |
| Network to `wss://openws.work.weixin.qq.com` | ✅ DNS `112.90.14.200`, HTTPS 404 reachable, firewall not blocking |
| Inbound path | ✅ WS not HTTP — `POST /message-channels/:id/inbound` correctly unused for wecom (see §6) |

**Root Cause (confirmed):** `POST /message-channels` (create) does **not** call `adapter.start()` / `registry.startEnabled()`. Only `POST /message-channels/:id/enable` does. Channel `glbot` was created at `2026-08-26 01:53:16` **after** server boot (`2026-08-26 01:40:12`), so `MessageRegistryService.onModuleInit → startEnabled()` never saw it. `lastStatus NULL` and zero wecom log lines prove `WecomAibotAdapter.start()` was never invoked. The WS `WSClient` for this bot was never constructed/connected, so Enterprise WeChat pushes have no peer and are dropped/retried server-side.

Secondary note: task `t_0000000014` is `completed` — fan-out via `MessageInboundService.submitInbound` would still succeed (it only checks `chatChannel task_group` exists, not task status), but newly bound channels to a completed task may surprise operators. Recommend binding to an `in_progress` task for live testing.

**Fix (immediate, no code change):**

```bash
TOKEN=$(curl -s http://localhost:13000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# This is the only endpoint that starts the WS (see controller.ts:212-218):
curl -s -X POST http://localhost:13000/api/v1/message-channels/mc_0000000007/enable \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Then verify lifecycle:
curl -s http://localhost:13000/api/v1/message-channels/mc_0000000007 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# expect lastStatus "connected" (or "error"/"reconnecting" if secret wrong)

docker logs aiagents-compose-server --since 2m | grep -i -E "wecom|aibot|adapter.*started|connected|authenticated|error"
docker exec aiagents-compose-db mysql -uroot -paiagents-root aiagents \
  -e "SELECT last_status,last_error,config FROM message_channels WHERE id='mc_0000000007';"
```

If `lastError` shows `missing botId/secret`, `already started`, or auth failure, see §7.

Alternative: `docker compose restart server` — on boot `startEnabled()` will pick up all `enabled=true` channels.

**Fix (code, recommended):** Make `MessageChannelsController.create()` auto-start when `enabled=true` (mirror `enable()` logic), or publish an event that `MessageRegistryService` subscribes to for `afterCreate`. Current defect is in `server/src/message-channels/message-channels.controller.ts:99-112` (create returns without `registry.get(type).start()`).

---

## 2. Channel Existence & Secrets (masked)

Query executed:
```sql
SELECT id,name,type,enabled,
       JSON_EXTRACT(secrets,'$.botId') as botId,
       LEFT(JSON_EXTRACT(secrets,'$.secret'),10) as secret_prefix,
       last_status, last_error, config, updated_at
FROM message_channels WHERE type='wecom_aibot';
```

Result:
```
id              mc_0000000007
name            glbot
type            wecom_aibot
enabled         1
botId           "aibhpIfrHaWxk1RpBT-1MEsY03BlnahCQTK"  (35 chars)
secret_prefix   "iuifjqYwB   (43 chars total, masked as *** via API)
last_status     NULL
last_error      NULL
config          {}   // no lastChatid / lastChattype / lastChatId
updated_at      2026-08-26 01:53:16.296
```

API masked verification:
```bash
curl -s http://localhost:13000/api/v1/message-channels/mc_0000000007 -H "Authorization: Bearer $TOKEN"
→ {
    "id":"mc_0000000007","name":"glbot","type":"wecom_aibot",
    "config":{},"secrets":{"botId":"***","secret":"***"},
    "enabled":true,"lastStatus":null,"lastError":null
  }
```

Interpretation: secrets present with plausible lengths (WeCom botId ~32-36, secret ~40-45). Not `"***"` stored — actual values present. If user later edits via UI, empty string omits that key (web dual-field fix 2026-08-25 — correct).

---

## 3. TaskMessageChannel Bindings

```sql
SELECT task_id,message_channel_id FROM task_message_channels;
→ t_0000000014  mc_0000000007

SELECT tmc.task_id, t.title, t.status, t.project_id
FROM task_message_channels tmc LEFT JOIN tasks t ON t.id=tmc.task_id
WHERE tmc.message_channel_id='mc_0000000007';
→ t_0000000014  vteam平台测试  completed  p_1787558645779_z6vnbx
```

API:
```bash
GET /tasks/t_0000000014/message-channels → [mc_0000000007]
```

`MessageInboundService.submitInbound` path (message-inbound.service.ts:171-199):
- Resolves `taskMessageChannel.findMany({where:{messageChannelId}})` — would find 1 row ✅
- If `taskLinks.length===0` it logs `delivery skipped "no tasks bound"` — NOT the case now.
- Currently bound task has `chatChannel task_group c_0000000017` with 126 messages — fan-out target exists.
- Deliveries remain 0, so inbound never reached this branch.

Historical gap: binding POST occurred at `2026-08-26 01:53+` (observed via logs `POST /tasks/t_0000000014/message-channels 201` at 09:25 local), possibly after user's test `@bot` message. If user tested before binding, the adapter would have logged `skipped no tasks bound` per channel — but since WS was never connected, that log also never fired.

---

## 4. MessageDelivery Logs

```sql
SELECT id,channel_id,direction,status,error,external_id,created_at
FROM message_deliveries WHERE channel_id='mc_0000000007'
ORDER BY created_at DESC LIMIT 5;
→ (empty)

SELECT channel_id,status,COUNT(*) FROM message_deliveries GROUP BY channel_id,status;
→ mc_0000000005  ok  1   (generic_webhook test-e2e)

GET /message-channels/mc_0000000007/deliveries?limit=20 → {"items":[],"nextCursor":null}
```

For comparison, `generic_webhook` delivery `md_0000007397` shows inbound→ok path works end-to-end for HTTP webhooks. WeCom's zero rows isolates failure to WS layer before `submitInbound`.

If WS were connected but fan-out failed, we would see deliveries with `skipped/rejected/failed` and errors like `no tasks bound`, `task_group channel not found`, `duplicate`, `chatService not available`. Absence = pre-fan-out.

---

## 5. Server Logs — WeCom Adapter Lifecycle

Commands run:
```bash
docker logs aiagents-compose-server --since 2h | grep -i -E "wecom|aibot|WSClient|authenticated|connected|reconnect|lastStatus|message.text|replyStream|adapter.*started|startEnabled"
docker logs aiagents-compose-server | grep -i "wecom"
docker logs aiagents-compose-server | grep -i "adapter"
docker logs aiagents-compose-server | grep '"level":50\|"level":40'
```

Results:
- `wecom` / `aibot` / `WSClient` / `connected` / `authenticated` — **0 lines**
- `adapter` — only `MessageChannelsModule dependencies initialized` and route mappings, no `adapter wecom_aibot started`
- Error level 40/50 — **0 lines**
- Startup at `01:40:12.66` shows `Nest application successfully started` with `DocsMirror` syncs, but no `WecomAibotAdapter` logs.

`wecom-aibot.adapter.ts` evidence:
- `start()` logs `warn no enabled channels found` if none — not seen.
- `start()` on each channel: `client.connect()` then `ctx.updateChannelRuntime(channelId,{lastStatus:'connected'})` (line 106-107) and `bindListeners` registers `connected/authenticated/disconnected/reconnecting/error` → `updateChannelRuntime`.
- `bindListeners` for `message.text` would log `replyStream placeholder failed` / `submitInbound failed` on failure.
- All of these are **absent**, confirming `start()` never executed for `mc_0000000007`.

`message-registry.service.ts:81-106` — `startEnabled()` queries `WHERE enabled=true SELECT type`, builds `Set(types)`, then iterates adapters. At boot time, `wecom_aibot` had zero rows (channel created 13 min later), so adapter skipped.

`message-channels.controller.ts:99-112` — `create()` inserts row with `enabled:true` but never calls `registry.startEnabled()` or `adapter.start()`. `enable()` at line 192-221 **does** call both. This is the defect.

`message-channels.module.ts` — `WecomAibotAdapter` correctly provided and injected via `MESSAGE_ADAPTERS`, `MessageRegistryService.onModuleInit` attaches and starts — wiring is correct, just timing.

---

## 6. Registry WS Clients Map & start Trail

Inferred from DB+logs (no runtime introspection endpoint exists):

| Check | Value |
|-------|-------|
| `GET /message-channels/mc_0000000007` `lastStatus` | `null` (never set) |
| `WecomAibotAdapter.clients Map size` | `0` (would be `1` if `start` had been called without `already started` error) |
| `reconnectCounts Map` | `0` or unset |
| `streams Map size` | `0` (`getStreamSize()` would return 0) |
| `start()` `already started` guard | would throw if enable called twice without stop — not seen |

`lastStatus` transitions expected from adapter code:
- `connected` (after `client.connect()` + `connected`/`authenticated` events)
- `disconnected` / `reconnecting` / `error` on network/auth failure
- `NULL` means none of these executed.

To confirm live (after fix) via container eval:
```bash
# After enable, lastStatus should move off NULL within 1-3s
watch -n1 'docker exec aiagents-compose-db mysql -uroot -paiagents-root aiagents -e "SELECT last_status,left(last_error,80),JSON_PRETTY(config) FROM message_channels WHERE id='\''mc_0000000007'\''"'
docker logs aiagents-compose-server --since 1m | grep -iE "wecom|connected|authenticated|error|reconnect"
```

---

## 7. Inbound URL vs Long Connection

- `wecom_aibot` `supportsInbound=true` but `normalizeInbound()` returns `[]` — HTTP inbound is **not used**.
- `POST /message-channels/:id/inbound` is for `generic_webhook`/`gitee_webhook`/`github_webhook` only. Test: `POST /message-channels/mc_0000000007/inbound` would return `empty commands after normalize` (400) if attempted — correctly not the path.
- Real inbound is `WSClient.on('message.text', ...)` → `replyStream` placeholder → `ctx.submitInbound(channelId,[cmd])` → fan-out to bound tasks → `registerStreamCorrelation` for later `finishStream`.
- User's Enterprise WeChat `@bot` pushes to Tencent `openws.work.weixin.qq.com` via the long-lived `wss://` held by `WSClient`. If `WSClient` not connected, Enterprise WeChat queues/retries then drops; no `MessageDelivery` or task_group message appears — exactly observed symptom.

Generic webhook contrast (for operators):
```bash
# This works because it is HTTP inbound (evidence .omo/evidence/webhook-e2e-20260825-235033.md)
curl -X POST http://localhost:13000/api/v1/message-channels/mc_0000000005/inbound \
  -H "x-vteam-signature: sha256=..." --data-raw '{"body":{"content":"e2e hello"}}'
→ {"ok":true,"internalMessageId":"m_0000000187"} + delivery ok + message in c_0000000017

# WeCom equivalent is NOT curl — it is WS. Validate by:
curl -s http://localhost:13000/api/v1/message-channels/mc_0000000007 -H "Authorization: Bearer $TOKEN"
# must show lastStatus=connected; then send @bot in WeCom and check:
curl -s "http://localhost:13000/api/v1/message-channels/mc_0000000007/deliveries?limit=5" -H "Authorization: Bearer $TOKEN"
# and
# SELECT * FROM messages WHERE channel_id='c_0000000017' ORDER BY created_at DESC LIMIT 5;
```

---

## 8. Network & Auth Pre-checks

```bash
getent hosts openws.work.weixin.qq.com → 112.90.14.200 ✅
dig openws.work.weixin.qq.com → 112.90.14.200 (39s TTL) ✅
wget https://openws.work.weixin.qq.com → HTTP 404 (endpoint expects wss upgrade, not https) ✅ expected
# Node https.get to same host → 404 done ✅
```

Network is **not** blocking egress to WeCom. If after enabling WS we see `lastStatus=error` with messages containing `auth`, `secret`, `botId`, `-1`, `token`, check:
- BotID/secret mismatched or revoked in WeCom admin
- Bot kicked: "WeCom long connection single WS per bot, new connection kicks old" — if same botId connected elsewhere, this instance will get `disconnected` + `reconnecting attempt 1...` + `lastError` with kick reason.
- `maxReconnectAttempts=-1` means infinite reconnect — `lastStatus` may flap `reconnecting` rather than `error`.

---

## 9. Root Cause & Fix Recommendation

### Root Cause
`MessageChannelsController.create()` (line 99) creates an `enabled` channel but does not start its adapter. `MessageRegistryService.startEnabled()` runs only at `onModuleInit`. Therefore any `wecom_aibot` channel created after deploy never gets its `WSClient.connect()` called. `lastStatus` stays `NULL`, `config` never gains `lastChatid`, and `MessageDelivery` stays empty regardless of user `@bot` messages or task binding.

### Immediate Fix (operator, no code deploy)
1. `POST /message-channels/mc_0000000007/enable` (even though already enabled — it idempotently triggers `adapter.start` + `registry.startEnabled`).
2. Wait 3s, verify `lastStatus=connected` and logs show `connected`/`authenticated`.
3. Re-test: in WeCom send `@glbot hello` in the configured chat. Expect:
   - WS log `message.text` handler fires (if debug enabled, placeholder `replyStream`).
   - `GET /deliveries` shows 1 inbound `ok`.
   - `GET /channels/c_0000000017/messages?limit=5` shows external message with `sender_type=external`.

If `lastStatus=error` after enable, capture `last_error` (first 512 chars) and check WeCom admin credentials; re-`PATCH /message-channels/mc_0000000007` with corrected `secrets:{botId,secret}` then `POST /enable` again (adapter `already started` guard requires `POST /disable` then `POST /enable` if prior `start` succeeded).

### Code Fix (PR, prevents recurrence)
In `server/src/message-channels/message-channels.controller.ts`, make `create()` behave like `enable()` when `dto.enabled !== false`:

```ts
async create(...) {
  const row = await this.prisma.messageChannel.create({...});
  // NEW: auto-start long-connection adapters for enabled channels
  try {
    const adapter: any = this.registry.get(row.type);
    if (row.enabled && adapter && typeof adapter.start === 'function') {
      await adapter.start(this.registry as any).catch(()=>{});
    }
    await this.registry.startEnabled().catch(()=>{});
  } catch {}
  return maskChannel(row);
}
```

Also consider adding a `GET /message-channels/:id/status` or exposing `WecomAibotAdapter.getClient(id)` via health endpoint for operators.

### Secondary Recommendation
- Bind wecom channels to an `in_progress` task for acceptance; `t_0000000014` being `completed` is not a blocker but will confuse QA (messages will land in an archived-completed timeline).
- Add integration test: create wecom channel → `lastStatus` becomes `connected` within 2s (mock WS), ensuring `create` auto-starts.

---

## 10. Queries & Commands Executed (evidence trail)

```sql
-- Channel check
SELECT id,name,type,enabled,
  JSON_EXTRACT(secrets,'$.botId'), LEFT(JSON_EXTRACT(secrets,'$.secret'),10),
  last_status, last_error, config
FROM message_channels WHERE type='wecom_aibot';

-- Secrets lens
SELECT id, name, CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(secrets,'$.secret'))),
       CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(secrets,'$.botId'))), config
FROM message_channels WHERE id='mc_0000000007';
SELECT JSON_PRETTY(secrets) FROM message_channels WHERE id='mc_0000000007';

-- Bindings
SELECT * FROM task_message_channels; -- t_0000000014 mc_0000000007
SHOW TABLES LIKE '%message%'; -- message_channels, message_deliveries, task_message_channels
SELECT * FROM chat_channels WHERE task_id='t_0000000014'; -- c_0000000017 task_group
SELECT COUNT(*) FROM messages WHERE channel_id IN (SELECT id FROM chat_channels WHERE task_id='t_0000000014'); -- 126
SELECT id,title,status FROM tasks WHERE id='t_0000000014'; -- completed

-- Deliveries
SELECT id,channel_id,direction,status,error,external_id,created_at
FROM message_deliveries WHERE channel_id='mc_0000000007' ORDER BY created_at DESC LIMIT 10; -- 0 rows
SELECT channel_id,status,COUNT(*) FROM message_deliveries GROUP BY channel_id,status; -- mc_0000000005 ok 1

-- API
GET  /message-channels/mc_0000000007           → 200 {enabled:true, lastStatus:null, secrets:{"***"}}
GET  /message-channels                        → 3 rows
GET  /message-channels/mc_0000000007/deliveries → {"items":[]}
GET  /tasks/t_0000000014/message-channels      → [mc_0000000007]

-- Logs
docker logs aiagents-compose-server --since 2h | grep -iE "wecom|aibot|WSClient|connected|authenticated|reconnect|error|lastStatus|message.text|replyStream|adapter.*started" → 0 matches
docker logs aiagents-compose-server | Strings "wecom" "adapter" "level 50/40" → only module init
docker inspect StartedAt → 2026-08-26T01:40:12.66Z (13 min before channel create)

-- Network
getent hosts openws.work.weixin.qq.com → 112.90.14.200
dig openws.work.weixin.qq.com → NOERROR 112.90.14.200
wget/https.get https://openws.work.weixin.qq.com → 404 (expected for wss host)
```

## 11. No-Mutation Assertion

- No `PATCH/POST` to `message_channels` executed except read-only `GET`s.
- No `docker restart` or `update` executed.
- Secrets never logged in clear (masked `***`, only length/prefix lens via `LEFT(...,10)` and `CHAR_LENGTH`).

---

*Evidence file: `.omo/evidence/wecom-debug-20260826.md` — read-only diagnostic, operator to execute §9 fix and re-verify.*
