# F3 Re-Review (2nd pass) — VERDICT: APPROVE

HEAD 1ec1273. Live compose stack: server :13000, web :13001, db in-network.
Fix commit contains ONLY migration + probe + spec (no runtime code), so the running
server image is valid. Migration `20260919000009_backfill_split_agent_prompts`
applied 2026-09-19 09:19:50 (prisma `migrate status`: "Database schema is up to date").

## 1. Duplication re-check on the LIVE populated DB — FIXED

Two independent methods, both against the live DB:

(a) Impl probe `scripts/t9-f3-check.ts` with the impl team's dumps (/tmp/t9-live.json):
    BEFORE: 79 shared sentences | 7/7 builtins duplicated blocks
    AFTER :  0 shared sentences | 0/7 builtins duplicated blocks
    rolePrompt byte-equal vs src constants: 7/7 true

(b) My own method (receipt: `own-method-live-assembly.json`): single JS probe run
    INSIDE the server container, reading the live DB via Prisma with the SAME discovery
    path dispatch uses (TeamMember.roleId → AgentRole.rolePrompt), assembling via the
    container's compiled `dist/src/chat/worker-dispatcher.js`, counting FULL block bodies
    (role prompt body, agent prompt body, charter constant, receipt constant) AND headings,
    with an independent clause tokenizer (split on \n。；，, len>=10) for the de-dup:

      builtin             roleBody agentBody charter receipt sharedClauses ordered OK
      a_product              1        1        1       1         0          true  ✓
      a_project_manager      1        1        1       1         0          true  ✓
      a_architect            1        1        1       1         0          true  ✓
      a_developer            1        1        1       1         0          true  ✓
      a_tester               1        1        1       1         0          true  ✓
      a_plan                 1        1        1       1         0          true  ✓
      a_librarian            1        1        1       1         0          true  ✓
      __summary: failures 0 / total 7 — exit 0

    Order per builtin: role(idx) < agent(idx) < charter(idx) < receipt(idx) — all 7 true.
    Raw agents.prompt still contains ZERO of the five pre-split markers for all 7.

(b2) Same t9 probe re-run with MY OWN live extraction (SQL dump + trailing-newline
     normalization) as input: AFTER 0 shared / 0-7 duplicated, BEFORE 79 / 7-7.
     My live extraction is byte-identical to the impl dump for all 7 rows.

## 2. Live DB direct check — CLEAN
`SELECT id, LOCATE('# 角色：',prompt), LOCATE('团队协作规约',prompt), LOCATE('回执铁律',prompt)`
→ 0/0/0 for all 7 templates. SHA2(prompt,256) for all 7 equals the migration's declared
post-split SHA (and byte-equals the current seed.ts post-split text).
Role identity (`你是任务虚拟团队中的…`) exists ONLY in AgentRole.rolePrompt: 7/7
(`live-db-role-ownership.txt`: agent_has_role_first_line=0, role_has_identity=1).
`COUNT(*) team_members WHERE role_id IS NULL` = 0 (28 members).

## 3. USER-EDIT PROTECTION — PASS (scratch DB `f3r2_scratch`, dropped after)
Fixture: A) pristine pre-split template; B) pre-split + user line; C) exact pre-split but
type=custom; D) already post-split template. The migration's 7 UPDATEs executed verbatim:
  A upgraded (1732→415, sha d29275d5…→16455a05…); B untouched (sha 0aba376f…, user line
  still present, still pre-split); C untouched (type=custom guard); D untouched.
`scratch-cleanup.txt`: SHOW DATABASES no longer lists it.

## 4. IDEMPOTENCY — PASS
Run 2 fingerprint (id, updated_at, SHA2(prompt,256)) identical to run 1;
run 3 raw output: 7 × "Query OK, 0 rows affected". Live: `prisma migrate status` → up to date.

## 5. Rest of the surface — GREEN
- `bash scripts/e2e-roles-members.sh` → exit 0, Playwright 3/3 (2 tabs / 7 builtins
  read-only no-delete / custom CRUD+persist / member by role pre-fill + override).
- My own Playwright spec (`own-ui-spec.out`): 2 tabs ["Agent","角色"], 7 builtin rows
  (keys = architect developer librarian plan product project_manager tester), name/prompt/
  default-agent inputs disabled, 0 delete buttons, 0 save buttons, builtin notice present,
  API reports 7 builtins with non-empty rolePrompt, consoleErrors=[] pageErrors=[].
- Member-by-role API probe (`member-by-role.json`): roleId-only → agentId=a_developer
  (role default); explicit a_tester wins; throwaway team deleted 200.
- `node scripts/verify-instruction-parity.mjs` → exit 0 (0 lost / 0 duplicated / 0 unaccounted).
- Frozen sha unchanged: 3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87.

## 6. Failures / anomalies
- During the builtin-protection probe I PATCHed `ar_developer.name` (API intentionally
  allows editing name/description/rolePrompt on builtins; only `key` and DELETE are 403 —
  UI is read-only, which is what the plan requires). Restored: name→开发者 and the exact
  original `updated_at` 2026-09-19 07:50:06.445 recovered from the ROW-format binlog
  before-image. Final row state matches all other builtins' migration-08 timestamps.
- No other anomalies. No QA leftovers (0 throwaway teams/roles/members; `f3r2_scratch` dropped;
  temp files under /tmp removed; web spec + config removed; no repo file modified).

Receipts: `.omo/evidence/agent-role-entity/f3-qa-rerun/`.
