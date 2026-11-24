# 平台资源 CRUD 全面体检报告（2026-11-13）

## 怎么跑

```bash
cd web
WORKER_TOKEN=ws-test-worker-token \
WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1 \
npx playwright test --config=playwright.api.config.ts
```

用例文件：
- `e2e/workspace-crud.platform.api.spec.ts` — 平台/全局资源（10 条）
- `e2e/workspace-crud.workspace.api.spec.ts` — 空间内资源（8 条）

每个用例都在**独立新建工作空间**执行，避免污染与相互影响；平台管理员 token。

## 覆盖矩阵（18 条）

| 资源 | 创建 | 读取 | 修改 | 删除/清理 | 备注 |
|---|---|---|---|---|---|
| 角色 Role | ✅ | ✅ 列表 | ✅ | ✅ | 权限矩阵入参 |
| Agent 岗位 AgentRole | ✅ | ✅ 详情 | ✅ | ✅ | |
| Agent | ✅ | ✅ 详情 | ✅ | ✅（含克隆+删克隆） | |
| 执行策略 ExecutionPolicy | ✅ | ✅ | ✅ | ✅ | |
| Provider/模型 | ✅ | ✅ 详情/Provider 列表 | ✅ Provider baseUrl | ✅ Provider（级联模型） | 模型无独立 DELETE，随 Provider |
| 技能 Skill | ✅ multipart | ✅ 内容 | ✅ | ⚠️ 无删除接口（启停+回滚，设计如此） | |
| 工具 Tool | ✅ | ✅ 按名过滤 | ✅ | ⚠️ 无删除接口（启停，设计如此） | |
| MCP Server | ✅ | ✅ | ✅ | ✅ | |
| Worker | ✅ 注册 | ✅ 列表 | ✅ maxInstances | ✅（先等 offline；在线删除 409 符合设计） | 用空间注册令牌注册 |
| 上传 Upload | ✅ | ✅ 签名 URL 内容 | — | ⚠️ 无删除/列表接口 | |
| 工作空间 Workspace | ✅ | ✅ 列表/成员 | — | 成员✅（加/移） | 空间本身无改名/删除接口（设计未提供） |
| 用户 User | ✅ | ✅ 列表/详情 | ✅ 状态/资料/空间/重置密码 | ⚠️ 无删除（禁用代替） | 新密码重新登录验证 |
| 团队 Team | ✅ | ✅ 详情 | ✅ 描述 | ✅ | |
| 成员 Member | ✅ | ✅ 详情 | ✅ | ✅（先移除团队席位） | |
| Git 凭证/仓库 | ✅ | ✅ 列表 | ✅ 描述/换凭证 | ✅ | |
| 消息渠道 | ✅ | ✅ 详情 | ✅ | ✅ | |
| 通知渠道 | ✅ | ✅ 详情 | ✅ | ✅ | |
| 任务 Task | ✅ | ✅ 详情 | ✅ 标题 | ⚠️ 无删除接口（状态流转设计） | 任务要求团队有成员 |
| 问题 Issue | ✅ | ✅ 详情 | ✅ 标题 | ✅（含 transition） | |
| 会话 Chat | ✅ 私聊（需成员已在团队） | ✅ 频道列表 | — | ✅ soft delete | |
| 记忆 Memory | ⚠️ 无 REST 创建（仅 Agent MCP 写入） | ✅ 列表 | ✅ 边界 404 | ✅ 边界 | 不存在行 PATCH 非 500 |

## 结果

- **API 全量：44 passed**（26 隔离矩阵 + 10 平台 CRUD + 8 空间 CRUD）
- **浏览器功能验收：8 passed**
- **UI 套件：3 passed**
- **server 全量 jest：223 suites / 5091 passed**

## 本轮到真实缺陷

1. **创建 Git 仓库 500**：多空间后 `GitRepo` 唯一键为 `(workspaceId, repoUrl)`，create 仍用
   `findUnique({ repoUrl })` → Prisma 校验错误。已改 `tenantUniqueWhere('GitRepo', {repoUrl})`,
   并补 API `GIT-REPO-01` 回归（同空间重复 409、跨空间同 URL 可建）。

## 设计性限制（非缺陷，已确认）

- 技能/工具只有启停与回滚，没有物理删除；任务只有状态流转，没有 DELETE；
- 记忆没有 REST 创建入口（由 Agent 通过 MCP 写入），上传没有列表/删除；
- 用户没有 DELETE（禁用）；工作空间没有改名/删除接口；
- Worker 在线不可删（要求先离线），删除前会 409 `WORKER_ONLINE_NOT_REMOVABLE`。
