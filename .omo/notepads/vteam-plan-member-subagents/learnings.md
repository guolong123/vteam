# Learnings — vteam-plan member subagents (Todo 2 seed)

## 2026-09-14 — seed 转正（Todo 2）

- Baseline HEAD：`5ad2e2f43b5390bbdc32081f2d7c0f8c69b83e97`。 sibling Todo 1（constants+guard）在并行修改，seed 侧一律运行时派生、不硬编码边界形状。
- 当前 HEAD 的 `ROLE_BOUNDARIES['vteam-plan']` 仍是旧形状（无 group_post、无 plans glob、无 task 字段）；D1 落地后 seed 的 `buildEditPermission(writeGlobs)` / `planToolLine` / `taskEffect` 分支自动跟进，无需二次修改。
- 关键手法：
  - 计划员 prompt「可用工具」行由 `Object.keys(ROLE_BOUNDARIES['vteam-plan'].toolAllows)` 运行时拼接，spec 漂移测试同源解析，双侧恒一致。
  - 层① task 门读取顺序：边界运行时 `taskEffect` 字段（若 Todo 1 落地）优先，否则按 agent 名分支（仅 vteam-plan allow）。
  - `agentKey='plan'` 经 `AGENT_KEY_PATTERN` 正则直接验证（`^[a-z][a-z0-9_-]{0,62}$`），不假设。
- 坑：
  - 旧 spec 的 `not.toContain('主 Agent')` 是全模板断言，计划员必须豁免（只接受主 Agent 派活是其协同核心）。
  - `skill(plan-review-*)` 字面只许出现在归属角色 prompt；计划员协同用 `plan-review-<role>` 泛名 + 按需加载表述，交叉污染测试保持全 6 模板覆盖。
  - 裸 MCP 名正则 `(?<!vteam_)\b<bare>\b` 会扫 prompt 全文：`task`（opencode 工具）安全，但 `task_context`/`doclib` 等必须带 `vteam_` 前缀；`plan-review-x`（连字符）不触发 `plan_review`（下划线）规则。
  - `tl_vteam_plan_review` 仅删 seed 注册行；服务端 handler 删除归 Todo 3。
- QA：`npx tsc --noEmit` exit 0；`npx jest src/prisma/seed.spec.ts` 24/24 绿。

## 2026-09-14 — plan_review 整套删除 + 编排指令改写（Todo 3 flow）

- Baseline HEAD：`5ad2e2f43b5390bbdc32081f2d7c0f8c69b83e97`（与 Todo 2 同基线； sibling Todo 1/2 在并行修改 constants/guard/seed，本删除只读它们、零依赖）。
- 删前 grep 定孤儿结论（删后复核全中）：
  - `describeReviewError` 仅 review 块内 3 处用 → 同删；`WorkersService` 在 service 内仅注入 + `runSingleReview` 一处 `assignWorker` → 注入 + import 同删（`Inject`/`Optional` 保留，他处仍用）。
  - service 内 `import * as path` 与 `taskDirOf` 仅 review 块用 → 同删（`WorkerClient`/`decodeContent` 他处仍用，保留）。
  - `silent` 旗仅 `runReviewWithTimeout` 传 → 删旗并恢复 `runSendAndAwait(payload, sessionID, ctx)` 原签名（另两处调用本就无参）。
  - `pruneStaleSessionPolicies/readSessionPolicy/writeSessionPolicy`、`trackInstanceStart/End`、`CompletionResult/CompletionTimeoutError`、`fsp`、`drainRequest` 均被 `/execute` 路径复用 → 保留。
- 删单：tools 注册 + schema/type；service `planReview` + 6 私有 + 2 超时常量 + 3 verdict 类型；spec 文件整体删除；`WorkerClient.review` + `ReviewOptions` + 2 超时常量 + client spec 块；exec `/review` 分支 + `handleReview` + `trackReviewGuardSession` + `runReviewWithTimeout` + `ReviewRequestPayload` + `ReviewTimeoutError` + `REVIEW_DEFAULT_TIMEOUT_MS` + spec 块（文件尾截断）；`e2e-plan-skills.sh` 整体删除；`e2e-permission-matrix.sh` 仅 3 处 6→5（断言/提示/header 注释；"6 roles/built-ins" 指 agent 数，不动）。
- `PLAN_PRODUCE_INSTRUCTION` 改写为 D5 五步编排（@计划员派起草含任务简报 → 收群聊摘要 → question 选评审视角 → @计划员带视角清单派评审 → VERDICT 聚合 → REJECT 带 feedback 重派 / APPROVE 宣布 → task_transition 出计划模式）；`PLAN_REVIEW_INSTRUCTION` 与 dispatch 逻辑零触碰。
- 坑：`head > tmp && mv` 跨卷 mv 报 owner/group 错但内容已替换（以 `wc`+`tail` 为准）；zsh 下 `echo ===...` 会触发 `== not found` 解析错，改用 bare 命令。
- grep 零证明（非 spec）：仅剩 `agent.constants.ts:140`（Todo 1 领地）+ 2 处 RBAC 通用注释 `view/create/edit/delete/review/manage`（无关旧词）+ 1 处 tasks.module 注释；spec 侧仅剩"断言缺席"类引用（dispatcher 自有 + sibling 领地的 seed/guard spec）。
- QA：server/worker `tsc --noEmit` 均 exit 0；jest：controller+service+client 226/226，dispatcher 188/188，exec-server 101/101。
# Learnings — Todo 1 [policy+guard] plan role member capabilities and scoped task spawn

Baseline HEAD at start: `5ad2e2f docs(plan): mark plan-skills-rewrite F1-F4 complete`.

## What changed (owned files only)

- `server/src/common/constants/agent.constants.ts`
  - `ROLE_SERVER_GATED_TOOLS`: removed `vteam_plan_review` → back to 5.
  - New exported helper `planDirGlob()` → `'**.opencode/plans/**'` (root-independent style like
    `taskSubdirGlob`: `**` crosses separators, so bare and worktree-prefixed paths both hit).
  - `ROLE_BOUNDARIES['vteam-plan']`: `writeGlobs: [planDirGlob()]`, `toolAllows += vteam_group_post`.
    `readGlobs: ['*']`, `bashEffect: 'deny'` unchanged. No other role touched (verified by diff).
- `server/src/execution-policies/execution-policy.service.ts`
  - `AgentPolicyDefinition.mode`: widened to `'primary' | 'all'`.
  - `buildAgentPolicies` builtin site: `mode` is `'all'` only for `vteam-plan`, `'primary'` otherwise;
    custom-agent site stays `'primary'`.
  - `buildRolePermission`: `task` is `'allow'` only for `vteam-plan`, `'deny'` otherwise.
    Comment records why: opencode native `ctx.ask({permission:'task'})` runs before guard, both gates must open.
  - `guardForAgent` unchanged (reads `toolAllows`; new entries flow automatically).
- `worker/src/role-guard/policy.ts` (+ inline snapshot in `worker/src/resources/role-guard-plugin.ts`, parity kept)
  - `SERVER_GATED_TOOLS`: removed `vteam_plan_review` → exactly 5
    (`vteam_task_transition, vteam_question_confirm, vteam_task_create, vteam_plan_mode, vteam_team_add_member`).
  - Precise `task` gate inserted before the `TASK_TOOLS` deny branch: allow iff mapped agent is
    exactly `'vteam-plan'` AND `args.subagent_type === 'vteam-plan'`; otherwise fall through to deny
    (`execute` always denies, malformed args deny). Header comment updated (branch 4 + the
    role-name-hardcode constraint now records this single exception).
- Specs: constants spec (plans glob match/mismatch, group_post addition, gated back to 5);
  matrix + custom-agents specs (vteam-plan layer-① task allow + group_post + plans glob + mode all;
  builtin fixture + snapshot regenerated); controller spec branched for vteam-plan mode/task
  (needed for green; sibling spec of the same service); policy.spec (gate truth table) + parity spec
  (plan allow/other-role deny/wrong-name deny/missing-args deny/execute deny; plan_review now deny; 29 cases).

## Glob match/mismatch proof (`planDirGlob() = '**.opencode/plans/**'`, spec-locked)

- MATCH: `.opencode/plans/x.md`, `data/vteam-worker/.opencode/plans/x.md`, `tasks/t_1/.opencode/plans/x.md`
- NO MATCH: `src/a.ts`, `tasks/t_1/code/x.ts`

## Guard gate truth table (policy.spec + parity spec, all green)

| mapped agent | tool | args | decision |
|---|---|---|---|
| vteam-plan | task | `{subagent_type:'vteam-plan'}` | allow |
| vteam-developer | task | `{subagent_type:'vteam-plan'}` | deny |
| vteam-plan | task | `{subagent_type:'vteam-developer'}` | deny |
| vteam-plan | task | `{}`, `null`, `{description}` | deny |
| vteam-plan | execute | `{subagent_type:'vteam-plan'}` | deny |
| any | task/execute | rolesDoc null / session unmapped | allow (pass-through, unchanged) |

## Verification

- `cd server && npx tsc -p tsconfig.json --noEmit` → exit 0.
- `cd worker && npx tsc --noEmit` → exit 0.
- server: `execution-policies` + `common/constants` + `prisma/seed.spec.ts` → 8 suites / 88 tests green
  (incl. regenerated custom-agents snapshot; seed.spec passes with gated-back-to-5).
- worker: `role-guard/policy.spec.ts` + `resources/role-guard-plugin.spec.ts` → 70 tests green.
- worker FULL suite: 593/595 pass; 2 failures in `driver/v1-driver.spec.ts` listModels `/provider`
  tests (extra `anthropic/claude-3-5-sonnet` entries in received) — pre-existing, unrelated to this
  todo (driver files untouched; failure is provider-model mock drift, not role-guard).

## Gotchas for later todos

- `agent.constants.spec.ts` `writeGlobs` shape test now accepts `**tasks/**` OR `planDirGlob()` — Todo 2/4
  adding more globs must extend that allowlist, not revert it.
- `agent-policies.controller.spec.ts` branches mode/task expectations on `vteam-plan` — e2e (Todo 4)
  asserting uniform `primary`/`deny` must branch the same way.
- The inline snapshot in `role-guard-plugin.ts` must stay byte-parity with `policy.ts`; the parity spec
  (now 29 cases) fails on any drift — edit both together.

## 2026-09-14 — namespace 常量补删 dead `vteam_plan_review`（Todo 3 遗留收尾）

- Baseline HEAD：`0806770 feat(policies): plan role member capabilities and scoped task spawn`；改前基线
  `npx jest src/common/constants src/execution-policies src/prisma/seed.spec.ts` → 8 suites / 88 tests 全绿。
- 改单（3 文件）：`agent.constants.ts` 删 `'vteam_plan_review',` 单行（L140）→ 23 工具；
  `agent.constants.spec.ts` `toHaveLength(24)` → 23；`agent-policies.custom-agents.spec.ts.snap`
  经 `jest -u`（仅此文件）更新。snapshot diff 死键唯一性证明：`git diff -- snap | grep ^[+-]` 去重后仅
  12 行 `- "vteam_plan_review": "deny",`（6+6 两种缩进），零新增行。
- 三向覆盖测试（mcpDenies ∪ toolAllows ∪ serverGated == VTEAM_MCP_TOOL_NAMES）零改动直接过：
  plan_review 本就不在三集合任一中，删除只缩小全集。
- grep 复核：`toHaveLength(24)` 零残留；`vteam_plan_review` 仅剩 4 处，皆为缺席断言
  （seed.spec.ts L457/459 + worker-dispatcher.spec.ts L1340 关键字环/L1370），按要求保留不动。
- QA：`npx tsc -p tsconfig.json --noEmit` exit 0；目标三套件 8 suites / 88 tests / 1 snapshot 全绿。
- 注意：仓库有基线前即脏文件（`.omo/boulder.json`、`platform-mcp.controller.spec.ts` 等），commit 仅
  `git add` 本改单 3 文件 + 本 learnings，不碰他处。

## e2e-plan-member run1 (2026-09-14) — REJECT: worker injector rejects mode:'all' (no product fix per task)

- Harness: `scripts/e2e-plan-member.sh` (new, mirrors e2e-permission-matrix conventions). Run1 aborted at step-0c sentinel (worker never re-injected); evidence under `.omo/evidence/plan-member/`.
- Step 0 (build+seed): PASS. Images were stale (built 05:37/05:45 UTC, plan commits 06:33-06:44 UTC); rebuilt, server healthy, dist contains a_plan, `node dist/prisma/seed.js` exit 0.
- Step 1 (seed truth): PASS (script asserts not yet executed, verified manually with same predicates): a_plan=template/plan/plan/ep_plan, ep_plan=template, tmm_0000000006=a_plan alias 计划员-1, main=tmm_0000000002 (not plan), 6 members; /agents lists a_plan template; /teams has 计划员.
- Server /agent-policies: CORRECT — vteam-plan mode=all, task=allow, edit={`*:deny`,`**.opencode/plans/**:allow`}, guard tools vteam_group_post=allow (layer-1 carries no group_post key: allowlist-complement design, same as the 5 gated tools).
- REJECT root cause: worker `buildAgentDefinitions`/`assertAgentShape` (`worker/src/resources/opencode-config-builder.ts:58-116`) hard-enforces `mode==='primary'` and hardcodes `mode:'primary'` in output. Live payload mode='all' throws `agent vteam-plan mode 非法：仅支持 'primary'` → injector `writeNeutralized` → roles.json `{enabled:false,roles:{}}` + opencode.json agent section stripped + guard plugin/sessions removed. Reproduced with worker's own dist code (see `reject-builder-throw.txt`); server access log proves the worker's pull was HTTP 200 with full body (`reject-server-200-pull.txt` req id=19); neutralized on-disk state in `reject-roles-neutralized.json`/`reject-neutralized-state.txt`.
- D1 said "AgentPolicyDefinition.mode 类型同步放宽" but only the server side was widened; the worker's local double-write (`AgentSectionEntry.mode: 'primary'`) was missed, and its docstring ("全程无角色名 if 分支…同一条校验与构造路径") now contradicts D1's per-name mode branch. Fix (NOT applied): widen worker type + assert to accept 'all' (scoped to vteam-plan or generally) and emit `agent.mode` instead of hardcoded 'primary'.
- Script correction made during run1: vteam_group_post must be ABSENT from layer-1 permission (not `allow`); allow is asserted in live roles.json guard tools. Fixed in script for post-fix re-run.
- Leftovers: none (killed before any live dispatch: no plan files, no group posts, no serve sessions; DB reseed = intended seed truth; images rebuilt).

## 2026-09-14 — worker builder 接受 mode:'all'（Todo 1 follow-up fix）

- 根因：worker `opencode-config-builder.ts` 本地双写 `AgentPolicyDefinition.mode: 'primary'` + `assertAgentShape` 硬拒非 primary + 输出硬编码 `mode:'primary'`；server 下发 vteam-plan `mode:'all'` 即抛错 → injector 中性化。server 侧早已放宽（仅 vteam-plan 发 all），worker 侧遗漏。
- 改单（2 文件，worker/ 域内）：`opencode-config-builder.ts` — `AgentPolicyDefinition.mode` 与 `AgentSectionEntry.mode` 放宽为 `'primary' | 'all'`；`assertAgentShape` 接受两者、拒其他（报错文案更新为 `仅支持 'primary' | 'all'`）；`buildAgentDefinitions` 输出 `mode: agent.mode` 原样透出；doc 注释 `{ name, description, mode:'primary'|'all', permission }` 同步。spec 新增 `mode:'all'` 原样透出 + `mode:'bogus'` 抛错两用例；既有 primary 行为断言不动。
- grep 复核（`worker/src/resources/`）：`primary` 残留仅放宽后的校验/类型/文案 + 既有 primary 用例 + injector/role-guard spec 的用户配置透传 fixture（与 builder 校验无关）；`mode` 残留确认 injector.ts 无 mode 硬编码。
- QA：`cd worker && npx tsc --noEmit` exit 0；`npx jest src/resources/opencode-config-builder.spec.ts` 8/8 绿。

## e2e-plan-member.sh run (2026-09-14T08:19:55Z) HEAD=5d416a2ca09dd68f255006b7f1fbe692d9435a94
- seed: a_plan(ep_plan)/tmm_0000000006 non-main/6 members; /agents template; /teams 计划员.
- injection: vteam-plan mode=all task=allow plans-scoped edit group_post guard-only; other five split-aware parity vs F3-own baseline (baseline predates allowlist-split); plan diff limited to mode/task/plans-glob + deny removals.
- guard: 12/12 (task gate allow-only plan+plan; execute deny; unmapped pass-through; plans-write allow / src-write deny).
- live step4 (group @): yes; live step5 path: live.
- plan_review: tools/list clean; POST /review HTTP 404; /agent-policies clean; repo non-spec grep zero hits.
- cleanup: plan file removed, task dir identical, serve sessions aborted. needs-attention: 

## e2e-plan-member.sh run (2026-09-14T08:26:38Z) HEAD=5d416a2ca09dd68f255006b7f1fbe692d9435a94
- seed: a_plan(ep_plan)/tmm_0000000006 non-main/6 members; /agents template; /teams 计划员.
- injection: vteam-plan mode=all task=allow plans-scoped edit group_post guard-only; other five split-aware parity vs F3-own baseline (baseline predates allowlist-split); plan diff limited to mode/task/plans-glob + deny removals.
- guard: 12/12 (task gate allow-only plan+plan; execute deny; unmapped pass-through; plans-write allow / src-write deny).
- live step4 (group @): yes; live step5 path: live.
- plan_review: tools/list clean; POST /review HTTP 404; /agent-policies clean; repo non-spec grep zero hits.
- cleanup: plan file removed, task dir identical, serve sessions aborted. needs-attention: 

## e2e-plan-member.sh stabilisation notes (runs 2-9, same HEAD 5d416a2, script-only changes, no product diff)

- Direct worker /execute is NOT a valid step-4 trigger (proven, kept as evidence `serve-msg-4.json`): it bypasses server `registerExecution`, so the member's correct `vteam_group_post` call 403s by design (`PLATFORM_MCP_FORBIDDEN ... 禁止冒充`). Step 4 now uses the production group-@ path (mention → resolveMentions + task-mode session backfill → dispatch registers `tmm_0000000006` → execute); `group_post` then succeeds and the reply lands in group (run-5..9: `m_0000000252/0256/...` from `tmm_0000000006` with `E2E-PLAN-POSTED`).
- F3-own `injected-opencode.json` baseline predates allowlist-split `22e95ee`: five-role check is now split-aware parity (retained keys byte-identical, zero new keys; baseline-only deny keys allowed iff guard-moved into that role's live guard tools or server-gated out of both layers). Any new/changed key still fails.
- macOS bash 3.2 traps fixed in-script: (1) `$VAR` directly followed by CJK punctuation inside heredocs mis-scans the name (`PLAN_MEMBER_ID）` → unbound) — braced; (2) `${4:-{}}` parses as `${4:-{}` + literal `}` → `mcp_post` params default rewritten without braces; (3) worker-exec cwd is `/app`, so all worker `find/rm/test` paths absolutised to `/data/vteam-worker/...`, stale-file pre-clean moved BEFORE the taskdir snapshot and verified.
- Step-5 marker matching reads assistant-role text + tool outputs only (`assistant_text()`): serve transcripts echo the prompt double-escaped, which defeats echo-scrubbing and false-positives marker greps. Live proof (run-7 session `ses_f610f3d08ffeOhgShEhDHF1fys`, supplemental `serve-msg-5-run7-supplemental.json`; rerun green in-suite): parent `task[subagent_type=vteam-plan]` → completed, child `PROBE-OK # E2E 角色边界验证计划`, nested attempt → `Subagent depth limit reached (1)`.
- Step-4 `E2E-PLAN-DONE` check is WARN-level by design (member's group_post summary + file are the contract; final回流 text varies). Runs 8-9 full PASS twice consecutively, `needs-attention.txt` empty.
