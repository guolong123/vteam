# Evidence — Task 2: 适配器框架：ChannelAdapter 抽象、DI 注册表与 host 注入

## Files Created
- `server/src/integrations/channel-adapter.ts` — exports `ChannelResolved` (`id,type,direction,taskId,config:Record<string,any>,secrets:Record<string,any>,enabled`), `OutboundMessage` (`kind:'markdown'|'text'|'question_card'; title?; text; actions?:{key,label}[]; aqId?`), `InboundCommand` union (`post_message{text,senderExternalId?,senderName?,dedupKey?} | card_action{aqId,action,operatorExternalId?}`), abstract `ChannelAdapter` (abstract `type:string`, optional `supportsInbound/supportsOutbound`, optional `verifyInbound(req,channel)`, optional `handleHandshake(req,res,channel):Promise<boolean>`, abstract `normalizeInbound(req,channel):Promise<InboundCommand[]>`, optional `start(ctx:AdapterHost)`/`stop()`, abstract `sendOutbound(channel,msg):Promise<{externalId:string|null;meta?}>`, optional `registerStreamCorrelation` + `attach(host)`), `AdapterHost` interface (`submitInbound(channelId,commands):Promise<{results:Array<{ok:boolean;internalMessageId?:string}>}>`, `getChannel(id):Promise<ChannelResolved|null>`, `updateChannelRuntime(id,patch)`, `requestStop(channelId)`, optional `registerStreamCorrelation`). Comments document attach/host pattern avoids circular deps (MessageDispatcher precedent).
- `server/src/integrations/channel-registry.service.ts` — DI `CHANNEL_ADAPTERS` array (`@Inject(CHANNEL_ADAPTERS)`), `OnModuleInit` builds `Map<string,ChannelAdapter>` by type (duplicate throws `Duplicate channel adapter type: ${type}`), calls `attach(host)` per adapter, then `startEnabled()` (Prisma `integrationChannel.findMany where enabled:true` → Set of types → calls `adapter.start(this)` per enabled type, single failure logs error without blocking others). `onModuleDestroy` reverse-order `stop()`. Implements `AdapterHost` (`getChannel` via `prisma.integrationChannel.findUnique`, `updateChannelRuntime` with `configMerge` merge, `requestStop` delegates to adapter.stop, `submitInbound` delegates to optional `bindInboundDelegate` or warn placeholder for Todo4). Uses `Logger`. Exposes `get(type)`/`all()`.
- `server/src/integrations/integrations.module.ts` — skeleton module with `CHANNEL_ADAPTERS` empty `useValue: []` placeholder + `ChannelRegistryService` provider, exports both. Comment notes Todo10 will replace factory with real adapters/providers.
- `server/src/integrations/channel-registry.service.spec.ts` — 6 fake-adapter tests (registry collection, duplicate throw, startEnabled enabled filtering + failure tolerance, disabled skip, stop reverse order, AdapterHost prisma delegation).

## Verification Commands
```
cd server && npm run build
# → nest build — no errors (exit 0)

cd server && npm test -- channel-registry
# → PASS src/integrations/channel-registry.service.spec.ts
#   6 passed: collection/attach, duplicate throw, startEnabled success/failure tolerance,
#   disabled skip, stop reverse order, getChannel/updateChannelRuntime/requestStop delegation
#   Logs show expected error handling: "adapter wecom_aibot start failed: boom" and "stop failed: stop boom" are caught and logged, not thrown.
```

## Key Assertions
- `svc.get('generic_webhook') === a` and `all().length === 2`, `attach` called with host.
- Duplicate type in `onModuleInit` rejects with `/Duplicate channel adapter type: generic_webhook/`.
- `startEnabled` only calls `start` for adapters whose type appears in enabled channels; failure of one (`wecom_aibot` rejects) still calls `generic_webhook` start.
- `onModuleDestroy` calls stops in reverse insertion order `[wecom_aibot, generic_webhook]`; failure of one does not block other.
- `getChannel('ic_1')` returns mapped `ChannelResolved` from prisma row; `updateChannelRuntime` and `requestStop` delegate correctly.

## Inherited Constraints Satisfied
- No direct `PrismaService`/`RealtimeService` injection in adapters — via `AdapterHost`/`ctx` only.
- No full `IntegrationsModule` (Todo10 skeleton comment only).
- No new dependencies.
- `npm run build` passes.
