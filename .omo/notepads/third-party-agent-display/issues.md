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

## todo 2 — notes/observations

- **`web/e2e/roles-members.spec.ts` had to be reconciled (2 assertions).** Its todo-7 test 1 asserted
  `manage-tab` `toHaveCount(2)` and selected the Agent tab with `filter({ hasText: "Agent" })`.
  Adding the third tab breaks both: the count becomes 3, and the substring filter now matches TWO
  buttons ("Agent" and "外部 Agent") → Playwright strict-mode violation. Fixed minimally to
  `toHaveCount(3)` + `filter({ hasText: /^Agent$/ })`; nothing about the 角色 tab behaviour changed.
  The git-master rule applied here: any `hasText` that is a prefix of another label must be anchored.
- `no-agent-picker.spec.ts` and `playwright.config.ts` were NOT touched (todo 3 owns the former).
- The evidence PNGs are gitignored by `.gitignore:39` (`.omo/evidence/**/*.png`) — consistent with
  every prior todo; the file exists on disk at the required path but is not part of the commit.
- The `!` in the warning block is a decorative `<span aria-hidden>` but it IS text content, so
  `toHaveText(exact)` fails; `toContainText` is the correct assertion (see learnings).
- Spec design choice: test 1 accepts BOTH `external-agent-instructions` (real prompt) and
  `external-agent-instructions-empty` (`empty:true`) as valid, because the engine's answer depends on
  whether the auto-selected first external agent has a prompt — but it never accepts the error state.
  Test 2 forces the error state with `page.route` fulfill 500 and asserts the empty/`<pre>` states are
  absent (the "never a blank" guarantee).

## todo 3 — notes/observations

- **Plan's example name `prometheus` does not exist on this deployment.** `/agents/opencode`
  reports `Prometheus - Plan Builder` (title-cased display name), not `prometheus`. Any spec
  or doc that hardcodes `prometheus` (e.g. the todo-3 QA scenario text) would fail. The spec
  resolves the name from the API at run time; production code never hardcodes it.
- `docker compose up -d --build web` recreated web (and started `init` as a dependency, which
  exited 0 idempotently). Seed data intact: team count 10, seed members 7, all
  `opencode_agent_name` NULL. Never `--force-recreate`.
- Server production code was NOT touched — no change was needed: `UpdateMemberDto`
  (`server/src/teams/dto/add-member.dto.ts:66-73`) already accepts `opencodeAgentName`
  (max 64) and `updateMember` (`teams.service.ts:878-887`) already normalizes `""` → null and
  weak-validates via `warnIfOpencodeAgentUnknown` (`:919-941`, logs only, never throws).
  `toTeamDto` (`:1413`) already returns the field. So no server test was added either — the
  existing `teams.service.spec.ts` cases (`:1154-1265`, including the unknown-name write
  path) already pin the server contract; adding a duplicate suite would be noise.
- `no-agent-picker.spec.ts` test 4 is a pure API test; while running the M6 spec set, note the
  Playwright `request` fixture resolves against `baseURL` OR the explicit `SERVER_URL` — the
  existing spec uses the absolute URL, which kept working unchanged.
- Evidence PNGs are gitignored (`.omo/evidence/**/*.png`) as in todos 1/2; the runner log
  `task-3-e2e.txt`, `task-3-proof.json`, and both screenshots exist on disk.
- Frozen baseline re-verified after the whole run:
  `shasum -a 256 .omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  = `3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87` (unchanged);
  `git diff --stat -- server/ worker/` empty.
