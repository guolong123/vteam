# Learnings — vteam-agent-strengthening-test

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---
## 2026-08-24 B1-1 PASS
- Endpoint: POST /api/v1/platform-mcp tools/call plan_submit
- Missing acceptance -> zod error tasks[0].acceptance (contains acceptance, request body has t1 title)
- Evidence: .omo/evidence/vteam-agent-strengthening-test/B1-1/screenshot.png (PNG 870x136), request.log shows -32602 with acceptance
- Ledger: tc-executed B1-1 PASS

## 2026-08-24 B1-2 PASS - missing qa zod error tasks[0].qa
## 2026-08-24 B1-3 PASS - valid submit -> pl_0000000001 reviewing task t_0000000002 main ta_0000000004
