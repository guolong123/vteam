# Phase 3 M3 里程碑验收证据汇总（Agent 与产出物）

> 日期：2026-08-07 ｜ 计划：`.omo/plans/phase3-agent-artifacts.md`（T1-T16 完成，T17 收口）
> 对照：`docs/agent-platform/18-推进计划（分阶段实施）.md` §7.6 可验收功能清单（A 后端 12 项 / B 前端 5 项 / C 端到端 4 项）
> 验收方式：后端 curl + jest 断言、前端 Playwright testid + 截图、门禁命令 exit 0

## 1. 功能交付清单（§7.6 对照）

### A. 后端可验收功能（12/12）

| # | 功能 | 实现要点 | 验收 |
|---|------|---------|------|
| A1 | Agent 列表与详情 | GET /agents 分页 + type 过滤 + skillIds/toolEffects/permissionScope/defaultModelId；GET /agents/:id 完整关联 | curl 字段齐全 ✓ |
| A2 | 自定义 Agent 创建 | POST /agents（custom）三表同事务（agents + agent_skills + agent_tool_effects） | curl 201 + 查表三表齐全 ✓ |
| A3 | Agent 克隆 | POST /agents/:id/clone 深拷贝（baseAgentId 血缘、与源解耦） | curl 血缘 + 改副本不影响源 ✓ |
| A4 | 更新/删除权限 | PATCH/DELETE 模板 403 `PERMISSION_AGENT_READONLY`、custom 可写可删 | curl 403 / 200 ✓ |
| A5 | available-models 静态占位 | GET /agents/:id/available-models 返回静态模型数组 | curl 200 数组 ✓ |
| A6 | 会话状态机 | 任务启动 sessions created→active（CAS 事务 afterCommit，不误动 frozen） | curl 启动 + DB 直查 active ✓ |
| A7 | 产出物协议校验 | validateArtifactDeclaration（type 枚举 + 交叉必填）；非法回退普通消息不归档 | curl 非法不落库 ✓ |
| A8 | 归档链路 | artifact.submitted 消费；append 版本递增 + sha256 幂等去重 | curl 重复不增 / 改内容递增 ✓ |
| A9 | 文档库端点 | GET /tasks/:id/artifacts（type/accepted 筛选 + 分页）、GET /artifacts/:id、GET /artifacts/:id/versions/:version | curl 筛选正确 + 版本字段完整 ✓ |
| A10 | 验收联动 | accept 标记 accepted_flag；已验收写 409 `ARTIFACT_ACCEPTED_IMMUTABLE`；验收后 append 退回 in_progress + 广播 | curl + jest 状态断言 ✓ |
| A11 | 用户管理端点 | POST /users、POST /users/:id/reset-password；AdminGuard 拦截 | curl 创建/重置 + 非 admin 403 ✓ |
| A12 | 角色矩阵 CRUD | GET/POST/PATCH/DELETE /roles；预置角色只读 403 `FORBIDDEN_BUILTIN_ROLE` | curl 自定义 CRUD + 预置 403 ✓ |

### B. 前端可验收功能（5/5）

| # | 功能 | 实现要点 | 验收 |
|---|------|---------|------|
| B1 | /agents | agent-config 原型迁移（左列表 + 右五块配置 + 模板只读态 + 克隆闭环） | Playwright testid + 只读 + 克隆 ✓ |
| B2 | /users | user-management 原型迁移（统计条 + 列表 + 新增弹层 + 禁用/重置密码） | Playwright user-stats / toggle / 提交 ✓ |
| B3 | /roles | role-permission 原型迁移（8×6 矩阵 + 自定义角色 CRUD）+ Dock 第 7 项「角色权限⚖」 | Playwright 矩阵渲染 + Dock 7 项 ✓ |
| B4 | /artifacts?pid= | 产出物管理聚合页（任务/类型/验收状态三筛默认全部 + 验收徽章 + 版本查看器 + 空态） | Playwright 27/27 三筛联动 + 版本切换 + 空态 ✓ |
| B5 | 产出物入口 | 看板「产出物」按钮 + 项目卡片次级入口（stopPropagation）+ 群聊页 artifact-link 跳转 → /artifacts?pid= | Playwright 三入口 URL 5/5 ✓ |

### C. M3 端到端验收（4/4）

| # | 功能 | 结果 |
|---|------|------|
| C1 | 完整主流程：克隆 Agent → 创建任务选 Agent → 启动 → mock 产出 → 归档 → 聚合页 → 验收闭环 | 闭环跑通 ✓ |
| C2 | 聚合页 SSE 实时性（artifact.submitted → 前端订阅刷新） | 事件链路验证 ✓ |
| C3 | 回归：Phase 0-2 任务创建/团队/群聊/SSE/看板不回归 | jest 全量 + Playwright 冒烟 ✓ |
| C4 | 全量门禁：server test+build / web tsc+build；无 Phase 4 泄漏（worker 调度/真实 LLM） | 全部 exit 0 ✓ |

## 2. 测试结果

### 后端（server/）
- `npx jest --no-cache --runInBand --silent` → **22 suites / 281 tests 全绿**（Phase 2 基线 201 → +80：agents 25 + artifacts 26 + users 30 + realtime 扩展等）
- `npm run build` → exit 0
- 零 DDL（Artifact/ArtifactVersion/Session/Role 表复用既有 schema）

### 前端（web/）
- `npx tsc --noEmit` → exit 0
- `npm run build` → exit 0（15 静态页面含 /agents /users /roles /artifacts 四新页）
- Playwright 冒烟：/artifacts 聚合页 27/27、三入口跳转 5/5、/users CRUD、/roles 矩阵 + Dock 7 项、/agents 只读 + 克隆

## 3. M3 端到端场景

```
登录 admin/admin123
  → /agents 克隆模板（POST /agents/a_product/clone）→ baseAgentId 血缘 → 改克隆体编辑
  → 创建任务选 Agent（agentIds + mainAgentId）→ 启动（sessions created→active）
  → mock 产出归档：POST /tasks/:id/artifacts（text v1 → 同内容幂等 duplicate → 改内容 v2）
  → /artifacts?pid= 聚合页：任务/类型/验收状态三筛 + 验收徽章（已验收绿/未验收灰）+ 版本查看器（‹ v1 › + 时间线）
  → 看板「产出物」按钮 → /artifacts?pid= 跳转
  → mark-pending-review → accept → accepted_flag=true + 验收徽章更新
  → 已验收版本再写 → 409 ARTIFACT_ACCEPTED_IMMUTABLE
  → 新 title append → 任务退回 in_progress + task.status.changed 广播
```

## 4. 证据文件索引

### 里程碑汇总
- `.omo/evidence/phase3-m3-summary.md`（本文件）
- `.omo/notepads/phase2-task-chat/learnings.md` — Phase 3 各任务 QA 详情与坑（T2-T14 逐条 + 收口总结）

### 后端任务证据（learnings 内联 curl 断言）
- T2 artifact.submitted 事件：`.omo/notepads/phase2-task-chat/learnings.md`「Phase 3 T2 ArtifactsModule 骨架 + artifact.submitted 事件」
- T3 Agent 查询：同文件「Phase 3 T3 AgentsModule 查询扩展」
- T4 sessions active：同文件「Phase 3 T4 任务启动置 session active」（curl 实测 start 后全 active）
- T5 Agent CRUD/克隆/403：同文件「Phase 3 T5 AgentsModule CRUD」（clone 血缘 / PATCH 模板 403 / available-models 3 项）
- T6 归档/幂等/非法：同文件「Phase 3 T6 ArtifactsModule 归档链路」（sha256 幂等 / 400 交叉校验）
- T7 验收联动：同文件「Phase 3 T7 验收联动」（accepted_flag / 409 / 退回 in_progress）
- T8 users/AdminGuard/角色矩阵：同文件「Phase 3 T8」（创建/重置密码/403/预置只读）
- T14 筛选 + 种子：同文件「T14 文档库端点可用性验证 + 种子数据」（type/accepted/分页实测）

### 前端任务证据
- T9 /agents：learnings「Phase 3 T9 前端 /agents 页」（tsc + build exit 0 + 只读/克隆闭环）
- T10 /users：learnings「Phase 3 T10 用户管理页迁移」（Playwright 全链路 testid）
- T11 /roles：learnings「Phase 3 T11 /roles 前端页」（矩阵 + Dock 7 项 + build）
- T12 /artifacts：learnings「Phase 3 T12 /artifacts 产出物聚合页」（Playwright 27/27 + web-iso 隔离解法）
- T13 三入口：learnings「Phase 3 T13 产出物入口改造」（Playwright 5/5）
- T15 M3 端到端、T16 全量门禁：learnings 收口总结（281 tests + build exit 0 复验）

### 门禁复验（T17 实测）
- server `npx jest --no-cache --runInBand --silent` → 22 suites / 281 tests 全绿
- 前端四页文件存在：`web/app/(main)/agents|users|roles|artifacts/page.tsx`
- Dock 7 项：`web/src/components/layout/nav-dock.tsx` NAV_ITEMS 含 `roles: 角色权限`

## 5. 环境状态

- dev.db：seed 项目/Agent/用户保留；T14 种子产出物保留（t_0000000002/t_0000000004 供联调）
- server 3000 / web 3001 运行中（.next 已恢复用户环境）
