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
