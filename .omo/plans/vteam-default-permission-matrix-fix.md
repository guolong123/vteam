# 计划：默认 Agent 权限矩阵修复（guard 与 server 门职责分离）

## TL;DR (For humans)

修复默认权限矩阵的三类缺陷：(1) 5 个「仅主 Agent」工具因 guard 白名单未收录而对**全员（含主 Agent）deny**，应改由 platform-mcp 服务端的 `mainAgentInstanceId` 权威门判定；(2) 补齐跨角色共享的对话/读类工具（PM/plan 的 `chat_history`、developer 的 `doclib`）；(3) 补齐被全局指令明确要求、却全员 deny 的通道工具（`wecom_reply`/`channel_send`）。

## 决策来源（用户确认）

- 用户报告：「项目经理的 `vteam_chat_history` 是拒绝的，这个感觉不合理……这个应该全都能执行才对」。
- 用户确认执行本方案：「可以」。
- 沿用约束：「不需要标注已退役相关说明」「涉及兼容问题不保留老代码，保持代码干净，不做 AB 实现」。

## 已实测事实（本会话）

- 用运行中 worker 的 `dist/role-guard/policy.js` 逐个判定：PM 对 `vteam_chat_history`/`task_transition`/`question_confirm`/`plan_mode`/`task_add_member`/`wecom_reply`/`channel_send` **全部 deny**。
- 7 个工具在**所有 6 个角色**的 `toolAllows` 中均缺席 → guard 最后分支 `isToolAllowed` 判 deny。
- seed 团队 `tm_0000000001` 的 `main_agent_member_id` = **项目经理** → 主 Agent 本人也被拦。
- platform-mcp 服务端**已有**权威门：`task.mainAgentInstanceId` / `team.mainAgentMemberId`（`findTaskTeamGate` + 各 handler 的 403），目前**永远收不到请求**。
- `agent.constants.spec.ts:186-193` 断言「任何角色的 toolAllows 都不得含 `task_transition`/`question_confirm`」——**把 bug 当成契约锁住**。
- `VTEAM_MCP_TOOL_NAMES`（22 项）漏了 `vteam_task_create`（registry 有 23 项）。
- 现行 `mcpDenies = VTEAM_MCP_TOOL_NAMES - toolAllows` → 层① 会对这 7 个工具写显式 `deny`，与层② guard 双重拦截。

## 冻结设计（唯一事实源）

### D1 两道门的职责边界（本次修复的核心）

| 工具类别 | 判定者 | guard 行为 | 层① permission |
|---|---|---|---|
| read / edit / bash | guard（层① + 层②） | 判定 | 现状 |
| 普通 MCP 工具（`group_post`/`issue_*`/`memory_*`…） | guard 层② allowlist | 判定 | 现状 |
| **主实例专属**（5 个） | **platform-mcp 服务端**（`mainAgentInstanceId`） | **pass-through（不判定）** | **不写 deny** |
| 通道工具（`wecom_reply`/`channel_send`） | guard 层② allowlist（按角色） | 判定 | 现状 |

**主实例专属工具（server-gated）**：`vteam_task_transition`、`vteam_question_confirm`、`vteam_task_create`、`vteam_plan_mode`、`vteam_team_add_member`。

### D2 guard 侧实现

- `worker/src/role-guard/policy.ts` 与 `worker/src/resources/role-guard-plugin.ts` 内联体：新增 `SERVER_GATED_TOOLS` 集合，命中即 `{action:'allow'}`（放在 `TASK_TOOLS` 判定之后、`BUILTIN_PASSTHROUGH` 之前）。
- worker 不 import server 代码 → 集合在 worker 侧**本地声明**（与 server 常量同值，由 parity spec + e2e 断言锁定一致）。
- **wire 格式不变**（`{enabled, roles:{permission,tools,bashDeny,correction}}`）→ worker 的 `assertGuardRole` 零改动。

### D3 server 侧实现

- `agent.constants.ts`：新增 `ROLE_SERVER_GATED_TOOLS: readonly string[]`（5 个真实名），并在 `defineBoundary` 的 `mcpDenies` 推导中排除它们（`!= allowed && != server-gated`）→ 层① 不再写 deny。
- `VTEAM_MCP_TOOL_NAMES` 补 `vteam_task_create`（与 registry 对齐，22→23）。
- `ExecutionPolicyService.resolveByAgent/resolveManyByAgents` 返回值 `ResolvedExecutionPolicy` 新增 `serverGated: string[]`（**仅 API/UI 用，不进 worker wire 格式**）。

### D4 补齐的按角色 allow（层② toolAllows）

| 角色 | 新增 allow |
|---|---|
| `vteam-product` | `vteam_wecom_reply`、`vteam_channel_send` |
| `vteam-architect` | `vteam_wecom_reply`、`vteam_channel_send` |
| `vteam-developer` | `vteam_doclib`、`vteam_wecom_reply`、`vteam_channel_send` |
| `vteam-tester` | `vteam_wecom_reply`、`vteam_channel_send` |
| `vteam-project_manager` | `vteam_chat_history`、`vteam_wecom_reply`、`vteam_channel_send` |
| `vteam-plan` | `vteam_chat_history`、`vteam_wecom_reply` |

（`channel_send` 不含 `vteam-plan`：只读计划角色不承担外部通知。）

### D5 prompt 对齐

各角色 seeded prompt 的「可用工具」行与 D4 + 现状一致（补 `chat_history`/`doclib`/`wecom_reply`/`channel_send`，并补 developer/tester 漏列的 git 只读工具）。

## Todos

- [x] 1. [server] `ROLE_SERVER_GATED_TOOLS` + `mcpDenies` 排除 + 补 `task_create` 常量 + 按角色 allow 补齐 + `serverGated` 契约
  References: `server/src/common/constants/agent.constants.ts:105-162`（VTEAM_MCP_TOOL_NAMES / VTEAM_GIT_TOOL_NAMES / RoleBoundary / defineBoundary）、`:243-438`（ROLE_BOUNDARIES）、`server/src/execution-policies/execution-policy.service.ts:220-300`（resolveByAgent/resolveManyByAgents）
  Acceptance: 新增 `ROLE_SERVER_GATED_TOOLS`（5 个真实名）；`defineBoundary` 的 `mcpDenies` 排除 server-gated；`VTEAM_MCP_TOOL_NAMES` 含 `vteam_task_create`；D4 六个角色的 `toolAllows` 补齐；`ResolvedExecutionPolicy.serverGated` 返回该清单。
  QA: happy - `buildAgentPolicies()` 的层① 对这 5 个工具无 deny 键；六角色 toolAllows 与 D4 一致。failure - 任一 server-gated 工具出现在任何 `mcpDenies` 即失败。Evidence: `server/src/common/constants/agent.constants.spec.ts` + `server/src/execution-policies/agent-policies.custom-agents.spec.ts`。
  Commit: `feat(policies): split server-gated tools from guard allowlist`
  Recommended task executor category: deep

- [x] 2. [worker] guard 新增 `SERVER_GATED_TOOLS` pass-through（policy.ts + 内联插件体）+ parity
  References: `worker/src/role-guard/policy.ts:90-190`（TASK_TOOLS/BUILTIN_PASSTHROUGH/evaluateToolCall）、`worker/src/resources/role-guard-plugin.ts:64-150`（内联判定块）、`worker/src/resources/role-guard-plugin.spec.ts`（parity 矩阵）
  Acceptance: 两个判定实现都新增与 server 同值的 `SERVER_GATED_TOOLS` 集合；命中返回 `{action:'allow'}`（位于 `TASK_TOOLS` 之后）；内联体与 policy.ts 逐字节 parity 保持；wire 格式零改动（`assertGuardRole` 不动）。
  QA: happy - 对 `vteam_task_transition` 等 5 个工具，guard 返回 allow；非 server-gated 的未知 MCP 工具仍 deny；parity 矩阵全绿。failure - 任一 server-gated 工具被 guard deny 即失败。Evidence: `worker/src/role-guard/policy.spec.ts` + `worker/src/resources/role-guard-plugin.spec.ts`。
  Commit: `feat(guard): pass through server-gated tools to the main-agent gate`
  Recommended task executor category: deep

- [x] 3. [seed] 角色 prompt「可用工具」对齐 D4（+ 补 dev/tester 的 git 只读工具）
  References: `server/prisma/seed.ts:138-280`（五角色 prompt 的『可用工具』行）、`:296-370`（模板 Agent upsert）
  Acceptance: 六角色 prompt 的可用工具行与 D4 + 实际 guard allowlist 完全一致；developer/tester 补上漏列的 `git_clone/pull/status/diff/log`；不新增/删除角色。
  QA: happy - 逐角色对比 prompt 声明集合 == `ROLE_BOUNDARIES[role].toolAllows` 键集合（git 前缀已计）。failure - 出现任一侧独有项即失败。Evidence: `server/src/prisma/seed.spec.ts`。
  Commit: `docs(seed): align role prompts with effective tool allowlist`
  Recommended task executor category: writing

- [x] 4. [web] 展示 server-gated 工具为独立只读态（不再误显「禁止」）
  References: `web/app/(main)/agents/page.tsx`（`effectOf` ~495、`EffectivePermission` 类型 ~53、`ToolEffectSelect`）、`server/src/execution-policies/execution-policy.service.ts`（`serverGated`）
  Acceptance: `EffectivePermission` 增 `serverGated?: string[]`；`effectOf` 对命中项返回独立状态（如 `server`），UI 渲染只读徽标「仅主 Agent」并可加说明；不改变 allow/ask/deny 的编辑逻辑（server-gated 不可编辑）。
  QA: happy - Playwright：该 5 行显示「仅主 Agent」而非「禁止」；自定义 agent 页可正常编辑其它工具。failure - 仍显示「禁止」即失败。Evidence: `.omo/evidence/permission-matrix/web-server-gated.png`。
  Commit: `feat(web): show server-gated tools as main-agent-only`
  Recommended task executor category: visual-engineering

- [x] 5. [e2e] 重建 + 重 seed + 重启 worker，端到端验证矩阵修复
  References: `scripts/e2e-role-boundaries.sh`、`scripts/e2e-custom-agent-opencode.sh`、本会话审计 `.omo/evidence/custom-agent-opencode/permission-matrix-audit.txt`
  Acceptance: 脚本可复现：① 6 内置角色的 server-gated 5 工具 `permission` 无 deny 键、guard 返回 allow；② PM 的 `chat_history`、developer 的 `doclib`、六角色的 `wecom_reply` 由 deny 变 allow（用 worker guard 判定）；③ server 门仍在：非主实例调 `task_transition` 由 platform-mcp 返回 403（主实例放行）；④ 单位测试/parity 全绿；⑤ server 侧 server-gated 集合与 worker 侧逐项一致。
  QA: happy - 五步全绿并留证据；failure - 任一项不成立即失败。Evidence: `.omo/evidence/permission-matrix/e2e.txt`。
  Commit: `test(e2e): verify default permission matrix split`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；References 真实存在；`mcpDenies` 与 `toolAllows` 恒一致断言在案。Evidence: `.omo/evidence/permission-matrix/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/stub；server-gated 集合单一来源且两侧一致；无 AB 双轨/退役说明。Evidence: `.omo/evidence/permission-matrix/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手工 QA — worker guard 实测六角色矩阵 + server 门实测（主/非主实例）+ Playwright 页面展示。Evidence: `.omo/evidence/permission-matrix/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 未越界；非 server-gated 工具的角色边界不变（read/edit/bash/普通 MCP 判定零回归）。Evidence: `.omo/evidence/permission-matrix/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- `cd server && npx tsc -p tsconfig.json --noEmit`、`cd worker && npx tsc --noEmit`、`cd web && npx tsc --noEmit` 均 exit 0。
- 相关 jest 全绿（agent.constants / execution-policies / role-guard policy + plugin parity / seed / web）。
- 实测：PM 可调 `task_transition`（guard allow + server 主实例门放行）、非主实例被 server 403；PM `chat_history` allow；developer `doclib` allow；六角色 `wecom_reply` allow。
- server 与 worker 的 server-gated 集合逐项一致。
