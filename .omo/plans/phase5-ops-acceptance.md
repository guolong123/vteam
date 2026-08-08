# Phase 5：运维与收尾（M5）

> 规划依据：18 篇 §9（551-588 行）+ 用户决策 1A/2A/3B/4A/5A + Metis 规划验证（7 必改点）+ Oracle 实测验证（Docker/MySQL/standalone 全通过 + worker 网络拓扑 1 处调整）
> 用户决策：1A（Git 首次提交+分支+PR 基线）2A（补迁移 2 页，17 页全量）3B（性能双线）4A（git.op 审计+JSON 日志）5A（docker compose 实跑）

## 目标（M5 验收标准，18 篇 §9.5）

**M5 = 可交付验收**：docker compose 一键部署跑通；性能指标达标（双线）；17 页原型终检通过；审计走查无阻断项；移交测试环境。

## 架构决策（已采纳验证结论）

### D1. Git 基线（Metis 必改点 1 + Oracle 实测）
- **前置事实**：`git remote` 为空、仅 master 分支、.gitignore 未忽略 `server/prisma/dev.db`（544KB 二进制会被提交！）、根目录 99 个验证截图 PNG 未归置
- T0 步骤：① 补 .gitignore（dev.db、*.tsbuildinfo、coverage、根 PNG 移入 .omo/evidence/）② 确认/创建 xishuhq/aiagents 仓库与 develop 分支 ③ add remote xishuhq + ketabot ④ `checkout -b feature/phase-5 xishuhq/develop` ⑤ 全量一次提交 ⑥ 推 ketabot → PR 到 xishuhq/develop（head=`ketabot:feature/phase-5`，AGENTS.md 规范）
- **F4 零污染基准重定义**：T0 之后核算 `git diff T0-commit..HEAD`（只查 T1-T11 引入），首次提交的巨大 diff 是基线不算污染

### D2. worker 网络拓扑调整（Oracle 实测唯一必改，server 零改动）
- **问题**：worker serve 固定 `SERVE_HOSTNAME='127.0.0.1'`（D2 铁律）；capabilities 只报 port 不报 baseUrl；server `resolveBaseUrl` 拼 `http://localhost:<port>`——容器化后解析到 server 容器自身，serve 在 worker 容器回环不可达
- **修复（2 处小改，均在 worker 侧）**：
  1. `opencode-server.ts`：serve hostname env 化（`OPENCODE_SERVE_HOSTNAME` 默认 `127.0.0.1` 保住本地铁律，容器内设 `0.0.0.0`）
  2. `buildCapabilities`：新增上报 `baseUrl = ${WORKER_ADVERTISE_HOST}:${port}`（新增 `WORKER_ADVERTISE_HOST` env，compose 里 `http://worker`）
- server `resolveBaseUrl` 已优先读 capabilities.baseUrl，无需改

### D3. MySQL 迁移（Oracle 实测通过）
- schema 已双库可移植（Json 列/无 enum/无 native type，schema.prisma:10-18 注释）；仅需 provider 改 mysql + 连接串
- 实测：临时 MySQL 8 + provider=mysql → `prisma migrate dev --name init` 一次成功（20 表，utf8mb4）、seed.ts 直接跑通
- 注意：migrate dev 需 shadow database 权限（root）；dev.db 数据丢弃（seed 可重建）；会重写 node_modules/@prisma/client（无碍）

### D4. Docker 镜像（Oracle 实测）
- server：`node:22-alpine` → npm ci → nest build → `NODE_ENV=production node dist/main`；**snapshot:true 非必须**（仅 Devtools 用）；健康检查端点 `/api/v1/health` 已就绪
- web：next.config.ts 加 `output: 'standalone'`（18 篇 §9.1 硬性要求，实测 build 成功且 standalone server 200）；**standalone 产物不含 .next/static 与 public，Dockerfile 需额外 COPY**；standalone 与 dev --turbopack 无冲突
- worker：双阶段（build TS → `npm i -g opencode-ai@1.18.15` + node dist/index.js）；opencode CLI = npm 包 opencode-ai@1.18.15（与宿主/SDK 版本一致）

### D5. docker-compose 四服务（Oracle 编排方案）
- db（mysql:8 + volume + healthcheck `mysqladmin ping`）/ server（depends_on db healthy + `DATABASE_URL=mysql://db:3306/aiagents` + `WORKER_BASE_URL` 兜底 + healthcheck `/api/v1/health`）/ web（standalone + `API_PROXY_TARGET=http://server:3000` + healthcheck `/`）/ worker（同网络 + `WORKER_ADVERTISE_HOST=http://worker`）
- 端口：server 3000、web 映射 3001（standalone 默认 3000 冲突）
- **next.config.ts rewrites 环境变量化**：`API_PROXY_TARGET` 容器内指向 server 服务名（Metis 必改点 5）
- 数据持久化：MySQL volume + artifacts 文件存储 volume（若 StorageModule 本地文件系统）

### D6. 审计（4A + Metis 必改点 2）
- **git.op 上报前置缺口**（Metis 关键发现）：`installGitTools` **生产代码未接线**（index.ts 只 import GIT_TOOLS 做 capabilities，git 工具实际未注入 serve）——T6 必须先修
- **上报架构难点**：git 工具 execute 在 opencode 插件进程内执行，worker 进程感知不到执行时机——T6 加 30 分钟 spike 验证上报路径（生成代码内嵌回调 vs SDK 事件订阅），再定实现；且补 taskId 从工具调用上下文带出的设计
- pino JSON：main.ts 现有 pinoHttp 仅 HTTP 层，业务日志改 JSON 结构化（nestjs-pino 或 logger 包装）

### D7. 原型终检（2A）
- 待迁移 2 页：skills-tools-manage（/skills 占位→全量，20 testid，路径 `web/app/(main)/skills/page.tsx`——**web 是根 app/ 非 src/app**，Metis 必改点 6）+ tool-register（独立路由 `(main)/tools/register`，56 testid 拆 T5a 结构/T5b 交互，Metis 必改点 3：先探明后端 Tool CRUD API 是否存在再定 mock/补后端）
- 原型审计报告位置对齐：.omo/evidence/prototype-audit.md → 复制/引用至 docs/agent-platform/（Metis 必改点 7）
- 可用性 ≥99.5% 冒烟归口（Metis 必改点 4）：并入 T8 性能脚本

## 任务分解（T0-T11 + F1-F4）

- [ ] T0 Git 基线：.gitignore 补全（dev.db/tsbuildinfo/coverage/根 PNG 归置）→ remote 确认/创建 → feature/phase-5 分支 → 全量一次提交 → 推 ketabot → PR 基线
- [ ] T1 Dockerfile 双镜像：next.config.ts standalone + rewrites 环境变量化 + server/Dockerfile + web/Dockerfile（含 static/public COPY）
- [ ] T2 MySQL 迁移：schema provider 改 mysql + prisma migrate dev --name init 首次基线 + seed 在空 MySQL 跑通（shadow DB 权限）
- [ ] T3 worker 网络调整 + worker Dockerfile：serve hostname env 化 + capabilities.baseUrl 上报（WORKER_ADVERTISE_HOST）+ worker/Dockerfile（npm i -g opencode-ai@1.18.15）
- [ ] T4 skills-tools-manage 页迁移：web/app/(main)/skills/page.tsx 占位→全量（20 testid）
- [ ] T5 tool-register 页迁移：T5a 独立路由+5 区块表单静态结构（~26 testid）→ T5b 4 执行形态+交互+数据对接（~30 testid）；前置探明后端 Tool CRUD API
- [ ] T6 git.op 审计事件：修 installGitTools 接线 → spike 上报路径 → worker 上报 + server ingress git.op 分支 + task_events 落库（metadata Json：agent/repo_url/action/exit code）
- [ ] T7 pino JSON 结构化日志：业务日志 JSON 化（nestjs-pino 或 logger 包装）
- [ ] T8 性能计时脚本（3B 双线 + 可用性冒烟）：群聊≤1s/首字双线 15s-5s/会话流≤2s/4-6 Agent 并发 + ≥99.5% 冒烟，产出 JSON
- [ ] T9 Playwright QA 套件：配置 + 17 页 testid 断言 + 性能 E2E
- [ ] T10 原型终检：17 页三维度对比（token/布局/testid）+ 报告落盘 docs/ + 审计报告位置对齐
- [ ] T11 docker compose 实跑 + 权限矩阵走查：四容器 up 全 healthy + 三守卫拦截验证 + 审计基线汇总
- [ ] F1 计划合规审计（oracle）
- [ ] F2 代码质量审计（oracle）
- [ ] F3 QA：compose 实跑 + 性能计时 + 17 页断言 + 容器内真实会话（oracle/qa）
- [ ] F4 零污染：git diff T0..HEAD 核算 + 工作区残留检查

## 并行/串行依赖
```
T0（Git 基线，唯一硬前置）
├── 轨① T1(Dockerfile) → T3(worker 调整+镜像) → T11(compose 实跑)
├── 轨② T2(MySQL 迁移) → T11
├── 轨③ T4(skills) ‖ T5(tool-register)
├── 轨④ T6(git.op) ‖ T7(pino JSON)
└── 轨⑤ T8(性能脚本)
T9(Playwright) ← T4/T5 → T10(终检) → F1-F4
```
- 并行：T1/T2/T4/T5/T6/T7/T8 在 T0 后全并行；串行链 T1→T3→T11、T4/T5→T9→T10

## 验证环境（Oracle 实测）
- Docker 29.1.3 + Compose v5.1.0 ✅；内网镜像源 docker.ketaops.cc ✅；mysql:8 已拉取 ✅
- 本机已有 4 容器运行（nats/postgres/opencode-serve/buildx），healthcheck 模式可复用

## 启动指令（/start-work 执行时）
1. **激活 boulder**：更新 `.omo/boulder.json` → `active_work_id: "phase5-ops-acceptance-0a1b2c3d"`，新增 works 条目（plan_name=phase5-ops-acceptance, status=in_progress）
2. **T0 先行**（唯一硬前置）：Git 基线——.gitignore 补 dev.db/tsbuildinfo/coverage/根 PNG 归置 → 确认 xishuhq/aiagents 仓库与 develop 分支 → add remote xishuhq+ketabot → checkout -b feature/phase-5 xishuhq/develop → 全量一次提交 → 推 ketabot → PR 到 xishuhq/develop
3. **并行轨**（T0 后）：T1(Dockerfile) ‖ T2(MySQL 迁移) ‖ T4(skills) ‖ T5(tool-register) ‖ T6(git.op) ‖ T7(pino JSON) ‖ T8(性能脚本)
4. **串行链**：T1→T3(worker 调整)→T11(compose 实跑)；T4/T5→T9(Playwright)→T10(终检)
5. **F1-F4 Final Wave**：T0 提交后核算 `git diff T0..HEAD`（F4 零污染基准）
6. 每任务完成后勾选计划复选框 + 追加 .omo/notepads/phase5-ops-acceptance/learnings.md
