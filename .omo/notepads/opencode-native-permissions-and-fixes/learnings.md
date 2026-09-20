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
