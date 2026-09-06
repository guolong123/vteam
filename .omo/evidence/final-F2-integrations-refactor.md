# F2. Code quality review — integrations-refactor

- [x] F2. Code quality review

## Scope
- `server/src/message-channels/*` (adapters: generic-webhook-inbound, gitee, github, wecom-aibot; field-template.util; message-delivery/inbound/registry/controller)
- `server/src/notification*/*` (adapters: webhook, wecom-group-robot; delivery/dispatcher/registry/controller)
- Inherited: read-only audit, no modifications

## Grep Checks

### TODO / FIXME
- `grep -rn TODO|FIXME server/src/message-channels/ server/src/notifications/` → **0 hits**. PASS.

### console.log
- `grep -rn console.log` → **0 hits**. All logging uses Nest `Logger`. PASS.

### as any abuse — 185 hits total, breakdown:
- **Production (`*.ts` excluding `*.spec.ts`): ~78 hits**. Pattern is systematic `(this.prisma as any).messageChannel|*.messageDelivery|*.notificationChannel` — unavoidable because Prisma client types in this repo’s generated client lack the new `messageChannel/notificationChannel/taskMessageChannel/taskNotificationChannel/messageDelivery/notificationDelivery` models in strict TS config, so `as any` is the established workaround (identical to `chat/task` modules). Remaining `as any` are narrow: `fieldMapping` type narrowing `(fieldMapping as any).content/source/user`, `cmd as any` discriminated union access in `message-inbound.service.ts`, adapter duck-typing `(adapter as any).attach/start/handleHandshake`, and `dto.config as any` DTO passthrough. No arbitrary `any` leaking domain invariants; no `as any` hiding logic bugs. **Verdict: justified, consistent with codebase convention.**
- **Tests (`*.spec.ts`): 107 hits** — mock/setup `as any`, expected and harmless.

### timingSafeEqual — presence required
- Found in:
  - `generic-webhook-inbound.adapter.ts:85` — `crypto.timingSafeEqual(a,b)` + dummy `timingSafeEqual(b,b)` on length mismatch (constant-time).
  - `github-webhook.adapter.ts:81` — same pattern.
  - `gitee-webhook.adapter.ts:75` — same pattern (+ `gitee` token header path).
- Non-webhook `wecom-aibot` correctly has no `verifyInbound`/`timingSafeEqual` (WS SDK auth, not HMAC webhook). `webhook-notification` is outbound-only (signs `x-vteam-signature` on send, no inbound verify) — correct.
- **PASS** — all inbound webhooks use timingSafeEqual; dummy comparison prevents timing oracle on length mismatch.

### P2002 (unique violation) handling
- `message-delivery.service.ts:16,46,178` — `tryBeginIngest` unique-key (channelId+externalId) with `P2002 → duplicate:true`; `log()` P2002 → findExisting fallback; `isUniqueViolation` checks `code===P2002` and target includes `external_id|externalId|channel_id`.
- `notification-delivery.service.ts:19,63,145` — symmetric.
- Specs cover `P2002 duplicate → true` and `non-P2002 rethrow` for both services.
- **PASS** — deduplication is bounded and tested; no swallowed non-P2002.

### LRU bounds — 100
- `wecom-aibot.adapter.ts:31` — `private static readonly STREAM_LIMIT = 100;`
- `registerStreamCorrelation()` evicts `streams.keys().next().value` (FIFO/insertion-order) when `size >= 100`, bounded `Map<string,{channelId,frameHeaders,streamId}>`. Tested: `wecom-aibot.adapter.spec.ts:31 'registerStreamCorrelation LRU 100'`.
- Also: notification dispatcher `queues Map` is per-channel promise chain (not LRU, but bounded by channel count).
- **PASS** — inbound stream correlation is bounded to 100; eviction is O(1).

### Secret masking
- `message-channels.controller.ts:37 maskSecrets` + `maskChannel` (all keys → `***`), applied on every read path: `list`, `findOne`, `create`, `update` (return), `enable`, `disable`.
- `notifications/notification-channels.controller.ts:35` identical.
- `wecom-aibot.adapter.ts:82` start path reads `secrets.botId|botID|bot_id` + `secrets.secret` and never logs values; webhook adapters read `secrets.secret|token|webhookSecret` only for HMAC.
- No `process.env` secret leaks; no hardcoded tokens; `grep process.env` in both trees → 0 hits.
- **PASS** — secrets never returned raw; masking consistent.

### Hardcoded secrets / error handling notes
- No hardcoded secrets, no inline tokens.
- Error handling: webhook adapters throw `UnauthorizedException(SIGNATURE_INVALID)` on missing/bad signature; generic-webhook/gitee/github `normalizeInbound` throws `BadRequestException` on invalid JSON/empty/content-length>8000; inbound `message-inbound.service.ts` logs per-command with `delivery.log` (skipped/rejected/failed) and never swallows task fan-out failures silently; `message-delivery`/`notification-delivery` rethrow non-P2002. `catch` blocks are narrow and per-boundary (typed `err: unknown`).

## Deep Samples

### generic-webhook-inbound (server/src/message-channels/adapters/generic-webhook-inbound.adapter.ts:1-221)
- `verifyInbound` — constant-time `timingSafeEqual`, secret required, missing/bad sig → 401. Correct.
- `normalizeInbound` — JSON parsing (rawBody canonical hash for dedup), `x-vteam-event-id` → `dedupKey` else `sha1(rawBody)`, `fieldMapping` trio `renderFieldTemplate` with fallback `body.text|body.content`, content-length 8000 guard, sender extraction. No stub. Clean error codes `BAD_REQUEST`.
- `getRawBody` handles Buffer/string/object; `getHeader` case-insensitive. Tight.

### wecom-aibot (wecom-aibot.adapter.ts:1-571)
- Inbound-only WS lifecycle; `start()` resolves enabled channels via `ctx` + `attachedHost` prisma dual-lookup, binds listeners, sets `lastStatus`/`lastError` (512 truncation), SKIPs missing secrets, throws `already started` only on duplicate client. Correct.
- `streams` LRU 100, `registerStreamCorrelation` + `finishStream` (streams.delete on both success and missing client). `clients/hosts/streams/reconnectCounts` cleared on `stop()`.
- Listeners: `message.text` (strip `@mention`, placeholder `replyStream`, `submitInbound`, correlation), `message.image/mixed/voice/file/video` fallback (text unsupported), `template_card_event` (event_key `aqId:action`, `agentQuestion` lifecycle checks in inbound service handle TTL/status/kind in depth). Reconnect churn logged with counts.
- Minor lint warning: unused `maybeAny` (line 125) — warning only, no error. No TODO, no console, no secret leak.

### field-template.util (field-template.util.ts:1-42)
- `get(data, path)` supports `a.b.c` + bracket `commits[0].message` → `commits.0`; numeric index array handling; `renderFieldTemplate` replaces `{{ path }}` (trimmed), missing→`''`, numbers/booleans stringified, other→`String(v)`. No `as any` leakage; 5 spec cases pass. Minimal, correct.

### notification webhook (webhook-notification.adapter.ts:1-82)
- Outbound-only (`supportsOutbound`, no `verifyInbound` — spec asserts `undefined`). Validates `config.targetUrl` required; signs `x-vteam-signature=sha256=HMAC(bodyStr, secret)` only if secret present (secret-optional is intentional for public webhooks — spec `without secret does not add header`). `bodyObj={event,text,title,ts}`, `res.clone().json()` for externalId fallback, sha1(bodyStr).slice(0,16) else, truncates errText 512. Correct.
- `wecom-group-robot.adapter.ts` peer: supports both `targetUrl|webhookUrl|url`, checks `errcode!==0`, no secret (robot webhook URL is the secret itself).

## TypeScript strictness
- No `TODO/FIXME`, no `console`. `as any` is systematic `prisma` accessor + discriminated union field access; not abuse to widen public API. Field-template util types `data:any` is intentional for dynamic JSON pointer. `notifications` dispatcher uses `queues: Map<string, Promise<void>>` per-channel serial queue — typed.
- Lint: `0 errors, 35 warnings` (repo-wide). Target scopes have 1 warning only: `wecom-aibot.adapter.ts:125 maybeAny unused`. No errors in integrations-refactor scope.
- Build: `nest build` PASS.

## Verdict — PASS (no changes required)

- All 7 grep dimensions pass (TODO/FIXME 0, console 0, timingSafeEqual present+sane, P2002 handled+tested, LRU 100 bounded, masking uniform, `as any` justified and conventional).
- Deep samples show no stubs, no hardcoded secrets, correct error semantics, bounded resources, and complete specs.
- Lint 0 errors, build passes. No file modifications performed (MUST NOT DO).

Evidence: this file `.omo/evidence/final-F2-integrations-refactor.md`
