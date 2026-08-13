# Learnings — issue-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-08-13 主 Agent 动态注入 + 团队进全局上下文（main-agent-dynamic）

- **模板 prompt 不写死「主 Agent」**：seed.ts 中产品/项目经理模板已移除主 Agent/牵头协调者表述，模板只描述角色本职；牵头/协调/汇总职责由 `dispatchForTarget` 按 `Task.mainAgentId` 运行时判定后经 system 通道动态注入（`MAIN_AGENT_INSTRUCTION`，仅注入给被选为主 Agent 的目标）。
- **团队信息走 system 通道**：`buildSystemInstructions(agent, opts?)` 扩展签名，opts.team 非空追加【团队成员】段（id/名称/角色 + 主 Agent 标注），agent 无需再调 task_context MCP 拉取；system 通道不进入聊天记录，符合「全局上下文」语义。
- **dispatch 是 hot path，task 查询最小化**：`prisma.task.findUnique` 只 select `mainAgentId + taskAgents.agent 三字段`，不整行拉取；多目标分派时每个 dispatchForTarget 各查一次（幂等轻量，可接受）。
- **spec mock 默认返回 undefined 即「无 task 行」**：prisma mock 新增 `task: { findUnique: jest.fn() }` 且默认不设返回 → isMainAgent=false + team=[]，既有断言全部不受影响；注入用例单独 mockResolvedValue。这比默认 mockResolvedValue(null) 更贴近真实「未 mock 就是 undefined」。
- **团队段标注主 Agent 需要 mainAgentId**：TeamMemberInfo 只含 id/name/role，标注「—— 主 Agent」需在 opts 额外传 mainAgentId（成员 id 匹配），扩展签名向后兼容单参调用。
- **落库验证字符集坑**：`docker exec ... mysql` 不带 `--default-character-set=utf8mb4` 时中文显示为 `?`，且 `LOCATE('中文', prompt)` 返回 0（连接字符集非 utf8mb4 导致字面量被错误转换）；验证中文 prompt 必须加该参数。

