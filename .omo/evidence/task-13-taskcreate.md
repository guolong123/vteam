# Task 13 — task-create 页保真迁移（web 前端）

时间: 2026-08-07
工作目录: /data/git-project/aiagents/web
唯一来源: `docs/agent-platform/prototypes/task-create/index.tsx`

## 1. 交付文件

| 文件 | 说明 |
|------|------|
| `web/app/(main)/tasks/new/page.tsx` | task-create 页（client 组件，TaskForm + AgentSelectPanel） |

> 路径说明：计划书中写 `web/src/app/(main)/tasks/new/page.tsx`，但本项目 Next.js 路由实际位于
> `web/app/`（Task 10 已交付 `web/app/(main)/layout.tsx` 用 AppShell 包裹，`src/app` 不存在）。
> 遵循仓库既有约定创建于 `web/app/(main)/tasks/new/page.tsx`，功能等价。

## 2. 保真迁移核对（与原型逐项比对）

| 类目 | 原型 | 迁移后 | 结果 |
|------|------|--------|------|
| 左栏卡片 | 任务信息（标题* / 描述 / 背景文档 / 优先级 / 提示条） | 结构/样式/文案一致 | ✅ |
| 右栏卡片 | 选择协作 Agent（4 角色）+ 已选列表 + 创建按钮 + create-hint | 一致 | ✅ |
| 初始勾选态 | product/developer 已勾选，product=主 Agent | 一致（playwright 实测 data-checked=["product","developer"]） | ✅ |
| data-testid | task-title / task-description / priority-select / doc-upload / doc-upload-btn / doc-file / agent-option / main-agent-tag / create-task-button / create-hint / selected-agents / task-create-root | 全部保留 | ✅（playwright 11/11 testid 存在，doc-file×3） |
| token | 原型 `_shared/styles` | 统一走 `src/theme/tokens.ts`（继承 Task 8/9：styles 与 tokens 逐字一致） | ✅ |
| 共享组件 | AgentAvatar / AgentBadge | `@/src/components/ui`（Task 9） | ✅ |
| 导航 | NavDock / NavTopBar / CmdKPanel | 由 AppShell `(main)/layout.tsx` 提供（Task 10），页面仅渲染内容区 | ✅ |
| 铁律 T15 | root 高度由 AppShell main flex 接管 | 页面无 fixed / 100vh / 100vw | ✅ |

## 3. 交互增强（原型为静态勾选，本页实现联动，视觉不变）

1. **Agent 勾选联动**：点击卡片切换勾选；「已选 Agent / N 个」与徽章列表实时联动
   （playwright：勾选 architect → data-checked=true，已选计数联动）。
2. **主 Agent 保持有效**（FR-19）：主 Agent 默认产品经理；取消勾选当前主 Agent 时自动
   转移至第一个勾选角色（playwright：取消 product → 主 Agent 徽章转移到 developer）。
   徽章背景色跟随主 Agent 角色（默认 product 蓝色，与原型字节一致）。
3. **空标题校验**：点击创建且标题为空 → 红色提示 `!请输入任务标题`（`data-testid=title-error`，
   红色 #DC2626 小字号，与原型视觉语言一致；原型无校验逻辑，此为 MUST DO 要求的交互）。
4. **提交**：`POST /api/v1/projects/:pid/tasks`（09 篇 §3.2 契约 `{title, description?, priority?,
   agentIds[], mainAgentId?, backgroundDocs[]?}`）。pid 取 URL `?pid=`，缺省 mock `p1`。

## 4. 提交模式（Phase 2 端点状态）

- **已确认**：`server/src/` 无 tasks 模块；`ProjectsController` 仅有 GET/POST `/projects`，
  `POST /projects/:pid/tasks` 属于 09 篇 §3.2 契约、Phase 2 计划端点。
- **行为**：页面 at 创建时先尝试真实 `POST`（fetch `/api/v1/projects/p1/tasks`，Next dev/prod
  无此路由 → 404，api.ts 归一化为 ApiError）→ catch 后展示 **mock 成功态**（`data-testid=create-success`，
  绿色状态条 + 小字 `（任务创建接口 Phase 2 未就绪，本次为模拟成功态）`）。
- **后端就绪后接管**：无需改前端，真实响应返回即走真实成功分支（`mockMode=false`）。
- 预期 console 404（仅提交路径一条，非页面错误）：playwright 实录 `Failed to load resource:
  the server responded with a status of 404`，即 mock fallback 的触发点。

## 5. 验证

### build
```
$ cd web && npm run build
EXIT=0；/tasks/new 4.51 kB（app 路由已生成，TS 类型检查通过）
```
（注：首次 build 因 `.next` 残留 BUllD_ID 缺失导致 `next start` 报
`Could not find a production build`，`rm -rf .next` 重建后正常，非代码问题。）

### Playwright 实测（chromium headless，1440×900，注入登录态）
| 项 | 结果 |
|----|------|
| 页面加载 task-create-root | PASS |
| 全 data-testid 存在（11 类，doc-file×3） | 11/11 PASS |
| 初始勾选 product/developer + 主 Agent=product | PASS |
| 空标题提交 → title-error「请输入任务标题」 | PASS |
| 勾选 architect 联动 | PASS |
| 取消主 Agent product → 主 Agent 转移到 developer | PASS |
| 提交 → create-success mock 成功态（含「模拟成功」标注） | PASS |
| Cmd+K 面板唤起 / Esc 关闭（AppShell 导航） | PASS |
| console error | 1（预期：POST /tasks 404 → mock fallback） |

### 截图
- `task-13-taskcreate-initial.png`（初始态：与原型截图一致）
- `task-13-taskcreate-title-error.png`（空标题校验）
- `task-13-taskcreate-submitted.png`（提交 mock 成功态）

## 6. 边界与 MUST NOT
- 未实现任务创建后端逻辑（Phase 2，不修改 server/）
- 未改动表单视觉 / 字段布局（与原型一致）
- 未引入新依赖（playwright 仅用于本机验证脚本，不入包）