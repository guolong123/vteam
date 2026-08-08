# Task 20 — M1 前后端联调验收（登录 → 项目 → 导航）

## 联调环境

| 服务 | 端口 | 说明 |
|------|------|------|
| server（NestJS 10） | 3000 | 全局前缀 `/api/v1`，全局 JWT 守卫（`APP_GUARD`），`@Public()` 放行 login |
| web（Next.js 15.5.22） | 3001 | dev server，`next.config.ts rewrites` 代理 `/api/v1/*` → `http://localhost:3000/api/v1/*` |

- 代理后浏览器同源，无 CORS 问题；生产可用 `NEXT_PUBLIC_API_BASE_URL` 指向独立后端域名（`web/lib/api.ts` 已支持）。
- 端口避让：5177 被 md-docs 占用，故 web 用 3001（任务约定）。

## 数据流（M1 主流程）

```
浏览器(3001) ──POST /api/v1/auth/login {admin,admin123}──▶ server(3000)
   │  JwtAuthGuard 放行（@Public）
   │◀── 200 { accessToken, refreshToken, user:{id:"u_admin",...} }
   │  api.ts 同步 token → authStore（zustand persist → localStorage）
   ▼
浏览器 ──GET /api/v1/projects──▶ server
   │  请求头：Authorization: Bearer <accessToken>（api.ts 自动注入）
   │          x-user-id: u_admin（projects task 17 临时方案，从 authStore.user.id 透传）
   │  鉴权链：全局 JwtAuthGuard（Bearer 校验）→ PlaceholderAuthGuard（x-user-id）
   │◀── 200 { items:[{name:"AI 智能体平台"},{name:"文档协作平台"}], total:2 }
   │  TanStack Query 渲染项目卡片网格
   ▼
浏览器 ──router.push / 导航跳转──▶ /board /agents /workers /skills /messages /users
   │  AppShell 登录守卫校验 localStorage token（hasHydrated 防竞态）
   │  无需重新登录，各导航页正常渲染
```

## 联调适配点（Task 20 引入）

1. **`web/next.config.ts`**：新增 `rewrites()`，`/api/v1/:path*` → `http://localhost:3000/api/v1/:path*`（可经环境变量 `API_PROXY_TARGET` 覆盖）。
2. **seed 数据补齐**：seed 项目（p_seed_1/p_seed_2）原 owner 为 `seed-admin`，初始 admin（u_admin）无成员关系。为满足「admin/admin123 登录 → 项目列表（seed 数据）」验收，为 `u_admin` 补齐两条 `project_members` 记录（role=owner）。纯数据准备，未改任何 server 业务逻辑。

## 验证结果

### 1) curl 接口链路（经 web 代理）

| 请求 | 结果 |
|------|------|
| `POST /api/v1/auth/login` (admin/admin123) | 200，返回 accessToken + refreshToken + user(u_admin) |
| `GET /api/v1/projects`（Bearer + x-user-id） | 200，items=2（AI 智能体平台 / 文档协作平台，role=owner） |
| `GET /api/v1/projects`（无 token） | 401 |
| `GET /api/v1/projects`（有 token 无 x-user-id） | 401 |

### 2) Playwright 全流程（chromium 1440×900）

```
PASS 登录页可达 (200)
PASS 登录表单可渲染
PASS 登录成功跳转 /projects
PASS JWT 已写入 localStorage
PASS 项目卡片渲染  count=2
PASS seed 项目: AI 智能体平台
PASS seed 项目: 文档协作平台
PASS 状态徽章: 进行中
PASS 导航到 /board 成功
PASS 导航到 /agents 成功
PASS 回 /projects 仍显示项目
===== 11/11 通过 =====
```

导航遍历 `/board /agents /workers /skills /messages /users` 全部可达，登录态保持（无重复登录）。

### 3) 控制台与网络

- API 请求（login / projects）全部 2xx，无 CORS、无 4xx/5xx。
- 无 console error；无 React hydration 警告。
- 唯一捕获项为 Next.js dev HMR 的 `webpack.*.hot-update.js net::ERR_ABORTED`（页面导航中断旧热更新请求，dev 模式正常现象，非联调错误）。

## 截图

| 文件 | 内容 |
|------|------|
| `task-20-login.png` | 登录页（品牌区 + 表单） |
| `task-20-projects.png` | 项目列表（2 个 seed 项目卡片，真实数据） |
| `task-20-board.png` | 导航 → /board（任务看板） |
| `task-20-agents.png` | 导航 → /agents |
| `task-20-nav-{workers,skills,messages,users}.png` | 其余导航页 |

## 范围边界

- 未改前端视觉 / server 业务逻辑（仅 next.config.ts 代理 + seed 数据成员关系补齐）。
- 未实现 Phase 2 功能（任务状态机 / 群聊等）。
- 验证完成后已停止临时 server/web 进程。