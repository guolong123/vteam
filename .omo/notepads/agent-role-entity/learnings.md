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
