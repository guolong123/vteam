# Task 17 — ProjectsModule 基础（列表/创建）+ 单测

## 目标
按 09 篇 §3.3 实现 ProjectsModule：`GET /api/v1/projects`（调用者所属项目，FR-25，分页）、`POST /api/v1/projects`（创建，创建者为 owner）。`project_members` 落库（owner 记录）。权限：成员仅见已加入项目。单测：列表（成员可见性）、创建（owner 写入）。seed 项目供前端验收。

## 交付文件

| 文件 | 说明 |
|------|------|
| `server/src/projects/projects.module.ts` | 项目模块（controller + service） |
| `server/src/projects/projects.controller.ts` | `GET /projects`、`POST /projects` 端点 |
| `server/src/projects/projects.service.ts` | 列表（成员可见性 + 分页）、创建（owner_id + project_members owner 记录） |
| `server/src/projects/current-user.decorator.ts` | `@CurrentUser()` 参数装饰器 |
| `server/src/projects/placeholder-auth.guard.ts` | 占位守卫：从 `x-user-id` header 取当前用户（Task 15 Auth 未就绪前临时方案） |
| `server/src/projects/dto/create-project.dto.ts` | `POST` 请求体（name 必填 / description 可选） |
| `server/src/projects/dto/query-projects.dto.ts` | `GET` 分页/状态筛选参数 |
| `server/src/projects/projects.service.spec.ts` | 单测：列表可见性 + 创建 owner 写入 |
| `server/prisma/seed.ts` | seed：roles(admin/member) + seed-admin/seed-member 用户 + 2 项目（owner=seed-admin） |
| `server/package.json` | 新增 `"seed": "ts-node prisma/seed.ts"` |

## 实现要点
- **列表（成员可见性）**：`GET /projects` 通过 `project_members` 关联查询该用户已加入的项目（owner 也是 member，天然包含），未加入项目不可见；分页 `page/pageSize`（对齐 09 篇 §2，page 1 起、pageSize 默认 20、上限 100）。
- **创建（owner 落库）**：`POST /projects` 同一事务内写 `projects`（owner_id=创建者，status=active）+ `project_members`（role=owner）。
- **权限占位**：AuthModule（Task 15）并行未完成，本模块用 `PlaceholderAuthGuard` 从 `x-user-id` header 取当前用户，缺省抛 401；JWT 就绪后仅需替换守卫来源。

## 验证结果

### 1) 单测 `npm run test`
```
PASS src/projects/projects.service.spec.ts
  ProjectsService
    findAll（成员可见性）
      ✓ 仅返回调用者已加入的项目（经 project_members 关联）
      ✓ 未加入项目的用户看不到任何项目（成员可见性）
    create（owner 写入）
      ✓ 创建项目并写入 project_members owner 记录
      ✓ 名称为空时抛 BadRequestException

Test Suites: 5 passed, 5 total
Tests:       27 passed, 27 total
```
退出码 0。

### 2) 端点验证（独立 Nest 应用 + supertest，ProjectsModule + PrismaModule，DATABASE_URL=dev.db）
```
GET  /projects  as admin(u_seed_admin)   status: 200 total: 2   # seed 2 项目可见
GET  /projects  as member(u_seed_member) status: 200 total: 0   # 未加入 → 不可见（成员可见性）
GET  /projects  无 x-user-id header      status: 401            # 占位守卫拦截
POST /projects  as member                 status: 201 ownerId: u_seed_member status: active  # 创建者=owner
GET  /projects  as member 创建后          total: 1              # 创建后成为成员可见
GET  /projects?page=1&pageSize=1 as admin items: 1 total: 2     # 分页生效
```
验证后已清理临时创建的项目，dev.db 保持 seed 确定性（2 项目 / 2 owner 成员记录）。

### 3) seed
```
$ npm run seed
Seed 完成：
  - 角色：admin / member
  - 用户：seed-admin(u_seed_admin) / seed-member(u_seed_member)
  - 项目：AI 智能体平台、文档协作平台（owner=seed-admin）
  - 管理员密码：Admin@123456
```

## 说明
- 完整 `nest build` 当前被**并行 Task 15（AuthModule）**的 `auth.service.ts` 类型错误阻塞（`expiresIn` 类型不匹配，非本模块文件）。本模块已通过「独立 Nest 应用 + supertest」完成端点级验证，与 AppModule 解耦；Auth 修复后整包可正常 build。
- 未实现项目内任务/成员管理完整流程、归档逻辑（Phase 2），`status` 字段保留默认。
- 未修改 `web/`。