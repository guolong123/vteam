# Issues — remove-project-dimension

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-09-07 — Final Wave F2 verdict: REJECT (narrow, 2 reds)

Evidence: `.omo/evidence/remove-project-dimension/final-F2.md` + `f2-*.log`.
Greens: server lint EXIT 0 (0 err/44 warn, none project-related), server tsc EXIT 0, web tsc EXIT 0, 5/6 orphan greps zero-hit, `server/src/projects/` gone.
RED-1: web lint EXIT 1 — `web/hooks/use-sse.ts:92:25 no-explicit-any`, pre-existing in untouched file (HEAD-era), out of F2 fix scope. Suggested: `payload.message?.channelId`.
RED-2: `my_projects` 文案 leftover — `worker-dispatcher.ts:316/321` prompt still tells agent to call deleted tool; `worker-dispatcher.spec.ts:4716,4720,4853` presence-assertions lock stale prompt (only `platform-mcp.service.spec.ts:4473` absence-assertion is correct). Violates plan acceptance "先调 my_projects 文案全部更新"; fix is product prompt edit → out of F2 scope. No product edits made.

## 2026-09-07 — Final Wave F2 re-verify: APPROVE (both reds closed by siblings, read-only session)

Evidence addendum in `final-F2.md` + `f2v-*.log`. Fresh runs: web lint EXIT 0 (0 errors), web tsc EXIT 0, server lint EXIT 0 (0 err/44 warn), server tsc EXIT 0. Orphan greps: 5/6 zero-hit; `my_projects` hits now exclusively absence-assertions (`worker-dispatcher.spec.ts:4717,4850` + `platform-mcp.service.spec.ts:4473`, all `not.toContain`). Reception prompt verified team-direct (`task_create`直建, no project-pick). No product edits made. F2 CLOSED.
