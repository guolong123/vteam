---
slug: agent-native-permission-editor
status: review_requested
intent: clear
review_required: true
pending-action: review the four plans (.omo/plans/agent-native-permission-editor.md, agent-role-entity.md, third-party-agent-display.md, agent-role-decommission.md)
review:
  momus:
    status: pending
    target: .omo/plans/agent-native-permission-editor.md
    scope: all four plans
    round_id: r1
    result: null
  independent:
    status: pending
    reviewer: oracle
    target: .omo/plans/agent-native-permission-editor.md
    scope: all four plans
    round_id: r1
    result: null
review_notes: |
  User explicitly requested a high-accuracy review ("走一轮高精度评审吧") after the
  four-plan split. review_required set true; the dual review (native momus + independent
  oracle) must BOTH approve before handoff. Scope = the four sequentially-executed plans:
    1 .omo/plans/agent-native-permission-editor.md  (9 todos)  - execute first
    2 .omo/plans/agent-role-entity.md               (8 todos)  - expanded this session
    3 .omo/plans/third-party-agent-display.md       (5 todos)
    4 .omo/plans/agent-role-decommission.md         (9 todos)  - highest risk
approach: Two coupled fixes. (A) Add a role picker to the create-agent form so a new agent inherits a real role policy instead of the read-only deny skeleton; the backend inheritance path already exists. (B) Make the 4 native permission rows editable in the agents page - edit/read as glob rule lists, bash as tri-state, task read-only with an engine-limit note - backed by a new native-permission mutation plus server-side validation that closes the edit-map fail-open gap. Superseded/expanded: the program is now a four-plan split (native editor -> AgentRole entity + prompt three-way split -> third-party read-only display -> Agent.role decommission).
---

# Draft: agent-native-permission-editor

## Components (topology ledger)

| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | New custom agent gets a usable permission set via a role picker (inherits `ep_<role>`) | active | `.omo/evidence/agent-native-permission-editor/` |
| C2 | The 4 native rows become editable: edit/read glob lists, bash tri-state, task read-only+note | active | (pending) |
| C3 | Server validates native permission edits safely (no `write`, edit catch-all enforced, glob shape, bash enum) | active | (pending) |
| C4 | Runtime enforcement matches what the editor writes (layer① opencode + layer② guard), incl. the fail-open fix | active | (pending) |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| `permissionScope` | not revived (dropped by migration 20260913000000) | one scheme only; documented-dead | yes |
| edit/read keep glob semantics | do NOT collapse to tri-state | collapsing would change the worker wire contract + guard semantics | no |
| worker untouched | no `worker/**` change | F3 deliberately routes around the hardcoded task exception | yes |
| `task` read-only | read-only + engine-limit note | changing it needs a worker change (out of scope per F3) | yes |
| Test strategy | tests-after + jest; Playwright for the UI; live-stack round-trip for enforcement | matches the repo's existing pattern; enforcement must be proven on the real surface | yes |

## Findings (cited - path:lines)

### Root cause 1 — the new-agent default is read-only by construction
- `server/src/agents/agents.service.ts:754-773` `buildSkeletonConfig()`:
  `permission: { edit: { '*': 'deny' }, read: { '*': 'allow' }, bash: 'deny', task: 'deny' }`, `tools: {}`.
- `create()` `:179-220` decision branch `:185-194`: explicit `policyId` → used as-is; else `resolveTemplateSource(dto.role)` → copy that policy as a NEW custom policy; else (no role / unknown role) → skeleton.
- `resolveTemplateSource` `:727-748`: `ep_<role>` row → copy; missing → `resolveConstantPolicySource('vteam-<role>')`; non-builtin/null role → `null` → skeleton.
- Comment `:751-752` documents the intent ("无命中 role 时的安全默认").

### Root cause 2 — the UI has no entry point for the 4 native rows, and no way to send `role`
- `web/app/(main)/agents/page.tsx` `NATIVE_PERMISSION_KEYS` `:598-604` (edit/read/bash/task → 文件写入/文件读取/终端命令/子任务).
- `nativeRows` `:923`; rendering `:955-998` uses **`EffectBadge`** (read-only pill). Object values (edit/read) render `glob + badge` joined by `；`; scalars render one badge.
- Editable `ToolEffectSelect` `:336-385` is used only for MCP rows `:868-883`.
- `editable` gate `:625-627` = `effective !== null`.
- `policyMutation` `:691-710` sends `{ config: { permission: effective.permission, correction, tools: nextTools } }` — **`permission` passed through unchanged**; only `tools` is written.
- **`CreateAgentModal` `onSubmit` payload `:1714` = `{ name, prompt?, persona?, agentKey }` — no `role`.** Submit `:2402` = `api.post('/agents', { ...payload, type: 'custom' })`.
- `CloneAgentModal` `:2013` / `:2377`: payload `{ name?, agentKey }` — clone inherits role from the source row.

### The backend already supports role inheritance (so C1 is mostly UI wiring)
- `server/src/agents/dto/create-agent.dto.ts:48-53` — `role?: string` optional.
- `server/src/agents/agents.service.ts:187` — `resolveTemplateSource(tx, dto.role ?? null)`.
- ⇒ a role picker in the create modal is sufficient for C1; no backend change needed for the happy path. (See OPEN-Q1 re: PATCH-after-create.)

### Runtime enforcement (verified first-hand by the planner)
`worker/src/role-guard/policy.ts`:
- READ_TOOLS → always allow `:150-152`.
- EDIT_TOOLS → `isEditDenied(target, permission.edit)` `:153-168`; algorithm `:383-402`: explicit deny glob wins; if `editMap['*'] === 'deny'`, allow only when a non-`*` glob matches with allow/ask; **if the map has NO `'*'` key → fail-open (allow every edit)**.
- bash → only `bashDeny` `:169-188`; `ROLE_BASH_DENY_PATTERNS` is `[]` ⇒ the guard never denies bash; **`permission.bash` (layer①) is the effective gate**.
- task → hardcoded `:189-196`: allow only when `agent === 'vteam-plan'` AND `subagent_type === 'vteam-plan'`; all other `task`/`execute` denied `:197-199` ⇒ **`permission.task` is shadowed for non-plan agents**.
- **Correction to an earlier subagent claim:** `:211-219` — tools NOT prefixed `vteam_`/`git_` (third-party MCP) are **allowed**; only `vteam_`/`git_` go through the allowlist, and `browser` is allowlisted `:206-210`. So `tools: {}` blocks `vteam_*` + `git_*` + `browser`, not external MCP.

### Server normalization / validation gaps
`server/src/execution-policies/execution-policy.service.ts`:
- `canonicalizePermission` `:197-210` — deletes `write`, reorders `edit/read/bash/task/...`; no value/glob validation.
- `canonicalizeEditMap` `:185-191` — order only.
- `assertValidConfig` `:801-819` — checks `permission`/`correction`/`tools` are objects; strips `permission.write`; **no glob validation, no edit catch-all requirement, no bash/task value validation**.
- `PolicyConfigDto` `dto/policy-config.dto.ts` — `@IsObject()` only.
- `config.bashDeny` is not in the DTO ⇒ stripped by the global `ValidationPipe({ whitelist: true })` (`server/src/main.ts:56-59`).

### Design-intent drift (docs)
- Docs 04/06/09/14 still describe `permissionScope` as live; the column + `agent_tool_effects` were **dropped** (`server/prisma/migrations/20260913000000_drop_agent_tool_effects_permission_scope/migration.sql`); zero runtime readers; docs 15/16 call it legacy.
- Doc 14 §9.2 open question ④ says blank custom agents were "empty ⇒ effectively all allow (越权风险)" with a proposed future tighten to deny-by-default — however the code ALREADY does deny-by-default, so the real defect is the opposite (too strict, no usable path).
- Doc 16 §2.1 factory table (product bash=deny; architect/developer/tester bash=ask) disagrees with live `ROLE_BOUNDARIES` (`bashEffect:'allow'` for those roles) ⇒ doc/code drift; do not use doc 16 §2.1 as the live reference.

## Decided (user interview)
| # | fork | decision |
| --- | --- | --- |
| F1 | new-agent default | 有 role 就继承该角色策略（加角色选择器；后端已支持） |
| F2 | edit/read editor | glob 规则列表编辑器 |
| F3 | task vs bash | bash 可编辑（三态）；task 只读 + 引擎限制说明 |
| F4 | permissionScope | 不复活（宣布默认） |
| F5 | glob semantics | 保持 glob，不塌缩三态（宣布默认） |

## SCOPE DECISION (user, this session)
- **Scope = B** (the full three-layer abstraction), with A's fixes as its natural first step. Skill handling = **正视现状 (global skill)**.
- ⚠️ This SUPERSEDES the earlier draft framing (which was A-only). Slug may be renamed.

## Verified: skill is a WORKER-global attribute, not an agent attribute
- `worker/src/resources/injector.ts:223-224` — `GET /skills?enabled=true` (no agent dimension); `:233` writes `<workDir>/.opencode/skills/<name>/SKILL.md` = ONE shared set per worker.
- `:4-5` comment: "serve 启动时 discoverSkills 扫描" (startup-level, not per-session).
- `worker-dispatcher.ts` — ZERO `skillIds` reads ⇒ the field never reaches dispatch.
- DB/API exist (`agents.service.ts:211, 337-338`, `agent_skills` table) ⇒ **decorative**.
- `permission.skill` deny rule from design doc 14 §3.2 does NOT exist in code; the guard instead lists `skill` as `BUILTIN_PASSTHROUGH` (`role-guard-plugin.ts:99`) = unconditional allow.
- ⇒ Decision: treat skill as a platform/worker-level resource; surface it truthfully (do not pretend it is per-agent).

## FINAL MODEL (user decisions, this session) — the abstraction target
The user's model: **capability belongs to the agent (like an installed plugin); a Role only BINDS an agent; no special-casing.**

| # | decision | consequence |
| --- | --- | --- |
| D1 | **Capability lives on the opencode agent definition** (permission/tools/prompt/mode/duty), NOT on the Role | `/agent-policies` generalizes from "7 hardcoded vteam-* names" to "any registered agent entry" |
| D2 | **Role = independent reusable entity; carries NO capability, only a binding** | new `Role` model; replaces today's `Agent.role` string's 4 overloaded jobs |
| D3 | **duty comes from the BOUND opencode agent**, not a new vteam field: "agent 可以直接绑定 plan agent 或者绑定 omo 的 prometheus" | `getOpencodeAgentDuty`'s hardcoded `PLAN_DUTY_AGENTS` Set becomes registry data; `isPlanRole`'s Chinese-substring match is deleted |
| D4 | **vteam CAN write/override third-party agent permissions** | `/agent-policies` may emit a definition for e.g. `prometheus`; the worker injects it into `opencode.json agent.<name>` |
| D5 | skill = platform/worker-global (truthful, not per-agent) | `skillIds` removed from the agent editor or marked global |
| D6 | Role management lives as a **Tab inside `/agents`** (user choice) | no new nav item; `/agents` gains an Agent tab + a Role tab |
| D7 | **Third-party agents go into the unified registry**: `Agent` table + a `source` field (`builtin` \| `custom` \| `third-party`) | one mechanism for all three origins; the third-party row is the writable carrier for vteam-overridden permissions |
| D8 | **`TeamMember = { roleId, agentId }`**; the Role carries a **default agent**, pre-filled and user-overridable | same team can run `dev-1 → vteam-developer` and `dev-2 → prometheus`; picking a role is one step, customising is optional |
| D9 | New entity is named **`AgentRole`** (table `agent_roles`), NOT `Role` | `Role` is taken by USER RBAC (`schema.prisma:68-80` + `User.roleId` `:48,57`) |
| D10 | `AgentRole` is **global reusable** | matches the global Team domain; one standard set of roles across teams |

### Final data-model shape (D1-D8 + D9/D10 reconciled)

> NAMING: the new entity is **`AgentRole`** (table `agent_roles`), NOT `Role` — `Role`
> is already taken by the USER RBAC role at `schema.prisma:68-80` (referenced by
> `User.roleId` `:48,57`; consumed by `roles.service.ts`, `permission.guard.ts`,
> `roles.constants.ts`). Reusing the name would collide. Scope = **global reusable**
> (matches the global Team domain).

```
AgentRole (independent, global, reusable, NO capability)      ← D2 / D9 / D10
  ├ id / key / name / description
  ├ type: builtin | custom
  └ defaultAgentId → Agent        ← pre-fills the member form (D8)

Agent (unified registry; carries capability via its bound policyId)
  ├ id / name / agentKey / prompt / persona / defaultModelId
  ├ source: builtin | custom | third-party        ← D7
  └ policyId → ExecutionPolicy                    ← capability lives here (D1)

ExecutionPolicy (capability; UNCHANGED shape)
  └ config: { permission(edit/read/bash/task), tools, correction, bashDeny? }

TeamMember (the binding)
  ├ roleId  → Role     ← slot / label
  ├ agentId → Agent    ← who fills it (overridable)
  └ alias / seq / workDir / overrideModelId / opencodeAgentName
```
`Agent.role` (string) is **deleted**; its four jobs are redistributed:
① display → `TeamMember.roleId`/`Role.name`; ② policy key → `Agent.policyId` (already exists);
③ plan identity → `duty` derived from the bound opencode agent (D3); ④ opencode-name fallback → `Agent.agentKey` (already exists).

### Declared defaults (reversible; surfaced for veto)
| assumption | default | rationale |
| --- | --- | --- |
| edit/read stay glob maps | yes (no tri-state collapse) | keeps the worker wire contract |
| `permissionScope` | NOT revived | dropped by migration 20260913000000 |
| `bashDeny` | add to DTO so it is actually settable | currently silently stripped by the global whitelist |
| `Agent.workerId` (worker affinity) | **out of scope this plan** — record as decorative-tech-debt | never consumed in dispatch; unrelated to the role/capability split |
| worker changes | **IN scope now** | the unified guard session mapping + duty data-ization require it; the previous plan's "worker untouched" boundary is explicitly lifted for this plan |

### The three-layer target
```
Capability (per opencode agent, keyed by opencode agent name)
  ├ source: builtin | custom | third-party
  ├ permission (edit/read globs, bash, task)  ┐
  ├ tools (tri-state matrix)                  ├─ editable on the AGENT page
  ├ correction (boundary)                     ┘
  ├ mode (primary|all)   ← derived-or-stored, not name-hardcoded
  └ duty (plan|execute)  ← registry data, replaces the name-Set + Chinese match

Agent (vteam row) = identity + binding
  ├ name / prompt / persona / defaultModelId
  └ opencodeAgentName → which capability entry to use (builtin custom or third-party)

Role = independent reusable entity, carries NO capability
  ├ key / name / description
  └ boundAgent → which Agent fills this slot
```

## Verified: the three layers' current maturity
| layer | entity | status |
| --- | --- | --- |
| 1 Role | `Agent.role` string (+ `ROLE_BOUNDARIES` / `ep_<role>`) | ⚠️ **NOT abstracted** — one string carries 4 jobs |
| 2 opencode agent | `TeamMember.opencodeAgentName` + `resolveMemberOpencodeAgentName()` | ✅ **already separable**, supports third-party (OmO) |
| 3 capability | `ExecutionPolicy` (permission+tools+correction) + `defaultModelId` + `skillIds` | ✅ policy/model per-agent; ❌ skill is global |

`role`'s four jobs (must be split):
| job | consumer | target after abstraction |
| --- | --- | --- |
| ① display (avatar/colour) | web `toAvatarRole()` | keep as a label |
| ② policy-inheritance key `ep_<role>` | `resolveTemplateSource` (`agents.service.ts:727-748`) | explicit `policyId` binding / Role entity |
| ③ plan identity | `isPlanRole()` — **Chinese substring match** (`worker-dispatcher.ts:365`) | explicit capability flag `duty: 'plan'` |
| ④ opencode-agent-name fallback | `roleToAgentName()` → `vteam-<role>` | DELETE (superseded by `agentKey`) |

## Verified: `plan` role's six specialisations (why it cannot be a reusable role today)
1. `task:'allow'` + guard's literal `agent === 'vteam-plan'` check (`policy.ts:189-196`) — custom agents named `vteam-<agentKey>` never match.
2. write scope = plan dir only (`agent.constants.ts:497`, `**.opencode/plans/**`).
3. skips `ARTIFACT_SUBMISSION_INSTRUCTION` (`worker-dispatcher.ts:550-551`).
4. skips the memory section (`:511-513`).
5. gets `PLAN_PRODUCE_INSTRUCTION` vs others' `PLAN_REVIEW_INSTRUCTION` (`:561`).
6. plan-gate exemption (`:1452, 1487`).
⇒ All six key off the NAME, not a capability. Abstraction target: make `duty: 'plan'` an explicit attribute, then any agent bound to a plan-duty role gets them.

## Metis gap analysis — findings folded in (all code-verified by planner where marked)

### Blockers
- **B1 worker propagation.** Policy edits do NOT reach a running worker: `roles.json`/`opencode.json` are written only by `injector.injectAll()` (worker startup / reload-config). `ExecutionPoliciesModule` broadcasts nothing. ⇒ an edit appears to do nothing until a worker restart. **Pre-existing for the tool matrix too** (not a regression this plan introduces).
- **B2 `'*'` auto-inject scope.** Must be: `edit` only; write-path (`assertValidConfig`) only; when `edit` exists but lacks `'*'`, OR when `edit` is absent. **NEVER for `read`** — `read` is `{'*':'allow'}` and `READ_TOOLS` always allows at the guard, so injecting deny would break all reads. Verified: all 7 baseline roles carry `edit['*']='deny'` ⇒ write-path inject is a **no-op on factory values** (byte-identity preserved).
- **B3 concurrency / lost update.** `policyMutation` sends the WHOLE config from a stale closure; `pendingKey` serializes only tool toggles; `execution_policies` has **no version column** (`schema.prisma:624-634`, verified) ⇒ native edit + tool toggle can clobber. ⇒ route native edits through ONE shared mutation + `pendingKey` gate, and build the payload from the freshest refetched `effective`.

### Majors
- **M1 `plan` in the create picker.** `ep_plan` carries `task:'allow'`, but a custom agent's opencode name is `vteam-<agentKey>` and the guard only allows task for the literal `vteam-plan` ⇒ selecting `plan` yields a shadowed/misleading policy.
- **M2 `ask` in glob maps.** The guard treats `ask` as allow (`policy.ts:394`); a normalizer that maps unknown→deny would silently convert a stored `ask` to `deny` on save. Editor must round-trip unknown effects untouched.
- **M3 role change after create.** `update()` writes `role` but never re-provisions ⇒ role=developer + skeleton permissions. Auto-reprovision is destructive (orphans/wipes the user's edited policy).
- **M4 existing fail-open rows.** Write-path inject does not fix rows already lacking `'*'` (reachable today via API since nothing validates). Needs an explicit position.
- **M5 enforcement QA.** Must be PATCH → reload worker → read back injected `opencode.json` + `roles.json`; a UI-only test cannot prove enforcement.
- **M6 absent native key.** `nativeRows` filters by presence (`page.tsx:923`) ⇒ an absent `bash`/`task` renders nothing, so it cannot be added.
- **M7 `config.bashDeny` stripped.** Not in `PolicyConfigDto` + global `whitelist:true` ⇒ any editor save silently drops it. (Impact today low: seed writes none, `ROLE_BASH_DENY_PATTERNS=[]`.)

### Minor
- glob validation: reject empty-string globs, dedupe, cap rules/length; decide whether extra allow-all globs (`**`) are permitted (enforcing `'*':'deny'` does not prevent adding `'**':'allow'`).
- `CreateAgentDto.role` is unconstrained (`@IsString` only) — define omit-vs-empty.
- custom agents inherit the policy but NOT the boundary prompt.
- touch-points: testid registry, spec files, docs drift.

### Pre-analysis flag NOT carried into Metis's final list (re-added here)
- **Template/shared-policy blast radius:** editing a TEMPLATE agent's native rows mutates the SHARED `ep_<role>` for every agent bound to it. Note this blast radius **already exists** for the tool matrix (the previous plan deliberately allowed editing built-in policies). ⇒ consistency argues for keeping native rows editable on templates too, WITH a UI warning. Surfaced to the user as an owner-decision.

## Open questions
- OPEN-Q1 (owner): template native-row editability (consistent-with-prior vs gate-to-custom).
- OPEN-Q2 (owner): worker propagation — auto-reload on policy change vs documented restart.
- OPEN-Q3 (owner): `plan` role in the create picker.
- OPEN-Q0 (resolved): after creating a role-less agent, PATCHing `role` does NOT re-provision — must send `policyId` too, or use the editor.

## Metis gap analysis on the D1-D10 model — 7 blockers, 9 majors (planner re-verified key claims)

### Blockers (all code-cited; #2 #3 re-verified first-hand by the planner)
| # | blocker | evidence |
| --- | --- | --- |
| B1 | New `Role` collides with the existing RBAC `Role` (`schema.prisma:68-80`, `@@map("roles")`, `User.roleId :48`) | ⇒ resolved by D9 (`AgentRole`) |
| B2 | **Naming model conflict**: `agentNameOf` always builds `vteam-<agentKey>` (`execution-policy.service.ts:829-838`) ⇒ a third-party agent can NEVER be emitted as bare `prometheus`. **D4/D7 provably non-functional without a naming change.** | planner re-verified `:764-767` + `:829-838` |
| B3 | **Worker gate**: `exec-server.ts:1129` `if (!agent.startsWith('vteam-')) return;` ⇒ a third-party dispatch writes NO session→policy mapping ⇒ guard branch 2 (`policy.ts:134-138`) pass-through ⇒ **vteam policy silently NOT enforced on third-party agents.** D4's whole value is void. | planner re-verified via read of `:1122-1167` |
| B4 | **Byte-identity**: `/agent-policies` order comes from the CONSTANT `AGENT_POLICIES_ORDER` (`:366-374`), NOT the DB query (seed insert order differs). A registry query reorders the 7 built-ins ⇒ frozen sha breaks. Requires an explicit order key. | planner verified constant + baseline order match; seed order differs |
| B5 | **Guard-neutralization blast radius**: one malformed third-party definition throws in `opencode-config-builder` (`assertAgentShape`/`assertGuardRole`) → `injector` catches → `writeNeutralized` → **layer-② guard off for EVERY role on that worker**. `mode:'subagent'` (legit in `WorkerAgentInfo.mode`) is one trigger. | `opencode-config-builder.ts:92-116,119-140`; `injector.ts:322-333,367-389` |
| B6 | `Agent.role` deletion is a cross-module break (~14 modules): `roleToAgentName`, `isPlanRole`, `ROLE_LABELS` (teams+tasks aliases), `platform-mcp`, `chat.service`, web `AGENT_ID_ROLE`/`toAvatarRole` … | Metis consumer map |
| B7 | **Two (soon three) competing "which agent runs" sources**: `TeamMember.agentId` vs `TeamMember.opencodeAgentName` vs `Agent.agentKey`; precedence undeclared | `worker-dispatcher.ts:2105-2112`; `schema.prisma:129` |

### Majors (decision gaps NOT covered by D1-D10)
- **M1** `isPlanRoleTarget` keys off the literal `PLAN_AGENT_ID = 'a_plan'` (`worker-dispatcher.ts:90,1487-1500`) — a SEPARATE hardcode the duty decision does not cover. Bind plan duty to `prometheus` ⇒ the gate exemption fails ⇒ plan agent blocked.
- **M2** **duty ≠ toolset**: memory/artifact suppression exists because `plan`'s tools lack `vteam_memory_save`/`vteam_submit_artifact`. Must derive suppression from the resolved **tools**, not from duty.
- **M3** `Agent.type` (template|custom|clone) vs new `source` (builtin|custom|third-party) overlap — `clone` has no source mapping; must declare the authority.
- **M4** **`resolveTemplateSource('ep_'+role)` has no replacement** ⇒ how does a new agent get its starting capability? Uncovered.
- **M5** injected third-party name shallow-merges over OmO's own agent definition; no collision detection.
- **M6** three more `vteam-plan` hardcodes: dispatch `:2105-2107`, `deriveAgentMode` `:253-255`, `resolveTaskEffect` `:239-247`.
- **M7** `workerSupportsAgentPolicies` is stale until worker reload ⇒ silent fallback.
- **M8** `TeamMember.roleId` backfill + Role-deletion FK semantics unstated.
- **M9** migration is one-way; loses data for non-`ep_` roles.

### Metis verdict
> "The model is coherent as a concept, but D1–D8 as stated are not implementable without several unstated decisions, and two decisions (D4, D7) are provably non-functional against the current code. **Do not write this as one plan.**"

### Required split (Metis checklist item 11)
> A native editor → **B** AgentRole entity + TeamMember backfill → **C** agent-policies registry generalization + third-party source → **D** duty data-ization + worker gate + guard.
> Highest-risk = **D's gate change + C's emission generalization**; each must be isolated with its own live-stack QA.

### Acceptance criteria that would let a broken build pass (must avoid)
- `toContain('vteam-plan')` (passes with wrong order)
- count-only `buildAgentPolicies()` assertions (never sha-compared)
- `toContain('prometheus')` on emission (never proves the guard DENIES for it)
- `roleId` column-exists check (never proves dispatch still picks the same agent)
- `getOpencodeAgentDuty('prometheus')==='plan'` (passes while dispatch still uses `agent.role`)
- PATCH→DB-read-back round-trips (never reloads the worker)
- fresh-DB migration test (never migrates a DB WITH existing `agent.role` values)
- "malformed definition throws" (never asserts the OTHER roles' guard survives)
- `agent.source==='third-party'` (never asserts the opencode name is bare `prometheus`)

## SCOPE RE-CUT (user decision, this session): **D + C**
> "自家先统一，三方只读接入"

### What D+C means
- **D — unify vteam's OWN agents first**: builtin + custom all go through one capability mechanism (no name-based special-casing for our own agents).
- **C — third-party = READ-ONLY integration**: an OmO agent is selectable in a team and its capabilities are displayed read-only; vteam does NOT emit/override its definition.

### Blockers now OUT of scope (because we never emit third-party definitions)
| blocker | why it drops |
| --- | --- |
| B2 naming (`agentNameOf` always `vteam-<agentKey>`) | we never need to emit a bare `prometheus` |
| B3 worker gate (`exec-server.ts:1129` `startsWith('vteam-')`) | no third-party policy to enforce ⇒ the gate stays as the safety boundary it was designed to be |
| B5 guard-neutralization blast radius | we never pour third-party metadata into `opencode-config-builder` |
| D4 / D7 (write/override third-party; unified registry emission) | superseded by D+C — third-party is read-only |

### Blockers that REMAIN
| blocker | status |
| --- | --- |
| B1 `Role` name collision | RESOLVED by D9 (`AgentRole` + `@@map("agent_roles")`) |
| B4 byte-identity order | **REMAINS** — only if we generalize `/agent-policies` for our own agents; must keep an explicit order key |
| B6 `Agent.role` cross-module break | **REMAINS** — the decoupling's core work |
| B7 competing "which agent runs" sources | **REMAINS** — must declare precedence (agentId vs opencodeAgentName) |
| M2 duty ≠ toolset | **REMAINS** — suppression must derive from resolved `tools` |
| M4 `resolveTemplateSource` replacement | **REMAINS** — needed for create/clone after `role` is gone |
| M1 `PLAN_AGENT_ID='a_plan'` literal | **REMAINS** if we de-special-case duty |
| M3 `type` vs `source` | **REMAINS** |
| M6 three `vteam-plan` hardcodes | **REMAINS** if we de-special-case duty |
| M8/M9 TeamMember backfill + migration | **REMAINS** |

## FINAL PROMPT-LAYERING MODEL (user, this session) — expands plan 2 substantially
The user's clean split:
| layer | prompt content | answers |
| --- | --- | --- |
| **AgentRole prompt** | what this post IS:职责范围、边界 | "我该承担什么" |
| **Agent prompt** | HOW to work: 权限、工具、工作方式 | "我怎么做、我有什么" |
| **Platform prompt** | 回执铁律 etc. (identical across all roles today) | platform-wide rules |

Decisions:
| # | decision |
| --- | --- |
| D11 | **both prompts are COMBINED** at runtime (not one overriding the other) |
| D12 | **boundary belongs to the AGENT** (prompt section + guard correction), NOT the role — user's clarification, supersedes the earlier "role holds boundary" idea |
| D13 | **plan 2 does the FULL split** of the 7 built-in prompts into role-part / agent-part / platform-part (user chose "第2份就彻底拆分") |

### Verified: the byte-identity invariant does NOT cover prompts
`.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` contains ONLY policy output
(`description`, `scopeSummary`, `handoff`, `denyTemplate`, `permission`, `tools`) — **no prompt text**.
⇒ the full prompt split does NOT touch the frozen sha.
But `server/src/chat/worker-dispatcher.spec.ts:466-504` asserts system-prompt CONTENT
(`:487` `'【职责】你是产品需求分析专家…'`, `:492-503` the degraded path), so the assembly refactor
requires updating those assertions (they use a mock prompt, not factory text — contained blast radius).

### Evidence of the current mixed state (why the split is needed)
`server/prisma/seed.ts:539-584` (product) — one prompt contains:
- `# 角色：产品经理` + `## 职责` → **role**
- `## 权限` (restates ExecutionPolicy in prose) → **agent**, and duplicates the policy layer
- `## 工作方式` → **agent**
- `## 协同方式` (mixed: 转交=boundary, @响应=mechanism)
- `## 回执铁律` → **platform** (identical across all 7 roles — currently copy-pasted 7 times)

**G2 — the assembly change's test blast radius is understated.**
- Plan 2 todo 5 says only "update the assertions in `worker-dispatcher.spec.ts` that pin system-prompt content".
- Reality (verified): `buildSystemInstructions` has **45+ call sites** in `worker-dispatcher.spec.ts` (grep `buildSystemInstructions` → lines 466, 492, 572, 1272-2004, 6175-6221…). Several construct an identity that carries `role` (`:1580` `agentRole: 'plan'`, `:1584` `{ ...agent, role: 'plan' }`, `:1804`, `:1809`) — and `AgentIdentityInfo` (`worker-dispatcher.ts:292`, with `agentRole?` at `:464`) is the interface plan 4 must change when `Agent.role` is removed.
⇒ Plan 2 todo 5 and plan 4 must both explicitly state that ~45 call sites and the `AgentIdentityInfo` shape are in their blast radius, and the worker must be told which assertions change vs which stay. Otherwise the worker will either under-edit (leaving broken assertions) or over-edit (weakening tests to reach green).

## SELF-FOUND CROSS-PLAN GAP (found by the planner during the review round)
**G1 — the create-form role picker is orphaned between plan 1 and plan 4.**
- Plan 1 todo 7 adds a role picker to the create form, explicitly using the EXISTING `Agent.role` string, and states: *"plan 4 later replaces it with `roleId` — that follow-on change is in plan 4's scope and must be listed there"*.
- Plan 4 (agent-role-decommission) does NOT contain any todo for that migration: a grep for `role picker|create-form|CreateAgentModal|roleId` finds only the TL;DR and a passing mention inside todo 7 ("ensure every team member has a `roleId` (plan 2)").
⇒ **Hidden rework / dangling handoff.** Plan 4 must add an explicit todo: migrate the create/clone forms from `Agent.role` to the `AgentRole` binding (the picker in plan 1 selects a role string; after plan 2 there is a real `AgentRole` and after plan 4 the string is gone).
Also: plan 2 now owns the role entity + prompt split, so the create form's picker arguably should move to the `AgentRole` API as soon as plan 2 lands — the plans must state which plan converts the picker, and it must be exactly one of them.

### Planner-verified additions during the review round
- **P1 (major, verified): plan 1 todo 1 misses the ABSENT `edit` key.** `worker/src/role-guard/policy.ts:159-165` — when `permission.edit` is not a plain object the guard sets `editMap = null` and returns **allow** (a second fail-open path). Plan 1 todo 1 only covers "present but lacks `'*'`"; the draft's B2 explicitly said "…OR when `edit` is absent". Fix: todo 1 must also inject `edit: {'*':'deny'}` when `edit` is absent from `permission` (write path), so both fail-open paths close.
- **P2 (clarification, verified): the worker restart API EXISTS.** `server/src/workers/workers.controller.ts:121-125` — `POST /api/v1/workers/:id/restart` (permission `workers.edit`). Plan 1 todo 6's "if no API exists, name the operator action" hedge is unnecessary; the todo must name this endpoint directly (and still must not auto-restart on every save).

## REVIEW ROUND 1 — findings (planner self-verified the starred ones)

### INDEPENDENT (Oracle) review — key findings
- **★ O1 (BLOCKER, verified by planner): plan 2's "7 identical platform blocks" premise is FALSE.**
  `server/prisma/seed.ts` grep: `## 回执铁律` appears **4×** (`:581` product, `:673` architect, `:718` developer, `:763` tester); `## 派发铁律` **1×** (`:626` project_manager, DIFFERENT content); `## 修订铁律` **1×** (`:811` plan, DIFFERENT content); librarian has **no** 铁律 section.
  Meanwhile `团队协作规约（全文见 …）` appears **7×** (`:575,620,667,712,757,801,848`) — that is the genuinely universal block.
  ⇒ plan 2 todo 3's "Remove the 7 copies" and its acceptance "no prompt still contains the block" are wrong as written, and an unconditional "lift it and inject for all" would ADD the block to the 3 agents that never had it (project_manager/plan/librarian) — a real behaviour change the plan does not acknowledge. Must be rewritten to classify all three 铁律 variants + the 7× shared convention block, and decide per-variant.
- **★ O2 (BLOCKER, verified by planner): plan 4's dependency matrix contradicts its own text.**
  `agent-role-decommission.md:68` says todo 7 (drop the column) is `Blocked by: 1,2` — but todo 7's own body requires "Only after todos 2-6 land and pass". Wrong matrix ⇒ a worker could drop the column before the consumer migrations land.
- **★ O3 (BLOCKER, planner-verified): plan 4's headline goal is unreachable under its own "no worker change" guardrail.**
  Plan 4 wants plan duties to work for a planner "not necessarily named `vteam-plan`", while forbidding worker changes. But `worker/src/role-guard/policy.ts:189-196` allows `task` ONLY when `agent === 'vteam-plan'` (literal) AND `subagent_type === 'vteam-plan'`; `TASK_TOOLS` denies otherwise (`:197-199`). So a renamed plan-duty agent gets `permission.task:'allow'` emitted but the guard still denies its fan-out ⇒ the plan's own success criterion ("works end to end") cannot hold. Either the worker guard must change, or the criterion must be narrowed to the server-side plan gate.
- O4 (major): plan 1's create-form role picker (on the existing `Agent.role`) is not scoped for rewrite by plan 4 — hidden rework. (planner also found this as G1)
- O5 (major): assembly blast radius — `buildSystemInstructions` has ~45 call sites in `worker-dispatcher.spec.ts`; several pass `role`/`agentRole` (`:1580,1584,1804,1809`) and `AgentIdentityInfo` (`worker-dispatcher.ts:292`, `agentRole?` `:464`) must change in plan 4. (planner also found this as G2)
- O6 (major): the `## 权限` prose restates `ExecutionPolicy`; plan 2 todo 2 permits dropping it while the parity gate demands "no line lost" — unstated tension.
- O7 (major): plan 2 todo 1 seeds the 7 `AgentRole` rows in the MIGRATION, but todo 4 populates `rolePrompt` via `seed.ts`. Migrations don't re-run on existing DBs ⇒ an existing deployment could get EMPTY `rolePrompt` while the CI test (fresh seed) passes. Needs an explicit data backfill for `rolePrompt`.
- O8 (major): the role binding lives on `TeamMember.roleId`, but plan 2 todo 5 says "the agent's bound role" — imprecise; two members sharing one agent could carry different roles. Must define it per assembly path.
- O9 (minor): plan 3's "governed" flag must call the SAME function as `buildAgentPolicies()`, not a second `vteam-*` prefix check.
- O10 (verified TRUE): the frozen artifact contains **no prompt text** ⇒ plan 2's prompt split genuinely cannot move the sha. Oracle confirmed all load-bearing code claims (isEditDenied fail-open, bash uses bashDeny only, task literal-only, buildSkeletonConfig shape, no version column, `Role` taken by RBAC, exec-server `vteam-` gate, `agentNameOf` always `vteam-`).

### Prior Metis blockers/majors across the four plans
- B1 RESOLVED (D9 `AgentRole`) · B2/B3/B5 dropped by scope (D+C read-only, legitimately, plan 3 keeps them as boundaries) · B4 not triggered · B6 ADDRESSED by plan 4.
- **B7 (competing "which agent runs": `agentId` vs `opencodeAgentName` vs `agentKey`) → SILENTLY DROPPED.** No plan declares the precedence. Must be added.
- M1/M2/M4/M6/M8/M9 ADDRESSED by plan 4 · M3/M5 moot · M7 partially addressed (plan 1 todo 6).

## REVIEW ROUND 1 — OUTCOME: BOTH REJECTED; all findings fixed; round 2 dispatched

Both reviewers returned REJECT (Momus: 3 blockers + 8 majors + 8 minors; Oracle: 3 blockers + majors O1-O9 + B7 drop).

### Fixes applied (round 1 → round 2)
| finding | fix |
| --- | --- |
| Momus B1 (`ask` contradiction) | plan 1 todo 1 now accepts `allow\|ask\|deny` for edit/read values (rejects only outside the tri-state); agrees with todo 3's `ask`-preservation |
| Momus B2 / Oracle O4 (picker unowned) | plan 4 todo 4 retitled `[server+web] … AND re-point the create-form role picker`, now owns the migration + DTO removal; plan 4 consumer map names the CreateAgentModal refs |
| Momus B3 (unverifiable component todo) | plan 1 todos 3+4 MERGED into one todo 3 (component + wiring), verified via Playwright; tooling note cites `web/package.json`; todos renumbered 1-8; matrix updated |
| Momus M1 / planner P1 (absent `edit`) | plan 1 todo 1 injects the catch-all when `edit` is absent too (both guard fail-open paths cited) |
| Momus M2 / Oracle O2 (dep header) | plan 4 todo 7 `Blocked by: 3,4,5,6` |
| Momus M3 (0-null unachievable) | plan 2 todo 1 defines three backfill cases incl. creating a custom role for unresolvable values + a fallback role for NULL |
| Momus M4 (new name-keyed conditional) | plan 2 todo 3 chose UNIVERSALITY: both platform blocks for all 7 (the 回执铁律 extension recorded as a deliberate change) — no name-keyed branch |
| Momus M5 / Oracle O-null (injection order) | plan 2 todo 5 records the explicit 17-step block order |
| Momus M6 (plan 3 vs e2e) | plan 3 todo 3 names `web/e2e/no-agent-picker.spec.ts` + the sanctioned resolution |
| Momus M7 / planner P2 (restart endpoint) | plan 1 todo 5 names `POST /api/v1/workers/:id/restart` + the all-workers propagation rule |
| Momus M8 (self-oracle) | plan 2 todo 5 mandates replacing the `worker-dispatcher.spec.ts:590` self-oracle |
| Oracle O1 (7-block premise false) | plan 2 todo 3 states the true counts (回执铁律 ×4 etc.) |
| Oracle O3 (goal unreachable) | plan 4 success criteria + todo 9(d) scoped to server-side; worker literal residual documented |
| Oracle O5 / planner G2 (~45 call sites) | plan 2 todo 5 flags the blast radius + `AgentIdentityInfo` |
| Oracle O6 (permission prose) | plan 2 todo 2 DECIDES: pointer only, dropped prose listed as intentional removal |
| Oracle O7 (empty rolePrompt on existing DB) | plan 2 todo 4 requires an idempotent data migration + 0-empty assertion on a populated DB |
| Oracle O8 (`roleId` on TeamMember) | plan 2 todo 5 states the join source |
| Oracle O9 (governed flag drift) | plan 3 todo 1 requires the same source as `buildAgentPolicies()` + a drift test |
| minors m1-m8 | all applied (prose counts, SegmentedTabs-not-imported, todo 9(d) wording, residual race stated, roleId location, scoped predicate, both either/ors decided, defaultAgentId onDelete) |

### REVIEW ROUND 2 — Momus APPROVE-leaning; Oracle REJECT (2 items) → both fixed; round 3 dispatched

### Round 2 outcomes
- **Momus**: all 3 blockers + all 8 majors RESOLVED. Found only bookkeeping inconsistencies introduced by the renumbering (plan 1 dependency matrix vs inline `Blocks:`/`Blocked by:` mismatches for todos 3/6/8; plan 3 matrix row 2 parallel-claim wrong) — classified non-blocking.
- **Oracle**: REJECT on exactly two items — **B7 still undeclared** (agent-selection precedence) and the **plan-1 phantom `Blocks: 2,3,8,9`** broken reference. Re-confirmed all O1-O9 resolved.

### Round-2 fixes applied
| item | fix |
| --- | --- |
| Oracle B7 (precedence) | plan 4 todo 1 now carries a normative 4-rule precedence declaration (policy candidate wins when worker supports it → else `opencodeAgentName` → else omit `agent` key → post-`role`-removal no-`agentKey` has no candidate) + a pinning-test acceptance criterion; plan 3 todo 3 now CITES that declaration instead of restating its own |
| Oracle broken ref | plan 1 todo 1 inline `Blocks:` → `2,3,7,8` (matches matrix; phantom `9` gone) |
| Momus plan-1 bookkeeping | aligned t3 `Blocks: 4,8`, t6 `Blocked by: —`, t8 `Blocked by: 1,2,3,4,5,6,7` to the matrix |
| Momus plan-3 bookkeeping | matrix row 2 no longer claims parallel with todo 3 (which depends on 2) |

### Round 3 status — BOTH APPROVED (gate closed)
- **Oracle** (`bg_12298a2e`, session `ses_f4ce2ce1effeJEdAAtfvpE89dz`): `INDEPENDENT VERDICT: APPROVE`. Independently re-read all four plans and re-verified every load-bearing code claim from disk: frozen sha `793093dc…abbc3a` (recomputed), guard fail-open BOTH paths (`policy.ts:159-165` + `:383-402`, `ask`→allow at `:394`), `task` literal `:189-199`, no version column `schema.prisma:624-634`, restart endpoint `workers.controller.ts:121-125`, `web/package.json` only `test:e2e`. Confirmed B7 declaration present + pinning test + plan-3 citation consistent, and the phantom-`9` reference gone. Only non-blocking note: the `workerSupportsAgentPolicies` cite `:2108-2112` is ~3 lines off (call is at `:2111`) — cannot mislead since the function is named.
- **Momus** (`bg_2b885c65`, session `ses_f4ce2db15ffeDP6b1lbsL8v6dk`): `MOMUS VERDICT: APPROVE`. Verified all 8 plan-1 inline/matrix pairs agree with no dangling edge refs, plan-3 row 2 no longer parallel-claims todo 3, todo counts 8/8/5/9 + F1-F4 present, and all 11 round-2 fixes (B1,B2,B3,M1–M8) still intact. Outstanding: **none**.
- **High-accuracy review gate is CLOSED**: 3 rounds, both reviewers APPROVE. The four plans are declared decision-complete and safe to hand to a worker.

## STILL OPEN (to be checked in round 2)
- **Metis B7** — the precedence between `TeamMember.agentId`, `TeamMember.opencodeAgentName`, and `Agent.agentKey` is STILL not declared by any of the four plans. The planner judges it may be acceptable (the plans never introduce a new ambiguity; the existing dispatch precedence is unchanged), but it was a Metis blocker for the earlier single-plan scope and is worth an explicit "not in scope, unchanged" note. If round 2 flags it, add that note.

## Approval gate
status: approved — write FOUR plans (user: "四份一起写（路线完整）")
| # | plan slug | content |
| --- | --- | --- |
| 1 | `agent-native-permission-editor` | A: native permission editor (edit/read glob lists, bash tri-state, task read-only) + create-form role picker (uses the EXISTING `Agent.role` field — still present at this stage) + the "restart worker to apply" affordance |
| 2 | `agent-role-entity` | B: `AgentRole` entity (global, reusable, no capability) + `TeamMember.roleId` + `defaultAgentId` + backfill + Role tab in `/agents` |
| 3 | `third-party-agent-display` | D': third-party (OmO) agents selectable + capabilities shown READ-ONLY; vteam emits nothing for them |
| 4 | `agent-role-decommission` | C': delete `Agent.role` (user chose outright deletion) + duty derived from resolved `tools` + de-special-case the plan literals + 14-module consumer migration |

### Final owner-decisions (this session)
| decision | value |
| --- | --- |
| third-party goal | **D+C**: unify our OWN agents first; third-party = read-only integration (no worker change) |
| `Agent.role` retirement | **delete the column outright** (irreversible — must backfill first; the plan MUST state this) |
| duty source | derive from the **resolved policy `tools`** (NOT a duty field) — Metis M2 |
| `AgentRole` scope/name | global reusable; table `agent_roles` (D9/D10) |
| plan count | four, written together, executed in order 1→2→3→4 |

### Migration hazard to state explicitly in plan 4
`Agent.role` today holds values (`product`/`project_manager`/`architect`/`developer`/`tester`/`plan`/`librarian`) plus possibly arbitrary custom strings (specs use `'analyst'`). Dropping the column is **one-way data loss** (Metis M9). The plan MUST: (a) backfill every consumer BEFORE dropping, (b) include a documented rollback (restore from the pre-migration dump), (c) test the migration against a DB that HAS existing `agent.role` values — not just a fresh DB.
