# F4 Scope Fidelity — replay report

**Verdict: PASS (7/7 replay groups green)**

Regression script: "directly editing the approved formal plan bypassing the mini-loop gets blocked or audited".
Harness level: unit/service-level only (NestJS Test harness + mocked Prisma). No live stack, no live services/data touched.
Product code changes: **none** (verification only). No spec/plan/doc edited.

## Replay commands (verbatim)

Probe: throwaway `/tmp/f4-replay.sh` (outside repo tree), executed then deleted.
Receipt: post-run `ls /tmp/f4*` → `zsh:1: no matches found: /tmp/f4*` (deleted). Pre-existing `git status` deltas in workdir left untouched.

Each replay = `npx jest --runInBand <existing-spec> [-t "<filter>"]` from `server/`. No spec file modified.

| # | Replay (bypass attempt) | Command | Assertion (exact service call + expected) | Result |
|---|---|---|---|---|
| A1 | approved row + `revise` action (must use reject loop) | `npx jest src/tasks/plan-revise-loop.spec.ts -t "错态 approved 修订"` | `service.confirmPlan('t_1',{action:'revise',reason:'想修订'})` on `status=approved` → 409 `PLAN_REVISE_WRONG_STATE`; `prisma.plan.update` NOT called; `rounds.applyRoundUpdate` NOT called | PASS (1 passed) |
| A2 | executing row + `reject` action (must use revise loop) | `npx jest src/tasks/plan-revise-loop.spec.ts -t "错态 executing 打回"` | `service.confirmPlan('t_1',{action:'reject',reason:'想打回'})` on `status=executing` → 409 `PLAN_REJECT_WRONG_STATE`; no DB write, no ledger write | PASS (1 passed) |
| A3 | raw `transition` to illegal state (choke-point guard) | `npx jest src/tasks/plan-lifecycle.service.spec.ts -t "非法目标态"` | `service.transition('t_1','archived')` → throws via `verifyEnum`; `prisma.plan.update` NOT called; `emitPlanStatusChanged` NOT called | PASS (1 passed) |
| A4 | draft row + confirm-to-executing (skip finalize) | `npx jest src/tasks/plan-lifecycle.service.spec.ts -t "错态 draft 确认"` | `service.confirmPlan('t_1',{userId:'u_1'})` on `status=draft` → 409 `PLAN_CONFIRM_WRONG_STATE`; `prisma.plan.update` NOT called | PASS (1 passed) |
| A5 | reject/revise without reason (audit-trail mandatory) | `npx jest src/tasks/plan-revise-loop.spec.ts -t "缺 reason"` | `confirmPlan(...{action:'reject'|'revise', reason:'   '/undefined})` → 400 `PLAN_REJECT_REASON_REQUIRED` / `PLAN_REVISE_REASON_REQUIRED`; no plan write, no ledger write | PASS (2 passed) |
| B | ledger-only edit cannot flip approved status | `npx jest src/issues/review-round.service.spec.ts` (full file) | `ReviewRoundService.applyRoundUpdate(issueId, update)` writes **only** `tx.issue.findUnique`/`tx.issue.update` (`issues.description`); code path contains zero `plan.*` writes, so `plans.status=approved` is unreachable from ledger edits. 5/5 tests green (serializable double-write, last-wins, pending-hash, issueId link-back, ISSUE_NOT_FOUND) | PASS (5 passed) |
| C | force path still audited (not a silent bypass) | `npx jest src/platform-mcp/platform-mcp.service.plan-hash.spec.ts -t "force"` | `notifyAgent` with stale `planHash` + `force:true, forceReason:'线上故障需立即执行'` → bypasses hash gate **and** writes audit row `expect.objectContaining({forceReason:'线上故障需立即执行'})` | PASS (1 passed) |

Full-file baselines also green in passing (revise-loop 23 tests, lifecycle 613-line suite, plan-hash suite) — no regressions introduced (nothing was changed).

## Code references replayed

- `server/src/tasks/plan-lifecycle.service.ts`: `transition` (176), `confirmPlan` (249), `finalizePlan` (299), `rejectPlan` (347), `revisePlan` (397); error codes `PLAN_LIFECYCLE_ERRORS` (61–68)
- `server/src/issues/review-round.service.ts`: `applyRoundUpdate` (36–80) — issues-table-only writes
- `server/src/issues/review-round-gate.service.ts`: convergence/quorum path (revise re-review reuses N/N gate; `expected` retained, `received` reset — locked by revise-loop spec "expected 原样保留、received 清零")

## Conclusion

- Direct approved-row mutation outside the revise loop is **blocked** with wrong-state codes (A1–A4) or rejected for missing audit reason (A5); raw transition choke point rejects illegal states without writing (A3).
- Round-ledger-only edits structurally cannot flip `plans.status` (B: separate table, separate service, no plan write path).
- The force escape hatch remains **audited** via `forceReason` (C), not widened by the hash gate.
- **F4 PASS.** No product code changed; probe deleted; nothing committed.
