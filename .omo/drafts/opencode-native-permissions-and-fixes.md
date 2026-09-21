---
slug: opencode-native-permissions-and-fixes
status: awaiting-approval
intent: clear
review_required: false
pending-action: write .omo/plans/opencode-native-permissions-and-fixes.md (ALREADY WRITTEN) -> then user runs $start-work
approach: Delete the hand-rolled worker role-guard layer (plugin + roles.json + policy/session-map), keep only opencode-NATIVE permission config (edit/read/bash/task), drop the `vteam_*` keys from the emitted payload, and add the missing server-side per-tool enforcement for `vteam_*` in platform-mcp (403). Then the three fixes: editable `task`, role binds one internal-or-external agent (role editor owns it), and dark-mode colour fixes. Re-baseline the frozen policy artifact.
---

# Draft: opencode-native-permissions-and-fixes

## Components (topology ledger)
<!-- id | outcome (one line) | status | evidence path -->
- W1 | worker role-guard layer deleted; only native config remains | active | .omo/evidence/opencode-native-permissions-and-fixes/task-5-guard-removed.txt
- W2 | server refuses an unpermitted `vteam_*` tool (403) | active | .../task-3-server-enforcement.json
- W3 | `task` permission editable in the agents page | active | .../task-6-task-editable.png
- W4 | a role binds one internal-or-external agent, in the role editor | active | .../task-7-role-agent-select.png
- W5 | dark-mode colours fixed on role active state + warnings | active | .../task-8-dark-mode.png
- W6 | docs/test-cases + e2e reflect the new behaviour | active | .../task-9-suite-refresh.txt
- W7 | live proof (clean rebuild + real session + 403 + confinement) | active | .../task-10-live-proof.txt

## Findings (cited - path:lines)

**opencode 1.18.31 native permission schema (fetched `https://opencode.ai/config.json`)** — decisive for the "keep vs drop" rule:
- `PermissionConfig` native keys: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, skill, doom_loop` **+ `additionalProperties`** (arbitrary tool names allowed).
- Value shape: `"allow"|"ask"|"deny"` OR `{ pattern → "allow"|"ask"|"deny" }`.
- Also native: `agent.mode ∈ subagent|primary|all`; **`subagent_depth`** ("Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents") → our hand-written 禁套娃 is redundant; `agent.tools` is `@deprecated` in favour of `permission`.

**What we emit today** (`agents[].permission`): native `edit`/`read`/`bash`/`task` **+ 14 `vteam_*` keys** (`vteam_submit_artifact`, `vteam_issue_*`×5, `vteam_task_transition`, `vteam_question_confirm`, `vteam_memory_save/update`, `vteam_team_add_member`, `vteam_plan_mode`, `vteam_channel_send`, `vteam_task_create`, `vteam_skill_create`, `vteam_git_repos_list`, `vteam_hook_register/cancel`).

**The redundancy** — `worker/src/role-guard/policy.ts` (+ `session-policy-map.ts`) and the generated plugin `worker/src/resources/role-guard-plugin.ts` → written to `<workDir>/.opencode/plugin/vteam-role-guard.ts`, fed by `<workDir>/.vteam-role-guard/roles.json`. It re-implements interception for `edit`/`write`/`apply_patch`/`bash`/`task`/`browser` — all natively expressible. Carries `bashDeny` (regex) and `correction` (`scopeSummary`/`handoff`/`denyTemplate`, the 越界拦截文本). `ROLE_BASH_DENY_PATTERNS` is **already empty** (`agent.constants.ts:264`), so there is nothing to translate into native `bash:{pattern:deny}`.

**The server-side hole (verified):** `grep -rn "tools\[" server/src/platform-mcp/` → nothing. `platform-mcp.controller.ts` only does JSON-RPC dispatch + `WorkerTokenGuard` + `x-worker-id`. `platform-mcp.service.ts` does ownership/flow checks (`ForbiddenException` at `:460/:508/:528/:537/:751/:772/:889/:903/:1477/:1500`) but **never consults the caller's role `tools` allowlist**. Today the ONLY thing stopping e.g. a developer calling `vteam_task_transition` is the `vteam_*: deny` we ship inside the opencode permission.
**Identity IS available:** `x-worker-id` header (`controller.ts:~78`) + args carry `selfInstanceId`/`teamId`/`taskId`, resolved by `PlatformMcpService.resolveExecContext`.
**Naming:** `platform-mcp.tools.ts` registers names **BARE** (`name: 'chat_history'` at `:874`, `'submit_artifact'` `:916`, …; the model sees `vteam_<name>`). Todo 1 pins which form the server receives, with a real capture.
**`git_*` tools** (`git_clone/pull/fetch/status/diff/log/push`) are **worker-injected custom tools, NOT our MCP tools** and are **not** in the emitted permission (`agent.constants.ts:162-175`) — not ours to server-gate.

**Issue 1:** `resolveTaskEffect(name, storedTask)` ALREADY honours an explicit stored value (`execution-policy.service.ts:313-321`); the UI renders `task` as a read-only `EffectBadge` + `native-task-note` (`agents/page.tsx:1413-1421`), while `bash` has an editable `native-bash-effect` — so the server supports it, the UI just lacks the control.

**Issue 3:** `AgentRole.defaultAgentId` is an FK to `Agent` (`schema.prisma:136`, `:145`) — cannot reference an external name. The role editor's `role-default-agent` select (`AgentRolesTab.tsx:537-552`) lists only `/agents`. The external choice lives on the team-detail member row (`member-external-agent-select` → `TeamMember.opencodeAgentName`, already single-valued).

**Issue 4:** theme is CSS-variable driven — `web/app/globals.css:124-175` defines `:root` + `.dark` (`--color-neutral-*`, `--color-surface`, `--color-bg`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-segment-active`, `--color-mention-*`). Defects: `AgentRolesTab.tsx:37-46` hardcoded light `roleTheme` used as the active `backgroundColor` (`:332`); `ExternalAgentsPanel.tsx:57-61` `warning = {text:'#B45309', bg:'#FFFBEB', border:'#FDE68A'}`; the same amber in `teams/[id]/page.tsx`.

## Decisions (with rationale)
1. **Keep native, drop ours.** Mechanically from the opencode schema: native keys stay (they are *how* agents stay inside their task folder); `vteam_*` keys leave the payload and are enforced **server-side**. This is the user's stated principle.
2. **Delete, don't port.** The worker layer is removed outright; sub-task/nesting policy reverts to opencode's native `task` + `subagent_depth`. No hand-rolled re-implementation (that would re-create the problem).
3. **Safety order:** server enforcement (todo 3) lands **before** the worker layer is deleted (todo 5), so the platform's own tools are never unguarded in the final state.
4. **Re-baseline is legitimate.** The payload changes shape on purpose, so the frozen artifact is re-created and its new sha recorded; the two harnesses defaulting to the old sha are updated.
5. **One agent slot per role**, internal OR external, owned by the role editor; the per-member external picker is removed (its data path — `TeamMember.opencodeAgentName` — was already single-valued).
6. **`ask` is not usable** for our own tools (headless cannot prompt; that is why `bash` is `allow`) → our refusal is a hard **403**, not a prompt.

## Scope IN
Native-only opencode permission payload; delete worker guard layer + roles.json + plugin registration; server-side `vteam_*` enforcement (403); editable `task`; role binds one internal-or-external agent (role editor); dark-mode colour fixes; docs/test-cases + e2e refresh; live end-to-end proof.

## Scope OUT (Must NOT have)
No reduction of the engine's own tool config (that is the confinement mechanism); no new name-based branching; no touch to the account-RBAC `Role`/`roles`; no dispatch-precedence change beyond removing the member picker; no shim/A-B/deprecated leftovers; no `ask`-based flow for our tools; no weakening of existing ownership checks; no unrelated restyling; no push.

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Where the role stores an external name | new nullable column (`defaultOpencodeAgentName`) + "at most one of the two slots" invariant in the service | keeps the existing FK intact and the invariant explicit; mirrors `assertAgentExists` validation style | yes (migration + rollback documented) |
| Unresolvable caller identity on a `tools/call` | decided in **todo 1** with a recorded rationale (todo 1 must state it explicitly, not leave it implicit) | the correct answer depends on which tools actually carry identity — a fact todo 1 establishes empirically | yes |
| `git_*` tools | **not** server-gated (they are worker-injected, not our MCP tools; not in the payload) — disposition stated in the plan | by the user's own rule ("非我们的工具我们不管") | yes |
| Dark-mode fix mechanism | extend the existing `:root`/`.dark` CSS variables (as `--color-mention-*` already does) rather than per-component inline values | established repo pattern; no new surface | yes |
| Whether the old 越界拦截文案 is preserved | dropped; replaced by a server 403 + stable code | it was the worker plugin's output; keeping it would mean keeping the layer | yes |

## Approval gate
status: awaiting-approval
- Plan written and contract-checked: 10 column-zero task rows + F1-F4, each todo carrying all 6 required fields; dependency matrix consistent; waves ordered so enforcement precedes deletion.
- Approval authorizes **execution** (via `$start-work opencode-native-permissions-and-fixes`); it does not authorize pushing.
