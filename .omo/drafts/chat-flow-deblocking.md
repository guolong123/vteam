# chat-flow-deblocking — intake draft (analysis-only, no plan yet)

> Status: **awaiting-approval** (approach brief presented; plan NOT yet written)
> Intent: **CLEAR** (user named concrete symptoms: plan/task state blocking, agents stuck one-by-one, can't create issues)
> review_required: **true** (user asked "帮我再分析一下看看能不能一起解决掉" on top of an existing high-accuracy-review request)
> Owner request (verbatim): "现在的群聊中有太多特定逻辑了，比如计划状态的流转、任务状态流转之类的，这边有考虑进去吗，感觉现在功能很难用，agent一个个都被阻塞，不能创建issue之类的，帮我再分析一下看看能不能一起解决掉。"

## What the user is complaining about (5 distinct themes)

| # | Theme | User words |
| --- | --- | --- |
| A | Plan-state drives message/dispatch blocking | "计划状态的流转" |
| B | Task-state drives blocking | "任务状态流转之类的" |
| C | Agents blocked/stuck, serialized one at a time | "agent 一个个都被阻塞" |
| D | Agents cannot create issues | "不能创建 issue 之类的" |
| E | Too much special-case logic in group chat | "群聊中有太多特定逻辑了" |

## VERIFIED root causes (file:line, read from disk this session)

### A — plan-state gating (two layers, the single biggest blocker)
- `platform-mcp.service.ts:1594` → `checkPlanExecutionAllowed` (`:2194-2223`): allows dispatch **only** when `plans.status === 'executing'` (or row absent). Any other state → `triggered:false, reason:'plan-gated'`, message **not persisted**, target **not woken** (`:1588-1625`).
- `worker-dispatcher.ts:1513-1553` `assertPlanExecutionAllowed`: second defense, **throws** `计划未放行：…（需 executing…）`. Called from `dispatchAgentMention` for `kind=execution` (`:1439-1457`).
- Plan states (`plan-lifecycle.service.ts:40-48`): `draft / reviewing / pending_final / approved / rejected / executing / completed`. Only `executing` passes. `reviewing` and `rejected` are **declared but never written** by any transition (dead states).
- Reaching `executing` requires a **user** action chain: convergence N/N → `pending_final` → user `finalize` → `approved` → user `confirm` → `executing` (`plan-lifecycle.service.ts:300-354`).
- Consequence: while a plan is in any pre-`executing` state, **no agent can dispatch execution work**; they can only produce/review the plan.

### D — why agents cannot create issues (the exact answer)
- The tool is exposed as `vteam_issue_create` and gated by the **worker role guard** (server does NO role check).
- `agent.constants.ts`: `vteam_issue_create: 'allow'` appears at **:299 (vteam-product), :421 (vteam-tester), :467 (vteam-project_manager)** only. The other four boundaries — `vteam-architect` (:322), `vteam-developer` (:361), `vteam-plan` (:487), `vteam-librarian` (:515) — **do not list it** → deny.
- Deny is emitted worker-side: `worker/src/role-guard/policy.ts` → `role-guard-plugin` throws `【越界拦截｜角色：…】不能调用 vteam_issue_create…请把该工作转交 {handoffTarget}…`.
- So: **developer / architect / plan / librarian cannot create issues**; product / tester / project_manager can. Server-side `issueCreate` (`platform-mcp.service.ts:2717-2736`) only checks team membership, not role.
- `ISSUE_DETAIL_ROLE_KEYS` (`worker-dispatcher.ts:349`) likewise limits full Issue instructions to product/tester/developer.

### B — task-state gating
- `worker-dispatcher.ts:1439-1451`: `kind=execution` on `completed`/`archived` task → throws `任务 … 已终态终止…请主 Agent 调用 task_create 创建新任务后再派发`.
- `tasks.service.ts:1316-1318` completion preflight: task cannot be accepted/archived until `planStatus === 'completed'`.
- `issues.service.ts:229-234, 295-300`: issue creation blocked (409 `ISSUE_TASK_ARCHIVED`) on archived tasks.
- `chat.service.ts:1125-1180`: task in `queued` (or non-head) → dispatch suppressed, triggers rewritten to `queued`.
- FIFO: same team's tasks serialize (`team_queues`, `promoteNext`), so a team works **one task at a time**.

### C — agents stuck / one at a time
- Per-team FIFO (`team_queues`, `promoteNext`) → serial task execution.
- `mention-throttle.ts`: pair max **3 / 60s**, task budget **20 / 120s**; exceed → `reason:'throttled'`, no dispatch.
- `platform-mcp.service.ts:2149-2187` issue lock → same-assignee re-dispatch returns `reason:'duplicate'`.
- `platform-mcp.service.ts:1747-1751, 1811-1821` join-pending: sub→main `answer` reports are persisted but **never open a turn on the main agent** (`triggered:false, reason:'join-pending'`); convergence relies on a JOIN drain.
- `notify_agent` routing: non-main → non-main is **403** (`PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION`); only the main agent may dispatch peers. Every peer-to-peer coordination must round-trip through the main agent.

### E — hardcoded / name-keyed special-casing (drift risk)
- `PLAN_AGENT_ID = 'a_plan'` duplicated in `worker-dispatcher.ts:90`, `platform-mcp.service.ts:123`, `review-verdict.listener.ts:35`.
- `VTEAM_AGENT_NAMES` (`worker-dispatcher.ts:106-114`), `AGENT_POLICIES_ORDER` (`execution-policy.service.ts:366-374`), `PLAN_DUTY_AGENTS` (`opencode-agent-duty.ts:29-33`), `ROLE_BOUNDARIES` (`agent.constants.ts:282-547` **re-declared in `seed.ts:120`**), `OMO_AGENT_NAMES` (`worker/src/resources/omo-config.ts:56-71`).
- `ROLE_LABELS` triplicated: `teams.service.ts:35`, `tasks.service.ts:53`, `seed.ts:2101`.
- Worker `vteam-plan` literal: `worker/src/role-guard/policy.ts:189-196` (task tool), `worker/src/exec/exec-server.ts:1129` (`startsWith('vteam-')`).

## Coverage by the EXISTING four plans — GAP MAP

| Theme | Covered by plans 1–4? | Note |
| --- | --- | --- |
| A plan-state blocking | **NO — and forbidden** | `plan-review-execution-gates.md:31` and `plan-finalize-actions.md:33` forbid touching the task state machine / throttle / RBAC / gate skeleton. Plan 4 only **re-points** plan-candidate selection; it does not relax the gate. |
| B task-state blocking | **NO** | The terminal-task gate + completion preflight appear in **no plan file**; they were landed ad-hoc (notepad only). Existing plans forbid task-state-machine changes. |
| C one-at-a-time / routing | **PARTIAL — wrong axis** | Plan 4 removes server-side `Agent.role` name-keying, but the worker `vteam-plan` literal and `startsWith('vteam-')` gate are **explicitly out of scope** (`agent-role-decommission.md:34`, and `:182` states a worker-side change is "a separate worker-side plan"). Throttle/join are untouched and fenced off. |
| D issue_create deny | **NO — only manually workaround-able** | Plan 1 makes permissions editable per-agent (so an admin could hand-enable it), but **no plan changes the default matrix**. `vteam-default-permission-matrix-fix` added chat_history/doclib/wecom but **not** issue_create. |
| E name-keyed logic | **PARTIAL** | Plans 2/4 de-hardcode role→agent and prompt assembly, but all four plans **forbid `worker/**` changes**, so the worker-side literals remain. |

**Verdict: a FIFTH plan is required.** Themes A, B, C, D are unowned; the two landed gate plans explicitly fence off the very files (task state machine, chat partition, throttle, RBAC, gate skeleton) a fix would touch. Themes A–C cannot be fixed by extending plans 1–4.

## USER ARCHITECTURE DECISION (verbatim, overrides option-1/2/3 below)
> "我不希望引入系统自己的门禁机制，应该全部由agent自身的工具权限来控制，只要有任务/计划流转权限的agent就能操作，而不是在server端再做一次验证，server端只控制流程的状态流转等参数校验，不做agent自身权限的校验"

**The target architecture (this is the plan's spine):**
- **Single source of truth = the agent's OWN tool permission** (worker-side role guard / native permission + MCP tool allowlist). One layer, no duplication.
- **Server MUST NOT do agent-permission validation.** Delete the server-side "system gate" mechanisms that re-check whether an agent is *allowed*.
- **Server ONLY keeps: flow state-machine legality + parameter validation** (legal from→to transitions, CAS/optimistic lock, idempotency, DTO/schema/enum/required-field checks, terminal-state immutability).
- A restricted agent is restricted by **its tool allowlist**, not by a server gate. If a role should be able to do X, grant it the tool — do not add a server check.

**Classification this forces (to be made decision-complete):**
- DELETE (server-side agent-permission / "system gate" duplication): `checkPlanExecutionAllowed` plan-gated, `assertPlanExecutionAllowed`, notify main-only routing (`NOTIFY_ROUTING_VIOLATION`), join-pending suppression, throttle pair/task budget as a hard block, issue lock `duplicate`, review-triplet gate, terminal-task execution dispatch gate, task-completion preflight coupling, all `main-agent-only` identity gates (`task_create` / `memory global` / `plan_mode` / `plan_complete` / `question_confirm`).
- KEEP (server state + param): `transition()` from-state + CAS + idempotency, illegal-transition 409, DTO/zod/glob validation, archived = immutable terminal.
- MOVE authoritative permission to the worker tool layer, and **rebalance `ROLE_BOUNDARIES` defaults** so roles that need task/plan/issue transition tools have them.
- `issue_create` deny for architect/developer/plan/librarian is the agent's OWN tool permission — it is the *correct* layer; the fix is to grant the tool where the duty requires it, not to add a server check.
- Worker change is **AUTHORIZED** (user confirmed) — the worker guard is the intended single source.
- Guard specs that will fight this (`no-tighten-audit.spec.ts`, `plan-removal.guard.spec.ts`, `e2e-permission-matrix.sh`) must be enumerated and folded into the plan.

**Status: awaiting-approval** — approach brief presented; exploration for the remove/keep inventory + fence inventory in flight.

## Scope question to resolve with the user (owner-decision, not discoverable) — RESOLVED

The one thing exploration cannot decide for the user — **what "solve it" means**:

1. **Relax / remove the gates** (make agents free to work: drop `plan-gated` for non-plan work, allow issues for all roles, loosen throttle) — biggest usability win, highest risk of reintroducing the runaway-loop / unverified-plan problems those gates were built to stop.
2. **Keep the gates but make them explicit & non-blocking** (gates stay, but a blocked agent gets a clear, actionable path instead of a silent drop; add an override/force path surfaced in the UI).
3. **Fix only the concrete blockers now** (issue_create defaults + the silent `triggered:false` drops + one-at-a-time) and leave the plan/task state machines alone.

This is an owner-decision because it trades safety invariants (which the team deliberately built) against throughput — irreversible in direction and a product choice the user lives with.

## THE STRUCTURAL CORE (verified `agent.constants.ts:213-221`)

`defineBoundary()` derives `mcpDenies` as `VTEAM_MCP_TOOL_NAMES − toolAllows − SERVER_GATED_SET`.
So a server-gated tool is **deliberately excluded from BOTH the allowlist and the denylist** — it is
neither allow nor deny at layer ①, and the worker's guard explicitly returns **allow** as pass-through
(`policy.ts:200-202`). **This exclusion IS the "server authorizes" mechanism.**

Consequence: the 5th plan's core edit is to **stop excluding `SERVER_GATED_SET` in `defineBoundary`** and
instead put each of the relevant tools explicitly into the `toolAllows` of the roles that should have it.
Without that edit, deleting only the server checks grants **every mapped role all gated tools** (all-powerful).

Pinned by multiple test layers (all will go red):
- `agent-policies.matrix.spec.ts:129-135` — layer① must have **no key** for any server-gated tool
- `worker/src/role-guard/policy.spec.ts:271-296` — all 7 pass-through allow; set must be exactly 7
- `agent-policies.custom-agents.spec.ts` + `.snap` + `before-agent-policies.json` byte-identity;
  `no-tighten-audit.spec.ts` freezes a 16-file gate-spec list; `plan-removal.guard.spec.ts` forbids
  any new `server/src/plans/**`, new `PLAN_STATUS` constant, or new `prisma.plan` access
- `scripts/e2e-permission-matrix.sh:195,438` — asserts the gated set is exactly **5** (stale vs 7 in source)
  and that `vteam-developer → vteam_issue_create = deny`

## CROSS-PLAN CONFLICT (must be resolved by sequencing)

The 5th plan and the four existing plans all edit the SAME artifacts:
`server/src/common/constants/agent.constants.ts` (`ROLE_BOUNDARIES`), `/agent-policies` emission,
and the worker role-guard — and each has byte-identity/snapshot fences.
- Plan 1 makes the 4 native rows editable; plan 2 adds `AgentRole`; plan 4 drops `Agent.role`.
- The 5th plan rewrites `ROLE_BOUNDARIES.toolAllows` + removes the `SERVER_GATED_SET` exclusion.
Running them in parallel is guaranteed to conflict → **sequencing is an owner-decision (asked).**

## FINAL SCOPE DECISION (verbatim): "只拆A+B"

**IN SCOPE — remove server-side AGENT-PERMISSION validation:**
- **A — 9 main-only MCP gates** (server 403 re-checks of agent identity):
  `task_create` (`:2948,2967`), `skill_create` (`:3021,3035,3053`), `memory_save` global (`:3149,3281`),
  `memory_update` global (`:3432`), `team_add_member` (`:3920`), `plan_mode` (`:4030-4035`),
  `plan_complete` (`:4086-4091` + `plan-lifecycle.service.ts:489`), `task_transition` main-only
  (`tasks.service.ts:1413-1418`), `question_confirm` (`questions.service.ts:290-295`).
- **B — task state-machine agent-permission gates**: `transitionByAgent` main-only; `accept`/`archive`
  forbidden for *all* agents (`tasks.service.ts:1395-1401`).
- **Plus the worker-side enabler**: remove the `SERVER_GATED_SET` exclusion in `defineBoundary()`
  (`agent.constants.ts:213-221`) and instead grant the relevant tools to the right roles in
  `toolAllows`, so "有工具权限的 agent 就能操作" is actually true.
- **Plus ROLE_BOUNDARIES rebalance**: grant `vteam_issue_create` to the roles whose duty needs it
  (architect/developer/plan/librarian currently lack it), and grant the task/plan transition tools
  to whatever role should own them.

**OUT OF SCOPE — KEEP (collaboration / routing / prompt semantics, NOT permission):**
- **C** `notify_agent` routing (non-main→non-main 403, self-notify 403) — collaboration protocol, anti ping-pong.
- **D** group chat no-@ → main agent; zero-task team direct chat no-@ → main (`chat.service.ts:865-871`).
- **E** main vs non-main instruction injection (`worker-dispatcher.ts:524-526`, `:568`).
- **F** join-pending reply-join suppression / fan-out drain convergence.

**UNDECIDED — the flow-state / coordination gates (NOT in A+B, NOT in C/D/E/F):**
These apply to *all* agents regardless of identity, so they are not "agent-permission" gates; but two of
them are pure *flow state* (which the user said the server SHOULD keep) and others are abuse/idempotency:
| Gate | Nature | `plan-gated` | flow state (plan.status must be `executing`) + an `a_plan` identity exemption |
| terminal-task execution gate | flow state (task completed/archived) |
| throttle (`pair_limit`/`task_budget`) | abuse control — neither permission nor flow state |
| issue lock (`duplicate`) | idempotency / concurrency |
| review-triplet | dispatch parameter contract validation |

## DECISIONS LOCKED (final)

| # | Decision | Value |
|---|---|---|
| D1 | Architecture | No system gates. Permission = agent's OWN tool permission. Server keeps ONLY flow state-machine legality + parameter validation. |
| D2 | Scope | **只拆 A+B** (remove server-side agent-PERMISSION validation) |
| D3 | `plan-gated` | **ALSO REMOVE** (dispatch no longer requires `plan.status === 'executing'`) |
| D4 | Terminal-task dispatch gate | **KEEP** (must still refuse execution dispatch into `completed`/`archived`) |
| D5 | C/D/E/F (notify routing, no-@→main, main instruction split, join-pending) | **KEEP** — collaboration/routing/prompt semantics, NOT permission |
| D6 | `Team.mainAgentMemberId` | **KEEP** (still needed by C/D/E/F); only its use as a *permission* check in A is removed |
| D7 | Worker change | **AUTHORIZED** (user confirmed) — worker guard is the intended single source of authority |
| D8 | Sequencing | **5th plan FIRST**, then the four role plans on top of it |

**Still-open flow/coordination gates (NOT in scope; carry forward as-is):** throttle (`pair_limit`/`task_budget`),
issue lock (`duplicate`), review-triplet. These are abuse/idempotency/contract, not agent permission — a
later plan can revisit if they still block in practice.

**Plan slug: `server-gate-removal-tool-authority`**
**Status: PLAN WRITTEN** (`server-gate-removal-tool-authority.md`; 12 implementation todos + F1-F4). Metis findings folded in: grant matrix, four-copy inventory, DB backfill, hash split, retained-check allowlist, code-not-line targeting, re-baseline authorization, both-failure-mode mutation checks. Next: dual high-accuracy review (momus + oracle).

## METIS GAP ANALYSIS — findings verified (blocking; plan NOT written)

Verdict: **do not write the plan yet.** Two decisions must exist first, or the plan cannot be decision-complete.

### F1 (BLOCKING) — no grant map, and "main" has no static owner
Worker `toolAllows` are keyed by **role** (`ROLE_BOUNDARIES` keyed by `vteam-<role>`); "main" is a
per-**instance** runtime attribute (`Team.mainAgentMemberId`, default product). A static role allowlist
**cannot express "whoever is main"**. So after removing the server main-gates, exactly one of:
(i) grant the 7 tools to all roles = all-powerful; (ii) grant to one role = main must be that role;
(iii) grant to none = the main workflow dies.
Verified: product's `toolAllows` (`agent.constants.ts:296-319`) contains **none** of the 7 gated tools —
so the default main literally cannot `task_create`/`plan_mode`/`task_transition` after removal.

### F2 — the brief's failure-mode premise is INVERTED
Removing the server checks while LEAVING the `SERVER_GATED_SET` exclusion + worker passthrough = **all-powerful**.
Removing the exclusion but NOT granting = **deny-all** (`policy.ts:214-219` fallthrough → deny).
Both catastrophic, opposite directions; the plan must state both and make the change atomic.

### F3 — FOUR copies of the constant, not one
`agent.constants.ts:155-166,213-220`; `seed.ts:70,80,83-88`; `worker/.../policy.ts:103-111,200`;
`worker/.../role-guard-plugin.ts:90-98,158` (+ compiled `dist/` used by e2e).

### F4 — DB `config.tools` WINS over the constants
`resolveGuardTools` (`execution-policy.service.ts:262-272`): a valid DB `config.tools` overrides the
constant fallback. Editing `toolAllows` alone does **not** reach production — a data migration/seed
refresh of `ep_<role>.config.tools` is required.

### F5 — the cited removal range silently deletes the planHash gate
`platform-mcp.service.ts:1594-1625` contains the stale-hash check (`:1597-1602`); `worker-dispatcher.ts`
`assertPlanExecutionAllowed` contains it at `:1541-1547`. D3 only authorized removing the *status* gate.

### F6 — removing plan-gated leaves "no execution before an approved plan" unowned
Today a missing row is auto-created `draft` and still blocked (`plan-lifecycle.service.ts:147-171`).
After removal, execution can dispatch on a `draft`/`rejected` plan; `plan_complete` still requires
`executing`, leaving the machine half-enforced.

### F7 — THREE gates are authority, not identity (security)
- `plan_mode`: the gate (`:4022-4027`) guards a body that **writes the MAIN member's `opencodeAgentName`** (`:4033-4035`) → a non-main caller could hijack the main's execution agent.
- `question_confirm`: `questions.service.ts:290-295` gate → `forwardReply` (`:317-321`) resolves any kind incl. `permission` → **self-approval** by the requesting agent.
- global memory (`:3143-3151, 3267-3283, 3422-3434`): becomes writable by any member.

### F8 — three cited anchors are WRONG (verified myself)
- `team_add_member`: gate is `:3907-3912`, NOT `:3920` (that is the NotFound/duplicate message).
- `plan_mode`: gate is `:4022-4027`, NOT `:4030-4035` (that is the `task.update` write).
- `plan_complete`: gate is `:4062-4068`, NOT `:4086-4091` (that is the `wecomReply` doc comment).
Deleting by line number would destroy innocent logic. Reference by error code, never line.

### F9 — re-baseline is not authorized
`before-agent-policies.json` + sha `793093dc…` (pinned `scripts/e2e-role-boundaries.sh:90`),
`.snap`, `agent.constants.spec.ts:93-120`, `agent-policies.matrix.spec.ts:119-136`,
`worker/.../policy.spec.ts:269-296`, `no-tighten-audit.spec.ts:27-34` (`GATE_SPEC_FILES.length === 16`),
`plan-removal.guard.spec.ts:104-123` (requires `plan-lifecycle.service.ts` to stay the plan choke point),
`scripts/e2e-permission-matrix.sh` (step 4 asserts the OLD 403s; step 5 asserts **5** gated vs 7 actual — already broken).
Also the Web UI renders `serverGated` as read-only (`web/app/(main)/agents/page.tsx:635-645,857`).

### F10 — accept/archive has a THIRD site
`platform-mcp.service.ts:2825-2831` throws `TASK_AGENT_COMPLETION_FORBIDDEN`, plus
`tasks.service.ts:1395-1401`. Adjacent to the main-only block at `:1413-1418` — line-range deletion risks clipping it.

### F11 — D2's wording is self-contradictory
"server keeps ONLY flow legality + params" is false while D4 keeps the terminal gate, D5 keeps the routing
403, and accept/archive is retained. Needs a precise invariant: worker = single source for **tool-permission**;
server retains **flow-state legality + topology routing + human-authority** gates, each enumerated.

### F12 — `vteam_issue_create` rebalance is unrelated creep
It is NOT in `ROLE_SERVER_GATED_TOOLS`; its absence from architect/developer/plan/librarian is a pre-existing
role-boundary decision. Granting it here collides with the four role plans (D8) and is unmeasurable as "done".

### F13 — no falsifiable AC for "permission moved to the worker"
Needs: per-role worker allow/deny matrix + server no-longer-403 + retained-403 allowlist + terminal refusal.

## DECISIONS LOCKED — ROUND 2 (resolves Metis F1-F13)

| # | Decision | Value |
|---|---|---|
| D9 | Grant matrix (resolves F1) | **按职责分工**: task_transition / task_create / plan_mode / team_add_member / question_confirm → product + project_manager; plan_complete → plan + project_manager; skill_create → project_manager; issue_create → product, tester, project_manager, developer, architect (NOT plan/librarian). "Main" ceases to be a capability identity — capability follows the role's tool grant; the main designation still governs C/D/E/F only. |
| D10 | Authority gates (resolves F7) | `plan_mode` + `question_confirm` main-gates **REMOVED** (user: 全拆，记录风险). Residual risk recorded: a product/PM instance calling `plan_mode` writes the MAIN member's `opencodeAgentName`; a product/PM instance could confirm its own request. Mitigation is by construction: developers/architects/testers do NOT hold `question_confirm`, so a requesting subordinate cannot self-approve. |
| D11 | planHash gate (resolves F5) | **RETAIN** the stale-hash check; remove only the `plans.status='executing'` requirement. Extract it so it survives on both layers; keep its specs + `GATE_SPEC_FILES` entries. |
| D12 | Re-baseline (resolves F9) | **AUTHORIZED**. Supersede list: `before-agent-policies.json` + sha constant, `.snap`, `agent.constants.spec`, `agent-policies.matrix.spec`, `worker/.../policy.spec` + `role-guard-plugin.spec`, `GATE_SPEC_FILES` count, `policy-canonical.spec`, `seed.spec`, both e2e scripts. Also fix the pre-existing 5-vs-7 inconsistency in `e2e-permission-matrix.sh`. |
| D13 | Memory global scope (resolves F1/F7 residual) | **RETAIN** the global-level memory write rule, reclassified as a **resource-scope rule** (the `memory_save`/`memory_update` tool is shared across team/global scopes, so a role allowlist cannot express "global only for PM"). Documented residual: a non-main PM instance cannot write global. Listed in the retained-server-check allowlist. |

## METIS FINDINGS — outcome
- F1 resolved by D9 (+ D13 for the memory residual).
- F2 accepted: the three-part change (remove exclusion + remove worker passthrough + add grants) is ONE commit; both failure modes (all-powerful / deny-all) get negative tests.
- F3 accepted: FOUR source copies + compiled `dist/` rebuild are in scope.
- F4 accepted: DB `config.tools` backfill is a required todo.
- F5 resolved by D11. F6 accepted (recorded replacement). F7 resolved by D9/D10/D13.
- F8 accepted: **all gate targets are referenced by error code / message string, never by line number.**
- F9 resolved by D12. F10 accepted (three accept/archive sites). F11 accepted (precise invariant). F12 accepted (issue_create declared in-scope here; the four role plans rebase on it). F13 accepted (executable matrix is a required todo).
- **F14 (new) — `question_confirm` must be GRANTED or managed-mode breaks**: removing its main-only gate without a tool grant leaves it denied to every role (worker denies unlisted). Covered by D9.

## REVIEW ROUND 1 — both REJECT; consolidated defects

**Momus**: `MOMUS VERDICT: REJECT` (plan sha `c0501b54…`). **Oracle**: `INDEPENDENT VERDICT: REJECT`.

| ID | Sev | Defect | Fix |
|---|---|---|---|
| R1 | HIGH | Re-baseline list omits `server/src/prisma/seed.spec.ts` (imports `ROLE_SERVER_GATED_TOOLS`, asserts `not.toHaveProperty(gated)` + `toContain('vteam_plan_complete')`) → suite cannot go green. Also omits `scripts/e2e-plan-member.sh` + its `F3-own` baseline. | add all three to todos 7/8 |
| R2 | HIGH | Dependency matrix says todos 2,3,4 may parallelize; execution strategy says serial. Landing 2 before 4 = the all-powerful window. | invert: 4 blocks 2 and 3; no parallel cells |
| R3 | HIGH | `question_confirm` after gate removal allows self-approval + cross-team confirmation (`confirmByAgent` never compares `row.taskId`). | add integrity checks (confirmer ≠ requester; request belongs to caller's task) + record residual |
| R4 | HIGH | Static role grant vs dynamic main: `mainAgentMemberId` is user-selectable to ANY member; a developer/architect main would hold none of the coordination tools. | document consequence + test; keep D9 (do NOT grant to all) |
| R5 | MED-HIGH | "green at every step" is unachievable: todo 4 changes the constants the frozen specs pin; todo 7 is a later wave. | make 4/5/6/7 ONE atomic commit; require green only at the end |
| R6 | MED | `hook_cancel` main-or-owner 403 is neither removed nor in the retained allowlist → todo 1 completeness check unsatisfiable. | classify as RETAINED (resource ownership) |
| R7 | MED | plan-status removal also removes `autoEnsureRow` row creation → `completePlan`/`loadWritablePlan` can fail. | keep row-ensure; remove only the status refusal |
| R8 | MED | `a_plan` exemption skips the ENTIRE guard incl. the hash check → stale hash passes. | remove the exemption; hash runs for all targets |
| R9 | MED | DB backfill only rewrites `config.tools`, not `config.permission` → layer-① permission diverges. | backfill/reconcile `config.permission` too |
| R10 | LOW-MED | `vteam_issue_create` is not formerly-gated; granting to developer/architect is a net expansion. | declare as intentional, separate from "formerly-gated" |
| R11 | LOW | "nine gates" miscount (8 distinct sites); `planMode` can target `id: null` after gate removal. | fix the count/derivation; handle null main |
| R12 | LOW | `isPlatformToolForHandoff` (policy.ts + plugin) also references the set. | name both call sites in todo 4 |

## REVIEW ROUND 1 — both REJECT; ALL defects fixed (round 2 pending)

All 12 defects (R1-R12) folded into the plan. Key structural changes:
- **Todos 2-7 are now ONE atomic commit** (was: separate commits with a serial narrative and a contradictory parallelizable matrix). Greenness contract moved to "green at the END of the flip".
- Added `seed.spec.ts` + `scripts/e2e-plan-member.sh` to the re-baseline/rewrite scope.
- `question_confirm`: added two integrity checks (confirmer ≠ requester; request belongs to caller's task) + a proof todo.
- `hook_cancel` classified RETAINED (resource ownership); added to the retained allowlist + proofs.
- Plan-hash: removed the `a_plan` exemption so the hash runs for every target.
- Plan-row creation (`autoEnsureRow`) explicitly preserved.
- DB backfill now covers `config.permission` as well as `config.tools`.
- `plan_mode` null-main handled; removal count corrected to **8 distinct sites**.
- `isPlatformToolForHandoff` call sites named.
- Added an ordering proof (no all-powerful intermediate commit).

## REVIEW ROUND 2 — Oracle APPROVE; Momus APPROVE-leaning (verdict line truncated) → residuals fixed

**Oracle** (`bg_43b9527d`): `INDEPENDENT VERDICT: APPROVE` — all D1-D11 verified RESOLVED against the code, including the re-check of the worker guard branch order (removing the passthrough genuinely routes formerly-gated tools to the role allowlist).

**Momus** (`bg_8c2138c8`): reasoning reached APPROVE (all 5 round-1 defects verified fixed) but its final verdict line was truncated mid-stream. It surfaced **3 residuals** that I then verified and fixed myself:
1. **Removal count wrong** — I verified by grep: there are **11 throw sites across 7 tools**, not 8 (task_create ×2, skill_create ×3, plan_complete ×2, others ×1). Fixed everywhere (TL;DR machine, Must-have, todo 1(a) with per-tool counts, todo 2, success criteria).
2. **Transitive/`Blocks` mismatch** — todo 7 inline `Blocks: 8,9,10,11` vs matrix `Blocks: 8` (direct). Normalized inline to direct `Blocks: 8`.
3. **5↔6 parallel cells** vs the "strictly serial internally" narrative — removed the parallel cells (both `—`).
Also fixed the TL;DR grant-matrix contradiction (it implied product holds nothing while decision 1 grants it issue_create): now names exactly what a product main lacks (`plan_complete`, `skill_create`).

**Caveat recorded:** Momus's round-2 verdict line was never captured (transcript saved mid-stream). Its reasoning text stated all 5 fixes verified and the residuals were cosmetic/documentation; it explicitly weighed "APPROVE is defensible". A conservative reading requires a fresh Momus round to obtain an unambiguous verdict line before handoff.

## REVIEW ROUND 3 — BOTH APPROVED, then one self-caught error → round 4 dispatched

**Momus** (`bg_8506cc90`, plan sha `a56b82e3…`): `MOMUS VERDICT: APPROVE` (first and last line, unambiguous). Independently re-derived the count from source: 11 removal sites / 7 tools — exactly matching. Verified all 5 round-1 defects fixed, all 4 post-round-2 edits present, matrix ↔ every inline annotation, counts agree, structure exact (12+4 rows), every todo complete. Remaining defects: **none blocking**.

**Oracle** (`bg_007b69e3`): `INDEPENDENT VERDICT: APPROVE` (first and last line). Re-verified D1-D11 against the code, re-checked the worker guard branch order, and re-derived the throw-site count.

**Then I self-caught a defect both reviewers missed:** line 16 claimed a `plan`-role main "will hold none of … `plan_complete`", but the grant matrix grants `plan_complete` TO `vteam-plan`. Fixed to the exact per-role statement (developer/architect/tester/librarian hold none; `plan` holds only `plan_complete`; `product` holds five but not plan_complete/skill_create).

**Because the plan changed after approval, both verdicts are invalidated by the strict rule → round 4 dispatched** (scoped to the one-line correction; both reviewers told to cross-check every role claim against the grant matrix).

## REVIEW ROUND 4 — BOTH APPROVED; HIGH-ACCURACY GATE CLOSED

**Momus** (`bg_2d9c9483`, sha `6cbfe5c8…`): first and last line `MOMUS VERDICT: APPROVE`. Verified line 16 now agrees with the todo-1(d) grant matrix, cross-checked every named role (developer/architect/tester/librarian hold none of the 7; `plan` holds only `plan_complete`; `product` holds five but not plan_complete/skill_create), confirmed counts/matrix/structure unchanged, no new contradiction.

**Oracle** (`bg_530ff594`): first and last line `INDEPENDENT VERDICT: APPROVE`. Independently verified against the real constants and re-derived the throw-site counts (2+3+1+1+2+1+1 = 11 across 7 tools), and confirmed the grant-matrix role claims.

**One honest caveat Oracle raised:** there is no committed round-3 snapshot, so the claim "only line 16 changed since round 3" could not be byte-verified; Oracle instead verified the current file is internally consistent and matches round-3's described properties. The round-4 file (sha `6cbfe5c8…`) is the reviewed and approved artifact.

**GATE CLOSED:** 4 rounds, both reviewers APPROVE the same file, no blocking defects. Plan is decision-complete and ready for handoff.

## Must-NOT-Have fences discovered (a 5th plan must not "extend" these)
- `plan-review-execution-gates.md:31` — 不改…任务状态机、群聊分区、throttle限额/窗口、mcpDenies/toolAllows/RBAC
- `plan-finalize-actions.md:31-35` — 不重建定稿门…不碰throttle配额/RBAC矩阵/任务状态机；不在C3审计里收紧任何现行放行（收紧需单独立项）
- All four role plans forbid `worker/**` changes; `agent-role-decommission.md:182` sets the precedent that a worker-side gate is "a separate worker-side plan."

## Open unknowns
- Which of the three directions above the user wants (owner-decision).
- Whether a worker-side change is in scope (the worker guard is where D and the `vteam-plan` literal live) — plans forbid it today; a 5th plan must decide explicitly.
