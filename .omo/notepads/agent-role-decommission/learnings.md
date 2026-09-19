# Learnings — agent-role-decommission

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — consumer map + precedence (inventory/design only)

- **The manifest is the union of 5 recorded greps**, not just `\.role`: `.role`
  (server 73, web 44) + `role: true` prisma selects (28) + the 9 named helpers
  (41) + the plan-duty literals (6) = **184 distinct file:line keys**. Committed at
  `scripts/agent-role-consumer-manifest.txt`; checker `scripts/check-agent-role-consumers.sh`
  prints `UNMAPPED: 0` and exits 0. Positive control via `--extra-dir` (synthetic
  consumer OUTSIDE the repo) prints `UNMAPPED: 1` and exits 1 — proven, not asserted.
- **`PLAN_AGENT_ID` and `isPlanRoleTarget` no longer exist in `server/src`.** The
  plan treats them as live tasks (todo 2/9). They were removed by
  `server-gate-removal-tool-authority`; only the stale `server/dist/**` still
  contains them. The real remaining plan literals are `PLANNER_AGENT_ID`
  (`review-verdict.listener.ts:35`) and `'a_plan'` (`plan-docs.service.ts:191`).
- **`roleNeedsIssueDetail` is at `:385`**, not the plan's `:350` nor its earlier
  `:358` — both were drift. `isPlanRole` is `:400` (plan said `:365`).
  `constantRoleNameOf` is `:746`; the plan didn't give it a line.
- **The precedence expression is `worker-dispatcher.ts:2141-2148`** (plan cited
  `:2094-2122`/`:2108-2112`; both drifted). Pinned with 5 spec-only tests against
  existing exports — no production seam needed. Full suite 140/3201 green.
- **`AgentRole` carries no capability** (`key/name/description/type/defaultAgentId/
  rolePrompt/sortOrder`). So the create/clone capability has exactly 3 sources:
  explicit `policyId` > chosen `AgentRole.defaultAgentId` -> that Agent's
  `policyId` > skeleton. Label changes must never re-provision the policy.
