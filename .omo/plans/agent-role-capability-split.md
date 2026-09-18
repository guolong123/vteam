# agent-role-capability-split — SUPERSEDED / DO NOT EXECUTE

> **This file is retained only as an audit trail. It is NOT a plan. Do not run it.**

## Why it exists
It was scaffolded when the user's intent was read as "one big plan: split Role from capability + unify third-party agents".

## Why it was abandoned
A Metis gap analysis (see `.omo/drafts/agent-native-permission-editor.md`, the "Metis gap analysis on the D1-D10 model" section) proved:

- **The single-plan scope is not implementable as stated.** Verdict: *"the model is coherent as a concept, but D1–D8 as stated are not implementable without several unstated decisions, and two decisions (D4, D7) are provably non-functional against the current code. Do not write this as one plan."*
- **D4 (vteam overrides third-party permissions) is provably void**: `worker/src/exec/exec-server.ts:1129` only creates a guard session mapping for `vteam-`-prefixed agents, so a third-party dispatch is always pass-through.
- **D7 (unified registry emission for third-party names) is naming-blocked**: `agentNameOf` (`server/src/execution-policies/execution-policy.service.ts:829-838`) always builds `vteam-<agentKey>`, so a bare `prometheus` can never be emitted.
- Plus 7 blockers total (name collision, byte-identity ordering, guard-neutralization blast radius, cross-module `Agent.role` break, competing agent-selection sources).

## What replaced it
The scope was re-cut (user decision: **D+C** — unify our own agents first; third-party is read-only) and split into four sequential plans:

| # | plan file | scope |
| --- | --- | --- |
| 1 | `.omo/plans/agent-native-permission-editor.md` | native permission editor + create-form role picker + restart affordance |
| 2 | `.omo/plans/agent-role-entity.md` | the `AgentRole` entity + `TeamMember.roleId` + Roles tab |
| 3 | `.omo/plans/third-party-agent-display.md` | third-party agents: read-only display + selectable, no enforcement |
| 4 | `.omo/plans/agent-role-decommission.md` | delete `Agent.role`, derive duties from tools, migrate the 14 consumers |

Execute them in that order. This file contributes no tasks to any tracker.
