# Evidence custom-local-model

- Prisma schema updated: Model added baseUrl TEXT nullable, providerType VARCHAR default cloud
- Migration created: 20260821090000_add_model_local_fields
- Prisma generate success (server/prisma/schema.prisma)
- Seed added ollama-local/qwen3-8b and custom-local/my-model
- DTOs updated: Create/Update/Query DTO providerType+baseUrl, SetModelCredentialDto token optional
- Service updated: findAll providerType filter, create/update baseUrl consistency, setCredential local skip, listProviders meta
- Worker injector updated: ensureLocalProviderKeys dummy, buildOpencodeConfig writeOpencodeConfig
- Frontend types updated: ApiModel/ProviderSummary baseUrl providerType
- Frontend models page added add-local-model modal (admin)
- Tests: server models.service.spec 37 passed, models.controller.spec 19 passed, worker 374 passed, web build success
- TSC: server tsc --noEmit pass, worker tsc pass
