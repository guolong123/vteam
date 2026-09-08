# models-truth fix note — sync converges on worker-executable set (2026-09-08)

## Root cause (proven, not hypothesized)

`syncLiveModels` (server/src/models/models.service.ts) derived liveness SOLELY from
serve `GET /api/model` filtered `status==active`. That registry is loaded ONCE at serve
startup and never refreshed. Evidence:

- Old serve (started 00:14Z): `/api/model` = 26 rows, 8 active = EXACTLY sync's 8 bogus
  liveModels (sync-before.json).
- New serve (started 04:03Z, same Dockerfile pin opencode-ai@1.18.16): `/api/model` =
  31 rows, 7 active = EXACTLY the CLI 7. Registry even GREW 26→31 upstream.
- `opencode models` CLI = Provider.list() (sst/opencode models.ts, auth-filtered) loads
  the offering FRESH per invocation → the executable truth, stable across CLI 1.18.29
  (old container, self-updated from the 1.18.16 pin) and 1.18.16 (fresh container).
- Live Zen offering (GET https://opencode.ai/zen/v1/models, public 200, 70 models,
  contains all 7 CLI ids) does NOT contain ling-3.0-tiny / laguna-s-2.1 / longcat-2.0 /
  north-mini-code → the 4 are retired upstream = unusable, proof. (deepseek-v4-flash-free
  is still Zen-offered but the CLI omits it; CLI is the accepted ground truth → pruned.)
- capabilities.models (7507 ids, 182 keyless providers — V1Driver.listModels pushes ALL
  /provider entries without the key check its comment/spec claim; v1-driver.spec 2 red
  pre-existing) must NEVER become visibility authority → naive option-(a) rejected.

## Fix (option a, snapshot authority NOT granted)

- worker: `resolveExecutableModels()` (index.ts) runs `opencode models` (spawnSync, 15s
  timeout, precedent: mcp-status-probe), parses `providerID/modelID` lines (dedupe,
  junk-line drop), failure/empty → undefined (omit, never assert zero). Threaded through
  buildCapabilities → buildRegisterOptions → registerCurrent (covers reRegister).
  Protocol: `WorkerCapabilities.executableModels?` (worker-protocol.ts + contract.spec).
- server: `WorkerCapabilitiesDto.executableModels?` (else ValidationPipe whitelist strips
  it — register spreads the DTO into capabilities Json). No workers.service logic change.
- server: `syncLiveModels` prefers union of online workers' `executableModels` (validated
  shape); workers WITHOUT the field fall back to legacy /api/model fetch (compat).
  Upsert+enable + orphan-disable unchanged → sync REMAINS the sole visibility granter.
  Snapshot path untouched (new opencode/* rows enabled:false; cleanup only enabled:false
  rows) → no stale-resurrection regression.
- No hardcoded model list anywhere; no DB surgery; no new dependencies.

## disabled: 6205 → 0 → 1720 (expected, not data loss)

- 6205: prior session's sync run disabled the keyless snapshot junk accumulated over time.
- 0: sync-before (this session) — all then-enabled rows were within the stale 8 live set.
- 1720: post-fix sync — 5 bogus opencode rows + 1715 uncredentialed snapshot-junk rows
  (all providers configured=False, verified via /models/providers) disabled + availability
  stripped. Total disabled now 7925 = 6205 + 1720. local/custom + credentialed providers
  are skipped by the (untouched) orphan rule. Dropdown source (available-models) = 7.

## Live proof

- sync-after.json: {synced:7, disabled:1720, liveModels:[exact CLI 7]}.
- /agents/a_product/available-models: exactly the 7 (available-models-after.json).
- :13001 Playwright (tmp spec, removed after): DROPDOWN_IDS = 7/7 expected, 0/5 bogus.
- Freshness: worker img 925b809162d4→2dc1c8f57d50, server e25c6ea912e5→def2813cc3ac;
  worker container b6ba4b71ef40→98ce52019713; init/web untouched; db data intact.
- First sync attempt returned {0,0,[]} because the fresh worker was still offline
  (boot probes) — correct offline-no-prune behavior; re-ran once online.

## Freshness caveat (documented, accepted)

executableModels refreshes on (re)registration (restart/reload-config), not per sync.
Rotation lag is bounded by worker restart; sync never resurrects (snapshot stays
enabled:false). A future heartbeat-carried refresh would tighten this further.
