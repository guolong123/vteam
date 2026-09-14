# Fix: Agent 工具权限展示与真实生效权限对齐（A 方案）

## 决策（用户已定）
- **A 方案**：Agent 管理页「工具权限」区改为**只读展示真实生效的 ExecutionPolicy 权限**（`edit`/`read`/`bash`/`task` + 工具 deny）。
- **不做旧说明**：不写"已退役/deprecated"文案。
- **不留旧代码、不做双轨（AB 实现）**：旧机制直接移除，保持代码干净。
- **MCP 入口保留**：swagger（`vteam-api`）与 `vteam` 的 MCP 工具操作入口保留；**disabled 时默认收起**，启用后可展开配置。
- 后续会做「vteam 平台管理角色」来操作平台本身（本次不做，仅保留入口）。

## 根因（已核）
- `agent_tool_effects` 表 0 行 → 前端 `?? "allow"` 默认值把 200 条启用工具全渲染成 allow。该字段**无运行时消费点**，真实权限在 `ExecutionPolicy` + opencode 原生 permission + guard。
- tools 表启用 200 条（builtin 6 + mcp 194），其中 194 条绝大多数是 `vteam-api`(swagger) 的 REST 端点。

## 实施
### Lane S — server
- S1 移除 `agent_tool_effects` 全后端链路（service/DTO/spec/schema），Agent 读写只保留 `policyId`；`toAgentDto` 去掉 `toolEffects`/`permissionScope`。
- S2 `GET /agents?withEffectivePermission=…` 或详情返回生效权限（复用 `ExecutionPolicyService.resolveByAgent`）。
- S3 `GET /tools` 支持 `enabled` 显式查询（含禁用）+ 返回 `mcpServer`；供前端分组与收起。

### Lane W — web
- W1 工具权限区改只读渲染生效权限（native permission + 工具 deny），去掉 toolEffects 编辑与保存。
- W2 MCP 工具按 `mcpServer` 分组；disabled server 默认收起，启用后可展开。
- W3 去掉 permissionScope 静态区（或改由生效权限承载）。

## 验证
- server tsc + 相关 spec；worker 不涉及。
- 前端 lint + tsc。
- 运行栈实测：Agent 详情返回生效权限；工具列表分组/收起正确。
