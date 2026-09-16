# F3 Real Manual QA — plan-finalize-actions (verification only, no product changes)

Date: 2026-09-16 · Workdir /Volumes/SSD-Data/01work/git-project/vteam
Scope: plan §Final verification wave F3. No product code/spec/plan/doc edits, no commits,
no shared live stack contact (no live DB writes, no container restarts). All probes are
unit-level jest harnesses + static grep + local file checks.
Per-todo inputs: `.omo/evidence/plan-finalize-actions/task-{1..6}/`
(`decisions.md`, `freeze.json`, `gate.json`, `loop.json`, `audit.json`, `asserts.json`+`ui.png`).

## Acceptance matrix

| # | Matrix item (plan acceptance) | Result | Evidence (command output / count / file) |
|---|---|---|---|
| R1 | finalize freeze/archive/notice round-trip (frozen row, superseded queryable, baseline notice, 2nd finalize idempotent) | PASS | `npx jest --runInBand src/tasks/plan-lifecycle.service.spec.ts src/tasks/plan-finalize-trio.spec.ts src/tasks/plan-docs.service.spec.ts` → **3 suites / 69 tests PASS** (this run). Verbose: `plan-finalize-trio.spec.ts` 8/8 ✓ incl. `二次 finalize→同冻结结果：不重写库、不重发系统消息、不重播基线事件`, `系统消息文本含版本号/哈希/定稿人`, `SSE 基线事件…载荷含版本/哈希/定稿人`, `superseded→listArchivedReceipts 原样返回`, `无账本→空归档（不抛错）`. Input: `task-2/freeze.json` (acceptance hooks/migration `20260918000000_add_plan_frozen_columns`, suites 15/tests 351 at todo time) |
| R2 | stale-hash execution blocked with BOTH short hashes (expected frozen + actual carried named in hint) | PASS | `npx jest --runInBand src/issues/plan-hash-gate.spec.ts src/chat/worker-dispatcher.plan-hash.spec.ts src/platform-mcp/platform-mcp.service.plan-hash.spec.ts src/chat/worker-dispatcher.gate.spec.ts src/platform-mcp/platform-mcp.service.gate.spec.ts src/issues/review-round-ledger.spec.ts` → **6 suites / 83 tests PASS** (this run, matches todo-3 `new_suites` 6/83). Verbose `plan-hash-gate.spec.ts` 19/19 ✓ incl. `hint 同时命名期望/实际短哈希（逐字锁定）`, `双哈希齐备且不一致 → true`, `任一侧缺失 → false（fail-open）` ×5. Hint source `server/src/issues/plan-hash-gate.ts:44`: `计划哈希已过期：期望 #${expected}（冻结正式版），实际 #${actual}（请求携带）；…` — both short hashes present. Input: `task-3/gate.json` |
| R3 | revise loop entry×action matrix + illegal-entry exact codes | PASS | `npx jest --runInBand src/tasks/plan-revise-loop.spec.ts src/issues/review-round-gate.service.spec.ts src/issues/review-round.service.spec.ts` → **3 suites / 38 tests PASS** (this run). Verbose `plan-revise-loop.spec.ts` **23/23** ✓: approved/rejected+reason→draft (version+1, no round key); executing/completed+reason→draft (round+1/version+1/collecting, expected保留/received清零, 不追杀); `PLAN_REJECT_WRONG_STATE(409)` ×5 + `PLAN_REJECT_REASON_REQUIRED(400)` ×1 + `PLAN_REVISE_WRONG_STATE(409)` ×5 + `PLAN_REVISE_REASON_REQUIRED(400)` ×1. Codes defined+thrown `server/src/tasks/plan-lifecycle.service.ts:64-67,358,369,408,419`. Input: `task-4/loop.json` |
| R4 | gate audit re-run (C3 loosen-only, no-tighten machine check) | PASS | `npx jest --runInBand src/gates/no-tighten-audit.spec.ts src/chat/review-dispatch-triplet.spec.ts src/platform-mcp/platform-mcp.service.review-dispatch.spec.ts src/chat/mention-throttle.spec.ts` → **4 suites / 68 tests PASS** (this run; `no-tighten-audit.spec.ts` 40 assertions green per `task-5/audit.json`: `allowToDenyFlips: 0`, `tighteningsLanded: 0`, 8 C3 items all `untouched`, `productionBehaviorChange: false`). Input: `task-5/audit.json` |
| R5 | UI screenshots (frozen version display, archive entry reachability; zero human-click asserts) | PASS | `task-6/ui.png` verified on disk: **PNG 267×241 8-bit RGB** (`file` output). `task-6/asserts.json`: archive toggle `归档回执（2）`, version line `v4·R2·2/3`, frozenVersion `v4`, frozenHash `e5f6a7b8`, items R2/v3 + R1/v2 — machine asserts, no human-gated claims. `web tsc --noEmit` clean (exit 0); `eslint TeamRightPanel.tsx testids.ts` → **0 errors** (2 warnings: pre-existing unused `TaskDetail`, `task`, not introduced by this plan) |
| R6 | regression guard: server tsc + web tsc clean; no product code changes by F3 | PASS | `server npx tsc --noEmit` exit 0; `web npx tsc --noEmit` exit 0. `git status --porcelain` before/after: only pre-existing dirty files + untracked `.omo/` evidence dirs; F3 wrote **one** new file (this `final-F3.md`) and touched zero product files, committed nothing |

## Spot-probe log (unit-level, no live writes)

1. Idempotency: `plan-finalize-trio.spec.ts` verbose ✓ `二次 finalize→同冻结结果` — second finalize reuses frozen row, no duplicate `plan.update`/message/broadcast. No DB, all mocks.
2. Hint contents: `plan-hash-gate.ts:44` grep — single template names `#${expected}` AND `#${actual}`; spec `hint 同时命名期望/实际短哈希` locks it word-for-word.
3. Illegal-entry codes: `plan-revise-loop.spec.ts` verbose — all 12 illegal-code assertions green with exact `409`/`400` codes; source grep confirms 4 codes in `PLAN_LIFECYCLE_ERRORS` + 4 throw sites.
4. Live-stack avoidance: no `docker`, no `curl` to :13000/:13001, no prisma writes, no container restart; only `npx jest`, `npx tsc`, `npx eslint`, `grep`, `file` against the local checkout.

## Verdict

**APPROVE** — every matrix row has a command output, test count, or screenshot artifact; zero human-gated claims. F3 made no product code changes (verification only).
