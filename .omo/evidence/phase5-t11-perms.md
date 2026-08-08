# Phase 5 T11：权限矩阵走查记录

> 时间：2026-08-08 ｜ 环境：`docker compose` 四容器实跑（db/server/web/worker）
> 被测目标：server 容器（宿主映射 `127.0.0.1:13000`）
> 测试账号（seed 数据）：`admin/admin123`（admin 角色，permissions.all=true）、
> `seed-admin/Admin@123456`（admin 角色，p_seed_1/p_seed_2 的 owner+member）、
> `seed-member/Admin@123456`（member 角色，非任何项目成员）

## 结论

三守卫（AdminGuard / ProjectMembershipGuard / WorkerTokenGuard）拦截行为全部符合预期，
权限隔离矩阵走查**无阻断项**。

| # | 守卫 | 用例 | 预期 | 实测 | 结果 |
|---|------|------|------|------|------|
| 1 | AdminGuard | 无 token 访问 `GET /api/v1/users` | 401 | `401 AUTH_UNAUTHORIZED` | ✅ |
| 2 | AdminGuard | member 角色访问 `GET /api/v1/users` | 403 | `403 FORBIDDEN_ADMIN`（需 users:manage） | ✅ |
| 3 | AdminGuard | admin 角色访问 `GET /api/v1/users` | 200 | `200` | ✅ |
| 4 | ProjectMembershipGuard | 无 token 访问 `GET /api/v1/projects/p_seed_1/tasks` | 401 | `401 AUTH_UNAUTHORIZED` | ✅ |
| 5 | ProjectMembershipGuard | 非成员(seed-member)访问项目任务 | 403 | `403 PERMISSION_PROJECT_NOT_MEMBER` | ✅ |
| 6 | ProjectMembershipGuard | owner(seed-admin)访问项目任务 | 200 | `200` | ✅ |
| 7 | ProjectMembershipGuard | admin(非项目成员)访问项目任务 | 403 | `403 PERMISSION_PROJECT_NOT_MEMBER` | ✅ |
| 8 | WorkerTokenGuard | 错误 X-Worker-Token 调 `POST /api/v1/workers/register` | 401 | `401 WORKER_TOKEN_INVALID` | ✅ |
| 9 | WorkerTokenGuard | 正确 X-Worker-Token 调 register | 2xx | `201 {"workerId":"w_compose_worker"}` | ✅ |
| 10 | WorkerTokenGuard | 空 X-Worker-Token 调 register | 401 | `401 WORKER_TOKEN_INVALID` | ✅ |

## 守卫实现与拦截链路（代码依据）

### A. AdminGuard — `server/src/users/admin.guard.ts`（@UseGuards 挂 UsersController 类级）
- 前置：全局 `JwtAuthGuard`（`server/src/auth/guards/jwt-auth.guard.ts`，经 APP_GUARD 注册于
  `auth.module.ts:31`）解析 token 挂 `req.user`；
- 用例 1：无 token → 全局 JwtAuthGuard 先抛 401（AUTH_UNAUTHORIZED）；
- 用例 2：member 角色 `permissions.all=false` 且无 `users.manage` → 403 FORBIDDEN_ADMIN；
- 用例 3：admin 角色 `permissions.all=true` → 放行。

### B. ProjectMembershipGuard — `server/src/common/guards/project-membership.guard.ts`
（@UseGuards 挂 TasksController 类级，`tasks.controller.ts:35`）
- 用例 4：无 token → 401（守卫内防御直抛，代码行 51-56）；
- 用例 5：`project_members` 表无 `(p_seed_1, u_seed_member)` → 403 PERMISSION_PROJECT_NOT_MEMBER；
- 用例 6：`(p_seed_1, u_seed_admin)` 存在（role=owner）→ 放行；
- 用例 7：**admin 虽有平台最高权限，但非 p_seed_1 项目成员 → 仍 403**（项目级权限与平台级
  权限正交隔离，符合 09 篇 §4 权限矩阵设计）。

### C. WorkerTokenGuard — `server/src/workers/worker-token.guard.ts`
（register/heartbeat/events 端点 @Public + @UseGuards(WorkerTokenGuard)）
- 用例 8/10：header 缺失或 sha256(timingSafeEqual) 不匹配 → 401 WORKER_TOKEN_INVALID；
- 用例 9：`X-Worker-Token: compose-worker-token`（compose 环境 `WORKER_TOKEN`）→ 201；
  重注册为 **upsert 语义**（`workers.service.ts:91` register → prisma upsert），
  走查后 `GET /workers` 仍仅 1 条 `w_compose_worker`，无测试数据污染。

## 复现命令

```bash
BASE=http://127.0.0.1:13000
# 登录三账号取 token（见上文种子账号）
curl -s -X POST $BASE/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"seed-member","password":"Admin@123456"}'
# 用例 1/2/3
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/v1/users
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/v1/users -H "Authorization: Bearer $MEMBER_TOKEN"
# 用例 8/9
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/v1/workers/register \
  -H 'X-Worker-Token: wrong-token' -H 'Content-Type: application/json' -d '{"workerId":"w_x","opencodeVersion":"1.0.0","capabilities":{"maxInstances":1,"skills":[],"tools":[]},"load":{"instances":0}}'
```
