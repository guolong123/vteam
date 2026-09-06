# Evidence — Task 1: 数据模型与领域常量 (IntegrationChannel/Delivery)

## Commands & Outputs

### 1. prisma validate
```
$ cd server && ./node_modules/.bin/prisma validate
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
The schema at prisma/schema.prisma is valid 🚀
exit 0
```

### 2. prisma generate
```
$ ./node_modules/.bin/prisma generate
✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 249ms
exit 0
```

### 3. npm run build
```
$ npm run build
> server@0.0.1 build
> nest build
exit 0
```

### 4. PrismaClient delegate check (node -e)
```
Has IntegrationChannel: object
Has IntegrationChannelDelivery: object
Methods: findUnique, findFirst, findMany, create, createMany, update, upsert, delete, count, etc.
constants: CHANNEL_TYPES, CHANNEL_DIRECTIONS, DELIVERY_DIRECTIONS, DELIVERY_STATUS, COMMAND_KINDS, OUTBOUND_EVENTS, INTEGRATIONS_ERRORS, CHANNEL_ADAPTERS, CHANNEL_ID_PREFIX, DELIVERY_ID_PREFIX
CHANNEL_TYPES: { generic_webhook: 'generic_webhook', wecom_aibot: 'wecom_aibot' }
CHANNEL_ADAPTERS: symbol Symbol(CHANNEL_ADAPTERS)
ID_PREFIXES: ic_ cd_
```

### 5. migrate dev attempt (DB unavailable)
```
$ npx prisma migrate dev --name integration_channels
Datasource "db": MySQL database "aiagents" at "localhost:3306"
Error: P1001: Can't reach database server at `localhost:3306`
→ Fallback: manual migration at 20260828000000_integration_channels/migration.sql (CREATE TABLE + FK CASCADE)
```

### 6. Files verified
- server/prisma/schema.prisma — appended IntegrationChannel + IntegrationChannelDelivery + Task.integrationChannels
- server/src/integrations/integrations.constants.ts — all 10 exports present
- server/prisma/migrations/20260828000000_integration_channels/migration.sql — exists (1780 bytes, 2 CREATE TABLE + 2 FK)
- .omo/notepads/channel-integrations/learnings.md — appended Task 1 entry

## Fix 2026-08-25 — Todo 1 constants correction
- Fixed `server/src/integrations/integrations.constants.ts` to exactly match plan spec:
  - DELIVERY_DIRECTIONS: `{ inbound:'inbound', outbound:'outbound' }` (was {in,out})
  - DELIVERY_STATUS: `{ ok:'ok', failed:'failed', rejected:'rejected', skipped:'skipped' }` (was pending/success/failed/duplicate)
  - COMMAND_KINDS: `{ post_message:'post_message', card_action:'card_action' }` (was chat/issue_create/unknown)
  - OUTBOUND_EVENTS: `{ TASK_STATUS_CHANGED:'task.status_changed', AGENT_REPLY:'agent.reply', AGENT_QUESTION:'agent.question' }` (was message_created/issue_created/task_status_changed)
- Kept CHANNEL_TYPES, CHANNEL_DIRECTIONS, INTEGRATIONS_ERRORS, CHANNEL_ADAPTERS, CHANNEL_ID_PREFIX, DELIVERY_ID_PREFIX unchanged (verified correct).
- Verified `server/prisma/schema.prisma` Task.integrationChannels relation present (line 157) and migration `20260828000000_integration_channels/migration.sql` exists with 2 CREATE TABLE + 2 FK CASCADE.
- Re-ran `cd server && npx prisma validate && npm run build` exit 0 ✓ (2026-08-25 15:1x UTC)

## Verification
- `cd server && npx prisma validate && npm run build` exit 0 ✓
- PrismaClient can create/delete both models (delegate presence verified; DB unavailable so validate+build suffices per task spec) ✓
- Constants exact-match plan Todo 1 spec ✓
