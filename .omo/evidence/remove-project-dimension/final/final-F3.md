# F3 真实 QA 通关报告（fresh stack, scratch DB）

- 日期：2026-09-07；执行：Sisyphus-Junior；计划：`.omo/plans/remove-project-dimension.md` Final wave F3
- 结论：**APPROVE**（附 2 条显式 gap，均不阻塞：无 live worker 的 MCP 路径以 service-level + 既有 T7 证据覆盖；session 页 plans-404 控制台噪音为预先存在的 by-design 行为）

## 栈（全部新建、当前树、隔离库）

| 项 | 值 |
|---|---|
| DB | scratch 容器 `f3-scratch-mysql`（mysql:8，宿主 `127.0.0.1:13306`，库 `f3scratch`），迁移后删除 |
| 迁移 | `npx prisma migrate deploy` 全量通过，含 `20260907000000_drop_project_dimension`；现场验证：无 `projects/project_members` 表，`tasks/memories/realtime_events` 无 project 列，`memories.team_id` 存在 |
| Seed | `npm run seed` 通过：示例团队 `tm_0000000001`（5 实例）+ 用户 admin/seed-admin/seed-member |
| Server | `npm run build`（当前树）+ `npx prisma generate`（关键：旧 client 曾导致 `POST /tasks` 500，见问题记录）→ `node server/dist/src/main.js`，`http://localhost:13100/api/v1`，health 200 |
| Web | `next dev -p 13101`，`API_PROXY_TARGET=http://localhost:13100` |
| 触碰共享 dev DB | 否（`aiagents-compose-db` 未动；T9 旧备份未使用因为根本没碰共享库） |

## 步骤与证据（每步：命令 / 截图 / 结果）

1. 登录（API）：`POST /api/v1/auth/login` admin/admin123 → 200（token 221 字符）；seed-admin → 200。截图 `f3-01-login.png`（登录页渲染正常）。
2. `/teams`（API+UI）：`GET /teams` → 200，`tm_0000000001` 5 成员。登录后前端自动跳转 `/teams`。截图 `f3-02-teams.png`（团队卡：vteam开发团队，5 成员 0 排队）。
3. 建任务：`POST /tasks {title, teamId: tm_0000000001, priority: high}` → **201**，`t_0000000001/pending`（`f3-api.log`）。失败路径：admin（非团队成员）建任务 → **403 PERMISSION_TEAM_NOT_MEMBER**（团队门按预期工作）。
4. 看板：`GET /tasks?teamId=` → 200，列出任务；`GET /tasks`（无 teamId）→ 200 全可见团队分页。UI 经 `/tasks/new?teamId=` 建第二个任务 `F3 UI创建任务`（t_0000000002/pending）→ 跳转团队会话页。截图 `f3-03-board.png`（2 任务卡：待开始/已完成，均标注团队无项目概念）、`f3-06-session-after-create.png`。
5. 团队会话群聊：`GET /channels?teamId=` → 200，`c_0000000001/team_group`。UI `/teams/tm_0000000001/session` 渲染群聊 tab + 5 私聊 + 5 成员 + 任务面板。截图 `f3-04-session.png`。
6. 记忆 team 写+读：写经真实 `PlatformMcpService.memorySaveForTeam`（service-level，ts-node 直调，scratch 脚本用后即删）→ `{memoryId: me_0000009001, level: team}`；`level=project` → 拒绝 `PLATFORM_MCP_MEMORY_INVALID`。读经 live `GET /memories?level=team&teamId=`（admin）→ 200，total=1。UI `/memories` 过滤器为 任务/团队/全局（无“项目”），列出该记忆。截图 `f3-05-memories.png`。
7. 任务 start/accept：`PATCH /tasks/:id {mainAgentInstanceId: ta_0000000003}` → 200；`POST start` → 201 in_progress；`POST mark-pending-review` → 201 pending_review；`POST accept` → 201 **completed**。失败路径：未设主 Agent 时 start → 400 MAIN_AGENT_NOT_SET；用团队外实例 id（tmm_…）设主 Agent → 400 MAIN_AGENT_NOT_IN_TEAM（任务快照实例 ta_… 才是合法域）。
8. `GET /api/v1/projects` → **404** `Cannot GET /api/v1/projects`（live proof，`f3-api.log` 尾部复验）。Web `/projects` → Next 404 页。截图 `f3-08-web-projects-404.png`。

## 控制台检查（0 JS 异常）

- login / teams / board / memories：error 级 0 条。
- session 页：2 条 error，均为 `GET /api/v1/plans?taskId=… → 404`（任务无计划时后端 by-design 404，前端 `retry:false` 优雅处理；属预先存在行为，与本次拆除无关）。

## 显式 gap（未伪造）

- G1 live worker 缺席：MCP `task_create` 未走 live worker 实跑。覆盖：① T7 既有证据 `t7-happy.log`；② 本次 `POST /tasks`（`createByAgent` 的 REST 等价入口）201 + 完整状态机流转。MCP 记忆写以 service-level 直调覆盖（见步骤 6）。
- G2 `npx prisma generate` 必须在 build 后重跑（client 为生成产物）；F3 中首次遗漏导致 500，已修复并记录（见问题记录）。

## 对抗自查

- stale_state：fresh DB + seed，无残留（建任务前 total=0，经 board/API 确认）。
- dirty_worktree：QA 期零产品代码编辑（仅 infra：容器/ env / 临时 ts-node 脚本且已删；截图移出仓库根到证据目录）。`git status` 产品文件集合 QA 前后一致（137 改动均为计划内 T1–T12 实现，非本次改动）。
- misleading_success_output：全部 7 张截图逐张目检（曾发现 2 张空白/错页并重拍，作废 1 张重复）。

## 清理收据

- `f3-scratch-mysql` 容器已 `rm -f`（连 volume，数据无残留）；server（:13100）/ web（:13101）进程已 kill，端口释放已验证。
- 共享 dev 栈（aiagents-compose-*）未重启、未触碰。
- 证据目录：`.omo/evidence/remove-project-dimension/final/`（7 png + f3-api.log + f3-server.log + f3-web.log + 本文件）。

## VERDICT：APPROVE
