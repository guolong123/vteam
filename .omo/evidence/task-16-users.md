# Task 16 — UsersModule 基础 + 单测

## 目标

按 09 篇 §3.2（FR-22 用户管理）实现 UsersModule 基础能力：分页列表、详情、禁用/启用，并配套单测。

## 交付物

| 文件 | 说明 |
|------|------|
| `server/src/prisma/prisma.service.ts` | Prisma 数据访问（全局唯一实例，测试走 sqlite 测试库） |
| `server/src/prisma/prisma.module.ts` | 全局 PrismaModule（@Global，导出 PrismaService） |
| `server/src/users/users.service.ts` | 业务逻辑：`findAll`（分页）/ `findOne`（详情）/ `updateStatus`（禁用启用） |
| `server/src/users/users.controller.ts` | 端点：`GET /users`、`GET /users/:id`、`PATCH /users/:id/status` |
| `server/src/users/users.module.ts` | 装配 UsersController + UsersService |
| `server/src/users/admin.guard.ts` | `[admin]` 守卫（Phase 1 占位放行，待 Task 15/Phase 3 接入 JWT+角色矩阵） |
| `server/src/users/dto/update-user-status.dto.ts` | `{ enabled: boolean }` 请求体校验 |
| `server/src/users/users.service.spec.ts` | 单测：列表分页 / 详情 / 禁用后状态 |
| `server/src/app.module.ts` | 导入 PrismaModule |

## 端点契约（09 篇 §3.2）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/users` | 分页列表（page/pageSize 默认 1/20，上限 100；search 模糊匹配 username/displayName；**不含 password_hash**） |
| GET | `/api/v1/users/:id` | 用户详情（不含 password_hash），不存在 404 |
| PATCH | `/api/v1/users/:id/status` | body `{enabled: boolean}` 禁用/启用（FR-22）；不存在 404 |

## 关键设计

- **密码安全**：列表/详情 select 明确排除 `passwordHash`，契约保证响应不含密码。
- **分页对齐**（09 篇 §2.2）：`page`≥1，`pageSize` 收敛到 `[1,100]`，响应 `{items,total,page,pageSize}`，按 `createdAt desc` 排序。
- **禁用不删除**（FR-22）：`updateStatus` 仅更新 `enabled` 标记，不触碰删除路径。
- **admin 守卫（Phase 1 占位）**：schema 无 `is_admin` 字段（用户通过 `roleId→Role.name` 判定角色），AuthModule（Task 15）并行开发中，故守卫先放行以保证端点可 curl 验证；注释明确后续接入 JWT+角色权限矩阵。
- **Prisma 全局模块**：Users 注入 PrismaService，测试时经 `test/setup-env.js` 指向 sqlite 测试库。

## 验证结果

### 单测 `cd server && npm run test`

Users 套件全部通过：

```
PASS src/users/users.service.spec.ts
  UsersService
    findAll（列表分页）
      ✓ 返回 {items,total,page,pageSize}，且 items 不含 passwordHash
      ✓ pageSize 上限收敛到 100（09 篇 §2.2）
      ✓ search 命中 username/displayName 模糊匹配
    findOne（详情）
      ✓ 返回用户详情（不含 passwordHash）
      ✓ 用户不存在抛 404
    updateStatus（禁用/启用，FR-22）
      ✓ 禁用后 enabled=false，账号数据不删除
      ✓ 目标用户不存在抛 404
```

注：`realtime.controller.spec.ts` 为并行任务（SSE 模块）的既有失败，与 UsersModule 无关（未触碰该模块）。

### 运行验证（curl，`start:prod` 等价用 ts-node 启动）

前置：`npx ts-node prisma/seed.ts` 写入 seed-admin / seed-member；`POST /api/v1/auth/login` 获取 Bearer token（全局 JWT 守卫来自 Task 15）。

```
# 1. 列表（分页，不含 passwordHash）
GET /api/v1/users            → page:1 pageSize:20 total:3; items 无 passwordHash
GET /api/v1/users?page=1&pageSize=2 → page:1 pageSize:2 returned:2 total:3
GET /api/v1/users?search=seed       → total:2 [seed-member, seed-admin]
无 token 时                    → HTTP 401（全局 JWT 守卫生效）

# 2. 详情
GET /api/v1/users/u_seed_member → {id, username:seed-member, enabled:true}; 无 passwordHash 字段

# 3. 禁用/启用（FR-22）
PATCH /api/v1/users/u_seed_member/status {enabled:false} → enabled:false
POST /api/v1/auth/login seed-member → HTTP 401（禁用后登录被拒，FR-22）
PATCH /api/v1/users/u_seed_member/status {enabled:true}  → re-enabled:true
```

FR-22 「禁用后登录返回 401」在 AuthModule（Task 15）login 链路已实现（`if (!user.enabled) throw UnauthorizedException(DISABLED)`），本任务验证通过。

## 边界与后续

- 新增/编辑/重置密码/角色管理（POST/PATCH /users、reset-password）属 Phase 3，本任务未实现。
- 用户删除不实现（FR-22 禁用不删除）。
- `web/` 未改动。
- admin 守卫为 Phase 1 占位，待 AuthModule 与 Phase 3 角色权限矩阵落地后替换为真实 `[admin]` 校验。