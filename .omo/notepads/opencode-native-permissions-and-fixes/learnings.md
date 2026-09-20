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
