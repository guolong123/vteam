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

## todo 2 — external agents read-only tab (web) (2026-09-19)

- Third tab is a 3-line change, not a refactor: `useState<"agent"|"role"|"external">`, one
  `items[]` entry `{key:"external",label:"外部 Agent"}`, and the existing ternary becomes
  `tab === "role" ? <AgentRolesTab/> : tab === "external" ? <ExternalAgentsPanel/> : <Agent+ConfigPanel>`.
  The `useState` union keeps the `as` cast type-safe (no `any`).
- Component lives at `web/src/components/agents/ExternalAgentsPanel.tsx`, same two-column shape as
  `AgentRolesTab` (left 320px + right flex:1), tokens only from `src/theme/tokens.ts`.
- Two queries, both inline `api.get` (there is still no `web/src/api/agents.ts`):
  list `["external-agents"]` → `/agents/opencode` with `query: {}` (omit workerId; server auto-assigns);
  prompt `["omo-agent-prompt","external",name]` → `/agents/omo-agent-prompt?name=` — the SAME endpoint
  `AgentPromptModal` uses, keyed per selected name so no prompt is fetched up front.
- `retry:false` on both queries is deliberate: the mocked-500 failure path must resolve to the explicit
  unavailable state fast, not after 1 retry delay. The read-only branch renders
  `external-agent-instructions-unavailable` and NEVER an empty `<pre>`.
- Freshness guard: react-query v5 keeps the previous query's `data` while a new key loads, so
  `d.name !== agent.name` is treated as stale and nothing is shown for that tick — otherwise agent B
  could momentarily display agent A's 33KB prompt.
- Playwright `toHaveText` fails on the warning block because the decorative `!` glyph is inside the
  element's text; use `toContainText(WARNING)` — the verbatim sentence is still pinned, the icon is not.
- `page.route("**/agents/omo-agent-prompt**", ...)` intercepts before login and the mock survives SPA
  navigation, so test 2 needs no second mouting.
- Read-only assertions that make the honesty claim falsifiable: within `external-agents-root`,
  count 0 of `textarea` / `input` / `select` / `[contenteditable]`, plus 0 of `prompt-editor`,
  `save-agent-button`, `effective-permission-section`, `native-rule-editor`, `model-select` page-wide
  (the panels don't mount on this tab).
- Live numbers on the rebuilt compose web: 24 engine agents = 8 governed + 5 hidden non-governed
  + 11 visible external (the tab shows 11 rows). `general` returns `empty:true` (no engine prompt) →
  that path shows 该 agent 未定义自定义提示词; `Sisyphus - ultraworker` returns 33,304 chars / 716 lines.
- `npx tsc --noEmit` clean; spec green 2/2 via tmp `.tpad.playwright.config.ts` against :13001.

## todo 3 — 成员外部 Agent 选择（设置面）(2026-09-19)

- Placement (orchestrator decision, honored): the select lives on the team DETAIL page
  `web/app/(main)/teams/[id]/page.tsx` `MemberRow`. `TeamMembersPanel.tsx` (rendered on the
  session page) got ZERO changes — its dead `OpencodeAgentItem`/`isSelectableOpencodeAgent`
  exports were left alone. The session page stayed at whole-page zero `<select>`.
- MemberRow became a 2-row column (identity+alias/workDir+save on row 1; external-agent
  control on row 2, separated by a dashed border) — the only layout change needed; no
  refactor of the 505-line page.
- Live engine names are NOT the plan's example: the external set is 11 names
  (`Sisyphus - ultraworker`, `Prometheus - Plan Builder`, `Atlas - Plan Executor`, …).
  There is NO bare `prometheus`. The spec therefore fetches `/agents/opencode` first and
  prefers `/prometheus/i` (matched `Prometheus - Plan Builder`) else the first external —
  never a hardcoded name. The task brief's "playwright picks `prometheus`" is satisfied by
  the real engine name that contains it.
- Honesty refinement worth keeping: the "engine-unknown" warning must judge against the
  engine's FULL list (incl. governed/hidden), not just the external subset. Otherwise a
  member saved with `vteam-developer` (engine-reported, merely governed) would be falsely
  labelled "未被引擎上报". Two distinct states: `unknownExternal` (full-list miss → warning)
  and `currentNotInList` (external-subset miss but engine-reported → option annotated
  `（当前，vteam 策略 Agent，非外部选项）`, no warning). Spec test 3 pins the negative
  assertion so a future simplification back to external-subset-only turns red.
- `engineState` is a 3-way (`loading` / `ready` / `unavailable`), not a boolean: while the
  list loads or the worker is offline the warning MUST NOT fire (it would be a false claim).
  Query uses `staleTime: 0` + `refetchOnMount: "always"` so the verdict is per-visit, never
  stale-cache.
- `UpdateMemberPayload` accepts the field; `AddMemberPayload` does NOT (server parity).
  MemberRow always sends `opencodeAgentName` in the same PATCH as alias/workDir; empty string
  = clear (server normalizes `""` → null).
- Cleanup discipline: throwaway team per test (create → patch → assert → DELETE). Seed team
  `tm_0000000001` was only read (before/after member-snapshot equality asserted in the spec
  and recorded in `task-3-proof.json`). Final DB check: `select count(*) from team_members
  where opencode_agent_name is not null` = 0, zero `qa-t3%`/`qa-t7%` teams left.
- `no-agent-picker.spec.ts` M6 update is 3 small edits: header boundary paragraph, test 1
  gained one `member-external-agent-select` count-0 probe (all original assertions intact),
  and a NEW test 5 that visits the detail page (picker visible, >1 option) then the session
  page (count 0). Nothing was deleted or weakened.
- Runner `scripts/e2e-member-external-agent.sh` uses ONE tmp config with a 4-spec testMatch +
  all screenshot/evidence env vars, so tsc-equivalent full-set verification is a single
  command. 13/13 green in ~26s.

## todo 3 review fix — 三态互斥（loading ≠ unavailable）(2026-09-19, commit follows 52e4514)

- 教训（可复用）：任何"状态说明"必须与状态机一一映射。用 `cond ? ready : unavailable` 这类
  二值表达式渲染三态状态机会把中间态（loading）谎报成终态（unavailable）——而且因为首帧必然
  命中，它在每次页面加载时都发生，肉眼却只闪一下，很容易过 review。**渲染前先数状态数**。
- 判别性测试模式（值得照抄）：把非确定性的"加载窗口"变成确定性的，靠的是**故意延迟路由**：
  `page.route("**/endpoint**", async r => { if (delayMs>0) await sleep(delayMs); await r.continue(); })`
  然后用一个可变 `delayMs` 在同一测试里放行（Phase B），最后 `unroute` + mock 5xx（Phase C）。
  一次测试钉死三个态，且每条断言都带**反向断言**（loading 时断言 not "不可用"；unavailable 时
  断言 not "加载中"）——只有正向断言时，一个把所有态都渲染成同一句话的实现也能通过。
- 反面教训：route 处理器里的 `route.continue()` 在页面导航抢先中止请求时会 reject；
  包 try/catch 即可，别让测试基础设施的噪声变成假失败。
- 范围纪律：修复只做"三态分支"这一件事，初稿顺带加的 `retry: false` 被撤回（超出范围）。
  代价是测试 Phase C 要走完默认退避（约 7s）才进 error 态 → 断言超时放到 25s。
  注意：`retry: false` 在状态诚实性场景里确有独立价值（失败晚 7 秒揭示 = 7 秒的"加载中"歧义），
  但那是另一个独立决策，项目内既有先例是 `ExternalAgentsPanel`/`omo-panel` 各自显式设了它。
- 证据截图必须落在 READY 态：在捕获点前断言说明含"个外部 Agent（引擎上报"且不含"不可用"，
  否则可能把加载瞬间截进证据。

## todo 5 — live-stack no-policy-leak proof (2026-09-19)

- **Independent engine source (D1):** PRIMARY = direct HTTP to `opencode serve` from INSIDE the
  worker container (`docker exec aiagents-compose-worker sh -c "curl -sS http://127.0.0.1:4000/agent?directory=/data/vteam-worker"`).
  Path is container → serve with ZERO vteam code in between; the endpoint is server → worker exec
  endpoint → serve, so equality is a cross-path check, not self-grading. Serve port resolved from
  `ps aux | grep '[o]pencode serve'` (`--port 4000`), workDir from worker env `WORK_DIR`. SECONDARY =
  the injected `opencode.json` `agent` keys (the file opencode itself consumes).
- **`opencode agent list` CLI is UNUSABLE as an assertion source**: on the same live stack it returned
  24/24/21/16/24 entries across 5 runs (later batch: 23/19/24/24). Truncation is recursive — a 16-entry
  run dropped ALL 8 `vteam-*` names, a 21-entry run dropped 3. Any comparison against it would be flaky.
  Rejected in the script + evidence with the observed counts.
- **The leak-check trap (D3):** `roles.json` legitimately contains the string `"plan"` as a
  `correction.handoff` task-type mapping KEY (`roles/vteam-project_manager/correction/handoff/plan`
  → `"vteam-plan"`). A raw text grep for external names therefore produces a FALSE leak. Structure is
  the only sound check: agent-name SLOTS are exactly depth-2 keys (`agent/<name>`, `roles/<name>`);
  everything else must be classified, and the only allow-listed shape is a handoff mapping key whose
  VALUE is a `vteam-*` name. Raw-text residue check catches hits the JSON walk cannot attribute.
- **Negative-control correctness has two levels:** exit-nonzero is NOT proof of detection — the first
  NC run exited 1 from a `FileNotFoundError` (display arg passed in the ext-path position) and would
  have read as "detected". Assert `result: LEAK` + a `[LEAK]` slot line, not just `rc != 0`. (Same
  family as the todo-3 review lesson: count the states, assert the reason.)
- NC deliberate choice: external name `plan` (also the handoff key name) proves slot-vs-non-slot
  discrimination in one artifact pair; both NC copies were detected with `slotHits=1` while the live
  copy with the same name in the mapping position stays `CLEAN`/justified.
- Artifact discovery: `find /data/vteam-worker -maxdepth 3 \( -name opencode.json -o -name roles.json \)`
  found exactly the canonical pair — task dirs (`tasks/<id>/`) carry no per-task copies, so there is no
  per-task escape surface. Supplementary: `/root/.config/opencode/opencode.json` (model-credential
  provider section, no `agent` section) checked too → 3 files total, 0 slot hits.
- `docker cp` of a directory (sessions/) copies contents into the target dir — for a per-file loop use
  `docker exec ls -1 <dir>/*.json` + `docker cp` per file.
- The whole proof is read-only: no reload/restart was needed (artifacts were fresh: opencode.json
  10:09:15Z, roles.json 10:08:49Z vs worker StartedAt 10:08:48Z). There is no public per-worker
  `reload-config` HTTP route — `broadcastCommand(reload-config)` fires internally from
  skills/tools/mcp-servers/execution-policies services on resource change.
- Run: `bash scripts/e2e-third-party-no-policy-leak.sh` → exit 0 twice (re-runnable); (a)-(d) set-equal,
  extras/omissions empty both directions; 24 agents = 8 governed + 16 external, 11 visible-external;
  frozen sha + worker clean; stack healthy at the end.
