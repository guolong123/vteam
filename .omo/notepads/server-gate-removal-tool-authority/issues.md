# Issues — server-gate-removal-tool-authority

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-18] task-1 gotcha — over-broad deletion risk
- In `tasks.service.ts`, the main-only refusal (`:1416-1418`, `TASK_STATUS_MAIN_AGENT_ONLY`) and the **accept/archive refusal** (`:1397`, `TASK_AGENT_COMPLETION_FORBIDDEN`) live ~20 lines apart in/around the same method family. Todo 2 must delete ONLY the main-only check and keep accept/archive at BOTH sites (`tasks.service.ts:1397` + `platform-mcp.service.ts:2842`). Do not delete by line range.
