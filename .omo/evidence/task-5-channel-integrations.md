# Task 5 Evidence — GenericWebhook 适配器 + @Public 入站端点

## 交付物
- `server/src/integrations/adapters/generic-webhook.adapter.ts` — type='generic_webhook', supportsInbound/Outbound true, verifyInbound (HMAC + timestamp 300s, timingSafeEqual), normalizeInbound (text <=8000, sender, dedupKey), sendOutbound (POST targetUrl with x-vteam-signature)
- `server/src/integrations/integrations-inbound.controller.ts` — @Controller('integrations/channels'), @Public() @All(':id/inbound'), GET 405, POST verify→normalize→submitInbound 流程
- `server/src/main.ts` — enable rawBody true + express.json verify 填充 req.rawBody（Express 场景；Fastify 分支注释说明）
- `server/src/integrations/adapters/generic-webhook.adapter.spec.ts` — 18 单元测试（签名向量/过期/缺头/normalize dedup/ outbound）
- `server/src/integrations/integrations.module.ts` — 注册 GenericWebhookAdapter + CHANNEL_ADAPTERS factory + IntegrationsInboundController
- `server/src/app.module.ts` — 导入 IntegrationsModule

## 功能验收
- Correct signature passes: ✅ (spec "correct signature passes")
- Bad signature 401: ✅ (throws UnauthorizedException with SIGNATURE_INVALID)
- Expired timestamp 401: ✅ (>300s both past/future)
- Duplicate event-id dedup: adapter normalize uses x-vteam-event-id else sha1(rawBody); InboundService.tryBeginIngest 去重，controller 返回 200 + results ok:false（已由 inbound.service 覆盖）
- Outbound POST with signature header: ✅ (fetch POST with x-vteam-signature = sha256 HMAC of JSON body)

## 验证命令
```
cd server && npm test -- generic-webhook
# 18/18 PASS

cd server && npm test -- "channel-|inbound"
# 35/35 PASS (channel-registry, channel-delivery, inbound.service)

npm run build
# PASS (nest build)

npm run test:e2e -- inbound-webhook
# No tests found (expected — no DB e2e yet, per task "do not fail if no DB")
```

## RawBody 关键修复
- main.ts: NestFactory.create(AppModule, { bufferLogs:true, bodyParser:false, rawBody:true })
- 加 verify 回调: express.json({ limit:'5mb', verify: (req, _res, buf) => req.rawBody = buf })
- adapter.getRawBody 优先 req.rawBody Buffer，否则回退 JSON.stringify（测试兼容，生产必有 rawBody）

## 签名细节
- header: x-vteam-signature = `sha256=${hmacHex}`, x-vteam-timestamp = seconds epoch, x-vteam-event-id = dedupKey
- HMAC: crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
- 对比: timingSafeEqual on Buffer.from(signature) vs Buffer.from(expected)，长度不等先 dummy compare

## 风险/备注
- 未添加新 DB 列，复用 IntegrationChannel config.targetUrl + secrets.secret
- 未实现重试队列，sendOutbound 单次 fetch
- 未回显 secrets
