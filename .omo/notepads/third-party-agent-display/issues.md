# Issues — third-party-agent-display

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — notes/observations

- `GET /agents/omo-agent-prompt` for `vteam-product` returns `empty:true` (built-in vteam
  agents have no engine-side prompt text); `prometheus` returns ~1.1KB. Todo 2's UI should
  not treat `empty:true` as an error.
- Calling `omo-agent-prompt` immediately after `docker start worker` yields 503
  (worker not yet heartbeating) — transient; retry after ~15s.
- The existing agents service spec's strict `toEqual` on the happy-path result had to become
  `agents.map(a => ({...a, governed:false}))` because the default `buildAgentPolicies` mock
  returns only vteam built-ins.

## [todo 3 CRITICAL] no-agent-picker.spec.ts asserts WHOLE-PAGE zero `<select>`
`web/e2e/no-agent-picker.spec.ts` test 1 visits `/teams/tm_0000000001/session` and asserts `expect(page.locator("select")).toHaveCount(0)` for the ENTIRE page at load (not just the message input). The only `<select>` currently on that page is `add-instance-agent-select` inside `TeamMembersPanel`, hidden behind `addOpen=false`. Therefore ANY persistently-rendered external-agent `<select>` on the session route (including one added unconditionally to `TeamMembersPanel`, which IS rendered on the session page) FAILS test 1.
SAFE surfaces: `/teams/[id]` team detail page (`web/app/(main)/teams/[id]/page.tsx`, member management — already has `add-member-agent-select`), or a dedicated settings panel not on the session route.
- `addMember` does NOT accept `opencodeAgentName`; only `updateMember` (PATCH /teams/:teamId/members/:memberId) does. `UpdateMemberDto.opencodeAgentName` :66-73, weak validation `warnIfOpencodeAgentUnknown` :919-941 = LOG ONLY, never throws.
- Dispatch precedence (worker-dispatcher.ts:2141-2148): policy candidate wins iff `workerSupportsAgentPolicies`; else `opencodeAgentName`; else omit `agent` key.
- `web/src/api/teams.ts` `UpdateMemberPayload`/`TeamMemberDto` lack `opencodeAgentName`.

## todo 4 — notes/observations

- The worker guard does NOT block external agents — by design. `policy.ts` branch 2 (lines 117-121) returns
  allow for any agent not present in `roles`; an external agent is therefore neither blocked NOR governed.
  The honest UI claim is "not governed", never "blocked". Do not "fix" that pass-through into fail-closed.
- `roles.json` is never transport for engine agent names: it is written from `GET /agent-policies`
  (`injector.ts`), whose names are `AGENT_POLICIES_ORDER` + `vteam-<agentKey>` only. External names have no
  path into the file — the new specs pin both ends (server emission set, worker key-membership behaviour).
- `prometheus` is a good mutation probe precisely because it's a real engine name absent from the policy set.
  Injecting it as both an `agents[]` entry and a `roles` key made 5/6 new server tests fail; restoring the
  production file byte-identically (sha `c5f50430…`) restored green.
- TS/jest detail: `worker/src/exec/exec-server.spec.ts` already covered non-vteam no-mapping with
  `[undefined, 'build']`; extended to 6 real external names instead of duplicating a new spec.
- Notepad note: this notepad carried uncommitted concurrent todo-3 (web) notes at commit time; todo-4 entries
  were appended after them and the whole file was staged with them (same plan, same notepad file — cannot
  split by file). No web/production source file was touched by this todo.
