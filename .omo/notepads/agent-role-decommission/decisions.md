# Decisions — agent-role-decommission

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 4 — capability resolution + label/policy separation

- **Capability comes from data, never from the label.** create/clone resolve the starting
  capability through exactly three paths: explicit `policyId` (bound as-is, highest
  precedence) > chosen `AgentRole` → `defaultAgentId` Agent's `policyId` → its stored
  policy config deep-copied (constant derivation fallback when the row is missing but the
  `agentKey` is a builtin) > deny-by-default skeleton. The chosen role is a **selector**,
  not a binding: the config is deep-copied once at assembly and never re-read.
- **Label change is a no-op for capability.** `update()` accepts no label field;
  `policyId` is written only when explicitly passed. Renaming an Agent or re-pointing its
  `AgentRole` / `TeamMember.roleId` leaves `policyId` and `effectivePermission`
  byte-identical — user policy edits must survive any label change. To change capability
  the caller must explicitly PATCH the agent's `policyId` or the policy's config.
- **`toAgentDto`'s `role` field stays as a display passthrough** for this plan's duration;
  todos 5/6 migrate the label consumers and web maps. Removing it here would be an
  unannounced API break that their acceptance criteria (byte-identical labels) forbid.
