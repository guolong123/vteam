# F2 Code Quality Review — plan-finalize-actions increment (read-only)

Scope: finalize-side files from commits d34d99f / 95216dc / d72ac07 / cd9aa2b / 7130fc5
(+ docs baseline 15397cd). No product code changed by this review.
Method: `git status --porcelain` context → `git show <commit> --stat` enumeration →
Read each new/changed file end-to-end → grep proofs on added lines → happy+error
path trace per new service → migration additivity check.

## 0. Context

`git status --porcelain` (head): working tree dirty with unrelated in-progress
files (boulder.json, evidence jsons, agent.constants, execution-policies,
models, workers, web models pages, worker git-tools/role-guard, untracked
`.omo/drafts/`, `.omo/evidence/plan-finalize-actions/task-1|6/`, `.omo/plans/`
etc.). F2 touched none of these; evidence file only (below).

`git log --oneline` increment (oldest→newest):
- 15397cd docs(plan): finalize dual-anchor, hash hook, revise matrix, C3 gate list (docs only)
- cd9aa2b feat(plan): post-finalize freeze, archive and baseline notice
- 7130fc5 feat(gate): hash-aware execution gate and docs footnote
- 95216dc test(gate): loosen-only audit with no-tighten check
- d34d99f feat(plan): revise-and-rereview mini-loop
- d72ac07 feat(plan): consolidation contract prompts and archive UI

## 1. File enumeration + per-file findings

### cd9aa2b — freeze / archive / baseline notice
| File | Finding |
|---|---|
| `server/prisma/migrations/20260918000000_add_plan_frozen_columns/migration.sql` (new, 5 lines) | ADDITIVE-ONLY: two `ADD COLUMN … NULL` on `plans` (`frozen_version`, `frozen_hash`), no DROP/ALTER-type/rename/backfill. Existing rows → NULL, read/write semantics unchanged. PASS. |
| `server/prisma/schema.prisma` | Adds `frozenVersion`/`frozenHash` optional mapped fields + locked-naming comment. Mirrors migration 1:1. No enum/relation/index change. PASS. |
| `server/src/tasks/plan-lifecycle.service.ts` (+127) | `FrozenAnchor` interface + `resolveFrozenAnchor` pure fn (ledger value or `v0.1` fallback + `computePlanHash(taskId:version)` deterministic backfill, triplet reuse, no new algo); `transition()` extended with optional `frozenVersion/frozenHash` spread-only (old call shapes unchanged); `finalizePlan` append-only 3-piece (freeze+archive-reuse+broadcast), idempotent on approved, 409 `PLAN_FINALIZE_WRONG_STATE` otherwise; `listArchivedReceipts` fail-open copy. Naming `PLAN_*` consistent, comments bilingual precise, error codes namespaced `PLAN_LIFECYCLE_ERRORS`. PASS. |
| `server/src/tasks/plan-docs.service.ts` (+51) | Creed comment rewritten to scoped version (draft-truth vs DB+hash frozen truth — matches todo 3 intent); `writePlanDoc→backfillPlanHash` hardwired hook via `applyRoundUpdate` hash-only patch, warn-only fail-open, pending-hash fallback. No state/version/content generation. PASS. |
| `server/src/issues/review-round-ledger.ts` (+15) | Adds `tryParseLedger` fail-open wrapper (null on missing/corrupt, never throws) for finalize/archive traversal. Does not touch SELECT FOR UPDATE / merge / verdict paths. PASS. |
| `server/src/tasks/tasks.module.ts` (+4) | Adds `IssuesModule` import for the hash-hook wiring; comment asserts no cycle (IssuesModule → RealtimeModule only). PASS. |
| Specs (`plan-finalize-trio.spec.ts` new 319L, `plan-docs.service.spec.ts` +74, `review-round-ledger.spec.ts` +16, `plan-lifecycle.service.spec.ts` +4) | Green-path + concurrency + idempotency coverage; spec-only, no prod impact. PASS (reviewed headers/diffs; full runs owned by F3). |

### 7130fc5 — hash-aware execution gate
| File | Finding |
|---|---|
| `server/src/issues/plan-hash-gate.ts` (new, 78L) | Pure fns: `normalizePlanHash` (trim, non-string/empty→null), `isStalePlanHash` (both-present-and-unequal only, fail-open), `buildStalePlanHashHint` (exact hint naming expected+actual short hashes), `selectFrozenPlanHash` (max-round ledger hash, never throws). Triplet sha1-8 reuse, no new algorithm. All 4 exports consumed by both gates (verified grep). No dead code. PASS. |
| `server/src/chat/worker-dispatcher.ts` (+57) | Adds optional `planHash` input, `assertPlanExecutionAllowed(taskId, planHash)` overload, `resolveFrozenPlanHash` read-only issues scan. Missing side → unarmed (loosen-only). One added `(this.prisma as any)?.issue` line — see §2 disposition (pre-existing file idiom). PASS with note. |
| `server/src/platform-mcp/platform-mcp.service.ts` (+49) | Mirrors dispatcher: `planHash` arg, stale→`plan-gated` + exact hint, message already published. Force path untouched. PASS. |
| `server/src/platform-mcp/platform-mcp.tools.ts` (+8/-1) | Adds optional `planHash` zod string; `force` gains `.preprocess(v => v === true \|\| v === 'true')` string coercion. **Flag (non-blocking):** coercion widens `force` acceptance (`"true"` string now forces) — semantically a loosen of input parsing, consistent with loosen-only direction, but it is a behavior change to a Scope-guardrailed surface (force). F1 scope-fidelity owns the verdict on whether this needed a separate proposal; F2 notes no tighten, no error-code rename, no audit-column change. PASS with note. |
| `web/src/components/teams/TeamRightPanel.tsx` (+33 here) | `PlanStatusResponse` gains `frozenVersion/frozenHash`; badge row renders `#{hash}` mono span. Display-only. PASS. |
| `web/e2e/reference/testids.ts` (+1) | Adds `plan-frozen-hash`. Registry-only. PASS. |
| Specs (`worker-dispatcher.plan-hash.spec.ts` 136L, `plan-hash-gate.spec.ts` 99L, `platform-mcp.service.plan-hash.spec.ts` 212L) | Fail-open matrix + stale-hint exact-match coverage. PASS. |

### 95216dc — loosen-only audit
| File | Finding |
|---|---|
| `server/src/gates/gate-spec-registry.ts` (new, 103L) | `GATE_SPEC_FILES` 16 entries mapping C3 8-gate list → spec files; `SERVER_GATE_BASELINE` (14/165/1) + `WORKER_GATE_BASELINE` (2/88/0) constants. Consumed by `no-tighten-audit.spec.ts` (import verified). Naming `GATE_*` consistent. PASS. |
| `server/src/gates/no-tighten-audit.spec.ts` (new, 96L) | Existence-of-all-16 + allow-side-only assertions (missing-file=red, allow→deny=red, never asserts deny-side). Test-only, zero prod semantics. PASS. |

### d34d99f — revise-and-rereview mini-loop
| File | Finding |
|---|---|
| `server/src/tasks/plan-lifecycle.service.ts` (+157) | `PLAN_REVISE_WRONG_STATE` / `PLAN_REVISE_REASON_REQUIRED` extend `PLAN_LIFECYCLE_ERRORS` (same `PLAN_*` prefix convention); `PlanConfirmAction` gains `revise`; `confirmPlan` dispatches finalize/reject/revise; `rejectPlan` (approved/rejected→draft, version+1 round-unchanged via `bumpLedgerVersion`) and `revisePlan` (executing/completed→draft, version+1 round+1 via `openNextRound` status=collecting) both: reason-required 400, wrong-state 409 with `details.current`, ledger-write warn-only fail-open, system message with from→to+reason. No transition/confirm skeleton change, no throttle/RBAC touch, force untouched. Happy path (revise→rereview→refinalize) and error paths (missing reason, illegal entry, no ledger host) all traced. PASS. |
| `server/src/tasks/dto/plan-confirm.dto.ts` (+15/-) | `action` enum + validator extended with `revise`; reason doc extended. Mirrors service union. PASS. |
| `server/src/tasks/tasks.controller.ts` (+5/-) | Confirm endpoint comment documents reject/revise matrix; passes `dto.action ?? 'confirm'`. Append-only. PASS. |
| `server/src/issues/review-round-ledger.ts` (+14) | Adds `bumpPlanVersion` pure fn (vN/tail-digit/`-r2` fallback). No concurrency/merge change. PASS. |
| Spec `server/src/tasks/plan-revise-loop.spec.ts` (new, 349L) | Entry×action matrix + version/round + force-audit assertions. PASS (headers reviewed). |

### d72ac07 — consolidation prompts + archive UI
| File | Finding |
|---|---|
| `server/prisma/seed.ts` (+5) | Appends `## 收敛契约` block (input=ledger+verdicts, output=frozen-candidate+archive-list) before 修订铁律; priority line preserved (`平台校验 > 本契约 > 计划原文`). Prompt-only, no code path. PASS. |
| `server/src/prisma/seed.spec.ts` (+12) | Asserts contract sentences + `superseded` token. PASS. |
| `web/src/components/teams/TeamRightPanel.tsx` (+55/-2) | `RoundLedgerView` gains `superseded`; `parseRoundLedger` parses it (schemaVersion===1 guard, Array guard); archive aggregation with dedupe key + desc sort; collapsed-by-default toggle `plan-archive-toggle` + items `plan-archive-item` with R{round}·{version} + verdict. Frozen version span `plan-frozen-version` prefers server `frozenVersion`, hash prefers server `frozenHash` falling back to ledger hash. No status-derivation change (still GET plan DB truth). PASS. |
| `web/e2e/reference/testids.ts` (+4) | Adds `plan-frozen-version`, `plan-archive-block/toggle/item`. PASS. |
| `web/e2e/plan-archive.spec.ts` (new, 246L) | Archive reachability + version visibility assertions. PASS (stat reviewed). |

### 15397cd — docs baseline
Single doc `docs/agent-platform/33-评审轮次机制.md` §6 +45 lines (dual-anchor, hash hook, revise matrix, C3 list). Docs-only. PASS.

## 2. Grep proofs (added-line scope, the F2 bar)

Run: for each of the 5 commits, `git show <c> -U0 | grep -E "^\\+" | grep -E "<pattern>"`:

- `as any` / `@ts-ignore` / `@ts-expect-error`:
  - cd9aa2b: **clean**. 95216dc: **clean**. d34d99f: **clean**. d72ac07: **clean**.
  - 7130fc5: **one added line**: `const issueRepo = (this.prisma as any)?.issue;`
    in `worker-dispatcher.ts resolveFrozenPlanHash`. Disposition: NOT a new
    violation class — the file already uses `(this.prisma as any).<model>`
    pervasively (pre-existing idiom for unmigrated Prisma delegates, dozens of
    instances); the added line follows the identical pattern with an added
    optional-chain null-guard. No `@ts-ignore`/`@ts-expect-error` added
    anywhere in the increment. No action.
- `TODO|FIXME|HACK`: **clean in all 5 commits** (no markers added).
- `console.log`: **clean in all 5 commits** (server uses `Logger.warn`
  fail-open paths; web additions contain no `console.log`).
- Broad `Grep` hits for `as any` across `server/src/{tasks,chat,platform-mcp,issues}`
  are pre-existing test-mock / Prisma-delegate casts, none introduced by this
  increment except the single line above.

## 3. Happy + error path traces (one each per new service/hook)

- Freeze (finalizePlan happy): pending_final → ledger read → `resolveFrozenAnchor`
  → `transition(approved, +frozen*)` → system message with version/hash/actor →
  SSE `PLAN_STATUS_APPROVED` with frozen payload. Error: approved→idempotent
  same-row; other states→409 `PLAN_FINALIZE_WRONG_STATE` + `details.current`;
  ledger missing/corrupt→fallback anchor, flip never blocked.
- Hash hook (writePlanDoc happy): locate worker → write file → `backfillPlanHash`
  → `applyRoundUpdate(hash-only)`. Error: no host / write fail → warn only,
  upload still returns; missing hash downstream → `pending-hash` (never
  superseded).
- Hash gate happy: matching hash → original state-gate semantics. Error:
  mismatch → `plan-gated` + exact hint (expected `#frozen`, actual `#caller`)
  at BOTH gates; either side missing → unarmed fail-open; force path unchanged.
- Revise loop happy: executing/completed + reason → draft, version+1, round+1
  collecting, full N/N rereview. Error: no reason→400
  `PLAN_REVISE_REASON_REQUIRED`; wrong state→409 `PLAN_REVISE_WRONG_STATE`;
  no ledger host→flip lands, warn only.
- Reject happy: approved/rejected + reason → draft, version+1, round unchanged.
  Error mirrors revise with `PLAN_REJECT_*` codes.
- Archive UI happy: issues→ledgers→max-round display + collapsed archive toggle
  listing superseded R·version·verdict. Error/degraded: no ledger → "暂无评审轮次";
  plan query error → degraded notice, files display-only.
- no-tighten machine check: 16-file existence + allow-side pins; any deletion
  or allow→deny flip = red; asserts nothing on deny side.

## 4. Migration additivity

`20260918000000_add_plan_frozen_columns/migration.sql`: two nullable
`ADD COLUMN`s, no default/constraints/index changes, no data rewrite, no
down-migration hazards beyond column drop. `schema.prisma` mirrors exactly.
Verdict: **additive-only, PASS**.

## 5. Naming / comment / error-code consistency

- Error codes: all new codes under existing `PLAN_LIFECYCLE_ERRORS` with
  `PLAN_*` prefix (`PLAN_FINALIZE_WRONG_STATE`, `PLAN_REJECT_*`,
  `PLAN_REVISE_*`, `PLAN_CONFIRM_*`, `PLAN_COMPLETE_*`); 409-wrong-state /
  400-reason-required / 403-main-only mapping preserved. `REVIEW_ROUND_*`
  untouched. PASS.
- Naming: `FrozenAnchor`/`resolveFrozenAnchor`/`PLAN_FROZEN_FALLBACK_VERSION`,
  `normalizePlanHash/isStalePlanHash/buildStalePlanHashHint/selectFrozenPlanHash`,
  `bumpPlanVersion/tryParseLedger`, `GATE_SPEC_FILES/*_BASELINE`,
  `plan-frozen-version/hash`, `plan-archive-*` testids — consistent within and
  across layers. PASS.
- Comments: bilingual, cite todo/section, state fail-open and loosen-only
  invariants explicitly. No stale references found. PASS.
- Dead code: every new export has a verified consumer (gate fns→both gates+
  specs; registry→audit spec; `tryParseLedger`→lifecycle+docs; `bumpPlanVersion`
  →lifecycle; revision helpers are private methods called from reject/revise).
  No orphaned additions. PASS.

## 6. Verification notes

- LSP diagnostics: unavailable (typescript server not installed, previously
  declined) — no LSP gate possible from this review; type safety covered by
  committed specs + F3 runtime QA. No build run by F2 (read-only mandate;
  builds owned by F3).
- No product/spec/plan/docs file modified by this review (`git status` delta
  for this task = this evidence file only).

## Verdict: APPROVE

Increment is append-only, naming/comment/error-code consistent, adds no
`as any` class violation (one line follows the file's pre-existing Prisma
idiom), no `@ts-ignore`, no TODO/FIXME/HACK, no `console.log`, no dead code,
migration additive-only. Two non-blocking notes for F1/F3: (a) `force`
zod-preprocess string coercion in `platform-mcp.tools.ts` widens input
acceptance — loosen direction, flag for scope-fidelity confirmation;
(b) LSP/build verification deferred to F3.
