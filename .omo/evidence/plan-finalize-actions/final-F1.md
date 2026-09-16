# F1 Plan Compliance Audit — plan-finalize-actions

Scope: todos 1–6 (commits 15397cd / cd9aa2b / 7130fc5 / d34d99f / 95216dc / d72ac07)
vs docs 33 §6 annex + Scope OUT bans. Read-only audit, no product code touched.
Date: 2026-09-16. `git status --porcelain` at audit start: dirty tree present
(uncommitted M: execution-policies, agent.constants, models, workers, web shell…;
untracked .omo/plans, md-docs/ etc.) — none of it attributed to the 6 landed commits.

## Per-todo verdicts

### Todo 1 — dual-anchor / hash hook / revise matrix / C3 list → PASS
- Commit `15397cd` touches exactly 1 file, 45 insertions, 0 deletions:
  `docs/agent-platform/33-评审轮次机制.md` (git show --stat).
- Annex present, `docs/agent-platform/33-评审轮次机制.md` total 162 lines:
  - L123–126 dual-anchor: 「正式版双锚…DB approved 行 + 文档版本哈希…哈希算法复用 triplet sha1-8，禁止引入新算法」
  - L131–132 hash hook: 「计划员修订落盘后，读文件算 sha1 前 8，写回账本 planVersion.hash」; missing → `pending-hash`
  - L135+ 修订入口矩阵 (revise entry matrix) + L148–150 force 口径维持现状 (forceReason 审计)
  - L153–159 C3 闭合门禁清单 (执行门禁/issue 锁/三元组门/throttle/force/a_plan 豁免…)
- Evidence landed: `.omo/evidence/plan-finalize-actions/task-1/decisions.md` exists.
- Acceptance 「无其他章节改动」 holds for this commit (single-file +45).

### Todo 2 — freeze / archive / baseline notice → PASS
- Commit `cd9aa2b` (11 files, +615/−4).
- Freeze: `server/prisma/schema.prisma` +2 nullable cols
  `frozenVersion/frozenHash` (additive-only); migration
  `20260918000000_add_plan_frozen_columns/migration.sql` is 2× ADD COLUMN NULL,
  no backfill/semantic change.
- Hook wired: `plan-lifecycle.service.ts` finalizePlan reads ledger anchor
  (`resolveFrozenAnchor`) and writes frozenVersion+frozenHash in the same
  `transition()` flip (append-only side effect, skeleton reused).
- Archive: `listArchivedReceipts` reuses ledger `superseded`, no new table
  (see BAN2). Notice: system-message channel + SSE baseline event with
  version/hash/finalizer.
- Evidence: `task-2/freeze.json` landed in-commit.

### Todo 3 — hash-aware execution gate + docs creed + badge → PASS
- Commit `7130fc5` (10 files, +659/−15).
- New `server/src/issues/plan-hash-gate.ts`: compares `planVersion.hash`
  (triplet sha1-8), mismatch → `plan-gated` + `buildStalePlanHashHint`
  naming both short hashes (L43–44).
  Wired at both gates: `worker-dispatcher.ts` L1295/L1370/L1421–1422,
  `platform-mcp.service.ts` L980–981/L1143 (`reason: 'plan-gated'`).
  Missing-hash default = fail-open (original gate semantics preserved).
- Creed scoped rewrite landed: `plan-docs.service.ts` L29
  「工作区计划文件是起草真相，冻结正式版以 DB+哈希为准」.
- Badge: `TeamRightPanel.tsx` L569–570/L594–606 shows frozenVersion + frozenHash
  beside plan badge (testids extended).
- Evidence: `task-3/gate.json` landed in-commit.

### Todo 4 — revise-and-rereview mini-loop (+force unification) → PASS
- Commit `d34d99f` (6 files, +524/−17).
- `plan-confirm.dto.ts` L13–14/L17–18: `revise` added to action enum;
  L9/L21: revise needs reason (executing/completed→draft, version+1 round+1).
- `plan-lifecycle.service.ts`: L105–106 action union extended;
  L264–265 revise dispatch; L342 reject path (version+1, round unchanged);
  L392–437 `revisePlan` (version+1 AND round+1, full N/N rereview, no
  kill of in-flight execution); L545/L570 ledger version-bump helpers.
  Force stays at execution-gate forceReason column only (L395 comment).
- Matrix asserted in `plan-revise-loop.spec.ts` (349 lines);
  evidence `task-4/loop.json` landed in-commit.

### Todo 5 — loosen-only audit + no-tighten machine check → PASS
- Commit `95216dc` (3 files, +200/−0, additive-only).
- `server/src/gates/gate-spec-registry.ts`: C3-derived registry
  (L5 lists 执行门禁/issue 锁/三元组门/throttle/force/a_plan 豁免;
  L31/L50–51/L63 gate→spec-file mapping).
- `server/src/gates/no-tighten-audit.spec.ts`: L25–27 registry completeness
  (16 spec files must exist); L37–63 hash-layer fail-open locks;
  L70–73 triplet allow-side lock; L92 null-input no-throw.
  Verdicts loosen-or-unchanged only; tighten recorded as separate proposal.
- Evidence: `task-5/audit.json` landed in-commit.

### Todo 6 — consolidation-contract prompts + archive UI → PASS
- Commit `d72ac07` (5 files, +320/−2).
- `server/prisma/seed.ts` L785–787 收敛契约 (input=轮次账本+verdicts明细;
  output=冻结候选版+归档清单); `seed.spec.ts` +12 asserts contract text.
- Archive UI: `TeamRightPanel.tsx` L447–448/L463–464 superseded parsing,
  L490/L525–536 archive entry (collapsed by default, old rounds reachable
  via aggregated superseded, reverse-round order).
- E2E `web/e2e/plan-archive.spec.ts` (246 lines) + testids; evidence
  `task-6/` dir exists (screenshots per todo acceptance).

## Scope OUT bans (grep proof)

- BAN-A no finalize-gate rebuild → PASS.
  finalize/confirm flow still routes through `transition()`:
  `plan-lifecycle.service.ts` L176 transition, L249 confirmPlan,
  L259→finalizePlan, L320/L376/L426/L474 transition calls intact.
  `git diff f3532f8..HEAD` deletions in that file are 7 lines only:
  action-union comment + `PlanConfirmAction` type (+revise),
  one finalize message string, reject-guard message strings — comment/type/
  message updates for the revise entry, no skeleton/guard rebuild.
  `review-round-gate.service.ts`: zero diff in range (untouched).
- BAN-B no round-ledger semantics change → PASS.
  `SELECT ... FOR UPDATE` serialization note (ledger L47),
  `pending-hash` (L27/L40–41/L80/L359/L363/L380),
  `superseded` archive-only (L29/L43/L104/L351–352/L364),
  round-monotonic reset rule (L296) all intact.
  No `review_rounds` table: `grep CREATE TABLE.*review_round / model ReviewRound
  server/prisma/` → empty; literal `review_rounds` refs only in
  `server/src/issues/issues.module.ts` (pre-existing wiring), zero new refs.
- BAN-C no throttle/RBAC/quota/state-machine change → PASS.
  Per-commit file lists for all 6 commits contain zero matches for
  `throttl|rbac|polic|quota|permission`. Working-tree modifications to
  `execution-policies/*`, `agent.constants.*`, `models/*`, `workers/*`
  are UNCOMMITTED dirty state, not part of landed todos (explicitly excluded).
- BAN-D no new hash algorithm → PASS (single disclosed exemption).
  Plan-hash path is sha1-only: `review-round-ledger.ts` L1/L145
  `createHash('sha1')…slice(0,8)`; `plan-hash-gate.ts` header L6 declares
  triplet sha1-8 + new-algorithm ban.
  `grep sha256|sha512|md5|createHmac|argon|bcrypt` hits in
  `platform-mcp.service.ts` (L1913/L4467/L4472/L4935/L4947/L5059/L5065) are
  PRE-EXISTING artifact-dedup contentHash (sha256 of uploaded bytes),
  unrelated to plan-version hashing — allowed exemption, not a plan hash.
- BAN-E no analysis page → PASS.
  `git log f3532f8..HEAD --name-only | grep -i analys|dashboard|stats` →
  empty; `git diff f3532f8..HEAD --stat -- web/app` → empty (no new routes);
  no `*analy*` files under web/.

## Verdict

APPROVE
