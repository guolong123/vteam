# Learnings — server-gate-removal-tool-authority

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-18] task-1 change map
- **The 11 removal throw sites are NOT uniform in shape.** 10 use `message: \`...\`` on the same line; `platform-mcp.service.ts:3036` (skill_create no-context) puts the message on the CONTINUATION line after a `new ForbiddenException({code,`. A naive `grep 'message'` completeness check finds only 10 and under-counts. Use the map's V2 extractor (or grep the `仅主 Agent` literal alone, not requiring `message` on the same line).
- **`worker/dist/` is NOT git-tracked** (`git ls-files worker/dist` = 0) yet exists on disk and contains stale `SERVER_GATED_TOOLS` in `dist/role-guard/policy.js` + `dist/resources/role-guard-plugin.js`. Todo 4's "rebuild dist" is therefore a real, required step — the e2e scripts load dist, not src.
- Grant-matrix deltas recomputed from live constants: product +5, architect +1, developer +1, tester +0, PM +7, plan +1, librarian +0 = 15 adds total. Resulting toolAllows: 21→26, 16→17, 18→19, 18→18, 20→27, 10→11, 9→9.
