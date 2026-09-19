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
