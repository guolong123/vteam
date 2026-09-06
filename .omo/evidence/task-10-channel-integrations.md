# Task 10 — 管理 REST API + 权限点 Evidence

## 1. Files created/modified
- server/src/integrations/dto/create-channel.dto.ts — CreateChannelDto with class-validator (name MaxLength64, type IsIn CHANNEL_TYPES, direction IsIn CHANNEL_DIRECTIONS, taskId optional IsString, config/secrets optional IsObject)
- server/src/integrations/dto/update-channel.dto.ts — UpdateChannelDto with all optional, same validators, secrets merge handled in controller
- server/src/integrations/integrations.controller.ts — @Controller('integrations/channels'), Swagger decorators, GET list/detail masked, POST/PATCH/DELETE with channels.manage, enable/disable, deliveries cursor, test-send via outboundDispatcher
- server/src/integrations/integrations.module.ts — imports [RealtimeModule], controllers [IntegrationsController, IntegrationsInboundController], providers [PermissionGuard, GenericWebhookAdapter, WecomAibotAdapter, CHANNEL_ADAPTERS factory, ChannelRegistryService, ChannelDeliveryService, InboundService, OutboundDispatcherService], exports [ChannelRegistryService, ChannelDeliveryService, InboundService, OutboundDispatcherService, CHANNEL_ADAPTERS]
- server/src/integrations/inbound.service.ts — made ChatService/QuestionsService @Optional() + guard missing case (delivery log failed + ok false)
- server/src/users/roles.constants.ts — added 'channels' to PERMISSION_RESOURCES (9 resources)
- server/prisma/seed.ts — added channels: { view: true, manage: false } to memberPermissions (admin all:true already covers admin)
- server/src/app.module.ts — already imports IntegrationsModule (verified)

## 2. Functionality verified
- Member cannot mutate (403): channels.manage checked via PermissionGuard on POST/PATCH/DELETE/enable/disable/test-send; GET list/detail has no RequirePermission so authenticated can view
- Admin can full CRUD: admin permissions.all=true bypasses resource check
- GET never leaks secrets: maskSecrets helper replaces each key with '***' via Object.keys(secrets).reduce; both list and findOne map through maskChannel
- PATCH merges secrets: newConfig = {...old.config, ...dto.config}, newSecrets = dto.secrets ? {...old.secrets, ...dto.secrets} : old.secrets (undefined keeps old)
- enable/disable triggers adapter lifecycle: enable updates enabled true then tries registry.get(type).start(registry) + registry.startEnabled(); disable updates enabled false then registry.requestStop(id)
- deliveries paginated: GET :id/deliveries delegates to channelDeliveryService.listByChannel with cursor/limit (normalizeLimit 1..100, desc + nextCursor)

## 3. Verification
- npm run build: PASS (nest build, 0 errors, duplicate identifier fixed via listDeliveries rename)
- npm test -- integrations: PASS 7 suites / 116 tests (channel-registry 6, channel-delivery 13, inbound 16, outbound-dispatcher 20, generic-webhook 18, wecom-aibot 24, question-card 19)
- grep -r channels.manage: 15 hits in controller + module docs, confirms permission point wired
- grep -r maskSecrets: controller helper present, no raw secrets returned in GET list/detail/create/patch/enable/disable
- grep secrets not in responses: manual check — controller never returns row.secrets directly, always via maskChannel
- Prisma relations: schema.prisma already has Task.integrationChannels + IntegrationChannel.task relation, IntegrationChannelDelivery channel relation — verified via grep

## 4. Must-do compliance
- integrations.module.ts uses CHANNEL_ADAPTERS factory with GenericWebhookAdapter + WecomAibotAdapter inject
- DTOs use class-validator IsIn CHANNEL_TYPES / CHANNEL_DIRECTIONS, IsString MaxLength64, IsOptional IsObject for config/secrets
- Controller uses @UseGuards(PermissionGuard) + @RequirePermission('channels.manage') for mutating, JwtAuthGuard global for GETs
- Permission point added to roles.constants + seed member matrix channels.manage false
- AppModule already imports IntegrationsModule
- InboundService optional guard prevents startup failure when ChatModule not imported

## 5. Notes
- InboundService ChatService/QuestionsService made @Optional to allow IntegrationsModule to boot without importing ChatModule/QuestionsModule (forwardRef not needed, keeps spec imports:[] semantics while still providing IdGenerator via RealtimeModule)
- Channel IDs generated via idGen.nextId('ic') (strip trailing underscore), aligns with resyncIdPrefix logic
- Test existing member permissions now include channels.manage false — member write attempts correctly 403 via PermissionGuard's matrix check
