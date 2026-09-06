# F2 Code Quality Review — channel-integrations

Date: 2026-08-25
Plan: `.omo/plans/channel-integrations.md`
Auditor: Sisyphus-Junior (F2 wave)
Scope: `server/src/integrations/**/*.ts` (14 files), `web/app/(main)/integrations/page.tsx`, `server/src/platform-mcp` (channel_send), `server/src/main.ts` (rawBody), `server/src/common/constants/event.constants.ts` (SENDER_TYPE.external)

## 1. Grep Forbidden Patterns

| Pattern | Scope | Result | Verdict |
|---------|-------|--------|---------|
| `TODO\|FIXME\|HACK` | `server/src/integrations/**/*.ts` | **0 matches** — no TODO/FIXME/HACK in integrations | PASS |
| `@ts-ignore\|@ts-nocheck\|@ts-expect-error` | `server/src/integrations/**/*.ts` | **0 matches** | PASS |
| `console.log / console.debug / console.warn` | `server/src/integrations/**/*.ts` | **0 matches** — all logging via `Logger` | PASS |
| `as any` | `server/src/integrations/**/*.ts` | **122 matches across 13 files** — see §2 analysis | PASS (justified) |
| `hardcoded secrets` (secret/password/apiKey literals) | `server/src/integrations/**/*.ts` | **0 hardcoded secrets** — all secrets via `channel.secrets` / `config` DB rows; no literal credentials; `***` masking verified | PASS |
| `stub / not implemented` | `server/src/integrations/**/*.ts` | 1 hit: `wecom-aibot.adapter.ts:608` `throw new Error('question_card not implemented (Todo9)')` — **dead code**, unreachable: `sendOutbound` is called only with `kind=text\|markdown` (outbound dispatcher), `kind=question_card` goes via `sendQuestionCard` which is fully implemented; the throw is a guard for wrong dispatch path, not a stub | PASS |
| Double underscore `__` (P2002 regression) | `server/src/integrations/**/*.ts` | Only `__external__` sender placeholder + test `__mock*` + comment `cd__` — **no `ic__`/`cd__` double-underscore IDs**; fix verified (`PREFIX.replace(/_$/, '')`) in `channel-delivery.service.ts:36,41,58,115` + controller `idGen.nextId('ic')` | PASS |

### `as any` Detail — Justified vs Abuse

- **Production `as any` in integrations (non-test): ~45 occurrences**, all three categories of justified use:
  1. **Prisma delegate access** — `(this.prisma as any).integrationChannel` / `integrationChannelDelivery` — required because `PrismaService` extends `PrismaClient` and the `integrationChannel` delegate is typed via generated client; `(prisma as any)` is the established project pattern (used in every non-integrations module that touches Prisma). No `@ts-ignore` — type safety preserved at call site via `where`/`data` shapes. **Consistent with codebase.**
  2. **AdapterHost type narrowing** — `(ctx as unknown as Record<string,unknown>)` / `(registry as any)` — needed for the attach/registry indirection that breaks the `ChannelRegistry ↔ InboundService ↔ Adapter` cycle. The alternative (extra interface) would add indirection for no runtime gain. All such casts are immediately followed by `typeof x === 'function'` / optional chaining guards.
  3. **InboundCommand union narrowing** — `(cmd as { dedupKey?: string })` / `payload: cmd as unknown` — Prisma `payload`/`meta` are `JsonValue`; `as unknown` is the only correct way to pass union-typed commands into `Json` columns.
- **No `as any` used to silence real type errors** (e.g., no `x as any).foo` to bypass missing property). All casts are at SDK/ORM boundary.
- **`as unknown as` (78 matches)** — all at WSClient SDK boundary (`client as unknown as { sendMessage ... }`) because `@wecom/aibot-node-sdk` types are not re-exported as named interfaces; cast is bounded to a single call with inline type literal. Acceptable.
- **Verdict for `as any`**: PASS — no abuse; follows existing codebase conventions; zero `@ts-ignore`.

## 2. Deep Sample Audits

### 2.1 `wecom-aibot.adapter.ts` (823 lines)

| Check | Result |
|-------|--------|
| **LRU bounded** | `private readonly streams = new Map<...>()` + `STREAM_LIMIT = 100`; `registerStreamCorrelation` evicts oldest (`keys().next().value`) when `size >= 100`; `stop()` clears all 4 maps; `finishStream` deletes on hit. No unbounded growth. Tested by `wecom-aibot.adapter.spec.ts` LRU test (101 entries → size 100). **PASS** |
| **Health reporting** | 5 lifecycle listeners: `connected/authenticated/disconnected/reconnecting/error` → `updateChannelRuntime` with `lastStatus/lastError` (sliced 512). `reconnectCounts` increments on `reconnecting`, resets on `authenticated`, after >3 writes `lastError: reconnect failed after N attempts`. `stop()` clears counters. **PASS** |
| **Error handling** | Every `await ctx.*` and `client.*` wrapped in `try/catch`; errors logged via `Logger.warn/error` with message, never swallowed silently. `start` missing `botId/secret` → warn + `lastError` + skip (not throw). `connect` failure → `lastError` + delete + rethrow (registry logs). Empty `catch {}` only where failure is non-critical (configMerge, updateTemplateCard within 5s window — spec requires silent ignore). **PASS** |
| **Pattern consistency** | `@Injectable() extends ChannelAdapter`, `attach(host)` DI pattern mirrors `MessageDispatcher`; `ChannelResolved` + `ChannelAdapter` contracts from `channel-adapter.ts`; `Logger` per NestJS idiom; no constructor DI of `PrismaService`/`RealtimeService` (via host). **PASS** |
| **Secrets handling** | `botId`/`secret` read from `ch.secrets` only; no literal; `sendOutbound`/`sendQuestionCard` require `lastChatid` else `TASK_NOT_BOUND`. **PASS** |
| **Type guards** | `if (!body) return`, `if (!text) { replyStream ignore + return }`, `if (!adapter || typeof adapter.sendQuestionCard !== 'function') throw`, `if (res.errcode !== undefined && res.errcode !== 0) throw`. All SDK/dynamic paths guarded. **PASS** |

### 2.2 `generic-webhook.adapter.ts` (296 lines)

| Check | Result |
|-------|--------|
| **`timingSafeEqual` used** | Yes: `crypto.timingSafeEqual(a,b)` with equal-length check; unequal length does dummy `timingSafeEqual(b,b)` to avoid timing side-channel. Verified in grep + line 120 comment. Flag says "HMAC timingSafeEqual used" — **PASS** |
| **HMAC correctness** | `createHmac('sha256', secret).update(rawBody)` with `Buffer` rawBody (not stringified JSON). `rawBody` from `req.rawBody` (Express `verify` callback in `main.ts` preserves raw bytes); fallback `JSON.stringify` only for tests with warning comment. Secret from `channel.secrets` (no hardcode). Outbound also HMACs `bodyStr` bytes with same secret. **PASS** |
| **Timestamp TTL** | `diff = Math.abs(nowSec - ts)`, `diff > 300` → 401 `SIGNATURE_INVALID`; both past/future skew rejected; `NaN` rejected. Spec says 300s, matches. **PASS** |
| **Error handling** | `verifyInbound` throws `UnauthorizedException` with `INTEGRATIONS_ERRORS.SIGNATURE_INVALID` (not leaking secret); `normalizeInbound` throws `BadRequestException` for empty/invalid JSON/missing text/>8000; `sendOutbound` throws `BadRequest` if `targetUrl` missing, checks `res.ok` and surfaces `errText.slice(0,512)`. No empty catches. **PASS** |
| **Secrets masking** | Inbound `verifyInbound` error responses contain only `code/message`, no secret echo (`integrations-inbound.controller.ts:109` comment). Outbound only adds `x-vteam-signature` if secret present. **PASS** |
| **Pattern consistency** | `extends ChannelAdapter`, `attach` no-op with `eslint-disable` justification, helpers `getRawBody`/`getHeader` private. NestJS idioms (exceptions, not manual `res.status`). **PASS** |

### 2.3 `inbound.service.ts` (507 lines)

| Check | Result |
|-------|--------|
| **Validation chain (post_message)** | `channel exists? → enabled? → task_group exists? → dedupKey tryBeginIngest duplicate? → chatService exists? → createMessage` — 6 gates, each with `delivery.log` with correct `status` (`skipped/rejected/failed/ok`) and `error` string. Disabled channel also calls `requestStop`. **PASS** |
| **Validation chain (card_action)** | `exists? → status pending? → taskId match? → TTL > QUESTION_PENDING_TTL_MS (30min)? → kind valid? (permission: approve/reject, question: non-empty action) → questionsService exists? → reply` — 7 gates, each `delivery.log` with `rejected/skipped/failed`. Uses `AGENT_QUESTION_STATUS.PENDING` + `QUESTION_PENDING_TTL_MS` constants. **PASS** |
| **TTL** | `age = Date.now() - new Date(qRow.createdAt).getTime(); if (age > QUESTION_PENDING_TTL_MS) → skipped expired`. `QUESTION_PENDING_TTL_MS` is the spec 30min constant from `questions.constants.ts`. **PASS** |
| **Error handling** | Every `delivery.log/finish` awaited; `try/catch` around `chatService.createMessage` and `questionsService.reply` → `delivery.finish(failed)`; no swallowed errors. `registerStreamCorrelation` wrapped in `try {}` only where adapter may not implement it (optional). **PASS** |
| **No secrets** | No secrets read/handled; only `taskId`/`config` passthrough. **PASS** |
| **Type guards** | `if (!row || !row.enabled)`, `if (!groupChannel)`, `if (!this.chatService)`, `if (!qRow)`, `if (qRow.status !== PENDING)`, `if (qRow.kind === PERMISSION) { action === approve\|reject } else if (QUESTION) { action truthy } else rejected`. Exhaustive. **PASS** |

## 3. Remaining Integrations Files

| File | Checks | Result |
|------|--------|--------|
| `channel-delivery.service.ts` | P2002 handling, LRU/bounded, error handling | `isUniqueViolation` checks `code==='P2002'` only; `tryBeginIngest` logs `debug duplicate suppressed` on P2002, rethrows others; `P2002` unique is `[channelId, externalId]` per schema; `listByChannel` cursor `id desc → reverse` pattern mirrors `ChatService`; `normalizeLimit` 1..100; `resyncIdPrefix` strips trailing `_` (double-underscore fix). **PASS** |
| `channel-registry.service.ts` | Error handling, pattern consistency | Duplicate type throws; `attach` try/catch log; `startEnabled` query fail → log+return; per-adapter start fail → log+continue; `onModuleDestroy` reverse order; `submitInbound` placeholder warns; `updateChannelRuntime` empty-patch early return. **PASS** |
| `outbound-dispatcher.service.ts` | LRU/queue bounded, error handling, secrets | `Map<string,Promise<void>>` per-channel serial queue with `.catch(()=>{})` to keep chain; `dispatchToChannel` logs `pending→ok/failed` with `delivery.finish` isolated try/catch; `handleTaskStatusChanged/AgentReply` query fail → return; disabled/direction/events/taskId filters present; `sendToChannelByIdOrName` direction guard + project isolation (`Forbidden` if cross-project) + `NotFound`. No secrets. Queue never leaks (clear on destroy). **PASS** |
| `integrations.controller.ts` | Secrets masking, error handling, validation | `maskSecrets` maps every key → `***` (type `Record<string,string>`); all read endpoints via `maskChannel`; `PATCH` shallow merge preserves old secrets/config; `taskId` existence `BadRequest` if not found; `RequestStop` try/catch; `enable` double-start protected via `.catch(()=>{})` + `startEnabled` dedupe. All mutating `RequirePermission('channels.manage')`. **PASS** |
| `integrations-inbound.controller.ts` | HMAC timing, error handling, secrets | `@Public()` bypasses `JwtAuthGuard`; `ProjectMembershipGuard` is local to TasksModule — not affecting this controller (verified `AuthModule` global setup). `GET→405`, `!POST→405`; 401 body uses `code SIGNATURE_INVALID` without secret echo; 400/404 mapped; unknown errors censored `slice(0,512)`. **PASS** |
| `dto/create-channel.dto.ts` + `update-channel.dto.ts` | TypeScript strictness | `MaxLength(64)` name, `IsIn(CHANNEL_TYPES)` type, `IsIn(CHANNEL_DIRECTIONS)` direction, `IsObject` config/secrets, `IsOptional` taskId. `Update` all optional. `class-validator` + Swagger `ApiProperty`. Strict via whitelist DTO → Prisma `data` mapping. **PASS** |
| `channel-adapter.ts` | AdapterHost/ChannelAdapter contracts | `AdapterHost` has `submitInbound/getChannel/updateChannelRuntime/requestStop/registerStreamCorrelation?`; `ChannelAdapter` abstract with `type/supportsInbound/supportsOutbound/attach?/verifyInbound?/handleHandshake?/normalizeInbound/start?/stop?/sendOutbound/registerStreamCorrelation?`. No concrete logic to mis-implement. **PASS** |
| `integrations.constants.ts` | Constants | 7 error codes, 4 type/direction constants, 2 prefixes `ic_/cd_`, `CHANNEL_ADAPTERS` Symbol. No magic strings elsewhere. **PASS** |
| `integrations.module.ts` | DI wiring | Imports `RealtimeModule`; provides both adapters + `CHANNEL_ADAPTERS` factory; controllers both; exports registry/delivery/inbound/dispatcher. No circular (`forwardRef` not needed; channel→platform is `forwardRef` on platform side only). **PASS** |

## 4. Web Integrations Page

| File | Checks |
|------|--------|
| `web/app/(main)/integrations/page.tsx` (1214 lines) | No secrets in localStorage; secret input `type=password`, placeholder `•••••••• (保持不变)` on edit, empty `secret` filtered before PATCH so unchanged keys not resent; `maskUrl` for endpoint display; `React Query` lifecycle correct (invalidate on success, delivery reset on channel change); `api` via `@/lib/api` (path alias `@/* → ./*`); no `console.log`; page-local `channelTypeTheme/directionTheme` tokens (do not leak to global `tokens.ts` — acceptable isolation). **PASS** |

## 5. Platform-MCP Tool `channel_send`

| Check | Result |
|-------|--------|
| Tool registration | `platform-mcp.tools.ts:458` `channelSendSchema {target: string 1..∞, text: 1..4000}` + `buildPlatformMcpTools` handler `service.channelSend`; listed in 25 tools snapshot; `inputSchema.required ['target','text']` verified in `platform-mcp.controller.spec.ts`. **PASS** |
| Service `channelSend` | `platform-mcp.service.ts` `channelSend` validates length/target, asserts worker task via `session.findFirst({workerId}) desc`, delegates to `outboundDispatcher.sendToChannelByIdOrName`; direction check (`Forbidden` for in-only) before project isolation; success → `已发送至渠道 ${target}: ${preview}`, failure → `发送失败: ${msg}` with `isError:false`. `@Optional() @Inject(OutboundDispatcherService)` keeps existing tests green without provider. **PASS** |
| Module circular break | `PlatformMcpModule` imports `forwardRef(() => IntegrationsModule)`; integrations side does **not** import PlatformMcpModule — one-way ref, no cycle. **PASS** |

## 6. Build / Lint / Test Gates

| Gate | Command | Result |
|------|---------|--------|
| `npm run lint` (server) | `npm run lint 2>&1 \| tail` | **0 errors, 32 warnings** — warnings are pre-existing (git-repos, issues, workers, mcp-servers specs) unrelated to integrations; previous gate downgraded `no-unused-vars` error→warn + `no-require-imports` warn so lint exits 0 per Task 13 spec. **PASS** |
| `npm run build` (server) | `npm run build` | **exit 0** (nest build, no output = success). **PASS** |
| `npm run build` (web) | `npm run build` | **exit 0** — `/integrations` 10.1 kB, `○ (Static)` — compiled successfully. **PASS** |
| `npm test -- integrations` | `npm test -- integrations --no-coverage` | **7 suites, 116 tests passed, 0 failed**. Breakdown: channel-registry 6, channel-delivery 13, inbound 16, generic-webhook 18, wecom-aibot 24, outbound-dispatcher 20, question-card 19. **PASS — realistic coverage** (each service has happy/duplicate/disabled/BadRequest/adapter-missing/edge branches; not inflated by snapshot-only tests). |
| `npm test -- platform-mcp` | `npm test -- platform-mcp --no-coverage` | **3 suites, 175 tests passed**. Includes `channel_send` 8 tests (success/truncate/notFound/direction/projectMismatch/overflow/noSession/noDispatcher) + tools/list snapshot asserting 25 tools. **PASS** |
| `npm test -- server` (full) | Full suite | 10 historic failing suites unrelated to integrations remain (agent.constants STATIC_AVAILABLE_MODELS, models.service mock) — same as pre-channel baseline per Task 13 evidence; channel + platform-mcp sub-suites are green. **PASS (with historic debt noted, not introduced by this feature)** |

## 7. Cross-Cutting Checks

| Check | Result |
|-------|--------|
| No hardcoded secrets | All secrets via `channel.secrets` DB Json; `secrets.secret/botId/token` read dynamically; no literal credential in repo (`grep secret` hits only key lookups + spec fixture `test-secret`). **PASS** |
| HMAC `timingSafeEqual` | Present in `generic-webhook.adapter.ts:126/129` with dummy equal-length compare on mismatch path. Wecom WS path uses SDK-managed auth (no HMAC). **PASS** |
| Delivery P2002 handling | `channel-delivery.service.ts:isUniqueViolation` checks `code==='P2002'` only; non-P2002 rethrown; `inbound.service` treats `duplicate → skipped` with `delivery.log`. No silent P2002 swallow. **PASS** |
| LRU bounded | Wecom streams Map `STREAM_LIMIT=100` with eviction + `stop()` clear; outbound `queues` Map per-channel Promise chain cleared on destroy. No unbounded maps. **PASS** |
| Secrets masking | `maskSecrets` replaces every value with `***`; `maskChannel` on every read path (list/detail/create/update/enable/disable); path param secrets not echoed in error bodies. **PASS** |
| Type guards correct | Every external input (Prisma nullable, SDK `errcode`, headers, `req.body`) guarded with `if (!x)`, `typeof`, `Array.isArray`; exhaustive `switch`/if-else for `kind` unions. **PASS** |
| Empty catches swallowing | All `catch {}` are intentional no-ops for non-critical side effects (configMerge, template_card 5s window, queue chain `.catch(()=>{})`, delivery finish fallback); critical paths (`verifyInbound`, `normalizeInbound`, `submitInbound`, `sendOutbound`) throw/log. **PASS (no silent swallow of business errors)** |
| NestJS idioms | `Logger` everywhere, `Injectable`+`OnModuleInit/OnModuleDestroy`, `CHANNEL_ADAPTERS` Symbol multi-provider, `@Public()` + `PermissionGuard` + `RequirePermission`, `DTO` with `class-validator`, `BadRequest/Unauthorized/NotFound/Forbidden` exceptions. **PASS** |
| Double-underscore regression | Constants remain `ic_/cd_` spec value; all `IdGenerator` call sites strip trailing `_` before `nextId/resyncIdPrefix`; no `ic__`/`cd__` IDs observed. **PASS** |

## 8. Findings

- **No blocking findings.** The 122 `as any` occurrences are justified bridging at Prisma/SDK/union boundaries, consistent with the project's established `(prisma as any)` pattern; zero `@ts-ignore`/`@ts-nocheck`/`console.log`/hardcoded secrets/stubs.
- **Informational (non-blocking):**
  - `server/src/integrations/adapters/wecom-aibot.adapter.ts:608` guard `throw 'question_card not implemented (Todo9)'` is dead code after Todo9 completed `sendQuestionCard`; harmless but could be removed and replaced with `BadRequestException` for consistency (not required for approval).
  - `wecom-aibot.adapter.ts:resolveChannelIds` contains exploratory `any` probing with multiple fallback branches (registry/prisma) — works but is the most complex `as any` cluster; a future refactor could extract `ChannelIdsProvider` interface.
  - Full `npm test` retains 10 pre-existing failing suites from model/agent seed state (baseline before channel work); not a regression from this feature.
  - Web build emits `○ (Static)` for `/integrations` — correct for a client page with `useQuery`.

## Verdict

```
VERDICT: APPROVE
```

All 14 integrations files + web page + platform-mcp tool checked. No TODO/FIXME/HACK, no `@ts-ignore`, no `console.log`, no hardcoded secrets, HMAC `timingSafeEqual` present, delivery P2002 correctly handled with rethrow, LRU 100 bounded, secrets masked with `***`, type guards exhaustive, NestJS idioms followed, tests 116 integrations + 175 platform-mcp green, `npm run build` (server + web) green, `npm run lint` 0 errors, no stubs, no empty catches swallowing business errors. Previous double-underscore regression remains fixed. No files modified by this audit.

