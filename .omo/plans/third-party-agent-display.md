# third-party-agent-display - Work Plan

## TL;DR (For humans)

**What you'll get:** The agents that come from outside vteam (the "oh-my-openagent" set, like its planner and builder) become visible and usable in a team, with their own description and instructions shown read-only. The page states plainly that these agents are not governed by vteam's permission rules, so nobody is misled into thinking they are.

**Why this approach:** These agents already run inside the same engine, and vteam already has the plumbing to point a team member at one. What is missing is that the picker was removed and the page pretends nothing exists. We bring back a clear, honest view — display and select only, no enforcement claims, no engine changes.

**What it will NOT do:** It will not give these agents vteam permissions, will not copy or override their definitions or instructions, and will not change the execution engine.

**Effort:** Short
**Risk:** Low - additions are display and selection; nothing about permissions or the engine changes.

**Decisions to sanity-check:** (1) the page must warn that external agents are outside vteam's permission system; (2) if the engine's automatic agent-policy gate is on, an external pick can be overridden — the UI must say so rather than silently ignore the choice; (3) their instructions are shown read-only, never edited.

Your next move: run `$start-work third-party-agent-display` to execute, or ask for a high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Short / Low - restore an honest read-only view of non-vteam (OmO) agents: list them from the engine, show description/mode/instructions read-only, allow selecting one for a team member, warn that vteam permissions do not apply and that the engine's policy gate may override the choice. No worker change.

## Scope

### Must have
- The external (non-`vteam-`) agents reported by the execution engine are listed in the UI with their description, mode, and instructions shown **read-only**.
- A team member can be pointed at one of these agents (the existing per-member field), with the choice made visibly available rather than hidden.
- The UI states, next to every external agent, that vteam's permission rules do **not** govern it.
- The UI states that when the engine's agent-policy gate is active for a vteam policy candidate, an external selection may be overridden — so the user is not surprised by a silent fallback.
- The list degrades gracefully when the worker is offline or the engine returns nothing.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No change to `worker/**` — including the `startsWith('vteam-')` guard-session gate (`worker/src/exec/exec-server.ts:1122-1167`) and the agent-policy injection.
- No vteam permission is emitted for, or applied to, an external agent.
- No copying, overriding, or editing of an external agent's definition or instructions.
- No third-party row in the `Agent` table (that was the rejected D4/D7 direction; the goal is D+C read-only).
- No removal of `Agent.role` or any plan-1/2/4 change.
- No change to the 7 built-ins' factory bytes (`before-agent-policies.json` sha `793093dc5106a76a929f2e043dd5a53af35a2b902e2d929268f1665782abbc3a`).
- No A/B dual path, legacy shim, or "deprecated" annotations.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest (`server`) + Playwright for the UI + a live-stack check that the external list actually comes from the engine, not a hardcoded list.
- Honesty proof: assert the "not governed by vteam permissions" warning renders for every external agent, and that no policy artifact is emitted for any external name.
- Evidence: `.omo/evidence/third-party-agent-display/task-<N>-third-party-agent-display.<ext>`

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 — server surface (serial):** expose the external list + a truthful "governed or not" flag.
- **Wave 2 — web:** the display panel and the member picker entry point.
- **Wave 3 — proof:** live-stack assertions that nothing is emitted for external names.
- **Final verification wave:** F1-F4 in parallel.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,5 | — |
| 2 | 1 | 4,5 | — |
| 3 | 1,2 | 4,5 | — |
| 4 | 3 | 5 | — |
| 5 | 1-4 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

- [ ] 1. [server] Expose the external agent list with an explicit "vteam-governed" flag
  What to do / Must NOT do: The engine list already reaches the server: `GET /agents/opencode` returns `{ agents, workerId, degraded }` where each item carries `name`, `description`, `mode` (`primary|subagent|all`), `native`, `hidden` (`WorkerAgentInfo`, `server/src/workers/worker.client.ts`). Extend the server response (or add a purpose-built endpoint) so each entry states whether vteam governs it.
  **Single-source requirement (review fix O9):** derive the `governed` flag by calling the SAME function that produces the policy set (`buildAgentPolicies()` / `agentNameOf` in `server/src/execution-policies/execution-policy.service.ts`) — NOT a second `name.startsWith('vteam-')` check, which can drift (e.g. a `vteam-*` agent with a null `policyId` is not in the policy set but would be mis-flagged governed). Include the readable instructions where the engine provides them (there is an existing `GET /agents/omo-agent-prompt` that reads a single agent's prompt — reuse or mirror it, do not duplicate the fetch logic).
  Must NOT hardcode the OmO agent names (the list must come from the engine). Must NOT emit any policy for an external name. Must NOT change the existing `/agents/opencode` consumers' contract in a breaking way.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,5
  References: `server/src/agents/agents.controller.ts` (`GET /agents/opencode`, `GET /agents/omo-agent-prompt`), `server/src/agents/agents.service.ts` (`listOpencodeAgents`, `getOmoAgentPrompt`), `server/src/workers/worker.client.ts` (`WorkerAgentInfo` incl. `mode`/`native`), `server/src/execution-policies/execution-policy.service.ts` (`buildAgentPolicies`, `agentNameOf` — the SINGLE source for "governed"), `server/src/common/opencode-agent-duty.ts` (already recognises `plan`/`prometheus` — reuse for a duty label, do not add a second list)
  Acceptance criteria (agent-executable): `cd server && npx tsc -p tsconfig.json --noEmit` exits 0; a test asserts that for each entry the `governed` flag equals membership in the `buildAgentPolicies()` agent set (derived from the same call, so it cannot drift); a test asserts an external name (e.g. `prometheus`) is reported `governed:false`; a test asserts a `vteam-*`-named agent with a null `policyId` is reported `governed:false` (the drift case); a test asserts a worker-offline response degrades to an empty list with `degraded:true` rather than throwing.
  QA scenarios (name the exact tool + invocation): happy — `curl -s .../api/v1/agents/opencode?workerId=...` returns the engine list with correct `governed` flags; failure — with the worker stopped, the endpoint returns `degraded:true` and an empty list, HTTP 200 (not 500). Evidence `.omo/evidence/third-party-agent-display/task-1-api.json`
  Commit: Y | `feat(agents): expose external agent list with a governed flag`

- [ ] 2. [web] Display external agents read-only with the non-governance warning
  What to do / Must NOT do: In the agents page, render the external (non-governed) agents as a clearly separated group: name, description, mode, and their instructions in a read-only view. Every entry must carry a visible warning that vteam's permission rules do not apply to it. If an instructions lookup fails, show a clear "unavailable" state — never a blank that looks like "no instructions". Must NOT render any permission or tool editor for these agents. Must NOT imply they are under vteam policy. Must NOT edit their instructions.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4,5
  References: `web/app/(main)/agents/page.tsx` (the list + detail panel; the existing read-only prompt viewer pattern in `web/app/(main)/workers/[id]/omo-panel.tsx` is the closest precedent), `web/src/api/teams.ts` (API-client pattern), `server/src/agents/` (the endpoint from todo 1)
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` exits 0; Playwright asserts the external group renders, each entry shows the non-governance warning, the instructions are read-only (no textarea/editable control), and no permission/tool control is present; a failed instructions fetch shows the unavailable state.
  QA scenarios: happy — Playwright opens the page and sees an external entry with description + read-only instructions + the warning; failure — with instructions unavailable the entry shows the explicit unavailable message. Evidence `.omo/evidence/third-party-agent-display/task-2-display.png`
  Commit: Y | `feat(web): show external agents read-only with a governance warning`

- [ ] 3. [web] Let a team member be pointed at an external agent (with the override caveat)
  What to do / Must NOT do: Make the per-member external-agent choice visible again in the member flows (the field already exists and the API already accepts it: `TeamMember.opencodeAgentName`, validated weakly in `server/src/teams/teams.service.ts`). Present it as an explicit "external agent" choice alongside the vteam agent, and state that when the engine's agent-policy gate is active the external selection may be overridden by the vteam policy candidate. **Cite the normative precedence declared by `agent-role-decommission` todo 1 (review fix B7)** — do NOT restate a different rule: (1) policy candidate wins when the worker supports it; (2) else `opencodeAgentName`; (3) else the engine default. Warn when the chosen external name is no longer reported by the engine.
  **KNOWN CONFLICT (review fix M6 — this todo must resolve it explicitly):** a prior decision removed the agent picker, and there is a regression spec that asserts it: `web/e2e/no-agent-picker.spec.ts` (header states "全页零 `<select>`"; it asserts `message-agent-select` is absent on the session page). Re-activating the choice WILL fail it. Name that spec and state the sanctioned resolution — recommended: the member-config surface (a settings/management panel), NOT the message input, may host the external-agent select, and the spec is updated to (a) still assert the **message input** stays picker-free and (b) allow the settings surface. Do NOT leave it "reconciled silently" and do NOT delete the spec without replacing its guarantee.
  Must NOT silently ignore or hide an overridden selection — the caveat must be visible. Must NOT change dispatch logic.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 4,5
  References: `web/e2e/no-agent-picker.spec.ts` (**the regression spec to update — name it**), `web/src/components/teams/TeamMembersPanel.tsx` (member add/edit), `web/app/(main)/teams/[id]/session/page.tsx` (existing `opencodeAgentName` wiring incl. a reset at ~:824), `web/app/(main)/teams/[id]/page.tsx`, `server/src/teams/teams.service.ts` (member update + the weak validation), `server/src/chat/worker-dispatcher.ts:2094-2112` (the gate that can override), `.omo/plans/vteam-no-agent-picker.md` (the precedent decision that removed the picker — reconcile with it explicitly)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` exits 0; Playwright selects an external agent for a member, saves, reloads, and sees it persisted; Playwright asserts the override caveat text is present; a test asserts selecting an engine-unknown name surfaces the warning; **`web/e2e/no-agent-picker.spec.ts` passes in its UPDATED form** (message input still picker-free; the settings surface allowed).
  QA scenarios: happy — Playwright picks `prometheus` for a member via the settings surface and it persists with the caveat visible, and the updated `no-agent-picker` spec is green; failure — choosing an unknown name shows the "not reported by the engine" warning. Evidence `.omo/evidence/third-party-agent-display/task-3-member-picker.png`
  Commit: Y | `feat(teams): allow selecting an external agent for a member`

- [ ] 4. [server] Prove nothing is emitted or enforced for external names
  What to do / Must NOT do: Add discriminating tests asserting that (a) `buildAgentPolicies()` output contains no external name, and (b) the worker's guard `roles.json` contains no external name — i.e. an external agent is genuinely outside vteam enforcement, which is the honest claim the UI makes. Also assert the guard's pass-through behaviour for an unmapped agent is unchanged (the safety property at `worker/src/role-guard/policy.ts:134-138`). Must NOT weaken the pass-through (it is deliberate). Must NOT add an external name to the policy set to "make it work".
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 5
  References: `server/src/execution-policies/execution-policy.service.ts` (`buildAgentPolicies`), `server/src/execution-policies/agent-policies.matrix.spec.ts`, `worker/src/role-guard/policy.ts:134-138` (unmapped → allow), `worker/src/exec/exec-server.ts:1127-1131` (only `vteam-` names get a session mapping), `worker/src/resources/opencode-config-builder.ts:143-153` (unknown fields throw — why we must not inject external metadata)
  Acceptance criteria (agent-executable): a test asserts no external name appears in `buildAgentPolicies()` agents/roles; a test asserts the guard returns allow for an unmapped agent (pass-through preserved); `npx jest --runInBand src/execution-policies src/chat` passes.
  QA scenarios: happy — the assertions pass; failure — adding a fake external entry to the policy set makes the test fail (mutation check, recorded). Evidence `.omo/evidence/third-party-agent-display/task-4-no-emission.json`
  Commit: Y | `test(policies): assert external agents receive no vteam policy`

- [ ] 5. [proof] Live-stack: the list comes from the engine and nothing leaks into policy
  What to do / Must NOT do: On the live stack, confirm the external list is populated from the engine (not a baked-in list) by checking the endpoint output against the engine's own agent list, and confirm the injected `opencode.json`/`roles.json` contain no external name. Restore nothing (this flow changes no state) but capture the artifacts. Must NOT modify the frozen baseline. Must NOT change the worker.
  Parallelization: Wave 3 | Blocked by: 1-4 | Blocks: F1-F4
  References: `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` (frozen baseline), the live worker work dir artifacts (`opencode.json`, `.vteam-role-guard/roles.json`), `server/src/agents/agents.controller.ts`
  Acceptance criteria (agent-executable): the endpoint's external names equal the engine's non-`vteam-` names (no extras, no omissions); the injected artifacts contain no external name; the frozen sha is unchanged.
  QA scenarios: happy — the live comparison matches and the artifacts are clean; failure — an external name appears in `roles.json` (the honesty claim would be false). Evidence `.omo/evidence/third-party-agent-display/task-5-live.txt`
  Commit: Y | `test(e2e): verify external agents stay outside vteam policy`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit ok before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
- One commit per todo; prefix `feat|test(<scope>): <summary>`.
- Keep `npx jest --runInBand src/agents src/execution-policies` green at every step.
- Do NOT push until the user says so.

## Success criteria
- `cd server && npx tsc -p tsconfig.json --noEmit` and `cd web && npx tsc --noEmit` exit 0; jest + Playwright green.
- External agents are listed from the engine (no hardcoded names) with description/mode/instructions read-only and a visible non-governance warning.
- A team member can be pointed at an external agent; the override caveat is visible; an unknown name warns.
- No external name appears in `/agent-policies` or in the injected `opencode.json`/`roles.json`.
- `worker/**` is untouched; the frozen baseline sha is unchanged.
