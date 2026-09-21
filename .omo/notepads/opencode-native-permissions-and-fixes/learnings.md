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
