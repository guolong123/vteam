# Contract: tool-call naming + caller identity (server-side enforcement)

> **Status:** documented contract, empirically pinned (todo 1 of
> `opencode-native-permissions-and-fixes`). **No enforcement is implemented here** —
> todo 3 owns the check. This file records *what the server actually receives* and
> *how the caller is resolved*, so todo 3 implements against facts, not assumptions.
>
> Evidence: `.omo/evidence/opencode-native-permissions-and-fixes/task-1-identity-and-naming.json`
> (+ raw captures under `.../raw/`).

## 1. Naming — the server receives the BARE name

The engine (`opencode` 1.18.31) namespaces every remote MCP tool as
`<server-name>_<tool-name>` for the **model**; the `vteam` server name (`mcp.vteam`
in the injected `opencode.json`) therefore makes the model-facing form `vteam_<name>`.

Over the wire, however, opencode POSTs the **bare** registered name. The exact
envelope the engine builds (extracted verbatim from the opencode binary) is:

```js
{jsonrpc:"2.0", id:1, method:"tools/call", params:{name:<bare>, arguments:<args>, _meta:{progressToken:1}}}
```

**Proven three ways (all in the evidence file):**

1. **Real captured call, byte-exact.** For five tool calls made by a live agent
   session, the server's recorded `content-length` equals
   `JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:<bare>,arguments:<args>,_meta:{progressToken:1}}})`
   length to the byte (delta `0` for all five). Substituting the `vteam_`-prefixed
   name makes every length 6 bytes larger and never matches.
2. **Server reply proves resolution.** A live `vteam_group_post` call returned
   `-32602 ✖ taskId 与 teamId 至少传一个` — that message can only be produced
   *after* `this.tools.find(t => t.name === name)` resolved the tool and the zod
   refine ran. A prefixed name can never reach zod: it returns
   `Unknown tool: vteam_group_post`.
3. **Differential probe.** Identical arguments, bare vs prefixed:
   - `name:"doclib"` → `200 {"artifacts":[]}` (byte-identical to the engine's own
     recorded output for that call);
   - `name:"vteam_doclib"` → `-32602 "Unknown tool: vteam_doclib"`.

### Consequence for todo 3

Key the allowlist lookup on the **bare** name. Do **not** strip a `vteam_` prefix
from the received value — it never has one. `PlatformMcpController.toolsCall()`
(`platform-mcp.controller.ts:172-212`) already resolves the tool with
`this.tools.find(t => t.name === name)`; the permission check must sit on that same
resolved `tool` object (the bare `name`), *before* `tool.handler` runs.

### The `vteam_` form is not dead — it is the *policy* key form

`VTEAM_MCP_TOOL_NAMES` (`common/constants/agent.constants.ts:117-147`) and every
`ROLE_BOUNDARIES[*].toolAllows` key use `vteam_<action>`, and that is what the
emitted `permission`/`guard.roles[*].tools` matrices carry. So todo 3 must bridge
the two namespaces exactly once:

```
received bare name  →  `vteam_${name}`  →  role.tools[`vteam_${name}`]
```

The map is a **bijection** over all 29 tools (asserted by
`platform-mcp.tool-naming.spec.ts`): `live tools/list names == registered names ==
VTEAM_MCP_TOOL_NAMES stripped of the `vteam_` prefix`.

## 2. Identity — what is resolvable at call time

Two independent identity sources are available to `toolsCall`:

| Source | Where | Trust |
| --- | --- | --- |
| `x-worker-id` header | `controller.ts:78` → `ctx.workerId` | authenticated by `WorkerTokenGuard`; identifies the **node**, not the member |
| `arguments.selfInstanceId` / `teamId` / `taskId` | zod-validated tool args | model-supplied; verified server-side by `assertWorkerTask` / `assertWorkerTeam` |

Resolution chain (all existing code, **no new code in todo 1**):

```
tools/call(name, args, ctx.workerId)
  └─ PlatformMcpService.resolveExecContext(ctx, args)        service.ts:5881
       ├─ args.taskId → assertWorkerTask(ctx, taskId, selfInstanceId)   service.ts:5807
       │                 → ExecContext{kind:'task', taskId, callerId}   // callerId = session.teamMemberId ?? agentId
       └─ args.teamId → assertWorkerTeam(ctx, teamId, selfInstanceId)   service.ts:5914
                         → ExecContext{kind:'team', teamId, callerId}   // callerId = session.teamMemberId
  └─ callerId (tmm_ member id)
       └─ TeamMember.id → TeamMember.roleId → AgentRole
       └─ TeamMember.agentId → Agent.policyId / Agent.agentKey
            └─ ExecutionPolicyService.resolveByAgent({policyId, agentKey})  execution-policy.service.ts:663
                 → ResolvedExecutionPolicy.tools = guardForAgent(...)      service.ts:990
                      = canonicalizeTools(config.tools)  (DB wins)
                        ?? ROLE_BOUNDARIES[bounded-name].toolAllows      (constant fallback)
```

- `assertWorkerTask` already fails closed: no `x-worker-id` → 403
  `MISSING_WORKER_ID`; worker not bound to the task's team or no session for the
  caller → 403 `FORBIDDEN`; `selfInstanceId` mismatch → 403.
- **The matrix keys come off `Agent` (`policyId`/`agentKey`), not `AgentRole`.**
  `AgentRole` carries **no capability fields** (see the model doc-comment,
  `schema.prisma:124-151`: “无任何能力字段：permission/tools/model/worker 属
  ExecutionPolicy / Agent，不是角色属性”). `TeamMember.roleId` only carries the
  *prompt/label* binding. Do not route the allowlist lookup through
  `TeamMember.roleId`; route it through `Agent.policyId` (the DB row that
  `/agent-policies` and the worker injection both consume).

## 3. Per-tool identity table

Full table (all 29 tools, with required/optional/absent per field) lives in the
evidence file under `identity_table`. Summary of the cases todo 3 must handle:

- **24 tools** require `selfInstanceId` → `assertWorkerTask`/`resolveExecContext`
  returns a concrete `callerId`; the role lookup is unambiguous.
- **`channel_send` carries NO identity at all** (`{target, text}` only) and does
  not call `resolveExecContext`. It derives the task from the worker's most recent
  session (`service.ts:5586-5598`, `SESSION.findFirst({workerId})` ordered by
  `createdAt desc`) and then calls `assertWorkerTask(ctx, taskId)` **without**
  `selfInstanceId`. Caller identity is therefore only the “most recent session on
  this worker” — which is not necessarily the session that invoked the tool.
- **4 tools omit `selfInstanceId` but require `taskId`** — `doclib`, `task_context`,
  `read_file`, `team_view` (plus `memory_search`, team-scoped, no `selfInstanceId`).
  `assertWorkerTask` still returns the session's `teamMemberId ?? agentId`.
- **`wecom_reply`** has both fields optional and backfills them from the worker's
  most recent session (`service.ts:4152-4154`).

## 4. Unresolvable-identity policy (binding for todo 3)

**Rule: `tools/call` is fail-closed. If the caller's role/tool matrix cannot be
resolved to a definite `allow`/`ask` entry, refuse with 403 + a stable error code.**

Applied per case:

| Case | Decision |
| --- | --- |
| No `x-worker-id` | already 403 `MISSING_WORKER_ID` today — keep; do not add a second check |
| Worker not bound to the task/team | already 403 `FORBIDDEN` — keep |
| `selfInstanceId` missing (`channel_send`, `memory_search`, the 4 task-bound read tools, `wecom_reply`) | resolve via the existing session lookup; if no member resolves, **403** |
| Tool name neither bare-registered nor present in the matrix | **403** (treat “not listed” = deny) — matches `filterToolsMatrix`/`isToolAllowed` semantics |
| Member resolves but `Agent.policyId`/`agentKey` yields `null` from `resolveByAgent` | **403** |
| Resolution throws | **403** (log, do not fall through to allow) |

### Justification — and the deliberate divergence from `role-guard/policy.ts`

`worker/src/role-guard/policy.ts` **passes through** when identity is unresolvable
(branches 1 and 2 at `policy.ts:109-121`, with the explicit comments “绝不
fail-closed”, mirrored in `session-policy-map.ts`'s “未映射会话 guard pass-through”).
That leniency is correct for *that* layer: the plugin hooks the engine's own tool
pipeline, where a missing session→role mapping would otherwise brick an
unrecognised agent, and the thing being guarded (`edit`/`bash`/`task`) is *also*
guarded by the engine's own native `permission` config (layer ①), so a
pass-through leaves the real confinement intact.

The server-side check has no such backstop. It is the **only** thing standing
between a live caller and a platform tool such as `task_transition` or
`question_confirm`; today the sole guard is the emitted `vteam_*: deny` entry in
the opencode permission config, which todo 4 removes and todo 5 stops feeding.
If the server also passed through on an unresolvable caller, removing the worker
layer would leave those tools **unguarded** — exactly the failure this plan exists
to prevent. Fail-closed is therefore required here, and it introduces no new
failure mode for legitimate callers: every current in-band caller reaches a tool
through a real session, so `assertWorkerTask`/`assertWorkerTeam` already resolve,
and every resolvable member maps to an `Agent` with a matrix (all 7 live members
carry a non-null `role_id` and template agents carry `policy_id`).

**Precedent for the strict posture already exists in-repo:** `assertWorkerTeam`
returns 403 when the worker↔team binding is absent (`service.ts:5935-5943`), and
`assertWorkerTask` 403s on a missing session (`service.ts:5840-5844`). The
server-side check is additive on top of the same posture, not a new philosophy.

## 5. Today's `vteam_*` matrix (for todo 3's intended behaviour)

Captured live from `GET /api/v1/agent-policies` (raw in evidence
`live_agent_policies`). Every `vteam_*` entry currently emitted in
`permission` is `deny`; there is **no** `vteam_*` explicit `allow` anywhere
(`tools` matrices carry the allows). For all 7 builtins:
`permission` = `edit`/`read`/`bash`/`task` + the role's `mcpDenies` complement,
and `guard.roles[<name>].tools` = the role's `toolAllows` (12–27 keys).

Non-`vteam_` keys present in the `tools` matrices — `browser` and the `git_*`
family (`git_clone/pull/fetch/status/diff/log/push`) — are **worker-injected
custom tools, not ours**. Todo 3 must scope its check to the 29 registered
platform tools and leave these keys untouched (they have no platform-mcp
`tools/call` surface).
