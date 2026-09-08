# Final-F2 — 代码质量复核 (session-unification)

- Date (UTC): 2026-09-08
- Plan row: `.omo/plans/session-unification.md` F2 — "工具 `npm run lint` + `npx tsc --noEmit`（server+web）；期望双双退出 0；无孤立 import/死文件；证据 `final-F2.md`"
- Method: read-only audit. No product/spec/doc edits (cache clears: none needed, see §3).
- Anti-deception: every EXIT below was cross-checked against the log body (`tail` + byte count), not trusted from the echo alone.

## 1. Command table

| # | Command | Workdir | Evidence log | EXIT | Errors | Warnings |
|---|---------|---------|--------------|------|--------|----------|
| 1 | `npm run lint > final-F2-server-lint.log 2>&1; echo "EXIT:$?"` | `server/` | `.omo/evidence/session-unification/final-F2-server-lint.log` (8090 B) | 0 | 0 | 44 |
| 2 | `npm run lint > final-F2-web-lint.log 2>&1; echo "EXIT:$?"` | `web/` | `.omo/evidence/session-unification/final-F2-web-lint.log` (101087 B) | 0 | 0 | 738 |
| 3 | `npx tsc --noEmit > final-F2-server-tsc.log 2>&1; echo "EXIT:$?"` | `server/` | `.omo/evidence/session-unification/final-F2-server-tsc.log` (0 B, empty = clean) | 0 | 0 | — |
| 4 | `npx tsc --noEmit > final-F2-web-tsc.log 2>&1; echo "EXIT:$?"` | `web/` | `.omo/evidence/session-unification/final-F2-web-tsc.log` (0 B, empty = clean) | 0 | 0 | — |

Note: cmd #1's log was first written to `server/.omo/...` (relative-path slip) and moved to the repo-root evidence dir; content untouched.

## 2. Warnings itemized (0 errors on both sides)

server (44 = 41 + 3):
- `41 × @typescript-eslint/no-unused-vars` (unused imports/args/vars, incl. `worker-event.ingress.ts:18 extractConclusionParts`, `:136 ActivityCallback`, `:957-958 taskId/agentId` unused args)
- `3 × @typescript-eslint/no-require-imports`

web (738 = 694 + 24 + 9 + 6 + 5):
- `694 × @typescript-eslint/no-unused-expressions`
- `24 × @typescript-eslint/no-unused-vars` (incl. `prototype-sandbox.tsx:2 useRef`)
- `9 × react-hooks/exhaustive-deps` (incl. `doc-explorer.tsx:40/49`, `docs-markdown.tsx:300`, `prototype-panel.tsx:21`)
- `6 × @typescript-eslint/no-explicit-any`
- `5 × @next/next/no-img-element`

All warnings are pre-existing style-level items; none is an error, none blocks the F2 gate.

## 3. Stale `.next` cache

web `tsc --noEmit` output is byte-empty with EXIT 0 — no ghost errors from deleted routes. No `.next` cache clear was required (documented here per plan instruction).

## 4. Orphan check (deleted symbols' imports — zero dangling)

| Symbol | Scope | Result |
|--------|-------|--------|
| `dispatchForTarget` | `server/src/**/*.ts` excl. specs | 0 hits |
| `adoptNewInstanceRefByTask` | `server/src/**/*.ts` excl. specs | 0 hits |
| `taskAgent` (code) | `server/src/**/*.ts` excl. specs + excl. 冻结/frozen comments (F1 pattern) | 0 hits (`grep` EXIT:1 = no match) |
| `dispatchForTarget\|adoptNewInstanceRefByTask\|taskAgent` | `web/src`, `web/app`, `web/e2e` (ts/tsx) | 0 hits |
| memory level `task`/`project` (code paths) | `server/src` non-spec | ONLY the intentional Todo-9 400 guards: `platform-mcp.service.ts:1306` (`project` → `MEMORY_INVALID`) and `:1315` (`task` → `MEMORY_LEVEL_INVALID`), both with session-unification comments. Not dangling — they enforce the deletion. |
| `MEMORY_LEVELS` | `memory.constants.ts:10` | team/global only (comment confirms task level deleted) |

## 5. Observation (non-blocking, for F4 follow-up — NOT a gate failure)

- `server/src/tasks/tasks.service.ts:1176` — acceptance-flow `privateMessage` prompt prose still instructs the main agent to save memory with `level: "task"` / `level: "project"` (both now 400). This is natural-language prompt text, not a code import / dead file, so it does not violate the F2 "zero孤立 imports/dead files" gate; runtime effect is a graceful 400-with-redirect-message, not a crash. Flagged for F4 (scope/behavior fidelity) to reword, not for F2 rejection. No fix applied (F2 is read-only; "do not fix" rule).

## VERDICT: APPROVE

- server lint EXIT 0, web lint EXIT 0, server tsc EXIT 0, web tsc EXIT 0 (all bodies verified).
- Orphan check: no dangling imports of `dispatchForTarget` / `adoptNewInstanceRefByTask` / `TaskAgent`; deleted memory levels referenced in code only by their intentional 400 guards.
- Dead files: none introduced (lint+tsc green, no unresolvable imports).
