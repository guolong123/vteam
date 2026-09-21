# Issues — opencode-native-permissions-and-fixes

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — findings that todo 3 must not get wrong

- **Brief correction (recorded, not a blocker):** the plan's chain said
  `TeamMember.roleId -> AgentRole -> role's tools allowlist`. Reality: `AgentRole` carries no
  capability fields; the matrix belongs to the **Agent** (`policyId`/`agentKey`) and is resolved by
  `ExecutionPolicyService.resolveByAgent`. Todo 3 must NOT introduce a `roleId`-keyed lookup.
- **`channel_send` has no `selfInstanceId`** and resolves its task from the worker's most recent
  session — which is not guaranteed to be the invoking session. Todo 3 needs an explicit decision
  for it (todo 1's recorded policy: unresolvable caller → 403).
- **Fail-closed vs the worker guard's leniency is a deliberate divergence**, not an oversight.
  `worker/src/role-guard/policy.ts:109-121` passes through on unresolvable identity because the
  engine's native `permission` config is a second gate behind it. The server-side check has no such
  backstop once todos 4/5 land, so it must be strict. Documented in
  `server/src/platform-mcp/CONTRACT-tool-naming-and-identity.md` §4.
- **Naming order differs between the two registries.** `VTEAM_MCP_TOOL_NAMES` and the
  `buildPlatformMcpTools` array are set-equal but NOT in the same declaration order (e.g.
  `memory_search` vs `memory_update`). Assert set equality, never array equality — an order-strict
  assertion is a false-positive trap.
- The **`_meta.progressToken`** in the envelope is easy to miss: without it the byte lengths are
  28 short. It is part of what makes the raw capture byte-exact.

## [2026-09-20] Task 2 踩坑
- apply 迁移到 live 时用 `docker cp` 把新迁移目录送进 `aiagents-compose-server` 再 `prisma migrate deploy`
  （server 镜像是构建期 COPY 的，包含到那时为止的 migrations）；**不要** `docker compose up -d --force-recreate`
  （会重跑 init → reseed）。server 重建用 `docker compose up -d --no-deps --build server`。
- `teams.service#warnIfOpencodeAgentUnknown` 传 `{id}` 给 `listAgents` 是既有隐患（跨容器永不告警）；
  本任务的新 validator 已按 `listOpencodeAgents` 的正确姿势带 capabilities，未去改 teams（超出 scope）。
- write 工具对已存在文件不覆盖（返回 "File already exists"），需用 edit。

## [2026-09-20] todo 4 踩坑

- **Parallel-todo interference in the full suite.** `npx jest --runInBand` (whole server) reports
  one failure in `src/platform-mcp/platform-mcp.tool-permission.spec.ts` — that file is **untracked
  in-flight todo 3 work**. Proof it is not ours: `git stash push -- server/src/execution-policies/execution-policy.service.ts`
  and the spec still fails identically. Final full-suite gate must be read as
  "144/144 with the todo-3 spec excluded". Do not "fix" it here (scope: MUST NOT touch `platform-mcp/**`).
- **`guard.roles[*].permission` vs `agents[].permission` divergence is intentional and temporary.**
  Any harness/spec that compared the two as equal must now project one side; the ordering hazard
  means the guard side must keep the `vteam_*` detail until todo 5 deletes the worker guard.
- **Old baseline artifact is not superseded in place.** `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  is still referenced by `scripts/e2e-third-party-no-policy-leak.sh` (asserts ITS sha is unchanged)
  and by the historical-value specs — do not delete or rewrite it.

## [2026-09-20] Task 3 踩坑

- 单测里给 `ExecutionPolicyService` 造 prisma mock 时，**要传测试自己改的那个 prisma 对象**：
  先用 `realPolicyService(null)` 造内部 mock、再去 mutate 外层另一个 prisma 对象，会导致
  `resolveByAgent` 走常量回退（内置名），"翻转矩阵"的断言其实没被读到（症状：deny 用例
  "resolved instead of rejected"）。修法：`realPolicyService(policy, alternatePrisma?)`，
  翻转测试把同一个 prisma 传进去。
- 真栈验证服务端门时，仍存活的 worker guard 会先拦下未授权工具，看不到服务端门的效果；
  必须用「只改 DB、不重启 worker」的差分（见 learnings）。
- 拒绝对 `/agent-policies` 的 frozen baseline 做任何事（todo 4 已有新 baseline 文件）。

## [2026-09-20] todo 5 踩坑

- **任务中误伤过一次 DB（已修复）**：手工验证时用 `curl --data '{"config":{"permission":
  {"bash":"deny"},"correction":{}}}'` 做了一次**截断式 PATCH**，把 `ep_product` 的
  permission/tools/correction 覆盖成残缺形状。修复：用 harness 保存在
  `EVIDENCE_DIR/f2-original-policy.json` 的完整快照 PATCH 回去，并逐字节验证
  `live == frozen baseline`（`JSON.stringify` canonical 相等）+ tools 计数 27。
  教训：对 execution-policies 的 PATCH 永远是「读原 config → 只改目标字段 → 整体回写」，
  绝不手写最小 body。
- **urllib 在本机会走代理返回 502**，而 curl 直连正常 —— 诊断时不要据此判定 server 挂了。
- `grep -c` / `head -N` 片段做 `bash -n` 检查会误报（heredoc 被截断），定位语法错误要按
  完整块抽取。
- permission-matrix 的 4f/4g 是**环境夹具依赖**（需要 review-round ledger / 终态任务），
  本 DB 没有；已改为「缺夹具 → 显式 SKIP 并记录」，不再硬 FAIL（相应单测在 server spec 里）。

## [2026-09-20] todo 6 踩坑

- **`config.permission.task` is NOT validated by `assertValidConfig`** (unlike `bash`, which is checked
  against `PERMISSION_EFFECTS`). The API will happily store `task: 'bogus'`. Consequence for this todo:
  the UI is the *only* thing keeping an illegal task out, so (a) the control must never offer a fourth
  option, (b) display must normalize a stored illegal value to `deny`, and (c) a click must write a legal
  value through. If a future todo wants server-side symmetry, that is a `server/` change (not in scope
  here — todo 6 MUST NOT touch `execution-policy.service.ts`).
- **First screenshot missed the target.** `page.screenshot({fullPage: true})` captured the MCP tool list
  because the content pane scrolls internally; `scrollIntoViewIfNeeded` on the task row is required.
  The evidence file was replaced by re-running the harness (the artifact is regenerated, not hand-edited).
- **Probe residue:** the recon step created a throwaway custom agent + policy (`a_0000000007`/`ep_0000000007`)
  to exercise the invalid-value path before the spec existed. Both DELETEd (200/200, re-GET 404) at the end;
  the 7 seed `ep_*` rows and the live `/agent-policies` payload are canonically equal to the frozen baseline.

## [2026-09-20] Orchestrator — PLAN DEFECT found at todo 7 (auto-continuation turn)

- **todo 7 was NOT done.** The prior session ended mid-deliberation: no commit, no `task-7-*` evidence,
  no `task_sessions` entry; `member-external-agent-select` still at `teams/[id]/page.tsx:121`,
  `role-default-agent` still internal-only at `AgentRolesTab.tsx:537-552`, `web/src/api/agent-roles.ts`
  has no `defaultOpencodeAgentName`. The earlier "todos 6 and 7 dispatched and reported complete" note
  was wrong about 7. Todo 6 WAS real (`b7b25e5`) and I re-verified it independently.
- **Defect: the todo-2 external slot had ZERO runtime consumers.** `defaultOpencodeAgentName` is
  write/validate-only (`agent-roles.service.ts:116,134,205,282`; DTOs; `opencode-agent-name.validator.ts`).
  Dispatch reads only the member-level field (`worker-dispatcher.ts:3671-3687` → `:2193-2213`); the role is
  loaded only for `rolePrompt` (`:2088-2089`). `resolveMemberBinding` (`teams.service.ts:1317-1366`) resolves
  only the internal slot. So todo 7 as written would kill the external capability and make todo 10(e)
  ("the member resolves to it") unprovable — while Scope OUT (`plan:56`) forbids a dispatch-precedence change.
- **Resolution (orchestrator, recorded as todo 7 ADDENDUM): Option A — symmetric prefill.** Extend
  `resolveMemberBinding` so the role prefills the member's external slot (`role.defaultOpencodeAgentName`
  → `TeamMember.opencodeAgentName`) when the caller did not pass one; explicit member value still wins;
  `worker-dispatcher.ts` untouched. This completes the pattern todo 2 began (mutually-exclusive prefill
  slots) and touches member *binding*, not dispatch *precedence* → Scope OUT preserved. Todo 7 is now
  server+web and executes as two file-disjoint slices (one commit each).
- **Ordering:** todo 7 must land before todo 8 — both edit `AgentRolesTab.tsx` + `teams/[id]/page.tsx`.
  Watch-out for todo 8: todo 7 REMOVES the member caveat amber in `teams/[id]/page.tsx`
  (`member-external-agent-caveat:144`), so that spot of the todo-8 defect may no longer exist —
  the todo-8 worker must verify and fix only what survives.

## [2026-09-20] todo 8 — dark-mode close-out notes

- **First spec run used the wrong cwd.** Running `npx playwright test --config
  .t8.playwright.config.ts` from the repo root fails (`config does not exist`); the throwaway
  config lives in `web/`, so run from `web/` with `T8_SCREENSHOT=../.omo/...` (or keep
  `testDir: ./e2e` anchored to `web/`).
- **Spec skips the warning-colour branch when the engine has no external agents**
  (`empty`/`unavailable` → `test.skip`). Passing 2/2 therefore means the warning assertions ran
  (no skip observed); if a skip appears, the PNG still proves the dark role-item state.

## [2026-09-20] todo 9 — suite-refresh notes

- **08 doc was untracked, not modified** — the brief's "251 lines, ~50 cases" describes the
  on-disk file, but it was never committed (00–07 are tracked, 08 is not). Staged via plain
  `git add` in the todo-9 commit; nothing to `git mv`.
- **f2 first attempt FAILED for an env reason, not a product bug**: `WORK_DIR=/tmp/...`
  leaked into `WORKER_WORK_DIR`, so the live `docker compose cp` fetch read a static host copy
  and the 180s poll timed out. Reran with `WORK_DIR` unset + `INJECTED_OPENCODE_JSON` for the
  static f-contract check → full `ALL SCENARIOS DONE: a/c/d/e/f/f2/g`. No product code touched;
  per the brief's MUST-NOT-DO this was recorded here, not "fixed" anywhere.
- **Stale comment traps fixed in this todo** (docs/specs/harnesses only):
  `scripts/e2e-native-rule-editor.sh` header still said "task is read-only + note";
  `web/e2e/policy-restart-notice.spec.ts` header still named the deleted
  `.vteam-role-guard/roles.json` as a live injection artifact. Both corrected to the shipped
  arrangement; assertions themselves already matched reality.

## [2026-09-20] todo 10 — issues (proof-only, no product changes)

- **Seed ships agents + worker with no defaultModelId** (`Agent.defaultModelId=null`,
  `worker.defaultModelId=null`); a fresh-stack dispatch runs `model=(default)` and fails before
  any tool executes. Worked around per-run (explicit model, restored to null after). If dispatch
  without a configured model should fail loudly instead of attempting `(default)`, that is a
  `server/` change — out of scope here, recorded only.
- **No product bug found during the proof.** The only anomalies were probe-shape issues
  (invalid action enum, proxy-blocked urllib), both resolved in the probe, not in product code.
  `git status -- server worker web scripts docs` shows only the pre-existing untracked
  prototype dirs → this commit is evidence + notepad only.

## [2026-09-20] task-11 — dual-empty context backfill

- Fix is outside the completed 14-todo plan; no `.omo/plans/*.md` change needed.
- All gates verified independently before closeout (`tsc` 0, 13 suites / 428 tests, live
  legs A/B/C); closeout job was notepad appends + exact-path commit only — no source,
  spec, evidence, rebuild, push, or DB touched.

## [2026-09-20] task-12 踩坑
- Working tree was already dirty (unrelated .omo/plans + evidence modifications from
  other plans); commit staged ONLY the 4 task-12 files (+ 2 notepad appends +
  1 evidence file) via explicit `git add <paths>` — never `git add -A`.
- `parseTimeoutMs` unit test initially asserted a wrong expectation for float-like
  input in my own draft; settled contract: only `^\d+$` strings parse, `'12.5'` →
  fallback (decimal-int-only, per brief).

## [2026-09-20] first-token wake-retry — 无产品缺陷遗留

- 本次改动为既有首字 watchdog 的行为增强（静默 → 唤醒重试 ×3 → 耗尽失败），
  `tsc` 0 + `src/chat` 13 套件 / 497 测试全绿；未发现新的产品缺陷。
- 记录一条设计副作用（非缺陷）：durable「重启路径」唤醒后重武装、DB `lastActivityAt`
  在唤醒时刻被刷新——若此窗口内发生进程重启，重启判定会因
  `lastActivityAt > 原 dispatchedAt` 而跳过收割。该窗口由该会话后续的活跃事件或
  空闲判死扫描兜底（30min），与原实现「重启后不重启收割即静默丢弃」相比不再更差。

## [2026-09-21] SERVER slice — team-create member selection map (role-based binding exploration, read-only)

Exploration only; no production code touched. Single-precedence-point invariant + 3-path divergence matrix with file:lines.

### Files mapped
- `server/src/teams/teams.service.ts` — `create` (:86-240), `addMember` (:615-679), `updateMember` (:832-932), `resolveMemberBinding` (:1328-1430), `warnIfOpencodeAgentUnknown` (:942-964); `roleBindingOf` DELETED (only stale comment ref at spec:371; resolver now does single role query :1373-1384).
- `server/src/teams/dto/create-team.dto.ts` — `TeamMemberInput` (:13-46), `CreateTeamDto` (:48-85).
- `server/src/teams/dto/add-member.dto.ts` — `AddMemberDto` (:15-47), `UpdateMemberDto` (:49-96).
- `server/src/teams/dto/update-team.dto.ts` — team-level update (name/desc/reuseSession/managedMode/mainAgentMemberId/version; no member binding).
- `server/src/tasks/dto/update-team.dto.ts` — `TeamInstanceInput` (:11-34), `UpdateTeamDto` (:42-61).
- `server/src/tasks/tasks.service.ts` — `TeamMemberView` (:54-66), `updateTeam` caller (:763-837), `createTeamMembers` (:1845-1898), `toTaskDto` read (:1778, :1793-1797).
- `server/prisma/schema.prisma` — `AgentRole` (:124-158, slots :137-143), `TeamMember` (:160-189, external :171-175).
- `server/src/agent-roles/agent-roles.service.ts` — slot conflict (:187-188, :298-305), auto-clear on update (:198-209).

### resolveMemberBinding rules 1-5 (teams.service.ts:1331-1343 doc, enforced :1367-1429)
1. Explicit `agentId` wins — :1392-1400 (never overwritten by role default; roleId only persisted alongside).
2. `roleId`-only prefills `agentId` from `AgentRole.defaultAgentId` — :1422-1429.
3. Role with empty `defaultAgentId` (roleId-only) → 400 `ROLE_DEFAULT_AGENT_MISSING` — :1416-1421.
4. Both missing → 400 `MEMBER_AGENT_REQUIRED` — :1403-1408.
5. External symmetric prefill (rule-2 mirror): explicit `opencodeAgentName` > `role.defaultOpencodeAgentName` > null — :1386-1390 (`explicit || role?.defaultOpencodeAgentName?.trim() || null`); branch-1 (explicit agentId+roleId) ALSO resolves external (:1341-1343, :1371-1372) because external roles can never hold `defaultAgentId` (mutual exclusion) so their members must pass explicit `agentId`.
- `updateMember` never clobbers persisted value — :894-910: explicit `dto.opencodeAgentName !== undefined` branch writes (empty→null, non-empty→warn+write :898-902); ELSE only if `prefilled && !(member.opencodeAgentName?.trim())` (:903-906) writes role default (prefill ≠ override :907-909). Request-level precedence: explicit > persisted > role default.
- Role row read once for both branches: `agentRole.findUnique where:{id} select:{id,key,name,defaultAgentId,defaultOpencodeAgentName}` :1373-1384.

### Error codes (exact)
- `MEMBER_AGENT_REQUIRED` (400 BadRequest) — teams.service.ts:1404-1407 (both agentId+roleId missing).
- `ROLE_NOT_FOUND` (404 NotFound) — teams.service.ts:1410-1415 (`agentRole.findUnique` null on roleId-only path; branch-1 with bad roleId does NOT throw — persists dangling roleId with null label).
- `ROLE_DEFAULT_AGENT_MISSING` (400) — teams.service.ts:1416-1421.
- `AGENT_ROLE_DEFAULT_SLOT_CONFLICT` (400) — agent-roles.service.ts:298-305, thrown :187-188 (create+update both-non-null); update auto-clear :198-209 (set one clears other; both-absent leaves untouched). Defined in `AGENT_ROLE_ERRORS`.
- Adjacent (not requested but on path): `AGENT_NOT_FOUND` (404, teams.service.ts:630-634 create-transaction :130-135 / updateMember :886-891; tasks.service.ts:1856-1861), `AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND` (400, agent-roles.service.ts:336-341).

### DTO required vs optional
- `TeamMemberInput` (create-team.dto.ts:13-46): ALL optional — `agentId?`, `roleId?`, `alias?`, `workDir?`. NO `opencodeAgentName` field declared (resolver still reads `input.opencodeAgentName` :1369 — extra key only flows via `as any`/unvalidated passthrough; spec uses `as any` for explicit-external cases). At-least-one enforced in service (rule 4), not by validators.
- `AddMemberDto` (add-member.dto.ts:15-47): same shape — all optional, NO `opencodeAgentName` declared; header comment :7-13 documents external symmetry anyway; explicit-external tests cast `as any` (spec:1210-1214).
- `UpdateMemberDto` (add-member.dto.ts:49-96): `alias?`, `workDir?`, `overrideModelId?`, `opencodeAgentName?: string|null` (:69-76, MaxLength 64), `roleId?: string|null` (:78-87, null/empty clears binding), `agentId?` (:89-95). ONLY DTO that officially carries the external slot.
- `TeamInstanceInput` (tasks/dto/update-team.dto.ts:11-34): `agentId: string` REQUIRED (`@IsString()` no `@IsOptional`), `roleId?`, `alias?`, `workDir?`; NO `opencodeAgentName`.

### Path-by-path difference matrix
| dimension | teams.create (teams.service.ts) | teams.addMember (teams.service.ts) | tasks.createTeamMembers (tasks.service.ts) |
|---|---|---|---|
| entry DTO | `TeamMemberInput[]` (all-optional, no external field) create-team.dto.ts:13-46 | `AddMemberDto` (all-optional, no external field) add-member.dto.ts:15-47 | `TeamInstanceInput[]` (`agentId` REQUIRED) tasks/dto/update-team.dto.ts:11-34; called from `updateTeam` :837 |
| via `resolveMemberBinding`? | YES — pre-transaction `Promise.all(members.map(resolve))` :101-103 | YES — single `await resolveMemberBinding(dto)` :623-624 | NO — bypasses entirely; inline logic :1851-1887 |
| role lookup shape | full `{id,key,name,defaultAgentId,defaultOpencodeAgentName}` :1373-1384 | same full select | NARROW `{key,name}` only :1862-1867 (no default slots read; dangling roleId silently kept, no ROLE_NOT_FOUND/ROLE_DEFAULT_AGENT_MISSING) |
| agent existence check | `tx.agent.findUnique select:{id,name}` per member INSIDE tx :126-135 → 404 AGENT_NOT_FOUND | `prisma.agent.findUnique` BEFORE tx :625-634 → 404 | `tx.agent.findUnique select:{id,name}` :1852-1861 → 404 `TASK_ERRORS.AGENT_NOT_FOUND` (same semantics, different error table) |
| external prefill | YES rule 5 → `teamMember.create {opencodeAgentName: item.opencodeAgentName ?? null}` :147-149 | YES rule 5 → `create {opencodeAgentName: binding.opencodeAgentName}` :647-648 (already null-coalesced in resolver :1387-1390) | NONE — `teamMember.create` data :1877-1886 has NO `opencodeAgentName` key (relies on DB default null); input type :1848 has no external field |
| persisted columns | id/teamId/agentId/roleId(`?? null`)/opencodeAgentName/alias/seq/workDir :141-154 | id/teamId/agentId/roleId/opencodeAgentName/alias/seq/workDir :641-653 | id/teamId/agentId/roleId(`?.trim()\|\|null`)/alias/seq/workDir :1877-1886 (no external, no overrideModelId) |
| seq strategy | `nextSeqForUpdate` (SELECT MAX FOR UPDATE) :136 | same :637 | aggregate `_max` :1868-1872 (no FOR UPDATE) |
| returned DTO | full team via `findOne` → `toTeamDto` includes `opencodeAgentName: m.opencodeAgentName` :1497 | same `findOne` :678 | `TeamMemberView` type HAS `opencodeAgentName?` :62 but `createTeamMembers` return push :1888-1895 OMITS it (+omits roleId/overrideModelId); read path `toTaskDto` DOES return `m.opencodeAgentName ?? null` :1778 |
| `agentId` effectively required? | NO (roleId-only prefill allowed) | NO (same) | YES (DTO required + no prefill branch; missing → validation/undefined `findUnique`) |

### Divergence flags (tasks.createTeamMembers)
- Direct `agent.findUnique` :1852-1855, no resolver; role lookup limited to `{key,name}` :1865 (vs full 5-field select) — cannot prefill either slot.
- No external prefill: neither reads `AgentRole.defaultOpencodeAgentName` nor writes `TeamMember.opencodeAgentName` (:1877-1886).
- `agentId` effectively required: `TeamInstanceInput.agentId` non-optional (tasks/dto/update-team.dto.ts:12-14) + no rule-2/4 logic → role-only calls impossible.
- `TeamMemberView.opencodeAgentName?` declared (:62) but never populated by the writer (:1888-1895); only the reader (`toTaskDto` :1778) surfaces it — write/read asymmetry to fix in implementation (writer should go through `resolveMemberBinding` or equivalent).

### `warnIfOpencodeAgentUnknown` (teams.service.ts:942-964)
- Weak check only: `assignWorker()` → null ⇒ silent return :947-950; `listAgents({id})` empty ⇒ return :951-954; name mismatch ⇒ `logger.warn` :955-960, NEVER throws; outer try/catch swallows all :961-963. Called ONLY from `updateMember` explicit branch :900-902 (create/addMember prefill paths do NOT warn).

## [2026-09-21] server createTeamMembers unification — landed
- `createTeamMembers` bypassed `resolveMemberBinding` (narrow `{key,name}` role read, agentId required, no external write). Fixed via private `resolveTaskMemberBinding` mirror (rules 1–5, same-value error codes); writer persists `roleId`+`opencodeAgentName`; view push populated. tsc 0; `src/tasks|src/teams` 13 suites / 413 green. Proof: `.omo/evidence/opencode-native-permissions-and-fixes/task-13-tasks-binding.txt`.
