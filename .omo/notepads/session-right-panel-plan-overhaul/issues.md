# Issues — session-right-panel-plan-overhaul

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## I1 · 计划 F3-2 步骤设计有副作用缺陷（自省）
计划的 F3-2 要求用 `reject → mark-pending-review` 触发归档，但 `reject` 会 `promoteNextInTx` 出队队首 → 破坏测试数据。
**修正**：真实链路验证应改用「队列为空的独立团队」或新建 scratch 团队/任务。

## I2 · 我的规划前提缺失：未校验"被测服务 == 当前代码"
F3 的验收假设 `:13000` 跑的就是本次代码，实际是 10:02 的旧镜像 → F3-2 初次 BLOCKED。规划阶段应把"部署/镜像新鲜度"列为前置检查。

## I3 · 预存脏文件（非本次，未提交）
`.omo/boulder.json`、`.opencode/opencode.json`、`.omo/evidence/phase5-t9-playwright.json`、`.omo/evidence/plan-review-execution-gates/task-9/probe.json`、`.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json`、`vteam-worker-sdk-0.1.0.tar.gz` —— 全程保持未暂存未提交。

## I4 · `docs-unified.spec.ts:377` 预存失败（数据漂移）
断言原型面板含任务名「cliyard MCP 新增」，但线上任务 `t_0000000001` 已被改名为「流程走通测试…」→ 与本次改动无关。
