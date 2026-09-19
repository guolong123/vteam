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

## [orchestrator review of todo 3] loading 态被误标为 unavailable（已修）

- 缺陷：`member-external-agent` 旁的说明用二值三元表达式，`engineState === "loading"` 落入
  `EXTERNAL_AGENT_LIST_UNAVAILABLE`（"worker 离线或版本不支持"）。页面首帧即瞬时谎报复，
  在一个主打诚实状态的特性里正好相反。orchestrator 独立复现（fresh load 时说明先显示"不可用"
  再翻成计数文案）。
- 修复：新增 `EXTERNAL_AGENT_LIST_LOADING = "引擎 Agent 列表加载中…"`，三态显式分支
  （loading → 加载中；unavailable → 离线；ready → 计数），说明元素加 `data-testid="member-external-agent-note"`。
  选择器仍仅在 loading 时 disabled；`（默认 / 不指定）`、loading option、caveat、unknown-warning、
  M6 放置全部未动。
- 修复范围严格限定（orchestrator 指示 "Keep everything else identical"）：初稿曾顺带给
  `opencodeAgentsQuery` 加 `retry: false`（理由：worker 真离线时默认 3 次退避重试会让"加载中"
  多停留约 7 秒），**已撤回**——那超出本次修复范围，且会改变失败路径的既有行为。
- 新测试（`member-external-agent.spec.ts` 测试 4，三阶段判别）：
  A. `page.route("**/agents/opencode**", delayed 2500ms)` 制造确定的加载窗口 →
     断言说明含"加载中"、**不含"不可用"/"worker 离线"**、选择器 disabled；
  B. `delayMs=0` 放行 → 断言计数文案出现、"加载中/不可用"消失、选择器 enabled；
  C. `unroute` 后 mock 500 + reload → 断言说明含"不可用"/"worker 离线"、**不含"加载中"**、
     选择器仍 enabled（可编辑已保存值）。query 未设 retry:false → 默认退避重试后才进 error 态，
     故该断言超时放宽到 25s（实测约 5.7s 完成整个三阶段测试）。
  route 处理器包 try/catch：页面导航可能先中止请求，`route.continue()` 因此抛错——不是测试失败。

## todo 5 — notes/observations

- **`opencode agent list` truncates non-deterministically.** Observed on the live stack 2026-09-19:
  5 runs → 24/24/21/16/24 entries (16-run lost every `vteam-*` name; 21-run lost 3). A second batch gave
  23/19/24/24. Root cause not investigated (CLI output includes per-agent permission JSON; the parser
  likely gives up on some run timing). Consequence: NEVER use this CLI as an assertion source for the
  agent set — use serve `GET /agent` (direct HTTP) or the injected `opencode.json` keys instead.
- **NC false-pass trap (fixed):** the first negative-control run exited 1 because `check.py` got the
  display string where the externals-file path was expected (`FileNotFoundError`), which the script's
  `rc != 0` assertion read as "leak detected". Fixed by correcting the arg order AND asserting the
  detection reason (`result: LEAK` + `[LEAK]` slot line). If a future edit reorders those args, the
  strengthened assertions fail loudly instead of silently passing.
- `worker/src` has no per-task `opencode.json`/`roles.json`; only the work-root pair exists. The
  `.vteam-role-guard/sessions/` mapping currently holds 1 entry (`vteam-tester`) — checked, no external.
- No state was mutated by this proof: no reload-config, no restart, no compose recreate. Artifacts were
  already fresh relative to worker start (worker StartedAt 2026-09-19T10:08:48Z; roles.json 10:08:49Z,
  opencode.json 10:09:15Z). Live artifact shas re-verified byte-identical before/after the run.
