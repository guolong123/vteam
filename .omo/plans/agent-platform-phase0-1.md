# Agent 平台 Phase 0 + Phase 1 开发计划

## TL;DR

> **Quick Summary**: 基于 18 篇《推进计划（分阶段实施）》，实现 Phase 0（前置准备）与 Phase 1（基础框架，前后端并行）——完成项目脚手架、Prisma 数据模型、认证/项目/SSE 基座后端模块，以及前端共享组件库与 4 个页面的原型一致迁移，达成里程碑 M0/M1。
>
> **Deliverables**:
> - `web/`：Next.js 15 前端（共享组件库 8 组件 + styles token + 导航体系 + login/project-list/task-create/task-board 4 页迁移）
> - `server/`：NestJS 10 后端（Prisma 20 表 + AuthModule + UsersModule + ProjectsModule + RealtimeModule SSE 基座 + OpenAPI）
> - 里程碑 M0（脚手架可启动）、M1（登录→项目→导航联调通过，与原型逐页视觉一致）
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 波执行
> **Critical Path**: 脚手架 → Prisma schema → 后端模块 / 前端 token+组件 → 页面迁移 → 联调 → 验收

---

## Context

### Original Request
用户要求「Phase 0 + Phase 1 开始实现，在 omo 下制定开发计划」，硬性约束：**前端页面效果与当前原型一致（样式、风格、布局不要随意改变）**，每阶段可功能性验收。

### Interview Summary
**Key Discussions**（用户确认 2026-08-06）:
- 代码目录：aiagents 根目录直接建 `web/` + `server/`
- 测试策略：后端 jest 单测（关键模块）+ 前端原型对比验收（playwright 截图对比 + data-testid 断言）
- Phase 1 前端迁移范围：4 页（login/project-list/task-create/task-board）+ 共享组件库 + 导航（rail 优先）

**Research Findings**:
- 原型体系：17 页 + `_shared/`（components.tsx 8 组件 / styles.ts 102 行 token / nav.tsx 778 行导航）
- 技术栈锁定（08 篇 §2）：Next.js 15 + React 19 / NestJS 10 / Prisma 5（MySQL+SQLite 双 provider）/ TanStack Query + Zustand / SSE / JWT
- 数据模型（15 篇）：20 表字段级定义，Prisma schema 直接来源
- API 契约（09 篇）：REST 10 模块 + SSE 事件 + 游标语义

### Metis Review
（环境无 Metis agent，由 Prometheus 自检替代）:
- 前端 token 迁移必须零改动：styles.ts 为唯一视觉事实源，页面迁移不得自行发明样式
- 后端模块边界对齐 08 篇 §3（禁止跨模块直接访问对方数据表）
- Prisma 双 provider（MySQL 生产 / SQLite 验证）为 15 篇 §2 硬约束

---

## Work Objectives

### Core Objective
完成 Phase 0 + Phase 1：搭建 monorepo（web/ + server/），后端跑通认证/项目/SSE 基座，前端共享组件库 + 4 页迁移且与原型逐页一致，达成 M0/M1 里程碑。

### Concrete Deliverables
- `web/`：Next.js 15 + TS 项目，共享组件库（tokens.ts + 8 组件 + 导航），4 页迁移
- `server/`：NestJS 10 + Prisma schema（20 表），Auth/Users/Projects/Realtime 模块，OpenAPI
- M0/M1 验收证据

### Definition of Done
- [ ] `cd server && npm run test` → 关键模块单测通过
- [ ] `cd server && npm run start:dev` → 服务起，`GET /api/v1/health` 200
- [ ] `cd web && npm run build` → 退出码 0
- [ ] Playwright 截图对比：4 页实现 vs 原型，视觉一致通过（token/布局/data-testid）
- [ ] M1 联调：登录 → 项目列表 → 全局导航可用

### Must Have
- 前端样式与原型一致（styles.ts token 零改动、8 组件原样迁移、data-testid 保留）
- 后端模块对齐 08 篇 §3（Auth/Users/Projects/Realtime）
- Prisma 双 provider（MySQL + SQLite）
- 认证 JWT + bcrypt（FR-22）
- RealtimeModule SSE 基座（事件通道 + 游标语义）

### Must NOT Have (Guardrails)
- 不得随意改变原型样式/风格/布局（除非用户明确要求）
- 不得引入 08 篇 §2 之外的新依赖
- 不实现 Phase 2+ 功能（任务状态机、群聊落库、Agent、Worker 集成）
- 不在本轮实现 git 凭证、产出物归档等后续阶段功能
- 不创建多租户/SSO/审计 API（下一版能力）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - 全部验证由执行 agent 完成，证据存 `.omo/evidence/`。

### Test Decision
- **Infrastructure exists**: 否（新项目，本轮搭建）
- **Automated tests**: 后端 jest 单测（关键模块）+ 前端原型对比验收（playwright）
- **Framework**: jest（server）/ playwright（web 验收）
- **If TDD**: 后端关键模块测试优先（Auth/Projects），其余 tests-after

### QA Policy
- **前端/UI**: Playwright 截图对比（实现 vs 原型）+ data-testid 断言 + 样式 token 检查
- **API/Backend**: Bash（curl）请求端点，断言状态码 + 响应字段
- **Build**: tsc/build/migrate 退出码 0

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Phase 0 前置 + 脚手架，7 任务并行):
├── Task 1: 根目录 + git 初始化 [quick]
├── Task 2: web/ Next.js 脚手架 [quick]
├── Task 3: server/ NestJS 脚手架 [quick]
├── Task 4: Prisma schema 20 表 + 双 provider [quick]
├── Task 5: 原型审计清单（17 页 data-testid/token 盘点）[quick]
├── Task 6: 后端测试基座（jest + supertest 配置）[quick]
└── Task 7: 前端状态层接入（TanStack Query + Zustand）[quick]

Wave 2 (Phase 1 前后端并行，MAX PARALLEL):
前端轨道:
├── Task 8: styles.ts token → tokens.ts 全量迁移 [quick]
├── Task 9: 8 共享组件迁移 [unspecified-high]
├── Task 10: 导航体系迁移（Sidebar/TopBar + App Router 路由）[unspecified-high]
├── Task 11: login 页迁移 [unspecified-high]
├── Task 12: project-list 页迁移 [unspecified-high]
├── Task 13: task-create 页迁移 [unspecified-high]
└── Task 14: task-board 页迁移 [unspecified-high]
后端轨道:
├── Task 15: AuthModule（注册/登录/JWT/bcrypt + 单测）[deep]
├── Task 16: UsersModule 基础 + 单测 [quick]
├── Task 17: ProjectsModule 基础（列表/创建）+ 单测 [quick]
├── Task 18: RealtimeModule SSE 基座 [deep]
└── Task 19: OpenAPI 契约（swagger 全端点）[quick]

Wave 3 (联调 + 验收):
├── Task 20: 前后端联调（登录→项目→导航，M1）[unspecified-high]
├── Task 21: 原型一致性验收（4 页截图对比）[unspecified-high]
└── Task 22: 构建/测试全量验证（M0/M1 证据汇总）[quick]

Wave FINAL (评审，4 并行):
├── Task F1: 计划合规审计 (oracle)
├── Task F2: 代码质量评审 (unspecified-high)
├── Task F3: 真实 QA（原型对比走查）(unspecified-high)
└── Task F4: 范围保真检查 (deep)
-> 汇总结果 -> 用户确认

Critical Path: Task 2 → Task 8 → Task 9 → Task 10 → Task 11 → Task 20 → F1-F4
```

### Dependency Matrix
- **2 (web 脚手架)**: 1 - 8-14, 20
- **3 (server 脚手架)**: 1 - 15-19, 20
- **4 (Prisma schema)**: 1 - 15-19
- **6 (测试基座)**: 3 - 15-17
- **8 (token)**: 2 - 9-14
- **9 (组件)**: 8 - 10-14
- **10 (导航)**: 9 - 11-14, 20
- **11-14 (页面)**: 10, 7 - 20
- **15 (Auth)**: 4, 6 - 20
- **16-17 (Users/Projects)**: 4, 6 - 20
- **18 (SSE)**: 3 - 20
- **20 (联调)**: 11, 15 - 21, 22

---

## TODOs

- [x] 1. 根目录结构 + git 初始化

  **What to do**:
  - 在 `/data/git-project/aiagents/` 根下创建 `web/`、`server/` 目录；根级 `.gitignore`（node_modules/.next/dist/.env）、`README.md`（项目结构说明）
  - `git init` 初始化仓库（aiagents 根当前非 git 仓库），首个 commit 仅含结构文件
  - 确认 md-docs 文档目录 `docs/` 不被误纳入（或纳入均可，保持干净）

  **Must NOT do**:
  - 不建 platform 子目录（用户确认直接在根建 web/+server/）
  - 不初始化任何构建配置（由 Task 2/3 脚手架完成）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 简单目录与 git 初始化，无复杂逻辑
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: 仅 init + 首 commit，不涉及复杂 git 操作

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 2-7）
  - **Blocks**: 2-7
  - **Blocked By**: None

  **References**:
  - 无代码参考（全新项目）

  **Acceptance Criteria**:
  - [ ] `ls /data/git-project/aiagents/` 含 web/ server/ 目录
  - [ ] `git -C /data/git-project/aiagents status` 显示干净仓库（或有未跟踪的 web/server）
  - [ ] `.gitignore` 含 node_modules/.next/dist

  **QA Scenarios**:
  ```
  Scenario: 目录与仓库初始化
    Tool: Bash
    Steps:
      1. `ls -d /data/git-project/aiagents/web /data/git-project/aiagents/server` → 两目录存在
      2. `git -C /data/git-project/aiagents log --oneline -1` → 首 commit 存在
    Expected Result: 目录存在、仓库已 init 且有提交
    Evidence: .omo/evidence/task-1-init.md

  Scenario: .gitignore 生效
    Tool: Bash
    Steps:
      1. `grep -E "node_modules|\.next|dist" /data/git-project/aiagents/.gitignore` → 命中
    Expected Result: 关键忽略项存在
    Evidence: .omo/evidence/task-1-gitignore.md
  ```

  **Commit**: YES
  - Message: `chore(init): 项目根结构与 git 初始化`
  - Files: .gitignore README.md
  - Pre-commit: 无

- [x] 2. web/ Next.js 脚手架

  **What to do**:
  - 在 `web/` 下用 create-next-app 初始化：Next.js 15 + React 19 + TypeScript + App Router（`npx create-next-app@latest web --ts --app --no-eslint --no-tailwind --no-src-dir` 或等价；注意：**不使用 Tailwind**——原型用内联样式 + token，保持样式机制一致）
  - 配置路径别名 `@/*` 指向 `web/*`
  - 删除默认模板样式（globals.css 清空或仅留 reset），准备接入 tokens.ts（Task 8）

  **Must NOT do**:
  - 不装 Tailwind / styled-components 等额外样式方案（08 篇 §2 未选，原型是内联样式）
  - 不实现任何业务页面（Task 11-14）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准脚手架命令 + 基础配置
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1,3-7）
  - **Blocks**: 8-14, 20
  - **Blocked By**: 1

  **References**:
  - 08 篇 §2.1 技术栈（Next.js 15 + React 19 + TanStack Query + Zustand）

  **Acceptance Criteria**:
  - [ ] `cd web && npm run build` 退出码 0
  - [ ] `cd web && npm run dev` 起服务，`curl localhost:3000` 返回 200

  **QA Scenarios**:
  ```
  Scenario: 脚手架构建
    Tool: Bash
    Steps:
      1. `cd web && npm run build` → 退出码 0
    Expected Result: build 成功
    Evidence: .omo/evidence/task-2-build.md

  Scenario: dev 服务启动
    Tool: Bash
    Steps:
      1. `cd web && (npm run dev &)` 等待 5s
      2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` → 200
    Expected Result: 页面可访问
    Evidence: .omo/evidence/task-2-dev.md
  ```

  **Commit**: YES
  - Message: `chore(web): Next.js 15 脚手架初始化`
  - Files: web/
  - Pre-commit: `cd web && npm run build`

- [x] 3. server/ NestJS 脚手架

  **What to do**:
  - 在 `server/` 下初始化 NestJS 10（`npx @nestjs/cli new server` 或手动骨架）+ TypeScript
  - 安装依赖：`@nestjs/config`、`@nestjs/jwt`、`@nestjs/passport`、`passport-jwt`、`bcrypt`、`@nestjs/swagger`、`@nestjs/terminus`（health）、pino 日志
  - 目录结构对齐 08 篇 §3 模块划分（auth/users/projects/realtime/... 模块骨架，本轮仅建 Phase 1 模块）
  - `GET /api/v1/health` 健康检查端点（@nestjs/terminus）

  **Must NOT do**:
  - 不实现业务逻辑（Task 15-19）
  - 不建 Phase 2+ 模块骨架之外的空目录

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准脚手架 + 依赖安装
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-2,4-7）
  - **Blocks**: 6, 15-20
  - **Blocked By**: 1

  **References**:
  - 08 篇 §2.1（NestJS 10 + JWT + class-validator + OpenAPI + pino）、§3.1（模块划分）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run build` 退出码 0
  - [ ] `cd server && npm run start:dev` 起服务，`curl localhost:3000/api/v1/health` 200

  **QA Scenarios**:
  ```
  Scenario: 后端构建与健康检查
    Tool: Bash
    Steps:
      1. `cd server && npm run build` → 退出码 0
      2. `(npm run start:dev &)` 等待 8s
      3. `curl -s http://localhost:3000/api/v1/health` → 含 "status":"ok"
    Expected Result: 构建成功 + health 200
    Evidence: .omo/evidence/task-3-health.md

  Scenario: 端口冲突处理
    Tool: Bash
    Steps:
      1. 若 3000 被占用，改 PORT env 重试（记录实际端口）
    Expected Result: 服务可起
    Evidence: .omo/evidence/task-3-port.md
  ```

  **Commit**: YES
  - Message: `chore(server): NestJS 10 脚手架初始化`
  - Files: server/
  - Pre-commit: `cd server && npm run build`

- [x] 4. Prisma schema 20 表 + 双 provider

  **What to do**:
  - 在 `server/` 安装 Prisma 5，`prisma init` 并配置双 provider：`provider = ["mysql", "sqlite"]`（15 篇 §2 双库兼容）
  - 依据 15 篇 §3 逐表字段定义，创建 20 表 schema（users/projects/project_members/roles/agents/agent_skills/agent_tool_effects/skills/tools/tasks/task_agents/task_events/sessions/chat_channels/messages/artifacts/artifact_versions/workers/task_group_instances；audit_logs 预留不建）
  - 字段类型按 15 篇 §2 约定（字符串枚举 + Json 列，规避 SQLite 无原生 enum 差异）；主键按 15 篇 §2.2（VARCHAR(64) 域前缀+自增序号）
  - 索引与唯一约束按 15 篇 §4/§5（task_agents(task_id,agent_id) 唯一、sessions(task_id,agent_id) 唯一、artifact_versions(artifact_id,version) 唯一等）
  - SQLite 验证库生成 migrate + `prisma db push` 验证 schema 可落库

  **Must NOT do**:
  - 不建 audit_logs 表（下一版预留，15 篇 §3 标注）
  - 不添加 15 篇之外的字段

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 从 15 篇文档机械转换 schema
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `ketaops-app`: 不涉及 KetaOps 平台

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-3,5-7）
  - **Blocks**: 15-19
  - **Blocked By**: 1

  **References**:
  - `docs/agent-platform/15-数据模型细化（ER图）.md` §2（类型约定/主键策略）、§3（逐表字段）、§4（关系与约束）、§5（索引）——**唯一事实来源**
  - 08 篇 §6.1（表划分总览）

  **Acceptance Criteria**:
  - [ ] `cd server && npx prisma validate` → schema 合法
  - [ ] SQLite 下 `npx prisma db push` 成功，20 表建出（`npx prisma db execute` 或 sqlite 检查）
  - [ ] 表数量 = 20（不含 audit_logs）

  **QA Scenarios**:
  ```
  Scenario: schema 校验
    Tool: Bash
    Steps:
      1. `cd server && npx prisma validate` → Schema is valid
    Expected Result: schema 合法
    Evidence: .omo/evidence/task-4-validate.md

  Scenario: SQLite 落库 20 表
    Tool: Bash
    Steps:
      1. 配置 DATABASE_URL="file:./dev.db"（sqlite provider）
      2. `npx prisma db push` → 成功
      3. 查表清单：`sqlite3 dev.db ".tables"` 或 Prisma 客户端 `listTables`
      4. 断言：20 表全在、audit_logs 不在
    Expected Result: 20 表建出
    Evidence: .omo/evidence/task-4-tables.md
  ```

  **Commit**: YES
  - Message: `feat(server): Prisma schema 20 表（双 provider）`
  - Files: server/prisma
  - Pre-commit: `cd server && npx prisma validate`

- [x] 5. 原型审计清单（17 页 data-testid/token 盘点）

  **What to do**:
  - 逐页读取 `docs/agent-platform/prototypes/` 下 17 个页面的 `index.tsx`，盘点每页：引用的共享组件、使用的 token（来自 styles.ts）、data-testid 清单、内联样式模式
  - 产出审计清单 `.omo/evidence/prototype-audit.md`：17 页 × {共享组件引用 / token 使用 / data-testid 列表 / 特殊布局}
  - 重点标注 4 个 Phase 1 迁移页（login/project-list/task-create/task-board）的完整依赖

  **Must NOT do**:
  - 不改动任何原型文件（只读审计）
  - 不产出代码

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 只读盘点与清单整理
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-4,6-7）
  - **Blocks**: 8-14（提供 token/组件/页面迁移的事实依据）
  - **Blocked By**: None

  **References**:
  - `docs/agent-platform/prototypes/*/index.tsx`（17 页）
  - `docs/agent-platform/prototypes/_shared/components.tsx`（8 组件）、`styles.ts`（token）、`nav.tsx`

  **Acceptance Criteria**:
  - [ ] `.omo/evidence/prototype-audit.md` 存在，含 17 页清单
  - [ ] 每页 data-testid 已盘点

  **QA Scenarios**:
  ```
  Scenario: 审计清单完整
    Tool: Bash
    Steps:
      1. 统计原型页数：`ls docs/agent-platform/prototypes/*/index.tsx | wc -l` → 17
      2. 对照审计清单，确认 17 页全收录
      3. grep 清单中 data-testid 数 > 0
    Expected Result: 17 页全审计、testid 已记录
    Evidence: .omo/evidence/task-5-audit.md
  ```

  **Commit**: YES
  - Message: `docs: 原型审计清单（17 页）`
  - Files: .omo/evidence/prototype-audit.md
  - Pre-commit: 无

- [x] 6. 后端测试基座（jest + supertest）

  **What to do**:
  - 在 `server/` 配置 jest（`@nestjs/testing` + `supertest` + ts-jest），package.json 加 `test` 脚本
  - 建 `test/` 目录与 e2e 配置；示例单测（app.controller 或 health）验证基座可用
  - jest 配置 sqlite 测试库（`DATABASE_URL=file:./test.db`），保证测试不依赖 MySQL

  **Must NOT do**:
  - 不写业务测试（Task 15-17 各自带）
  - 不引入额外测试框架

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准 jest 配置
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-5,7）
  - **Blocks**: 15-17
  - **Blocked By**: 3

  **References**:
  - NestJS 官方 Testing 文档（@nestjs/testing + supertest）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run test` → 示例测试通过
  - [ ] 测试用 sqlite 库，无 MySQL 依赖

  **QA Scenarios**:
  ```
  Scenario: 测试基座运行
    Tool: Bash
    Steps:
      1. `cd server && npm run test` → 退出码 0，示例测试 PASS
    Expected Result: jest 基座可用
    Evidence: .omo/evidence/task-6-jest.md
  ```

  **Commit**: YES
  - Message: `chore(server): jest + supertest 测试基座`
  - Files: server/jest.config.* server/test server/package.json
  - Pre-commit: `cd server && npm run test`

- [x] 7. 前端状态层接入（TanStack Query + Zustand）

  **What to do**:
  - 在 `web/` 安装 `@tanstack/react-query` + `zustand`
  - 建 QueryClientProvider 挂载（app/layout.tsx）
  - 建 `web/lib/api.ts`（fetch 封装：baseURL /api、token 注入、错误归一化——对齐 09 篇 §2 通用约定）
  - 建 Zustand 基础 store：authStore（token/user 持久化，配合登录页）

  **Must NOT do**:
  - 不写具体业务查询（页面任务各自接）
  - 不引入 Redux 等额外状态库

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准接入配置
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1（with 1-6）
  - **Blocks**: 11-14（页面需要 api.ts + authStore）
  - **Blocked By**: 2

  **References**:
  - 08 篇 §2.1（TanStack Query + Zustand 选型）
  - 09 篇 §2（API 通用约定：baseURL、错误码）

  **Acceptance Criteria**:
  - [ ] `cd web && npm run build` 退出码 0
  - [ ] app/layout.tsx 含 QueryClientProvider

  **QA Scenarios**:
  ```
  Scenario: 状态层接入可构建
    Tool: Bash
    Steps:
      1. `cd web && npm run build` → 退出码 0
      2. `grep -r "QueryClientProvider" web/src/app/layout.tsx` → 命中
    Expected Result: 构建通过 + provider 挂载
    Evidence: .omo/evidence/task-7-state.md
  ```

  **Commit**: YES
  - Message: `feat(web): TanStack Query + Zustand 状态层`
  - Files: web/
  - Pre-commit: `cd web && npm run build`

- [x] 8. styles.ts token → tokens.ts 全量迁移

  **What to do**:
  - 将 `docs/agent-platform/prototypes/_shared/styles.ts`（102 行 token）**逐字迁移**为 `web/src/theme/tokens.ts`（或等价路径），**零改动**（label/color/bg/border + 角色色 product/architect/developer/tester 全部保留）
  - 导出类型（Token 类型定义）与所有常量，供组件与页面引用
  - 验证迁移完整性：`diff` 关键 token 名清单，确保无遗漏/无改名

  **Must NOT do**:
  - **不得改动任何 token 值**（颜色/字号/间距——用户最高约束）
  - 不得自行发明新 token（除非用户要求）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 逐字搬运 + 完整性校验
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 9-19）
  - **Blocks**: 9-14
  - **Blocked By**: 2

  **References**:
  - `docs/agent-platform/prototypes/_shared/styles.ts` — **唯一视觉事实源，零改动迁移**

  **Acceptance Criteria**:
  - [ ] tokens.ts 存在，token 值与 styles.ts 完全一致
  - [ ] token 名集合一致（`diff <(grep -oE '^\s+[a-zA-Z-]+:' styles.ts | sort) <(grep -oE ... tokens.ts | sort)` 为空）
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: token 零改动迁移
    Tool: Bash
    Steps:
      1. 提取 styles.ts 全部 token 名/值 → A
      2. 提取 tokens.ts 全部 token 名/值 → B
      3. `diff A B` → 空（完全一致）
    Expected Result: token 100% 一致，零改动
    Evidence: .omo/evidence/task-8-tokens-diff.md

  Scenario: 构建通过
    Tool: Bash
    Steps:
      1. `cd web && npm run build` → 退出码 0
    Expected Result: 构建成功
    Evidence: .omo/evidence/task-8-build.md
  ```

  **Commit**: YES
  - Message: `feat(web): 样式 token 全量迁移（零改动）`
  - Files: web/src/theme/tokens.ts
  - Pre-commit: `cd web && npm run build`

- [x] 9. 8 个共享组件迁移

  **What to do**:
  - 将 `_shared/components.tsx` 的 8 个组件（AgentAvatar/AgentBadge/ChatBubble/MessageInput/StatusBadge/Sidebar/TopBar/EmptyState）**原样迁移**为 `web/src/components/ui/`（或等价路径）
  - **结构/样式/data-testid 保留**；改用 tokens.ts 引用（若原型内联字面量则保留字面量等价——以原型渲染效果一致为准）
  - 处理与 nav.tsx 的依赖（Sidebar/TopBar 若引用导航，Task 10 完成后再接）
  - 每个组件导出含原型一致的 data-testid 默认值

  **Must NOT do**:
  - 不改组件视觉（尺寸/颜色/间距/文本）
  - 不改变组件 props 语义（可扩展但不得破坏原型行为）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 组件迁移需要视觉保真与结构理解
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: 本轮是保真迁移非新设计，不需设计能力

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8,10-19）
  - **Blocks**: 10-14
  - **Blocked By**: 8

  **References**:
  - `docs/agent-platform/prototypes/_shared/components.tsx`（716 行）— 唯一来源，8 组件原样迁移
  - `docs/agent-platform/prototypes/_shared/nav.tsx`（依赖关系）

  **Acceptance Criteria**:
  - [ ] 8 组件全部迁移至 web/src/components/ui/
  - [ ] 每组件 data-testid 与原型一致
  - [ ] `cd web && npm run build` 退出码 0
  - [ ] Playwright 组件对比：迁移组件渲染与原型组件截图一致

  **QA Scenarios**:
  ```
  Scenario: 组件渲染对比（以 AgentAvatar 为例）
    Tool: Playwright
    Preconditions: web dev 起（localhost:3000 测试页渲染组件）；原型服务起（5177 渲染原型组件）
    Steps:
      1. 分别在 web 测试页与原型组件页渲染 AgentAvatar（相同 props）
      2. 截图对比 → 视觉一致
    Expected Result: 组件渲染与原型一致
    Evidence: .omo/evidence/task-9-avatar.png

  Scenario: data-testid 保留
    Tool: Bash
    Steps:
      1. `grep -c "data-testid" web/src/components/ui/*.tsx` → 与原型 components.tsx 中 data-testid 总数一致
    Expected Result: data-testid 全保留
    Evidence: .omo/evidence/task-9-testid.md
  ```

  **Commit**: YES
  - Message: `feat(web): 8 共享组件原样迁移`
  - Files: web/src/components/ui/
  - Pre-commit: `cd web && npm run build`

- [x] 10. 导航体系迁移（Sidebar/TopBar + App Router 路由）

  **What to do**:
  - 将 `_shared/nav.tsx`（778 行）导航体系迁移为 `web/src/components/layout/`（nav-rail 优先，nav-cmdk/nav-hybrid 预留组件结构）
  - 建 App Router 全局布局 `web/src/app/(main)/layout.tsx`：Sidebar + TopBar + 内容区（Dock 导航 7 项：project/board/agents/workers/skills/messages/users 对齐 06 篇）
  - 建路由骨架：/login /projects /board /agents /workers /skills /messages /users（页面占位，Task 11-14 填充 4 个）
  - 登录态守卫：未登录跳 /login（配合 authStore）

  **Must NOT do**:
  - 不改导航视觉（图标/文案/布局/选中态）
  - 不实现各页面内容（Task 11-14）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 导航体系迁移 + 路由编排，需保真与结构理解
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8-9,11-19）
  - **Blocks**: 11-14, 20
  - **Blocked By**: 9

  **References**:
  - `docs/agent-platform/prototypes/_shared/nav.tsx`（778 行）— 唯一来源
  - 06 篇（Dock 导航 7 项设计）

  **Acceptance Criteria**:
  - [ ] 全局布局含 Sidebar+TopBar，与原型导航视觉一致
  - [ ] 路由骨架可访问（/login /projects /board /agents /workers /skills /messages /users 返回占位页）
  - [ ] 未登录访问 /projects 跳转 /login
  - [ ] `cd web && npm run build` 退出码 0

  **QA Scenarios**:
  ```
  Scenario: 导航视觉一致
    Tool: Playwright
    Steps:
      1. 打开 web /projects（占位）与原型 nav-rail 页，截图对比导航区
      2. 断言导航项（project/board/agents/workers/skills/messages/users）存在
    Expected Result: 导航结构与原型一致
    Evidence: .omo/evidence/task-10-nav.png

  Scenario: 登录守卫
    Tool: Playwright
    Steps:
      1. 清除 localStorage token，访问 /projects
      2. 断言跳转 /login
    Expected Result: 未登录重定向
    Evidence: .omo/evidence/task-10-guard.png
  ```

  **Commit**: YES
  - Message: `feat(web): 导航体系与路由骨架`
  - Files: web/src/components/layout web/src/app
  - Pre-commit: `cd web && npm run build`

- [x] 11. login 页迁移

  **What to do**:
  - 将 `prototypes/login/index.tsx` **保真迁移**为 `web/src/app/login/page.tsx`
  - 接入真实认证：表单提交 → `POST /api/v1/auth/login`（Task 15 端点）→ token 存 authStore → 跳 /projects
  - 错误态（登录失败提示）与原型一致；data-testid 保留（login-username/login-password/login-submit 等原型实际值）
  - 迁移后原型对比：截图与原型 login 页视觉一致

  **Must NOT do**:
  - 不改视觉（布局/间距/配色/文案）
  - 不实现注册流程（Phase 1 仅登录；注册端点后端可留，页面不做）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 页面保真迁移 + 真实接口接入
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8-10,12-19）
  - **Blocks**: 20
  - **Blocked By**: 10, 7

  **References**:
  - `docs/agent-platform/prototypes/login/index.tsx` — 唯一视觉来源
  - 09 篇 §3.1/§3.2（auth 端点：POST /auth/login 请求/响应字段）

  **Acceptance Criteria**:
  - [ ] 页面渲染与原型 login 截图一致
  - [ ] 输入正确账号密码 → 登录成功跳 /projects
  - [ ] 错误凭证 → 显示错误提示（不跳转）
  - [ ] data-testid 与原型一致

  **QA Scenarios**:
  ```
  Scenario: 视觉一致
    Tool: Playwright
    Steps:
      1. 打开 web /login 与原型 login 页，截图对比
      2. 断言 token 一致（无视觉 diff）
    Expected Result: 与原型一致
    Evidence: .omo/evidence/task-11-login-visual.png

  Scenario: 登录成功流
    Tool: Playwright
    Preconditions: server 起（Task 15 完成）；测试账号已建（seed）
    Steps:
      1. 填 data-testid=login-username → "admin"；login-password → 正确密码
      2. 点 login-submit
      3. 断言 URL → /projects；localStorage 有 token
    Expected Result: 登录成功跳转
    Evidence: .omo/evidence/task-11-login-ok.png

  Scenario: 登录失败
    Tool: Playwright
    Steps:
      1. 填错误密码，提交
      2. 断言：仍在 /login + 错误提示可见（data-testid 断言）
    Expected Result: 错误提示，不跳转
    Evidence: .omo/evidence/task-11-login-fail.png
  ```

  **Commit**: YES
  - Message: `feat(web): 登录页迁移 + 认证接入`
  - Files: web/src/app/login
  - Pre-commit: `cd web && npm run build`

- [x] 12. project-list 页迁移

  **What to do**:
  - 将 `prototypes/project-list/index.tsx` **保真迁移**为 `web/src/app/(main)/projects/page.tsx`
  - 接入真实数据：`GET /api/v1/projects`（Task 17）→ TanStack Query 渲染列表；创建项目弹窗 → `POST /api/v1/projects`
  - data-testid 保留；空态（EmptyState 组件）与原型一致
  - 原型对比：截图与原型 project-list 页视觉一致

  **Must NOT do**:
  - 不改视觉（卡片布局/间距/文案/空态）
  - 不实现项目详情（Phase 2）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 页面保真迁移 + Query 数据接入
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8-11,13-19）
  - **Blocks**: 20
  - **Blocked By**: 10, 7

  **References**:
  - `docs/agent-platform/prototypes/project-list/index.tsx` — 唯一视觉来源
  - 09 篇 §3.3（projects 端点：GET /projects 列表、POST /projects 创建字段）

  **Acceptance Criteria**:
  - [ ] 页面与原型 project-list 截图一致
  - [ ] 列表渲染真实数据（seeded 项目）
  - [ ] 创建项目后列表刷新（Query 失效重取）
  - [ ] 空态显示 EmptyState 与原型一致

  **QA Scenarios**:
  ```
  Scenario: 视觉一致
    Tool: Playwright
    Steps:
      1. web /projects 与原型 project-list 截图对比 → 无视觉 diff
    Expected Result: 与原型一致
    Evidence: .omo/evidence/task-12-list-visual.png

  Scenario: 列表数据 + 创建
    Tool: Playwright
    Preconditions: server 起 + 已登录 + seed 项目
    Steps:
      1. 断言列表渲染 N 个项目卡片（data-testid）
      2. 打开创建弹窗，填名提交
      3. 断言列表刷新出现新项目
    Expected Result: 数据驱动正常
    Evidence: .omo/evidence/task-12-list-data.png
  ```

  **Commit**: YES
  - Message: `feat(web): 项目列表页迁移 + 数据接入`
  - Files: web/src/app/(main)/projects
  - Pre-commit: `cd web && npm run build`

- [x] 13. task-create 页迁移

  **What to do**:
  - 将 `prototypes/task-create/index.tsx` **保真迁移**为 `web/src/app/(main)/tasks/new/page.tsx`
  - 接入真实提交：`POST /api/v1/projects/:pid/tasks`（Phase 2 端点未实现时，表单 UI 完整 + 提交走预留接口并展示结果；或标注 Mock 阶段——**以 Phase 1 边界为准：表单保真 + 数据接口若未就绪则 mock 成功态，不阻塞视觉验收**）
  - 表单字段与原型一致（标题/描述/优先级/Agent 选择/背景文档，FR-01）；data-testid 保留
  - 原型对比：截图与原型 task-create 视觉一致

  **Must NOT do**:
  - 不改表单视觉/字段布局
  - 不实现任务创建后端逻辑（Phase 2）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 复杂表单保真迁移
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8-12,14-19）
  - **Blocks**: 20
  - **Blocked By**: 10, 7

  **References**:
  - `docs/agent-platform/prototypes/task-create/index.tsx` — 唯一视觉来源
  - 03 篇 FR-01/FR-07（任务创建字段：标题/描述/优先级/Agent/主 Agent/背景文档）

  **Acceptance Criteria**:
  - [ ] 表单渲染与原型截图一致（全部字段 + data-testid）
  - [ ] 提交动作触发（接口就绪则真实提交；未就绪则 mock 成功，记录在证据）
  - [ ] 校验：空标题提示（与原型交互一致）

  **QA Scenarios**:
  ```
  Scenario: 视觉一致
    Tool: Playwright
    Steps:
      1. web /tasks/new 与原型 task-create 截图对比 → 无视觉 diff
    Expected Result: 与原型一致
    Evidence: .omo/evidence/task-13-visual.png

  Scenario: 表单交互
    Tool: Playwright
    Steps:
      1. 空标题提交 → 断言校验提示（data-testid）
      2. 填完整字段 → 提交 → 断言成功反馈（真实或 mock，记录实际路径）
    Expected Result: 交互与原型一致
    Evidence: .omo/evidence/task-13-form.png
  ```

  **Commit**: YES
  - Message: `feat(web): 任务创建页迁移`
  - Files: web/src/app/(main)/tasks/new
  - Pre-commit: `cd web && npm run build`

- [x] 14. task-board 页迁移

  **What to do**:
  - 将 `prototypes/task-board/index.tsx` **保真迁移**为 `web/src/app/(main)/board/page.tsx`
  - 看板五列（待开始/进行中/待验收/已完成/已归档，FR-03）与原型一致；列内容先渲染静态/seed 数据（Phase 2 接真实接口）
  - data-testid 保留；卡片拖拽/点击交互与原型一致（Phase 1 仅视觉 + 交互骨架，状态迁移逻辑 Phase 2）
  - 原型对比：截图与原型 task-board 视觉一致

  **Must NOT do**:
  - 不改看板布局（五列结构/卡片样式/拖拽形态）
  - 不实现状态迁移后端逻辑（Phase 2）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 看板保真迁移（布局 + 交互）
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 前端轨道（with 8-13,15-19）
  - **Blocks**: 20
  - **Blocked By**: 10, 7

  **References**:
  - `docs/agent-platform/prototypes/task-board/index.tsx` — 唯一视觉来源
  - 03 篇 FR-03（五态看板）、13 篇 §2（五态枚举）

  **Acceptance Criteria**:
  - [ ] 五列看板与原型截图一致（含列头/卡片样式）
  - [ ] 卡片数据渲染（seed）
  - [ ] data-testid 与原型一致

  **QA Scenarios**:
  ```
  Scenario: 视觉一致
    Tool: Playwright
    Steps:
      1. web /board 与原型 task-board 截图对比 → 无视觉 diff
    Expected Result: 与原型一致
    Evidence: .omo/evidence/task-14-board-visual.png

  Scenario: 五列结构
    Tool: Playwright
    Steps:
      1. 断言 5 个列头文本（待开始/进行中/待验收/已完成/已归档）
      2. 断言卡片渲染（seed 数据）
    Expected Result: 看板结构完整
    Evidence: .omo/evidence/task-14-board-structure.png
  ```

  **Commit**: YES
  - Message: `feat(web): 任务看板页迁移`
  - Files: web/src/app/(main)/board
  - Pre-commit: `cd web && npm run build`

- [x] 15. AuthModule（注册/登录/JWT/bcrypt + 单测）

  **What to do**:
  - 按 09 篇 §3.1/§3.2 实现 AuthModule：`POST /api/v1/auth/register`、`POST /api/v1/auth/login`、`GET /api/v1/auth/profile`（或 09 篇实际端点）
  - JWT 签发/校验（@nestjs/jwt + passport-jwt 策略）+ bcrypt 密码哈希（FR-22）
  - 全局守卫装配（除 login/register 外需 token）；`users` 表落库（Task 4 schema）
  - **单测**：register（密码哈希、重复用户名 409）、login（正确/错误凭证 200/401）、guard（无 token 401）
  - seed：初始 admin 账号（供前端登录验收）

  **Must NOT do**:
  - 不做 SSO/第三方登录（后续迭代，05 篇 3.4）
  - 不实现多租户

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 认证安全逻辑（JWT/bcrypt/守卫）+ 单测，需严谨
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 后端轨道（with 8-14,16-19）
  - **Blocks**: 20
  - **Blocked By**: 4, 6

  **References**:
  - 09 篇 §3.1/§3.2（auth 端点契约：请求/响应/错误码 401/409）
  - 03 篇 FR-22（内置账号 + 密码登录）
  - 08 篇 §2.1（JWT + bcrypt + @nestjs/passport）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run test` 含 auth 单测全过
  - [ ] curl 注册/登录/鉴权三场景通过
  - [ ] 密码以 bcrypt 哈希存库（非明文）

  **QA Scenarios**:
  ```
  Scenario: 注册 + 登录 + 鉴权（curl）
    Tool: Bash
    Steps:
      1. POST /api/v1/auth/register {username:"t1",password:"pass123"} → 201
      2. POST /api/v1/auth/login 正确密码 → 200 含 access_token
      3. GET /api/v1/auth/profile 带 Bearer → 200 返回用户
      4. 无 token 访问 /profile → 401
      5. 重复注册同用户名 → 409
    Expected Result: 全部符合 09 篇契约
    Evidence: .omo/evidence/task-15-auth-curl.md

  Scenario: 密码非明文
    Tool: Bash
    Steps:
      1. 查 users 表密码列 → bcrypt 哈希（$2b$ 前缀），非明文
    Expected Result: 哈希存储
    Evidence: .omo/evidence/task-15-hash.md
  ```

  **Commit**: YES
  - Message: `feat(server): AuthModule（JWT + bcrypt + 单测）`
  - Files: server/src/auth server/prisma/seed
  - Pre-commit: `cd server && npm run test`

- [x] 16. UsersModule 基础 + 单测

  **What to do**:
  - 按 09 篇 §3.2 实现 UsersModule 基础：`GET /api/v1/users`（列表）、`GET /api/v1/users/:id`、`PATCH /api/v1/users/:id/status`（禁用/启用，FR-22）——Phase 1 做列表 + 详情基础，status 可一并
  - 权限：用户管理操作 `[admin]` 守卫（roles 表/角色矩阵 Phase 3 完善，Phase 1 用简单 admin 标记或占位）
  - 单测：列表分页、详情、禁用后状态
  - 前端 user-management 页 Phase 1 不做（路由占位即可）

  **Must NOT do**:
  - 不做角色 CRUD/权限矩阵完整实现（Phase 3 role-permission）
  - 不实现用户删除（FR-22 禁用不删除）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准 CRUD 模块 + 基础单测
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 后端轨道（with 8-15,17-19）
  - **Blocks**: 20
  - **Blocked By**: 4, 6

  **References**:
  - 09 篇 §3.2（users 端点契约）
  - 03 篇 FR-22（用户管理：创建/禁用、禁用 401）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run test` 含 users 单测通过
  - [ ] curl 列表/详情/禁用三场景通过

  **QA Scenarios**:
  ```
  Scenario: 用户列表与禁用（curl）
    Tool: Bash
    Steps:
      1. GET /api/v1/users（admin token）→ 200 含 users 列表
      2. PATCH /users/:id/status {enabled:false} → 200
      3. 被禁用用户登录 → 401
    Expected Result: 符合 09 篇契约
    Evidence: .omo/evidence/task-16-users.md
  ```

  **Commit**: YES
  - Message: `feat(server): UsersModule 基础 + 单测`
  - Files: server/src/users
  - Pre-commit: `cd server && npm run test`

- [x] 17. ProjectsModule 基础（列表/创建）+ 单测

  **What to do**:
  - 按 09 篇 §3.3 实现 ProjectsModule：`GET /api/v1/projects`（调用者所属项目，FR-25）、`POST /api/v1/projects`（创建，创建者为 owner）
  - `project_members` 落库（owner 记录）；权限：成员仅见已加入项目
  - 单测：列表（成员可见性）、创建（owner 写入）
  - seed：1-2 个项目供前端 project-list 验收

  **Must NOT do**:
  - 不做项目内任务/成员管理完整流程（Phase 2）
  - 不实现项目归档（FR-25 status 变更可留字段）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准 CRUD + 可见性规则 + 单测
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 后端轨道（with 8-16,18-19）
  - **Blocks**: 20
  - **Blocked By**: 4, 6

  **References**:
  - 09 篇 §3.3（projects 端点：GET /projects 分页 + status、POST /projects 创建字段）
  - 03 篇 FR-25（项目：创建者 owner、成员仅见已加入）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run test` 含 projects 单测通过
  - [ ] curl 列表（成员可见性）/创建（owner）通过
  - [ ] seed 项目存在

  **QA Scenarios**:
  ```
  Scenario: 项目列表与创建（curl）
    Tool: Bash
    Steps:
      1. GET /api/v1/projects（已加入用户）→ 200 含项目列表
      2. POST /api/v1/projects {name:"demo"} → 201
      3. GET /projects 再查 → 含新建项目
      4. 未加入用户 GET /projects → 不含他人项目
    Expected Result: 符合 09 篇契约 + FR-25 可见性
    Evidence: .omo/evidence/task-17-projects.md
  ```

  **Commit**: YES
  - Message: `feat(server): ProjectsModule 基础 + 单测`
  - Files: server/src/projects server/prisma/seed
  - Pre-commit: `cd server && npm run test`

- [x] 18. RealtimeModule SSE 基座

  **What to do**:
  - 按 09 篇 §4 实现 RealtimeModule SSE 基座：统一事件通道（EventEmitter/内部总线），`GET /api/v1/events`（SSE 端点，EventSource 可消费）
  - 事件格式对齐 09 篇 §4：`{id, type, payload, timestamp}`，id 为主键游标语义（10 篇 §6 同源）
  - 支持 `since` 参数（断线续拉，EventSource lastEventId）——Phase 1 先打通通道与游标，事件类型注册表预留
  - 心跳/注释事件（SSE 保活）
  - 单测：SSE 连接、事件广播、since 续拉

  **Must NOT do**:
  - 不实现具体业务事件（chat.message.new 等 Phase 2）
  - 不用 WebSocket（08 篇 §2.2 SSE 决策）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: SSE 基座（游标/续拉/保活）需严谨设计
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 后端轨道（with 8-17,19）
  - **Blocks**: 20
  - **Blocked By**: 3

  **References**:
  - 09 篇 §4（SSE 事件设计：事件格式、id 游标、since、心跳）
  - 10 篇 §6（消息历史与游标同源语义）
  - 08 篇 §2.2（SSE 选型：EventSource 自动重连 + lastEventId 续拉）

  **Acceptance Criteria**:
  - [ ] `cd server && npm run test` 含 SSE 单测通过
  - [ ] curl 验证 SSE 端点返回 `text/event-stream` + 事件格式
  - [ ] since 续拉返回遗漏事件

  **QA Scenarios**:
  ```
  Scenario: SSE 通道 + 广播 + 续拉（curl）
    Tool: Bash
    Steps:
      1. `curl -N http://localhost:3000/api/v1/events` → 返回 text/event-stream，收到事件行（id/type/payload）
      2. 另一终端触发广播（测试端点/直接 emit）→ 订阅端收到事件且 id 递增
      3. `curl "http://localhost:3000/api/v1/events?since=<lastId>"` → 返回 lastId 之后事件
    Expected Result: 事件流 + 游标续拉可用
    Evidence: .omo/evidence/task-18-sse.md

  Scenario: 心跳保活
    Tool: Bash
    Steps:
      1. curl -N 观察 15s → 收到周期性注释/心跳事件
    Expected Result: 连接保活
    Evidence: .omo/evidence/task-18-heartbeat.md
  ```

  **Commit**: YES
  - Message: `feat(server): RealtimeModule SSE 基座（游标/续拉）`
  - Files: server/src/realtime
  - Pre-commit: `cd server && npm run test`

- [x] 19. OpenAPI 契约（swagger 全端点）

  **What to do**:
  - 用 @nestjs/swagger 生成 OpenAPI：全部已实现端点（auth/users/projects/health）带 DTO schema
  - `GET /api/v1/docs`（Swagger UI）+ `GET /api/v1/docs-json`（契约 JSON）
  - DTO 用 class-validator 校验装饰器对齐 09 篇字段（login/register/project 等）
  - 导出契约 JSON 到 `.omo/evidence/api-contract.json`（前后端联调锚点）

  **Must NOT do**:
  - 不实现未完成的端点（Phase 2+）
  - 不手写 schema（用装饰器自动生成）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 标准 swagger 配置 + DTO 装饰
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 后端轨道（with 8-18）
  - **Blocks**: 20
  - **Blocked By**: 15-17

  **References**:
  - 09 篇 §1/§2（API 契约字段与通用约定——DTO 字段来源）
  - 08 篇 §2.1（OpenAPI 选型：@nestjs/swagger）

  **Acceptance Criteria**:
  - [ ] `curl localhost:3000/api/v1/docs-json` → 合法 OpenAPI JSON（含已实现端点）
  - [ ] Swagger UI 可访问
  - [ ] 契约 JSON 已导出到 .omo/evidence/

  **QA Scenarios**:
  ```
  Scenario: OpenAPI 契约生成
    Tool: Bash
    Steps:
      1. `curl -s http://localhost:3000/api/v1/docs-json | python3 -m json.tool` → 合法 JSON
      2. 断言 paths 含 /auth/login /auth/register /projects /users /health
      3. 断言 login 请求 schema 含 username/password
    Expected Result: 契约完整
    Evidence: .omo/evidence/task-19-openapi.md
  ```

  **Commit**: YES
  - Message: `feat(server): OpenAPI 契约（swagger）`
  - Files: server/src（swagger 配置）
  - Pre-commit: `cd server && npm run build`

- [x] 20. 前后端联调（登录→项目→导航，M1）

  **What to do**:
  - 联调环境：web dev（3000）+ server dev（3000 或 proxy）；配置 web 到 server 的 API 代理（next.config rewrites 或环境变量 baseURL）
  - 跑通 M1 主流程：登录（真实 JWT）→ 项目列表（真实数据）→ 全局导航跳转
  - 修复联调问题（CORS/代理/token 传递）
  - 产出 M1 验收证据：全流程截图 + 数据流说明

  **Must NOT do**:
  - 不改前端视觉来适配接口（先修后端/适配层）
  - 不实现 Phase 2 功能

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 前后端联调排障
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（联调收口）
  - **Parallel Group**: Wave 3
  - **Blocks**: 21, 22
  - **Blocked By**: 11, 15（以及 10/12-14/16-19 尽量完成）

  **References**:
  - 09 篇 §2（API 通用约定：baseURL/token/错误）
  - Task 7（api.ts 封装）、Task 11/12（登录与项目页）

  **Acceptance Criteria**:
  - [ ] 登录 → 项目列表 → 导航 全流程可用（真实数据）
  - [ ] 控制台无网络错误（除预期 401）
  - [ ] M1 验收证据齐全

  **QA Scenarios**:
  ```
  Scenario: M1 主流程（Playwright）
    Tool: Playwright
    Preconditions: server + web 起，seed admin/项目
    Steps:
      1. 访问 /login，填 admin 凭证登录 → 跳 /projects
      2. 断言项目列表渲染 seed 数据
      3. 点击导航项（board/agents 等）→ 页面跳转 + 导航高亮
      4. 刷新 /projects → 会话保持（token 持久化）
    Expected Result: M1 全流程通过
    Evidence: .omo/evidence/task-20-m1-flow.png

  Scenario: 网络与代理
    Tool: Bash
    Steps:
      1. 浏览器网络面板无 CORS/代理错误（或已修复记录）
    Expected Result: 无网络错误
    Evidence: .omo/evidence/task-20-net.md
  ```

  **Commit**: YES
  - Message: `feat: M1 联调（登录→项目→导航）`
  - Files: web/next.config.* web/.env.local 等
  - Pre-commit: `cd web && npm run build`

- [x] 21. 原型一致性验收（4 页截图对比）

  **What to do**:
  - 对 4 个迁移页（login/project-list/task-create/task-board）逐页执行实现 vs 原型截图对比（Playwright 双开截图 + 像素/结构比对）
  - 对比维度：布局结构、token（颜色/字号/间距）、data-testid、交互形态
  - 产出对比报告 `.omo/evidence/prototype-parity-report.md`（每页 PASS/FAIL + 差异截图）
  - 差异项修复（优先修实现侧对齐原型，除非差异源于原型缺陷需用户确认）

  **Must NOT do**:
  - 不得为通过对比而修改原型文件（原型是基准）
  - 不得放宽对比标准（token 零改动是硬约束）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 视觉对比与差异分析
  - **Skills**: [`playwright`]

  **Parallelization**:
  - **Can Run In Parallel**: NO（验收收口）
  - **Parallel Group**: Wave 3
  - **Blocks**: 22
  - **Blocked By**: 20（联调完成基础上验收）

  **References**:
  - `docs/agent-platform/prototypes/` 4 个对应页（基准）
  - Task 8-14 迁移产物

  **Acceptance Criteria**:
  - [ ] 4 页全部 PASS（视觉一致）
  - [ ] 对比报告存在，差异项全部解决或用户确认豁免

  **QA Scenarios**:
  ```
  Scenario: 逐页对比
    Tool: Playwright
    Steps:
      1. 对每页：开 web 实现 + 原型（5177），同尺寸截图
      2. 像素 diff + 结构断言（data-testid 存在性）
      3. 记录 PASS/FAIL + diff 图
    Expected Result: 4 页 PASS
    Evidence: .omo/evidence/prototype-parity-report.md + 各页 diff 图

  Scenario: token 一致性复检
    Tool: Bash
    Steps:
      1. 对比 tokens.ts 与 styles.ts → 零 diff（复检 Task 8）
    Expected Result: token 零改动
    Evidence: .omo/evidence/task-21-tokens-recheck.md
  ```

  **Commit**: YES
  - Message: `test: 原型一致性验收（4 页 PASS）`
  - Files: .omo/evidence/
  - Pre-commit: 无

- [x] 22. 构建/测试全量验证（M0/M1 证据汇总）

  **What to do**:
  - 全量验证：`cd server && npm run test && npm run build`、`cd web && npm run build`
  - 汇总 M0/M1 证据清单到 `.omo/evidence/m0-m1-summary.md`（脚手架/健康检查/登录联调/原型一致 4 项证据引用）
  - 检查无 Phase 2+ 功能泄漏（grep 任务状态机/群聊/Agent 等关键词在代码中不出现业务实现）

  **Must NOT do**:
  - 不新写功能（纯验证汇总）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 验证命令执行 + 证据汇总
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（最终验证）
  - **Parallel Group**: Wave 3
  - **Blocks**: F1-F4
  - **Blocked By**: 20, 21

  **References**:
  - Task 2/3/15-19（各任务证据）
  - 18 篇 §5（M1 定义）

  **Acceptance Criteria**:
  - [ ] server test/build 全过
  - [ ] web build 全过
  - [ ] M0/M1 汇总文档齐全

  **QA Scenarios**:
  ```
  Scenario: 全量门禁
    Tool: Bash
    Steps:
      1. `cd server && npm run test` → 全过
      2. `cd server && npm run build` → 退出码 0
      3. `cd web && npm run build` → 退出码 0
      4. 检查 m0-m1-summary.md 含 4 项验收证据
    Expected Result: 全部门禁通过
    Evidence: .omo/evidence/task-22-gates.md
  ```

  **Commit**: YES
  - Message: `test: M0/M1 全量验证与证据汇总`
  - Files: .omo/evidence/
  - Pre-commit: 无

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 个评审 agent 并行，全部 APPROVE。汇总结果给用户，获明确确认后完成。

- [x] F1. **Plan Compliance Audit** — `oracle`
  对照本计划 Must Have/Must NOT Have 逐项检查实现；检查证据文件存在；前端 token 零改动验证（styles.ts vs tokens.ts diff）。
  输出: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  `cd server && npx tsc --noEmit && npm run test`；`cd web && npm run build`；检查 `as any`/@ts-ignore/空 catch/console.log/注释代码/未用 import。
  输出: `Build [PASS/FAIL] | Tests [N pass/N fail] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ playwright skill)
  从干净状态执行每个任务的 QA 场景；重点：4 页实现 vs 原型截图对比（逐 token/布局/data-testid）；登录→项目→导航全流程。证据存 `.omo/evidence/final-qa/`。
  输出: `Scenarios [N/N pass] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  每任务读 "What to do" 与实际 diff 核对 1:1；确认无 Phase 2+ 功能泄漏；无跨任务污染。
  输出: `Tasks [N/N compliant] | VERDICT`

---

## Commit Strategy

- **1-7 (Wave 1)**: `chore(init): 项目脚手架与 Prisma 初始化` - web/ server/ 根文件
- **8-10**: `feat(web): 共享组件库与导航体系迁移（token 零改动）` - web/src/components
- **11**: `feat(web): 登录页迁移（原型一致）` - web/src/app/login
- **12**: `feat(web): 项目列表页迁移` - web/src/app/projects
- **13**: `feat(web): 任务创建页迁移` - web/src/app/tasks/new
- **14**: `feat(web): 任务看板页迁移` - web/src/app/board
- **15-19**: `feat(server): Auth/Users/Projects/SSE 基座与 OpenAPI` - server/src
- **20-22**: `feat: M1 联调与原型一致性验收` - 证据

---

## Success Criteria

### Verification Commands
```bash
cd server && npm run test        # 期望: 关键模块单测全过
cd server && npm run start:dev & curl http://localhost:3000/api/v1/health   # 期望: 200
cd web && npm run build          # 期望: 退出码 0
# playwright 截图对比 4 页（实现 vs 原型）期望: 视觉一致 PASS
```

### Final Checklist
- [ ] 前端 4 页与原型逐页视觉一致（token/布局/data-testid）
- [ ] 后端 Auth/Users/Projects/SSE 基座可运行、单测通过
- [ ] M0/M1 证据齐全
- [ ] 无 Phase 2+ 功能泄漏
