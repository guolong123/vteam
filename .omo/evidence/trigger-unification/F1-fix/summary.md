# F1-fix — trigger-unification deviations D12-1 + D14-1 (2026-09-17)

## D12-1 path chosen: DB-NOW implementation (NOT plan revision)

Production due-comparison now uses DB time while the fixed-clock test seam is
kept. Plan text needs no revision — decision 12 is honored literally.

### Code (`server/src/timers/trigger.service.ts`)

- `fireDue(now?: Date)` dispatches:
  - **no arg → production** (`fireDueDbNow` via `fetchDbNow`/`selectDueDbNow`/
    `claimRowDbNow`): select + atomic claim both evaluate `due_at <= NOW(3)`
    DB-side; downstream `now` (maxFires/expiresAt/clamp/interval re-arm) comes
    from the same `SELECT NOW(3)`. Raw access uses the repo-precedent
    `$queryRawUnsafe`/`$executeRawUnsafe` (cf. workers/teams/review-round).
  - **explicit `now` → test seam** (`fireDueAt`, the exact previous body):
    Prisma `dueAt: { not: null, lte: now }`. All 25 pre-existing fixed-clock
    specs pass `NOW` explicitly → byte-identical behavior, zero assertion
    changes.
- Atomic-claim equivalence: DB path proceeds only when raw `UPDATE` affected
  rows `=== 1` (same gate as `updateMany.count === 1`); `id` bound via `?`
  placeholder, not string interpolation.
- NULL-safety equivalence (decision 15): both raw statements carry
  `` `due_at` IS NOT NULL ``.
- Ticker now calls parameterless `fireDue()` (was `fireDue(new Date())`).
- Choice documented in the `fireDue` docblock (paths, why the seam stays,
  claim/NULL equivalence).

### Proof the production path genuinely uses DB time

1. Unit (`trigger.service.spec.ts` +4, all green):
   - "无参调用走 DB 时钟" asserts emitted SQL contains `NOW(3)` +
     `` `due_at` IS NOT NULL `` + `ORDER BY \`due_at\` ASC LIMIT 100`, and that
     `findMany`/`updateMany` (app-clock path) are **never called**; row still
     lands `fired`.
   - "DB claim 影响 0 行" asserts overlap → handler not called, `out === []`
     (the `count===1` overlap-safety spec family, DB flavor).
   - Raw-row normalization (`snake_case` + string dates → `TriggerRow`).
   - `SELECT NOW(3)` failure → `[]`, no throw (tick never rejects).
2. Live (`db-live-proof.txt`): verbatim SQL against real MySQL — overdue row
   selected, NULL row excluded, claim affected `1` then `0`. Probes cleaned.

### D14-1 (`server/src/triggers/hook.service.ts`, comments only)

- File-header docblock: single-`server`-replica premise + why (process-local
  veto sees only this process; multi-replica → leader election, out of scope).
- `isTargetBusy` docblock: same premise at the evaluation site.

### Verification

- Baseline (pre-change): `tsc` exit 0; `123 suites / 2831 tests` green.
- After: `tsc` exit 0 (`tsc-after.txt`); `123 suites / 2835 tests` green
  (`jest-after.txt`) — +4 new, zero regressions. Overlap-safety
  (`updateMany count=0 → handler not called`), null-safety query-shape
  (`dueAt: { not: null, lte }`), overdue-clamp and interval re-arm specs all
  green (see `trigger.service.spec.ts` run; full log in `jest-after.txt`).
- Scope: only `timers/trigger.service.ts` (+ its spec) and
  `triggers/hook.service.ts` (comments). No stash/commit; dirty WIP preserved.
