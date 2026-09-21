# Issues — agent-native-permission-editor

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-19] BLOCKING DISCOVERY (orchestrator, verified empirically) — the restart endpoint does NOT re-inject a policy change

**The plan's central premise for todo 5/8 is factually wrong.** The plan says: "`roles.json`/`opencode.json` are written only by the worker's `injectAll()` at startup / reload-config ... restart the worker (via `POST /api/v1/workers/:id/restart`)". I tested this on the live stack:

**Command routing (worker/src/index.ts):**
| command | what it does | calls `injectAll()`? |
|---|---|---|
| `reload-config` (:769) | re-fetch resources → `injector.injectAll()` → then restart decision | **YES** |
| `restart` (:861) | `restartCoordinator.requestRestart()` → restart `serve` + `reRegister` | **NO** |
| (startup :970) | `injectAll()` before serve launch | YES |

**Services that enqueue `reload-config`:** `mcp-servers.service.ts`, `skills.service.ts`, `tools.service.ts` — but **NOT** `execution-policies` (verified: no `broadcastCommand`/`RELOAD_CONFIG` reference in `execution-policy.service.ts`), and there is **no** on-demand reload endpoint in `workers.controller.ts`.

**Empirical proof (exact sequence, live compose stack):**
1. `PATCH /execution-policies/ep_product` with `edit['**probe2/**']='allow'` → HTTP 200; `GET` confirms the DB stores `probe2`. ✓
2. `POST /workers/w_compose_worker/restart` → 201 `{command:'restart', queued:true}`.
3. Worker logs: `收到命令 restart` → `[restart] serve 重启完成` → `注册后 MCP 重注入完成: 1 servers` → `重启后重新注册成功`. **No `reload-config`, no `资源重注入完成` line.**
4. Injected `opencode.json` → `probe2 present = False`. **The policy edit never reached the artifact.**
5. Waiting 60s+ (12 polls) made no difference.
6. `docker restart aiagents-compose-worker` (container restart → startup path) DID refresh it — that is the only mechanism that works today.

**Consequences:**
- **Todo 5's UI is misleading as shipped.** It says "restart the worker to apply" and offers a button that calls the restart endpoint — but clicking it will NOT apply the change. The migration is harmless, the API is correct, and the state-only proof (todo 3) is unaffected; the *enforcement* claim is what fails.
- **Todo 8 (b) cannot be satisfied via the mandated endpoint.** Its acceptance criterion is "the edited rule is present in the injected artifacts" — achievable only via a container restart (or a `reload-config` broadcast that nothing triggers for policies).
- The root cause is a **missing feature, not a bug in this plan's code**: nothing broadcasts `reload-config` when an execution policy changes. Best fix: add a `reload-config` broadcast in `ExecutionPolicyService.update` (mirroring `mcp-servers`/`skills`/`tools`), which also makes todo 5's button truthful.

**Decision made (recorded):** the todo-5 notice text + button remain (they are correct that a restart is needed), and todo 8 MUST prove enforcement using a mechanism that actually works, while recording this gap explicitly. The scope-correct repair (broadcast on policy change) is a change to `ExecutionPolicyService` — outside this plan's stated "no server logic change" fence, so it is being raised to the user rather than silently absorbed.

## [2026-09-19] COHERENCE NOTE for F1/F3 — todo 5's notice is now over-cautious (todo 9 changed the mechanism)
Todo 5 (commit `115340a`) ships a notice saying "restart the worker to apply" plus a button that calls `POST /workers/:id/restart`. It was written against the belief that a restart was the ONLY way to apply a policy change.

Todo 9 (`fde75ad`) then fixed the platform so `ExecutionPolicyService.update()` broadcasts `reload-config`, which means an ONLINE worker re-injects **automatically within ~10s** — no restart needed (verified live: probe appeared on poll #2 with no restart issued; todo 8 asserts exactly this).

So todo 5's claim is now **over-cautious but not false**:
- It IS still true for an **offline** worker (`broadcastCommand` skips `status==='offline'`; those refresh on next register).
- It IS still true when an active session defers the `serve` restart (the change is injected to disk but the running `serve` keeps the old config until `serve` restarts).
- It is NOT true for an online idle worker, where the change now lands on its own.

**This is flagged, not silently reworded.** The wording is not a lie, and rewriting it would exceed the todo's scope fence; but a reviewer may reasonably judge the copy imprecise. Deciding whether to reword is the user's call. Recorded here so F1/F3 judge it as a known, disclosed nuance rather than an undiscovered defect.

## [2026-09-19] FINAL WAVE — all four gates APPROVE, two substantive findings raised
Verdicts: F1 APPROVE · F2 APPROVE · F3 APPROVE · F4 APPROVE.

### FINDING A (verified by me empirically) — the editor's PATCH payload drops `config.bashDeny`
Todo 2 (`6b057f7`) added `bashDeny` to `PolicyConfigDto` precisely so it survives the global `whitelist:true` pipe, with the stated rationale: "Because the new editor PATCHes the WHOLE config, an in-scope policy carrying `bashDeny` would lose it on save." But the editor's payload type is `{ permission, correction, tools }` (`web/app/(main)/agents/page.tsx:898-902`), and `EffectivePermission.bashDeny` (`:71`) is declared but never read — so the editor still drops it.
**My proof (live):** created a custom policy with `bashDeny:["rm -rf /"]` → stored OK; then PATCHed with the EXACT editor payload shape → `bashDeny = None` → **DROPPED**. Cleaned up.
**Severity:** latent today (no seeded policy carries `bashDeny`; `ROLE_BASH_DENY_PATTERNS=[]`), but it is real data loss for any policy created via API with the field, and it defeats todo 2's stated purpose.
**Tension:** todo 4's fence says "Must NOT change the PATCH endpoint or the payload shape" — so adding `bashDeny` conflicts with a written fence. The plan contains an internal contradiction. DECISION NEEDED FROM THE USER.

### FINDING B (verified by me) — the todo-5 notice copy is factually wrong
Notice says: "权限已保存到策略，但尚未生效：worker 重启后才会写入 opencode.json / roles.json" and "所有已注册 worker 都需重启，新权限才会生效".
Reality (F3 proved live, I confirmed by reading `worker/src/index.ts:769-785`): the todo-9 `reload-config` handler runs `injector.injectAll()` AND then `restartCoordinator.requestRestart()` — so for an online worker with no active session the files are rewritten AND `serve` auto-restarts within ~10-15s, with no manual action. F3 observed the injected `opencode.json` update and the serve PID change (5855→5926→6093→6163) across propagation, with zero manual restarts.
**Severity:** a user-visible false requirement in the exact feature under review. Benign failure mode (clicking restart is a harmless redundant restart), but the copy is wrong.
**Fix:** reword to say the change applies automatically for online workers within seconds, and the button is an optional "restart now" (still useful for offline workers / to force a running session to pick it up). No fence conflict.

## [2026-09-19] RECOVERED — todo 11 was interrupted mid-mutation-proof, leaving a live mutation in the tree
The todo-11 subagent was cut off **after** it ran the discriminating mutation (removing the conditional `bashDeny` spread from the sync effect) but **before** it restored the file, built evidence, or committed. I found `web/app/(main)/agents/page.tsx` carrying the literal marker `// MUTATION t11: bashDeny spread removed` in the working tree, uncommitted, with the running web image (`built 04:43:19Z`) being the MUTATED build (the mutation run was `04:43:31Z`).

**Recovery (orchestrator, verified):**
- The subagent had left a pre-mutation backup at `/tmp/t11-page.tsx.fixed` and recorded its sha in `/tmp/t11-src-before.sha` = `1e95db7aeb6e17e9e3e55a5dd52bef4a43b3d1879aebc894071184b598f1daa4`.
- I restored with `cp` (NOT `git checkout`), then confirmed byte-identity: the restored file's sha256 equals the recorded pre-mutation sha exactly, the `MUTATION t11` marker is gone, and both conditional spreads are present (`:966` sync effect, `:987` currentConfig fallback).
- The mutation log (`/tmp/t11-mutation.log`) confirms the proof DID run and produced the expected discriminating failure: `FAIL ui reason=playwright run failed`.
- The four pre-mutation suites had already gone green (`/tmp/t11-green1|native|restart|create.log` = all PASS).
- `cd web && npx tsc --noEmit` exit 0 on the restored source.
**Lesson:** when a delegated task performs a temporary in-place mutation, the subagent must restore it as its LAST action or be resumed; an interruption can leave a mutation live in the working tree. Always verify with a `MUTATION`/marker grep + sha compare before trusting the tree.
