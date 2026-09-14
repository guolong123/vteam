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
