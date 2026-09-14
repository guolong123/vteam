# Learnings — vteam-default-permission-matrix-fix · Todo 1 (server)

## 2026-09-14 · server-gated 从 guard allowlist 拆分（Todo 1 DoneClaim 要点）

- 新增单一来源 `ROLE_SERVER_GATED_TOOLS`（5 真实名：task_transition / question_confirm /
  task_create / plan_mode / team_add_member）于 `agent.constants.ts`，紧邻
  `VTEAM_MCP_TOOL_NAMES`；`execution-policy.service.ts` 仅 import，不重复字面量。
- `VTEAM_MCP_TOOL_NAMES` 补 `vteam_task_create`（22→23），追加末尾，与
  `platform-mcp.tools.ts` 注册顺序一致；`toolAllows` 的 MCP 键归属断言自动通过。
- `defineBoundary` 经预计算 `SERVER_GATED_SET` 排除门控工具：
  `mcpDenies = VTEAM_MCP_TOOL_NAMES - toolAllows - serverGated`（D3）。
- D4 补齐后 product 的 `toolAllows` 覆盖全部 18 个非门控 MCP → 其 `mcpDenies` 为空数组。
  教训：`seed.spec.ts` 旧断言 `otherKeys.length > 0`（默认每角色必有 deny）被证伪，
  已改为与 `ROLE_BOUNDARIES[agentName].mcpDenies` 逐项一致的精确断言；"无 deny 键"
  本身就是 D1 的正确形态，不要把"至少一个 deny"当不变量。
- `seed.spec.ts` 旧断言"task_transition 必须显式 deny"（把 bug 锁成契约，与
  `agent.constants.spec.ts:186-193` 同类问题）已改为：5 门控工具在层① permission
  无键。`seed.ts` 本体零改（permission 由 `boundary.mcpDenies` 派生，自动跟随）。
- `seed.ts` 的 `vteamTools` 注册表（22 项，缺 `task_create`）未动：属 seed 运行时数据，
  留给 Todo 3（seed 对齐）处理；`VTEAM_MCP_TOOL_NAMES`（23）是 guard/层① 的口径，
  两者暂不一致是已知遗留，不在本 todo 验收内。
- `ResolvedExecutionPolicy.serverGated` 为 `[...ROLE_SERVER_GATED_TOOLS]` 拷贝，
  `resolveByAgent` / `resolveManyByAgents` 均返回；worker wire 格式
  (`AgentGuardRole` / `buildAgentPolicies().guard.roles[*]`) 零改动——matrix +
  custom-agents 两个 spec 显式断言 permission/tools 均无门控键。
- 验证：`cd server && npx tsc -p tsconfig.json --noEmit` exit 0；
  `npx jest src/prisma/seed.spec.ts src/common src/execution-policies` →
  14 suites / 127 tests 全绿（含更新后的 1 snapshot，其 diff 仅为门控 deny 删除 + D4 allow 新增）。
- Commit：`feat(policies): split server-gated tools from guard allowlist`（仅 server
  侧文件；`.omo/boulder.json` 的未暂存改动为前人遗留，未纳入本次提交）。
