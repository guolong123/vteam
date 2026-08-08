# Task 12 — project-list 页迁移 + 数据接入

## 目标
将 `docs/agent-platform/prototypes/project-list/index.tsx` **保真迁移**为 `web/app/(main)/projects/page.tsx`，接入真实数据：`GET /api/v1/projects`（Task 17）→ TanStack Query 渲染列表；创建项目弹窗 → `POST /api/v1/projects`。data-testid 保留；空态用 EmptyState 组件（Task 9）。

## 交付文件
| 文件 | 说明 |
|------|------|
| `web/app/(main)/projects/page.tsx` | 项目列表页（client）：卡片网格 / 操作行 / 创建弹窗 / 空态 / 加载与错误态 |

> 说明：Task 描述中的路径 `web/src/app/(main)/projects/page.tsx` 在本仓库实际为 `web/app/(main)/projects/page.tsx`（`src` 目录仅存组件与 token，App Router 页面在 `web/app/`）。

## 实现要点
- **保真迁移**：操作行（「我的项目」+「N 个项目正在协作」+ 新建项目按钮）、卡片三段布局（头部 name+StatusBadge / 描述 / 底部任务统计+成员容器）、网格 `repeat(auto-fill,minmax(300px,1fr)) gap 24`、间距/圆角/字号/阴影全部走 `src/theme/tokens.ts`；`data-testid` 保留：`project-list-root` / `project-card` / `create-project-button`。
- **导航由 AppShell 提供**（Task 10）：本页仅渲染内容区，不再自带 NavTopBar / NavDock / CmdKPanel；页面根 `padding: space.xl`（AppShell 已做左缘 80px 避让 Dock）。
- **数据接入**：`useQuery(["projects"])` 拉 `GET /projects`；`useMutation` + `invalidateQueries(["projects"])` 提交后刷新列表。
- **状态映射**：API `status`（active/archived）→ 原型 `StatusKey`（active="进行中" / archived="已归档"）。
- **字段兜底**：原型卡片底部任务统计与成员 Agent 头像需项目内任务/成员列表端点（Phase 2，`GET /projects/:id`），Phase 1 API 无此数据 → 任务统计 0 兜底（seed 项目确无任务，真实值）、成员区保留布局渲染空容器。
- **认证适配**：Task 17 的 projects 端点当前为 `PlaceholderAuthGuard`（`x-user-id` header）+ 全局 `JwtAuthGuard`（Task 15），页面从 `authStore.user.id` 显式透传 `x-user-id`，api.ts 自动携带 Bearer；JWT 切换后本 header 无副作用。
- **空态**：`projects.length === 0` 时渲染 `EmptyState`（title「还没有项目」/ description「创建你的第一个项目，开始组建 AI 协作团队」）+ 新建项目 action。
- **错误态**：查询失败显示错误信息 + 重试按钮。

## 验证结果

### 1) 构建 `cd web && npm run build`
```
✓ Compiled successfully in 4.6s
✓ Generating static pages (14/14)
Route (app)          Size  First Load JS
├ ○ /projects      8.75 kB         119 kB
EXIT_CODE=0
```

### 2) API 实测（server: PORT=3100）
```
GET  /projects  (Bearer + x-user-id=u_seed_admin)  → 200  items=2（seed：AI 智能体平台 / 文档协作平台）
POST /projects  {"name":"AT 测试项目",...}         → 201  ownerId=u_seed_admin status=active
GET  /projects  → 200  items=3（新项目在最前）
```
验证后已清理临时项目，dev.db 保持 seed 确定性（2 项目 / 2 owner 成员记录）。

### 3) Playwright 实测（web dev :3110 + server :3100，登录 seed-admin）
```
PASS 页面已渲染项目列表（project-list-root）
PASS 项目卡片渲染(>=2 seed)  count=3
PASS seed 项目: AI 智能体平台                          # 真实数据渲染
PASS seed 项目: 文档协作平台
PASS 状态徽章: 进行中                                  # active → StatusKey 映射
PASS 操作行: N 个项目正在协作
PASS 新建项目按钮
PASS 列表态下无空态组件
PASS 创建弹窗打开（create-project-modal）
PASS 创建后列表刷新出现新项目  before=3 after=4        # invalidateQueries 失效重取
PASS 弹窗已关闭
PASS 无页面报错
===== 13/13 通过 =====
```

### 4) 空态实测（seed-member 登录，无项目）
```
PASS empty-state 可见
empty-state 文本: ▤ | 还没有项目 | 创建你的第一个项目，开始组建 AI 协作团队 | + | 新建项目
```

## 截图
- `.omo/evidence/task-12-list.png` — 列表渲染（seed 真实数据）
- `.omo/evidence/task-12-create-modal.png` — 创建项目弹窗
- `.omo/evidence/task-12-list-after-create.png` — 创建后列表刷新
- `.omo/evidence/task-12-empty-state.png` — 空态（EmptyState）

## 说明
- 未修改 `server/`，未引入新依赖（复用既有 `@tanstack/react-query` / `zustand` / api.ts）。
- 未实现项目详情（Phase 2）。
- 运行时验证采用 dev 模式 + 测试浏览器禁用 web security（server 未开启 CORS，属既有 server 配置，不在本任务范围）；生产构建不受影响。