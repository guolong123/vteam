# F3 Real Manual QA — Acceptance Matrix (plan-review-execution-gates)

Date: 2026-09-16 UTC. Workdir: /Volumes/SSD-Data/01work/git-project/vteam.
Mode: verification only — **no product code changes**. No live/shared stack touched
(no docker rebuild/restart, no live DB writes, no curl against shared services).
All probes are unit-level (jest with mocked DB) or pure-function ts-node.
No dev servers started → nothing to kill (receipt: `ps` clean, no ports bound by this task).
`git status --porcelain` at start: pre-existing dirty worktree (unrelated changes) + untracked plan/evidence dirs; nothing committed by this task.

## Re-run suites (executed by F3 verifier, server/ unless noted)

| # | Command | Result |
|---|---------|--------|
| R1 | `npx jest --runInBand src/chat/message-receipts.service.spec.ts src/chat/mention-throttle.spec.ts src/issues/review-round-ledger.spec.ts src/issues/review-round.service.spec.ts src/issues/review-round-gate.service.spec.ts` | **PASS** — 5 suites / 42 tests |
| R2 | `npx jest --runInBand src/platform-mcp/platform-mcp.service.gate.spec.ts src/platform-mcp/platform-mcp.service.review-dispatch.spec.ts src/chat/review-dispatch-triplet.spec.ts src/tasks/plan-lifecycle.service.spec.ts src/platform-mcp/plan-removal.guard.spec.ts` | **PASS** — 5 suites / 89 tests |
| R3 | `npx jest --runInBand src/platform-mcp/platform-mcp.service.spec.ts src/chat/worker-dispatcher.spec.ts src/chat/worker-dispatcher.gate.spec.ts` | **PASS** — 3 suites / 420 tests |
| R4 | `npx jest --runInBand src/tasks/tasks.controller.spec.ts src/chat/chat.service.spec.ts src/common/constants/event.constants.spec.ts src/prisma/seed.spec.ts` | **PASS** — 4 suites / 195 tests |
| R5 | server `npx tsc --noEmit` | **PASS** — clean, exit 0 |
| R6 | web `npx tsc --noEmit` + `npx eslint src --quiet` | **PASS** — both clean, exit 0 |
| **Total re-run** | R1–R4 | **17 suites / 746 tests, all PASS** |

## Acceptance matrix

| # | F3 item (plan §Final verification F3) | Verdict | Evidence (command output / count / file) |
|---|----------------------------------------|---------|-------------------------------------------|
| M1 | 回执恰好一次唤醒 (receipt exactly-once wake) | **PASS** | R1: `message-receipts.service.spec` 已 acked 幂等 + `mention-throttle.spec` wake 豁免零丢失 PASS; spot `npx jest message-receipts.service.spec -t 幂等` → 1 passed. Input: `.omo/evidence/plan-review-execution-gates/task-5/events.json` (burst: wake bypass, loss 0), `task-1/migrate.log` |
| M2 | 去重拦连击 (dedup blocks repeat dispatch) | **PASS** | spot `npx jest platform-mcp.service.gate.spec -t duplicate` → 1 passed (`in_progress + 同 assigneeInstanceId → reason=duplicate + origMessageId，不触发`); contract `reason=duplicate` paired with `triggered:false`. Input: `task-4/gate-matrix.json` (issue_lock matrix), `task-3/contract.json` |
| M3 | 收敛门 2/3 拒修订 (convergence gate refuses 2/3 revision) | **PASS** | spot `npx jest review-round-gate.service.spec -t "2/3"` → 1 passed; R1 gate suite 8 tests PASS (2/3 refused 待 2/3, 3/3 auto-notify, stale no-auto-notify). Input: `task-7/gate.json` (acceptance: revision_refused_2_3, three_three_auto_notify, stale_no_notify) |
| M4 | approved 态执行派发被拦 (approved-state execution dispatch blocked) | **PASS** | spot `npx jest worker-dispatcher.gate.spec -t approved` → 4 passed; hint exact: `计划未放行：任务 ${taskId} 的计划状态为 ${status}（需 executing，…review/nudge/wake 类触发不受此限）` (worker-dispatcher.ts:1364); review/nudge/wake exemptions asserted in gate.spec 豁免 kind block. Input: `task-4/gate-matrix.json` |
| M5 | 确认按钮翻转 (confirm-button flip) | **PASS** | R2 `plan-lifecycle.service.spec` 37 tests + R4 `tasks.controller.spec` PASS (approved→executing idempotent, wrong-state exact codes PLAN_CONFIRM_WRONG_STATE 409, confirmedBy audit, DB truth-source). Unit-level only, no live DB writes. Input: `task-11/confirm.json` (87 passed / 3 suites), `task-2/plans-proof.json` |
| M6 | 四态截图 (four-state screenshots) | **PASS** | 4 PNGs verified via `file`: `task-12/plan-draft.png` 267x107, `plan-approved.png` 267x339, `plan-executing.png` 267x107, `plan-completed.png` 267x107 — all `PNG image data, 8-bit/color RGB`. DOM asserts: `task-12/asserts.json` (draft 修订中 / approved 待执行+confirm flow / executing checklist summary / completed no-button). Non-approved no-button DOM assertion included |
| M7 | 三元组缺件被拒 (review triplet rejection — supports M4 review path) | **PASS** | ts-node pure-function probe (no DB): complete dispatch `请评审本轮计划 R2 · 计划 v0.3#abcd1234 · expected: tmm_arch,tmm_dev,tmm_test…` → `{ok:true, round:2, planVersion:v0.3, planHash:abcd1234}`; missing-version input → `{ok:false, missing:[planVersion,planHash]}` + hint `评审派发缺三元组：须携带 round + planVersion(+hash) + expected 名单…`. Input: `task-8/dispatch.txt` |
| M8 | 分页契约 chat_history 20+截断 (supports receipt readability) | **PASS** | R4 `chat.service.spec` PASS; input `task-10/paging.json` (page1 20/truncated/total 25, page2 beforeId 5, all ≤64KB, tsc clean). No re-probe needed — suite green in R4 |
| M9 | 提示词铁律探针 (supports dispatch discipline) | **PASS** | Input `task-9/probe.json` (pass:true; nudge_no_dispatch + early_revise_blocked 待收敛 + precedence 平台校验>铁律>原文风); R4 `seed.spec` PASS (195-suite batch) |

Zero human-gated claims: every row above cites a re-run command output/count or a file-backed artifact verified in this session (PNG magic bytes, ts-node JSON, jest tallies).

## Non-interference receipt

- No `docker` commands issued; no curl against :13000/:13001 or any live host.
- No Prisma migrate/seed/db-push executed; no servers started (no background PIDs, no ports bound).
- No product/spec/plan/doc files edited; no `git add/commit`; no plan checkboxes touched.

## Verdict

**APPROVE** — full acceptance matrix green (M1–M9 PASS), 17 suites / 746 tests re-run PASS, server+web tsc/eslint clean, evidence archived per-row with zero human-gated claims.
