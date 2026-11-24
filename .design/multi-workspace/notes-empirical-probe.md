# 多用户场景 · 实证探测记录（2026-11-12）

> 由 Lead 在运行中的服务（`http://127.0.0.1:13000/api/v1`，docker compose 五服务全部 healthy）
> 上实际执行，非静态代码推测。探测用账号与团队均已清理，DB 恢复为探测前 3 个用户 / 1 个团队。

## 探测方法

1. `POST /auth/register` 创建两个普通成员账号 `wsuserA` / `wsuserB`（默认 `roleId=r_member`，权限矩阵完整版）。
2. 分别登录取 `accessToken`（JWT payload：`{sub, username, roleId, type}` —— **不含 workspaceId/tenantId**）。
3. 用两个 token 分别请求同一批列表接口，比对返回集合。
4. A 创建一个私有团队，验证 B 的可见性与写权限。

## 结果 1：两个用户看到完全相同的全局数据

| 接口 | wsuserA | wsuserB | 是否隔离 |
|---|---|---|---|
| `GET /teams` | 1 条（`tm_0000000001` vteam开发团队） | 1 条（同一条） | ❌ |
| `GET /tasks` | 0 条 | 0 条 | ❌（口径相同） |
| `GET /models` | total=44 | total=44 | ❌ |
| `GET /workers` | 1 个节点 | 1 个节点 | ❌ |
| `GET /members` | total=280 | total=280 | ❌ |
| `GET /agents` | total=7 | total=7 | ❌ |
| `GET /skills` | total=8 | total=8 | ❌ |
| `GET /mcp-servers` | total=2 | total=2 | ❌ |
| `GET /git-repos` | 3 个 | 3 个 | ❌ |
| `GET /users` | 403 FORBIDDEN_ADMIN | 403 | ✅ 仅 admin 可管用户（但这是「功能权限」而非「数据归属」） |

两个刚注册、从未加入任何团队的用户，`GET /teams` 均能读到 `createdBy=u_seed_admin` 的团队详情
（含 `members[]`、`currentWorkerId`、`workDir`、`defaultModelId` 等内部信息）——说明列表/详情接口
**没有任何「按用户归属/团队成员过滤」**。

> 注：`server/src/common/guards/team-membership.guard.ts` 存在且能通过 `teamUserMembers` 校验
> 「您不是该团队成员」，但 `TeamsController` 只挂了 `PermissionGuard`（见
> `server/src/teams/teams.controller.ts:24` `@UseGuards(PermissionGuard)`），**未挂 TeamMembershipGuard**，
> 因此团队成员门禁在该路由上未生效。`GET /teams` 的 `findAll(query)` 甚至不接收 `@CurrentUser()`。

## 结果 2：跨用户越权写确认（最严重）

```
A: POST /teams {name:"WsA-Private-Team"}          -> tm_0000000005 (createdBy=A)
B: GET  /teams                                    -> total=2，能看到 "WsA-Private-Team"
B: GET  /teams/tm_0000000005                      -> 200，完整详情
B: PATCH /teams/tm_0000000005 {name:"HackedByB"} -> 200，改名成功 ✅ 越权写
B: DELETE /teams/tm_0000000005                    -> 403（被 `teams.delete` 权限点拦住，非归属拦截）
```

`PATCH /teams/:id` 的处理链是
`teams.controller.ts:57-60 update(id, dto)` → `teams.service.update(id, dto)`，
**既不接收 `user.id`，也不校验 `createdBy`/团队成员关系**。member 角色拥有 `teams.edit=true`，
于是任何登录用户可改任何团队。DELETE 之所以 403，仅因 member 角色的 `teams.delete=false`——
这是「功能权限」，不是「数据归属」：换成任一有 delete 权限的账号（或同空间的另一用户）即可删别人团队。

## 结果 3：唯一性约束是全局的

`Team.name @unique`（`schema.prisma:88`）、`Member.name @unique`（`schema.prisma:261`）、
`User.username/email @unique`、`Role.name @unique`、`ExternalUser.externalId @unique`、
`Model`/`Skill`/`Agent`/`McpServer`/`GitRepo` 等均无空间维度。
后果：A 想建一个叫「开发团队」的团队，B 先建了同名团队，A 直接 409；反之 A 的存在会泄露给 B（枚举）。

## 结果 4：现有「成员感知过滤」仅存在于个别 service

`server/src/users/admin-permission.ts` 注释里提到「service 需要在无守卫的成员感知端点上复用同一口径
（例如 memories 的非 admin 过滤）」，说明系统里**已经有按用户过滤的零散实现**（memories 等），
但没有统一的、覆盖全部资源的隔离层。这正是后续改造要收敛的对象。

## 结论

当前系统是一个**单租户（single-tenant）应用 + 双层 RBAC（admin/member）**：
- 认证：JWT 只带 `userId/username/roleId`，无 workspace 维度；
- 授权：`PermissionGuard` 判定「能不能做这个动作」（功能权限），不判定「能不能碰这条数据」（数据归属）；
- 数据：53 张表无 `workspaceId`，所有业务表全局共享，唯一键全局；
- 运行时：worker / 模型目录 / 凭据 / 会话 / 文件上传 / SSE 均为单实例全局共享（详见各方向报告）。

因此「多用户各拥有隔离工作空间」在**数据模型、鉴权、API、运行时、前端、测试**六层全部缺失，
不是补几个 if 就能解决的，需要一次有计划的租户化改造。

## 清理确认

- 测试团队 `tm_0000000005` 已由 admin `DELETE /teams/:id` 删除（返回 `{"deleted":true}`），团队列表恢复 total=1。
- 测试账号 `wsuserA`/`wsuserB` 已由 `docker exec ... mysql` 直接删除（`/auth/register` 无对应删除接口，
  `UsersController` 也没有 DELETE 方法）；`SELECT id,username,role_id FROM users` 仅剩
  `u_admin / u_seed_admin / u_seed_member`，与探测前一致。
- 未修改任何源码文件；未执行任何迁移。
