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
