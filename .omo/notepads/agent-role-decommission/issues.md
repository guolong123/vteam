# Issues — agent-role-decommission

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — findings / questions

- **Sweep beyond `.role`:** the `.role` grep cannot see the ~20 hardcoded
  `ROLE_KEYS` / `AGENT_ID_ROLE` maps in web (`tokens.ts`, `agents/page.tsx`,
  `board`, `session`, `TaskDetailDrawer`, `TeamMembersPanel`, ...). They are the
  "duplicate role maps" todo 8 must collapse and todo 6 must re-point; they do not
  read `Agent.role` directly. Listed in evidence §4b so nothing is unmapped.
- **Non-`Agent.role` `.role` hits that must NOT be migrated** (recorded so the
  "100% mapped" claim is honest): account RBAC `Role` (`user.role.permissions`,
  `prisma.role`, auth/users/guards/tools/skills/timers), LLM message
  `info.role === 'assistant'`, and `TeamUserMember.role` (`owner`/`member`,
  teams.service:752/1422, tasks:226/229, web user-members.tsx:83). All OUT-OF-SCOPE.
- **Plan line-number drift is systemic** (evidence §5): schema `Agent.role` is
  `:629`, not `:588`; exec-policy helpers ~40 lines off; web helpers ~20 lines off.
  The plan's `:350 roleNeedsIssueDetail` note is itself wrong (real `:385`).
- **DTO decision deferred to todo 5 with a recommendation:** keep the field name
  `role` (now resolved `AgentRole.name`) so seeded labels stay byte-identical and
  the UI keeps its field; add `roleId` for identity. Do not silently drop it.

## todo 2 — findings / gotchas

- **D2 null-semantics inversion is the easy bug.** "Suppress iff tools lack X"
  reads naturally as `!toolAllowed(...)`, but `toolAllowed(null,...) === false`
  makes null suppress too. The contract is `tools != null && !toolAllowed(...)`.
  Three of the new tests exist specifically to pin this.
- **`vteam-prometheus` is NOT plan duty** — only base names `plan`/`prometheus`/
  `vteam-plan` are. An early D3 test fixture used `agentKey:'prometheus'` expecting
  plan duty; corrected to `agentKey:'plan'` (a genuinely non-`a_plan` agent id).
  Do not assume the `vteam-` prefix participates in duty matching.
- **Manifest checker has no regenerate mode** — it only reports manifest-minus-observed
  as UNMAPPED (new/moved keys); it does not flag removed keys. Since every edit that
  shifts a line makes the committed file:line keys stale, the manifest was regenerated
  from the checker's own grep pipeline and the per-file delta recorded honestly
  (net 184→178; +2 new plan-docs duty reads). Do NOT hand-edit to hide the +2.
- **`plan-docs.service.ts` spec `happyPath()` now needs `prisma.agent.findMany`** or
  `resolvePlanAgentId` logs a warn and skips the gate; existing assertions expecting
  `requestRevision('is_7','a_plan')` still pass because the fixture resolves
  `a_plan` by duty.

## todo 3 — findings / gotchas

- **The plan's `:938`/`:946`/`:746` were again stale** (todo 2 shifted lines): actual
  at edit time `policyKeyOf:946`, `agentNameOf:954`, `constantRoleNameOf:754`.
  Post-edit: `:970` / `:978` / `:767`. Grep, never trust.
- **`create-agent.dto.ts` already dropped `role?:`** (sibling todo 4, unstaged) so the
  shared tree does not currently compile end to end; my files do (clean-worktree tsc 0).
  Anyone running the full suite on the shared tree before todos 4/5 land will see 4
  suite-compile failures that are NOT from this todo.
- **`agent-policies.native-edit.spec.ts` has 2 pre-existing prettier errors** (lines
  58/93) and `execution-policy.service.ts:169` one more; confirmed pre-existing by
  stashing my diff. Left untouched (todo-8 territory), only my own new error was fixed.

- **Manifest staleness shipped once (caught in final QA, fixed by amend).** The first
  regenerated manifest (176 keys) ran before a last doc-comment edit; the committed tree
  then had `UNMAPPED: 9` at its own sha. The bug was hidden because the regeneration run
  piped through `tail`, swallowing the checker's rc. Regenerated against the committed
  source (177 keys, rc=0 in a clean worktree at the sha) and the commit was amended. Do
  not trust a manifest unless `check-agent-role-consumers.sh` exits 0 on a clean checkout
  of the exact commit.

## todo 4 — findings / gotchas

- **Live-stack QA requires rebuilding BOTH containers**: `docker compose build server web
  && docker compose up -d server web` (no `--force-recreate`). The web picker change is
  invisible until the web image is rebuilt; the server DTO change is invisible until the
  server image is rebuilt. Rebuild both before asserting the create flow in the browser.
- **The e2e wrapper hard-codes the `T6_*` env names and `web/.t6.playwright.config.ts`.**
  Running `npx playwright test` manually with `T4_*` vars produces green tests but NO
  evidence JSON. Use the `T6_*` names (or edit the wrapper) so `task-6-proof.json` and
  the screenshots are actually written.
- **The picker's option set must be key-filtered, not "all /agent-roles rows"**: the live
  DB has a custom `ar_general` role with no `defaultAgentId`, which the modal intentionally
  does not offer. An e2e assertion comparing against all non-plan rows will fail — compare
  against the create key set.
- **urllib in this environment routes through a system proxy and 502s**; use
  `urllib.request.build_opener(ProxyHandler({}))` or plain `curl` for localhost API probes.
- **The plan's line numbers were stale again** (`create :190`, `clone :241`,
  `resolveTemplateSource :753`, web picker `<select> :2448`) — all confirmed by grep at
  edit time, and they had shifted once more by the time of the edits.

## todo 5 — findings / gotchas

- **`chat_channels.agent_id` is vestigial.** `toChannelDto` rendered `agent.role` from the
  channel's Agent relation, but a live DB check showed 14/14 agent-bound channels all also have
  `team_member_id` set (0 rows agent-bound without a member). The role value therefore comes
  from `row.teamMember.role` (→ `AgentRole.key`), which is the semantically correct source and
  byte-identical for every existing row. Old channels with a member but no `roleId` now render
  `role: null` instead of the old agent label — flagged as a residual (no such rows exist today).
- **Spec fixtures silently faked the new shape.** Mock rows returning
  `agent: {role:'developer'}` passed nothing to the new code → `role` came back null and 8 tests
  failed. Every teamMember fixture in the 5 touched specs now carries `role:{key,name}` (and
  `agent` only `{id,name}`). The old `agent.role` in fixtures is gone; leaving it is now a lie.
- **`prisma.agentRole.findUnique` in `addMember` with an explicit `agentId` is intentional.**
  The old test asserted `not.toHaveBeenCalled()`; the new behaviour reads the role row for the
  alias label only (does NOT resolve `defaultAgentId`), so the assertion became a `toHaveBeenCalledWith({key,name})`.
- **D3 compat arg is inert but must stay value-identical.** `resolveByAgent({role})` is ignored by
  todo 3's resolver; passing `AgentRole.key` (not `agent.role`) keeps todo 3's
  `toHaveBeenCalledWith({policyId, role, agentKey})` assertions green. Removal is todo 8's.

## todo 6 — issues found

- **Plan-line drift again (benign):** the brief's `TaskDetailDrawer.tsx:96` /
  `TeamMembersPanel.tsx:51` / `board/page.tsx:156` / `tasks/page.tsx:64` / `session/page.tsx:45`
  line numbers all matched on the day, but the follow-up line numbers (e.g. S3 at `~:553`) were
  stale. Grep-first confirmed each site before editing; nothing was missed.
- **Brief's "keep the EXISTING `a_`-prefix derivation" was wrong for one of the five files.**
  `teams/[id]/tasks/page.tsx:286` had no derivation, only `AGENT_ID_ROLE[id] ?? "developer"`.
  Un-guarded deletion would have repainted all seeded task-member avatars neutral. Fixed by
  importing the exported `toRole` from `TeamMembersPanel` (documented deviation; rendered output
  preserved). Watch for this same assumption in todo 8's collapse.
- **`ROLE_KEYS` does not contain `librarian`, but `librarian` is a live template role.**
  Any `.role`-gated UI must distinguish "known theme key" from "known role". S3 uses
  `a.type === "template"` instead, which also keeps custom rows showing `(custom)` rather than
  their agentKey. Todo 8's de-duplication must not "simplify" this back to `ROLE_KEYS.includes`,
  or `知识管理员 (librarian)` regresses to `(template)`.
- **`web/.auth/user.json` is :3001-bound** — reusing it against the :13001 container yields an
  empty shell and false-negative "element not found" failures. Use a fresh login setup on the
  target origin for live-container proof.
