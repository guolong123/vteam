# vteam — 虚拟团队 AI 协作平台 / Virtual Team Collaboration Platform

Virtual team collaboration platform for AI agents — assemble role-based agent teams (PM, architect, developer, tester) per task; collaborate via group chat, issues, and artifact workflows.

vteam 是任务驱动的多 Agent 虚拟团队协作平台。用户先创建**全局团队**（一团队一群，成员多实例），再为任务**指派团队**（`teamId` 必填），各角色实例通过群聊、私聊、Issue 与产出物工作流协作交付；同团队多任务串行 FIFO 排队，群聊与会话可按团队复用。

## 功能特性

### 任务驱动

- 任务全生命周期：创建任务（指派全局团队 `teamId`）→ 排队/启动（`queued`/`pending` → 进行中）→ 验收 → 归档（状态机：排队中 / 进行中 / 待验收 / 已完成 / 已归档，队首自动晋升）
- 全局团队与串行排队：一团队一群（`team_group`），同团队多任务 FIFO 串行（`current_task_id` 指队首，`team_queues` 按 `position` 排队，支持取消排队 `DELETE /teams/:id/queue/:taskId`）
- 角色多实例：同一模板 Agent 可在团队内创建多个实例（如开发者-1、开发者-2），各实例独立会话、私聊、被 @ 与 issue 指派；实例在团队侧管理，任务侧为快照
- 主 Agent 动态化：主 Agent 由用户选择（默认产品经理，须在团队内），职责在运行时动态注入；群聊中无 @ 的消息自动路由给主 Agent
- 记忆开关：团队 `reuseSession`（默认 true 跨任务复用）与任务 `resetAfterComplete`（覆盖开关，下任务开新会话）控制会话复用

### 角色化 Agent

- 5 个模板角色：产品经理（product）、项目经理（project_manager）、架构师（architect）、开发者（developer）、测试（tester），每个角色有独立身份与四方向提示词（职责 / 权限 / 工作方式 / 协同方式）
- Agent 管理：模板、自定义、克隆，type=template 只读、权限范围最小化
- 模型管理：模型目录维护，Worker 上报可用模型，创建/克隆 Agent 时绑定模型

### 协作方式

 - 团队常驻会话：`/teams/:id/session` 按 `teamId` 复用群聊（`team_group` 单例，切任务不切群），看板/列表/团队详情的“进入会话”统一指向该路由，旧 `/tasks/:id` 群聊入口隐藏或 302 跳至团队会话；状态 Tab 改为任务列表（当前执行队首 `team.currentTaskId` + 等待队列 FIFO 可取消）
- 群聊：一团队一群（`team_group` 复用，消息按 `taskId` 分区过滤 + 系统分隔），@ 触发、@all 广播、Agent 互 @（`notify_agent`）、SSE 流式输出（两阶段 loading），历史跨任务可见，按 `team:` + `channel:` 订阅
- 私聊：按 `team_member_id` 复用（`teamId + teamMemberId` 维度幂等），与群聊并行，历史可跨任务保留（`reuseSession` 时）
- 队列视图：团队详情队列预览与状态 Tab 任务列表 `TeamQueueCard`（FIFO 徽章、当前位置、取消排队，仅 `queued` 可取消）
- Issue 管理：需求 / 缺陷 issue 创建指派，状态流转（start → resolve → close），支持标签
- 产出物管理：Agent 通过 MCP `submit_artifact` 提交产出物，沉淀为文档库，验收时版本基线锁定

### 平台能力

- 平台 MCP Server（`vteam`）：提供 `task_context`、`chat_history`、`doclib`、`group_post`、`notify_agent`、`issue_*`、`submit_artifact` 等工具，Agent 在会话内经 MCP 协议调用
- Worker 节点：集成 opencode 执行引擎，负责会话创建、执行、事件回流、首字超时、空闲判死，并注入模型凭据
- 权限矩阵（RBAC）：admin / member 角色 + 项目成员管理
- 实时事件：SSE 通道推送消息、事件与状态变更

## 架构

三端 + 外部执行引擎：

```
                    ┌──────────────────────────────────────────────┐
                    │                 web (Next.js)                │
                    │  任务/看板 · 群聊/私聊 · Issue · Agent/模型   │
                    └─────────────────────┬────────────────────────┘
                                          │ HTTP /api/v1 + SSE
                    ┌─────────────────────▼────────────────────────┐
                    │          server (NestJS + Prisma)            │
                    │  chat · tasks · issues · agents · workers    │
                    │  artifacts · models · tools · platform-mcp   │
                    │              MCP Server (vteam)      │
                    └───────┬───────────────────────┬──────────────┘
                            │                       │ 注册/心跳/事件回流
                   ┌────────▼────────┐     ┌────────▼──────────────┐
                   │   MySQL (Prisma)│     │   worker (Node)       │
                   └─────────────────┘     │  opencode 会话执行     │
                                           │  凭证注入 · MCP 客户端 │
                                           └────────┬──────────────┘
                                                    │ spawn 子进程
                                           ┌────────▼──────────────┐
                                           │   opencode serve      │
                                           │  (外部执行引擎)        │
                                           └───────────────────────┘
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS（server），全局路由前缀 `/api/v1`，Swagger 挂载于 `/api/v1/docs` |
| 前端 | Next.js App Router（web），页面基于 `app/(main)/` 分组 |
| 执行节点 | Node worker，集成 opencode CLI（spawn 子进程 + REST 代理） |
| 数据层 | Prisma ORM + MySQL 8，迁移文件位于 `server/prisma/migrations` |
| 实时 | SSE（消息流式输出、事件推送），两阶段 loading 提示 |
| Agent 工具 | MCP 协议（`vteam` MCP Server + worker 端 MCP 客户端） |
| 部署 | Docker Compose（db / init / server / web / worker 五服务） |

## 快速开始

依赖 Docker（Compose v2）。在仓库根目录执行：

```bash
docker compose up -d --build
```

首次启动时 `init` 容器自动执行 `prisma migrate deploy` 与 seed（迁移基线 + 种子数据），成功后才拉起 server。

### 端口

| 服务 | 容器内 | 宿主机 |
|------|--------|--------|
| server | 3000 | 13000 |
| web | 3000 | 13001 |
| db（MySQL 8） | 3306 | 不映射（compose 网络内互通） |
| worker | - | 不暴露（由 server 通过 compose 网络访问） |

- Web 控制台：http://localhost:13001
- 后端 API：http://localhost:13000/api/v1
- Swagger：http://localhost:13000/api/v1/docs

### 预置账号

| 账号 | 密码 | 角色 |
|------|------|------|
| admin | admin123 | 初始管理员 |
| seed-admin | Admin@123456 | 种子管理员（项目 owner） |
| seed-member | Admin@123456 | 普通成员 |

### 种子数据

- 5 个模板 Agent：产品经理 / 项目经理 / 架构师 / 开发者 / 测试
- 2 个种子项目：`p_seed_1`（AI 智能体平台）、`p_seed_2`（文档协作平台）
- 内置工具 + `vteam` MCP 工具注册、模型目录

### 本地开发

各端独立开发（不经 Docker）：

- `server/`：`npm install && npm run start:dev`（默认 3000，需配置 `.env` 指向本地 MySQL，参考 `server/.env.example`）
- `web/`：`npm install && npm run dev`（默认 3001，代理到 server）
- `worker/`：`npm install && npm run dev`（需 `X_WORKER_TOKEN` 等环境变量，参考 `worker/.env.example`）

## 目录结构

```
.
├── web/        # 前端（Next.js App Router）
├── server/     # 后端（NestJS + Prisma + migrations）
├── worker/     # opencode 执行节点（独立 Node 进程）
├── docs/       # 设计文档（agent-platform/ 20+ 篇）+ 测试用例/报告
├── docker-compose.yml  # 一键部署编排
├── scripts/    # 辅助脚本
└── .omo/       # 内部计划 / 验证证据目录
```

## 迁移（Breaking）

团队重构为 **expand-contract** 迁移：新增 `teams`/`team_members`/`team_queues` 3 表，`tasks.team_id` 改必填（`teamId!`），`chat_channels(team_id, team_member_id)` 一团队一群（`task_group` 已废弃 400），`messages.task_id` 分区，任务六态新增 `queued` FIFO 排队。**回滚为重建库**：`docker compose down -v && docker compose up -d --build`（或 `npx prisma migrate reset` + `npm run seed`）。详见 [15-数据模型 §8](docs/agent-platform/15-数据模型细化（ER图）.md#8-团队重构-breaking-变更与迁移) 与 [28-团队模型与排队设计 §6](docs/agent-platform/28-团队模型与排队设计.md#6-迁移与回滚)。

## 文档

设计与实现细节见 `docs/agent-platform/`（20+ 篇设计文档），推荐从以下开始：

- [08-平台架构设计](docs/agent-platform/08-平台架构设计.md)：三端架构与模块划分
- [13-任务状态机与全生命周期](docs/agent-platform/13-任务状态机与全生命周期.md)：任务状态流转
- [14-Agent配置与虚拟团队模型](docs/agent-platform/14-Agent配置与虚拟团队模型.md)：全局团队与实例模型
- [28-团队模型与排队设计](docs/agent-platform/28-团队模型与排队设计.md)：全局团队、FIFO 排队与复用
- [15-数据模型细化（ER图）](docs/agent-platform/15-数据模型细化（ER图）.md)：Team/TeamMember/TeamQueue ER 与迁移
- [16-内置Agent角色与提示词库](docs/agent-platform/16-内置Agent角色与提示词库.md)：五类角色身份与四方向提示词
- [21-平台MCP-Server设计方案](docs/agent-platform/21-平台MCP-Server设计方案.md)：vteam MCP 工具设计

## License

MIT（待定，尚未正式确定许可证，确定后会更新此段）。
