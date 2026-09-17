# plan-lifecycle-tool learnings

## 2026-09-17：新增 MCP 工具 vteam_plan_complete（executing→completed 闭环）

- 缺口：33 篇 §6.1 规定 PM 标记完工，但 MCP 工具表无计划状态类工具，计划卡 executing。
  `PlanLifecycleService.completePlan`（仅主实例 + 仅 executing 校验）与 HTTP 端点已存在，本任务只做 agent 可达路径暴露，未改其语义。
- 接线：`planCompleteSchema` + `buildPlatformMcpTools` 的 `plan_complete` 条目（tools.ts）
  → `PlatformMcpService.planComplete`（assertWorkerTask + findTaskTeamGate 主实例门 + completePlan，
  缺装配 503 `PLAN_COMPLETE_UNAVAILABLE`）→ seed 工具注册表 + PM 经 server-gated 调用。
- 关键决策（偏离任务书 (d)4）：未把 `vteam_plan_complete` 写入任何角色 `toolAllows`
  （含 PM）。原因：server-gated 工具按既定契约既不进 toolAllows 也不进 mcpDenies，
  guard 层② pass-through、运行时按主实例判定；`plan_mode` 即此模式。
  若写入 toolAllows 会同时打破 `agent.constants.spec`（gated ∉ toolAllows 全角色断言）
  与 `seed.spec`（seed config.tools == src toolAllows 逐项相等）两个绿测试。
  PM"被允许调用"由 pass-through + 主实例门保证，已在 seed.spec 加断言锁定。
- 测试：service.spec 新增 `plan_complete` 三条（主实例成功 + instanceId 透传断言 / 非主 403 且
  completePlan 未调用 / planLifecycle 缺失 503）；controller.spec tools/list 28→29 + schema +
  tools/call 转发；agent.constants.spec gated 6→7、工具名 28→29。

## 2026-09-17（补漏）：PM 提示词加计划完工铁律

- 闭环缺口：工具有了但 PM 不知道何时调。seed.ts PM prompt `## 职责` 段 `- 环节推进` 后
  新增 bullet：交付齐备/待验收且计划仍 executing → 须调 `vteam_plan_complete`
  （executing→completed）；点明 DB plans.status 为真值源、改文件无效、不要 @计划员-1 改文件。
- 冲突与解法：seed.spec「可用工具去重」测试断言旧五角色 prompt 不含任何 gated 工具名，
  新 bullet 点名 `vteam_plan_complete` 会打红它。解法是给该测试加定向豁免：
  仅 `a_project_manager` 允许含 `vteam_plan_complete`（职责明令调用，运行时仍由主实例门鉴权，
  prompt 点名≠越权），其余 gated 工具禁令不变。裸名检查（BARE_MCP_NAMES）不受影响。
- 未动 platform-mcp.* / agent.constants.ts；未给 vteam-plan 加任何完工提示或工具。
- 验证：tsc --noEmit exit 0；jest src/prisma/seed.spec.ts 44/44 绿。

## [2026-09-17] 主会话实机 QA 验证（Atlas）
上线后经 MCP 端点（`POST /api/v1/platform-mcp`，`X-Worker-Token` + `x-worker-id`）实调验证四路径：
- tools/list → 29 工具，`plan_complete` 在列，入参 `{taskId, selfInstanceId}`。
- 负路径（非主实例 计划员-1 tmm_0000000011）→ JSON-RPC error `-32003 [403] PLATFORM_MCP_FORBIDDEN 仅主 Agent（tmm_0000000008）可标记计划完工`。
- 正路径（主实例 项目经理-1 tmm_0000000008）→ `{"status":"completed","idempotent":false}`；DB `pl_0000000002` 由 executing → **completed**（S9 计划卡死解除）。
- 幂等（重复调用）→ `idempotent:true`；错态门（对 draft 计划）→ `-32009 [409] PLAN_COMPLETE_WRONG_STATE`。
- 群聊落系统消息：「计划执行完成（executing → completed），由 tmm_0000000008 标记。」
教训：MCP tools/call 的 403/409 以 **JSON-RPC `error`** 返回（非 `result.content`），解析时勿只看 result。
