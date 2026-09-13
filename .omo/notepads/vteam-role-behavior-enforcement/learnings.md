# Learnings — vteam-role-behavior-enforcement

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 2 — glob base + ROLE_BOUNDARIES

- opencode 1.18.30: `Instance.worktree` = git top-level for a git WORK_DIR, else literal `"/"`. The
  permission matcher (`permission.edit`/`read`) receives **`path.relative(worktree, absoluteFilePath)`**
  (edit/write/read/apply_patch all do this; apply_patch additionally normalizes `\`→`/`).
- `Wildcard.match` escapes regex specials, `*`→`.*` (crosses `/`), `?`→`.`, anchors `^...$`, flags `s`
  (`si` on win32). So the universal root-agnostic form `**tasks/*/<subdir>/**` matches BOTH
  `tasks/t_1/<subdir>/x` and `data/vteam-worker/tasks/t_1/<subdir>/x`. Absolute globs are useless.
- Universal form adopted; no `git init` and no absolute paths. See
  `.omo/evidence/role-enforcement/glob-base-spike.md`.
- `ROLE_BOUNDARIES` lives in `server/src/common/constants/agent.constants.ts` keyed by opencode agent name
  (`vteam-<role>`/`vteam-plan`); `toolAllows` uses real exposed names (MCP `vteam_<action>`, custom
  `git_<action>`); `mcpDenies` is derived as the MCP-namespace complement of `toolAllows`.
- Gotcha: JSDoc `/** ... */` cannot contain the literal `*/` — glob strings like `**tasks/*/` contain it and
  truncate the comment. Use `//` line comments (or split the glob) when documenting glob literals.

---

## Todo 3 + 5-9 — ExecutionPolicy seed + role prompts

- `seed.ts` imports `ROLE_BOUNDARIES` / `buildEditPermission` / `buildReadPermission`; all 5 `ep_<role>`
  policies are derived from the boundary map (zero literals). Policies upsert **before** template-agent
  upserts; `agent.upsert` update+create both bind `policyId`, so update keys are now `['policyId','prompt']`.
- Permission shape decision: the task prose ("`...buildEditPermission(writeGlobs)`" flat) vs plan L91/L154
  and opencode's config require the **nested** `permission.edit` glob map. Implemented nested:
  `{ edit: buildEditPermission(...), read: buildReadPermission(), bash, task:'deny', ...mcpDenies:'deny' }`,
  **no `write` key**. Derived matrix verified against plan L285-289 (10/12/13/12/11 keys, 0 bare MCP names).
- `correction = { scopeSummary, handoff: handoffTo, denyTemplate }`. `denyTemplate` uses
  `vteam_notify_agent` (still contains the required `notify_agent` substring, keeps no-bare-name rule).
- Prompts rewritten, four-direction headers kept; banned substrings 主 Agent/牵头协调者/UI 设计 absent from
  the templateAgents region; every MCP mention uses `vteam_<action>`; `git_*` stays bare (custom namespace).
- `npx tsc -p tsconfig.json --noEmit` → exit 0 (2 runs, incl. final). `seed.spec.ts` fails as expected —
  its mock has no `executionPolicy` and asserts update keys `['prompt']`; Todo 10 owns both fixes.

---

## Todo 10 — seed.spec.ts updated

- `mockPrisma` gained `executionPolicy: { upsert }`; spec now has 9 green tests. Existing intent preserved
  (template count=5, no ack, defaultModelId null, update whitelist, team owner upserts).
- update whitelist assertion is now `['policyId','prompt']` (+ explicit not-haveProperty for
  `permissionScope/name/persona/defaultModelId`).
- Ordering check uses `mock.invocationCallOrder.slice(-5)` on both mocks (robust whether or not
  `clearAllMocks` resets invocationCallOrder): `max(policy) < min(agent)`.
- Policy assertions are structural, not re-derived from `ROLE_BOUNDARIES` (avoids tautology): nested
  permission, no `write`, `edit['*']='deny'` + all other globs allow, `read={'*':'allow'}`, bash in
  allow/ask/deny, `task='deny'`, every non-special key is a `vteam_*` deny (no bare names/no stray keys),
  `vteam_task_transition` deny for all roles, correction.denyTemplate contains `vteam_notify_agent`.
- Bare-MCP-name prompt check: derive bare names from `VTEAM_MCP_TOOL_NAMES` and use
  `(?<!vteam_)\b<bare>\b`. Plain substring counting FALSE-POSITIVES on `doclibOnly` (contains `doclib`)
  and on `vteam_<name>` occurrences; word boundary + lookbehind avoids both. Prompts also must keep
  `转交` + `vteam_notify_agent` (handoff) and must not contain `UI 设计`.
- `npx jest src/prisma/seed.spec.ts --runInBand` → 9/9 pass; `npx tsc -p tsconfig.json --noEmit` → exit 0.
  Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`.

---

## Todo 11 — ExecutionPolicyService + policyId binding

- Partial DTOs from failed attempt were already in the NEW nested `{permission, correction}` shape — kept as-is.
- Canonical service: `server/src/execution-policies/execution-policy.service.ts` (CRUD + `resolveByAgent`); dead duplicate
  `platform-mcp/execution-policy.service.ts` (old `{permissions,writePaths}` shape) had zero importers — deleted.
- DTO class → `Prisma.InputJsonValue` needs `as unknown as` cast (class without index signature doesn't overlap `InputJsonObject`).
- Controller specs with `@UseGuards(PermissionGuard)` must `.overrideGuard(PermissionGuard).useValue({canActivate:()=>true})`
  (see skills/tasks/teams controller specs); otherwise Nest fails resolving `PrismaService` in RootTestModule.
- Permission points reuse agents domain: reads `agents.view`, writes `agents.edit`; template rows 403 via service `assertWritable`.
- `resolveByAgent`: `policyId` first, else `ep_<role>` naming lookup; agentName `vteam-<role>`/`vteam-plan`; invalid config → null (caller falls back).

## Todo 12 — GET /api/v1/agent-policies (2026-09-13)
- `ExecutionPolicyService.buildAgentPolicies()` 纯函数：值全部由 `ROLE_BOUNDARIES` + `buildEditPermission`/`buildReadPermission` 派生，与 seed 角色策略同形（`task:'deny'`、无 `write` 键、MCP deny 全 `vteam_` 前缀）。
- 新增 `ROLE_BASH_DENY_PATTERNS`（16 项，含 `>`/`>>`/`tee`/`cp`/`mv`/`sed -i`/`truncate`/`dd`/`ln`/`python -c`/`node -e`/`perl -i`/`git apply`/`patch`/`git push`/`rm`）+ `ROLE_POLICY_DENY_TEMPLATE`（与 seed 同值，seed.ts 未动）。
- 端点鉴权复用 `@Public() + WorkerOrJwtGuard`（mcp-servers/tools/skills GET 同模式）；unauth → 401。
- spec 用 supertest 真实 guard：worker token 走 worker 通道 200；jwt 通道 stub 401（测试环境无 passport 策略）；`onModuleInit` 需 `executionPolicy.findMany` mock。
