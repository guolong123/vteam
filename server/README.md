# server — vteam 后端服务

vteam 的后端，基于 NestJS。提供任务、群聊/私聊、Issue、Agent/模型/Worker 管理、产出物与平台 MCP Server 等全部业务 API。

- 全局路由前缀：`/api/v1`
- Swagger 文档：`/api/v1/docs`
- 数据层：Prisma ORM + MySQL

## 模块概览

`src/` 下按业务模块组织：

| 模块 | 职责 |
|------|------|
| `teams/` | 全局团队（Team/TeamMember/TeamQueue）、FIFO 串行排队、记忆开关与批量重置 |
| `chat/` | 群聊（一团队一群 `team_group`，消息按 `taskId` 分区）/ 私聊（`team_member_id` 复用）、SSE 流式输出、worker 事件分发、消息路由与隔离 |
| `tasks/` | 任务生命周期（`queued`/`pending`/进行中/待验收/已完成/已归档，队首晋升）、任务归属团队（`teamId` 必填）与实例快照 |
| `issues/` | 需求 / 缺陷 issue 创建指派、状态流转 |
| `agents/` | Agent 模板 / 自定义 / 克隆、角色实例、四方向提示词管理 |
| `workers/` | Worker 节点注册、心跳、事件上送接入（`worker-event.ingress`）、会话生命周期 |
| `models/` | 模型目录与模型可用性 |
| `tools/` | 内置工具 + MCP 工具注册、技能管理 |
| `artifacts/` | 产出物提交与文档库、版本基线锁定 |
| `platform-mcp/` | 平台 MCP Server（`vteam`）：`task_context` / `chat_history` / `doclib` / `group_post` / `notify_agent` / `issue_*` / `submit_artifact` |
| `auth/` | 登录认证与 JWT |
| `users/` `projects/` `roles/` | 用户、项目、权限矩阵（RBAC） |
| `realtime/` | SSE 实时事件通道 |
| `git-repos/` | 仓库与凭证管理 |
| `health/` | 健康检查（`/api/v1/health`） |

## 本地开发

前置：Node.js >= 18、MySQL 8。

```bash
cd server
npm install
cp .env.example .env   # 按需修改 DATABASE_URL 等
npm run start:dev      # 开发模式（热重载），默认端口 3000
```

生产构建：

```bash
npm run build          # 编译到 dist/
npm run start:prod     # node dist/main
```

## Prisma / 数据库

迁移与种子数据由 Prisma 管理，迁移文件位于 `prisma/migrations/`：

```bash
npx prisma migrate deploy   # 应用迁移
npm run seed                # 执行种子数据（等价 npx ts-node prisma/seed.ts）
```

种子数据包括：admin / member 角色（含 `teams` 域权限）、admin / seed-admin / seed-member 三个用户、两个种子项目（p_seed_1 / p_seed_2）、5 个模板角色 Agent、全局示例团队 `tm_0000000001`（5 角色各 1 实例）、内置工具与 `vteam` MCP 工具、模型目录。

### 团队重构迁移（Breaking）

新增 `teams`/`team_members`/`team_queues` 3 表，`tasks.team_id` 必填，`chat_channels` 一团队一群（`team_group`，`task_group` 已废弃 400），`messages.task_id` 分区，任务六态 `queued` FIFO 排队（`team_queues` + `teams.current_task_id`/`version` CAS）。回滚：`npx prisma migrate reset` 或 `docker compose down -v && up -d --build` 重建卷后 `migrate deploy` + `seed`（历史随卷丢失，生产先 `mysqldump` 备份）。详见 [15 篇 §8](../../docs/agent-platform/15-数据模型细化（ER图）.md) 与 [28 篇](../../docs/agent-platform/28-团队模型与排队设计.md)。

## 测试

```bash
npm run test          # 单元测试（jest --runInBand）
npm run test:e2e      # e2e 测试（jest --config ./test/jest-e2e.json）
npm run test:cov      # 覆盖率
npm run lint          # ESLint（--fix）
```

## 环境变量

参考 `server/.env.example`，核心变量：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | MySQL 连接串（Prisma 格式） |
| `PORT` | 服务端口（默认 3000） |
| `JWT_SECRET` / `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | 登录签发与校验（access 短时效 + refresh 长时效） |
| `WORKER_TOKEN` | Worker 注册 / 事件上报鉴权 token（与 worker 端 `X_WORKER_TOKEN` 对齐） |
| `MODEL_CREDENTIAL_KEY` | 模型凭据 AES-256-GCM 加密主密钥（32 字节，生产必改） |
