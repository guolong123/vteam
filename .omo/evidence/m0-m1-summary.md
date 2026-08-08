# M0/M1 证据汇总（Task 22 — 构建/测试全量验证）

> 生成时间：2026-08-07
> 范围：M0（脚手架/健康检查）+ M1（登录联调/原型一致）全量验证与证据收敛
> 声明：本文件为证据索引，仅引用已有证据文件路径，不重复截图。

---

## 1. 全量验证结果（本轮 Task 22）

### 1.1 server 单测 — ✅ 通过
```bash
cd server && npm run test   # jest --runInBand
```
```
Test Suites: 7 passed, 7 total
Tests:       39 passed, 39 total
Time:        5.393 s
```
- **退出码：0**
- 覆盖：auth（auth.service / jwt-auth.guard）、users.service、projects.service、realtime（controller / service）、app.controller 共 7 个套件、39 个用例。
- 测试库：jest + SQLite（prisma/dev.db），与生产 schema 一致。

### 1.2 server build — ✅ 通过
```bash
cd server && npm run build   # nest build
```
- **退出码：0**，无 TS 编译错误。

### 1.3 web build — ✅ 通过
```bash
cd web && npm run build   # Next.js 15 生产构建
```
- **退出码：0**
- 产出 11 条路由：`/` `/login` `/projects` `/board` `/tasks/new` `/agents` `/workers` `/skills` `/messages` `/users` `/_not-found`。
- 占位页（agents/workers/skills/messages/users）首屏仅 136 B，确认为 EmptyState 占位组件。

---

## 2. M0 证据

### 2.1 脚手架（Task 1）
- **证据**：`.omo/evidence/task-1-init.md`
- 内容：web/server/docs 三目录、根级 `.gitignore`（node_modules/.next/dist/.env）、README、`git init` + 首个 commit `48764b7 chore: 初始化项目结构与 git 仓库`。

### 2.2 健康检查（Task 3）
- **证据**：`.omo/evidence/task-3-health.md`（另见 `task-3-port.md`）
- 内容：`GET /api/v1/health` → `{"status":"ok",...}` HTTP 200；全局前缀 `/api/v1`；Swagger `/api/v1/docs` 200；模块骨架 auth/users/projects/realtime/health 全部挂载。

---

## 3. M1 证据

### 3.1 登录联调（Task 15 + Task 20）
- **证据**：`.omo/evidence/task-15-auth-curl.md` + `.omo/evidence/task-20-m1-flow.md`
- Task 15：注册/登录/鉴权 11 项 curl 用例全过（201/409/401/200 错误码对齐 09 API 契约；refresh 双 token；refresh 不可当 access 用）。
- Task 20：前后端联调主流程（浏览器 3001 → 代理 → server 3000），Playwright 11/11 通过：
  - 登录页可达 → 登录成功跳转 /projects → JWT 写入 localStorage → 项目卡片 2 个 seed 项目 → 导航 /board /agents /workers /skills /messages /users 全部可达且登录态保持。
  - API 全 2xx，无 CORS/console error/hydration 警告。
- 截图：`task-20-login.png` `task-20-projects.png` `task-20-board.png` `task-20-agents.png` `task-20-nav-{workers,skills,messages,users}.png`

### 3.2 原型一致（Task 21）
- **证据**：`.omo/evidence/proto-parity/`（3 组视觉对比）
  - `login-diff.png` / `diff-login.png`（impl-login.png vs proto-login.png）
  - `project-list-diff.png`（impl-project-list.png vs proto-project-list.png）
  - `task-create-diff.png`（impl-task-create.png vs proto-task-create.png）
- 根目录配套素材：`proto-login.png` `proto-project-list.png` `proto-task-create.png` 与 `impl-*.png` 一一对应。

---

## 4. Phase 2+ 功能泄漏检查 — ✅ 无泄漏

检查范围：业务代码 `server/src/` 与 `web/src/`（+ `web/app/` 路由页）。按计划 Phase 2 功能（任务状态机、群聊落库、Agent 集成、Worker 集成、git 凭证、产出物归档）**不得在业务代码实现**；schema 表定义允许存在。

| 功能 | 检查结论 | 证据 |
|------|---------|------|
| 任务状态机 | 无实现。server 无 tasks controller（全部端点仅 auth/users/projects/health/events）；web `/board` 仅静态 seed 数据渲染，代码注释明示"状态迁移逻辑 Phase 2" | server `@Controller` 仅 6 个；`web/app/(main)/board/page.tsx`（378 行，无 API 调用） |
| 群聊落库 | 无实现。`chat.message.new` 仅出现于 realtime 模块注释与 spec 测试（事件名占位），无落库业务；`/messages` 为 EmptyState 占位页；chat-bubble/message-input 为纯 UI 展示组件 | `server/src/realtime/realtime.service.ts:24` 注释"Phase 2 落地 chat.message.new 等"；`realtime.service.spec.ts` 仅事件名断言 |
| Agent 集成 | 无实现。`/agents` 占位页（EmptyState，注释"Task 13 实现"）；agent-avatar/agent-badge 纯 UI（自 docs 原型迁移） | `web/app/(main)/agents/page.tsx`（13 行） |
| Worker 集成 | 无实现。`/workers` 占位页 | `web/app/(main)/workers/page.tsx`（13 行） |
| git 凭证 | 无实现。server/web src 均无 credential/git 凭证代码；仅 docs 设计文档 `.omo/evidence/git-credential-mechanism.md` | grep `credential|git.*token` 业务目录零命中 |
| 产出物归档 | 无实现。`artifact.submitted` 仅 realtime spec 测试事件名；`archived` 仅为项目状态筛选 enum（M1 已有范围），非归档业务 | `query-projects.dto.ts:26-30`；`realtime.service.spec.ts:46` |

补充确认：
- **schema 表定义存在但无业务实现**（按计划允许）：`prisma/schema.prisma` 含 Task/TaskAgent/TaskEvent/ChatChannel/Message/Artifact/Agent/Worker/TaskGroupInstance 等表，均无对应 controller/service 业务代码。
- **前端零业务 API 调用**：`web/src/` grep `fetch|axios|/api/v1|apiClient` 零命中，全部页面为静态渲染 + UI 组件（M1 联调走 browser→dev-server 代理，非前端代码内 API 层）。
- server 全部 HTTP 端点仅 11 个，全部落在 M0/M1 范围（auth×4 / users×3 / projects×2 / health×1 / events×1）。

---

## 5. 结论

- ✅ server 单测 39/39、server build 退出码 0、web build 退出码 0
- ✅ M0 证据：脚手架（task-1-init.md）、健康检查（task-3-health.md）
- ✅ M1 证据：登录联调（task-15-auth-curl.md / task-20-m1-flow.md）、原型一致（proto-parity/）
- ✅ 无 Phase 2+ 功能泄漏：任务状态机/群聊落库/Agent/Worker/git 凭证/产出物归档均仅存在于 docs 与 schema 表定义，业务代码无实现

**M0/M1 验收达成，可进入 Phase 2。**
