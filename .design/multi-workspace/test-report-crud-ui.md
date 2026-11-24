# 真实页面 CRUD 验收报告（2026-11-13）

## 怎么跑

```bash
cd web
WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1 \
WORKSPACE_WEB_BASE=http://127.0.0.1:13201 \
npx playwright test --config=playwright.workspace-ui.config.ts workspace-crud.ui.spec.ts
```

用例：`e2e/workspace-crud.ui.spec.ts`（10 条，全部真实浏览器操作；每轮新建独立空间）。
截图：`.design/multi-workspace/shots/crud-ui/`。

## 覆盖（10 条，全部通过）

| 资源 | 页面路径 | 页面操作 |
|---|---|---|
| 角色 | 系统管理 → 角色权限 | 新建角色 → 列表可见 → 删除 |
| 技能 | 技能与工具 → 技能 | 新建技能 → 编辑描述 → 启停 |
| 消息渠道 / 通知渠道 | 外部渠道（两个 Tab） | 新建 → 改名 → 删除（两类都验证） |
| MCP Server | 技能与工具 → 工具 → MCP 工具 | 新建（remote）→ 编辑 URL → 删除 |
| Git 凭证 + 仓库 | 仓库管理（凭证/仓库 Tab） | 建凭证 → 建仓库 → 删仓库 → 删凭证 |
| 成员 | 团队与成员 → 成员库 | 新建成员 → 编辑提示词 → 删除 |
| Agent | Agent 页 | 新建自定义 Agent → 删除 |
| Provider/模型 | 模型管理 → Provider 管理 | 新增 Provider（含模型）→ 编辑 Base URL → 删除 Provider |
| Agent 岗位 | Agent 页 → 角色 Tab | 新建岗位 → 编辑描述 → 删除 |
| 团队 | 团队 → 新建团队 | 按岗位建团队 → 改名 → 删除 |

## 本轮 UI 测试发现的真实问题（已修复）

**MCP 保存后自动同步失败会让整页列表变成「加载失败」**

- 复现：新建一个 remote MCP Server（指向不可达地址）→ 保存触发自动同步 → 同步 400；
  随后技能/工具页整页显示「加载技能/工具列表失败」，必须点「重试」才恢复。
- 原因：`skills/page.tsx` 的 `loadError` 只要任一列表 query 有 error 就用整页错误态盖住列表，
  而此时列表缓存数据仍然存在。
- 修复：有缓存数据时不再用整页错误态；仅在首次加载无任何数据时才展示整页错误。

## 设计性限制（UI 不提供删除，故 UI 用例止于启停/编辑）

- 技能、工具：只有编辑/启停/回滚，无物理删除；
- 任务/问题：无独立「资源 CRUD」页（问题在任务详情内流转），本轮 UI 覆盖其 API CRUD；
- 用户：无删除，只有禁用；工作空间：无改名/删除。

## 结果

- 页面 CRUD：**10 passed**
- 原 UI 套件：3 passed（合计 13 passed）
- 功能验收：8 passed
- API 全量：44 passed
- server 全量 jest：5091 passed
