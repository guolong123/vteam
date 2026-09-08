# models-sync chain trace (2026-09-08)

## Endpoints & files
- Sync write: `POST /api/v1/models/sync` → `ModelsController.syncLive`
  (`server/src/models/models.controller.ts:80-87`) →
  `ModelsService.syncLiveModels` (`server/src/models/models.service.ts:444-555`).
  - Upstream fetch: live `GET {workerBaseUrl}/api/model` per online worker
    (service:462-466; same endpoint as `WorkerClient.listModels`,
    `server/src/workers/worker.client.ts:376-400`), fallback per-worker
    `workerClient.listModels`, union into `liveSet` (only `enabled!==false` +
    `status active`).
  - Write: `upsertAndEnableCatalogModel` per live ref (505-511; creates
    `enabled:true` or re-enables) + availability upsert for every online
    worker (512-520) + orphan disable (`enabled:false` + delete availability,
    526-548). Tables: `models` (enabled flag), `worker_model_availabilities`.
- Page read: agent-config dropdown (`web/app/(main)/agents/page.tsx:1208-1237`
  `data-testid="model-select"`, options from `models`) ←
  `GET /agents/:id/available-models` (page.tsx:1812-1819) ←
  `AgentsService.getAvailableModels`
  (`server/src/agents/agents.service.ts:300-314`) ←
  `ModelsService.listCatalogModels` (models.service.ts:398-437):
  `models WHERE enabled=true` ∩ has-availability ∩
  (opencode-free | local/custom | credentialed provider).
  Same tables as sync. No hardcoded list in web/ (grep `muse-spark|
  nemotron-3|ling-3.0-flash|big-pickle|mimo-v2` over web/ = zero hits;
  server `STATIC_AVAILABLE_MODELS` = `[]`,
  `server/src/common/constants/agent.constants.ts:43-44`).
- Second writer (ROOT CAUSE): worker register →
  `WorkersService.register` (workers.service.ts:259-271) →
  `ModelsService.syncFromWorkerCapabilities` (models.service.ts:356-390) →
  `upsertCatalogModel` (629-649) creates EVERY capability-reported model with
  `enabled` defaulting `true` (schema.prisma:557 `@default(true)`) +
  availability. Worker `capabilities.models` is a startup snapshot (live:
  thousands of entries incl. rotated-out opencode free models) that goes
  stale on upstream rotation. Cleanup (379-388) deletes availability for any
  model absent from the snapshot — including live-confirmed ones.
- Divergence: after upstream rotation, catalog holds stale snapshot rows
  enabled+available (page shows stale, e.g. muse-spark-1.2/1.3,
  ling-3.0-flash-fin-free, nemotron-3.5-lightning-free) while sync truth is
  the fresh 8; only manual POST /sync reconverges (observed: sync disabled
  6205 orphans; post-sync `models?providerID=opencode` = exactly 8 enabled
  md_0000001688-95, total 6213).
- User claim check: `opencode/nemotron-3.5-lightning-free` ("latest") is NOT
  in sync `liveModels` (8 listed, no 3.5-lightning) → stale per upstream
  truth, correctly excluded.

## Fix (models.service.ts only, no schema/worker/web change)
- `upsertCatalogModel`: registration path creates `opencode/*` rows with
  `enabled:false` (capability snapshot ≠ live confirmation; live-sync stays
  sole granter of visibility via `upsertAndEnableCatalogModel`). Existing
  rows untouched. Non-opencode/local/custom/admin-created semantics unchanged.
- `syncFromWorkerCapabilities` cleanup: `deleteMany` restricted to
  `model: { enabled: false }` rows — stale snapshots can no longer strip
  availability from live-confirmed models (protects "all 8 present"); CONF-01
  fake-model cleanup preserved (fakes are created disabled).
- Page read path unchanged: `enabled ∩ availability ∩ provider-gate` now
  equals exactly the live-confirmed set.
