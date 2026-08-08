# Draft: Phase 5 运维与收尾（M5）

## 背景
- Phase 0-4 完成（M0-M4：脚手架→基础框架→任务群聊→Agent产出物→真实会话）
- 18 篇 §9 定义 Phase 5 = **运维与收尾**，M5 可交付验收：
  - 9.1 部署方案（单机 + Docker Compose：server/web/MySQL8/worker 四容器）
  - 9.2 审计基线（task_events + pino 结构化日志 + 权限矩阵走查）
  - 9.3 性能验收（群聊≤1s / @首字≤5s / 会话流≤2s / 4-6 Agent 并行 / 可用性≥99.5%）
  - 9.4 原型一致性终检（17 页逐页对比，以 Phase 0 审计报告为基准）
- M5 = docker compose 一键部署跑通 + 性能达标 + 17 页终检通过 + 审计无阻断 + 移交测试环境

## 调研结论（explore 已出，.omo/drafts 落盘）
### A. 部署现状
- server：NestJS 10 + Prisma 6 + pino；非 standalone；**无 Dockerfile**
- web：Next.js 15.5.22；next.config.ts 仅 rewrites 代理；**无 standalone 输出、无 Dockerfile**
- DB：SQLite（dev.db）；schema 双 provider 注释（生产 MySQL 改 provider 即可）；**无 migrations 目录**（无 MySQL 迁移基线）
- env：server/.env 未提交、无 .env.example；WORKER_TOKEN 默认 dev 值
- **docker-compose 零存在**

### B. 原型终检
- 17 原型页 = 14 业务页 + 3 导航变体（与 18 篇 §9.4 一致）
- 前端实现映射：13 页已迁移（login/projects/tasks/board/messages/agents/workers/users/roles）
- **2 页未迁移**：skills-tools-manage（/skills 是 14 行占位 EmptyState，20 testid）、tool-register（无路由未迁移，56 testid 最多）
- 2 页收敛实现：worker-install（/workers 折叠面板）、task-detail（/tasks/[id] + /artifacts）
- 导航：当前 nav-hybrid 融合；nav-rail/nav-cmdk 原型保留无切换入口
- Phase 0 审计报告在 .omo/evidence/prototype-audit.md（17 页 testid 全清单，计划文档说存 docs/ 路径不一致）

### C. 性能基线
- SSE 心跳 15s、消息轮询兜底、前端 SSE 单例均已实现
- **无量化基线**：无压测脚本；唯一实测 = phase4-f3-recheck（首字 5016ms 接近 5s 目标线，D8 通过线 15s）
- 群聊≤1s / 会话流≤2s / 4-6 Agent 并行 / 可用性≥99.5% 均无数据
- QA 工具链：无 Playwright 配置、web 无 jest 测试

### D. 审计基线
- task_events 4 类事件（status_change/accept/reject/archive）
- **git.op / permission.request 未实现**（worker 6 事件类型无此二类，17 篇 §8.2 承诺未落地）
- pino 仅 HTTP 层，业务日志文本格式，无 JSON 结构化
- 权限矩阵三标记（Admin/ProjectMembership/WorkerToken）已接线 + spec 覆盖 ✅

### ⚠️ 最大前置风险
- **Git 基线几乎为空**：git ls-files 仅 5 个文件，server/web/worker/docs 全部未跟踪！18 篇 §1.3 要求分支推进——M5 验收前必须首次提交

## Phase 5 资产差距清单
1. **部署**：server/web Dockerfile + docker-compose.yml（四服务）+ MySQL 迁移基线 + server/.env.example + Git 首次提交
2. **原型**：skills-tools-manage 页迁移（20 testid）+ tool-register 页迁移（56 testid）+ 终检对比口径
3. **性能**：四项指标计时脚本 + Playwright QA 套件
4. **审计**：git.op/permission.request 事件落地 + pino JSON 结构化 + 权限矩阵走查

## 待用户确认（采访）
- [x] **1A**：Phase 5 开头 Git 首次提交——feature/phase-5 分支（基于 xishuhq/develop），全部代码一次提交，推 ketabot → xishuhq/develop PR 基线
- [x] **2A**：补迁移 skills-tools-manage（20 testid）+ tool-register（56 testid）两页，17 页全量达标
- [x] **3B**：性能双线——通过线按 18 篇 D8（首字 15s），目标线按 05 篇（5s）；QA 记录两值，超目标线不阻断
- [x] **4A**：git.op 事件落 task_events（worker git 工具执行上报）+ pino JSON 结构化日志，审计基线闭环（credentials/repo_grants 表 + ask 流本身不在本轮，仅审计事件）
- [x] **5A**：docker compose 实跑（MySQL 8 + server + web + worker 四容器），真起容器验证 M5

## 决策影响
- 1A → T0 前置任务：首次 git 提交 + 分支 + PR 基线（AGENTS.md 规范）
- 2A → 原型终检任务含 /skills 全量迁移 + tool-register 页新增 + 路由挂接
- 3B → 性能 QA 双线记录（通过线 15s/目标线 5s 等），自动化计时脚本
- 4A → git.op 事件：worker git-tools execute 上报 → server ingress 消费 → task_events 落库；pino JSON 结构化（nestjs-pino 或统一 logger）
- 5A → docker-compose.yml 四服务 + MySQL 迁移基线 + server/web Dockerfile + env 清单
