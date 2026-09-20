# Issues — opencode-native-permissions-and-fixes

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — findings that todo 3 must not get wrong

- **Brief correction (recorded, not a blocker):** the plan's chain said
  `TeamMember.roleId -> AgentRole -> role's tools allowlist`. Reality: `AgentRole` carries no
  capability fields; the matrix belongs to the **Agent** (`policyId`/`agentKey`) and is resolved by
  `ExecutionPolicyService.resolveByAgent`. Todo 3 must NOT introduce a `roleId`-keyed lookup.
- **`channel_send` has no `selfInstanceId`** and resolves its task from the worker's most recent
  session — which is not guaranteed to be the invoking session. Todo 3 needs an explicit decision
  for it (todo 1's recorded policy: unresolvable caller → 403).
- **Fail-closed vs the worker guard's leniency is a deliberate divergence**, not an oversight.
  `worker/src/role-guard/policy.ts:109-121` passes through on unresolvable identity because the
  engine's native `permission` config is a second gate behind it. The server-side check has no such
  backstop once todos 4/5 land, so it must be strict. Documented in
  `server/src/platform-mcp/CONTRACT-tool-naming-and-identity.md` §4.
- **Naming order differs between the two registries.** `VTEAM_MCP_TOOL_NAMES` and the
  `buildPlatformMcpTools` array are set-equal but NOT in the same declaration order (e.g.
  `memory_search` vs `memory_update`). Assert set equality, never array equality — an order-strict
  assertion is a false-positive trap.
- The **`_meta.progressToken`** in the envelope is easy to miss: without it the byte lengths are
  28 short. It is part of what makes the raw capture byte-exact.
