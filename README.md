# vteam — 虚拟团队 AI 协作平台 / Virtual Team Collaboration Platform

Virtual team collaboration platform for AI agents — assemble role-based agent teams (PM, architect, developer, tester) per task; collaborate via group chat, issues, and artifact workflows.

vteam 是任务驱动的多 Agent 虚拟团队协作平台。用户创建任务后，为任务组建角色化的虚拟团队（产品经理 / 项目经理 / 架构师 / 开发者 / 测试），各角色 Agent 通过群聊、私聊、Issue 与产出物工作流协作交付。

## 功能特性

### 任务驱动

- 任务全生命周期：创建任务 → 组建虚拟团队 → 启动 → 验收 → 归档（状态机：进行中 / 待验收 / 已完成 / 已归档）
- 角色可多实例：同一角色可添加多个实例（如开发者-1、开发者-2），每个实例拥有独立的会话、私聊、被 @ 与 issue 指派；任务创建后仍可在详情页继续添加实例
- 主 Agent 动态化：主 Agent 由用户选择（默认项目经理），职责在运行时动态注入；群聊中无 @ 的消息自动路由给主 Agent

### 角色化 Agent

- 5 个模板角色：产品经理（product）、项目经理（project_manager）、架构师（architect）、开发者（developer）、测试（tester），每个角色有独立身份与四方向提示词（职责 / 权限 / 工作方式 / 协同方式）
- Agent 管理：模板、自定义、克隆，type=template 只读、权限范围最小化
- 模型管理：模型目录维护，Worker 上报可用模型，创建/克隆 Agent 时绑定模型

### 协作方式

- 群聊：@ 触发、@all 广播、Agent 互 @（`notify_agent`）、SSE 流式输出（两阶段 loading）
- 私聊：按实例独立隔离，与群聊并行
- Issue 管理：需求 / 缺陷 issue 创建指派，状态流转（start → resolve → close），支持标签
- 产出物管理：Agent 通过 MCP `submit_artifact` 提交产出物，沉淀为文档库，验收时版本基线锁定

### 平台能力

- 平台 MCP Server（`keta-platform`）：提供 `task_context`、`chat_history`、`doclib`、`group_post`、`notify_agent`、`issue_*`、`submit_artifact` 等工具，Agent 在会话内经 MCP 协议调用
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
                    │              MCP Server (keta-platform)      │
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
| Agent 工具 | MCP 协议（`keta-platform` MCP Server + worker 端 MCP 客户端） |
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
- 内置工具 + `keta-platform` MCP 工具注册、模型目录

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

## 文档

设计与实现细节见 `docs/agent-platform/`（20+ 篇设计文档），推荐从以下开始：

- [08-平台架构设计](docs/agent-platform/08-平台架构设计.md)：三端架构与模块划分
- [13-任务状态机与全生命周期](docs/agent-platform/13-任务状态机与全生命周期.md)：任务状态流转
- [14-Agent配置与虚拟团队模型](docs/agent-platform/14-Agent配置与虚拟团队模型.md)：角色、实例与团队模型
- [16-内置Agent角色与提示词库](docs/agent-platform/16-内置Agent角色与提示词库.md)：五类角色身份与四方向提示词
- [21-平台MCP-Server设计方案](docs/agent-platform/21-平台MCP-Server设计方案.md)：keta-platform MCP 工具设计

## License

MIT（待定，尚未正式确定许可证，确定后会更新此段）。
