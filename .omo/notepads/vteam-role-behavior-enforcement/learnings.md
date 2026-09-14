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

## Todo 19 — session→policy 映射 worker/src/role-guard/session-policy-map.ts

- 新纯/IO 模块：`writeSessionPolicy`（同目录 tmp+`rename` 原子写，先 `mkdir -p sessions/`）、
  `readSessionPolicy`（缺失/损坏/形状非法→null，pass-through）、`removeSessionPolicy`
  （best-effort 吞错，幂等）；`sanitizeSessionId`（非法字符→`_`，空/`..`→占位，128 上限），
  文件名消毒后 `path.join` 即无穿越（spec 用 `../../etc/passwd` 验证不出逃逸）。
- `import * as fsp from 'node:fs/promises'`（`{ promises } from 'node:fs/promises'` 无此导出，
  tsc TS2305）。`SessionPolicy` 类型从 `./policy` import（同进程纯模块，无 opencode 依赖）。
- `runExecution` 接线：`trackGuardSession` 在 `createSession` 已知 id 后、prompt 发送前调用；
  404 重建分支为新 id 追加映射（旧 id 由 finally 统一清）；finally `untrackGuardSessions` +
  `trackInstanceEnd`。仅 `payload.agent` 具 `vteam-` 前缀才写（默认 agent/未传→未映射
  pass-through）。写/删失败 catch+`logger.warn`，永不抛入执行链。
- `resolveGuardWorkDir`：优先 `this.workDir`（与 injector 同根）；未配置时从
  `<workDir>/tasks/<id>` 上跳两级推导；均无返回空串跳过（不阻断）。
- exec-server.spec 用 sendMessage gate（deferred promise）观测“执行中文件存在、完成后删除”；
  写失败用例以“workDir 指向已存在文件”强制 mkdir 失败，断言仍 task.completed 且无 error 事件。
- `npx tsc -p tsconfig.json --noEmit` exit 0；新 11 例 + 全量 role-guard/exec 157 例绿。
  全量 worker 另有 `injector.spec`（Todo 18 进行中改动所致）与 `v1-driver.spec`（基线预存）失败，
  均与本 Todo 无关（injector.ts 未动，本模块仅 exec-server import）。

## Todo 18 — guard 插件 vteam-role-guard + 注册 + spike

- 新增 `worker/src/resources/role-guard-plugin.ts`：纯 `renderRoleGuardPlugin(): string`，发射自包含插件
  （`tool.execute.before`，deny→`throw new Error(纠正)`；仅 `node:` 导入）。判定为 `policy.ts` 手工内联快照
  （起止标记供 spec 提取）：`toString()` 不可用——policy 辅助函数模块私有，只能拿到导出外壳；
  等价性由 20 例 parity 矩阵锁定（policy 改分支不同步快照即红）。
- workDir 三锚点：`import.meta.url` 上两级 → `ctx.directory` findUp（`tasks/<id>` 上爬，含 roles.json 优先、
  否则 opencode.json）→ 回退 directory/cwd。显式 `./.opencode/plugin/vteam-role-guard.ts` plugin 条目注册，
  不依赖 `.opencode/plugins/`（复数）原生发现目录。
- injector 成功路径：`writeGuardPluginFile()` + `ensureGuardPluginEntry()`（幂等：缺失追加、异写规范为正典、
  用户条目保留且顺序稳定）+ 陈旧异路径文件删除（不碰数组，防宽匹配误删正典条目）；manifest 置
  `guardPluginFile` 正典值。中性化路径不动（删文件+移除条目）。
- `injector.spec.ts` (a)(b) plugin 数组期望同步为 `[guard, omo]`；resources 全目录 65/65 green；
  新 `role-guard-plugin.spec.ts` 10/10（含 transpile 合法性 + 磁盘 harness deny/allow/pass-through）。
- UNVERIFIED（待 Todo 21 live）：MCP 运行时 `input.tool` 是否确为 `vteam_<action>` 裸名（若带前缀，
  映射会话 fail-closed deny 为安全方向）；hook 对 MCP/custom/git 全量触发为静态推理（prompt.ts 双调用点）。
- hook 签名：`(input:{tool,sessionID,callID}, output:{args})`；工厂 ctx 含 `directory`；opencode 1.18.30。

---

## Todo 22 — docs update (16/15/A1 + README typo)

- 16 doc: §2.1 table now mirrors shipped `ROLE_BOUNDARIES` (per-agent edit globs, bash effect, `ep_<role>`
  seed id); §4 UI-design replaced by project_manager section (UI design demoted to custom-agent path note);
  product/developer handoffs de-UI'd to match seed prompts (Todo 5 removed UI handoff).
- 16 doc §8.2 rewritten: enforcement source = `ExecutionPolicy` + opencode native permission + guard;
  `agent_tool_effects`/`permissionScope` explicitly labeled legacy non-enforcement in a table row plus §8.5,
  §9.2, per-role mapping tables, and closing paragraph. Grep-asserted zero live-enforcement claims.
- 15 doc: added `execution_policies` table + `agents.policyId` row + clone-inheritance note + config shape;
  ER diagram gained entity + relation; table count header 21→22; legacy columns annotated non-enforcement.
- A1 doc: §0 landing section records edit sole gate, universal glob, 1.18.30 + unpinned spec, all-roles
  task deny, guard branch precedence + enabled sentinel + neutralization, real `vteam_<action>` names,
  Degradation table + rollback; old §2 kept as history.
- worker README:70 `OPENCODE_SERVE_PASSWORD` → `OPENCODE_SERVER_PASSWORD` (matches `config.ts:144`).
- Commit `7a780ce` stages only the 4 doc files (worktree has parallel-todo files: .omo, md-docs/, scripts/).

---

## Todo 21 — e2e script + live probe (INCONCLUSIVE, feature not deployed)

- Script `scripts/e2e-role-boundaries.sh` (bash, set -euo pipefail, curl+python3 only, no new deps)
  covers a/c/d/e/f/g per plan: serve session create (POST /session → {id}), worker /execute 202,
  poll GET /session/$SID/message for guard literal `【越界拦截` or native deny markers, bound-session
  ask flow via POST /channels/:id/messages (@mention) → poll /questions?taskId&status=pending →
  POST /questions/:id/reply {"response":"once"} asserting 200 (503 QUESTION_WORKER_UNAVAILABLE = fail),
  deterministic task=deny contract on /agent-policies + injected opencode.json. Any poll timeout →
  INCONCLUSIVE + non-zero exit, never pass by default. `bash -n` clean.
- Live stack (compose, 2026-09-13) is reachable but PREDATES enforcement: /agent-policies → 404
  (swagger 111 paths, no *polic* route), serve /agent → 16 agents with no vteam-*, injected
  opencode.json has only {mcp, plugin} (no agent section), no .vteam-role-guard dir. Model executions
  deliberately not fired (no policy → denial strings unproovable; 202 would start real background agent
  loops on the shared stack). Evidence: `.omo/evidence/role-enforcement/e2e-role-boundaries.txt`.
- Gotchas live-verified: (1) serve needs no Basic auth in compose (OPENCODE_SERVER_PASSWORD unset);
  (2) seed-member is NOT in tm_0000000001 → /questions returns 403 PERMISSION_TEAM_NOT_MEMBER, so the
  script auto-logins seed-admin (team owner) for MEMBER_JWT; (3) compose publishes serve 4000→host 14000
  but NOT worker exec 4198 → WORKER_EXEC_URL needs an in-network host/forwarder; (4) no DELETE /tasks/:id
  exists — probe task t_0000000003 left queued (archive → 409); (5) mention target 测试-1 = a_tester instance.

## Todo 21 — e2e live run PARTIAL (2026-09-13, images rebuilt, a/d/e/f VERIFIED, c/g INCONCLUSIVE)

- Deploy: `docker compose build server worker init` + `up -d --force-recreate server worker` (init auto-seed: 5 ExecutionPolicy rows).
  server Created 2026-09-13T08:04:03Z (dc28efad, was 276f7452), worker 08:04:14Z (62d8faa4, was f53a6d28).
  /agent-policies → 200, 6 agents all task=deny; opencode.json agent×6 task=deny; roles.json enabled/6 roles; serve 22 agents incl. 6 vteam-*.
- Script bugs fixed (test tooling only): (F1) bash<4.4 empty-array+set -u abort → serve_curl(); (F2) worker_execute sys.argv[1:7]→[1:8] (prompt dropped → worker 400);
  (F3) PM agent name `vteam-project-manager`→`vteam-project_manager` (nonexistent agent ⇒ serve 204-accepts but never runs, cost=0/tokens=0, 3 silent stalls);
  (F4) (d) poll `text|part|…` matched prompt-echo envelope vacuously (PASS with model never run) → poll literal `hello-e2e` + explicit in-scope path
  tasks/$TASK_ID/src/e2e-ok.txt (direct-serve sessions keep global cwd, ignoring taskDir; developer allow is `**tasks/*/**` only).
- Results: (a) VERIFIED — product write denied verbatim 【越界拦截｜vteam-product】, model handed off via vteam_notify_agent, dispatcher ran developer
  fulfillment (in-scope write, legitimate); (d) VERIFIED — developer write completed + readback hello-e2e (bonus: developer bash-with-`>` denied);
  (e) VERIFIED — PM bash hidden by layer① (tool `invalid`: "unavailable tool 'bash'") + layer② guard correction on `invalid`, marker absent;
  (f) VERIFIED — 6/6 task=deny both sides, no `write` key; (g) INCONCLUSIVE — 180s of reads only, no gated attempt (clone a_0000000001 inherits
  policyId=ep_product server-side; same enforcement path as (a)); (c) INCONCLUSIVE — queued task never dispatched, zero questions in 180s.
- Methods lessons: (1) serve POST /session + /execute accept unknown agent names with 204/202 yet never run — always check cost/tokens>0;
  (2) model satisficing (glob finds other tasks' files from global cwd) and model no-attempts are the dominant INCONCLUSIVE sources, not enforcement;
  (3) cross-task file leakage breaks (a) isolation — clean task dirs between runs; (4) no DELETE /tasks/:id — QA tasks t_0000000004-8 left queued.
- Evidence: `.omo/evidence/role-enforcement/e2e-role-boundaries.txt` + `e2e-20260913-raw/` (24 files: serve JSONs, run logs, payloads).

---

## Todo 24 — matrix self-check (anti-drift)

- New `server/src/execution-policies/agent-policies.matrix.spec.ts` (9 tests): all expectations derived from
  `ROLE_BOUNDARIES` (single source, zero per-role literals) — service/constant divergence fails red.
- `ExecutionPolicyService` instantiated with `{}` placeholders (`new ExecutionPolicyService({} as never, {} as never)`)
  since `buildAgentPolicies()` is pure (no DB); tsc accepts `never` args, jest runs it in ~1.4s.
- Namespace rule enforced both directions: every `toolAllows` key ∈ `VTEAM_MCP_TOOL_NAMES` ∪ `VTEAM_GIT_TOOL_NAMES`;
  every `mcpDenies` ∈ MCP set and disjoint from that role's allows (= MCP complement by construction).
- `jest src/execution-policies/agent-policies.matrix.spec.ts` 9/9 green; `tsc -p tsconfig.json --noEmit` exit 0.

---

## Todo 23 — three-end regression (typecheck + lint + tests)

- All three typechecks green (server/worker/web `tsc --noEmit` exit 0, empty output); web lint
  exit 0 with 0 errors / 738 pre-existing warnings.
- server `npm run lint` uses `--fix` (mutating) — regression runs MUST use
  `npx eslint "{src,apps,libs,test}/**/*.ts"` WITHOUT `--fix`; exit 1 with 141 errors / 49 warn.
- zsh gotcha: `cmd | tail; echo $?` reports tail's status (always 0); use `pipestatus[1]`
  (zsh) / `PIPESTATUS[0]` (bash), or redirect to a file then echo `$?` with no pipe.
- Baseline proof without reinstall: `git worktree add /tmp/vteam-baseline 2fb188a` + symlink
  current `node_modules` into it, run the failing specs, then `git worktree remove --force`.
  Result: IDENTICAL failures at baseline — server 34/184 in the same 7 suites, worker 2/45
  listModels. Zero introduced failures.
- Lint baseline spot-check: `git show 2fb188a:<file> | npx eslint --stdin --stdin-filename <file>`
  proves prettier drift predates the plan (agents.service.ts 9=9; workers.service.ts 1=1).
- Evidence: `.omo/evidence/role-enforcement/regression.txt` (commands + tails + table + classification).

## 2026-09-13 clean-slate e2e (F1 REJECT fix, F-A/F-B)
- `docker compose down -v && up -d --build` → all Created 09:56:52Z, init migrate+seed OK; seed-db.txt re-captured (5 policies + 5 bindings + no-write-key + counts).
- Serve free-model behavior is sampling-dependent: same PM-bash prompt yielded guard-denial once (prior stack) vs 3× prose-decline (clean run, big-pickle). INCONCLUSIVE ≠ broken — containment (bash hidden layer-1, marker absent) verified separately.
- (c) ask flow: clean DB task is team currentTask + pending → @mention dispatches to bound session (prior queued-blocker gone). But architect prose-handles + tester has no team session → no question. To fully verify (c), tester needs a live team session first.
- Script `jget` pending-question extractor crashes on empty-list `[]` responses (`d.get` on list) — manual poll used null-safe variant; script fix deferred (script exited before (c) in clean run anyway).
- (d) script ~10s `hello-e2e` match hits prompt echo; genuine allow proof = completed write + readback + file on disk (same raw file, re-fetched full set).

## Prompt-vs-behavior alignment fix (2026-09-13, live chat c_0000000001)
- Architect/Developer/Tester bash lines no longer say bare "bash 默认 ask"; now "只读查询命令默认 ask（需成员确认）；写入/重定向、删除、push 等危险命令被直接拒绝（越界拦截）。" — matches layer① permission.bash='ask' + layer② guard ROLE_BASH_DENY_PATTERNS hard-deny (worker/src/role-guard/policy.ts bash branch: hit → deny, miss → allow to layer①).
- Tester 职责边界 keeps 不修改实现代码 + explicit "测试文件只写任务目录下 tests/ 与 docs/，实现代码路径一律不写"; bash-writes-denied note added so tester expects no ask prompt for redirects.
- PM keeps NO vteam_submit_artifact (plan intent: PM 不产出交付物); prompt 禁止 line now explicit "不产出具体交付物（无 vteam_submit_artifact 能力）" with real vteam_ prefix (bare submit_artifact would trip seed.spec no-bare-name rule `(?<!vteam_)\b<bare>\b`).
- No prompt mentions permissionScope/toolEffects as enforcement (only layer① permission.edit/bash references, which ARE the enforced source); agent.constants.ts untouched (no value change needed, ROLE_BASH_DENY_PATTERNS unchanged).
- seed.spec.ts needed NO changes: four-direction + 转交/vteam_notify_agent + banned-words + bare-name assertions all still green (22/22 with constants spec); tsc exit 0.
# learnings

## 2026-09-13 guard role-label mismatch（architect 执行被标 vteam-product）
- 根因（已证实，非推测）：`worker/src/exec/exec-server.ts` `trackGuardSession`
  对缺失/非 `vteam-` 前缀的 `payload.agent` 直接跳过写映射，且不清理已存在的
  `sessions/<ses>.json`；而 server 在 Todo-13 策略门为假时（worker capabilities
  缺失/过期、`workerSupportsAgentPolicies` 假）会省略 `/execute` 的 `agent` 键
  （`server/src/chat/worker-dispatcher.ts:1706-1730`），模型仍以 system 身份执行
  对应角色。叠加 `reuseSession=true` 默认（`teams.service.ts:118`，per-member
  单会话、`instanceRef` 跨任务保留）导致同一 ses_ id 被复用，且 `sessions/*.json`
  无任何 TTL/启动清理（grep 全仓无 prune；`untrackGuardSessions` 只删本轮写过的
  id），worker 重启/崩溃的孤儿文件永久残留 → architect 复用旧 ses_ id 时读到
  product 残留映射，guard 按 product 模板拦截并冠名。
- 次要因素：`mappedSessionIds.includes` 写一次语义 + 结束无条件删，在并发复用
  同一 ses_ id 时存在交叉覆盖/误删竞态；`resolveGuardWorkDir` 回退推导在
  workDir 未配置时可能与插件 findUp 不一致（生产 workDir 恒定，已排除为主因）。
- 修复（worker 内，`fix(worker): correct session-to-role mapping for guard`）：
  `trackGuardSession` 改为先读后写（落盘 agent 与本 payload 不一致即重写，后写者
  权威，写点仍在 prompt 发送前）；`untrack` 仅删仍属于本执行的映射（被并发他角
  色重写则不删，残留交 TTL）；新增 `pruneStaleSessionPolicies`（默认 24h，
  best-effort，删过期 json 只回 pass-through 不 fail-closed），每次 track 前调用。
- 未映射 pass-through 语义保持；guard 判定优先级未动；无新增依赖。

## 2026-09-13 agent @ storm 熔断 + my_profile effectivePermission（fix(chat))
- Storm 根因：agent-originated 触发（group_post/notify_agent → dispatchAgentMention）无服务端配额，仅 prompt 软约束；`@all` 在 agent 内容中无展开抑制。
- 修法：新增 `server/src/chat/mention-throttle.ts`（纯内存滑动窗口，时钟经 `now` 注入）：无序对 3 次/60s + 单任务 20 次/120s + `containsTeamWideMention`（@all/@所有人/@全体/@here）display-only。仅 MCP 两路径咨询（groupPost mentionedInstances 循环、notifyAgent 分派前），被拦 warn + 照常返回成功；`chat.service` 用户路径零触碰（spec 断言源码不引用 throttle）。
- 实现坑：prune 用 max 窗口淘汰时，计数必须按各自窗口过滤（pair 60s vs task 120s），否则 pair 配额被 task 窗口拉长——被单测抓出，已修（计数侧 `r.at > now - windowMs`）。
- my_profile：新增 `effectivePermission{policyId,policyName,agentName,permission,correction}`（`ExecutionPolicyService.resolveByAgent({policyId,role})`，`@Optional` 注入 + try/catch 回退 null）与 `agentName(vteam-<role>)`；legacy `permissionScope/toolEffects` 保留但加 `deprecated{permissionScope:true,toolEffects:true,note}` 指明 effectivePermission 为唯一事实来源。`PlatformMcpModule` 新增 `ExecutionPoliciesModule` import（该模块仅依赖 Realtime，无环）。
- 验证：mention-throttle 7 + platform-mcp.service 150 + controller/chat/worker-dispatcher 313 全绿；`tsc --noEmit` 干净。
---

## 2026-09-14 Lane W：Agent 页生效权限只读展示（feat(web))
- 移除：`ToolPermissionList`（effect 三态编辑 + 添加工具）、`permissionRows`/`permission-config` 块、`toolEffects` 保存字段、`ToolEffectKey/toolEffectMeta/toolSourceMeta/BUILTIN_TOOL_ACTIONS/inferToolSource`；`CreateAgentModal` 仅改副文案（去“工具权限”字样，字段本就只有 name/prompt/persona）。
- 新增 `EffectivePermissionSection`（只读）：策略元信息（policyName · agentName + correction.scopeSummary）→ 原生行（edit/read glob map 可读渲染 `glob effect` 以；分隔，bash/task 三态徽章）→ MCP 分组（permission 中 `vteam_*` 键经工具目录 name/action 双键匹配 → 按 `mcpServer` 分组；停用 server 默认收起 `aria-expanded` 可展开，启用默认展开；未命中目录进“未收录工具”组保留展示；目录工具 `enabled=false` 标“已停用”）。
- 数据：`GET /mcp-servers` 全量 + `GET /tools?source=mcp&enabled=false`（enabled=false 按冻结契约取含停用全量，不传 enabled 语义依赖 admin 默认故显式传参）；`effectivePermission===null`（含 Lane S 未落地前的 undefined）→ 中性“未绑定执行策略”，无历史回退。
- 坑：勿用 `git stash` 验证基线——并行 Lane S 同树作业，stash 会卷走对方未提交改动且 pop 冲突；只读验证用 `git stash show`/`git diff` 或直接读文件。恢复时用 `git checkout stash@{0} -- <own-file>` 定向取回，不碰他人文件。
- 验证：`npx tsc --noEmit` exit 0；`npm run lint` 0 errors（agents/page 仅剩基线既有 `deleting` 未用警告）；全仓 grep 确认零 `toolEffects/permissionScope/tool-permission-list` 残留。
---

## 2026-09-14 Lane S：移除退役 per-agent 权限机制 + effectivePermission（refactor(server))
- 移除：`AgentToolEffect` 模型 + `Agent.toolEffects` 关系 + `agents.permission_scope` 列（schema + 新迁移 `20260913000000_drop_agent_tool_effects_permission_scope` 手写 SQL：DROP TABLE + DROP COLUMN，0 行无需数据迁移）；`agents.service` 的 AGENT_INCLUDE/toolEffects 全套关联方法（createAssociations/replaceToolEffects/createToolEffects/copyAssociations→copySkills）；DTO 的 `ToolEffectDto`/`toolEffects`/`permissionScope`；seed 5 模板 `permissionScope`；my_profile 的 `permissionScope/toolEffects/deprecated`。
- 新增：`ExecutionPolicyService.resolveManyByAgents`（单次 findMany + 内存映射，语义与 resolveByAgent 一致，resolveByAgent 改调内部 `policyKeyOf`）；`AgentsService.toAgentDto/toAgentDtoList` async 返回 `policyId + effectivePermission`（未绑定 null）；`AgentsModule` import `ExecutionPoliciesModule`（仅依赖 Realtime，无环）。
- `GET /tools`：成员 enabled 缺省仍默认 true，显式传入（含 false）任何 viewer 按值过滤（与 Lane W `enabled=false` 取全量契约对齐；worker injector 恒传 `enabled=true` 不受影响）；items 本就是 Tool 全行（含 mcpServer）。
- 隐藏消费者：`swagger-mcp.auth.ts` 直读 `AgentToolEffect`（与“无运行时消费”说法矛盾，但表 0 行故实际恒 deny）→ 改为实例归属解析后默认拒绝（行为不变，message 改指引 ExecutionPolicy）；其 spec 的 allow 用例改 deny 断言，F2 集成块改 mock authorize 放行（assertWorkerTask 改直调单测保留覆盖）。
- 坑：同消息多 edit 并发写同一文件会静默丢失（报成功但 git diff 为空）——同一文件必须逐个串行 edit 并抽查 `git status`；spec 先改会导致 tsc 报 DTO 不存在（属正常中间态，按产品→规格顺序收敛）。
- 验证：`npx tsc -p tsconfig.json --noEmit` exit 0；`npx jest src/agents src/tools src/platform-mcp src/prisma --runInBand` 303 全绿；`src/swagger-mcp src/execution-policies` 59 全绿。

## 2026-09-14 Stack 重建验证（DI fix 91a1613）
- `npx tsc -p tsconfig.json --noEmit` exit 0（server）。
- `docker compose build server worker web init` + `up -d --force-recreate server worker web`：server 由 CrashLoop（Nest can't resolve AgentsService → ExecutionPolicyService at index [5] in SwaggerMcpModule）恢复 healthy；新容器日志 0 条 "can't resolve dependencies"，"Nest application successfully started"；`docker compose run --rm init` "No pending migrations" + seed 完成 exit 0。
- DB：`agent_tool_effects` 表无（SHOW TABLES 空）、`agents.permission_scope` 列无（SHOW COLUMNS 仅 policy_id 等）、5 模板俱在。
- API：`GET /agents?type=template` 5 条各有 policyId + effectivePermission（permission.edit/read/bash/task 齐全，task 全 deny），无 permissionScope/toolEffects。
- **跨 Lane 契约断裂（未改代码，仅报告）**：Lane W（web agents/page.tsx:1804）以 `GET /tools?source=mcp&enabled=false` 取“含停用全量”；Lane S（tools.controller）实现为显式 enabled 按值过滤 → 当前 200 工具全 enabled=true，故该查询恒返回 `{"items":[],"total":0}`。Playwright 实测（admin 登录 → /agents → 模板 agent）：effective-permission-section 渲染正常（policyMeta + 4 原生行，0 console errors），但 MCP 分组退化为单组 `__unknown`“未收录工具”6 条，`vteam-api` 停用默认收起不可观察。server 日志证实浏览器确发 `.../tools?source=mcp&enabled=false&page=1&pageSize=200`。另：server pageSize 上限 100，mcp 工具 194 条，单页取不全。修复方向（二选一，需产品决策）：web 端分两次取（enabled=true/false 合并）或 server 加 `includeDisabled` 语义；勿动 DI fix 之外的代码。
---

## 2026-09-14 fix(tools)：includeDisabled 目录查询 + Agent 页 MCP 全量分页
- 断裂根因：Agent 页以 `GET /tools?source=mcp&enabled=false` 取“全量 MCP 目录”，但 server 显式 enabled 为严格过滤 → 返回 `[]`（停用 0 行），页面退化为 `__unknown` 单组；另目录 194 行超单页 100 上限。
- Server：`QueryToolsDto` 新增 `includeDisabled?: boolean`（"true"/"false" 字符串 Transform + IsIn，与 enabled 同模式）；`findAll` 中 `includeDisabled===true` 时 where.enabled 置 undefined 且跳过成员默认 `enabled=true`；优先级 includeDisabled > enabled（文档写进 class/method JSDoc + DTO 描述 + controller 注释保留原语义说明）。显式 `enabled=true|false` 语义不变，worker injector（恒传 enabled=true）不受影响。
- Web：`mcp-tools` 改 `source=mcp&includeDisabled=true`，`mcp-servers` 与 `mcp-tools` 均 pageSize 100 循环拉全（items.length >= total 或空页停，上限 20 页防死循环）；分组 + 停用默认收起逻辑零改动。
- 验证：tools.service.spec 28 全绿（含 3 新增：includeDisabled 返回混合行、优先于 enabled、成员默认被绕过）；web `tsc --noEmit` exit 0；web lint 0 errors；server 改动文件 eslint 干净（spec 2 处 prettier 已 --fix）。

## 2026-09-14 agent-permission-page e2e (9c70dac redeploy)
- `enabled` on GET /tools filters the tool-ROW flag, not server state; all 194 rows (22 vteam + 172 vteam-api) are enabled=true in seed, so `enabled=true` returns both. Server-level gating lives in GET /mcp-servers?enabled=true (vteam only) which is what worker injectMcp() uses. No code regression.
- EffectivePermissionSection groups ONLY effective-policy `vteam_*` entries; no policy key resolves to vteam-api (catalog names are `*controller_*`), so the vteam-api group can never render with current code+seed. Needs owning-task decision: render all catalog servers as groups vs add vteam-api tools to policies. Evidence: .omo/evidence/role-enforcement/agent-page-permissions.txt/.png
