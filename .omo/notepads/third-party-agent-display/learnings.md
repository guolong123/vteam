# Learnings — third-party-agent-display

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — governed flag on /agents/opencode (2026-09-19)

- Single-source derivation is one line of wiring: `AgentsService` already injects
  `ExecutionPolicyService` (constructor arg 6), so `listOpencodeAgents` just calls
  `buildAgentPolicies()` and does set membership. No new endpoint, no worker/client change,
  no `startsWith('vteam-')` anywhere.
- Wire shape stays additive by extending the element type only:
  `export type OpencodeAgentEntry = WorkerAgentInfo & { governed: boolean }` defined in
  `agents.service.ts` — deliberately NOT touching `worker.client.ts`.
- Live compose proof (the whole point of this plan): with the real worker,
  `/agents/opencode` returned 24 engine agents, exactly the 8 `vteam-*` names governed,
  and the governed set was set-equal to `/agent-policies` agents (8). External names like
  `Prometheus - Plan Builder`, `build`, `plan`, `oracle` all `governed:false`.
- Degraded path verified for real: `docker stop aiagents-compose-worker` →
  `{"agents":[],"workerId":"w_compose_worker","degraded":true}` HTTP 200 (no throw).
  Note: with an explicit `workerId` the degrade path preserves that workerId (first return
  branch); the catch branch returns `workerId:null`.
- `docker compose up -d --build server` recreates the `init` container as a dependency but
  it is idempotent (`Exited 0`) and did NOT reseed — data (8 agents incl. `myagent`) intact.
  Safe; never use `--force-recreate`.
- Server jest baseline moved 3186 → 3190 (4 new tests), 139 suites, whole suite ~17s.

## [todo 1 done] governed flag — single source confirmed
- `OpencodeAgentEntry = WorkerAgentInfo & { governed: boolean }` in `agents.service.ts`; `listOpencodeAgents` maps `governed = buildAgentPolicies().agents names set`. Live: governed set == /agent-policies names (8) set-equal; 24 engine agents total.
- NO `web/src/api/agents.ts` exists — the agents page uses inline `api.get(...)`; `/agents/opencode` + `/agents/omo-agent-prompt` are called only from `web/app/(main)/workers/[id]/omo-panel.tsx`.
- Read-only viewer precedent: `omo-panel.tsx` `AgentPromptModal` L536-683 (`<pre data-testid="omo-prompt-body">`, loading "加载中…", error "提示词加载失败", empty "该 agent 未定义自定义提示词"); list precedent `OpencodeAgentsPanel` L420-528 (`hidden` filter, degraded → "未获取到（worker 离线或版本不支持）").
- Agents page structure: `SegmentedTabs` L2963-2970 (agent|role), list column L2977-3074, `ConfigPanel` L1526-2204. Roles tab precedent component: `web/src/components/agents/AgentRolesTab.tsx`.
- Playwright: `web/playwright.config.ts` baseURL :3001; agents-page specs (create-agent-role, native-rule-editor) run via dedicated `scripts/e2e-*.sh` that build a tmp config with baseURL http://localhost:13001 + workers 1. Compose web is :13001.
- `TeamMembersPanel` L14-32 has DEAD `OpencodeAgentItem`/`isSelectableOpencodeAgent` (leftover from the removed picker).

## todo 4 — zero-emission proof (server) + guard pass-through pin (worker), 2026-09-19

- `AGENT_POLICIES_ORDER` is module-private in `execution-policy.service.ts` (not exported). To assert
  "emitted set == expected governed set" without importing it, the spec hardcodes the 7 builtins and
  cross-checks them against `Object.keys(ROLE_BOUNDARIES)` — constant drift turns the test red.
- Discriminating assertion shape that catches BOTH directions: (a) `expect([...names].sort()).toEqual(expected)`
  catches an *added* external name; (b) the namespace invariant `name.startsWith('vteam-') &&
  AGENT_KEY_PATTERN.test(name.slice(6))` with `violations === []` + `sample.length > 0` catches a renamed/odd name.
  Add a self-check that every external fixture name FAILS the invariant (proves the predicate discriminates),
  and that real vteam names PASS it.
- Custom-block equality needs mocked `agent.findMany` rows with a valid lowercase `agentKey` + matching
  `executionPolicy.findMany` policy rows (`config.permission` must be an object). Expected names derive from
  the mock rows (`vteam-<agentKey>`), never read back from the implementation.
- Worker: the deliberate safety property is `policy.ts` branch 2 (now lines 117-121):
  `if (typeof agent !== 'string' || agent.length === 0 || !hasOwn(roles, agent)) return { action: 'allow' }`.
  Pin it with a *contrast* (mapped `vteam-developer` + same dangerous call → deny) so the allow assertions are
  provably not vacuous. Add case/whitespace/suffix near-misses (`VTEAM-DEVELOPER`, `vteam-developer `,
  `vteam-developer2`, `vteam-`) → all still pass-through: governance is exact-key membership only.
- `worker/src/exec/exec-server.ts:1129` is the second half of the proof: `if (!agent.startsWith('vteam-')) return;`
  in `trackGuardSession` — no `vteam-` prefix ⇒ no session mapping ⇒ guard only reaches branch 2. Extended the
  existing exec-server spec's non-mapping list with real external names (no production change).
- Mutation check that works with a concurrent agent in the tree: copy the production file to a temp path first,
  mutate, run the new spec (expect failures), then `cp` the pristine copy back and re-hash. Verified
  `git diff --numstat` on the production file = 0 lines afterwards. Record pristine/mutated/restored shas.
- Server baselines: 139 suites / 3190 tests → 140 suites / 3196 tests (+1 suite, +6 tests). Worker:
  26 suites / 683 tests → 26 suites / 688 tests (+5 tests, no new suite). `npx tsc --noEmit` clean both sides.
