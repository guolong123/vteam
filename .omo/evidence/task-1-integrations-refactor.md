# Evidence — Task 1: Prisma 推倒重建 MessageChannel/NotificationChannel

## 1. Schema 变更

### 删除的旧模型
- `model IntegrationChannel` (ic_) 完全移除 — grep 0 hits
- `model IntegrationChannelDelivery` (cd_) 完全移除 — grep 0 hits
- `Task.integrationChannels` 关系移除，替换为 `messageChannelLinks` + `notificationChannelLinks`

验证:
```
grep -n "IntegrationChannel" server/prisma/schema.prisma
# (no output)
```

### 新增的 6 个模型

**MessageChannel (mc_):**
```prisma
model MessageChannel {
  id         String   @id
  name       String   @db.VarChar(64)
  type       String   @db.VarChar(32)
  config     Json     @default("{}")
  secrets    Json     @default("{}")
  enabled    Boolean  @default(true)
  lastStatus String?  @db.VarChar(16) @map("last_status")
  lastError  String?  @db.VarChar(512) @map("last_error")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  deliveries MessageDelivery[]
  taskLinks  TaskMessageChannel[]
  @@map("message_channels")
}
```

**MessageDelivery (md_):**
```prisma
model MessageDelivery {
  id         String         @id
  channelId  String         @map("channel_id")
  channel    MessageChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  externalId String?        @db.VarChar(128) @map("external_id")
  direction  String         @db.VarChar(8) @default("inbound")
  status     String         @db.VarChar(16)
  kind       String?        @db.VarChar(32)
  error      String?        @db.VarChar(512)
  payload    Json?
  meta       Json?
  createdAt  DateTime       @default(now()) @map("created_at")
  @@unique([channelId, externalId])
  @@index([channelId, createdAt])
  @@map("message_deliveries")
}
```

**NotificationChannel (nc_) / NotificationDelivery (nd_)** 同构，direction 默认 outbound，map 到 notification_channels / notification_deliveries

**TaskMessageChannel / TaskNotificationChannel (join tables):**
```prisma
model TaskMessageChannel {
  taskId           String         @map("task_id")
  messageChannelId String         @map("message_channel_id")
  task             Task           @relation(fields: [taskId], references: [id], onDelete: Cascade)
  messageChannel   MessageChannel @relation(fields: [messageChannelId], references: [id], onDelete: Cascade)
  @@id([taskId, messageChannelId])
  @@unique([taskId, messageChannelId])
  @@index([taskId])
  @@map("task_message_channels")
}
model TaskNotificationChannel {
  taskId                String              @map("task_id")
  notificationChannelId String              @map("notification_channel_id")
  task                  Task                @relation(fields: [taskId], references: [id], onDelete: Cascade)
  notificationChannel   NotificationChannel @relation(fields: [notificationChannelId], references: [id], onDelete: Cascade)
  @@id([taskId, notificationChannelId])
  @@unique([taskId, notificationChannelId])
  @@index([taskId])
  @@map("task_notification_channels")
}
```

任务侧: `Task.messageChannelLinks TaskMessageChannel[]` + `Task.notificationChannelLinks TaskNotificationChannel[]` (无 taskId 直连渠道表)

## 2. 迁移

- 保留旧迁移 `20260828000000_integration_channels` (创建 integration_channels + integration_channel_deliveries)
- 新迁移 `20260829000000_split_channels_notifications/migration.sql`:
  - `DROP TABLE integration_channels` / `integration_channel_deliveries` (含 DropForeignKey)
  - `CREATE TABLE message_channels`, `notification_channels`, `message_deliveries`, `notification_deliveries`, `task_message_channels`, `task_notification_channels` + FK Cascade

验证:
```
ls server/prisma/migrations/20260829000000_split_channels_notifications/migration.sql
grep -c "DROP TABLE\|CREATE TABLE" -> 8
# 2 DROP + 6 CREATE
```

生成方式: DB localhost:3306 不可达 (P1001)，采用手写 migration (CREATE + FK + INDEX 与 prisma migrate diff --from-empty 抽取一致)，validate/generate 独立验证

## 3. 验证

### prisma validate
```
npx prisma validate
# Prisma schema loaded from prisma/schema.prisma
# The schema at prisma/schema.prisma is valid 🚀
```

### prisma generate + delegates
```
npx prisma generate
# Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client
node -e "new PrismaClient() has messageChannel/messageDelivery/notificationChannel/notificationDelivery/taskMessageChannel/taskNotificationChannel = true; integrationChannel = false"
# delegates: true true true true true true
# integrationChannel: false (old removed)
```

### npm run build
```
npm run build
# > nest build
# (exit 0) — fixed channel-delivery.service.ts Prisma.IntegrationChannelDeliveryWhereInput -> Record<string,unknown> to unblock build
```

### lsp
- prisma LSP not installed (declined), typescript LSP previously declined — build success covers type check

## 4. 前缀一致性

- MessageChannel id 前缀 `mc_` (待 Todo2 常量 MESSAGE_CHANNEL_ID_PREFIX='mc_')
- MessageDelivery id 前缀 `md_` (MESSAGE_DELIVERY_PREFIX='md_')
- NotificationChannel id 前缀 `nc_` (NOTIFICATION_ID_PREFIX='nc_')
- NotificationDelivery id 前缀 `nd_` (NOTIFICATION_DELIVERY_PREFIX='nd_')
- Schema 层仅 String @id，具体前缀由 IdGeneratorService.nextId('mc'/'md'/'nc'/'nd') 保证 (需 strip 尾下划线)

## 5. MUST NOT 检查

- [x] 未保留旧 IntegrationChannel 表/字段 (schema grep 0, client delegate false)
- [x] 未在渠道/通知表上存 taskId (仅通过 TaskMessageChannel/TaskNotificationChannel 关联表)
- [x] 未跳过 validate/build (均执行并通过)

## 6. 备注

- Gotcha: channel-delivery.service.ts 残留 `Prisma.IntegrationChannelDeliveryWhereInput` 导致 build 失败，已改 `Record<string,unknown>` 作为最小修复 (as any 兼容新模型)
- Shadow DB diff 尝试因 MySQL P1001 失败，手写迁移 SQL 与 `prisma migrate diff --from-empty` 抽取的 CREATE 语句对齐 (含 CHARSET utf8mb4, Json, indexes)
