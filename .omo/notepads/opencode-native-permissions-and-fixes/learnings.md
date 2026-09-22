# Learnings — opencode-native-permissions-and-fixes

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — MCP tool-call naming + caller identity (pinned empirically)

- **The server receives the BARE tool name.** `PlatformMcpController.toolsCall` matches
  `this.tools.find(t => t.name === name)` where `name` is `params.name` verbatim — and the
  engine sends it WITHOUT the `vteam_` prefix. Model-facing form is `vteam_<name>` (opencode
  namespaces remote MCP tools as `<mcp-server-name>_<tool>`; our server name is `vteam`).
  **Todo 3 must key on `vteam_${receivedName}`**, never strip a prefix from the received value.
- **Exact wire envelope** (extracted verbatim from the opencode 1.18.31 binary):
  `{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:<bare>,arguments:<args>,_meta:{progressToken:1}}}`
  With those exact bytes, the server's recorded `content-length` matches for all five real
  calls captured from a live agent session (delta 0). Adding the `vteam_` prefix makes every
  length 6 bytes larger and never matches.
- **Capture technique that actually worked** (do not theorise — reproduce):
  1. `docker cp aiagents-compose-worker:/root/.local/share/opencode/opencode.db .` — the engine's
     own session DB. `part` table, `json_extract(data,'$.tool')` = model-facing name,
     `json_extract(data,'$.state.input')` = the real args, `$.callID` = the real call id.
  2. `/root/.local/share/opencode/log/opencode.log` logs `evaluated permission=vteam_task_context` —
     direct proof of the model-facing form.
  3. Server access log (`docker logs aiagents-compose-server`, JSON lines, `req.headers['content-length']`)
     gives the received byte length to cross-check the reconstructed envelope.
  4. `/root/.local/share/opencode/storage/...` holds no JSON-RPC bodies — don't hunt there.
- **The decisive differential probe**: POST the same args with `name:"doclib"` → `200 {"artifacts":[]}`
  (byte-identical to the engine's recorded output); with `name:"vteam_doclib"` →
  `-32602 "Unknown tool: vteam_doclib"`.
- **A zod-refine error is proof the name resolved**: a real `vteam_group_post` call returned
  `-32602 ✖ taskId 与 teamId 至少传一个` — that message is only reachable after
  `tools.find(name)` matched AND `inputSchema.safeParse` ran. A prefixed name can never get there.
- **The chain in the brief was slightly wrong — `AgentRole` is NOT the capability carrier.**
  `AgentRole` has no permission/tools columns (schema.prisma:124-151 doc-comment is explicit).
  The tool matrix is keyed off the **Agent** (`Agent.policyId` + `Agent.agentKey`), resolved by
  `ExecutionPolicyService.resolveByAgent` → `guardForAgent` → DB `config.tools` ?? `ROLE_BOUNDARIES[*].toolAllows`.
  `TeamMember.roleId` only supplies the prompt/label binding. Route todo 3 through `policyId`.
- **`channel_send` is the one tool with NO identity in its args** (`{target, text}` only). It derives
  the task from the worker's most recent session (`SESSION.findFirst({workerId}) orderBy createdAt desc`)
  and then calls `assertWorkerTask(ctx, taskId)` without `selfInstanceId`. That is the case todo 3's
  policy must handle. Five more tools omit `selfInstanceId` (`doclib`,`task_context`,`read_file`,
  `team_view`,`memory_search`) and two have it optional (`wecom_reply`, and the five team-free tools
  let `taskId` be optional).
- **`tools/list` is stable and cheap to assert against**: live `tools/list` returned exactly the 29
  registered names, and that set is a bijection with `VTEAM_MCP_TOOL_NAMES` minus the `vteam_` prefix.
  `platform-mcp.tool-naming.spec.ts` locks this (3 assertions; mutation-tested: renaming one
  registration to its prefixed form fails all three).
- **Live matrix today**: every `vteam_*` entry in the emitted `permission` is `deny`; the allows live
  in `guard.roles[*].tools` (12–27 keys per role). Non-`vteam_` keys in those matrices (`browser`,
  `git_*`) are worker-injected custom tools with no platform-mcp `tools/call` surface — leave them alone.
- The webui `tmp` dir `/var/folders/0y/.../T/opencode` is fine for scratch captures; keep raw
  artifacts under `.omo/evidence/<plan>/raw/` with sha256 in the evidence JSON.

## [2026-09-20] Task 2: AgentRole 外部 Agent 槽位（single-slot）
- 槽位形状：`defaultAgentId`（内部 FK）与新增 `defaultOpencodeAgentName`（外部引擎名）互斥，service 层强制。
  - 代码：`AGENT_ROLE_DEFAULT_SLOT_CONFLICT`（400）。update 设置其一自动清空另一个（原子切换）；
    两字段都不传 → 现有槽位不动。
- `@MaxLength(128)` 依据：live `GET /agent?directory=` 23 个 agent，最长 `Prometheus - Plan Builder`（25）；
  oh-my-openagent 4.19.4 `AGENT_DISPLAY_NAMES` 最长亦 25；因 display 名可由 `overrides[].displayName`
  自定义（无固有上限），取 128（列宽 VARCHAR(128) 同值）。
- 弱校验取数必须带 worker capabilities：`WorkerClient.listAgents(worker ?? {id})`，只传 `{id}` 会回落
  localhost → 跨容器静默 `[]`（`agents.service#listOpencodeAgents` 已记录同坑）。镜像后 WARN 正常触发。
- 7 内置角色行不受影响：迁移为 additive-only（单条 ADD COLUMN），live 校验 `default_agent_id` 逐行不变。
- `/agent-policies` 输出逐字节不变（f698c24b…）；frozen baseline sha 3b8c5d4b… 未触碰。

## [2026-09-20] todo 4 — native-only permission payload

- **Two emission sites, one projection helper.** `buildAgentPolicies()` emits `agents[]` twice
  (builtin `AGENT_POLICIES_ORDER` loop + custom `vteam-<agentKey>` block). `projectNativePermission()`
  is applied at both; `guard.roles[*]` is built from the **un-projected** canonical permission
  (custom block reuses the same `permission` var for both — the projection must be applied only
  at the `agents.push` site, NOT by reassigning the variable, or the guard loses its `vteam_*` detail).
- **`resolveByAgent` deliberately left un-projected.** It feeds `Agent.effectivePermission` (agents
  page policy editor) and dispatcher memory/artifact suppression (`guardForTools` reads `tools`, not
  `permission`). Only the **opencode payload** (`/agent-policies` → injected `opencode.json`) needed
  the native-only shape. Projecting it would have broken the policy editor round-trip for `vteam_*`.
- **Baseline artifact is deterministic without a DB.** The new `baseline-agent-policies.json` is
  captured from `buildAgentPolicies()` with an empty prisma stub (constant path) — key order is the
  service's canonical order, so `JSON.stringify` byte-comparison works. The live payload is compared
  **canonically** (`sort_keys`) because MySQL reorders JSON object keys on storage.
- **f2c harness comparison had to switch sides.** `opencode.json` agent permission is now the
  projected form while baseline `guard.roles[*].permission` is the full form — comparing them
  directly would misreport; the fix compares opencode.json against baseline `agents[].permission`
  and additionally asserts a zero `vteam_` leak.
- **Live propagation is start-only for the injector.** The injector runs at worker start
  (`injectAll()`), so a `docker compose restart worker` is what re-fetches `/agent-policies`;
  `reload-config` broadcast only exists for policy PATCH. Server rebuild used
  `docker compose up -d --no-deps --build server` — never `--force-recreate` (reseeds).
- Frozen sha transition (authorized): `3b8c5d4b…` → `3d26b49f…`; the old artifact stays untouched
  under `.omo/evidence/vteam-role-behavior-abstraction/` and is still asserted by
  `e2e-third-party-no-policy-leak.sh` D1.

## [2026-09-20] Task 3: 服务端平台工具权限门（vteam_*）

- 落点：`PlatformMcpController.toolsCall()` 在 zod parse 之后、`tool.handler` 之前调用
  `PlatformToolPermissionService.assertToolAllowed(await service.resolveToolCallerId({workerId}, args), tool.name)`。
  `tools/list` 不过滤（调用时拦截）。
- 名称桥接唯一位置：`vteam_${receivedBareName}`（todo 1 契约）。收到的就是裸名，全程不 strip。
- 稳定码 `PLATFORM_MCP_TOOL_NOT_PERMITTED`（与归属 403 `PLATFORM_MCP_FORBIDDEN` 机器可区分）；
  JSON-RPC 层仍是 -32003 + `[403]` 前缀。
- 身份解析复用：`resolveToolCallerId` 传了 taskId/teamId 就走既有 `resolveExecContext`
  （错误码原样保留）；**双空**（channel_send / wecom_reply 缺省）走「worker 最近会话」
  （`SESSION.findFirst({workerId}) orderBy createdAt desc`）——与 channelSend/wecomReply
  自己的回填同源，不是第二套绑定逻辑；解析不到成员 → fail-closed 403。
- fail-closed 与 worker guard 的 pass-through 是有意分道（todos 4/5 后服务端是唯一闸门），
  理由记在 `CONTRACT-tool-naming-and-identity.md` §4。
- 真栈差分技巧（证明服务端门独立生效，绕开仍存活的 worker guard）：只改 DB `execution_policies.config.tools`
  而**不重启 worker** → 注入的 guard payload 仍是旧值（guard 放行），调用因此到达服务端并被服务端拒。
  恢复用 `JSON_SET` 写回原值，`shasum` 与改动前逐字节相等（本次 `9bfa4867…`）。
  注意 `LOAD_FILE` 在 mysql 容器里读不到 `docker cp` 进去的文件（secure_file_priv），要用
  `JSON_SET`/`JSON_REMOVE` 就地改。
- `channel_send` 决策：无身份 → 最近会话解析 → 命中成员才做矩阵判定；不命中 403
  PLATFORM_MCP_TOOL_NOT_PERMITTED（不是静默放行）。

## [2026-09-20] todo 5 — role-guard layer deleted; dead guard extras dropped

- **The persisted volume is the real deployment risk.** Deleting the plugin source is NOT
  enough: `<workDir>/.opencode-worker-inject.json` (guardRolesFile/guardSessionsDir/
  guardPluginFile), `<workDir>/opencode.json` (`plugin` entry) and
  `<workDir>/.vteam-role-guard/` all survive in the volume, so the next image would boot
  opencode still pointed at a plugin file that no longer exists. `purgeLegacyGuardArtifacts()`
  in the injector removes exactly those (both injection paths) and is asserted live on a
  reused volume. Any future deleted-injection layer needs the same purge step.
- **`resolveGuardTools` / `resolveBashDeny` are NOT dead after deleting the guard.**
  They feed `resolveByAgent` → `ResolvedExecutionPolicy.tools`, which is the matrix the
  LIVE server gate (todo 3) reads. Reference search before deletion: both stayed.
  Same for `guardForAgent` / `canonicalizeTools` / `filterToolsMatrix` /
  `canonicalizeCorrection` (the last is used by `worker-dispatcher.ts` for the DB-sourced
  boundary injection, independent of the deleted payload).
- **The payload's `guard.roles[*]` is now `{permission}` only** — `tools`/`bashDeny`/
  `correction` were consumed ONLY by the deleted worker plugin. `permission` stays because
  it is the historical byte-identity anchor and the agents-page/my_profile display source.
- **Baseline transition:** `3d26b49f…` → `e795b0c8…` (todo-4 → todo-5 shot). Both harnesses'
  `FROZEN_BASELINE_SHA256` defaults updated; the historical
  `vteam-role-behavior-abstraction/before-agent-policies.json` (3b8c5d4b…) untouched and
  still asserted by `e2e-third-party-no-policy-leak.sh` D1.
- **Harness gotcha that cost a false FAIL:** `e2e-role-boundaries.sh` f2 polled the injected
  file with a whole-file `grep '"bash": "deny"'` — but `vteam-project_manager`'s baseline
  ALREADY has `bash: deny`, so the poll passed against the pre-restart container and the
  comparison then read a stale file. Fix: poll the *edited role's own field* (a small python
  reader) AND gate on `docker inspect .State.StartedAt > reload_requested_at`. Any
  "did the restart land" poll must key on a value that is genuinely new.
- **`--force-recreate` was also hiding in the f2 EXIT trap.** It re-runs the `init`
  dependency → reseed. Replaced with `restart` (the brief forbids `--force-recreate`).
  Same fix applied to `e2e-plan-member.sh` step 0c.
- **The todo-3 gate runs BEFORE the retained checks**, so old probes that used a caller
  lacking the tool now abort in the wrong place. The permission-matrix harness now derives
  its probe member/tool FROM the live gate matrix (member must HOLD my_profile and
  task_transition; the denied probe tool must be absent), and the hook-cancel probe
  registers as MAIN (a hook_cancel holder) then cancels as a different holder. Both
  throwaway sessions are inserted idempotently and deleted on EXIT.
- **Offline gate probe technique (reusable):** `docker compose cp` a small JS file into the
  server container and `node` it — it can `require('/app/dist/src/...')` the compiled
  `PlatformToolPermissionService` / `ExecutionPolicyService` and drive the REAL gate with a
  real PrismaClient. That is how permission-matrix step 1 now derives the 203-cell matrix
  from the live production code path instead of the deleted worker guard.
- `python3 -c` inside a `$( … <<'HEREDOC' … )` command substitution is fragile in these
  scripts (the outer quoting breaks). Write the heredoc to a temp JSON file with a TOP-LEVEL
  `python3 … <<'EOF'`, then read fields with short `python3 -c` calls.
- The models' own refusal behaviour can mask a confinement probe: both out-of-bounds edit
  probes were refused by the model before the engine's permission layer was reached.
  Confinement is asserted structurally from the injected config (the `edit` glob) plus the
  engine's own `evaluated permission=` log lines, not only from a probe's outcome.

## [2026-09-20] todo 6 — `task` becomes editable (issue 1)

- **The write path needed no new plumbing.** `task` reuses `handleNativeEffectChange(key,next)` verbatim
  (400ms debounce → `writeConfig` → `PATCH /execution-policies/:policyId {config}`). The only new fact was
  confirming that `assertValidConfig` validates `bash` but **not `task`** — so the control, not the server,
  is what constrains `task` to `allow|ask|deny`. `resolveTaskEffect(name, stored)` honours a stored legal
  value, so DB write → page read (`resolveByAgent`) and engine read (`buildAgentPolicies` → opencode.json)
  agree. Verified live: `GET /agent-policies` returned `task: allow` for `vteam-product` while the control
  showed allow, then both returned to `deny` after restore (see `task-6-task-editable.json`).
- **Seed agents are the safest round-trip fixture** (no create/delete churn): `产品经理` → `ep_product`
  (`task: deny`). The spec captures the full stored `config` before, flips deny→ask, reloads, then flips
  back and compares the whole config **deep-canonically** (MySQL reorders JSON keys; `JSON.stringify`
  byte-compare would false-fail). Also asserted against `GET /agent-policies` — the engine injection source
  — not just the page, which is what makes the proof cover "the server would honour it".
- **Screenshot scoping on this app:** `fullPage: true` is useless because the main area is an internal
  scroll container — the first capture showed the MCP tool list instead of the native rows. Fix:
  `row(page,"task").scrollIntoViewIfNeeded()` before `page.screenshot({fullPage:true})`.
- **Dead code falls out of the change:** with all four native rows owning a control, the `EffectBadge`
  branch was unreachable (`key` is the union `edit|read|bash|task`), so `EffectBadge` / `effectBadgeMeta` /
  `unknownEffectMeta` / `PermissionEffectKey` were deleted rather than parked. Header comment that claimed
  "task 为只读" and the old `native-task-note` claim were both replaced (a stale claim is a fail, not a
  cosmetic issue).
- **`--build web` recreates the `init` dependency too** (compose dependency graph), so a seed run happens;
  it is idempotent and left all 7 `ep_*` rows byte-identical (verified canonical + frozen-baseline canonical
  equality after the e2e). The recreate is not a `--force-recreate` and does not reseed destructively.
- Negative proof technique that also satisfies "no silent no-op": inject an illegal stored value
  (`task='bogus'`) via DB `JSON_SET`, assert the control normalizes the display to `deny` (never shows a
  value the server cannot honour) and that clicking a legal chip writes through (`bogus` → `allow`).
  Also asserted the row has no free-text input (`input,textarea,select` count 0) — the chip set IS the
  constraint, so there is no path by which the UI could submit an illegal `task`.
- **e2e reuse:** the todo-3 spec (`native-rule-editor.spec.ts`) had two `native-task-note` assertions; both
  updated in the same commit (test 1 now asserts `native-task-effect` visible + note absent; test 2 asserts
  the absent-key row defaults to `deny`). No other spec referenced the note.

## [2026-09-20] todo 7 SERVER slice — role external slot now actually reaches the member

- **The gap was exactly one function.** `defaultOpencodeAgentName` (todo 2) had zero runtime
  consumers: dispatch reads only `TeamMember.opencodeAgentName` (`worker-dispatcher.ts:3671-3687`),
  and `resolveMemberBinding` resolved only the internal slot. Fix: `resolveMemberBinding` gained
  **rule 5** (the mirror of rule 2) — `explicit opencodeAgentName > role.defaultOpencodeAgentName > null`
  — and returns `opencodeAgentName: string | null`; `create`/`addMember` persist it on the member row.
  `worker-dispatcher.ts` is byte-identical to HEAD (Scope OUT preserved: this is binding, not dispatch).
- **Branch 1 (explicit `agentId` + `roleId`) needed the external prefill too**, not just branch 2.
  A role that points at an *external* agent can never also hold `defaultAgentId` (todo 2 exclusivity),
  so its members MUST pass an explicit `agentId` — i.e. the role's external choice only ever flows
  through branch 1. The role row is now read once for both branches (label + both slots); the old
  `roleBindingOf` helper is deleted (it was the only other reader and would have been a second query).
- **`prefill ≠ override` lives in `updateMember`, not in the resolver.** The resolver is stateless and
  cannot see the persisted member; the guard `dto.opencodeAgentName === undefined && !(member.opencodeAgentName?.trim())`
  is what prevents clobbering. The explicit `opencodeAgentName` branch keeps its own path, so the
  request-level precedence is: explicit request value > persisted member value > role default.
- **Deleting `roleBindingOf` shifts 2 existing spec assertions.** The two `agentRole.findUnique` shape
  assertions (`addMember 仅给 roleId` and `addMember 同时给 agentId 与 roleId`) now expect the full
  select `{id,key,name,defaultAgentId,defaultOpencodeAgentName}`; the first `create()` test asserts
  exact `teamMember.create` args (not `objectContaining`) so those two needed `opencodeAgentName: null`.
  `tsc` catches the type-level consequence but NOT these mock-shape assertions — run `src/teams` early.
- **`updateMember` reuses the resolver for the explicit-agentId + roleId branch** rather than
  inlining a second slot lookup: `resolveMemberBinding({agentId, roleId})` returns the same
  `opencodeAgentName` the other branches get, so rule 5 is computed in exactly one place.
- **Mutation proof pattern that works here:** patch `teams.service.ts` in a python heredoc, run
  `npx jest src/teams/teams.service.spec.ts` with `stderr=subprocess.STDOUT` (plain `2>&1 | grep`
  missed the `✕` lines because jest prints failures on stderr), then assert the file reads back
  byte-identical. All 4 mutations map 1:1 to acceptance criteria (a)-(d); the "no regression" (e)
  cases are asserted as `opencodeAgentName === null` / `undefined` — note `undefined` means "not in
  the update payload" for updateMember, `null` means "written null" for create.
- **Full server suite: 145 suites / 3320 tests** (baseline 3308 + 12 new tests, all in `src/teams`).
- Live e2e (role editor select → member resolves) is todo 10(e); this slice's acceptance gates were
  `tsc --noEmit` + `jest --runInBand src/teams`, so no server restart / DB mutation was performed
  (a server rebuild mid-parallel-web-slice would race the other todo-7 worker; nothing was left dirty).

## [2026-09-20] todo 7 WEB slice — one agent slot in the role editor; member picker removed

- **Selector encoding beats parallel state.** The single `role-default-agent` control maps
  `"" | internal:<agentId> | external:<name>` via two pure helpers (`slotValueOf` /
  `applySlotValue`) and the XOR lives in exactly one place. A `data-slot="unset|internal|external"`
  attribute mirrors the chosen family so the specs assert the slot *family*, not just the value.
  Consequence: the existing `roles-members` test-2 assertions became
  `selectOption("internal:a_developer")` / `toHaveValue("internal:a_tester")` (persistence
  assertion unchanged) — a value-encoding change only.
- **The honesty requirement split into two visible states.** (a) A saved external name that is
  missing from the current list gets a synthetic `external:<name>` option with the *reason*
  (引擎未上报 / 列表加载中 / 列表不可用) — never silently dropped, and the note text distinguishes
  the three engine states. (b) `describeDefaultSlot()` makes the left list item say
  `<name>（外部）` so an external binding can never read 未设置 (asserted in the spec).
  Not a cosmetic thing: the old code's `?? "未设置"` was a false claim for exactly the roles this
  todo creates.
- **`role-action-error` ordering.** `isApiError` narrowing means the conflict branch is a second
  `err.code` ternary; the copy names the invariant (内部与外部只能二选一). A single-select UI
  cannot produce a double-non-null request, so the spec proves the surface with a route-mocked
  400 (and asserts persisted state is unchanged after the failed save — no false success).
- **Removal was grep-gated.** `useMemo` was imported only for the opencode-query derivations
  (verified: the only other `useMemo` uses were those two), so the import went with them.
  `agentsQuery` (add-member panel) stays. The session-page spec keeps its own guarantee via a
  second file-scoped assertion instead of relying on the removed test's promise.
- **Harness repurposed, not deleted: `git mv scripts/e2e-member-external-agent.sh
  scripts/e2e-agent-surfaces.sh`.** `third-party-agents.spec.ts` had NO other runner (grep:
  only this harness's testMatch matched it), so deleting the harness silently dropped that
  coverage. New testMatch `(no-agent-picker|third-party-agents|roles-members)`, dead `T3_*` env
  vars dropped; the run is 12/12 (5 + 2 + ... specs) plus roles-members 4/4.
- **Screenshots: wait for the engine note before capturing.** The first
  `task-7-role-agent-select.png` captured the *loading* state ("引擎 Agent 列表加载中…"), which
  is honest but not the proof the brief wants; gating on `role-default-agent-note` containing
  `个外部 Agent` before `scrollIntoViewIfNeeded()` + viewport screenshot fixed it. `fullPage:true`
  remains unreliable (todo-6 lesson).
- **Spec/notepad wiring for todo 9:** `web/e2e/member-external-agent.spec.ts` is DELETED (guarded
  only the removed picker); its engine-state coverage for the settings surface moved into the
  role editor (`role-default-agent` note) and `third-party-agents.spec.ts` keeps the external-tab
  read-only contract. The external picker's live round-trip now lives in `roles-members.spec.ts`
  test 4. `docs/test-cases/08-*.md` (todo 9) still references the deleted spec — update it to the
  above.
- **Canonical no-residue habit:** pre-build `GET /agent-roles?pageSize=100` captured as
  `sorted(json.dumps(sort_keys=True))` strings; compared equal after every e2e run (8 seed rows),
  `teams` 1 / `tasks` 2 / `agents` 7. All throwaway roles/teams were deleted in spec `finally`.

## [2026-09-20] todo 9 — test-case doc refresh + suite re-green

- **The 08 doc was untracked in git** (never committed; `git ls-files docs/test-cases/` lists only
  00–07). Task 9 stages it with `git add` in the single todo-9 commit — no history to preserve,
  so no `git mv` needed.
- **Stale-proof pattern:** a throwaway `.t9stale/` spec asserting the removed
  `member-external-agent-select` on the team-detail page FAILS live (count 0 ≠ 1), proving the
  doc matches reality; scratch deleted immediately after (never committed).
- **`e2e-role-boundaries.sh` SCENARIOS=f pitfall:** passing `WORK_DIR=/tmp/...` leaks into
  `WORKER_WORK_DIR` (default `${WORK_DIR:-/data/vteam-worker}`), so f2's live `docker compose cp`
  fetch reads a static copy and the 180s poll fails. Fix: pass `INJECTED_OPENCODE_JSON` (static
  copy) for the f contract check and leave `WORK_DIR` unset so `WORKER_WORK_DIR` defaults to
  the live container path. State restored canonically after both the failed and the green run
  (live `/agent-policies` == frozen baseline `e795b0c8…`, injected `vteam-product` bash back
  to `allow`).
- **Counts that hold:** 08 doc = 54 cases (46 section tables + 8 E2E), 31正向/23反向,
  41 P0 / 13 P1; index 00 adds the 08 row (31/23/54) with totals 202/218/420.
  R1–R8 red lines now include R7 (server 403) + R8 (single slot).

## [2026-09-20] todo 8 — dark-mode role selection + external warning

- **Shallow contract, not deep-vars.** The spec asserts ON the role-item/warning computed colours
  (dark ≠ light hex, light byte-equal to the old `#EFF6FF/#B45309/#FFFBEB/#FDE68A`), so any
  refactor that preserves light output passes — per-role `--color-role-*-{color,bg,border}` +
  `--color-warning-*` in `:root`/`.dark` is the shape chosen, light values byte-equal by intent.
- **Spec theme goes through the app's own `theme-toggle`** (theme-store → `html.dark`), matching a
  real user; assertions use `rgba(` alpha presence for the dark tint, not a fixed rgb.
- **Screenshot flow that works:** `theme → tab → wait off loading → scrollIntoViewIfNeeded →
  viewport screenshot`. `fullPage:true` stays unreliable (internal scroll container); PNG comes
  from the `T8_SCREENSHOT` run itself (throwaway `.t8.playwright.config.ts`, baseURL
  `http://localhost:13001`, deleted after the run).

## [2026-09-20] todo 10 — closing live proof (a)–(g) on a clean rebuild

- **Parts (a)+(b) survived from the prior attempt — do NOT redo.** `task-10-raw/00-08` (down -v,
  verbatim credential restore, up --build, init 0, 64 migrations, native-only injection) was
  verified intact; the finish session only added `09-*` files.
- **Dispatch needs a worker defaultModelId.** Seed agents carry `defaultModelId=null` and the
  worker row has none → first sendMessage ran `model=(default)` and failed pre-execution
  (Cannot connect to API). Fix: PATCH `/workers/w_compose_worker {defaultModelId:
  "ornith/ornith-1.5:35b"}` (live, connectivity pre-verified with wget from inside the worker),
  re-dispatch on the SAME session row, then PATCH back to null. Record the detour honestly —
  the pass condition is the observable execution record, never model text.
- **`task_transition` deny probes must use a schema-valid action.** `action=close` is rejected
  by zod pre-gate (-32602 Invalid option) so the permission gate never answers; `action=start`
  reaches the gate and yields -32003/[403]/PLATFORM_MCP_TOOL_NOT_PERMITTED.
- **urllib 502s through the local proxy — use curl** (established learning, re-bit once more).
- **Harness env for SCENARIOS=f:** pass a static `INJECTED_OPENCODE_JSON` copy and leave
  `WORK_DIR` unset so `WORKER_WORK_DIR` defaults to the live container path (todo-9 lesson).
- Evidence generator pattern: one `/tmp/t10gen.py` script reads every raw file and writes
  `task-10-live-proof.txt` — regenerate, never hand-edit (keeps every claim re-runnable).

## [2026-09-20] task-11 — dual-empty context backfill

- **Refines removed from the tool schema; backfill lives in `toolsCall`.**
  `resolveToolCallerWithContext` + `resolveSessionFallback` give single-precedence backfill:
  explicit taskId/teamId wins, else infer from the worker session, unresolvable → fail-closed
  403 `PLATFORM_MCP_TOOL_NOT_PERMITTED` (never `-32602`).
- **controller.spec rewritten around the backfill:** dual-empty proceeds via session fallback,
  no-session → 403, explicit-teamId-wins mutation test (explicit value survives backfill).
- **Live legs:** A dual-empty succeeds via session fallback; B no-session → 403
  `PLATFORM_MCP_TOOL_NOT_PERMITTED`; C explicit teamId unchanged. Gates: `tsc` 0,
  `src/platform-mcp` 13 suites / 428 tests green. Evidence:
  `task-11-context-backfill.txt` + `task-11-raw/` (legs A/B/C).

## [2026-09-20] task-12 — first-token timeout env parse + 300s default
- **Root cause**: plain ConfigModule (no schema) returns STRINGS, so
  `config.get<number>('FIRST_TOKEN_TIMEOUT_MS')` + `typeof === 'number'` always failed
  → env (incl. compose `"0"`) was silently ignored and the 60s default always won.
  Fix: exported `parseTimeoutMs(raw, fallback)` (decimal int; `"0"`→0 disabled;
  empty/garbage/negative/non-finite→fallback), applied to BOTH first-token and idle reads.
- **Default 60s → 300s** (`DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 300_000`); compose
  `FIRST_TOKEN_TIMEOUT_MS: "300000"`. Stale `60s` comments/titles updated; the
  DISPATCH_TIMEOUT_MS historical note (72s > 60s) is intentionally untouched.
- **Spec pattern for env-string coverage**: `config.get` mock must return STRINGS
  (`'10000'`), not numbers — a numeric mock would pass even with the old broken code.
- Integration spec now advances `dispatcher.firstTokenTimeoutMs + 1000` instead of a
  hardcoded `60_000`, so it survives future default changes.

## [2026-09-20] first-token wake-retry — 首字静默改为唤醒重试

- **静默 #1/#2/#3 各唤醒一次，耗尽才失败**：`reapFirstTokenDeadline` 先查
  `firstTokenWakeAttempts`，未达 `MAX_FIRST_TOKEN_WAKE_ATTEMPTS=3` → 计数 +1、经既有
  `tryAutoRestart`（kind='wake'【自动恢复】文案，团队频道经 resolveTeamChannel）唤醒、
  经 `armFirstTokenWatchdog` 重武装全新 300s 窗口（内存 timer + durable 行新 dedupKey）；
  第 4 次到期才走失败路径（pending 删除 + failedSessions + 注销 + emitError/agent.error，
  文案含「已尝试 3 次自动唤醒仍未恢复」）。
- **重武装的世代号是正确性核心**：`PendingDispatch.dispatchedAt` 与 durable payload 的
  `dispatchedAt` 同值作世代号——durable handler 与旧 setTimeout 都凭它识别被取代的旧行，
  否则迟到 firing 会提前收割新窗口。`scheduleFirstTokenTrigger` 的 dedupKey 挂载也须
  同世代校验，防旧 schedule 迟到 resolve 覆盖新窗口 key。
- **计数器生命周期**：`handleSessionActivity`（任意活动）与 `handleTaskCompleted`、
  `clearPendingWatchdog` 复零；`onModuleDestroy` 清空。唤醒目标按
  `session.findUnique({taskId,teamId,teamMemberId})` 解析（与 idle-forensics 同口径），
  无团队归属 → 跳过唤醒但计数/重武装照常。
- **测试必须按窗口推进**：旧断言单次 `advanceTimersByTimeAsync(300s)` 现在只够第 1 次
  唤醒；新断言推进 `300s × (MAX+1)`，并在 dispatch/唤醒用例 mock
  `task.findUnique(status:'in_progress')` + `chatChannel.findFirst` 让 tryAutoRestart 真走通，
  或 spy `tryAutoRestart`（注意：spy 需在首个 300s 到期前安装）。
- **突变验证**：把 `attempts < MAX` 临时改为 `attempts < 0` → 4 个新/改断言立即失败，
  证明唤醒路径确被断言锁定（验证后已还原）。

## [2026-09-20] first-token wake-retry — 坑

- 证据文件用 `workdir=server` 执行重定向会落到 `server/.omo/...`；已移动到仓库根
  `.omo/evidence/...` 并删除误建目录（MUST-NOT-DO 禁止 server/ 下新建文件）。

## [2026-09-21] WEB slice — team-create member selection map (role-based binding unblock)
- **team-create page is agent-sourced, role-attached silently.** `web/app/(main)/teams/new/page.tsx:192-196` GET `/agents` + `:199-203` GET `/agent-roles` (via `agentRolesApi.list`); `agentIdForRoleKey` (`:210-215`) = `role.defaultAgentId` first, fallback `/agents` template match by `role`. Six `RoleInstanceCard` (`:83-121`) are FIXED `ROLE_ORDER` (`:50`) toggles — no role picker; `CustomAgentCard` (`:123-176`) renders raw custom-agent list from GET `/agents` (`type!==template`, `:196`). `roleId` attached silently at `:225`/`233` (`roleByKey.get(role)?.id`). Submit (`:262-276` → `teamsApi.create` POST `/teams`) per member: `{agentId, roleId?, alias?, workDir?}` — never `opencodeAgentName`.
- **TeamMembersPanel add-instance is the only dual selector.** `TeamMembersPanel.tsx:152-156` GET `/agent-roles` renders role radios (`:723-761`, `data-role-id`, `data-default-agent`); agent `<select>` (`:813-838`) options built at `:171-178` from parent-supplied `agentOptions`+`customAgents` (both derived from GET `/agents`). `pickRole` (`:238-241`) prefills `selectedAgentId = role.defaultAgentId ?? ""`; user can override in the select. `confirmAdd` (`:242-255`) sends `{agentId, roleId?, alias?}` — no `workDir`, no `opencodeAgentName`. Payload type `AddInstancePayload` at `:102-106`.
- **team-detail add-member is agent-only, role-free.** `teams/[id]/page.tsx:93-97` GET `/agents`; select at `:443-448` (`value=a.id`); `addMutation` at `:150-152` → POST `/teams/:id/members` `{agentId, alias?, workDir?}` — no `roleId`, no `opencodeAgentName`. This is the clearest AGENT-where-ROLE-should-go spot.
- **session-page add-instance reroutes through tasks.** `session/page.tsx:276-280` GET `/agents` → `roleOptionsOf`/`customAgentsOf` (`TeamMembersPanel.tsx:70-87`) → panel props at `session/page.tsx:1098-1099`; `handleAddInstance` (`:987-996`) → POST `/tasks/:taskId/team` `{addInstances:[{agentId, roleId?, alias?}]}` (`:971-976`) — same shape as panel, different endpoint; no `workDir`/`opencodeAgentName`. Only `opencodeAgentName` write on this page is the plan-mode clear PATCH (`:816` `{opencodeAgentName:""}`), not a picker.
- **role-owned binding lives in exactly one place.** `AgentRolesTab.tsx:627-657` `role-default-agent` single selector, encoding `""|internal:<id>|external:<name>` (`slotValueOf` `:115-119` / `applySlotValue` `:121-135`, `data-slot` at `:630`); sources GET `/agents` (`:175-178`) + GET `/agents/opencode` (`:186-194`, filtered `!governed && !hidden`); saves XOR `defaultAgentId`/`defaultOpencodeAgentName` via POST/PATCH `/agent-roles` (`:226-250`). API shapes: `agent-roles.ts:13-26` DTO, `teams.ts:68-100` payloads (`CreateTeam`/`AddMember` lack `opencodeAgentName`; only `UpdateMemberPayload:97` carries it).
- **AGENT-where-ROLE-should-go list (per requester intent):** (1) team-create `CustomAgentCard` raw agent list (`new/page.tsx:158-172`); (2) team-detail `add-member-agent-select` pure agent dropdown (`[id]/page.tsx:443-448`, no roleId sent); (3) panel `add-instance-agent-select` explicit-override path (`TeamMembersPanel.tsx:813-838`) letting the user detach agent from role default; (4) team-create fixed `ROLE_ORDER` cards silently bind whatever `defaultAgentId`/fallback resolves without showing the role record. Message-input `@` mention (`message-input.tsx:33-36,213-296`) is chat mention, not member binding — out of scope.

## [2026-09-21] task-13 tasks binding unification — learnings
- TeamsService.resolveMemberBinding is `private` and reads roles via non-tx `this.prisma`; importing TeamsService into tasks would drag WorkerClient/WorkersService — mirror line-for-line with a citation comment instead (`teams.service.ts:1328-1430` stays single source of truth).
- DTO-shape vs service-rule split: class-validator cannot express at-least-one-of, so controller.spec asserts shape-only (roleId-only valid, alias-only valid) while rule-4 400 lives in service.spec.
- Controller.spec stale assertion was the only red test (alias-only now valid by design); updated, never weakened — both-missing still 400s in service.

## [2026-09-21] web role-first member-add — payload contract + external executor rule + absorbed files
- **Role-only payload contract (server prefill).** Both web entry points accept a member with ONLY `roleId`, no `agentId`: team-create (`web/app/(main)/teams/new/page.tsx`) POSTs `/teams` with `{roleId}` members, and team-detail `TeamMembersPanel`/`[id]/page.tsx` POST `/teams/:id/members` with `{roleId, alias?}`. Server rule 2 fills `agentId := role.defaultAgentId`; the browser request body must NOT contain `agentId` (spec asserts the raw request payload is role-only, then reads back `member.agentId === role.defaultAgentId`).
- **External-only role → mandatory executor.** When a role is external-bound (`role.defaultOpencodeAgentName`, e.g. `Prometheus - Plan Builder`), the role option renders with a `（外部）` suffix and an "执行 Agent" executor slot appears. Confirm is GUARDED while the executor is unset (visible error, ZERO request emitted); once an internal executor Agent is chosen, server rule 5 persists `member.opencodeAgentName === <external role name>` AND `member.agentId === <executor>`. This survives reload (row re-renders; API read-back field-identical).
- **Absorbed into concurrent commit `fdfeb1f`.** `web/app/(main)/teams/[id]/page.tsx` (66 lines) and `web/app/(main)/teams/[id]/session/page.tsx` (31 lines) were committed by the concurrent `feat(team): 主agent门禁 …` commit — their working-tree state is clean; the task-14 closeout stages NEITHER.
- **Spec result.** `web/e2e/role-first-member-add.spec.ts` under throwaway config `web/.t14.playwright.config.ts` → **3 passed (6.8s)** on live compose (web :13001 / server :13000): (a) team-create role-only no-`agentId`; (a+b) detail-page role-only + external guard + executor → `opencodeAgentName` persisted after reload; (c) session page still zero `<select>` / zero `message-agent-select`. Cleanup DELETEd all `qa-t14-*` throwaways (team-then-role); live residue check = 0.

## [2026-09-21] task-15 — team-create 改由 /agent-roles 单一来源（web）

- **卡片来源＝岗位列表，bucket＝role.id**：`/teams/new` 删掉 `ROLE_ORDER`(6 硬编码) + `CustomAgentCard`
  (`/agents` `type!=template` 的逃生口)，改为 `roleItems.map(...)`（内置 + 自定义同列）。`InstancesByRole`
  由 `Partial<Record<RoleKey|"custom">>` 改为 `Record<string, InstanceDraft[]>`，每个自定义岗位天然各占一桶；
  提交 member 恒带 `roleId`，仅外部-only 岗位附执行者 `agentId`（与 server 规则 2/5 对齐）。
- **自定义 key 不能查 tokens.roles**：`roles[key]` 对 `sisyphus/atlas/general` 返回 undefined，且
  `AgentAvatar` 的 `role` prop 是 `RoleKey`（TS 直接报错）。用 `(ROLE_KEYS as readonly string[]).includes(key)`
  收窄；非内置走中性 palette + 同尺寸自绘 `<span data-testid="agent-avatar">`——既不崩，也不冒充
  developer 绿（`AgentAvatar` 内部对非法 role 静默回落 developer，会给出错误角色语义）。
- **默认 alias/workDir 基名＝`role.name`**：live 内置岗位 name 与 tokens label 逐字相同（产品经理/项目经理/…），
  统一用 `role.name` 不改变既有默认值（`开发者-1` 仍是 `开发者-1`），自定义岗位自然得 `Sisyphus-1`。
- **`allInstancesOf` = `Object.values(m).flat()`**：成员顺序＝勾选顺序（ROLE_ORDER 规范序已不存在）；
  `mainAgentMemberId` 与 members 用同一数组下标计算，二者永远一致——顺序变化不是正确性问题。
- **零既有 spec 依赖被删 testid**：`web/e2e` 对 role-card / custom-agent-item / add-custom-agent-btn 的引用为 0；
  新增 `web/e2e/team-create-role-list.spec.ts` 用 `[data-testid="role-card"][data-role=<key>]` 定位自定义岗位卡。
  live `/teams/new` DOM census = 11 卡（7 内置 + sisyphus/prometheus/atlas/general），截图见
  `.omo/evidence/opencode-native-permissions-and-fixes/task-15-teams-new-role-cards.png`。
- **bundle 标记要选唯一字面量**：`roles-loading` 在 agents/system-roles 页早已存在，用它证明「新 image 生效」
  是弱证据；本页独有字面量 `岗位加载失败` grep `/app/.next/static/chunks` 才命中唯一 chunk
  `app/(main)/teams/new/page-*.js`。`docker compose up -d web` 会连带跑 init（migrate deploy，退出即止），
  实测数据未被重置（11 roles / 2 teams 不变）；依然不要 `--force-recreate`（会 reseed）。
- **spec 形状**：建一张一次性自定义岗位（`defaultAgentId=a_tester`）→ 断言角色卡全量（count = /agent-roles 总数、
  每个 key 一张、>6）→ 勾选该卡建团 → 断言 POST `/teams` body `members[0].roleId===role.id` 且无 `agentId`
  → GET 回读 `agentId==="a_tester"`；第二例用 live 外部-only 岗位证明 hint + executor 槽位 + 守卫零请求。
  finally 先删 team 后删 role（防 409 in-use）；residue=0。

## [2026-09-21] 平台强制 plan agent 移除 — 执行 agent 恒取成员绑定

- **改了什么（单文件 + spec）**：`server/src/chat/worker-dispatcher.ts` 删除
  `effectivePlanForPolicy` 镜像变量与 `agent = effectivePlan ? VTEAM_PLAN_AGENT_NAME :
  resolvePolicyAgentCandidate(...)` 分支；`policyCandidateAgent` 现在无条件 =
  `resolvePolicyAgentCandidate(agentIdentity)`（`vteam-<agentKey>`，仅受 worker 能力位门控）。
  `VTEAM_PLAN_AGENT_NAME` import 随之删除（grep 确认该文件无其余引用；
  `opencode-agent-duty.ts` 常量保留，platform-mcp `'vteam-plan'` 兜底与
  tasks.service `effectivePlanMode` DTO 均按 brief 未触碰）。
- **新优先级（代码不变式，未动能力位门/external-vs-internal 顺序）**：执行 agent 由成员绑定唯一决定——
  能力位 `enabled && names.includes(vteam-<agentKey>)` 真 → 内部候选；否则回落成员显式绑定
  `opencodeAgentName`；两者皆无 → 省略 agent 键（引擎默认）。`systemOpts.taskPlanMode`
  与原 `getOpencodeAgentDuty(mainAgentName) === 'plan'` 启发式原样保留，只管计划指令注入。
- **计划模式现在真由绑定表达**：要计划行为 = 成员/岗位绑定到 agentKey=plan（或职责为 plan 的
  opencode 名）的 agent → 候选即 `vteam-plan`；平台不再凭 task.planMode 代选。
- **spec 迁移（+2 净新增，273→275 个 `it(`）**：原「plan_mode → vteam-plan」3 个断言改为
  「计划开关不影响 agent 选择」（候选命中→vteam-product / 候选未命中→回落 build / 省键），
  新增「(f) agentKey=plan + planMode 关 → vteam-plan（绑定才是来源）」。
- **突变验证（不污染工作树）**：把 `resolvePolicyAgentCandidate(agentIdentity)` 临时换成
  `systemOpts.taskPlanMode === true ? 'vteam-plan' : ...`（旧行为），`-t "plan 开关真"` 下
  恰 2 个新回归断言 ✕、门假用例仍 ✓；随后从 /tmp 备份还原，sha256 `eae15611…` 前后一致。
- **命令与结果**（均 `cd server`）：
  - `npx tsc --noEmit -p tsconfig.json` → exit 0
  - `npx jest --runInBand src/chat` → 13 suites / 502 tests 全绿（基线 notepad 记的 497 是旧数字；
    HEAD spec `it(` 计数 273 → 275 = 本次净 +2）
  - `npx jest --runInBand src/tasks src/teams` → 13 suites / 422 tests 全绿
- **坑**：bash 多行命令的 `workdir` 必须显式给 `server`，否则 jest 在仓库根找不到 config 而假红
  （第一次突变跑出的 exit 1 其实是 "Could not find a config file"，不是断言失败）。

## [2026-09-21] 外部绑定优先（Change A）+ 平台计划指令注入下线（Change B）—— worker-dispatcher 单文件双改

- **Change A 新优先级（bug 修复）**：`resolvedAgentName = opencodeAgentName ?? (候选 && workerSupportsAgentPolicies(worker, 候选) ? 候选 : null)`。
  成员显式外部绑定（`TeamMember.opencodeAgentName`，含岗位外部槽位预填）**无条件胜出**；内部候选 `vteam-<agentKey>`
  只在无外部绑定时使用，且仍受能力位 `enabled && names.includes(候选)` 门控（**能力位只门控内部候选，不门控外部绑定**）；
  两者皆无 → 省略 `agent` 键（引擎默认）。旧行为（候选优先、外部仅兜底）造成「外部绑定岗位顺带选内置执行 agent ⇒ 外部名被忽略」。
  `...(resolvedAgentName ? { agent: resolvedAgentName } : {})` 调用点未动。
- **Change B：平台不再注入计划指令**。删除 `PLAN_PRODUCE_INSTRUCTION`/`PLAN_REVIEW_INSTRUCTION` 常量（含
  `【计划编制】/【计划评审】`）、`BuildSystemInstructionsOptions.taskPlanMode` 字段与注入块、dispatch 的计划计算
  （`request.taskContext?.planMode` / `resolveTaskPlanMode` / `getOpencodeAgentDuty(主成员绑定名)==='plan'` 启发式）、
  私有方法 `resolveTaskPlanMode`、该文件的 `getOpencodeAgentDuty` import；`message-dispatcher.ts` 的
  `taskContext.planMode` 透传字段同步删除。task-mode 结构保持：`if (taskIdForPrompt) { memoryIndex… } else { teamMode/taskId='' }`。
  是否计划模式由所绑定 agent 自身 prompt 表达（用户指令），平台不代控。
- **未动**：`platform-mcp/**` 的 plan_mode 工具/服务、`tasks/**` 的 Task.planMode 列与 DTO、`VTEAM_PLAN_AGENT_NAME` /
  `opencode-agent-duty.ts`（其它消费方仍在：tasks.service / plan-docs.service / review-verdict.listener / execution-policy）、
  prisma、web。
- **越界 1 处（brief 的 MUST-NOT-DO 与 DoD 冲突，已最小化处理）**：`server/src/platform-mcp/plan-removal.guard.spec.ts:177-185`
  原断言 `export const PLAN_PRODUCE_INSTRUCTION` 恰好命中 1 处——与 Change B（常量必须删除）直接互斥；不改则全量必红。
  已改写为「PLAN_PRODUCE/PLAN_REVIEW 常量必须缺席」的反向防回流锁（保留 `type:"plan"` 零命中断言），未碰任何控制面代码。
- **命令与结果（均 workdir=server）**：
  - `npx tsc --noEmit -p tsconfig.json` → exit 0
  - `npx jest --runInBand src/chat/worker-dispatcher.spec.ts` → 1 suite / 265 tests 全绿（净 -4 条 it：删 8 增 4）
  - `npx jest --runInBand`（全量）→ 142 suites 过 / **3 suites 失败、5 tests 失败**；失败集与 HEAD 基线**逐一相同**：
    `task.constants.spec.ts`×3（五态契约未含新 `blocked/block/resume`）、`platform-mcp.service.spec.ts` notify_agent
    团队维度 triggered、`platform-mcp.service.review-dispatch.spec.ts` 三元组 reason。
    **基线证明**：`git stash push` 这 4 个文件 → 同 3 套件仍 3 suites / 5 tests 失败（同 5 个测试名）→ `git stash pop` 还原。
    ⇒ 与本改动零关联；且属 MUST-NOT-DO 的 platform-mcp/tasks 域，**未修**（按 notepad 先例：证明不是我们的，不在越界域修）。
  - `npx jest --runInBand src/tasks src/teams` → 13 suites / 422 tests 全绿
  - 突变验证（不污染工作树）：临时改回旧优先级（候选优先）→ `-t 'rule 1'` 恰 1 个新回归断言 ✕（收到
    `vteam-demo-agent` 而非 `Sisyphus - ultraworker`）；/tmp 备份还原后 sha256 `e6de75bb…` 前后一致。
- **spec 迁移**：删 4 类计划注入断言（buildSystemInstructions 3 例、dispatch 计划 3 例、taskContext planMode 免读表 1 例…），
  新建 2 个「平台不再注入计划段」反向锁；agent-selection 契约由旧 4 条改为新 3 条（外部绑定 > 内部候选 > 省略），
  rule 1 用 brief 指定外部名 `'Sisyphus - ultraworker'` 锁定 Change A；`Todo2` 主门用例改断言 dispatch 零 task 表读取。
- **坑**：`git stash push -- <path>` 在 workdir=server 下 pathspec 必须相对 server 写（写 `server/src/...` 会
  "did not match any file(s)" 静默失败，`&&` 链全跳过；当时 tail 到的 `/tmp/jest-baseline.log` 竟是 9/17 的陈旧文件，
  差点误读 —— 每次用新的日志文件名）。`.omo/evidence/plan-review-execution-gates/task-9/probe.json` 与
  `.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json` 会话中途变为 modified（非本次改动产生，未触碰）。

## [2026-09-21] WEB slice — legacy task.planMode UI surface removed (platform stops touching plan mode)

- **Removals (7 files, web only)**：
  - `web/src/components/tasks/task-detail-types.ts`：删 `TaskDetail.planMode` / `effectivePlanMode` 两字段及注释。
  - `web/src/components/teams/TeamRightPanel.tsx`：删 `planModeOn` 推导、配置 Tab「计划模式」行、计划文档空态三元（改为单串「暂无计划文件（可上传）」）；计划 Tab 的 `PlanStatusBlock`/文件列表/上传/执行步骤一律未动。
  - `web/app/(main)/teams/[id]/session/page.tsx`：删 `approveSwitchError` state、`handleQuestionSubmit` 的 andSwitchToExecute 分支（含 `PATCH /tasks/:id {planMode:false}` 与主成员 `opencodeAgentName:""` 两步）、`showApproveAndSwitch` 计算、`approve-switch-error` 渲染块与 prop；答复路径收敛为 `questionReplyMutation.mutate(payload)`（普通批准/拒绝行为不变）。
  - `web/src/components/chat/question-modal.tsx`：`QuestionModalProps` 删 `andSwitchToExecute`（payload 字段）与 `showApproveAndSwitch`（含两处按钮 `question-approve-and-switch`）。
  - `web/e2e/plan-{finalize,archive,status}.spec.ts`：仅删 mock task 中两枚死键（`planMode:false` / `effectivePlanMode:false`），断言全未动。
- **Grep 归零**：`grep -rIn -E 'planMode|effectivePlanMode|showApproveAndSwitch|andSwitchToExecute' web/ --exclude-dir=node_modules --exclude-dir=.next` → exit 1（零命中）。
- **命令与结果（workdir=web）**：
  - `npx tsc --noEmit` → exit 0
  - `./node_modules/.bin/eslint <7 touched files>` → 0 errors / 3 warnings；用 `git show HEAD:...` 临时副本对照，三条 warning（TeamRightPanel 未用 TaskDetail/task、question-modal no-unused-expressions）HEAD 基线完全相同，非本次引入。
  - plan 域 e2e（临时 config：`testDir ./e2e`、`baseURL http://localhost:3001`、`channel:'chrome'`、list reporter；跑完已删）：
    - 先对 docker web `:13001`（镜像不含本次工作树改动）跑 → 10/10 失败，全部「navigated to /login」。
    - 根因（环境，不是本次改动）：spec 未 mock `GET /api/v1/triggers`（`TeamRightPanel.useTaskTriggers`，spec 之后才加入）→ 命中真 server → 401 → `authStore` 模块级 401 handler `window.location.href='/login'`；本次 7 个文件不在镜像内，失败与改动无关。
    - 改对工作树 dev server `npx next dev --turbopack -p 3001`（web 无 .env，middleware 代理目标缺省 localhost:3000 无监听 → 未 mock 调用是网络错误而非 401）：
      `npx playwright test --config .t-plan-flag-removal.playwright.config.ts e2e/plan-status.spec.ts e2e/plan-archive.spec.ts e2e/plan-finalize.spec.ts --reporter=list` → **10 passed**（plan-status 5 + archive 1 + finalize 4）；dev server、临时 config、test-results/ 均已删除。
  - 副作用（如实记录）：spec 运行重写了 `.omo/evidence/plan-review-execution-gates/task-12/asserts.json` 与 `.omo/evidence/plan-finalize-gate/asserts.json`——diff 为 badge「修订中」→「草稿」+ 新增 draft-empty 场景，说明工作树 spec 本就比已提交证据新；未回滚、未手改。
- **将来跑这三个 spec 的正确姿势**：对 dev server 跑（或补 mock `/api/v1/triggers`）；对 docker 13001 镜像跑必假红（401 重定向），且镜像 ≠ 工作树，不能作验证手段。

## [2026-09-21] legacy `task.planMode` 控制面从 server 全量下线（option a：平台不代控计划）—— schema / DTO / service / MCP / seed / spec / 冻结基线 / e2e 脚本

- **删除清单（server）**：
  - `prisma/schema.prisma` Task.planMode 列 + 其注释；新迁移 `20260921000001_drop_task_plan_mode`（仅 `ALTER TABLE tasks DROP COLUMN plan_mode`，中文注释说明列史与单向性）。
  - DTO：`create-task.dto.ts` / `update-task.dto.ts` 的 planMode 字段（含 ApiPropertyOptional 描述）。
  - `tasks.service.ts`：TaskRow.planMode 类型字段、create 写入、update 分支、toTaskDto 的 `planMode` + `effectivePlanMode`；随后 `getOpencodeAgentDuty` import 在本文件零消费方 → 一并删除（`plan-docs.service.ts:225` 仍在用，模块保留）。
  - `platform-mcp.tools.ts`：planModeSchema / PlanModeArgs / `plan_mode` 注册（工具 29→28）。
  - `platform-mcp.service.ts`：`planMode()` 方法与返回接口字段；`resolveTeamMainMemberId`（唯一调用方即 planMode，整段删除）；3 处 stale 注释（task_transition start 门、findTaskTeamGate 复用说明）。`PlanLifecycleService` 注入保留（autoEnsureRow/completePlan 仍在用）。
  - `agent.constants.ts`：VTEAM_MCP_TOOL_NAMES + vteam-product / vteam-project_manager 两个 toolAllows 的 `vteam_plan_mode`；`worker-dispatcher.ts:665` 团队直聊任务上下文工具串同步去除。
  - `common/opencode-agent-duty.ts` 两处「走显式 task.planMode 开关」注释改为「是否计划由所绑定 agent 自身 prompt 表达」。
  - `seed.ts`（brief 只核了 camelCase —— 实际有 4 处 snake_case）：VTEAM_MCP_TOOL_NAMES 拷贝、2 个角色矩阵、tools 注册行 `plan_mode` 全删。
- **迁移 scratch-DB 实证**（未碰 live DB；宿主 3306 未映射，改走容器内 prisma CLI）：
  - `docker exec aiagents-compose-db mysql -uroot -paiagents-root -e "CREATE DATABASE vteam_mig_probe CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`
  - `docker cp server/prisma/migrations/20260921000001_drop_task_plan_mode aiagents-compose-server:/app/prisma/migrations/`（server 镜像已含截至 20260921000000 的迁移，只缺这一条）
  - `docker exec -e DATABASE_URL='mysql://root:aiagents-root@db:3306/vteam_mig_probe' -w /app aiagents-compose-server npx prisma migrate deploy` → **All migrations successfully applied（66 条）**
  - 断言：`information_schema` 中 tasks.plan_mode 列计数 = 0；`_prisma_migrations` 中 `20260912000000_add_task_plan_mode` 与 `20260921000001_drop_task_plan_mode` 均 finished=1；随后 `DROP DATABASE vteam_mig_probe` + 删除容器内拷贝（容器恢复原状）。
- **冻结基线级联（本次最大的连带面）**：删 MCP 工具会改变 layer① permission 载荷（每个角色少一个 `vteam_*: deny` 键），6 个 execution-policies spec 立刻红，必须同步：
  - `.omo/evidence/opencode-native-permissions-and-fixes/baseline-agent-policies.json` 删 5 个 deny 键（plan/architect/developer/tester/librarian），sha256 `e795b0c8…` → **`22aaf9e1…`**；
  - `scripts/e2e-role-boundaries.sh` 与 `scripts/e2e-native-edit-enforcement.sh` 的 `FROZEN_BASELINE_SHA256` 默认值同步更新；
  - `agent-policies.native-only-payload.spec.ts` 的「guard.permission 与历史基线逐字节一致」放宽为「仅允许历史侧独有的 `vteam_*` 键缺席；其余键同值且当前侧不得新增」（历史基线本体未动）；
  - `agent-policies.custom-agents.spec.ts.snap` 由 `jest -u` 重生成。
  - 历史基线 `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` **绝对未动**（matrix spec 的 sha `3b8c5d4b…` 断言仍绿）。
- **e2e 脚本连带修复**（否则再跑必挂）：`prove-authority-matrix.sh` 删 3c plan_mode 步并同步合并清单/requiredSteps（后续步号 3d→3c、3e→3d）；`e2e-permission-matrix.sh` 去掉 `SELECT … plan_mode` 列读取。保留 `absence-nonmain-plan_mode.json` 证据文件名——历史 evidence 文本引用该名，改名破坏可追溯性。
- **命令与结果（均 workdir=server）**：
  - `npx prisma validate` + `npx prisma generate` → 绿
  - `npx tsc --noEmit -p tsconfig.json` → exit 0
  - `npx jest --runInBand` → 145 suites：142 passed / **3 failed（5 tests）**，与 HEAD 基线逐一相同（notify_agent 团队维度、review-dispatch 三元组、task.constants 五态×3）→ **零新增失败**
  - `npx jest --runInBand src/execution-policies` → 14 suites / 210 tests 全绿（基线级联后）
  - 残留 grep：`server/src` 仅 `plan-removal.guard.spec.ts` benign 清单；`server/prisma` 仅历史迁移（add 20260912 / backfill 20260919）+ 本次 drop 迁移文件本身。
- **坑**：
  - 首轮 grep `server/src server/prisma` + `head -100` 截断漏掉了 `server/prisma/seed.ts` 的 snake_case 命中；零命中核验必须分开跑 `server/src` / `server/prisma` 且不得被 head 截断。
  - Edit 工具对 ~130 行重复 spec 块报 JSON parse error（长 payload/反引号），且一次构造失误把块重复了一遍；恢复用 python3 按行号精确删区间 + sed 复核，比多次切割 edit 更稳。
  - zsh 下 `echo ===` 触发 `= not found` 展开错误，改用 `echo '---'`。
  - 「冻结基线 = 工具注册表投影」是硬约束：MCP 工具增删必须连带 baseline JSON + 两个脚本 sha 默认值 + 快照一起改，否则 execution-policies 6 套件必红。

## [2026-09-21] 清理 `vteam_plan_mode` 持久化残留 — 数据清理迁移 `20260921000002_prune_plan_mode_registry`

- **文件**：`server/prisma/migrations/20260921000002_prune_plan_mode_registry/migration.sql`（中文注释，单向不可逆，明示活计划域 plans/PlanTask/PlanLifecycleService/plan-docs/评审轮次/`vteam_plan_complete` 不受影响）。
- **实测发现两条残留路径**（live `aiagents` 8 行策略中 7 行命中；顶层 section 仅 `tools`/`correction`/`permission`，`correction` 无该键）：
  - `$.tools.vteam_plan_mode = "allow"` → `ep_product` / `ep_project_manager`
  - `$.permission.vteam_plan_mode = "deny"` → `ep_architect` / `ep_developer` / `ep_librarian` / `ep_plan` / `ep_tester`
- **三句 SQL**：`DELETE FROM tools WHERE name='vteam_plan_mode';` + 两条独立 `UPDATE ... SET config=JSON_REMOVE(config,path) WHERE JSON_CONTAINS_PATH(config,'one',path)`（守卫必不可少：`JSON_REMOVE` 路径缺失时返回 NULL 会把整列清空）。
- **证明（scratch DB `vteam_probe_prune`，live `aiagents` 全程未触碰）**：
  1. `npx prisma migrate deploy`（含新迁移，空表 no-op）+ `node dist/prisma/seed.js` → 7 策略行、0 残留。
  2. 合成残留：`INSERT INTO tools(id,name,action,source,execution,enabled,updated_at) VALUES('tl_probe','vteam_plan_mode','x','mcp','sync',1,NOW(3))`；`JSON_SET` 给 `ep_product` 加 `$.tools.vteam_plan_mode`、给 `ep_project_manager` 加 `$.permission.vteam_plan_mode` → 三项断言各为 1。
  3. `docker exec -i aiagents-compose-db mysql -uroot -paiagents-root vteam_probe_prune < <migration.sql>`（执行真实迁移文件）。
  4. 断言结果：tools 命中 **0**；`$.tools` 路径 **0**；`$.permission` 路径 **0**；`config IS NULL` **0**；策略行数 **7**；`ep_product` 仍保有 `$.tools.vteam_doclib` + `$.permission.vteam_plan_complete`（活计划域未动）。
  5. **守卫/可重入**：第二次执行同一文件 → `config IS NULL` 仍 0、行数仍 7（5 个无键行从未被清空）。
- **清理**：`DROP DATABASE vteam_probe_prune`；`rm -rf` 容器内 `/app/prisma/migrations/20260921000002_prune_plan_mode_registry`（已确认容器仅剩 `...000001` + lock）。
- **门禁**：`npx prisma validate` → exit 0；`npx tsc --noEmit -p tsconfig.json` → exit 0；`grep vteam_plan_mode server/src` 零命中。
- **坑**：`JSON_SEARCH(config,'all','vteam_plan_mode')` 全行返回 NULL——它搜的是 **值** 不是 **键**；发现路径必须用 `JSON_CONTAINS_PATH`（按候选 section 逐条探测），不能靠 `JSON_SEARCH`。

## [2026-09-21] DESIGN (READ-ONLY, nothing edited) — bind server-side tool authority to AgentRole (option 甲)

Scope: reconnaissance + decision-complete design. No source/schema/spec/web file edited; only this notepad appended. HEAD at start = `560e5ea`.

### Verdict
Move the **server-side `vteam_*` tool gate** to resolve through the member's **role** (`AgentRole.policyId`). Keep the **worker-injected opencode agent payload** (`buildAgentPolicies()`, consumer 2) keyed by the **opencode agent name** (`vteam-<agentKey>`). Do **not** merge the two consumers; do **not** drop `Agent.policyId` (it still feeds the injector + layer-① native permission + template resolution). For the 7 builtins, `AgentRole.policyId` and `Agent.policyId` are the **same row** (`ep_<role>`), so the split is a second pointer, not a table fork.

### Today's authority (state this in the PR)
- Gate (`platform-tool-permission.service.ts:41-93`): `TeamMember.agent.policyId` (primary) → `resolveByAgent` (`execution-policy.service.ts:691-701`) → `policyKeyOf` (`:984-990`) → `execution_policies` row → `resolved.tools['vteam_<bare>']` must be allow/ask.
- `myProfile` (`platform-mcp.service.ts:3693-3804`): same key (`agent.policyId`/`agent.agentKey`, select at `:3744-3745`).
- Dispatcher `resolveBoundaryAndTools` (`worker-dispatcher.ts:3683-3717`, called `:2141`): same key (`agent.policyId`/`agentKey`, from `AgentIdentityInfo` assembled `:2069-2079`).
- Fallback in all three: `agent.agentKey` → `vteam-<agentKey>` → `ROLE_BOUNDARIES[*]` constant.

### Target authority
- Gate: `TeamMember.role.policyId`; fallback `role.key` → `vteam-<role.key>` → `ROLE_BOUNDARIES[*]`; role absent/policy unresolvable → 403 `PLATFORM_MCP_TOOL_NOT_PERMITTED` (keep fail-closed).
- Implementation shortcut: add `ExecutionPolicyService.resolveByRole({policyId, roleKey})` that reuses the existing `resolveAgentWithFallback`/`policyKeyOf`/`constantRoleNameOf` machinery fed `roleKey` instead of `agentKey` (for builtins `role.key === agentKey`, so behaviour is identical).
- Dispatcher + `myProfile` should switch to the role key too (consistency): boundary/correction + `resolvedTools` follow the *post*.

### Consumer split recommendation
Same `execution_policies` table, two bindings: role-owned (`AgentRole.policyId`) = tool authority for the gate; agent-owned (`Agent.policyId`) = engine-native layer-① permission + injector payload + template deep-copy. `buildAgentPolicies()` (`:812-906`) is already agent-keyed and reads builtin rows by convention `ep_<role>` (independent of `Agent.policyId`) and custom rows via `Agent.policyId` (`:846-878`); leave it untouched.

### Live data (aiagents, read-only)
- `team_members`: 8 rows, **0 with `role_id IS NULL`**, 0 with `agent_id IS NULL`. All 8 bind builtin roles (`ar_<key>`) + template agents (`a_<key>`).
- `agents`: 7 template rows, every `policy_id = ep_<agent_key>`.
- `execution_policies`: 8 rows = 7 `ep_<key>` template + `ep_0000000001` ("Sisyphus 超", custom, **bound to 0 agents**).
- `agent_roles`: 7 builtin (`default_agent_id = a_<key>`), 3 custom external `sisyphus`/`prometheus`/`atlas` (`default_agent_id NULL`, `default_opencode_agent_name` set), 1 `ar_general` (both NULL).
- Consequence: backfill `AgentRole.policyId = (defaultAgentId).policy_id` is **behaviour-preserving** for all live members.

### Edge cases (recommendations)
(a) `roleId NULL` member → **403 fail-closed** (live: 0 rows).
(b) role `policyId` NULL → builtin fallback to constant; custom/external → null → 403.
(c) role binds internal agent with a different policy → gate uses **role** policy; that is the point. Injector still uses the agent's policy for layer-① (no conflict: layer-① never carries `vteam_*`; `projectNativePermission` `:150-160`).
(d) pre-migration members → unchanged (backfill == current authority).
External roles + `ar_general`: no internal default agent to inherit from → leave `policyId NULL` (fail-closed), require explicit admin binding in the roles UI if platform-tool access is wanted.

### Executor picker (point 7)
This change **alone does not** remove the picker: `team_members.agent_id` is NOT NULL (`schema.prisma:163`; relation required `:179`; unique `teamId,agentId,seq` `:187`), so every member still needs an internal Agent row, and `execute({agentId})` (`worker-dispatcher.ts:2205`) plus `defaultAlias` (`teams.service.ts:1467-1473`) and `defaultWorkDir` (`:1475-1483`) read it. Minimal fix later: give external-only roles a fixed platform-owned placeholder `defaultAgentId` (type `system`, `agentKey NULL`, `policyId NULL` so `buildAgentPolicies:846` ignores it) and relax the external-only guards (`teams.service.ts:1416-1421`; web `TeamMembersPanel.tsx:843`, `teams/new/page.tsx:144`, `teams/[id]/page.tsx:485`); dispatch must then derive prompt from `role.rolePrompt` (`worker-dispatcher.ts:2160`) because `Agent.prompt` (`:2075`) would be generic.

### Contract conflict
`server/src/platform-mcp/CONTRACT-tool-naming-and-identity.md` §2 (`:83-89`, `:94-100`) and §4 (`:134`) pin the matrix to `Agent.policyId`/`agentKey` and state `TeamMember.roleId` carries only prompt/label. That is **reversed** by option 甲 and must be rewritten (chain, per-tool table rows, fail-closed row, and the "all 7 live members carry a non-null role_id" justification at `:158`).

### Migration
New `server/prisma/migrations/20260921000003_add_agent_role_policy_id/migration.sql`:
`ALTER TABLE agent_roles ADD COLUMN policy_id VARCHAR(191) NULL;` + index + deterministic backfill `UPDATE agent_roles r JOIN agents a ON a.id = r.default_agent_id SET r.policy_id = a.policy_id WHERE r.policy_id IS NULL AND a.policy_id IS NOT NULL;` (optionally a second join on `a.agent_key = r.key` for robustness). `Agent.policyId` stays (deprecated as gate authority, not dropped).

### Sequencing / tests
Land column+backfill first, then `resolveByRole`, then the gate, then CRUD/web/seed, then docs. `AgentRole.policyId` backfill == current `agent.policyId` for live data ⇒ gate switch is a no-op live; builtin constant fallback covers unbackfilled roles.
Specs to retarget: `platform-mcp.tool-permission.spec.ts` (memberRow + all allow/deny assertions), `platform-mcp.authority-matrix.spec.ts` (`:88-110`, `:286-400`), `agents.service.spec.ts` (effectivePermission/policyId), `agents.controller.spec.ts:345`, `agent-roles.*.spec.ts`, `seed.spec.ts:1029`, new migration spec; scripts `check-agent-role-consumers.sh` + `scripts/agent-role-consumer-manifest.txt`, `scripts/e2e-permission-matrix.sh` (`:5,:187-203`).
Commands: `cd server && npx prisma validate && npx prisma generate && npx tsc --noEmit -p tsconfig.json` (green); `npx jest --runInBand` (known HEAD baseline 3 suites / 5 tests red: `task.constants.spec.ts` ×3 blocked/block/resume, `platform-mcp.service.spec.ts` ×1 notify_agent team-dimension, `platform-mcp.service.review-dispatch.spec.ts` ×1 triplet); `npx jest --runInBand src/platform-mcp src/execution-policies src/agents src/agent-roles src/prisma src/teams` (must be green after retarget).

## [2026-09-21] SLICE 1 LANDED — server-side `vteam_*` tool authority bound to `AgentRole` (role-owned authority)

**Status: implemented + verified (working tree, not committed).** HEAD start `560e5ea`.

### What changed (files)
- `prisma/schema.prisma`：`model AgentRole` 新增 `policyId String? @map("policy_id")`（置于 `defaultOpencodeAgentName` 之后）+ `@@index([policyId], map:"idx_agent_roles_policy")`；模型头注释由「无任何能力字段」改为「无能力**载荷**字段；经 policyId **引用** ExecutionPolicy（绑定，非载荷）」。
- `prisma/migrations/20260921000003_add_agent_role_policy_id/migration.sql`（新，加法 expand）：`ALTER TABLE agent_roles ADD COLUMN policy_id` + index；幂等 INSERT `ep_external`（NOT EXISTS 守卫）；**先**按 `key IN ('sisyphus','prometheus','atlas')` 绑 `ep_external`（NULL 守卫，避免被通用 JOIN 抢占）；再两条回填 UPDATE（`default_agent_id→agents.policy_id` 与 `agents.agent_key=r.key`，均 `policy_id IS NULL` 守卫）。`Agent.policy_id` 不删。
- `src/execution-policies/execution-policy.service.ts`：新增 `RolePolicyInput` + `resolveByRole({policyId, roleKey})`（复用 `policyKeyOf`/`resolveAgentWithFallback`/`constantRoleNameOf`；实现上映射为 `{policyId, agentKey: roleKey}` 喂同一私有解析链）。
- `src/platform-mcp/platform-tool-permission.service.ts`：`assertToolAllowed` select 由 `agent` 改 `role:{id,key,policyId}`，改调 `resolveByRole`；`roleId`/`role` 缺失或 `resolved===null` 一律 403 `PLATFORM_MCP_TOOL_NOT_PERMITTED`（fail-closed 语义逐字保留）；类注释改述岗位权威。
- `src/agent-roles/agent-roles.service.ts` + `dto/create|update-agent-role.dto.ts`：`AgentRoleRow`/create/update/toAgentRoleDto 增 `policyId`（可选）；新增 `assertPolicyExists`（400 `AGENT_ROLE_POLICY_NOT_FOUND`，镜像 `assertAgentExists`）与 `normalizePolicyId`；update 传 `null`/空串 → 解除绑定。
- `src/common/constants/agent-role.constants.ts`：`BuiltinAgentRole.policyId`（7 项 `ep_<key>`）；`AGENT_ROLE_ERRORS.AGENT_ROLE_POLICY_NOT_FOUND`；外部常量 `EXTERNAL_AGENT_ROLE_POLICY_ID='ep_external'` / `EXTERNAL_AGENT_ROLE_KEYS`（sisyphus/prometheus/atlas）/ `EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST`（恰 8 个）。
- `prisma/seed.ts`：镜像 `BUILTIN_AGENT_ROLES` 增 `policyId`；agentRole create 写 policyId + `updateMany(where policyId:null)` 补齐；新增 `ep_external` upsert（type=template、permission/correction 对象、tools=8 allow）+ 外部岗位 `updateMany(where key in ..., policyId:null)` 绑定。
- 规格：`platform-mcp.tool-permission.spec.ts`（memberRow→role；新增 precedence/roleId NULL/内置常量回退/自定义 NULL 四例）、`platform-mcp.authority-matrix.spec.ts`（stub 改 role）、`agent-roles.service.spec.ts`（+policyId 用例）、`agent-roles.controller.spec.ts`（+DTO 例）、`seed.spec.ts`（策略计数 7→8、过滤 ep_external、内置 policyId 补丁、ep_external/外部绑定断言）、新增 `src/prisma/agent-role-policy.migration.spec.ts`。
- `src/platform-mcp/CONTRACT-tool-naming-and-identity.md`：§2 解析链改 `TeamMember.roleId → AgentRole.policyId/role.key`（`resolveByRole`），§4 fail-closed 表新增 `roleId IS NULL→403` 行并改 `resolveByRole` 行，删除「矩阵来自 Agent、禁止走 roleId」段落，替换为「权威是岗位不是执行者」+ rationale；justification 段末句改岗位口径。

### 行为保持（存量）
7 内置角色：migration 回填 `policy_id = default_agent_id.policy_id = ep_<key>`，与旧门禁读取的成员 Agent 策略**同一行** ⇒ 存量成员门禁结果**不变**（live 8 成员全绑内置角色）。`Agent.policyId` 未删，`buildAgentPolicies`/`resolveByAgent`/dispatcher/myProfile/agents CRUD 未动。

### 有意行为变更
- 外部岗位（sisyphus/prometheus/atlas）由「按其执行 Agent 策略」收敛为 `ep_external` 最小权限（仅 8 个协作/取证/产出工具 allow；不得建任务/加成员/流转/建技能/确认提问/外发）。
- `ar_general`（无默认 Agent、无匹配 key）保持 `policy_id NULL` ⇒ 平台工具门 fail-closed 403。通用/自定义岗位须显式绑定策略才有平台工具权限。

### 命令与结果（均 `workdir=server`，另注明者除外）
- `npx prisma validate` → exit 0；`npx prisma generate` → exit 0。
- `npx tsc --noEmit -p tsconfig.json` → exit 0。
- `npx jest --runInBand src/platform-mcp src/execution-policies src/agent-roles src/prisma` → 33 passed / 2 failed suites（**恰为已知基线**：`platform-mcp.service.spec.ts` notify_agent 团队维度、`platform-mcp.service.review-dispatch.spec.ts` 三元组）。
- `npx jest --runInBand`（全量）→ **146 suites：143 passed / 3 failed（5 tests）**，与 HEAD 基线逐一相同（task.constants ×3、platform-mcp.service ×1、review-dispatch ×1）⇒ **零新增失败**；新增迁移 spec 使 145→146 suites。

### 突变验证（precedence 测试确锁角色权威）
`cp` 备份 `platform-tool-permission.service.ts`（sha256 `a69e1f1e…`）→ 临时把 select 改回 `agent`、`resolveByRole` 改回 `resolveByAgent`（并把两处 `role.key` 临时改 `role.agentKey` 以过编译）→ `npx jest … -t "角色策略胜过执行 Agent 策略"` → **1 failed**（收到 `ep_agent_deny` 的 deny，证明旧实现读 Agent）→ `cp` 还原，sha256 一致，同测复跑 **1 passed**。该用例构造成员同时挂 `role.policyId='ep_role_ok'(allow)` 与 `agent.policyId='ep_agent_deny'(deny)`。

### Scratch-DB 迁移实证（live `aiagents` 全程未触碰；收尾已核对 11 roles / 8 members / 8 policies / 无 policy_id 列）
**A. fresh-install（宿主临时 MySQL，全新代码）**：`docker run --rm -d --name vteam-probe-mysql -p 13306:3306 -e MYSQL_ROOT_PASSWORD=probe -e MYSQL_DATABASE=vteam_probe_fresh mysql:8` → 宿主 `DATABASE_URL=mysql://root:probe@127.0.0.1:13306/vteam_probe_fresh npx prisma migrate deploy`（All migrations applied）→ `node dist/prisma/seed.js`（`npx nest build` 产出的**新** seed，exit 0）。断言：
  - `agent_roles`：7 builtin 全部 `policy_id=ep_<key>`；`ar_general`（migration 000007 建）`policy_id NULL`。
  - `ep_external`：`JSON_LENGTH(config->'$.tools')=8`；逐键 `vteam_group_post/chat_history/doclib/submit_artifact/notify_agent/task_context/my_profile/team_view = allow`；治理键 `JSON_CONTAINS_PATH(...,'one','$.tools.vteam_task_create',...add_member,...question_confirm,...skill_create)=0`。
  - 再插入 3 外部岗位 → 重跑新 seed（exit 0）→ 3 行 `policy_id=ep_external`；`COUNT(*) ep_external=1`、`total_policies=8`、`builtins_bound=7`（证明 seed 绑定 + 幂等无重复）。清理：`docker stop vteam-probe-mysql`。
**B. upgrade（compose scratch DB + 容器，存量库路径，验 migration 自身回填/绑定）**：`CREATE DATABASE vteam_probe_upgrade` → 容器 `npx prisma migrate deploy`（镜像仅含至 000001）→ 容器**旧** `node dist/prisma/seed.js`（7 builtins）→ 插入 3 外部岗位（pre-migration 无 policy_id 列）→ `docker cp` 000002+000003 进容器 → `npx prisma migrate deploy`（applied）。断言：
  - 7 builtins `policy_id` 全非空，`builtins_mismatch = COUNT(type='builtin' AND policy_id <> CONCAT('ep_',key)) = 0`。
  - 3 外部岗位 `policy_id=ep_external`（`external_bound=3`）；`ar_general` 仍 NULL；`ep_external_tool_count=8`；`policies_total=8`。
  - **幂等**：`awk '/^-- 3\)/{p=1} p' migration.sql` 抽出三条 UPDATE，在已迁移库上重跑 → 三条均 `Rows matched: 0  Changed: 0`。
  - 清理：`DROP DATABASE vteam_probe_upgrade`；`rm -rf` 容器内 000002/000003 拷贝（容器恢复仅至 000001）；`rm /tmp/*` 临时件。

### 未验证 / 边界
- 未在容器内运行**新** seed（runner 镜像无源码、`node_modules/.prisma/client` 为旧 schema 生成，直接跑会因 `policyId` 未知参数失败）；新 seed 由 `seed.spec.ts`（全绿）断言其 upsert 载荷/绑定，并在 A 中由宿主新 seed 端到端跑通。真实 init 容器（`migrate deploy && node dist/prisma/seed.js`）在下次 `docker compose build` 后才会带新代码。
- 未改 web（并行 worker）、未改 dispatcher/myProfile（SLICE 3）。
- 运行 authority-matrix spec 会重写 `.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json`（消息文案 `Agent（…）`→`角色（…）`）；本次已 `git checkout` 还原证据文件，保持 diff 只含本 slice。

## [2026-09-21] SLICE 4 LANDED — 外部绑定岗位不再要求「再选一个内部执行 Agent」（端到端移除）

**Status: implemented + verified live（工作树未提交）。** 用户诉求原文：「外部绑定岗位：实例需再选一个内部执行 Agent…选择 agent 为外部时展示出来」→ 现在只选一个岗位即可。

### 系统占位 Agent 设计（以及为何**不用** `defaultAgentId`）
- 新增平台占位 Agent：`id='a_external'`、`name='外部执行'`、`type='system'`、`agentKey=NULL`、`policyId=NULL`。`TeamMember.agentId` 是 NOT NULL FK，外部绑定成员必须有落点；该行只记账（别名/工作目录/`execute({agentId})` 的 FK 目标），**不承载能力**。
- **未写 `AgentRole.defaultAgentId`**（brief 的 option 1 给了「安全则设，否则 resolve 时自动填」的裁量）。实测**不安全**：
  1. `AgentRolesTab.describeDefaultSlot`（web，SLICE 2 域）以 `defaultAgentId` 非空判「内部绑定」→ 写了会让外部岗在 UI 被谎报为内部（违背 `roles-members.spec.ts:360` 的诚实性约束）；
  2. `defaultAgentId` 与 `defaultOpencodeAgentName` 是声明互斥的单槽位（`AGENT_ROLE_DEFAULT_SLOT_CONFLICT`）→ 同时非空是非法态。
  ⇒ 采用 brief 明示的替代路径：`resolveMemberBinding`/`resolveTaskMemberBinding` 在「已给 `roleId` + `defaultAgentId` 空 + `defaultOpencodeAgentName` 非空」时返回 `agentId='a_external'`；两槽位皆空的角色（`ar_general`）**保持** 400 `ROLE_DEFAULT_AGENT_MISSING`（未另起错误码——该码语义仍准确）。
- 常量单一来源 `src/common/constants/agent-role.constants.ts` 的 `EXTERNAL_SYSTEM_AGENT_ID`/`EXTERNAL_SYSTEM_AGENT_NAME`；`prisma/seed.ts` 自包含镜像（文件头约定）。

### 文件变更
- **新增** `prisma/migrations/20260921000004_add_external_system_agent/migration.sql`：幂等 `INSERT ... SELECT ... FROM (SELECT id FROM users ORDER BY (username='admin') DESC, created_at ASC LIMIT 1) u WHERE NOT EXISTS(...)`。**关键陷阱**：`agents.created_by` NOT NULL FK → 全新库 `migrate deploy` 先于 seed、`users` 尚空，选择子查询无行 → 不插入（否则 FK 失败）；存量库有用户 → 落行，seed 的 upsert 对之为 no-op。中文注释对齐相邻迁移。
- `prisma/seed.ts`：镜像常量 + `agent.upsert`（create-if-absent，`createdBy=adminUser.id`），置于 7 模板 Agent loop 之后。
- `teams.service.ts`/`tasks.service.ts`：`resolveMemberBinding`/`resolveTaskMemberBinding` 外部分支落 `a_external`；`defaultWorkDir`/`defaultAgentWorkDir` 增 `(role, externalBound)` 形参，外部绑定时 base 取 `role.name`（否则沿用 `agent.name`，存量逐字节不变）。
- `agents.service.ts`：`findAll` 缺省 `where` 由 `{type: undefined}` 改 `{type:{not:'system'}}`——否则占位行会污染 Agent 管理页与 `AgentRolesTab` 的内部 Agent 下拉（`QueryAgentsDto.type` 枚举仍只 template/custom）。
- **web（3 文件）**：`teams/new/page.tsx` 删 `instance-executor-select`/`role-external-hint`/`executorOptions`/`agentsQuery`/payload `executor` 展开/校验 + `InstanceDraft.agentId`；`teams/[id]/page.tsx` 删 `add-member-external-hint`/`add-member-agent-select`/`selectedIsExternalOnly`/`agentTouched`/`selectedAgentId`/payload agentId/校验；`TeamMembersPanel.tsx` 删 `canConfirm` 的外部守卫与 `add-instance-external-hint`（保留通用「显式覆盖 Agent」下拉——那是既有能力，非外部专用）。
- **spec 重定向**：`web/e2e/team-create-role-list.spec.ts` (c) 改为「卡片内零 `<select>` → roleId-only 建团成功 → 回读 `agentId='a_external'`/`opencodeAgentName=岗位外部名`」；`web/e2e/role-first-member-add.spec.ts` (a+b) 同理（详情页无槽位 → role-only → 占位 Agent）。为满足 DoD「`instance-executor-select` 在 web/ 零命中」，(c) 用 `card.locator("select")` 结构断言而非 testid；`add-member-agent-select` 的负断言保留（DoD 未点名该 testid）。server 侧：teams/tasks spec 外部用例由「抛 ROLE_DEFAULT_AGENT_MISSING」改为「落 `a_external`」并新增「两槽位皆空仍 400」用例；seed.spec 的 `templateAgentCalls()`/两个 `.startsWith('a_')` 过滤因 `a_external` 也以 `a_` 开头而改为按 `create.type==='template'` 过滤（否则 7→8 断言全红），并新增占位行 upsert 断言。

### 命令与结果
- `npx prisma validate` / `npx prisma generate` / `npx tsc --noEmit -p tsconfig.json`（workdir=server）→ 全 exit 0。
- `npx jest --runInBand src/teams src/tasks src/agents src/prisma` → 22 suites / 636 tests 全绿。
- `npx jest --runInBand`（全量）→ **146 suites：143 passed / 3 failed（5 tests）**，与 HEAD 基线**逐一相同**（task.constants ×3、platform-mcp.service notify_agent ×1、review-dispatch 三元组 ×1）⇒ 零新增失败。
- `cd web && npx tsc --noEmit` → exit 0。
- grep：`需再选一个内部执行 Agent` / `instance-executor-select` / `role-external-hint` / `ROLE_DEFAULT_AGENT_MISSING` 在 `web/`（含 e2e）**零命中**；`外部绑定` 仅剩 4 处注释/角色展示文案（`AgentRolesTab` 的「（外部）」显示属 SLICE 2，保留）。

### live 实证（compose，未用 `--force-recreate`）
- **迁移应用方式**（重要）：live DB 当时**只到 `20260921000002`**（slice 1 的 000003 尚未上 live，与 brief 的 context 描述不符）→ 新 server 代码读 `role.policy_id` 会直接炸。故先 `docker compose build server`，再一次性应用迁移：
  `docker compose run --rm --no-deps --entrypoint sh server -c "npx prisma migrate deploy"` → 应用 000003 + 000004（`All migrations successfully applied`）。**未跑 seed**（迁移 000004 已建 `a_external`，users 非空），避免重跑 seed。
  断言：`agents.a_external` = system / agent_key NULL / policy_id NULL / created_by=`u_admin`；3 外部岗 `policy_id=ep_external`、`default_agent_id` 仍 NULL；`ar_general` policy_id NULL；`ep_external` 1 行。
- `docker compose build web` → `docker compose up -d --no-deps server web`（会 recreate 容器属正常）→ server/web healthy。
- `GET /agent-policies` 200（`a_external` 不出现）；`GET /agents` 仅 7 模板、零 `a_external`（列出 `a_architect…a_tester`）。
- **Playwright 对 http://localhost:13001（admin/admin123）**：临时 config（`testDir ./e2e`、`channel=chrome`、list reporter；跑完已删）：
  - `web/e2e/team-create-role-list.spec.ts` → 2 passed；(c) 断言：外部岗卡片 `select` 数 0、POST body `members[0].roleId=外部岗.id` 且 `"agentId" in members[0]===false`、回读 `agentId==='a_external'`、`opencodeAgentName===defaultOpencodeAgentName`、`alias.startsWith(role.name)`。
  - `web/e2e/role-first-member-add.spec.ts` → 3 passed；(a+b) 详情页外部岗无 `add-member-external-hint`/`add-member-agent-select`，role-only 提交，回读 `agentId==='a_external'`、`opencodeAgentName===外部名`；reload 行仍在。
  - **专用 Sisyphus 探针**（临时 spec，已删）：`/teams/new` 勾 `[data-role="sisyphus"]` 卡片 → 卡片零 `select` → 建团成功 → 详情页 `member-row` 恰 1 行、`member-alias-input` value=`Sisyphus-1` → API 回读 `alias==='Sisyphus-1'`、`agentId==='a_external'`、`opencodeAgentName==='Sisyphus - ultraworker'`、`workDir` 含 `Sisyphus`。
- 全部探针 team/role 在 finally DELETE（日志 `DELETE -> 200`）；收尾核对 live：`teams=2`（seed `tm_0000000001` + **既存** `tm_0000000002` probe-role-only，非本次产生）、`team_members=8`（与开始时同）、`agent_id='a_external'` 成员 **0**、`custom_roles=3`、`_prisma_migrations` 中 000003/000004 各 1。临时 config/spec/report/json 全删。

### 行为说明 / 未验证
- **外部成员同团队内的 seq 共享**：多外部岗位成员共享 `agentId=a_external`，`seq` 按 `(teamId, agentId)` 递增 ⇒ 同团队内 `Sisyphus-1`、`Atlas-2`（不再是各角色独立 -1）；`uk_team_members_team_agent_seq` 只约束 `(teamId,agentId,seq)`，故必须如此且无别名冲突。单外部岗位团队不受影响（`Sisyphus-1`）。
- `defaultWorkDir` 仅对 `opencodeAgentName` 非空的成员改用 `role.name`：若用户经 API 给**内部**岗位成员显式传 `opencodeAgentName`，其 workdir 也会改用岗位名（同一判据，可接受；UI 路径不产生此组合）。
- 未验证：直接 `POST /agents/a_external/clone` 或 PATCH 该占位行（`assertWritable` 只拦 `type='template'`，故技术上可 clone/改名）——非本次要求，未加门；如需可后续把 `type='system'` 纳入只读保护。`a_external` 的 `created_by` 在存量库为「优先 admin 的任一用户」，全新库为 seed 的 admin。
- 未触碰：`web/src/components/agents/AgentRolesTab.tsx`、`web/src/api/agent-roles.ts`（SLICE 2）、`worker-dispatcher.ts`、`platform-mcp.service.ts` myProfile（SLICE 3）、`Agent.policyId`、slice 1 的 `platform-tool-permission.service.ts`/`resolveByRole`。schema 仅 000003/000004 已含，本次无新 schema 变更。
- **迁移幂等 + 全新库路径 scratch 实证**（scratch DB `vteam_probe_s4`，live `aiagents` 未触碰，收尾已 DROP）：
  1. 把 000004 的原始 SQL 在 live（a_external 已存在）重跑 → `a_external_rows=1`（NOT EXISTS 守卫，零重复）。
  2. 全新库：`CREATE DATABASE vteam_probe_s4` → 容器内 `npx prisma migrate deploy && node dist/prisma/seed.js`（`docker compose run --rm --no-deps -e DATABASE_URL=...@db:3306/vteam_probe_s4 --entrypoint sh server`）→ migrate 侧因 `users` 空而**跳过** 000004 的 INSERT（未触发 `created_by` FK），seed 侧落 `a_external`：断言 `a_external=1 / type=system / agent_key NULL / policy_id NULL / created_by=u_admin`；`ar_general.policy_id IS NULL=1`；`members=7`（seed 示例团队）。外部 3 岗在全新库不存在（自定义行为用户创建），故 `ext_roles_bound=0` 属预期。

## [2026-09-21] SLICE 3 LANDED — 剩余两个执行策略消费者（dispatcher / myProfile）收敛到岗位（role-owned）

**Status: implemented + verified live（工作树未提交）。** HEAD start `560e5ea`。改动仅 5 个文件：`server/src/chat/worker-dispatcher.ts`、`server/src/chat/worker-dispatcher.spec.ts`、`server/src/platform-mcp/platform-mcp.service.ts`、`server/src/platform-mcp/platform-mcp.service.spec.ts`、`server/scripts/t9-f3-check.ts`（外加 `execution-policy.service.ts` 一处过期注释）。`buildAgentPolicies()` / `GET /agent-policies` / slice 1 的门禁 / `Agent.policyId` 均未动。

### 解析表（before → after）

| 消费者 | before（读取） | after（读取） | 回退 |
|---|---|---|---|
| gate `assertToolAllowed`（slice 1，已落） | `member.agent.policyId/agentKey` | `role:{id,key,policyId}` → `resolveByRole` | 常量 `vteam-<role.key>`；role 缺失 → 403 fail-closed |
| dispatcher `resolveBoundaryAndTools` | `Agent.policyId`/`agentKey`（`AgentIdentityInfo`）→ `resolveByAgent` | `TeamMember.roleId → AgentRole.policyId/key` → `resolveByRole` | 常量 `vteam-<role.key ?? agent.agentKey>`；role 缺失 → 不查策略，直接常量（不阻断分派） |
| `myProfile.effectivePermission` | `agent.policyId`/`agentKey` → `resolveByAgent` | `role.policyId` + `role.key` → `resolveByRole` | `resolveByRole({null,null})` → null → `effectivePermission=null` |

- dispatcher：`teamMember.findMany` 的 role include 由 `{rolePrompt}` 扩为 `{id,key,policyId,rolePrompt}`，一次查询三用（角色提示词 + 岗位策略输入 + 常量键）；`AgentIdentityInfo.policyId` 已删（无消费方），agent 行 select 不再读 `policy_id`。`systemOpts.boundarySection` 与 `resolvedTools`（记忆/产出物段屏蔽）现随岗位。
- `myProfile`：`effectivePermission` 字段名保留（caller 兼容），语义注释改为「**岗位**的平台工具权威，与 `assertToolAllowed` 同源；执行 Agent 的原生层①由 worker injector 注入，不在本字段」。未新增 engine-native 字段（无消费方）。
- **仍读 Agent 策略的地方（有意保留）**：`buildAgentPolicies()`/`GET /agent-policies`（worker injector 原生层①，agent-keyed）、`agents.service.ts resolveManyByAgents`（GET /agents 的 Agent 自身视图）。`resolveByAgent`/`resolveManyByAgents` 本体保留服务于这两处。
- 岗位缺失（`roleId NULL`，live 0 命中）语义：dispatcher 不查策略、常量回退；myProfile 传 `{null,null}` 收 null；门禁 403（slice 1）。三处一致：无岗位=无平台工具权威。

### 命令与结果（workdir=server）
- `npx tsc --noEmit -p tsconfig.json` → exit 0（`scripts/t9-f3-check.ts` 里死掉的 `policyId: null` 同步删除，否则编译报 TS2353）。
- `npx jest --runInBand src/chat src/platform-mcp src/execution-policies` → 40 suites / 1141 tests：**2 suites / 2 tests 红**，恰为已知基线（notify_agent 团队维度、review-dispatch 三元组）。
- `npx jest --runInBand`（全量）→ **146 suites：143 passed / 5 failed tests（3 suites）**，与 HEAD 基线逐一相同（task.constants ×3、platform-mcp.service ×1、review-dispatch ×1）⇒ 零新增失败。
- 新增/重定向用例：dispatcher 4 个 policyService 用例改 `resolveByRole` + 3 新用例（**岗位>执行者 precedence**、`resolveByRole` reject 不阻断分派、未绑岗位不读 Agent 策略）；myProfile 4 个用例重定向（含自定义岗位）+ **岗位>执行者 precedence**，`resolveByAgent` 保留为 spy 断言 `not.toHaveBeenCalled()`。

### 突变验证（sha256 before == after-restore）
- `worker-dispatcher.ts`：`831ab61a621983cbaa1463a0718eb0b414b9687fbfed1d2912b126ebeec5c489`。临时把 role 解析改回 `resolveByAgent({policyId:null, agentKey})` → `jest -t "岗位决定"` **1 failed**；`cp` 还原 → sha 一致 → 同测 **1 passed**。
- `platform-mcp.service.ts`：`4bb8927b7f186cdecde18d0de896a828c30e7fd2603adbe84724efe564af2426`。临时改回 `resolveByAgent({null,null})` → `jest -t "岗位决定 effectivePermission"` **1 failed**；还原 → sha 一致 → **1 passed**。

### live 实证（compose；`docker compose build server` + `up -d --no-deps server web`，未用 `--force-recreate`；server healthy）
调用方式：`POST http://localhost:13000/api/v1/platform-mcp`，头 `x-worker-token: <容器 WORKER_TOKEN>` + `x-worker-id: w_compose_worker`，body JSON-RPC `tools/call`。**坑：工具名是裸名**（`my_profile`/`task_create`），策略矩阵里才带 `vteam_` 前缀——`vteam_my_profile` 会 `-32602 Unknown tool`。
- 基线（allow）：`my_profile {taskId:t_0000000001, selfInstanceId:tmm_0000000004(developer)}` → 200，`effectivePermission.policyId=ep_developer / policyName=开发者 / agentName=vteam-developer`。
- fail-closed：`task_create` → `-32003 [403] PLATFORM_MCP_TOOL_NOT_PERMITTED …角色（developer）…（策略 ep_developer）`（Agent 发起的平台调用授权路径正常且保持拒绝语义）。
- **Agent 策略换掉证明不读它**：`UPDATE agents SET policy_id='ep_product' WHERE id='a_developer'` → 同请求仍返回 `ep_developer`；还原。
- **岗位策略换掉证明读它**：`UPDATE agent_roles SET policy_id='ep_product' WHERE id='ar_developer'` → 同请求返回 `ep_product / 产品经理`；还原。
- 收尾核对：`my_profile` 回到 `ep_developer`；`tasks=2、team_members=8、agent_roles=11、builtin role policy mismatch=0、template agent policy mismatch=0、a_external policy_id IS NULL=1`（无探针残留；临时 UPDATE 全部还原）；`/tmp/slice3-mutation` 已删。

### 坑
- spec 里 `role: { key: 'developer', name: '开发者' }` 出现两次（team_view 夹具 + myProfile 夹具），edit 锚点不足时改错文件位置——重定向夹具必须核对行号/上下文唯一性。
- 全量 `npx jest` 会重写 `.omo/evidence/opencode-native-permissions-and-fixes/task-6-native-rule-editor.json` 等（native-edit spec 副作用）；同时并行 SLICE 2 的 web e2e 也在写 `agent-native-permission-editor/`、`agent-role-entity/` 证据文件——两类 diff 均非本 slice 产生，本次**未回滚**（避免踩掉并行 worker 输出），如实记录。
- `AgentIdentityInfo.policyId` 删除会打穿 `scripts/t9-f3-check.ts`（构造该接口的探针）——接口瘦身后要 grep 全仓（含 `server/scripts`）而非只 grep `src`。

### 未验证 / 边界
- **未做 live dispatch**：dispatcher 的边界段/屏蔽行为由单测 + 突变覆盖，未真实触发一次 worker 执行去看 `system` 提示词（成本/影响面考虑）。
- 未绑岗位（role null）与外部岗位（ep_external）的 dispatcher 路径均只有单测覆盖，live 8 成员全为内置岗位绑定。
- `myProfile` 的 engine-native 信息未暴露（无消费方）；如将来调用方需要执行 Agent 的原生层①权限，应另起字段并只读 `Agent.policyId`（`buildAgentPolicies` 同源）。

## [2026-09-21] SLICE 2 LANDED — 岗位平台工具权限在 Web UI 可绑定（角色 Tab）+ Agent 侧策略字段口径校正

**Status: implemented + verified live（工作树未提交）。** HEAD start `560e5ea`。仅 web 3 文件：`web/src/api/agent-roles.ts`、`web/src/components/agents/AgentRolesTab.tsx`、`web/app/(main)/agents/page.tsx`。

### 文件与改动
- `web/src/api/agent-roles.ts`：`AgentRoleDto.policyId: string | null`；Create/Update payload 增 `policyId?: string | null`；新增 `ExecutionPolicySummary`/`ExecutionPoliciesPage` + `executionPoliciesApi.list({page,pageSize})`（`GET /execution-policies`，与 Agent Tab `effectivePermission` 同表同源；全仓唯一 `["execution-policies", …]` query key）。
- `AgentRolesTab.tsx`：`RoleDraft.policyId`（`EMPTY_DRAFT`/`draftOf`）；policies query（pageSize 100）；新控件 `role-policy-select`（`data-bound="unbound"|"bound"`；空选项「未绑定（不可调用平台工具）」；`foreignPolicyId` 兜底显示清单外已绑定 id；`readOnly || isPending` 时禁用）；`role-policy-note`（未绑定→403 文案 / 列表加载失败文案）；save/clone payload 带 `policyId`（空串→null）；400 `AGENT_ROLE_POLICY_NOT_FOUND` 中文化；列表项新增 `role-item-policy`「平台工具权限：<名称>（id）」（清单未收录如实显示 id，绝不谎报「未绑定」）；底部文案由「能力…属于 Agent」改为「平台工具权限随岗位绑定；引擎原生权限/模型属 Agent」；头部注释同步（仍无 permission/tools 编辑器）。
- `agents/page.tsx`：④ 区标题「权限」→「引擎原生权限」；新增 `effective-permission-scope-note`；MCP 分组上方新增 `effective-mcp-scope-note`（调用授权以成员岗位绑定策略为准）；文件头注释同步。

### 命令与结果
- `cd web && npx tsc --noEmit` → exit 0。
- `eslint`（3 文件）→ 0 errors / 2 warnings（`deleting` unused、`roles` exhaustive-deps）；`git show HEAD:… | eslint --stdin` 证明两条 warning 在 HEAD 完全相同 ⇒ 零新增。
- 部署：`docker compose build web && docker compose up -d --no-deps web`（两次；第二次为清掉 JSX 文本里字面 `**` 的 cosmetic 修正，保证镜像 == 工作树）。

### Playwright 证明（:13001，admin/admin123；临时 spec + config 跑完已删；两次均 1 passed）
`web/e2e/zz-slice2-policy-proof.spec.ts` + `web/.slice2.playwright.config.ts`（testMatch 该 spec、baseURL 13001、chrome）：
1. 前置 `ar_general.policyId=NULL` → 角色 Tab → 通用：select value `""`、`data-bound=unbound`、列表行「平台工具权限：未绑定」、note 含 `vteam_* MCP`/`403`；
2. `selectOption("ep_external")` → `data-bound=bound` → 保存 → **API 轮询回读 `ep_external`**；
3. reload 后 select 仍 `ep_external`（非前端态）；截图 `/tmp/slice2-role-policy-final.png`；
4. **还原**：`selectOption("")` → 保存 → API 轮询 = `null` → reload UI unbound → 末尾再断言 `null`；
5. Agent 侧两条 scope note 含「岗位」「vteam_*」且**不含字面 `**`**。报告 `/tmp/slice2-proof-report-final.json`。
- live 收尾核对（mysql）：`ar_general NULL`、外部 3 岗仍 `ep_external`、roles=11、teams=2、members=8、policies=9 ⇒ 无探针残留。

### 既有 spec
- `scripts/e2e-create-agent-role.sh` → **4/4 green**（首跑假红：并行 SLICE 3 正在重建 server，`Up 58 seconds`；重跑即绿）。
- `scripts/e2e-task-permission-editable.sh`（task-permission-editable + native-rule-editor）→ **10/10 green** + seed policy 还原 receipt。
- 临时 config 跑 `role-first-member-add.spec.ts` + `team-create-role-list.spec.ts`（13001）→ **5/5 green**。
- `scripts/e2e-roles-members.sh` → **3 passed / 1 failed**：test 3「成员按岗位添加」在 `add-instance-agent-select` 期望 `a_developer`、实收 `""`。**HEAD 基线证明（与本 slice 无关）**：`git worktree add --detach /tmp/vteam-head 560e5ea` + `ln -s` node_modules + `next dev`（**不能带 `--turbopack`**：Turbopack panic「Symlink node_modules … points out of the filesystem root」）+ `API_PROXY_TARGET=http://localhost:13000` 于 :3001 跑同一 spec → **同样 1 failed（同断言、`Received ""`）**。根因：commit `3b92491 feat(web): role-first member add surfaces` 有意改为「仅显式覆盖才显示」（`value={agentTouched ? selectedAgentId : ""}` + `pickRole` 重置 `agentTouched=false`），而 spec:285 仍停在旧口径（blame：select value 行与 `pickRole` 属 `3b92491` 9/21 19:17；spec:285 属 `eabb5ce` 9/19，spec 最后改动 `1d34387` 9/20，均早于 3b92491）⇒ **HEAD 陈旧红**；该失败路径只加载 `TeamMembersPanel.tsx`（本 slice 未碰）。worktree 已 `remove --force`。

### 坑
- `scripts/e2e-*.sh` 失败分支 `|| fail "ui"` 在 dump playwright raw **之前** exit（PW_OUT 随 cleanup 删除）⇒ 失败时零线索；失败要直接自建 temp config 跑 spec。
- worktree 基线跑 web：Turbopack 不接受外指 node_modules 符号链接 → 用 webpack（`next dev` 不带 `--turbopack`）。
- JSX 文本里的 `**粗体**` 会**字面渲染星号**——中文 UI 文案别用 markdown 加粗（本 slice 曾写入后改纯文本，并加 `not.toContainText("**")` 断言之）。
- 并行 SLICE 3 会重建 server → 期间跑 e2e 假红；跑前先 `docker ps` 看 server `Up` 时长。
- e2e 脚本会重写 `.omo/evidence/{agent-native-permission-editor,agent-role-entity,opencode-native-permissions-and-fixes/task-6-*}`（`agent-role-entity/e2e.txt` 被 `: >` 截断）；收尾 `git checkout --` 还原为 HEAD，保持 diff 只含本 slice。`plan-review-execution-gates/task-9/probe.json` 与 `server-gate-removal-tool-authority/task-9-matrix.json` 会话开始时即 modified（并行 worker），未触碰。

### 未验证 / 未触碰
- 内置岗位在 UI **只读**（不可改 policyId；服务端 PATCH 允许，UI 维持 `isBuiltin` 只读约定）——如需放宽属后续产品决策。
- 未碰 `server/**`、`worker-dispatcher.ts`/`myProfile`（SLICE 3）、`web/app/(main)/teams/**`、`TeamMembersPanel.tsx`（SLICE 4）、`Agent.policyId`、slot 互斥语义；无 commit/push/branch。


## [2026-09-21] SLICE 6a LANDED — 岗位业务能力点（capabilities）+ default-allow + 通用 MCP/agent 层解耦（server）

**Status: implemented + verified（工作树未提交）。** HEAD start `560e5ea`。用户决策 Q1=(ii) 默认全放行 + 出厂敏感点预置拒绝；Q2=业务能力名；Q3=明确接受 `vteam-api`/`swagger-mcp` 绕过（防误调用，非安全边界，不加门）；Q4=二元 allow/deny；Q5=无岗位成员不支持（无兼容路径）；Q6=引擎原生 edit/read/bash/task 不动、保持 agent-keyed，本次目标是让 agent+MCP 成为与 vteam 权限**解耦的通用机制**。

### 能力目录（single source of truth）
`src/common/constants/platform-capability.constants.ts`：21 个有序能力点 `{ key, label, tools[], defaultDeny }`，覆盖 `VTEAM_MCP_TOOL_NAMES` 全 **28** 项（每工具恰属一个能力点）。出厂矩阵 = `defaultDeny?false:true`（10 敏感点拒绝：task.create/transition/complete、team.add_member、chat.channel_send、wecom.reply、issue.manage、skill.create、question.confirm、hook.manage）。
派生函数：`capabilityKeyForTool`（反查）、`buildCapabilityMatrixFromTools`（**全组工具放行才授予**，保守方向）、`capabilityMatrixToToolStates`、`buildFactoryCapabilityMatrix`、`isCapabilityGranted`。
新增 `platform-capability.coverage.spec.ts` 断言：键唯一/格式、28 工具一一覆盖（`[...owner.keys()].sort() == [...VTEAM_MCP_TOOL_NAMES].sort()`）、未知工具→null、default-allow 语义、全组/保守映射。

### 派生的内置能力矩阵（保守：能力点全组工具放行才 true；故部分放行组塌陷为 false）
- product: 18/21 true（否：task.complete, skill.create, git.repos）
- project_manager: 19/21（否：doc.submit, git.repos）
- architect: 12/21（否：task.create/transition/complete, team.add_member, **issue.manage**, skill.create, question.confirm, hook.manage, git.repos）
- developer: 13/21（否：task.create/transition/complete, team.add_member, skill.create, question.confirm, hook.manage, git.repos）
- tester: 12/21（否：task.create/transition/complete, team.add_member, **issue.manage**, skill.create, question.confirm, hook.manage, git.repos）
- plan: 10/21（否：task.create/transition, team.add_member, chat.channel_send, doc.submit, issue.manage, **memory.manage**, skill.create, question.confirm, hook.manage, git.repos）
- librarian: 8/21（否：task.create/transition/complete, team.add_member, chat.notify, chat.channel_send, wecom.reply, doc.submit, issue.manage, **memory.manage**, skill.create, question.confirm, hook.manage）
- external(sisyphus/prometheus/atlas): 8/21（= 原 ep_external 的 8 协作/取证/产出工具对应能力点；其余 13 显式 false）
- factory(ar_general 等): 11/21
**有意行为变更（保守塌陷，绝不新增授权）**：architect 失去 issue_create/get/list；tester 失去 issue_create/get/list/transition；plan/librarian 失去 memory_search（多工具能力点无法表达"部分放行"）。不做任何"放大"映射。

### 文件与改动
- **schema**：`AgentRole` 增 `capabilities Json? @map("capabilities")`，删 `policyId` 与其索引 `idx_agent_roles_policy`；模型头注释改述。
- **迁移 `20260921000006_agent_role_capabilities`**：① ADD COLUMN；② 临时表 `tmp_agent_role_tools` 物化 `policy_id→config.tools`（**避免 UPDATE 自引用 1093**；列 collation 必须 `utf8mb4_unicode_ci` 对齐 `agent_roles.id`，否则 `Illegal mix of collations`——实测踩坑）→ 套 21 能力 JSON_OBJECT（每值 `IF(... IN ('allow','ask'), CAST('true' AS JSON), CAST('false' AS JSON))`，规避 `JSON_OBJECT` 对 NULL 落 JSON null 的陷阱）；③ 7 内置 key 常量回退矩阵（无策略行时）；④ 外部 3 岗最小矩阵；⑤ 末条全表 `WHERE capabilities IS NULL` 写出厂矩阵（**兜底保证无 NULL**）；⑥ DROP INDEX + DROP COLUMN policy_id；⑦ `DELETE ep_external ... AND NOT EXISTS(SELECT 1 FROM agents WHERE policy_id='ep_external')`。**未清理** `execution_policies.config.tools` 的 vteam_* 键（仍服务引擎原生 GET /agents / agent-policies 视图；brief item 8 允许留下并报告）。
- **门禁 `platform-tool-permission.service.ts`**：只依赖 PrismaService（**去掉 ExecutionPolicyService**）；`select role:{id,key,capabilities}`；裸名→`vteam_<name>`→能力点；`capabilities[capKey]===false`→403；缺失键→allow（default-allow）；工具映射不到能力点→403（unknown 面 fail-closed）；`role` 缺失/成员不可解析→403。
- **dispatcher**：`MemberRoleAuthority` 用 `capabilities` 取代 `policyId`；`resolveBoundaryAndTools` **双通道**——`tools`（记忆/产出物段屏蔽）由 capabilities 推导；`correction`（prompt 关注点，非授权）保留 `resolveByRole({roleKey})` 读内置约定策略行（AgentRole.policyId 已删，故 `RolePolicyInput` 仅 `roleKey`）。未绑岗位（存量路径）→ tools 回退常量工具集（与引入前逐字节一致）；已绑岗位 → 能力矩阵。
- **myProfile**：`effectivePermission` 改为 `{ roleId, roleKey, capabilities }`（直接取 `role.capabilities`，缺失键=允许语义；未绑岗位=null）；移除 `ExecutionPolicyService` 可选注入；`platform-mcp.tools.ts` 描述同步。`PlatformMcpModule` 去掉 `ExecutionPoliciesModule` import。
- **无岗位成员（Q5）**：`resolveMemberBinding`/`resolveTaskMemberBinding` 把 roleId 校验**前置**：缺 roleId（或 updateMember 显式清空 roleId）→ 400 `MEMBER_ROLE_REQUIRED`（teams 域 `TEAM_ERRORS.MEMBER_ROLE_REQUIRED`；tasks 域同名字符串）；roleId 指向不存在角色→404 `ROLE_NOT_FOUND`（不再静默回退无岗位）。**enforcement point = service 层**（唯一权威，覆盖 HTTP + 内部 task 快照路径）；DTO 仅注释说明。
- **角色 CRUD**：DTO 增 `capabilities?: Record<string,boolean>`（`@IsObject`），移除 `policyId`；service `normalizeCapabilities` 校验键 ∈ 目录、值 boolean，否则 400 `AGENT_ROLE_CAPABILITY_KEY_INVALID`（新码，替换 `AGENT_ROLE_POLICY_NOT_FOUND`）；create 缺省落出厂矩阵；response `capabilities`。**内置角色唯一写保护仍只有 `key`（改 key→403）与 DELETE→403**；capabilities 对 builtin 放开（未新增/放宽任何他字段）。
- **常量**：`BuiltinAgentRole` 删 `policyId`；删 `EXTERNAL_AGENT_ROLE_POLICY_ID`；增 `EXTERNAL_AGENT_ROLE_CAPABILITIES`（由 8 工具 allowlist 映射）。
- **seed**：自包含镜像能力目录 + `capabilityMatrixFromTools`/`factoryCapabilityMatrix`；builtin upsert 落其 ROLE_BOUNDARIES 派生矩阵 + `updateMany(where capabilities: Prisma.DbNull)` 补齐；外部 3 岗补最小矩阵；末条全表补齐出厂矩阵（防 NULL）；删 ep_external upsert 与外部 policyId 绑定。`Prisma` 改为具名 import。
- **spec 重定向**：gate spec 全量改能力点（cases a/b/c/d + 结构断言 select 不含 agent）；authority-matrix 门改真实 PlatformToolPermissionService（role.capabilities=ROLE_BOUNDARIES 派生）；worker-dispatcher 6 例重定向（capabilities + resolveByRole({roleKey})）；platform-mcp.service myProfile 6 例；agent-roles service/controller；seed；teams/tasks 全部补 roleId 并新增缺 roleId→MEMBER_ROLE_REQUIRED；删 `agent-role-policy.migration.spec.ts`，新增 `agent-role-capabilities.migration.spec.ts`（迁移常量与 TS 派生逐键相等）。
- **`CONTRACT-tool-naming-and-identity.md`**：§2 解析链改 `TeamMember.roleId→AgentRole.capabilities`；新增 §2.1 capability model（default-allow/目录/21 覆盖 28/Q6）与 §2.2 明确接受的 `vteam-api`/`swagger-mcp` 绕过（防误调用≠安全边界，不加门）；§4 fail-closed 表改 capability 口径 + 唯一的 allow 分支；§5 说明 vteam_* 键仍服务引擎原生视图、对平台授权已死；工具数 29→28。

### 命令与结果
- `npx prisma validate` → 0；`npx prisma generate` → 0；`npx tsc --noEmit -p tsconfig.json` → 0。
- `npx jest --runInBand`（全量）→ **147 suites：3 failed / 144 passed（5 tests）**，与 HEAD 基线**逐一相同**（task.constants ×3、platform-mcp.service notify_agent ×1、review-dispatch 三元组 ×1）⇒ **零新增失败**。

### Scratch-DB 迁移实证（宿主临时 MySQL 容器 :13306；live `aiagents` 全程未触碰；收尾已 stop/drop）
宿主 `npx nest build` → `dist/prisma/seed.js`（新）。
**A. fresh**：`vteam_fresh` → `npx prisma migrate deploy`（All applied）→ `node dist/prisma/seed.js`。断言探针 **11/11 passed**：无 policy_id 列、有 capabilities、无 NULL、ep_external 已删、7 builtin capabilities == ROLE_BOUNDARIES 常量派生（逐键）、ar_general == 出厂矩阵。roles=8（7 builtin + ar_general）。
**B. upgrade**：`vteam_upg` 先只应用至 000004（临时把 000006 移出再移回）→ raw SQL 造存量态：11 角色（7 builtin 绑 policy_id、developer 置 NULL、3 外部绑 ep_external、ar_general NULL）+ ep_<key> 策略（**architect 的 config.tools 额外放行 issue_update/issue_transition**，用于证明 DB 优先）。应用 000006 后断言探针 **18/18 passed**：
  - `ar_architect.issue.manage=true`（DB config.tools 优先于常量）、`ar_tester.issue.manage=false`（部分放行→保守 false）、`ar_developer.issue.manage=true`（policy_id NULL→常量回退）；
  - product/project_manager/tester/plan/librarian == 常量派生；3 外部 == EXTERNAL 矩阵；ar_general == 出厂；
  - 无 policy_id 列、有 capabilities、无 NULL、ep_external 已删、角色数仍 11。
  - 应用前引用计数：`agents_ref_ep_external=0`、`agent_roles_ref_ep_external=3`（故 DELETE 安全）。

### 突变验证（sha256 before == after-restore）
- 门禁 `platform-tool-permission.service.ts` sha `182239f4…`：把 `matrix?.[capabilityKey] === false` 改为 `!== true` → `jest -t "能力点缺失"` **2 failed**（default-allow 唯一证明被破）；还原 sha 一致 → 全绿。
- dispatcher `worker-dispatcher.ts` sha `7c5d0446…`：把 capabilityTools 由 role.capabilities 改为 agentKey 常量派生 → `jest -t "岗位决定 correction"` **1 failed**；还原 sha 一致 → **1 passed**。

### live 实证（compose；`docker compose build server` → `run --rm --no-deps --entrypoint sh server -c "npx prisma migrate deploy"`（应用 000006，All applied）→ `up -d --no-deps server web`；**未跑 seed**；server healthy）
`POST /api/v1/platform-mcp`，头 `x-worker-token`（容器 WORKER_TOKEN）+ `x-worker-id: w_compose_worker`，team 维度 `teamId=tm_0000000001`、`selfInstanceId=tmm_0000000004`（developer）。
- **改前基线（旧镜像 / policy_id 间接层）**：`group_post`→200；`task_create`→`-32003 PLATFORM_MCP_TOOL_NOT_PERMITTED …角色（developer）的工具矩阵未授权（effect=未列入）（策略 ep_developer）`。
- **改后**：`group_post`→200（**与改前一致**）；`task_create`→`-32003 …岗位（developer）已拒绝能力点 task.create`（判定同，文案换 capability 口径）。
- **翻转 role.capabilities**：`chat.post=false` → `group_post` **-32003**；`task.create=true` → `task_create`（缺 title）**-32602 zod**（证明已过门禁，非 403）；均还原。
- **翻转 agent 策略不影响**：`UPDATE agents SET policy_id='ep_product' WHERE id='a_developer'` → `group_post` 仍 200、`task_create` 仍 -32003；还原 `ep_developer`。
- live 迁移态：roles=11、policies=8（ep_external 已删）、members=11、teams=3、tasks=2、无 policy_id 列、无 NULL capabilities、ar_general 出厂矩阵；`GET /agent-policies`（带 JWT）200、7 内置名齐全（**buildAgentPolicies 未动**）。
- 收尾：删除 3 条探针消息（`m_0000000248/249/250`，`probe_msgs_left=0`）；临时 SQL 文件已删。

### 行为变更汇总（需 review）
1. 内置角色能力点矩阵按**保守映射**落库：多工具能力点部分放行时塌陷为 false（architect/tester 的 issue.manage、plan/librarian 的 memory.manage）——只减不增，符合"不得因默认翻转获得新授权"。
2. 无岗位成员不再支持（服务层 400 `MEMBER_ROLE_REQUIRED`；roleId 悬空 404 `ROLE_NOT_FOUND`）；相关 teams/tasks 单测同步重定向。
3. 外部岗位的 `correction` 边界段随 `ep_external` 删除而消失（prompt-only；dispatcher correction 仍走内置约定策略行/常量）。`rolePrompt` 段不受影响。
4. myProfile `effectivePermission` **形状变更**（policyId/policyName/permission/correction → roleId/roleKey/capabilities）。无 web 消费方（grep 确认）。
5. `execution_policies.config.tools` 的 vteam_* 键保留（对平台授权已死；仍供引擎原生视图）——按 brief item 8 未清理。

### 坑
- 迁移临时表 JOIN 的 **collation 必须显式对齐** `agent_roles.id`（utf8mb4_unicode_ci），否则 `Illegal mix of collations`（fresh 首跑即红）。
- `JSON_OBJECT('k', <0/1 表达式>)` 对逻辑表达式落 JSON boolean，但 `COALESCE(..., FALSE)` 会落数字 `0`——必须统一用 `IF(cond, CAST('true' AS JSON), CAST('false' AS JSON))`。
- MySQL JSON 路径键含点号（`task.create`）必须写 `$."task.create"`，`$.task.create` 会被当作嵌套路径返回 NULL（误导"列是 NULL"）。
- `seed.spec.ts` 的 `jest.mock('@prisma/client')` 只 mock `PrismaClient`，seed 里 `Prisma.DbNull` 会 undefined；需在 factory 补 `Prisma: { DbNull: 'DbNull' }`。
- 全量 `npx jest` 会重写 `.omo/evidence/.../task-9-matrix.json`（authority-matrix spec 副作用）；`plan-review-execution-gates/task-9/probe.json` 会话开始时即 modified（并行 worker），均未回滚。
- 并行 slice 6b 正在写 `web/**`（新增 `role-capabilities.ts`/`RoleCapabilityEditor.tsx`），未触碰。

### 未验证 / 边界
- 未做 live dispatch 观看 `system` 提示词（dispatcher 的 capabilities 屏蔽行为由单测 + 突变覆盖）。
- 外部/未绑岗位的 dispatcher 路径仅单测覆盖（live 11 成员全为内置岗位绑定）。
- `resolveByRole` 仍保留（仅 dispatcher correction 消费）；`resolveByAgent`/`resolveManyByAgents` 保留服务 `buildAgentPolicies`/GET /agents（引擎原生层，未动）。
- `MEMBER_AGENT_REQUIRED` 常量与 tasks 域同名旧码保留未删（无引用；仅为错误码注册表兼容）。

## [2026-09-21] SLICE 6b LANDED — 岗位表单的「策略下拉」改为「业务能力点」编辑器（角色 Tab，web）

**Status: implemented + verified live（工作树未提交）。** 仅 web 5 文件：`src/api/role-capabilities.ts`（新）、
`src/components/agents/RoleCapabilityEditor.tsx`（新）、`src/api/agent-roles.ts`、`src/components/agents/AgentRolesTab.tsx`、
`app/(main)/agents/page.tsx`。

### 文件与改动
- `role-capabilities.ts`（新）：21 个能力点目录，**逐字对照服务端** `server/src/common/constants/platform-capability.constants.ts`
  的 `PLATFORM_CAPABILITIES`（key / 中文 label / 覆盖工具 `vteam_<action>` / 出厂拒绝，含顺序），仅新增 UI 分组字段 `group`
  （任务/团队/协作/产出/Issue/记忆/能力/自动化）。辅助：`factoryCapabilityMap()`、`normalizeCapabilities()`
  （null/undefined→出厂矩阵且 `fromFactory=true`；已保存 map 的目录键**缺省允许**、显式 false 才拒绝、目录外键保留 into `extraKeys`）、
  `summarizeCapabilities()`、`capabilityOf()`。
- **目录来源（必须报告）**：服务端**未**暴露目录接口（`GET /agent-roles` 只回矩阵），故走 brief 的「无接口则硬编码 + 报告」分支：
  web 端是服务端常量的**逐字副本**；用 ts-node 从服务端 `PLATFORM_CAPABILITIES` 逐项机器比对（key/label/tools/factoryDefault）
  → `web entries=21 server entries=21 mismatches=0`。服务端若新增目录接口，只需替换本文件的来源，编辑器无需改动。
- `RoleCapabilityEditor.tsx`（新）：`data-testid="role-capability-editor"`；每行 = 中文名（主，fontSize.md/600）+
  `key · vteam_tool`（次，mono/xs）+ 右侧**二进制** 允许/拒绝 pill 分段（镜像 Agent Tab `ToolEffectSelect` 视觉：neutral[50] 容器 +
  绿 #059669 / 红 #DC2626 选中白字；**无 ask 第三态**）；出厂拒绝行加琥珀左边 + `capability-factory-deny-hint`「请确认」；
  目录外键单独「其他」组（`data-extra`，保存原样带回）；`data-source`(factory-default|stored)/`data-readonly`/`data-creating`/
  `data-allowed-count`，行级 `data-capability`/`data-allowed`/`data-factory-default`。
- `AgentRolesTab.tsx`：删策略 `<select>`、`role-policy-note`、`role-item-policy`、`executionPoliciesApi` query、
  `foreignPolicyId`/`describePolicy`/`policyIdKnown`、`AGENT_ROLE_POLICY_NOT_FOUND` 文案分支；`RoleDraft` 增
  `capabilities`（完整 map）+ `capabilitiesFromFactory`；保存**整份 map**（目录键恒在；创建/自定义/克隆同口径），
  内置岗位 PATCH **只带 `capabilities`**（`data-scope="capabilities"`，身份字段保持只读）；列表行改
  `role-item-capabilities`「权限点：N 允许 / M 拒绝（出厂默认）」；内置提示改「身份字段只读、不可删除；平台能力点可调整」；
  底部文案改能力点口径（缺省允许 / 「请确认」含义）；`capabilitiesReadOnly = creating ? !canCreate : !canEdit`。
- `agent-roles.ts`：`AgentRoleDto.capabilities: Record<string, boolean> | null`；Create/Update payload `capabilities?`；
  删除 `policyId`、`ExecutionPolicySummary/Page`、`executionPoliciesApi`（文件只剩 DTO/传输）。
- `agents/page.tsx`：`effective-permission-scope-note` / `effective-mcp-scope-note` 与两处注释 → 「平台工具调用授权以成员岗位的**平台能力点**为准」；
  「引擎原生权限」标题与说明保留（本页策略=ExecutionPolicy 引擎原生层，不改）。

### 命令与结果
- `cd web && npx tsc --noEmit` → exit 0（收尾清理临时 spec 后再跑一次仍 0）。
- `eslint`（5 文件）→ 0 errors / 2 warnings（`deleting` unused、`roles` exhaustive-deps；均 HEAD 既有，零新增）。
- 目录机器比对（server ts-node + 正则解析 web 副本）→ `mismatches=0`。
- grep：`role-policy-select|role-policy-note|role-item-policy` → web 全仓 **0**；`role.policyId|draft.policyId|AgentRole.*policyId` → **0**。
  残留 `policyId` 仅在 Agent 侧引擎原生权限编辑器（`effective.policyId` = ExecutionPolicy 主键，`PATCH /execution-policies/:policyId`）——
  该功能本 slice 明确保留，不属「角色 policyId」。
- 部署：`docker compose build web && docker compose up -d --no-deps web`；镜像产物 grep 含新文案「已保存能力点矩阵」、无 `role-policy-select` ⇒ 镜像 == 工作树。

### Playwright 证明（:13001，admin/admin123；临时 spec + config 跑完已删；**3 passed**）
1. 自定义探针 `zz-slice6b-probe`（baseline 11 岗）：创建态 `data-creating=true`/`data-source=factory-default`、21 行、10 个「请确认」；
   翻 `task.create→允许`、`chat.post→拒绝` → 保存 → **API 回读**：21 键完整、task.create=true、chat.post=false、
   task.transition/hook.manage=false、task.context/file.read=true；reload 后 UI `data-source=stored`、两行 data-allowed 与
   aria-checked 一致、列表摘要「权限点：11 允许 / 10 拒绝」；删除 → roles=11、逐行 == 基线快照、探针 GET 404（无残留）。
2. 内置 `developer`：`data-source=stored`、`data-readonly=false`、当前值渲染（chat.post=true）；翻 `chat.post→拒绝` →
   **PATCH 200（服务端已放宽该字段，非 blocker）** → 回读 false；还原（→允许）→ 回读**整份矩阵 == 基线**；`role-name-input` 仍 `readonly`。
3. Agent Tab `effective-permission-scope-note` 含「岗位」「能力点」、无字面 `**`。
- 报告 `/tmp/slice6b-proof-report.json`；截图 `/tmp/slice6b-editor-only.png`、`/tmp/slice6b-probe-reloaded.png`、`/tmp/slice6b-builtin-developer.png`。
- 回归（临时 config 直跑，未写 evidence）：`dark-mode-role-warning.spec.ts` **2/2 green**；`create-agent-role.spec.ts` **4/4 green**。

### live 收尾核对（mysql/curl）
- `agent_roles=11`、`key LIKE 'zz-slice6b%'`=0；`ar_developer`：`JSON_LENGTH(capabilities)=21`、`chat.post=true`（还原）；`ar_general` 21 键。
- **基线更正**：brief 记 8 members / 2 teams，实测（本 slice 未触碰）：`members=11`、`teams=3`
  （`tm_0000000002 probe-role-only` 09:24、`tm_0000000007` 14:26 属更早切片遗留）⇒ 本 slice 未新建/删除任何 team/member。

### 坑
- 目录是 SLICE 6a 的**新文件**（`platform-capability.constants.ts`，21 项覆盖 28 个 `vteam_*` 工具）——最初按工具自拟的 22 项目录
  （`task.view`/`issue.view` 等键）已整体废弃，改为逐字对照；**先等 6a 落地再定目录**，否则必返工。服务端 DTO 拒绝未知键/非 boolean
  （400 `AGENT_ROLE_CAPABILITY_KEY_INVALID`）⇒ web 的「目录外键保留」在现行服务端不会触发，保留作目录收缩时的防丢失。
- 服务端 `null` 运行时等同 `{}`（全放行，schema 注释），而本 slice 按 brief 固定「null → 出厂矩阵展示」；migration 兜底非 NULL，
  live 不出现 null；未来若新增行可能出现 null 语义差，需产品口径统一（已记）。
- 老 server（无 capabilities 字段）下 `role.capabilities === undefined` → `normalizeCapabilities(undefined)` 走 null 分支，UI 不白屏（冒烟已证）。
- Playwright 跑内置用例前必须等服务端重建完成（信号：`docker ps` server `Up <1min` + DB `agent_roles.capabilities` 列出现）；
  重建中跑会假红。
- 临时 Playwright spec 会被 `tsc` 一起检查（web tsconfig 含 e2e）——清理后再跑最终 tsc。

### 未验证 / 未触碰
- 未跑 `scripts/e2e-roles-members.sh`（已知 HEAD 陈旧红，见 SLICE 2 记录）；未跑全量 web e2e。
- 未暴露/未消费服务端目录接口（不存在）；未碰 `server/**`、`web/app/(main)/teams/**`、`TeamMembersPanel.tsx`（SLICE 4 在改）、
  slot 互斥语义、Agent 侧引擎原生权限编辑器；无 commit/push/branch。

## [2026-09-21] SLICE 6c LANDED — 内置岗位能力矩阵拉平到出厂默认（seed + migration 000007，server）

**Status: implemented + verified（工作树未提交）。** HEAD start `560e5ea`。用户决策（原话答复「内置角色拉平到出厂默认吗？」）：**是**。替换 SLICE 6a 的保守派生（`buildCapabilityMatrixFromTools(ROLE_BOUNDARIES…)`）为目录出厂默认（`buildFactoryCapabilityMatrix()`：default-allow + 10 个 defaultDeny 敏感点 `false`，11 个 `true`，21 键全量）。

### 文件与改动
- **seed**（`prisma/seed.ts`）：7 内置岗 upsert create 分支 + `updateMany(capabilities: DbNull)` 补齐分支均改 `factoryCapabilityMatrix()`（替换 ROLE_BOUNDARIES 派生）；`capabilityMatrixFromTools` **保留**（外部 3 岗最小矩阵仍由 8 工具 allowlist 派生，非死代码）。外部岗/兜底 updateMany/`Prisma.DbNull` 语义不变。
- **迁移 `20260921000007_builtin_role_capabilities_factory_default`（新）**：单条 UPDATE 整列 `CAST('<21 键出厂字面量>' AS JSON)` 覆盖，范围守卫 `type='builtin' AND key IN (7 内置 key)`；幂等（常量右值、不引用列自身，重跑零变化已实证）。**不使用 JSON_SET/JSON_REMOVE**（对不存在路径返回 NULL 置空整列的陷阱不适用——整列字面量覆盖恒非 NULL，头注释已声明 JSON_CONTAINS_PATH 守卫不适用的理由）。**未改 `20260921000006`**（checksum ledger）。
- **外部 3 岗（sisyphus/prometheus/atlas）不动**：保持 000006 写入的 8 工具最小矩阵（8 true / 13 false）——第三方执行器最小权限为有意设计（upgrade 前后逐字节 diff 证同）。`ar_general` 已是出厂矩阵，不在 000007 范围（前后同值证同）。
- **specs**：`seed.spec.ts` 内置岗期望改 `buildFactoryCapabilityMatrix()`（删未用 import）；`platform-mcp.authority-matrix.spec.ts` 的 `builtinCapabilities`→`factoryCapabilities()`（expect 与 gate fixture 同源换出厂，头注释同步；具名负格 8 格全部仍 deny——它们都落在 defaultDeny 能力点上）；**新增** `src/prisma/agent-role-capabilities-factory-default.migration.spec.ts`（000007 契约：字面量==目录出厂、恰 1 条 UPDATE、无 JSON_SET/JSON_REMOVE、key IN 恰 7 内置 key、外部/general 不可命中、头注释标记）。`agent-role-capabilities.migration.spec.ts`（000006 契约）未动。

### 有意授权翻转（DB 实测 upg-before vs upg-after 逐岗差集，需 review）
**deny→allow（GRANT，共 12 格）**：
- product: `git.repos`
- project_manager: `git.repos`, `doc.submit`
- architect: `git.repos`
- developer: `git.repos`
- tester: `git.repos`
- plan: `git.repos`, `doc.submit`, `memory.manage`
- librarian: `doc.submit`, `chat.notify`, `memory.manage`

**allow→deny（REVOKE，敏感点回归出厂拒绝，共 30 格）**：
- product(8): `task.create`, `task.transition`, `team.add_member`, `chat.channel_send`, `wecom.reply`, `issue.manage`, `question.confirm`, `hook.manage`
- project_manager(10): 上 8 + `task.complete`, `skill.create`
- architect(2): `chat.channel_send`, `wecom.reply`
- developer(3): architect 2 + `issue.manage`
- tester(2): `chat.channel_send`, `wecom.reply`
- plan(2): `task.complete`, `wecom.reply`
- librarian(0)

### 命令与结果
- `npx prisma validate` → 0；`npx prisma generate` → 0；`npx tsc --noEmit -p tsconfig.json` → 0。
- `npx jest --runInBand`（全量，workdir=server）→ **148 suites：3 failed / 145 passed（5 tests / 3399）**，失败逐一 == HEAD 基线（task.constants ×3、platform-mcp.service notify_agent ×1、review-dispatch 三元组 ×1）⇒ **零新增失败**；新增 000007 契约 spec 通过（148 = 基线 147 + 1）。

### Scratch-DB 双路径实证（宿主临时容器 `vteam-scratch-mysql` :13306，live `aiagents` 只做过只读 SELECT；收尾已 drop 全部库 + rm 容器 + 清 stash）
探针 `/var/folders/…/T/opencode/probe-caps.mjs`（fresh/upg-before/upg-after 三模式，逐键比对 + 21 键 + 无 NULL）：
- **A. fresh**：`vteam_fresh7` → `migrate deploy`（含 000007，All applied）→ `node dist/prisma/seed.js` → **PROBE PASS：8 roles**（7 内置 == 出厂、ar_general == 出厂、无 NULL、无外部岗=fresh 本就无）。**seed 补齐探针**：置 `ar_product.capabilities=NULL` 重跑 seed → 再 PASS（DbNull 补齐分支落出厂）。
- **B. upgrade**：`vteam_upg7` 移出 000006+000007 → deploy 至 …000004 → raw SQL 插 3 外部岗（type=custom + default_opencode_agent_name，对齐 live 形状，11 roles）→ 归位 000006 → deploy → **upg-before PASS**（7 内置 == 000006 常量派生、`product.task.create=true` 判别性成立、3 外部 == 8 工具、general == 出厂、无 NULL）→ 归位 000007 → deploy → **upg-after PASS**（7 内置 == 出厂；external+general 前后 TSV **diff 为空**；无 NULL）。**幂等**：手工重跑 000007 SQL → 全表 TSV 与跑后逐字节一致。
- 迁移目录收尾核对：000006/000007 均在位，stash 空；`20260921000006` 内容全程未改（仅 mv 往返）。

### 坑
- `mysql -B` 批量模式把 TAB 转义成字面 `\t` 两字符——TSV 导出必须加 `-r`（raw），否则按 TAB 切列全错位。
- 比对两份 JSON 矩阵**不能** `JSON.stringify` 直比（MySQL 落库键序 ≠ 字面量键序）——按键排序归一后比（探针 `norm()`）。MySQL 8 `CAST(a AS JSON)=CAST(b AS JSON)` 键序不敏感（实测 `{"a":1,"b":2}={"b":2,"a":1}` → 1），可直接 SQL 比。
- 迁移序号**没有 000005**（000004 直接跳 000006）；「deploy 至 000006」= 移出 000006/000007 后 deploy 即停在 000004。
- bash 多行命令在本环境需单行 `&&` 链（带 workdir），换行分隔会静默不执行。
- authority-matrix spec 跑全量 jest 会重写 `.omo/evidence/…/task-9-matrix.json`（allow/deny 计数随出厂矩阵变化）；`plan-review-execution-gates/task-9/probe.json` 会话开始即 modified（并行 worker），均未回滚（沿袭 6a 记录）。
- seed.ts / seed.spec.ts / authority-matrix.spec 均为继承的超 250 LOC 大文件；本次净改动为缩减/持平（未新增行数推高），未在本 slice 触发重构。

### 未验证 / 未触碰
- 未跑 web e2e / `scripts/e2e-roles-members.sh`（已知 HEAD 陈旧红）；未动 `web/**`、目录常量、门禁逻辑、`buildAgentPolicies`/GET /agent-policies、引擎原生权限。
- live `aiagents` DB 只读核对（11 角色、无 NULL、外部 8 工具、内置仍旧派生态）——未写入；orchestrator 事后 `docker compose down -v` 重建时 000007 将把 live 内置岗拉平。
- 无 commit/push/branch。

---
## 2026-09-22 · 移除岗位能力点编辑器「请确认」徽章（用户：出场关掉的本身后面就有关闭的状态开关，没必要加一个）

### 变更范围（web only，无 server 改动）
- `web/src/components/agents/RoleCapabilityEditor.tsx`：会话开始时源码已处于目标态（07:24 编辑，早于本会话）——
  琥珀 `capability-factory-deny-hint`「请确认」badge + `title="出厂预设拒绝：放开前请确认该能力的影响"`、
  出厂拒绝行琥珀行样式、header note 里的「标「请确认」」、底部 legend 对徽章的解释**均已不存在**；
  二进制 允许/拒绝 开关与三态 note（creating=出厂预设 / fromFactory=尚未保存 / stored=已保存矩阵）逐字保留。
  旧容器镜像（2026-09-21T14:58 构建）仍含徽章字符串 → `docker compose build web && docker compose up -d --no-deps web`
  重建后容器内 grep：`capability-factory-deny-hint`=0、`出厂预设拒绝：放开前`=0。
- `AgentRolesTab.tsx` / `web/` 全仓 grep `请确认`（排除 node_modules/.next）= **4 处，全部与能力点编辑器无关，未改**：
  ① `app/(main)/agents/page.tsx:818` 兜底规则提示；② `app/(main)/git-repos/page.tsx:337` 删除凭据错误文案；
  ③ `app/(main)/teams/[id]/session/page.tsx:1016` 建队重试提示；④ `public/install-worker.sh:242` 安装脚本报错。
  能力点上下文（`web/src/components/agents/` + `web/src/api/` + `web/e2e/`）= **0**。

### 验证
- `cd web && npx tsc --noEmit` → **exit 0**（临时 spec 删除后复跑仍 0；tsconfig 含 e2e，临时 spec 必须先删再跑终检）。
- Playwright（:13001，admin/admin123，临时 spec + 临时 config 跑完即删）→ **1 passed (3.5s)**，报告 `/tmp/cap-badge-proof-report.json`：
  builtin developer `data-source=stored`、21 行 / 8 组 / 42 开关、21 行开关逐行往返（draft only）、
  10 个 `data-factory-default=deny` 行逐行无徽章、编辑器与整页 `请确认` 计数=0、mutation 请求数=0；
  截图 `/tmp/cap-badge-proof-developer.png`、`/tmp/cap-badge-proof-create-factory.png`。
- **null note 口径**：live 11 岗 `capabilities` 全部 = 21 键对象（migration 兜底非 NULL，无 `null` 岗可选，
  `ar_general` 也非 null）→ 按 brief「否则报告所用角色且不改动」：用**创建态 draft**（`capabilitiesFromFactory=true`
  ≙ `normalizeCapabilities(null)` 分支）证明 `data-source=factory-default` + 出厂预设 note 仍在、同样无「请确认」；
  未保存、未写库（mutation_requests=[]）。
- 未 commit/push/branch；未触碰 `server/**`、`web/app/(main)/teams/**`、`TeamMembersPanel.tsx`、出厂默认 map、允许/拒绝语义。

### 坑 / 复用
- **镜像与工作树可能脱节**：容器 grep 到旧字符串 ≠ 源码仍有——先 grep 源码定性，再比对容器 `.next`，必要时重建 web 镜像后复扫。
- `请确认` 是通用短语：全仓 grep 必须按**上下文**（能力点编辑器目录/e2e）报 0，其余命中只报告不改写。
- Playwright 证明「不改动」的正确姿势：`page.on("request")` 守卫 agent-roles 的 POST/PATCH/DELETE 计数=0，
  开关往返只走 draft（onChange 上抛、不点保存）。

---
## 2026-09-22 · orchestrator 收尾：原子提交 + down -v 全新部署逐条核对

### Part A 提交（6 个新 commit：5 代码 + 1 .omo；未 push、未建分支，HEAD=main）
- `7301390` feat(server): role-owned capability points gate vteam_* tool calls
  — 21 文件：能力目录 platform-capability.constants(21 点/28 工具) + `AgentRole.capabilities`
  + 迁移 000003/000006/000007 + 门禁 switch（platform-tool-permission 只读 capabilities，
  module 摘 ExecutionPoliciesModule）+ agent-roles CRUD 校验 + seed 出厂/外部矩阵 + specs + CONTRACT。
  行为：内置岗拉平出厂（相对旧派生 **12 grants / 30 revokes**）、外部 3 岗保持 8-tool、ep_external 随 000006 删除。
- `5bfcc53` feat(server): dispatcher and my_profile resolve authority by role
  — 名册一次查询带 role{id,key,capabilities}；工具屏蔽由能力矩阵推导；边界 correction 走新增
  `resolveByRole`；`my_profile.effectivePermission` 改为 `{roleId,roleKey,capabilities}`（不再读执行 Agent 策略）。
- `815805b` feat(server+web): external members land on a_external; role is mandatory
  — 迁移 000004 建占位行；resolveMemberBinding（teams+tasks）外部岗落 a_external；
  **MEMBER_ROLE_REQUIRED 必填**（缺 roleId 400、显式清空解绑 400、ROLE_NOT_FOUND 前置）；
  GET /agents 排除 type=system；web 三处（teams/new、teams/[id]、TeamMembersPanel）删执行 Agent
  选择器与提示；e2e 断言 agentId==='a_external'、roleId-only POST。
- `0549f55` feat(web): role capability-point editor; relabel agent policy as engine-native
  — RoleCapabilityEditor（21 行/8 组/二进制 允许-拒绝，无「请确认」徽章）+ role-capabilities.ts +
  AgentRolesTab draft(capabilities/capabilitiesFromFactory) + agents 页「权限」→「引擎原生权限」+
  两处 scope note + `web/scripts/one-off/list-role-caps.mjs`（只读诊断，admin123 dev 值）。
- `25e0ef7` test(server): lock migration 000007 factory-default contract
  — **补录**：该 spec 文件（mtime 08:15，早于本会话首查 08:26 却未出现在首查 status——疑似并行
  worker/索引滞后）在 commit 1 后才被发现，单独成原子提交；000007 migration.sql 本体已随 7301390。
- 混合文件拆分手法（可复用）：`agent-role.constants.ts` / `seed.ts` / `seed.spec.ts` 同时含
  能力点与 a_external 内容 ⇒ `cp /tmp 备份 → Edit 摘除 a_external 块 → git add → cp 还原工作树`
  ⇒ commit 1 只收能力点部分，commit 3 收剩余（index=部分、工作树=全文，git status 差异恰为 64 行 a_external 块）。
- secret 扫描：pending diff 命中仅 `admin123`（one-off 脚本，已知 dev 值）与本 notepad 散文里的
  临时 probe MySQL 口令；无 `sk-`/PRIVATE KEY/长 hex 真凭据。`git ls-files` 命中
  node_modules/dist/.next/.env/*.log = **0**。
- 小瑕疵（遵「不 amend」规则保留）：`815805b` 正文末行有重复片段 `explicit executorexternal roles…`（可读、未 push）。

### Part B down -v + up -d --build（README 路径，非 --force-recreate）
- `docker compose down -v`：移除 5 容器 + **4 卷（mysql_data/uploads_data/worker_home/vteam_worker_data）** + 网络。
- `docker compose up -d --build`：db Healthy → **init Exited(0)**（`All migrations have been successfully applied.`
  + `Seed 完成`）→ server Healthy → web Healthy → worker Up。
- 终态 compose ps：db Up(healthy) / init Exited(0) / server Up(healthy) / web Up(healthy) /
  worker Up（**compose 未定义 worker healthcheck**（inspect `.State.Health`=null），workers 表
  `w_compose_worker`=online 作为存活旁证）。

### DB 断言（mysql root/`aiagents-root`@容器 aiagents-compose-db，库 aiagents；down -v 后口令仍来自 docker-compose.yml）
- 迁移：磁盘目录 **71** == `_prisma_migrations` **71**（finished_at 非空=71、finished_at IS NULL=0、
  目录↔账本 `comm -3` diff **空**）。
- 角色 `agent_roles`=**8**：7 builtin 逐岗 `JSON_LENGTH=21, false=10, true=11`（出厂：product/
  project_manager/architect/developer/tester/plan/librarian 全中）+ `general`(custom)=21/10/11（出厂）。
- **偏差①（如实记录）**：外部 3 岗（sisyphus/prometheus/atlas）全新库**不存在** ⇒ 任务 §2「3 外部岗
  承载 8-tool 矩阵」在 fresh 上无对象可验、§6「11 roles」不成立。notepad 本就有据：line 717
  「外部 3 岗在全新库不存在（自定义行为用户创建），属预期」、line 845/993 fresh 探针 PASS=**8 roles**。
  代码事实：seed 对外部岗只有 `updateMany(… capabilities IS NULL)` 补齐、不 create；全部迁移也无
  INSERT 外部岗 ⇒ fresh 恒 8。**未手工补插**（避免非 seed 残留）。升级路径（存量已有 3 外部岗）仍由
  000006/seed 写 8-tool 矩阵——scratch DB 双路径证明见上文 SLICE 6c。
- 策略 `execution_policies`=**7**（ep_product…ep_librarian），`ep_external`=0。任务 §2「9 → back to
  the seeded policy count (no ep_external)」按箭头语义解读=回到 **seeded 计数 7** ⇒ 达成；若把 9 当
  目标值则不符（live 曾 8/9：7 内置 + ep_external + 1 条 live-only，见 notepad 659/785/862 行）。
- `a_external`：id=a_external、type=**system**、agent_key=NULL、policy_id=NULL ✅。
- 应删列/表 grep（information_schema）：tasks 无 `plan_mode`（任何 *plan_mode* 均无）；agent_roles 无
  `policy%` 列；agents 无 `role` 列；agent_tool_effects 无 `permission_scope`；projects/task_agents 表
  **不存在**；`SHOW TABLES LIKE '%plan%'` 仅剩 plans/plan_tasks（计划域正式表，非残留）；tools
  `%plan_mode%`=0、execution_policies.config 含 `vteam_plan_mode`=0。**`agents.policy_id` 仍在=有意保留**
  （喂 worker injector 原生层，非残留；被删的是 `agent_roles.policy_id`）。
- 残留：team_members=**7**（seed 示例团队 tm_0000000001）、teams=**1**、users=3、sessions=0、tasks=0、
  skills=8（seed 内置）；`zz-%/%probe%` UNION 扫 agent_roles/teams/agents/team_members/sessions/users/
  execution_policies/tasks = **0 行**。

### 端到端断言（逐字）
- `GET http://localhost:13000/api/v1/health` → **HTTP 200** `{"status":"ok","info":{},"error":{},"details":{}}`。
- `http://localhost:13001/` → **HTTP 200**；`POST /api/v1/auth/login` {admin, admin123} → **HTTP 200**，
  accessToken 长 **221**。
- 能力门 `POST /api/v1/platform-mcp`（X-Worker-Token: compose-worker-token、X-Worker-Id: w_compose_worker、
  裸工具名）：
  - fresh sessions=0 ⇒ caller 解析 fail-closed，先**临时**插 1 行 `szz_gate_probe`
    （worker=w_compose_worker、team_member=tmm_0000000003=architect、team=tm_0000000001），测毕 DELETE，
    复核 sessions=0、tasks=0、skills 无新增、zz/probe UNION=0。
  - **ALLOW** `memory_search`（memory.manage 出厂放行）→
    `{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"[]"}]}}` **HTTP 200 非 403** ✅。
  - **DENY** `task_create` → **-32003**
    `PLATFORM_MCP_TOOL_NOT_PERMITTED 工具 vteam_task_create 未获授权：岗位（architect）已拒绝能力点 task.create，拒绝调用`
    ✅（点名能力点 task.create）。复核 `skill_create` → -32003 点名 skill.create ✅。
  - 过程注记：首轮 ALLOW 得 `-32602 该工具需要任务上下文`——来自 handler（memorySearch 内部
    resolveExecContext），**非**门禁 403，恰证门禁已放行；给 probe session 补 `team_id` 后完整成功。
- Playwright（:13001，admin/admin123，脚本 `/tmp/opencode/verify-role-cap-editor.cjs` **不落仓库**）：
  登录 → /agents → 角色 Tab → 点「开发者」→ `role-capability-editor`：
  `data-source=stored`、**「请确认」：编辑器内=0、整页=0**、rows=**21**、groups=8、toggles=42、
  `data-readonly=false`、`data-allowed=false` 行=**10**（出厂拒绝）、sourceNote=「已保存能力点矩阵…」；
  点 task.create 行「允许」→ aria-checked **false→true**、行 data-allowed **false→true**
  （toggleWorked=true）；`roleMutations=[]`（零 POST/PATCH/DELETE，纯 draft）；截图
  `/tmp/vteam-role-cap-editor-fresh.png`。
- **坑（新）**：同页同元素，Playwright `.filter({hasText}).first()` 链的 click 偶发不生效
  （elementFromPoint 命中正确、aria-disabled=false，但 React 状态不翻、200ms 后仍 false）；换显式
  `[data-capability="task.create"]` 定位 + 点后 50ms×10 采样后稳定绿。判定 toggle「可用」须以
  aria-checked **或** 行 data-allowed 翻转为准并带重试采样，单次 click+固定 sleep 会假红。

### 收官状态
- 新 commit：`7301390` `5bfcc53` `815805b` `0549f55` `25e0ef7` + 本条 .omo commit；**未 push、未建分支**；
  除 .omo 三文件外工作树全净；stack 留跑：db/server/web healthy、init Exited(0)、worker running。
- 未做（有意）：未修 815805b 正文末行重复片段（不 amend 规则）；未给 fresh 补外部 3 岗（见偏差①）。
