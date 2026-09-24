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

The map is a **bijection** over all 28 registered tools (asserted by
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
       └─ TeamMember.id → TeamMember.roleId → AgentRole.capabilities   (role-owned matrix)
            └─ bare name → `vteam_${name}` → capability key (platform-capability catalogue)
                 └─ capabilities[capKey] === false  → 403
                    capabilities[capKey] missing   → ALLOW   (default-allow)
```

- `assertWorkerTask` already fails closed: no `x-worker-id` → 403
  `MISSING_WORKER_ID`; worker not bound to the task's team or no session for the
  caller → 403 `FORBIDDEN`; `selfInstanceId` mismatch → 403.
- **Authority is the post (`AgentRole`), not the executor (`Agent`).** The matrix is
  now carried **directly on the role** as `capabilities` — a `Record<string, boolean>`
  keyed by *business capability* (e.g. `task.create`, `issue.create`), not by MCP tool
  name. `Agent.policyId` still feeds the worker injector (`buildAgentPolicies`), the
  engine-native layer-① permission and template resolution — it is **not** the gate's
  authority. Rationale: **authority is the post, not the executor** — changing which
  Agent fills a role must not silently change the platform tools that role may call.

### 2.1 Capability model (2026-09-21)

- **Default-allow.** `capabilities[capKey] === false` ⇒ deny; the key **absent** ⇒
  allow. A role with `capabilities = null` is equivalent to `{}` ⇒ all allowed.
  The factory set (for roles created without an explicit matrix) pre-denies the
  sensitive points (`task.create`, `task.transition`, `task.complete`,
  `team.add_member`, `chat.channel_send`, `wecom.reply`, `issue.create`,
  `issue.get`, `issue.list`, `issue.update`, `issue.transition`,
  `skill.create`, `question.confirm`, `hook.manage`).
- **Capability catalogue is the single source of truth**
  (`common/constants/platform-capability.constants.ts`): 27 ordered entries, each
  `{ key, label, tools[], defaultDeny }`. Every `VTEAM_MCP_TOOL_NAMES` tool (28)
  belongs to exactly one capability (coverage asserted by
  `platform-capability.coverage.spec.ts`); exactly one entry (`hook.manage`) spans
  2 tools — the former grouped points `issue.manage`/`memory.manage` were split
  into per-tool points on 2026-09-22 (option (b)) to eliminate group collapse.
  A binary capability over a multi-tool group is granted only when **all** member
  tools are allowed (conservative mapping used by seed/migration).
- `AgentRole.policyId` is **removed** (migration `20260921000006`); the role no longer
  references an `ExecutionPolicy`. `execution_policies` now serves only the
  engine-native layer.
- **Genericity (Q6).** The `edit`/`read`/`bash`/`task` engine-native permissions stay
  agent-keyed and untouched; built-in tools and third-party MCPs are out of scope.
  This gate is a vteam-platform-business-capability check, decoupled from the generic
  MCP/agent mechanisms.

### 2.2 Accepted bypass — `vteam-api` / `swagger-mcp` (Q3, explicit)

This gate guards **only** the `vteam` platform MCP server (`POST /platform-mcp`).
`vteam-api` and `swagger-mcp` are independent MCP servers at the same layer as any
third-party MCP — their tools call the server over HTTP directly and **bypass this
gate entirely**. That is **explicitly accepted**: this check is an **anti-mistake
guard for agents**, **not a security boundary**. No gate is added there.

## 3. Per-tool identity table

Full table (all 28 tools, with required/optional/absent per field) lives in the
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
- **`wecom_reply`** exposes `selfInstanceId` and `teamId` as optional identity/context fields. `teamId` comes from the arguments or the worker's most recent session (`session.teamId`); legacy task sessions fall back through `session.taskId → task.teamId`. `selfInstanceId` resolves to the bound team member. The tool does not require or depend on `taskId`; legacy `taskId` input is stripped by the schema.

## 4. Unresolvable-identity policy (binding for todo 3)

**Rule: `tools/call` is fail-closed. If the caller's role/tool matrix cannot be
resolved to a definite `allow`/`ask` entry, refuse with 403 + a stable error code.**

Applied per case:

| Case | Decision |
| --- | --- |
| No `x-worker-id` | already 403 `MISSING_WORKER_ID` today — keep; do not add a second check |
| Worker not bound to the task/team | already 403 `FORBIDDEN` — keep |
| `selfInstanceId` missing (`channel_send`, `memory_search`, the 4 task-bound read tools, `wecom_reply`) | resolve via the existing session lookup; if no member resolves, **403** |
| Tool maps to **no capability** (unknown/retired tool) | **403** (unknown surface is fail-closed) |
| Member resolves but `TeamMember.roleId IS NULL` | **403** (no post ⇒ no authority) |
| Capability key present and explicitly `false` on the role | **403** |
| Capability key **absent** from the role's matrix | **ALLOW** (default-allow — the one non-fail-closed branch, by design) |

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
`question_confirm`. If the server also passed through on an unresolvable caller,
those tools would be **unguarded** — exactly the failure this plan exists to
prevent. Fail-closed is therefore required for identity and unknown tools; the
**only** deliberate allow-branch is the default-allow capability semantics
(a missing capability key ⇒ allow), which is a product decision, not a leniency:
the factory matrix pre-denies the ten sensitive capabilities, and builtin roles are
seeded from their *current* effective allow-set so they never gain authority when
the default flips. Every current in-band caller reaches a tool through a real
session, so `assertWorkerTask`/`assertWorkerTeam` already resolve, and every
resolvable member maps to a **role** with a capability matrix (all 8 live members
carry a non-null `role_id`). Members without a role are **not supported** (Q5):
`resolveMemberBinding` / `resolveTaskMemberBinding` reject a member input that
yields no role with 400 `MEMBER_ROLE_REQUIRED`.

**Precedent for the strict posture already exists in-repo:** `assertWorkerTeam`
returns 403 when the worker↔team binding is absent (`service.ts:5935-5943`), and
`assertWorkerTask` 403s on a missing session (`service.ts:5840-5844`). The
server-side check is additive on top of the same posture, not a new philosophy.

## 5. The `vteam_*` matrix and the capability catalogue

The `vteam_<action>` form is still the **tool identity** carried by
`VTEAM_MCP_TOOL_NAMES` and the engine-native agent-policy payloads
(`GET /agent-policies`, `guard.roles[<name>].tools`). It is no longer the gate's
storage form: the gate bridges bare name → `vteam_<action>` → **capability key**
(via the catalogue), then reads `AgentRole.capabilities`.

`execution_policies.config.tools` retains its `vteam_*` keys (they still feed the
engine-native `GET /agent-policies` / `GET /agents` views); those keys are **dead
for platform authority**. They are intentionally not pruned by migration
`20260921000006` (pruning would change the engine-native views).

Non-`vteam_` keys present in the `tools` matrices — `browser` and the `git_*`
family (`git_clone/pull/fetch/status/diff/log/push`) — are **worker-injected
custom tools, not ours**. The gate scopes its check to the registered platform
tools and leaves these keys untouched (they have no platform-mcp `tools/call`
surface).
