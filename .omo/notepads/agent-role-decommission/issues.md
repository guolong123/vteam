# Issues — agent-role-decommission

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — findings / questions

- **Sweep beyond `.role`:** the `.role` grep cannot see the ~20 hardcoded
  `ROLE_KEYS` / `AGENT_ID_ROLE` maps in web (`tokens.ts`, `agents/page.tsx`,
  `board`, `session`, `TaskDetailDrawer`, `TeamMembersPanel`, ...). They are the
  "duplicate role maps" todo 8 must collapse and todo 6 must re-point; they do not
  read `Agent.role` directly. Listed in evidence §4b so nothing is unmapped.
- **Non-`Agent.role` `.role` hits that must NOT be migrated** (recorded so the
  "100% mapped" claim is honest): account RBAC `Role` (`user.role.permissions`,
  `prisma.role`, auth/users/guards/tools/skills/timers), LLM message
  `info.role === 'assistant'`, and `TeamUserMember.role` (`owner`/`member`,
  teams.service:752/1422, tasks:226/229, web user-members.tsx:83). All OUT-OF-SCOPE.
- **Plan line-number drift is systemic** (evidence §5): schema `Agent.role` is
  `:629`, not `:588`; exec-policy helpers ~40 lines off; web helpers ~20 lines off.
  The plan's `:350 roleNeedsIssueDetail` note is itself wrong (real `:385`).
- **DTO decision deferred to todo 5 with a recommendation:** keep the field name
  `role` (now resolved `AgentRole.name`) so seeded labels stay byte-identical and
  the UI keeps its field; add `roleId` for identity. Do not silently drop it.

## todo 2 — findings / gotchas

- **D2 null-semantics inversion is the easy bug.** "Suppress iff tools lack X"
  reads naturally as `!toolAllowed(...)`, but `toolAllowed(null,...) === false`
  makes null suppress too. The contract is `tools != null && !toolAllowed(...)`.
  Three of the new tests exist specifically to pin this.
- **`vteam-prometheus` is NOT plan duty** — only base names `plan`/`prometheus`/
  `vteam-plan` are. An early D3 test fixture used `agentKey:'prometheus'` expecting
  plan duty; corrected to `agentKey:'plan'` (a genuinely non-`a_plan` agent id).
  Do not assume the `vteam-` prefix participates in duty matching.
- **Manifest checker has no regenerate mode** — it only reports manifest-minus-observed
  as UNMAPPED (new/moved keys); it does not flag removed keys. Since every edit that
  shifts a line makes the committed file:line keys stale, the manifest was regenerated
  from the checker's own grep pipeline and the per-file delta recorded honestly
  (net 184→178; +2 new plan-docs duty reads). Do NOT hand-edit to hide the +2.
- **`plan-docs.service.ts` spec `happyPath()` now needs `prisma.agent.findMany`** or
  `resolvePlanAgentId` logs a warn and skips the gate; existing assertions expecting
  `requestRevision('is_7','a_plan')` still pass because the fixture resolves
  `a_plan` by duty.
