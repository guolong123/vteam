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

---

## Todo 15 + 16 — injector single-writer + builder pure fn

- `injectAll` 串行结构：skills/tools 并行（沿用旧行为）→ `fetchAgentPoliciesSafe`（永不抛错，
  null=中性化）→ `injectMcpAndAgents` 单次 opencode.json read-modify-write（mcp+plugin+agent）。
  旧 `injectMcp()` 保留原行为供注册后 MCP 重注入复用（保留 agent 节、不碰 guard、不中性化）。
- `cleanupByManifest` 用 TS overloads 实现显式分支；impl 签名末尾对 `mcpServers` 加了防御性
  throw（新键误入即炸，绝不进 tools 删除分支）。
- Todo 15 不写 guard 插件体：成功路径 `guardPluginFile` 沿用 manifest 已记录值（Todo 18 写入），
  仅中性化/停用路径删文件+清 `plugin` 条目；另 `removeGuardPluginEntry` 兜底清无 manifest 记录的残留条目。
- Todo 16 `buildAgentDefinitions(agents, guard)`：`permission.write` 键显式拒绝（层①唯一写闸门是
  edit）；guard.enabled 才做 roles 交叉校验（中性化路径不被校验阻断）；未知字段抛错。
- 同名注意：`credentials/model-credential-injector.ts` 有个同名异构 `buildOpencodeConfig`
 （auth.json 内容构造），与死掉的 ExecutionConfig-builder 无关，未动。
- 基线已有 2 个 `v1-driver.spec.ts` 失败（stash 验证过，与本改动无关）。
# learnings (append-only)

## 2026-09-13 — Todo 14 worker agentPolicies capability + gate helper
- `WorkerCapabilities.agentPolicies` 为加法可选字段；`buildCapabilities` 恒带该键（默认空报告 → enabled:false/names:[]），旧 worker 缺字段 → server 门返回 false。
- server 全局 `ValidationPipe({whitelist:true})` 会剔除未声明字段，故 `WorkerCapabilitiesDto` 必须显式声明 `agentPolicies` 嵌套 DTO，否则注册时能力位被 strip、门永假。
- `workerSupportsAgentPolicies` 判定式 `enabled===true && Array.isArray(names) && names.includes(agentName)`；`enabled:1`/names 非数组等残缺形状一律 false（stale-true 防护）。
- 基线 `workers.service.spec.ts` 已有 5 处 git-credential dispatch 失败（与 Todo 14 无关，未动）；本次新增 7 用例全绿，无回归。

## Todo 17 (2026-09-13): config discovery / --pure / glob base
- opencode 1.18.30 (`~/.opencode/bin/opencode --version`); `worker/Dockerfile:30` OPENCODE_CLI_SPEC unpinned.
- `isPureMode()` pure sources confirmed; guard-not-loaded warning was MISSING -> added blocking-level warn in `spawnServe()` + spec; 28/28 green, tsc exit 0.
- Universal glob `**tasks/*/<subdir>/**` hits both worktree bases via node Wildcard.match replica; absolute globs never match relative inputs -> forbidden.
- Live serve e2e left UNVERIFIED (no serve spawned); deferred to Todo 21.

## Todo 13 (2026-09-13): dispatch capability+name gated policy agent selection
- `vteam-plan` 加入 `PLAN_DUTY_AGENTS`；`baseAgentName` 按 ` - ` 切分，`vteam-plan`（连字符无空格）不受影响，直接命中。
- dispatch 单一下发点（`dispatchForTeamTarget` 唯一 `workerClient.execute`）：`effectivePlanForPolicy` 为只读镜像（与 `systemOpts.taskPlanMode` 同源赋值，不改计划指令逻辑）；候选 `effectivePlan ? 'vteam-plan' : roleToAgentName(agentIdentity.role)`（角色未知→null 无候选）；门真则覆盖（含显式成员选择），门假则 `resolvedAgentName = opencodeAgentName` 回退现状。
- `WorkerEndpointRef.capabilities?: unknown` 与 `workerSupportsAgentPolicies({capabilities?: unknown})` 签名直接兼容，无需适配。
- 回退断言用 `toEqual` 对整 payload 做逐字节比较（enabled:false vs 无能力位字段；未知角色门真 vs 无能力位），比只断言 `agent` 键更强。
- `server` tsc exit 0；`worker-dispatcher.spec` + `opencode-agent-duty.spec` 193/193 green。

## Todo 20 — guard 纯判定模块 worker/src/role-guard/policy.ts

- `evaluateToolCall({rolesDoc, session, tool, args})` 纯函数实现固定分支优先级：rolesDoc 缺失/非法/`enabled!==true`
  → allow；session 未映射/未知 agent → allow（两者绝不 fail-closed）；角色条目残缺（permission/tools 缺失或非对象）
  → fail-closed deny；read 类 9 名（read/grep/glob/lsp/webfetch/websearch/list/todowrite/todoread）allow 交层①；
  edit 类 5 名按 `permission.edit` glob（`*:"deny"`+无 allow 命中即 deny，显式 deny 优先，不可解析路径时 allow 交层①）；
  bash 仅按 bashDeny（与服务端 `ROLE_BASH_DENY_PATTERNS` 语义对齐：大小写不敏感子串，含 `*`/`?` 按 glob）；
  task/execute 恒 deny；question/plan_exit/skill 通行；browser 按 tools allowlist；其余未知/自定义/MCP
  （`vteam_<action>`、`git_*`）按 tools（allow/ask 放行）默认拒绝。
- 本地 `wildcardMatch` 复刻 `Wildcard.match`（转义正则特殊字符，`*`→`.*` 跨分隔符，`?`→`.`，`^...$` 锚定），
  worker 零 opencode 依赖；纠正文案替换 `{role}`/`<tool>`/`{tool}`/`<scopeSummary>`/`{scopeSummary}`/`{handoffTarget}`
  （handoff 优先同名工具键，否则首个非空值）。
- spec 49 例全绿；`npx tsc -p tsconfig.json --noEmit` exit 0。全量 worker 套件中
  `src/driver/v1-driver.spec.ts` 2 例失败为基线预存（stash 后复现），与本模块无关。
