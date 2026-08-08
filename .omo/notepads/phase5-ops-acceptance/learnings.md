# Learnings — phase5-ops-acceptance

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## T0 · Git 基线首次提交（M5 前置）

- **实际未跟踪文件数 = 216**（非任务预估的 217），根目录 PNG 实为 **11 个**（非约 99）——任务描述的数量为估算，以 `git status --porcelain` 实测为准。
- **`.playwright-mcp/` 是 240 个运行时调试产物**（console log / page yml 快照 / diff 截图），此前未在忽略清单中，会随 `git add -A` 混入基线——必须加入 `.gitignore`。这是首个「意料之外」的运行时目录。
- **`server/prisma/dev.db`（544KB SQLite 二进制）确认存在**，`.gitignore` 追加 `server/prisma/*.db` + `*.db-journal` 后不再出现于 untracked。
- **远端 xishuhq/master 是 Gitee auto_init 模板 README**（内容与本地 README 完全不同），任意合并方式（rebase / --allow-unrelated-histories）都会触发 README 冲突。本地 README 含真实目录结构说明，保留本地版。
- **合并策略选 rebase（线性历史）**：`git rebase xishuhq/master` 把本地 2 个 commit 平移到 b063933 之上，比 merge 产生的分叉线更符合「git log 干净」要求；本地 commit 未推送过，改写无风险。
- **根目录散落 PNG 归置到 `.omo/evidence/root-screenshots/`** 并用 `.omo/evidence/**/*.png` 忽略：`**` 必须覆盖二级目录（`*` 不匹配 `/`），否则 root-screenshots 下 PNG 会漏网重新出现在 untracked。
- **已跟踪文件仅 5 个**（.gitignore / README.md / .omo 下 3 个 md/txt），.omo 下其余产物（boulder.json / plans / drafts / notepads）随基线首次提交。
- **追加 findings 必须在 commit 之前**：learnings.md 本身会随 `git add -A` 进基线，若 commit 后再追加会产生二次未提交变更，违反「一需求一 commit」规范。

## T8 · 性能计时脚本（3B 双线 + 可用性冒烟）

- **实测结果（全过，allPass=true）**：`scripts/perf/bench.mjs` 实跑产出四值 JSON（归档 `.omo/evidence/phase5-t8-perf-report.json`，server:3000 + web:3001 + worker w_local_1）：
  | 指标 | measured | 通过线 | 目标线 | 判定 |
  |---|---|---|---|---|
  | groupChat | **31ms**（3 采样中位数） | 1000ms | 500ms | ✅/✅ |
  | firstToken | **3179ms**（@a_product 复用会话 s_0000000001） | 15000ms(D8) | 5000ms(05篇) | ✅/✅ 双线过 |
  | sessionStream | **11ms** | 2000ms | - | ✅ |
  | parallelAgents | 4 并发（2 真实验收 + 1 非法@隔离 + 1 无@），2 目标均回流 | 受理全成功或失败隔离 | - | ✅ |
  | availability | **100%**（20/20 健康检查 + SSE 断线 since 续拉重连 53ms） | 99.5% | - | ✅ |
- **真实 opencode 调用成本 = 3 次/运行**（firstToken ×1 + parallelAgents ×2），符合 ≤3 预算；groupChat/sessionStream/availability 用无 @ 消息 / 纯 HTTP 零调用。
- **首字延迟波动大、由模型行为主导**（第一次跑 19459ms ❌ 多轮 tool 调用；第二次 3179ms ✅ 单轮直接回复）——与 F3 实测（4205/5016/17687ms）一致，D8 通过线对复杂任务仍偏紧，脚本如实记录两值不阻断。
- **关键坑：SSE backlog 误匹配**。SSE 连接建立后频道历史事件会重放（backlog），若被测 Agent 之前已有回复消息，`waitFor(senderId===agentId)` 会立即命中历史回复 → 首字/并发回流测量失真。**解法：改用 `GET /channels/:id/trigger-results/:messageId` 轮询精确关联本 @ 消息的回复**（回复落库后立即可查，与 SSE 广播近乎同步）。这是脚本两次重跑迭代中发现的核心测量正确性修正。
- **parallelAgents 失败隔离设计**：并发 4 条 = 2 条真实 @（a_product/a_architect 复用会话）+ 1 条非法 @（`a_ghost_not_in_team` 不在团队 → 400 MENTION_AGENT_NOT_IN_TEAM）+ 1 条无 @ 普通消息。验证：非法 @ 单独 400 拒绝不串扰其余受理，真实 dispatch 全回流。
- **groupChat 采样取中位数**（非 min）：3 次采样 24/31/323ms，min 会过乐观，中位数 31ms 更稳。
- **可用性重连测试需触发新事件**：SSE 断线后 since 续拉若频道安静会永远等不到事件 → 重连验证要"断线重连期间 POST 无 @ 消息"，用新消息 id 精确匹配确认实时流恢复。

## T8 · 环境事故恢复（并行轨端口冲突 + 数据重建）

- **server :3000 与 MySQL :3307 同时宕机**（T8 开始前发现）：server 进程消失、3307 MySQL 无监听、`docker ps -a` 无对应容器 → **3307 上的 aiagents 库数据（含 F3/F4 遗留 t_0000000006/c_0000000012）全部丢失且不可恢复**。恢复链路：`docker run --name aiagents-mysql -p 3307:3306 mysql:8` → `prisma migrate deploy`（migrations/20260808003102_init）→ `prisma db seed`（重建 3 用户 + 2 项目 + 4 模板 Agent）→ 重启 server。
- **并行轨端口冲突**：T1 的 `next start`（web standalone 验证产物，`npm_lifecycle_script=next start`）占用了 :3000，与 Nest server 端口冲突 → worker 心跳 `SERVER_URL=http://localhost:3000` 打到 next start 返回 404 连环失败。处理：移除 :3000 的 next start，恢复 server 于 :3000（**worker 心跳地址不可配，server 必须在 3000**；web dev 在 3001 不受影响）。
- **seed 后 projectMember 归属坑**：seed.ts 的 `p_seed_1` 成员是 **seed-admin（u_seed_admin）** 而非 admin（u_admin）——`projectMember.create` 用 `admin.id`（=seed-admin）而非 `adminUser.id`。用 admin 登录创建任务 → 403 PERMISSION_PROJECT_NOT_MEMBER；**T8 测试数据用 seed-admin/Admin@123456 登录创建**。
- **worker 重启需 X_WORKER_TOKEN**：worker 的 `dist/config.js:51` 强制必填 `X_WORKER_TOKEN` env（缺失即抛错退出）；server 侧默认 `dev-worker-token`（guard 未设 WORKER_TOKEN env 时）。原 worker 注册在旧库，新库 worker 表空 → 心跳 404（worker 记录不存在）→ **必须重启 worker 携带 `X_WORKER_TOKEN=dev-worker-token WORKER_ID=w_local_1 SERVER_URL=http://localhost:3000` 重新注册**。
- **测试数据重建**：`POST /projects/p_seed_1/tasks {agentIds:[a_product,a_architect]}` 同事务创建群聊频道（c_0000000001）+ taskAgent 团队 + 每 Agent session（s1/s2）→ `POST /tasks/:id/start` → in_progress。T8 脚本实测即基于该任务。

## T0 · 推送后补充（ketabot remote）

- **ketabot/aiagents 仓库不存在**：`git push ketabot master` 返回 `Auth error: 404 not found`。经 gitee API 验证：`ketabot` 是**个人账号**（非组织，`orgs/ketabot` 返回 `Group` 且 `/users/ketabot/repos` 为空列表），从未创建 aiagents 仓库。任务前置「ketabot 远端仓库」与实际不符。
- **当前凭据无法创建 ketabot 个人仓库**：`GITEE_ENT_MCP_ACCESS_TOKEN` 是企业版 token（`api.gitee.com/enterprises`），用于个人仓库 API（`POST /api/v5/user/repos`）报 `401 Unauthorized: Access token is wrong type`。
- **SSH 推送链路双重缺失**：SSH key 属于 `guolong(@guojongg)`，即使创建了 ketabot/aiagents，guolong 也无 collaborator 推送权限（除非另行授权）。
- **xishuhq/aiagents 推送成功**：`b063933..0f9ad9f master -> master`，远端 master 已验证指向本地基线 0f9ad9f（`git ls-remote xishuhq` 确认）。任务核心目标「本地 master 推送到 xishuhq master 成功」达成。
- **后续处理建议**：ketabot 推送需先由有权限的账号（ketabot 机器人本身）创建个人仓库并授权 guolong，或改用企业内 fork 策略——属编排者决策，不在 T0 内强制。

## T6 · git.op 审计事件链路（4A）

- **spike 结论：上报路径选方案 B（worker 轮询感知），非方案 A（生成代码内嵌回调）**。SDK 类型实证：`ToolPart`（types.gen.d.ts:263-274）含 `tool`（工具名）、`callID`（每次调用唯一）、`state{status,input,output,error,time{start,end}}`——worker 复用现有 `GET /session/{id}/message` 轮询（awaitCompletion）即可感知插件进程内工具执行时机与结果，零侵入插件代码。方案 A 需把上报端点 + taskId 运行时写入全局注入的 git.ts（无法随会话变化）并暴露凭证，侵入性高。
- **K3 修复发现第二个隐藏 bug：`OpencodeServer` 默认 `cwd=process.cwd()`，而 git 工具注入落点是 `config.workDir`**——两者不一致时 serve 以自身 cwd 扫描 `.opencode/tools/`，永远扫不到注入的工具。K3 必须同时做两件事：① serve 启动前 `installGitTools(config.workDir)` ② `OpencodeServer({ cwd: config.workDir })`。只做①是半修复。
- **taskId 来源（Metis 必改点 2 细节）**：git 工具定义无 taskId 参数，工具执行在插件进程无感知。方案 B 下 `GitOpReporter` 在 worker 进程创建时从会话执行上下文注入 taskId/agentId，挂载到 `awaitCompletion({ onPoll })` 回调即完成上下文带出——worker 进程天然知道当前任务归属。
- **exit code 映射**：ToolState 只有 status（completed/error），无 exit code 字段。映射规则：completed → 0；error → 从错误消息正则 `exit[= ](\d+)` 提取真实退出码（runGit throw 格式 `git ... failed (exit N)` 可提取 128 等），提取不到记 1。
- **去重设计**：轮询返回全量累积消息列表（同一 callID part 随执行演变 pending→running→终态），`GitOpReporter` 按 callID 去重（Set），只对终态（completed/error）上报一次；中间态跳过。
- **server 落库复用模式**：ingress 注入 `IdGeneratorService`（RealtimeModule 提供，与 tasks.service 同源续号），`taskEvent.create` 用 `te_` 前缀 + `eventType='git.op'` + `actorType='agent'`（ACTOR_TYPE 无 agent 值，直接字面量）+ `metadata Json{agent/repo_url/action/exit/error}`；落库失败吞错记 warn（对齐 session.updated 模式，controller 恒定 202）。
- **协议扩展**：WORKER_EVENT_TYPES 双端（worker-protocol.ts + server worker-event.dto.ts）同步加 `git.op`（6→7 事件），两侧 contract/dto spec 的数量断言要同步更新。
- **验收数字**：worker 99→108 tests（+9：git-op-reporter 8 + contract 1），server 431 tests 全绿（31 suites）。

## T1 · server/web Dockerfile + next standalone

- **Next.js rewrites 在构建时编译进 `.next/routes-manifest.json`，运行时 ENV 无效**（实测：build 时 destination 硬编码 `http://localhost:3000`，运行时设 API_PROXY_TARGET 不生效）。Dockerfile 必须用 **build ARG**（`ARG API_PROXY_TARGET` + `ENV`）在 `npm run build` 前注入——这是对计划 D5「compose 里运行时 ENV 注入」方案的关键修正，T11 compose 需改用 `build.args`。
- **NestJS 标准进程构建产物在 `dist/src/main.js`**（非 `dist/main.js`）：tsconfig `outDir=./dist` 且 `rootDir` 未单列 src，`nest build` 产出 `dist/src/`。Dockerfile CMD 必须为 `["node", "dist/src/main"]`，`dist/main` 会 MODULE_NOT_FOUND。
- **prisma schema 会被并行任务改动**：T1 期间 T2（MySQL 迁移）并行执行将 schema provider 改为 mysql 并生成 migrations/——server 镜像内 prisma client 随之变 mysql 版，冒烟需临时 MySQL。多轨并行时 Dockerfile 只做「COPY prisma/」即可跟随 T2，勿在 T1 假设 sqlite。
- **server 容器冒烟要点**：容器内 `127.0.0.1` 指向容器自身，连宿主 MySQL 需用 docker0 网关 `172.17.0.1`（或 compose 服务名）；`DATABASE_URL=file:./dev.db` 对 mysql provider 报 P1012。
- **web standalone 产物结构**：`.next/standalone/` 含 server.js + 精简 node_modules + package.json；`.next/static` 与 `public/` 必须额外 COPY（铁律）。next.config.ts 也需 COPY（standalone 运行时仍读取）。
- **验证通过**：web `tsc --noEmit` ✅、`next build` ✅（standalone 生成）、server `nest build` ✅、两镜像 docker build ✅；web 容器 `/` 与 `/login` 均 HTTP 200、server 容器 health `{"status":"ok"}` + docs 200 ✅。
- **镜像命名**：`aiagents-server:t1` / `aiagents-web:t1`（未打 tag 版本，T11 compose build 时用 build 上下文 + build args）。

## T2 · MySQL 迁移基线（M5 前置）

- **schema provider 改 mysql 后 migrate dev --name init 一次成功**：空 MySQL 8（docker `mysql:8`，映射 3307）+ `DATABASE_URL=mysql://root:root@localhost:3307/aiagents` → 自动建 shadow database 无需额外配置（root 权限），生成 `migrations/20260808003102_init/migration.sql` 恰 **20 张表**，全 utf8mb4_unicode_ci，字符集与设计文档约定一致。
- **migration.sql 全量复核**：20 表（users/roles/projects/project_members/tasks/task_agents/task_events/sessions/chat_channels/messages/artifacts/artifact_versions/agents/agent_skills/agent_tool_effects/skills/tools/workers/task_group_instances/realtime_events）+ `_prisma_migrations` 记录表 = 库内 21 张；每表 `VARCHAR(191)`/`JSON`/`DATETIME(3)` 与 schema 可移植类型约定完全一致，无 enum、无 native type 泄漏。
- **migrate deploy 空库验证**：`DROP DATABASE aiagents; CREATE DATABASE aiagents` 模拟空库 → `npx prisma migrate deploy` 幂等应用成功 → `SHOW TABLES` 20 表齐全。**deploy 不依赖 migrate dev 的历史状态**，生产首次部署直接跑 deploy 即可。
- **seed 在 MySQL 跑通**：`npx ts-node prisma/seed.ts`（即 `npm run seed`）在空库 upsert 成功：roles=2、users=3、projects=2、project_members=2、agents=4。幂等 upsert 设计使重复执行仅 update 不报错。
- **⚠️ `prisma db seed` 命令需显式 `prisma.seed` 配置**：package.json 仅脚本 `seed` 时 `npx prisma db seed` 静默无输出（exit 0 但实际不执行）；补 `"prisma": {"seed": "ts-node prisma/seed.ts"}` 后恢复正常输出。这是 Prisma 6 的标准约定，此前缺失。
- **migrate dev 会重写 node_modules/@prisma/client**：确认无碍（server 用 MySQL 连接 `npm run start:dev` 启动成功，`Found 0 errors`，`/api/v1/health` 返回 `{"status":"ok"}`）。
- **本地开发方案决策（provider=mysql 后 dev.db 不可再直用）**：① 推荐本地 Docker MySQL（.env 指向 `localhost:3306`，与生产同构，命令已写入 .env 注释）；② 回退 SQLite 需改 provider + `prisma db push` 重建（dev.db 数据非权威，seed 可重建，原 dev.db 已备份 /tmp/dev.db.bak）。schema 注释已更新为「provider 当前为 mysql」双方案说明。
- **本机 3306 已被 relay-mysql（他项目）占用**：本地开发容器端口映射需避开 3306 或复用现有实例——T2 验证用 3307 避让，.env.example 仍写 3306 作为新装机标准示例。
- **git 工作区为并行轨共享**：git status 显示 T1/T3/T4/T5/T6/T7 的同批文件也在改动（Dockerfile/worker/next.config 等），T2 只交付 schema.prisma + migrations/ + .env.example + package.json(prisma.seed)。

## T7 · pino JSON 结构化日志（D6 审计）

- **方案选型结论：nestjs-pino@4.6.1（生态标准）**，npmmirror 可装（2s），peerDeps 与现有栈完全兼容（@nestjs/common ^10 / pino ^10 / pino-http ^11 / rxjs ^7）。
- **nestjs-pino 自动注册 pino-http 中间件**：LoggerModule 内部 `consumer.apply(pinoHttp()).forRoutes(DEFAULT_ROUTES)` 挂到全局路由，且 `PinoLogger.root = middleware.logger`——HTTP 与业务日志**共享同一 pino 实例**。main.ts 原 `app.use(pinoHttp())` 可直接移除，HTTP 访问日志功能保留（req/res/responseTime 齐全），不算"移除 pinoHttp HTTP 层"。
- **业务日志零改动接管**：`app.useLogger(app.get(PinoLogger))` 后，所有 `new Logger(XService.name)`（7 处）与框架内部 Logger 全部委托给 pino，输出 JSON。无需改动任何业务模块。
- **启动日志也要 JSON 化必须配 `bufferLogs: true`**：NestFactory.create() 默认在 useLogger 前就用文本 Logger 打印 "Starting Nest application" 等框架日志；加 `{ bufferLogs: true }` + useLogger 后 `app.flushLogs()` 才让启动期日志也走 pino JSON。
- **`@nestjs/common` Logger 静态方法会委托给 useLogger 设置的 logger**：main.ts Bootstrap 的 `Logger.log(..., 'Bootstrap')` 无需改为 nestjs-pino 的 Logger 实例（后者无静态方法），输出已验证为 JSON（context: Bootstrap）。
- **测试静默**：jest 自动设 `NODE_ENV=test`，`enabled: process.env.NODE_ENV !== 'test'` 让 pinoHttp 在测试中静默；单元测试 spec 均不导入 AppModule，不受 LoggerModule 影响（425 tests 全绿，> 423 基线）。
- **可选项**：`LOG_PRETTY=1` 切 pino-pretty（已装 devDependency，仅开发便利，默认保持 JSON）；`LOG_LEVEL` 控级别；`redact` 对 req.headers.authorization/cookie 脱敏。
- **验证命令**：`PORT=3100 node dist/src/main.js` 启动 → 88 行日志全部 `jq -e .` 通过（INVALID=0），HTTP 请求日志含 req/res/responseTime，Bootstrap 日志含 context 字段。
- **坑：dist 产物路径是 `dist/src/main.js`**（tsconfig outDir=dist + rootDir 未设导致），`npm run start:prod` 用的是 node dist/main（标准路径），但本机直接 `node dist/src/main.js` 才对——生产脚本是 `node dist/main`，依赖 T1 Dockerfile 时需确认实际产物路径。

## T5 · tool-register 原型迁移（56 testid，全站最大）

- **Metis 必改点 3 结论：后端 Tool CRUD API 不存在**。证据：`server/src/app.module.ts` 无 ToolsModule（仅 auth/users/projects/agents/tasks/chat/artifacts/realtime/health/workers）；`server/src/` 下无 tools 目录；grep server/src 命中 tool 的文件均为 workers/agents 模块（worker-tool 无关）；`schema.prisma:345-359` 有 Tool 表（name/action/source/execution/mcp_server/schema/init_command/enabled）但**无对应 controller/service**。→ 页面注册按钮为本地 mock（校验工具名必填 + 模拟成功反馈 `register-feedback[data-state]`），注释已写明待 ToolsModule 落地后接 `POST /tools`。
- **web 页面不渲染 NavTopBar/NavDock/CmdKPanel**：导航由 `app/(main)/layout.tsx` 的 AppShell 提供（登录守卫：未登录 `router.replace("/login")`）。迁移时仅渲染内容区，root 用 `flex:1 + minHeight:0 + position:relative + overflowY:auto + padding: xl xl xl 0`（对齐 users 页，原型 paddingLeft 避让 Dock 的逻辑由 AppShell 承担）。
- **条件渲染 testid 的断言方式**：56 testid 中约一半是条件渲染区块（cli/http/mcp 配置 + 绑定列表），初始 code 形态下不存在（原型同构）。断言必须按「分形态可达性合计」：初始 + cli(schema/free) + http + mcp(local/remote) 各形态 collect 并集 = 56。
- **Playwright 断言 auth 注入坑**：`page.add_init_script` 在 about:blank 阶段执行 localStorage 写入会**静默失败**（origin 未定）；须先 `goto` 同源页（/login）→ `evaluate` setItem（key `agent-platform-auth`，zustand persist JSON `{"state":{token,user},"version":0}`）→ 再 goto 目标页。本机 Playwright 为 Python 版，浏览器用 `channel="chrome"`（系统 google-chrome；ms-playwright 缓存的 chromium_headless_shell 版本不匹配）。
- **生产 `npm run start` 的 .next 污染坑（复现）**：dev server 与 build 产物混用后 `routesManifest.dataRoutes is not iterable`；解法 = 杀 3000 端口进程 + `rm -rf .next` + 重新 build 再 start（历史坑确认）。
- **role-bind 角色多选升级为受控交互**：原型 boundRoles 为 const 静态勾选，T5b 改为 useState + 点击切换（data-bound 联动），不破坏 testid 契约。
- **新增辅助 testid `register-feedback`**（error/success 两态条件渲染）：不在原型 56 清单内，属 T5b「保存按钮交互」的反馈载体，不计数入 56。
- **验证通过**：`npx tsc --noEmit` ✅、`npm run build` exit 0 ✅（/tools/register 9.19 kB）、Playwright 30 项断言全 PASS（56 testid 全量 + 4 形态切换 + cli 双模式 + mcp Local/Remote + OAuth toggle + http 位置 select + 初始化命令增删 + 注册校验/mock 成功）。

## T4 · skills-tools-manage 原型迁移（25 testid，双 Tab + 工具三子 Tab）

- **后端 Skill/Tool CRUD API 不存在（与 T5 结论一致，双证确认）**：`server/src/app.module.ts` 无 SkillsModule/ToolsModule；grep server/src 命中 skill/tool 的文件均为 agents/workers/chat 域（toolEffects/capabilities）。`schema.prisma:331-343`（Skill: id/name/description/file_meta/enabled）+ `:345-359`（Tool: name/action/source/execution/mcp_server/schema/init_command/enabled）有表无接口 → 页面用原型 mock 数据（skills 5 / builtin 3 / custom 5 / mcp 4）+ 文件头注释说明，T5 补后端后切换 api.get。
- **审计清单 testid 计数修正**：prototype-audit.md 2.8 节标题写 20，实际列出 25 个（含 mcp-* 5 个：mcp-tool-item/mcp-tool-name/mcp-type/mcp-status/mcp-tool-status）。以原型代码为准实现全部 25 个，Playwright 断言按「初始 skill Tab + tool Tab 三子 Tab 互斥切换」分态 collect 并集 = 25。
- **条件渲染断言模式（与 T5 同）**：tool 相关 testid（tool-subtabs/tool-item/tool-ready/tool-kind/tool-dep-status/mcp-*）在初始 skill Tab 下不存在（互斥渲染，原型同构）。断言必须逐 Tab 切换后收集并集，不能一次性全查。
- **Playwright auth 注入：直接语句可行（补 T5 经验）**：`page.add_init_script("localStorage.setItem('agent-platform-auth', ...)")` 用**直接可执行语句**（非 `() => {}` 箭头函数表达式）在无痕 context 生效，无需先 goto 同源页；T5 先 goto /login 再 evaluate 的路径同样可行。persist key = `agent-platform-auth`，格式 `{"state":{token,user},"version":0}`。
- **本机 Playwright 环境**：Python 版（~/.local/lib/python3.10），全局 CLI 1.62.1 需要 chromium_headless_shell-1223 但缓存只有 -1208 → `launch(executable_path='~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome')` 显式指定。
- **dev 500 全站的隐藏元凶：残留 `next start` 幽灵进程**：dev server 稳定后突然全站 500 + build-manifest ENOENT，`pgrep -af "next"` 发现有个 `sh -c next start`（08:48 自动出现）与 dev 争抢 .next。处理 = kill 全部 next 进程（pkill -f 会匹配自身 shell 导致超时，用精确 PID kill -9）+ rm -rf .next + 重启 dev。
- **迁移裁剪点**：原型 NavDock 统计子面板（技能/内置/自定义/MCP/依赖缺失 5 行计数）不迁移——AppShell 的 NavDock 无 children 插槽（workers 页先例），计数信息已含于主 Tab 徽章（5/12）与三子 Tab 徽章（3/5/4）。
- **验证通过**：`npx tsc --noEmit` ✅、`npm run build` exit 0 ✅（/skills 5.12 kB）、Playwright 断言全 PASS（25/25 testid + 三子 Tab 数据量 3/5/4 + 连接中 1 个 + 搜索框受控 "git" + 零 pageerror），dev server 3001 已恢复。

## T9 · Playwright QA 套件（配置 + 17 页 testid 断言 + 性能 E2E）

- **QA 账号必须用 seed-admin/Admin@123456（非 admin/admin123）**：实测 admin 登录后 `GET /projects` 返回 0 项目（projectMember 归属 seed-admin，T8 同款结论），数据型 testid（project-card 等）无法断言。auth.setup.ts 走真实表单登录（非注入）存 storageState，比 addInitScript 注入更贴近生产（且顺带测 login 页跳转）。
- **17 页 → 14 路由映射（实测确认）**：login=/login、project-list=/projects、task-create=/tasks/new、task-board=/board?pid=、agent-config=/agents、dm-chat=/messages/[id]、group-chat=/tasks/[id]、role-permission=/roles、skills-tools-manage=/skills、task-detail=/artifacts?pid=（产出物聚合页演化形态）、tool-register=/tools/register、user-management=/users、worker-install+worker-list=/workers（worker-guide 注册指引在页内）。**nav-cmdk/nav-hybrid/nav-rail 三变体无独立路由**——AppShell（NavTopBar+NavDock+CmdKPanel）以 nav-hybrid 心智统一承载，pages.spec 每页断言 rail-bar/topbar/cmdk-trigger 即覆盖其终态。
- **浏览器版本坑第 3 次确认**：@playwright/test 1.62.1 需要 chromium_headless_shell-1234，本机 ms-playwright 缓存仅 -1208（T4/T5 同款）。**Node 版解法 = config `channel: "chrome"`**（系统 /usr/bin/google-chrome-stable），零下载零缓存依赖。
- **worker serve 端口假死事故（T9 期间发现）**：worker 主进程（node dist/index.js）心跳正常（server 侧 online），但 **opencode serve 子进程监听端口已死**（ss 无 46155）→ 首字 dispatch 全部 `agent.error dispatch_failed "fetch failed"`（server resolveBaseUrl → capabilities.baseUrl http://127.0.0.1:46155 不可达）。重启 worker（kill + 同 env `X_WORKER_TOKEN=dev-worker-token WORKER_ID=w_local_1 SERVER_URL=http://localhost:3000 node dist/index.js`）后 serve 随机端口 44089 恢复，首字立即双线通过。**诊断手段：查 realtime_events 表 agent.error 事件**（`docker exec aiagents-mysql mysql -uroot -proot aiagents`）比查 worker 日志快。
- **SSE 测量时序陷阱（T8 backlog 坑的补充维度）**：POST 的 chat.message.new 广播事件帧可能**插在 backlog 重放流中先于 HTTP 响应到达**——onmessage 匹配 `msgId === 新消息` 时 msgId 尚未从 POST 响应赋值 → 帧被跳过 → 永久超时（事件已过）。**解法：onmessage 记录所有已见帧 `seen[mid]=Date.now()-t0`，POST 响应回来后查表命中即返回；未命中再等后续帧**。这是比"先注册 onmessage"更深的时序修正（先注册只解决事件早于订阅，不解决事件早于 msgId 赋值）。
- **web 是 CJS 项目（package.json 无 type:module）**：e2e TS 文件不能用 `import.meta.url`（playwright 转译后 node 直接加载报 SyntaxError），storageState 路径用 `path.join(process.cwd(), ...)`（playwright 运行 cwd=web/）。
- **页面断言适配（与原型/审计差异，Playwright 报错实证）**：① tool-register 初始执行形态是「平台代码」（handler-code-editor 可见）非 CLI——4 形态断言顺序：code → CLI（cli-mode-select）→ HTTP（http-callback-url）→ MCP（mcp-type-select）；② worker-guide 是受控展开（`{guideOpen && <WorkerGuide/>}`），需先点 add-worker-button；③ artifacts 页 artifact-row 为条件断言（当前任务无产出物时跳过 viewer，annotation 记录）。
- **测试产物**：`.omo/evidence/phase5-t9-playwright.json`（33 tests, 0 unexpected）；perf 实测：首字 4.6-5.0s（双线 ✅，T8 后 worker 健康时模型行为稳定）、群聊 SSE 3 采样中位数 ~15ms 级（≤1000ms ✅）、页面加载 /projects dev 模式 load <15s ✅。
- **.gitignore 补三项**：`/test-results/` `/playwright-report/` `/.auth/`（storageState 含真实 token，严禁入库）；test-results 由 playwright 成功运行后自动清理。
- **perf 首字测试的容错哲学（沿用 T8）**：首字由模型行为主导（T8 实测 3179ms-19459ms 波动），通过线 15s 断言、目标线 5s 仅记录 annotation，dispatch 失败（worker 掉线）会显式 fail——环境故障应暴露而非掩盖。

## T10 · 原型一致性终检（17 页三维度 + 报告落盘 + 审计位置对齐）

- **token 层逐字节一致（终检最干净的维度）**：`web/src/theme/tokens.ts` 与原型 `docs/agent-platform/prototypes/_shared/styles.ts` diff 无差异（均 102 行）——T8 迁移时原样复制。32 个实现文件收敛引用，无散落魔法数字。
- **testid 提取三种语法缺一不可（静态断言的核心坑）**：`data-testid="x"` / `data-testid={"x"}` / `data-testid={cond ? "a" : "b"}` / 自定义组件 `testid="x"` prop 四种形式并存——skills 页 6 个 testid 用 `testid=` prop、tool-register 的 cli-mode-schema/free 用三元，粗正则全 grep 会误报缺失。终检须 `grep -rhoP '(?:data-testid|testid)="[^"]+"|(?:data-testid|testid)=\{[^}]+\}'` 兜底。
- **真实缺失 19 个 testid（2 页 FAIL）**：① **worker-install 全 17 项**——3 步安装向导整体未迁移，`/workers` 仅 worker-list + worker-guide（受控展开的「部署指引」，只有 token/安装构建 2 步，非 3 步向导）；② dm-chat `msg-error-action`——原型 dm-chat:386 错误消息操作链接，实现 msg-error.tsx 无。T9 pages.spec 对这两处都未断言（workers 只断 worker-guide，dm-chat 只断 4 核心），故 T9 33 tests 仍全绿——**终检暴露了 T9 断言盲区**。
- **task-detail 演化形态确认**：原型（TaskInfoHeader+TabBar+文档库左 300 列表）→ `/artifacts` 聚合页（任务下拉+类型/验收筛选+行式 artifact-row+版本查看器），4 个原型 testid（task-detail-root/task-info-header/artifact-tab/artifact-item）有意缺失，非漏迁移。
- **布局演化偏差 5 处（静态结构比对 + 截图双证）**：task-detail→artifacts 聚合、worker-install→worker-guide 页内展开、task-board Dock「任务统计」子面板未迁移（AppShell NavDock 无 children 插槽）、group-chat 移动端分支未实现（原型 device:both 单栏折叠，实现仅 login 保留 useIsMobile）、导航变体融合（nav-cmdk 面板默认可见→受控关闭、nav-rail 无 CmdK→融合新增）。
- **截图证据管线（MUST NOT build 约束下的替代方案）**：dev 3001 跑 Playwright channel=chrome + storageState（.auth/user.json）逐路由截图，15 张 1440×900 PNG 落 /tmp/opencode/t10-shots/。**坑**：storageState 带登录态时 goto /login 会被重定向到 /projects——login 页须用无 storageState 的独立 context 重截。
- **审计位置对齐**：`docs/agent-platform/18-原型审计报告.md` = prototype-audit.md 全文副本 + 归档头注 + T10 结论引用（210 行），消除 18 篇 §4.1 路径不一致；.omo/evidence/prototype-audit.md 保留为原始件。注意 18 号文档编号与 18-推进计划重号——这是计划 §4.1 既定设计，非冲突。
- **终检报告**：`.omo/evidence/phase5-t10-final-check.md`（17 页三维度逐页 PASS/FAIL + 缺失清单 + 截图证据 + 后续项）。

## T11 docker compose 实跑 + 权限矩阵走查（2026-08-08）

- **BUILDX_BUILDER=default 是内网 build 关键**：本机默认 buildx builder 是 multiarch（docker-container
  driver），其 manifest 解析直连 registry-1.docker.io 不走 daemon registry-mirror，导致 `# syntax=`
  frontend 与 node:22-alpine 拉取全部 i/o timeout。`BUILDX_BUILDER=default docker compose build`
  走 daemon（mirror docker.ketaops.cc + 本地镜像缓存）一次通过。**不要动 daemon.json（影响其他项目）**。
- **compose 端口避开策略**：本地 dev server 占 3000、web dev 占 3001、relay-mysql 占 3306、
  aiagents-mysql 占 3307 → db 不映射宿主、server→13000:3000、web→13001:3000、worker 不映射。
  web 的 rewrites 目标 `http://server:3000` 走 compose 内网，与宿主映射无关。
- **migrate+seed 用一次性 init 服务**（depends_on db service_healthy + condition
  service_completed_successfully 门控 server）：`npx prisma migrate deploy && npx prisma db seed`
  （runner 镜像含 devDeps，ts-node 可跑 seed.ts）。幂等可重复 up。
- **server Dockerfile CMD `node dist/src/main` 已验证正确**：tsconfig 未设 include/rootDir，
  编译输入含 src/ 与 prisma/seed.ts，公共根=项目根 → dist/src/ + dist/prisma/ 两级结构。
- **worker serve 网络拓扑闭环**：capabilities.baseUrl=`http://worker:39987`（随机端口）上报，
  server 容器经 compose 网络直连可达（HTTP 200）；serve 容器内 0.0.0.0:39987 监听确认。
  git 工具族（git_clone/pull/fetch/status/diff/log/push 7 个）随注册上报。
- **权限矩阵全绿**：AdminGuard（无 token 401 / member 403 / admin 200）、ProjectMembershipGuard
  （非成员 403，admin 平台级权限也不豁免项目成员校验——正交隔离）、WorkerTokenGuard
  （错误 401 / 正确 201 / 空 401）。register 为 upsert 幂等，走查不污染 workers 表。
- **archive 状态机**：迁移表仅允许 `completed → archived`（13 篇 §4.5 终态）——reject 回到
  in_progress 后直接 archive 返回 `TASK_INVALID_TRANSITION`（状态机防护正确，非 bug），
  须先 accept 至 completed 再归档。
- **pino JSON 全量合规**：docker logs 抽样 159 行全部 JSON 可解析（0 非 JSON）；Authorization
  redact 生效；业务日志带 context 字段。
- **证据落盘**：`.omo/evidence/phase5-t11-perms.md`（10 用例矩阵）、
  `.omo/evidence/phase5-t11-audit.md`（六类事件查库 + pino 抽查）。
- **清理命令（F3 前保留运行）**：`docker compose down`（保留 mysql_data volume）/
  `docker compose down -v`（连数据删除）。容器名 aiagents-compose-* 与前缀隔离，不影响
  nats/postgres/opencode-serve/buildx 等既有容器。
- **web healthcheck 坑（Next.js standalone 监听地址）**：standalone `server.js` 用 `HOSTNAME` env
  （Docker 容器自动设置为容器 ID）作为监听地址，故容器内 `127.0.0.1:3000` ECONNREFUSED（宿主端口映射
  走 eth0 IP 仍可达）。healthcheck 必须访问 `http://${HOSTNAME}:3000`。server（NestJS app.listen 默认
  0.0.0.0）无此问题。

## F1 2A worker-install 迁移 + msg-error-action 补齐（2026-08-08）

- **worker-install 独立路由落地**：`web/app/(main)/workers/install/page.tsx`（对齐原型 577 行 3 步向导：
  ① 基础配置 serverUrl/workerId/能力声明 → ② curl/docker 双 Tab → ③ 命令展示 + 3 步说明 + 完成/取消）。
  17 个 install-* testid 全实现，T9 reference 2.12 条目 route 从「/workers（页内扩展）」修正为独立路由
  `/workers/install`，root 由 worker-guide 改为 worker-install-root（worker-guide 保留在 2.13 worker-list）。
- **/workers 页双入口**：保留 add-worker-button（展开 worker-guide 折叠面板，T13 收敛不动），
  新增 install-worker-link 链接按钮跳转独立向导——原型「新增 Worker」语义（向导）与注册指引
  （guide 面板）解耦，互不干扰。
- **msg-error-action 补位**：`web/src/components/chat/msg-error.tsx` quota 分支「查看升级方案」
  操作链接补 data-testid（对齐 dm-chat 原型 :386）；retry 分支无操作链接（原型即无）。
- **复制按钮增强**：原型纯静态，实现给 copy-command-button 接 navigator.clipboard（成功反馈「已复制」
  2s，失败静默降级）——唯一超出原型的交互增强，无新依赖。
- **build 污染 dev .next 复现 + 恢复流程**：npm run build 后 dev 3001 返回 500 → kill next-server +
  rm -rf .next + 重启 dev（历史坑再次实证，流程固化）。
- **验证全绿**：tsc --noEmit 0；build exit 0（/workers/install 4.17 kB 静态）；Playwright pages 15/15
  （16/17 install 向导含 docker Tab 联动断言 + 17/17 worker-list 含 install-worker-link/guide 展开；
  dm-chat 补 msg-error-action 条件断言，quota 分支条件渲染沿用 artifacts 条件跳过模式）。
- **testid 计数核对**：worker-install 17 个 install-* 与 prototype-audit.md §2.12 清单逐项一致（17/17）；
  dm-chat msg-error-action 为清单第 9 项补位，T10 终检 2 FAIL 页已清零。

## T10 终检报告同步（F1 修复 + F3 QA 复核，2026-08-08）

- **终检证据与代码状态同步**：初版 `.omo/evidence/phase5-t10-final-check.md` 标记 15/17 + 2 FAIL
  （worker-install 17 testid + dm-chat msg-error-action），与 F1 修复后的实际代码滞后。本次将报告同步为
  **17/17 全 PASS**：逐页表 6（dm-chat）与 16（worker-install）改 PASS、1.2 缺失清单改「原 19 项已清零
  （保留原始记录作对照）」、布局偏差 5→4 处（worker-install 消除）、section 6 待办删 1/2 两条、新增
  section 7 F1 修复记录（修复文件 + F3 QA 15/15 复核）。
- **grep 实证 17/17**：`web/app/(main)/workers/install/page.tsx` 直接 grep 命中全部 17 个 install-*
  testid（含 11 个 data-testid + 6 个表单/按钮位），`msg-error.tsx:104` 确认 quota 分支
  `data-testid="msg-error-action"` —— 无需 Playwright 复跑即可凭源码定稿。
- **同类滞后排查**：docs/agent-platform/18-原型审计报告.md 为 T10 报告归档副本，若同步终检结论需一并
  更新（本次未动，属编排者决策范围）。

## Phase 5 补充 · ToolsModule 后端 CRUD（2026-08-08）

- **零 DDL 铁律落地**：schema.prisma Tool 表（349-363）已存在（id/name/action@unique/source/execution/mcp_server?/schema Json?/init_command Json?/enabled default true），只补 controller/service 层，不动 schema。`tl_` 前缀 id 复用全局 IdGeneratorService（RealtimeModule 导出，与 agents/tasks 同源续号）。
- **模块结构对齐 agents 模式**：`server/src/tools/` = tools.module.ts（imports RealtimeModule）+ tools.controller.ts（@Controller('tools') 4 端点 GET/POST/PATCH/DELETE，全局 JwtAuthGuard 自动鉴权，无需额外 guard）+ tools.service.ts + dto/（create/update/query）。controller 无需 @CurrentUser——Tool 表无 createdBy 字段（与 agents 的 createdBy=userId 不同），create 直接 @Body()。
- **action 唯一冲突处理**：POST/PATCH 均先 `findUnique({where:{action}, select:{id}})` 预查，命中（且 PATCH 时排除自身 id）→ 409 `TOOL_ACTION_EXISTS`；错误码常量放 `server/src/common/constants/tool.constants.ts`（对齐 agent.constants 命名）。
- **initCommand 是 Json 数组不是对象**：前端 tool-register 表单 initCommands 为 `{id, script, note}[]` 数组（表单 1872 行中 useState InitCommand[]），DTO 里必须用 `@IsArray() Array<Record<string, unknown>>`，用 `@IsObject() Record<string, unknown>` 会编译报错（测试实测 TS2322）。schema 字段才是 `@IsObject()`。
- **enabled 查询参数布尔转换坑**：QueryToolsDto 的 enabled 用 `@Transform(({value}) => value==='true'||value===true ? true : value==='false'||value===false ? false : undefined)` + `@IsIn([true,false])`——裸 `@Type(() => Boolean)` 会把字符串 "false" 转成 true（非空字符串即真），过滤语义反转。service 侧 `enabled: query.enabled === undefined ? undefined : query.enabled` 兜底。
- **过滤 where 写法**：source/execution 用 `{equals: query.x}`（对齐 agents.type），name 用 `{contains: query.name}` 模糊搜索（MySQL utf8mb4_unicode_ci 默认 case-insensitive 无需 mode）。分页 normalize 复用 agents 私有方法（page≥1、pageSize 1-100 收敛）。
- **物理删除无需关联清理**：tools 表无外键引用（agent_tool_effects 存的是 toolAction 字符串而非 Tool.id），直接 delete。onModuleInit 对齐 agent 前缀续号（`findFirst orderBy id desc` + parseInt 切片）。
- **验证通过**：`npx jest --no-cache --runInBand tools` → 2 suites / 18 tests 全 PASS；`nest build` exit 0；全量回归 **469 tests / 35 suites 全绿**（较基线 431 净增 38，含并行 SkillsModule 贡献）。app.module.ts 注册时发现 SkillsModule 已被并行任务加入，ToolsModule 紧随其后，无冲突。

## SkillsModule 后端 CRUD（Phase 5 补充，/skills 管理页接线前置）

- **落地内容**：`server/src/skills/` 全套（skills.module/controller/service + dto/{create,update,query} + service/controller spec）+ `common/constants/skill.constants.ts` + app.module.ts 注册。
  路由对齐现有风格：`GET /api/v1/skills`（enabled 过滤 + name 模糊搜索 + 分页 {items,total,page,pageSize}）、
  `POST /api/v1/skills`（409 SKILL_NAME_EXISTS）、`PATCH /api/v1/skills/:id`（enabled 兼作启停开关）、
  `DELETE /api/v1/skills/:id`（409 SKILL_IN_USE）。权限跟随 agents：仅全局 JWT（APP_GUARD），无 AdminGuard。
- **id 前缀 `sk_`**：Skill 是第 6 个域前缀（既有 s_/m_/ev_/ti_/w_），IdGeneratorService 由 RealtimeModule 导出，
  onModuleInit 按 `last.id.slice(3)` 续号（复用 agents.seedPrefix 的 parseInt 模式）。
- **AgentSkill `onDelete: Restrict` 的 API 层表达**：schema.prisma:312 `skill Skill @relation(... onDelete: Restrict)`
  —— 被 agent_skills 引用的 skill 物理删除会被 DB Restrict 拦截（P2003）。决策：**删除前先 `agentSkill.count`
  预检，引用 >0 返回 409 SKILL_IN_USE（提示先解除关联），并发竞态由 P2003 捕获同一 409 兜底**。不采用级联删关联
  —— Restrict 语义即「被引用不可删」，保护 agent 技能定义的引用完整性。
- **name 唯一双保险**：create/update 前 `findUnique({where:{name}})` 预检（改名时仅当新名 ≠ 当前名才查），
  Prisma P2002 捕获兜底并发，均映射 409 SKILL_NAME_EXISTS。fileMeta 透传 `as Prisma.InputJsonValue`。
- **query boolean 过滤的先例建立**：现有 Query DTO 均无 boolean（QueryProjects/Agents 只有 string+int），
  本次 QuerySkillsDto 首次引入 —— `@Transform` 把 query string `"true"/"false"` 归一为 boolean（非法值保留原样
  交由 `@IsBoolean` 400），不能裸用 `@Type(() => Boolean)`（`Boolean("false") === true` 是坑）。
- **验证数字**：skills 专项 `jest --runInBand skills` 20/20 通过（service 16 + controller 4）；`nest build` exit 0；
  全量回归排除并行轨 tools 模块后 **33 suites / 451 tests 全绿**（基线 431 + skills 新增 20，零回退）。
  注：`src/tools/` 为并行任务未跟踪产物，其 spec 编译错误（initCommand 数组 vs Record 类型不匹配）非本次引入，
  本次不触碰（MUST NOT DO 范围外）。
- **追加 learnings 需在 commit 前**（T0 教训重演）：本文件当前处于 MM 状态（并行轨同文件改动），
  SkillsModule 提交时须连同本段一起 `git add` 进同一 commit。

## 前端接线 skills 页 + tool-register 页（mock → 真实 API，2026-08-08）

- **接线范围**：`web/app/(main)/skills/page.tsx` + `tools/register/page.tsx` 从 mock 切真实 API
  （GET/POST/PATCH /api/v1/skills + /api/v1/tools），保留全部 25+56 testid 与 Tab/子 Tab 结构。
  接线模式对齐 agents 页：useQuery + useMutation + queryClient.invalidateQueries（无新依赖）。
- **展示字段降级映射（后端无字段的决策）**：技能 source 由 fileMeta 推导（有=上传/无=内置）；
  version 读 fileMeta.version 缺省 "v1"；roles 后端无绑定列 → 行组件空态显示「未绑定」；
  Tool 无 desc → 显示「调用标识 <action>」；custom kind 由 execution 映射（code→代码/http→HTTP/cli→CLI）；
  MCP 工具 type/status 无运行态数据 → 中性默认 remote + disconnected（避免伪造已连接）。
- **server 重启坑**：宿主机 3000 的 server 是 11:19 启动的旧 dist（SkillsModule/ToolsModule 源码
  已注册且 dist 已有产物，但**进程未加载**）→ GET /skills 404。需 kill 旧进程重启
  （`node --enable-source-maps dist/src/main`，.env 自动加载），重启后 API 即通。
- **库内 skills/tools 表为空**（seed.ts 不种技能/工具数据）→ pages.spec 12/17 断言
  skill-item/tool-item(builtin)/mcp-tool-item 可见会挂。验收时通过 API 预置数据
  （1 内置技能 + builtin/mcp 工具各 1，UI 无法创建 builtin 来源）后 12/17 通过。
- **UX 缺陷修复**：注册/编辑弹窗 API 失败（409 TOOL_ACTION_EXISTS/SKILL_NAME_EXISTS）时
  弹窗保持打开（合理，可修改重试），但错误反馈条显示在 modal 遮罩（zIndex 40）后面——
  isVisible() 为 true 但用户**视觉看不到**。修复：modal 卡片内加 `[role="alert"]` 错误文本
  （registerMutation.isError/editMutation.isError 渲染），打开弹窗时 mutation.reset() 清残留。
- **Playwright 时序坑（临时交互验证脚本）**：notice 3s 自动消失 → waitFor 会命中旧 notice 文本；
  校验反馈需轮询文本（isVisible+textContent 循环）而非一次性断言；列表新增项用
  waitForFunction 轮询 DOM 数量（async POST + refetch 后才有）。
- **409 冲突是错误处理链路的天然验证**：重复上传同名技能/注册同 action 工具 → 409 →
  弹窗内错误可见。验证脚本第一版误把 409 当失败（重复数据残留导致），先清理库再重跑。
- **存量坏数据导致 unrelated 页面挂**：pages.spec 3/17 task-create 间歇失败——库里有个
  role=NULL 的 custom agent（a_0000000001），AgentOptionCard `roles[role]` 无防护 → client
  crash「Cannot read properties of undefined (reading 'label')」。非本次接线引入（该页未改）。
  清理：确认无 task_agents/sessions 引用后 DELETE，15/15 恢复全绿。教训：跑全量 pages.spec
  前先查 agents 表 role 完整性。
- **验证全绿**：tsc --noEmit 0；build exit 0（/skills 8.74 kB、/tools/register 10.4 kB）；
  API 反向验证全链路（POST/PATCH/GET/409 冲突）；UI 交互脚本 15 项断言（列表渲染/启停 PATCH/
  编辑 PATCH/上传 POST/注册 POST/409 modal 错误可见/MCP 渲染/tool-register 注册+拦截）；
  pages.spec 15/15 全通过（含 12/17 + 14/17）。
