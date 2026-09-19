# Learnings — agent-role-entity

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — AgentRole model + TeamMember.roleId + backfill migration (done)

- **id prefix `ar`** (`AGENT_ROLE_ID_PREFIX`): builtin rows use named ids `ar_<role>` (mirrors `a_<role>` / `ep_<role>`);
  migration-derived custom rows use `ar_c_<md5(raw)[:16]>`; fallback is `ar_general`.
- **Single source of truth** = `server/src/common/constants/agent-role.constants.ts`
  (`BUILTIN_AGENT_ROLES`, `FALLBACK_AGENT_ROLE`, `deriveCustomAgentRoleKey/Id`). `seed.ts` keeps a
  self-contained mirror (its documented convention: no `../src` imports in the runner image).
- **Fresh-DB ordering gotcha**: `migrate deploy` runs BEFORE seed (docker-compose `init` service), so at
  migration time `agents` is empty. The builtin INSERT resolves `default_agent_id` via scalar subquery
  `(SELECT id FROM agents WHERE id='a_product')` → NULL on fresh DB; **seed backfills** it via
  `agentRole.updateMany({ where: { id, defaultAgentId: null } })` (create-if-absent, never overwrites
  a user-edited default). Directly FK-ing to a not-yet-existing agent row would break fresh deploys.
- **Backfill case (ii) derivation** (must stay byte-identical in SQL and TS):
  `stem = LEFT(TRIM(BOTH '_' FROM REGEXP_REPLACE(LOWER(TRIM(role)),'[^a-z0-9]+','_')),32)` fallback `'role'`;
  `key = 'custom_'||stem||'_'||LEFT(MD5(role),8)`; `id = 'ar_c_'||LEFT(MD5(role),16)`. **MD5 hashes the RAW
  role**, not the normalized form — TS `deriveCustomAgentRoleKey` deliberately hashes raw too. Vector:
  `role='analyst' → custom_analyst_05d5c5df / ar_c_05d5c5dfb743a5bd`.
- **Live data had zero case ii/iii members** (28 members, all builtin). Had to CONSTRUCT probes
  (`a_probe_analyst` role='analyst', `a_probe_norole` role=NULL) before `migrate deploy`, then clean up.
  Post-migration verified tally: case-i 28 / case-ii 1 / case-iii 1 / MISMATCH 0, nulls 0.
- **FK proof on live MySQL 8.4.11**: deleting `ar_product` while in use → ERROR 1451 (RESTRICT works);
  deleting an agent that is `default_agent_id` → column becomes NULL (SetNull works, agent deletion not blocked).
- **Contenant migration path**: host MySQL port 3306 is not published (Docker Desktop macOS), so copy the
  migration dir + schema into `aiagents-compose-server` and run `npx prisma migrate deploy` there.
- Jest baseline grew 134→136 suites / 3101→3124 tests; `tsc --noEmit` exit 0; frozen baseline sha unchanged.
- **Next todos read `roleId`**: the running server container still has the OLD generated Prisma client
  (built before this migration); a rebuild/`prisma generate` is needed before services can use `agentRole`/`roleId`.

## todo 2 — classify the 7 built-in prompts (role/agent/platform) (done)

- **Reconstruction method**: `seed.ts` stores prompts as JS string concatenations across many physical
  lines. Classify the LOGICAL (rendered) lines: evaluate the `templateAgents` array literal with
  `planToolLine` in scope, then `prompt.split("\n")`. `planToolLine` is itself re-derived from
  `ROLE_BOUNDARIES["vteam-plan"].toolAllows` in the same file (the eval string came from seed.ts alone).
  Stable key for todo 8 = `(agent key, rendered line index)`; 264 lines total
  (39/42/36/38/38/41/30).
- **Artifact**: `.omo/evidence/agent-role-entity/task-2-classification.json` (oracle) +
  `task-2-classification.txt` (human table). Checker `scripts/verify-prompt-classification.mjs`
  re-derives both sides and exits 1 on any unclassified/drifted/duplicated line; negative case proven.
- **Tally**: role=97, agent=92, platform=55, removed-intentionally=20.
- **Block semantics**: 团队协作规约 ×7 + 回执铁律 ×4 are `platform` (universal). 派发铁律 (PM) and
  修订铁律 (plan) are role-specific → `agent` (NOT folded into the platform block). 收敛契约 (plan) is
  likewise role-specific → `agent`. librarian has no 铁律 section; todo 3 deliberately EXTENDS 回执铁律 to
  all 7 (PM/plan/librarian gain it). This is why the artifact marks 回执铁律 platform at only 4 of 7 rows.
- **O6 removals**: 20 `## 权限` enumerated prose lines → `removed-intentionally`; pointer
  `权限边界以 ExecutionPolicy/【职责边界】为准，越界会被拒绝` is kept (product/PM/architect/developer/tester/
  librarian already have a live pointer line; **plan has none** — its 权限 §13 is an enumerated tool list
  that must be REPLACED by the pointer in todo 4, and the `seed.spec.ts` "可用工具" assertion must move).
- **Marker drift vs the task brief**: the brief quoted 团队协作规约 at seed `:576..849` and 回执铁律 at
  `:582/674/719/764`; the literal string lines are `:605,650,697,742,787,831,878` and `:611,703,748,793`.
  I anchor by content (checker-verified), not by the stale offsets.
- **Do NOT classify** the 3 unrelated `团队协作规约` occurrences at `seed.ts:2236-2260` (team-memory
  charter content) — they are not `templateAgents[].prompt` content.
- **Split consequence for todo 4**: all `## 职责` module-example bullets stay `role` even when they name a
  tool (vteam_issue_*, git_*, vteam_plan_complete) — the *responsibility* is the post, the tool is its means.
  Only `## 工作方式`/refusal-script/pointer lines are `agent`; the task-brief examples put 工作方式 in agent.

## todo 6 — AgentRole CRUD module + builtin protection (done)

- **New module** `server/src/agent-roles/` (controller/service/dto + 2 specs), registered in `app.module.ts`.
  Routes `/api/v1/agent-roles`: GET / (list), GET /:id, POST, PATCH /:id, DELETE /:id.
- **Permissions reused from the agents matrix, NOT invented**: read=`agents.view`, create=`agents.create`,
  update=`agents.edit`, delete=`agents.delete` — same `@UseGuards(PermissionGuard)` + `@RequirePermission(...)`
  idiom as `agents.controller.ts`. Asserted directly in the controller spec via
  `Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)` (pattern from artifacts/tasks/chat controller specs).
- **Builtin protection constant**: `AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY` (mirrors
  `AGENT_ERRORS.AGENT_READONLY` = `PERMISSION_AGENT_READONLY`). Declared `type='builtin'` → DELETE 403 and
  the row survives (asserted: `agentRole.delete` never called; live GET still 200). Same code for
  PATCH-builtin-`key` → 403.
- **Decision (recorded): PATCH on a builtin IS allowed** for `name`/`description`/`rolePrompt`/`defaultAgentId`
  (the Roles tab reads them), but changing `key` → 403. Mirrors the agents module (is_0000000030 lets template
  agents edit settings, `agentId`/`type` immutable). `type` is absent from the DTO, so it is structurally
  immutable; `key` is the builtin identity anchor and is explicitly guarded.
- **defaultAgentId validation**: non-null value must resolve to an existing `Agent` (else 400
  `AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND`); `null`/absent clears/skips without a DB lookup. Validated on both
  create and update.
- **key**: `AGENT_KEY_PATTERN` (`^[a-z][a-z0-9_-]{0,62}$`) at DTO + service; uniqueness via `uk_agent_roles_key`
  → P2002 mapped to 409 `AGENT_ROLE_KEY_CONFLICT`. In-use role delete (FK RESTRICT) → P2003 mapped to 409
  `AGENT_ROLE_IN_USE` (never silently deletes).
- **No capability fields**: response object is exactly {id,key,name,description,type,defaultAgentId,rolePrompt,
  sortOrder,createdAt,updatedAt}; a spec asserts the key set and the absence of permission/tools/model/worker.
- **List order**: `orderBy: [{type:'asc'},{sortOrder:'asc'}]` — 'builtin'<'custom', so the 7 builtins lead,
  which is the authoritative listing contract (the task brief said "type/sortOrder order").
- **Live data caveat (expected, not a bug)**: todo 4 has not run, so all 7 builtin `role_prompt`s are still
  NULL. GET returns 7 builtins each with `defaultAgentId` set and the `rolePrompt` key present (value null).
  The spec asserts key presence + a mocked value, not non-null live data, so it won't false-fail pre-todo-4.
- **Container rebuild required** (carries over from todo 1): the running image predated the AgentRole model.
  `docker compose build server && docker compose up -d server` (plain up, NO `--force-recreate`) — the `init`
  service ran `migrate deploy` + seed, both idempotent; 8 rows preserved (7 builtin + ar_general).
- **Full-suite baseline**: grew 136→138 suites / 3124→3162 tests; `tsc -p tsconfig.json --noEmit` exit 0.
- **Evidence**: `.omo/evidence/agent-role-entity/task-6-api.json` (+ reusable `task-6-proof.sh`) with raw
  HTTP 200/201/403 outputs; DB recheck after delete-builtin = 8 rows, `ar_product` intact.
