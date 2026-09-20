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
