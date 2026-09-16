# plan finalize gate — verification notes (NOT committed)

## Baseline (unchanged code)
- server jest tasks/issues/platform-mcp: 17 suites, 577 tests green on rerun
  (one transient run showed 2 fails in gate.spec under parallel load; green in isolation and on rerun — flaky, pre-existing)
- `npx tsc --noEmit` clean in server/ and web/
- Failing-first: new specs red pre-fix (TS2322 'finalize' not assignable; TS2339 attachPlanSink missing)

## After change
- server jest src/tasks + src/issues + src/platform-mcp: **17 suites / 577 tests green**
  (incl. new: verifyEnum pending_final, 7-state const, finalize flip/idempotent/409×5,
  confirm-rejects-pending_final, convergence→pending_final never approved, sink-absent no-op,
  controller finalize forwarding; plan-removal guard green — choke file unchanged)
- server `tsc --noEmit`: clean (after `npx prisma generate` for finalizedBy/finalizedAt)
- web `tsc --noEmit`: clean; `eslint` on touched files: 0 errors (2 pre-existing warnings untouched)
- Playwright (mock API, web dev :3001, killed after): plan-finalize.spec.ts **3/3 green**;
  regression plan-status.spec.ts **4/4 green**
- Screenshots: plan-pending-final.png (modal), plan-after-finalize.png (approved)

## Docker / live (read-only)
- `docker compose build server web` OK; `up -d server web` → both healthy
- live swagger docs-json contains `finalize` (5 hits) → new build serving; web :13001 200
- live DB migration NOT applied (no live writes per policy): 20260917000000_add_plan_finalize_columns
  is additive-nullable and will apply on next init-container run; until then only the NEW
  finalize path would 500 on live, all existing paths byte-identical and unaffected
- No live rows in pending_final (expected: no production convergence calls wired yet;
  gate.attachPlanSink is opt-in; no plan/todo/ledger/boulder files touched)

## Behavior note (per policy, recorded not mutated)
- Review convergence no longer has any path to `approved` directly: gate flips to
  `pending_final` when a sink is attached; user finalize (pending_final→approved) and
  user start (approved→executing) are two separate double-confirm gates; reject stays approved→draft.
