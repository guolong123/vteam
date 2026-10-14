# team-worker-node - Work Plan

## TL;DR (For humans)

**What you'll get:** 团队可以指定「这个团队跑在哪个执行节点上」，团队里的每个成员也能各自指定（未指定就是「跟随团队」）；谁都指定时按成员的选择走。同时把一个已经上线却从来没生效过的「首选 Worker」下拉彻底删掉，避免留下第二套看起来能用、其实不生效的设置。

**Why this approach:** 只在已有的执行分派链路上加一层「偏好」，节点不可用（离线、满了、没有需要的模型）时一律自动回退到今天的调度方式，绝不因为设置而卡住或报错；并且团队与成员两级设置必须同时出现在两处接口返回里，否则页面上的选择会被空值悄悄覆盖（这个坑仓库里已经踩过一次）。

**What it will NOT do:** 不做硬绑定（不会因为指定的节点不在就等待或失败）；不做节点池、白名单或按能力路由；不会因为改了设置就打断正在跑的会话，也不会去改动平台内部另一条会「顺手认领会话」的安全逻辑。

**Effort:** Large
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** Medium - 同一次发布里包含一次不可逆的删列（旧服务回滚会遇到列不存在），已用手写迁移 + 守卫测试 + 迁移前备份留档来约束；调度语义本身是软回退，不会让执行卡住。
**Decisions to sanity-check:** ① 优先级定为「成员选择 > 团队设置 > 现状」；② 删列与功能同一次发布（回滚靠「代码回退 + 数据库整库恢复」，仓库既有契约）；③ 指定的节点只在与其它节点同等可用时才被选用（不绕过容量与模型限制）；④ 平台内部「会话认领」这条安全逻辑不动，因此它认领过的会话会暂时不听团队设置；⑤ 保存时不校验节点是否真实存在（沿用「软引用」惯例，只在分派时告警）。

Your next move: 直接开始执行（在 worker 会话里用 `$ulw-execute team-worker-node`），或先要求一次高精度评审（会额外跑一遍独立复核）。Full execution detail follows below.

---

> TL;DR (machine): Large / Medium risk - teams+members preferred worker column (member > team > current behavior, soft fallback inside existing filters), plus removal of the never-consumed Agent.workerId with a hand-written migration + inverted guard spec; 13 implementation todos + F1-F4.

## Scope

### Must have
1. **团队级首选 worker 节点**：`teams.preferred_worker_id`（varchar(191) NULL，无 FK/无索引）+ `UpdateTeamDto.preferredWorkerId` + `TeamsService.update()` 写入（trim 空串→null）+ `toTeamDto` 回吐 + `PATCH /teams/:id`（沿用 `teams.edit` 权限与 version 乐观锁）+ 团队详情页控件。
2. **成员级首选 worker 节点**：`team_members.preferred_worker_id`（同上列形态）+ `UpdateMemberDto.preferredWorkerId` + `TeamsService.updateMember()` 写入（照抄 `overrideModelId` 的 trim-or-null 形状 `teams.service.ts:821-822`）+ `PATCH /teams/:id/members/:memberId` + 成员面板 chip（默认项「跟随团队」）。
3. **优先级链 = 成员显式 > 团队 > 现状**（用户决策）：两级皆空时必须与今天逐字节一致地走自动调度。
4. **软回退与可观测**：置顶节点只在通过 `assignWorker` 全部四道既有过滤时被选用，否则回退自动调度并 `warn`；绝不因置顶不可用而 throw 或阻塞。
5. **删除 `Agent.workerId` 全链**（用户决策）：schema 声明、`AgentRow`/`toAgentDto`/`toAgentDtoList`/PATCH 写入、`UpdateAgentDto` 字段、web 下拉与草稿/载荷、testids 清单条目、两处原型页；附手写迁移（含 `ALTER TABLE agents DROP COLUMN worker_id`）+ 反转守卫 spec + 迁移前预检 dump。
6. **DTO 投影三处同步**：团队 DTO（`teams.service.ts:1477-1500`）、任务实例 DTO（`tasks.service.ts:2005-2035`）、web 类型；只改一处会让正确值被 null 覆盖（该陷阱在 `tasks.service.ts:2028-2030` 有既有注释记录）。
7. **悬空引用清理**：`WorkersService.remove()` 事务内清空 teams/team_members 的 preferred_worker_id（照抄 `workers.service.ts:1315-1322` 现有 agents/sessions 清理）。
8. **可验证性**：server jest 单测（新链 + 零回归 + 四过滤 + 回退矩阵 + 投影）、迁移守卫 spec、`scripts/e2e-team-worker-node.sh` 冒烟、`bash scripts/gate.sh`。

### Must NOT have (guardrails, anti-slop, scope boundaries)
- **不做硬绑定**：置顶节点离线/行缺失/容量耗尽/模型不符/opencodeVersion 不符时**不得**阻塞、不得等待其恢复、不得 throw「无可用 worker」——一律软回退自动调度。
- **不得修改 `server/src/platform-mcp/platform-mcp.service.ts` 的会话 adopt/归属逻辑**（`:7296-7313`、`:7396-7423`）。该路径会按调用方 `x-worker-id` 给 `workerId` 为空的会话补绑定（`resetTeamSessionsInTx` 重置后的会话正是空绑定，`session-lifecycle.service.ts:325-334`），因此**如实记录语义**：置顶只治理分派期指派；被 adopt 兜底重新绑定的会话会一直沿用 adopt 的节点，直到该节点离线才在 `worker-dispatcher.ts:2335` 重新应用置顶。改它是反冒充安全代码，属未请求的越界。
- **不得让 `/agents/*` 全局配置端点感知团队/成员偏好**（`agents.controller.ts:92-192`，无 teamId 上下文）；`PATCH /agents/omo-config` 写配置到哪个节点仍由 `assignWorker()` 排序决定。
- **不得修改 `matchesModelRequirement` 的既有降级语义**（`workers.service.ts:918-936`，`avail.length===0 ⇒ true` 是已发布的兼容契约）；B1 的处理只能在置顶分支内附加条件。
- **不得编辑 `20260925000000_squashed_baseline/migration.sql`**（`docs/migration-baseline.md:29-31` 明令不得用 schema 重建基线；编辑它对已部署库是静默 no-op，会永久留下 schema 漂移）；必须**追加**新迁移目录。`agent-role-drop.migration.spec.ts:1-15` 记录的历史 drop 被折叠进基线的先例，本轮**故意不照做**。
- **不得新增 FK / 索引**（本方案按「软引用 + 应用层清理」惯例）；若未来需要「列出某节点的团队」再独立决策。
- **不做节点池/允许列表/能力或标签路由**；`worker/` 目录零改动；不加依赖。
- **不得主动重绑健康会话**：改设置只影响后续新绑定与已绑定会话的离线重分配；强制重绑仍走既有 reset-session 入口。
- **不得做机械的 `workerId` 清扫**：`OpencodeAgentsResult.workerId`（`agents.service.ts:96-104`）、`web/src/components/agents/AgentRolesTab.tsx:78-82`、`web/src/components/agents/ExternalAgentsPanel.tsx:73-77`、`agents.controller.ts` 的 `?workerId=` 查询参数都是「取数 worker」语义，与 `Agent.workerId` 同名不同物。
- **不得为新增两列加存在性校验/外键**：采用弱校验（写入即存，仅 dispatch 期 warn），这与 `mainAgentMemberId` 的存在性校验（`teams.service.ts:347-365`）**故意分歧**，必须在代码注释里写明理由。
- **不得保留任何 Agent 级 worker 偏好**（用户已决定删除），也不得顺手把它「纳入链路」。
- **不迁移/不回填存量数据**：两列全为新空列；`agents.worker_id` 存量值随列丢弃（该列从未参与分派，无机读价值）。
- 验收标准**不得**写成文档文本 grep 计数，**不得**要求人工点击/目视确认；Playwright **不得**视为默认 gate 的一部分（`scripts/gate.sh:15-19`：仅 `--with-playwright` 且需 :3001 已监听）。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after** + jest（`server/jest.config.js`：`rootDir: src`、`testRegex: .*\.spec\.ts$`、sqlite 测试库且 Prisma 全程 mock —— 无 `globalSetup`/无 `db push`，故**迁移守卫 spec 是本次 schema 变更的唯一自动护栏**）
- 证据根目录：`.omo/evidence/task-<N>-team-worker-node.txt`（本计划不在 ulw-loop 内，故不用 `<attemptDir>` 形式）
- 库形态：本机/CI 无 MySQL（`nc -z localhost 3306` 不通）⇒ 迁移是**手写 DDL**，其正确性由 `server/src/prisma/team-worker-node.migration.spec.ts` 双向断言（照抄 `model-usage.migration.spec.ts:1-80` 的结构，本轮断言按「DROP」反转）
- 端到端：`scripts/e2e-team-worker-node.sh` 针对 live compose（web :13001 / server :13000）；**前置强制**：`docker compose build server web && docker compose down && docker compose up -d`（**必须先 build**：`server/Dockerfile:13-18,24,28` 把 `prisma/` 与 `dist/` 烤进镜像，只 `up -d` 会用旧镜像——迁移文件不在镜像里、`PATCH` 的新字段被 whitelist 静默剥离；先例一致：本计划引为格式模板的 `scripts/e2e-roles-members.sh:19` 明写 `docker compose build server web && docker compose up -d server web`（**不要写脚本数量统计**——该数字不是判据，且本轮对「10 个 `scripts/e2e-*.sh` 里几个带 build」存在分歧）。或：build 之后删除已完成的 init Job 再 up），否则新列不存在、断言全部神秘失败
- 门禁：`bash scripts/gate.sh`（server: prisma generate → lint:check → test → test:e2e → build；worker；web）。**不得**加 `--with-playwright`
- 关键既有断言可复用（不要另造形状）：`worker-dispatcher.spec.ts:3207` `toHaveBeenCalledWith({})`、`:3147/:3181` `toHaveBeenCalledWith({ modelId })`、`:3237-3269`「离线重分配仍携带模型过滤」、`agents.service.spec.ts:295-316` DTO 精确键集

## Execution strategy
### Parallel execution waves
> 顺序刻意做成「每一波落地后仓库都可编译」：先移除 Agent 级读写的代码，再摘 schema 声明，最后才 DDL。

- **Wave 1 — 移除面与调度核心（4 个 todos，文件互不重叠）**：T1 预检 dump（docs/tech-debt-rollback.md §2）、T2 服务端移除 Agent.workerId、T3 web+原型移除 Agent 首选 Worker、T4 `workers.service` 置顶调度。
  - T4 只写 `AssignmentRequirement.preferredWorkerId` 字段与语义（**接口在本计划中已冻结**：`preferredWorkerId?: string`，仅当该 id 通过全部四道过滤才被选用，否则忽略）。T5 只消费它，且必须等 T6 造出列之后（见 Wave 2）。
  - T4 **不得**触碰 `remove()`：worker 删除时的引用清理与 schema 列同生共死，归 T6 独占（否则 Wave 1 会出现「清理新列但列尚不存在」的编译错误窗）。
- **Wave 2 — schema 与 DDL（4 个 todos）**：T6 schema（加两列 + 摘掉 agents.workerId 声明 + 连带删 `workers.service.ts:1319-1322` 及其 spec 断言 + 补 teams/team_members 两处清理 + `prisma generate`）、T5 dispatcher 两级 resolver 与透传（**必须先有 T6 生成的 Prisma 类型**）、T7 迁移 + 反转守卫 spec、T8 团队级写路径（DTO+service+toTeamDto）。
- **Wave 3 — 成员级写路径与 UI（3 个 todos）**：T9 成员级写路径 + `TeamMemberView` 类型 + 三处 DTO 投影同步、T10 web 类型 + 团队详情页控件、T11 成员面板 chip + 会话页接线 + testid 注册。
- **Wave 4 — 冒烟与收口（2 个 todos）**：T12 编写 `scripts/e2e-team-worker-node.sh`（F3 的可执行载体，含栈重建前置）、T13 全仓残留引用复核 + `bash scripts/gate.sh` 全绿。
- **Final verification wave**：F1-F4 并行（见下）。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 预检 dump | - | 7 | 2, 3, 4 |
| 2 服务端移除 Agent.workerId | - | 6, 13 | 1, 3, 4 |
| 3 web+原型移除下拉 | - | 13 | 1, 2, 4 |
| 4 workers.service 置顶调度 | - | 5, 7 | 1, 2, 3 |
| 5 dispatcher resolver + 透传 | 4, **6**（列须先由 6 生成 Prisma 类型，否则 `select: { preferredWorkerId: true }` 是超集属性错误） | 13 | 7, 8 |
| 6 schema 两列 + 摘声明 + 连带编译修复 + generate | 2（先摘代码再摘声明，保证可编译） | 5, 7, 8, 9 | - |
| 7 迁移 + 守卫 spec | 1, 4, 6 | 13 | 5, 8 |
| 8 团队级写路径 | 6 | 10 | 5, 7 |
| 9 成员级写路径 + 类型 + 三处投影同步 | 6 | 11, 10 | 7, 8 |
| 10 web 类型 + 团队详情页控件 | 8 | 11, 12 | - |
| 11 成员面板 chip + 会话页接线 | 9, 10 | 12 | - |
| 12 e2e 冒烟脚本 | 10, 11 | 13 | - |
| 13 残留复核 + gate | 2, 3, 5, 7, 10, 11, 12 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. 迁移前预检 dump + 单向 DDL 回滚契约落档
  What to do / Must NOT do:
  - 按 `docs/tech-debt-rollback.md` §2 取预检备份：`mkdir -p .omo/evidence && mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p <db> > .omo/evidence/ddl-team-worker-node-$(date +%Y%m%d).sql`，随后 `ls -lh` 校验非空。
  - 若本机/CI 无任何可达 MySQL（`nc -z localhost 3306` 不通，本仓常态）：在证据文件里原样留档上述命令、写明结论「本波 DDL 只在 compose/k8s 由 init 服务应用（`docker-compose.yml:44-54`），恢复路径 = `git reset --hard <last-green>` + dump restore（本仓无 down migration）」，并明确记录「部署方执行 DDL 前必须自行补 dump」。
  - 证据文件同时写明本仓恢复的顺序规则（代码先、数据后）与「restore 会丢弃迁移后的所有写入」这一不可逆事实。
  - **开工快照（供 Todo 13 与 F4 做相对比较）**：把 `git rev-parse HEAD`（记为 base-sha）与 `git status --porcelain` 的**完整原始输出**写进证据文件。本计划开工前工作区已经是脏的（`server/src/platform-mcp/platform-mcp.service.ts`、`platform-mcp.controller.ts`、`platform-mcp.tools.ts`、`web/src/components/chat/msg-parts.tsx`、`.omo/evidence/*.json`），这些既有脏改动**不属于本计划范围**。
  - Must NOT：**不得把 dump 文件提交进 git**（`.omo/evidence/*` 是被跟踪的目录；dump 只留本地，入库的只有 receipt）；不得贴真实口令（用 `$MYSQL_ROOT_PASSWORD` 一类变量名或占位符）；不得在无 dump 的情况下继续执行 Todo 7；**不得清理/回退开工前就存在的脏文件**（`git checkout`/`git stash` 均禁止——会毁掉无关的在进行工作）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 7
  References (executor has NO interview context - be exhaustive): `docs/tech-debt-rollback.md:1-90`（§1 回滚触发与两步恢复、§2 预检备份命令与命名 `.omo/evidence/ddl-W<n>-<date>.sql`、§3 restore 语义「无 DROP COLUMN 的部分撤销」）；`docker-compose.yml:44-54`（init 服务 `npx prisma migrate deploy && node dist/prisma/seed.js`）；`chart/vteam/templates/job-init.yaml:58`、`chart/vteam/values.yaml:221-223`（k8s 侧同名 Job）；`server/prisma/migrations/`（12 个目录，最早为 `20260925000000_squashed_baseline`）
  Acceptance criteria (agent-executable): `.omo/evidence/task-1-team-worker-node.txt` 内含：`git rev-parse HEAD` 的 base-sha 原文 + `git status --porcelain` 完整原始输出 + `mysqldump` 命令原文 + 「无可达 MySQL」结论（若有 MySQL 则为 dump 文件 `ls -lh` 非空输出）+ 「部署前须补 dump」；`bash -c 'ls -lh .omo/evidence/ddl-team-worker-node-*.sql 2>/dev/null || true'` 若有结果则字节数 > 0；**dump 未入库必须有检出能力**：`git ls-files --error-unmatch .omo/evidence/ddl-team-worker-node-*.sql` **必须失败**（`ls-files` 报未跟踪/不存在即通过）；同时把 `git check-ignore -v .omo/evidence/ddl-team-worker-node-*.sql` 的输出（应命中 `.gitignore:45 .omo/evidence/**/*.sql`）粘进证据，说明为何「porcelain 计数」在本仓是零检出判据（原始计划里的「`.omo/evidence/*` 是被跟踪的目录」对 `.sql` 不成立——`.sql` 被 :45 忽略）
  QA scenarios (name the exact tool + invocation): happy——对可用 MySQL 执行上述 mysqldump，`head -3 .omo/evidence/ddl-team-worker-node-*.sql` 出现 mysqldump 注释头且文件非空；failure——把 `-P` 改为未监听端口复跑，命令非 0 退出，证据文件写下「预检失败 ⇒ STOP，不得进入 Todo 7」（用 `zsh -c '...' ; echo exit=$?` 记录真实退出码）。Evidence .omo/evidence/task-1-team-worker-node.txt
  Commit: N（证据并入 F 波）
  Recommended task executor category: `quick` — 单文件证据 + 一条既定命令，机械可验。

- [x] 2. 服务端删除 `Agent.workerId` 读写与 DTO 字段（并修既有精确键集测试）
  What to do / Must NOT do:
  - `server/src/agents/agents.service.ts`：删 `AgentRow.workerId`（:66）、PATCH 写入分支 `...(dto.workerId !== undefined ? { workerId: dto.workerId } : {})`（:361）、`toAgentDto` 的 `workerId: agent.workerId`（:652）、`toAgentDtoList` 的同名字段（:678）、以及 `toAgentDto` 的**返回类型成员** `workerId: string | null;`（:628——漏删会让 tsc 报「missing in type」并被本 todo 的 grep 断言抓到）；同时修正 :323 注释里列举的「设置字段（name/prompt/defaultModelId/workerId/persona/…）」去掉 workerId。
  - `server/src/agents/dto/update-agent.dto.ts`：删 :83-91 的 `workerId` 字段与 `@ApiPropertyOptional` 描述。
  - `server/src/agents/agents.service.spec.ts`：把 :295-316 的 `Object.keys(result.items[0]).sort()` **精确键集**断言里的 `'workerId'` 删掉（这是硬失败点，不是可选清理）；并清理 :70/:86/:102/:118/:137 行夹具里的 `workerId: null`。
  - Must NOT：**不得**删除 `OpencodeAgentsResult.workerId`（`agents.service.ts:96-104`）——那是「取数 worker」；不得动 `agents.controller.ts` 的 `?workerId=` 查询参数与 `getOmoConfig/setOmoConfig/getOmoAgentPrompt/listOpencodeAgents` 的 `opts.workerId`；不得动 `workers.service.ts`（归 Todo 4）；不得改 schema（归 Todo 6）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 6, 13
  References (executor has NO interview context - be exhaustive): `server/src/agents/agents.service.ts:66,96-104,323,361,652,678`；`server/src/agents/dto/update-agent.dto.ts:83-91`；`server/src/agents/agents.service.spec.ts:295-316,70,86,102,118,137`；`server/src/main.ts:52-60`（`whitelist: true, forbidNonWhitelisted: false` ⇒ 旧客户端仍发送 `workerId` 会被静默剥离、不报 400，这是设计内行为，不必兼容层）；`.omo/plans/model-management.md:15,32`（曾承诺「agent 首选 worker 软绑定」的旧计划，本计划取代其该项承诺——只读引用，不要改它）
  Acceptance criteria (agent-executable): `cd server && npx jest src/agents` 全绿；`grep -rn "workerId" server/src/agents/agents.service.ts server/src/agents/dto/update-agent.dto.ts` 仅剩取数语义（`OpencodeAgentsResult.workerId` 及其赋值）与 `opts.workerId`；`npx tsc --noEmit -p tsconfig.json` 通过
  QA scenarios (name the exact tool + invocation): happy——`npx jest src/agents/agents.service.spec.ts -t "列表"` 通过且键集断言不再含 workerId；failure——保留 `toAgentDtoList` 的 `workerId` 字段复跑，该键集断言转红（突变校验，即 C1 的真实失败路径）。Evidence .omo/evidence/task-2-team-worker-node.txt
  Commit: Y | refactor(agents): 移除从未参与分派的 Agent.workerId 读写与 DTO 字段
  Recommended task executor category: `quick` — 四处删除 + 一处测试夹具修正，边界清晰。

- [x] 3. web 与原型删除 Agent「首选 Worker」下拉与 testid 清单条目
  What to do / Must NOT do:
  - `web/app/(main)/agents/page.tsx`：删 `AgentItem.workerId`（:101）、`workerDraft` 状态（:1526）、`handleSave` 载荷里的 `workerId: workerDraft || null`（:1549）、`UpdateAgentPayload.workerId`（:127）、`sortedWorkers`（:1563-1568）、**:1880 的小节副标题「默认模型 · 凭据 · 首选 Worker」中的字样**、与整段下拉 UI（:2048-2090，含 `agent-worker-select` 与「首选 Worker」注释）。
  - **保留** `workersQuery`（:2847-2852）、`workers` prop 与 `ApiWorkerRow`（:172-176）——`EffectivePermissionSection` 的「重启全部 worker」仍在用（:835-862,1069,1409-1415）。
  - `web/e2e/reference/testids.ts:156` 删 `"agent-worker-select"`（该文件无任何 import，属参考清单）。
  - 原型：`docs/agent-platform/prototypes/agent-config/index.tsx` 删 :8 头部注释提及、:161-162 mock worker 池（`workerPool`，仅被 :814 消费）、:782-821 整块（不止 :798 的 data-testid 行）；`docs/agent-platform/prototypes/agent-manage/index.tsx` 删 :20 头部注释里的提及（**注意 :20 是注释、不是类型字段**）、**:106 的 `worker: string` 类型字段**、:829 的 `<Field label="首选 Worker" …>` **以及 9 条 mock 行里的 `worker` 键**（:133,150,167,184,201,218,235,253,270），否则留下死字段。
  - Must NOT：不得删「重启全部 worker」功能或其 testid；不得顺手清理其它 testid；不得为「保存时静默无效」加兼容提示（见 Todo 2 的 whitelist 说明）；**grep 复核必须限定源码路径**（`web/app web/src web/e2e docs`），不得写成 `grep -rn … web docs` —— 后者会命中被 gitignore 的 `web/.next/` 构建产物（实测 18 处命中），使验收永远不可达且让突变校验失去意义。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 13
  References (executor has NO interview context - be exhaustive): `web/app/(main)/agents/page.tsx:95-104,127,172-176,835-862,1069,1409-1415,1490-1500,1520-1575,2040-2090,2840-2855`；`web/e2e/reference/testids.ts:140-160`（auditPage「2.1 agent-config」、route `/agents`）；`docs/agent-platform/prototypes/agent-config/index.tsx:8,161-162,782-821`；`docs/agent-platform/prototypes/agent-manage/index.tsx:20,106,133-270,829`；`web/.gitignore`（`.next/` 是被忽略的构建产物，故 grep 必须限定源码目录）；`web/AGENTS.md`（改 web 前先读 `web/node_modules/next/dist/docs/` 的版本差异提示）
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` 通过；`npm run lint` 0 err；`grep -rn "agent-worker-select" web/app web/src web/e2e docs` 零命中；`grep -rn "首选 Worker" "web/app/(main)/agents" web/src/components/agents docs/agent-platform` 零命中（**收窄到 agents 面**：teams 面会在 T10 起合法出现同名字样，全 `web/app` 范围会自伤）；`grep -c "workerDraft\|sortedWorkers" "web/app/(main)/agents/page.tsx"` 输出 0
  QA scenarios (name the exact tool + invocation): happy——限定源码路径的 `grep -rn "首选 Worker" "web/app/(main)/agents" web/src/components/agents docs/agent-platform` 零命中（**与验收行同一收窄范围**；写成 `web/app docs/agent-platform` 会在 T10 落地后自伤）且 tsc 通过，页面「重启全部 worker」仍存在（`grep -c "restart" "web/app/(main)/agents/page.tsx"` 不减）；failure——只删下拉保留 `workerDraft` 引用复跑 tsc，报未使用变量/编译错误，证明清理必须成组。Evidence .omo/evidence/task-3-team-worker-node.txt
  Commit: Y | refactor(web): 移除 Agent 首选 Worker 下拉与原型/testid 残留
  Recommended task executor category: `quick` — 删除式改动，风险在「保留项」，已逐条点名。

- [x] 4. `workers.service`：`AssignmentRequirement.preferredWorkerId` 置顶调度（四过滤内）
  What to do / Must NOT do:
  - `AssignmentRequirement`（:69-80）新增 `preferredWorkerId?: string`，注释写明语义：**候选内偏好**——仅当该 id 通过全部既有过滤才被选用，否则忽略；未传 = 行为与今日逐字节一致。
  - `assignWorker`（:863-899）在现有 `ranked` 链路末端做一件事：若 `req.preferredWorkerId` 且该 id 出现在通过全部四道过滤的候选里 → 直接返回它；否则返回原 `ranked[0]?.worker.id ?? null`。四道过滤必须**全部**保持（`workers.service.ts:884-891`）：① `status !== offline`；② `remainingCapacity(w) >= need`（:1363）；③ `!req.opencodeVersion || w.opencodeVersion === req.opencodeVersion`；④ `matchesModelRequirement(w, req.modelId)`（:909-938）。置顶未命中时 `this.logger.warn` 说明原因（**注意 `candidates` 的 DB `where` 已排除 offline（:866），故「行缺失」与「offline」在候选集里不可区分——warn 文案不要把二者说成两种确定原因，按「候选集中不存在该 id」如实表述**；其余可区分原因：容量不足 / opencodeVersion 不符 / 模型不符 / **degraded 节点被置顶**——四道过滤只挡 offline，`degraded` 会通过全部过滤并绕过 online 优先排序，属需要被告知的状态）。
  - **B1（置顶专属附加条件，不改全局语义）**：当 `req.modelId` 非空且置顶 worker 的 `modelAvailabilities.length === 0`（从未上报模型能力）→ 视为置顶不命中并回退。理由：`matchesModelRequirement` 对「从未上报」返回 `true`（分支在 :926-927，既有兼容契约，注释在 :902-908），自动调度下无害，但**置顶会把它变成确定性选择**，从而静默击穿 C7 的模型可用性保证，失败会推迟到 opencode serve 运行期。**不得修改 `matchesModelRequirement` 本身**。（注意：某节点 `defaultModelId === modelId` 但 `modelAvailabilities` 为空时，④ 会放行而 B1 会拒——这是**有意**的，回退后重排仍可能选回它，不要把它当 bug 修。）
  - 单测（`server/src/workers/workers.service.spec.ts`，既有 `describe('assignWorker（Scheduler）')` :1397 与模型匹配组 :2294 不得回归）新增至少 9 例（**六种回退都必须同时断言 `logger.warn`**，与成功标准 3 对齐）：置顶在线→命中（无 warn）；置顶 offline→回退 + warn；置顶 degraded→仍命中但 warn；置顶行缺失→回退 + warn；置顶容量耗尽→回退 + warn；置顶 opencodeVersion 不符→回退 + warn；置顶无 availability 且 modelId 非空→回退 + warn（B1）；**置顶有 availability 但全部不匹配/enabled=false**→回退 + warn；**无参调用 `assignWorker()` 的候选集与今日一致**（保护 9 处无参调用方）。另断言置顶命中不受 `ranked` 容量排序影响。
  - Must NOT：不得 throw「无可用 worker」因置顶不可用；不得让置顶绕过任一过滤；不得改 `matchesModelRequirement`；**不得改 `remove()`**（`:1310-1325`）——其引用清理必须与 schema 列同生共死，归 Todo 6 独占（本 todo 只做调度）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 5, 7
  References (executor has NO interview context - be exhaustive): `server/src/workers/workers.service.ts:69-80`（AssignmentRequirement）、`:863-899`（assignWorker 与四过滤+排序）、`:902-938`（matchesModelRequirement 及其兼容契约注释，含 `avail.length===0 ⇒ true`）、`:1363`（remainingCapacity）；`server/src/workers/workers.service.spec.ts:1397-1580`（既有 Scheduler 组：容量排序/版本匹配/degraded 降级/容量耗尽/无 load）、`:2294-2360`（模型匹配组）；9 处调用方（**全部无参或仅 `opts.workerId` 兜底**，故新增可选字段对它们行为中性）：`server/src/chat/worker-dispatcher.ts:2305,2335`、`server/src/agents/agents.service.ts:413,461,499,535,575`、`server/src/agent-roles/opencode-agent-name.validator.ts:31`、`server/src/teams/teams.service.ts:923`
  Acceptance criteria (agent-executable): `cd server && npx jest src/workers/workers.service.spec.ts` 全绿（新增 ≥9 例）；`grep -n "preferredWorkerId" server/src/workers/workers.service.ts` 命中类型声明与置顶判定；`grep -c "matchesModelRequirement" server/src/workers/workers.service.ts` 未减少；**禁止用 `--stat`（它只打印 `path | N ++--` 汇总行、永不输出 hunk，判据会恒真而零覆盖）**，改用 `git diff -U0 server/src/workers/workers.service.ts | grep '^@@'` 并断言没有任何 hunk 覆盖 `:1310-1325`（另加**补充**检查但**不等价**——只新增 `team.updateMany` 时该计数仍为 0，故 hunk 判据才是主判据：`git diff server/src/workers/workers.service.ts | grep -c 'agent.updateMany'` == 0）
  QA scenarios (name the exact tool + invocation): happy——mock 一个 online+容量足+模型匹配的置顶节点与一个容量更高的其它节点，断言 `assignWorker({ preferredWorkerId })` 返回置顶 id；failure——把置顶节点的 `status` 置 offline 复跑，断言返回非置顶 id 且 `logger.warn` 被调用（spy），且**不抛异常**。Evidence .omo/evidence/task-4-team-worker-node.txt
  Commit: Y | feat(workers): 首选 worker 在既有过滤内的置顶调度
  Recommended task executor category: `deep-low` — 正确性取决于四道过滤与 B1 的交互语义，需跨读 assignWorker/matchesModelRequirement 才能定案。

- [x] 5. dispatcher：两级 resolver（成员 > 团队）+ 透传 `preferredWorkerId` + 无模型时的可观测 warn
  What to do / Must NOT do:
  - 新增两个私有 fail-open resolver（**完全照抄** `resolveMemberOverrideModelId` 的形状 `worker-dispatcher.ts:3812-3832`）：repo 取值必须用 `(this.prisma as any).teamMember` / `(this.prisma as any).team`（**不得**写成 `this.prisma.teamMember.findFirst({ select: { preferredWorkerId: true } })` 这类带类型的字面量——该写法会被 Prisma 泛型做超集属性检查），返回值用 `as { preferredWorkerId?: string | null } | null` 收窄，并保留 `typeof repo.findFirst !== 'function'` 兜底与 try/catch → `logger.warn` + 返回 null，绝不阻断分派。两个函数：`resolveMemberPreferredWorkerId(teamMemberId)`、`resolveTeamPreferredWorkerId(teamId)`。
  - 在 `:2290-2304` 的模型解析块旁组链：`const preferredWorkerId = (await resolveMember…()) ?? (await resolveTeam…()) ?? undefined;`，并把它并入 `assignmentReq`（`preferredWorkerId ? { …preferredWorkerId } : {}`）。**顺序即用户决策**：成员显式 > 团队 > 未设（undefined）。
  - 在紧邻处写注释说明两件事：① 置顶同时作用于**离线重分配**路径（`:2335` 复用同一 `assignmentReq`，故已绑定会话在其节点离线后会被拉回置顶节点）；② 改设置**不主动重绑健康会话**（`:2282` 的 `session.workerId` 复用优先）。
  - **B2 可观测**：当 `agentModelId === null`（成员/任务/agent 链皆无模型）且置顶实际生效（`assignWorker` 返回了 `preferredWorkerId`）时 `logger.warn`，记录 resolved `workerId` 与 `workerRow.defaultModelId`——因为最终模型来自 `agentModelId ?? workerRow.defaultModelId ?? null`（`:2365-2367`），置顶会改变兜底来源，这必须是可见的。
  - Must NOT：不得修改 `platform-mcp.service.ts` 的 adopt/归属逻辑（`:7296-7313`、`:7396-7423`）；不得改会话复用/离线重分配既有分支；不得 throw；不得把 resolver 失败升级为 fail-closed。
  Parallelization: Wave 2 | Blocked by: 4, 6（接口冻结由 4 提供；Prisma 类型由 6 的 generate 提供——缺 6 会让本 todo 的 tsc/jest 打红） | Blocks: 13
  References (executor has NO interview context - be exhaustive): `server/src/chat/worker-dispatcher.ts:2233-2370`（dispatchForTeamTarget 全链：会话读取/复用判定/assignmentReq 构造/离线重分配/模型兜底）、`:2280-2304`（复用与模型解析块）、`:2318-2359`（离线重分配第二次 assignWorker）、`:2365-2367`（模型兜底）、`:3812-3832`（fail-open resolver 范式）、`:3922-3950`（agent 模型链）、`:1770-1781`/`:1827-1898`（唯一分派漏斗）；`server/src/workers/workers.service.ts:69-80`；**反例证据（不得效仿改造）**：`server/src/platform-mcp/platform-mcp.service.ts:7296-7313,7390-7393,7396-7423`、`server/src/workers/session-lifecycle.service.ts:322-336`
  Acceptance criteria (agent-executable): `cd server && npx jest src/chat/worker-dispatcher.spec.ts` 全绿且新增 6 例：① 两级皆空 → `expect(assignWorker).toHaveBeenCalledWith({})`（形状对齐 :3207，零回归）② 仅团队有值 → 传团队值 ③ 成员与团队都有值 → 传**成员**值 ④ 已绑定 offline 节点的重分配仍携带 `preferredWorkerId`（形状对齐 :3237-3269）⑤ resolver 查询抛错 → 传 `{}` 且分派继续（fail-open）⑥ **`agentModelId === null` 且置顶命中 → `logger.warn` 命中且携带 resolved `workerId` 与 `workerRow.defaultModelId`**（B2 的可失败测试：漏了它这条告警可以是死码）
  QA scenarios (name the exact tool + invocation): happy——构造 team.preferredWorkerId=w_a、member.preferredWorkerId=w_b，断言 `toHaveBeenCalledWith({ preferredWorkerId: 'w_b' })`；failure——让 `team.findUnique` 抛错并断言 `assignWorker` 仍被调用（`toHaveBeenCalledWith({})`）且 `logger.warn` 命中、无异常上抛；再补一条 B2：agent 全链无模型（`resolveAgentModelId` 返 null）且置顶命中时断言 warn 文本含该 workerId。Evidence .omo/evidence/task-5-team-worker-node.txt
  Commit: Y | feat(chat): 分派期解析首选 worker（成员 > 团队 > 现状，fail-open）
  Recommended task executor category: `deep-low` — 需在既有 60 行时序里插链并守住复用/重分配两条路径的语义。

- [x] 6. schema：新增两级 `preferred_worker_id` 并摘除 `agents.workerId` 声明 + `prisma generate`
  What to do / Must NOT do:
  - `model Team`（:86-115）在 `managedMode` 之后、`version` 之前加：`/// 团队级首选 worker（软绑定单节点；成员显式选择优先；不可用自动回退，绝不阻塞）` + `preferredWorkerId String? @map("preferred_worker_id")`。
  - `model TeamMember`（:177-204）在 `overrideModelId`（:184）之后加同名列 + 一句注释（成员显式 > 团队 > 现状；null/空 = 不覆盖）。
  - `model Agent` 删除 `workerId String? @map("worker_id")`（:652）与其上方注释（:651）。
  - 加列**不得**声明 `@relation`/`@@index`；不加 `@@map` 之外的东西。
  - **删列带来的连带编译修复（本 todo 独占，必须与 schema 同一提交）**：`server/src/workers/workers.service.ts:1319-1322` 的 `this.prisma.agent.updateMany({ where: { workerId: id }, data: { workerId: null } })` 是**带类型**的调用（`PrismaService extends PrismaClient`，`AgentWhereInput.workerId` 随之消失）；保留它会同时打红 `nest build` 与 `ts-jest`（jest diagnostics 未关闭），删掉它则必须同步删 `server/src/workers/workers.service.spec.ts:2070-2072` 的 `expect(prisma.agent.updateMany).toHaveBeenCalledWith({ where: { workerId: 'w_0000000001' }, data: { workerId: null } })`。**两者必须同一次提交内一起改**。
  - **同一处补齐新列的引用清理（本 todo 独占）**：`remove()`（`:1310-1325`）事务内追加 `team.updateMany({ where: { preferredWorkerId: id }, data: { preferredWorkerId: null } })` 与 `teamMember.updateMany({ where: { preferredWorkerId: id }, data: { preferredWorkerId: null } })`；同步改造 `workers.service.spec.ts` 的 prisma mock——补齐 `team.updateMany` 与 `teamMember.updateMany`（现有 `:133-135` 的 mock **没有 `team` 键**，`teamMember` 只有 `findMany`），并按实际写入条数更新 `describe('remove（DELETE /workers/:id 删除离线 worker）')`（`:2046`）的断言，含 `:2058-2059` 的 `expect(txOps).toHaveLength(5)`——当前 5 条写入，去掉 `agent.updateMany` 后 4 条，再加 team/teamMember 两条应为 **6**（以实际代码为准核对，不得照抄本文数字），四处 `remove` 用例（`:2053/:2086/:2099/:2127`）全部需通过。
  - 运行 `cd server && npx prisma generate`（在 `tsc` 或 jest 之前必须跑，否则新列不存在的类型错误会先炸）。
  - Must NOT：不得编辑 `server/prisma/migrations/**`（迁移是 Todo 7）；不得改 Session/Worker/TaskGroupInstance 的 workerId；不得顺手删 `/agents/*?workerId=` 相关代码；不得为绕过类型错误改成 `(this.prisma as any)`（此处类型错误是**正确的信号**：列真的没了）。
  Parallelization: Wave 2 | Blocked by: 2（先摘掉所有读它的代码，再摘声明，保证每一波可编译） | Blocks: 5, 7, 8, 9
  References (executor has NO interview context - be exhaustive): `server/prisma/schema.prisma:86-115`（Team 现有列与中文注释风格）、`:177-204`（TeamMember）、`:651-652`（待删的 Agent.workerId）、`:321,336`（Session.workerId + FK，判例：分派用的绑定列）、`:902-929`（Worker.defaultModelId 与 worker 域注释风格）；`server/src/prisma/prisma.service.ts:10-11`（`extends PrismaClient` ⇒ 生成类型即编译约束）；`server/src/workers/workers.service.ts:1290`（remove 的文档注释里「agents.workerId 置空（软绑定首选 worker）」一句须同步改写，否则留下与代码不符的说明）、`:1293,1310-1325`（remove 事务与待改的 agent.updateMany）；`server/src/workers/workers.service.spec.ts:108-149`（prisma mock，无 `team` 键、`teamMember` 仅 `findMany`）、`:2046-2131`（remove 用例组，含 :2058-2059 条数断言与 :2070 agent.updateMany 断言）；`server/src/agents/agents.service.ts:66,361,652,678`（Todo 2 已删）；`docs/migration-baseline.md:29-31`（基线不可用 schema 重建）
  Acceptance criteria (agent-executable): `cd server && npx prisma generate && npx tsc --noEmit -p tsconfig.json` 通过；`npx jest src/workers src/agents` 全绿（含 `remove` 用例组）；`grep -n "preferred_worker_id" server/prisma/schema.prisma` 恰好 2 命中（**注释措辞只能用中文「首选 worker」，不得在 schema 注释里写出 `preferred_worker_id` 字面量**，否则该计数必然 > 2）；`awk '/model Agent /,/^}/' server/prisma/schema.prisma | grep -c workerId` 输出 0；`grep -c "agent.updateMany" server/src/workers/workers.service.ts` 输出 0 且同文件 `grep -c "team.updateMany\|teamMember.updateMany"` 输出 ≥2
  QA scenarios (name the exact tool + invocation): happy——generate 后 `tsc --noEmit` 通过且 `npx jest src/workers/workers.service.spec.ts -t "remove"` 全绿；failure（**双向**）——① 只删 schema 声明、保留 `:1319-1322` 复跑 `npx tsc --noEmit`，必须报 `workerId` 不存在（证明该修复是必需的）；② 删了 `:1319-1322` 但漏改 `workers.service.spec.ts:2070` 复跑，该断言转红（证明测试同步是必需的）。Evidence .omo/evidence/task-6-team-worker-node.txt
  Commit: Y | feat(db): 团队/成员新增首选 worker 列，移除未生效的 Agent.workerId 声明及其唯一写路径
  Recommended task executor category: `unspecified-high` — schema 与两处服务代码/测试的连带修改必须同生共死，改动面跨 3 个文件。

- [x] 7. 迁移：追加目录 + 手写 DDL（2 ADD + 1 DROP，内联回滚契约）+ 反转守卫 spec
  What to do / Must NOT do:
  - 新建 `server/prisma/migrations/<YYYYMMDDHHMMSS>_team_worker_node/migration.sql`，时间戳必须 **>** `20261010030000`（本仓时间戳为整齐段位，取当日下一个段位即可）。内容：中文理由头（逐列论证 + why-not 段）+ 裸 DDL：`ALTER TABLE \`teams\` ADD COLUMN \`preferred_worker_id\` varchar(191) DEFAULT NULL;`、`ALTER TABLE \`team_members\` ADD COLUMN \`preferred_worker_id\` varchar(191) DEFAULT NULL;`、`ALTER TABLE \`agents\` DROP COLUMN \`worker_id\`;`。
  - 文件头必须**内联**写明单向 DDL 回滚契约（照 `docs/tech-debt-rollback.md` §3 的既有惯例）：本迁移不可 down，回滚 = `git reset --hard <last-green>` **加** 恢复迁移前全库 dump，且 restore 会丢弃迁移后所有写入。
  - 同目录内 DDL 必须与 Prisma 自产 `migrate diff` 输出逐字等价（列类型/默认值/顺序）。可用离线命令自证：`npx prisma migrate diff --from-schema-datamodel <迁移前 schema> --to-schema-datamodel prisma/schema.prisma --script`（本机无 MySQL，真跑 SQL 的机会为零）。
  - 新建 `server/src/prisma/team-worker-node.migration.spec.ts`（结构照抄 `model-usage.migration.spec.ts:1-80`，**断言方向按 DROP 反转**）：① baseline **必须**含 `agents` 表的 `worker_id`（`20260925000000_squashed_baseline/migration.sql:130`）；② 新迁移**必须**含 `ALTER TABLE \`agents\` DROP COLUMN \`worker_id\``；③ 新迁移**必须**含两条 `ADD COLUMN \`preferred_worker_id\``（teams 与 team_members）；④ `schema.prisma` 不再声明 `workerId`（Agent 段零命中）且 `preferred_worker_id` 恰好两处；⑤ 新迁移零 `UPDATE`/`INSERT`/`FOREIGN KEY`/`IF EXISTS`/`IF NOT EXISTS`（**断言前必须先剔除 `--` 注释行**，照 `model-usage.migration.spec.ts` 的 `statements()` helper 形状）；同时本迁移的中文理由头**不得写出** `UPDATE`/`INSERT`/`FOREIGN KEY`/`IF EXISTS`/`IF NOT EXISTS`/`preferred_worker_id` 这几个字面量（与 `schema.prisma` 注释的同一约束 `:171` 对齐，否则 T13 的「剔除注释后计数」与「==2 计数」都会打架）；⑥ baseline 里 `agents` 的 `worker_id` 无 FK 无索引（:135-141 的 PRIMARY/UNIQUE/KEY/CONSTRAINT 段零命中）——这既是 DROP 安全的前提，也是「不可逆」的证据。
  - Must NOT：不得编辑 baseline（`docs/migration-baseline.md:29-31`；改动对已部署库是静默 no-op，会永久 schema 漂移）；不得为「未来可能回滚」保留影子列；不得加 FK/索引；不得把 DROP 拆成第二个迁移（本轮一次切干净，回滚靠 dump）。
  Parallelization: Wave 2 | Blocked by: 1, 4, 6 | Blocks: 13
  References (executor has NO interview context - be exhaustive): `server/prisma/migrations/20261010030000_worker_update_state/migration.sql:1-20`（手写 DDL + 中文理由头 + 「逐字等价」自证范式 + `varchar(191)` 说明）、`server/prisma/migrations/20260930010000_memory_role_inject/migration.sql:1-26`（最小迁移范式：编号理由 + why-not 段 + 裸 DDL）、`server/prisma/migrations/20260925000000_squashed_baseline/migration.sql:120-141`（agents DDL，含 :130 worker_id 与无 FK/索引的证据）、`:780-798`（team_members DDL）、`:858-877`（teams DDL）、`:952-957`（workers 域 FK 对照）；`server/src/prisma/model-usage.migration.spec.ts:1-80`（守卫 spec 结构与 helper）、`server/src/prisma/agent-role-drop.migration.spec.ts:1-15`（历史 drop 被折叠进基线的先例——**本轮故意不照做**，理由见 `docs/migration-baseline.md:29-31`）；`docs/tech-debt-rollback.md:1-90`
  Acceptance criteria (agent-executable): `cd server && npx jest src/prisma/team-worker-node.migration.spec.ts` 全绿（六条断言）；`ls -d server/prisma/migrations/*team_worker_node` 恰好 1 个且字典序在 `20261010030000_worker_update_state` 之后；`grep -v '^--' server/prisma/migrations/*team_worker_node/migration.sql | grep -c "DROP COLUMN"` == 1
  QA scenarios (name the exact tool + invocation): happy——守卫 spec 全绿；failure——把 `DROP COLUMN` 行注释掉复跑，断言②转红（突变校验证明守卫真的在读 DDL）；再单独把 baseline 里的 `worker_id` 断言行反转，验证断言①也会红。Evidence .omo/evidence/task-7-team-worker-node.txt
  Commit: Y | feat(db): 迁移 团队/成员首选 worker 列并移除 agents.worker_id（含单向回滚契约）
  Recommended task executor category: `unspecified-high` — 手写 DDL + 反转守卫 spec，正确性无法由真跑 SQL 兜底，必须逐条比对。

- [x] 8. 团队级写路径：`UpdateTeamDto` + `update()` + `toTeamDto`
  What to do / Must NOT do:
  - `UpdateTeamDto`（`update-team.dto.ts:1-46`）加 `preferredWorkerId?: string | null`（`@ApiPropertyOptional` 描述写明：团队级首选 worker，空串/null = 自动调度；成员显式选择优先于本值）。
  - `TeamsService.update()`（`teams.service.ts:313-390`）在 `managedMode` 分支后加：`if (dto.preferredWorkerId !== undefined) data.preferredWorkerId = dto.preferredWorkerId?.trim() || null;` ——**弱校验**：不做存在性检查；代码注释必须写明「与 `mainAgentMemberId` 的存在性校验（:347-365）故意分歧：worker 是软引用，可用性属运行期事实，纯配置操作不应被节点状态阻断；不可用由分派期 warn 收敛」。
  - `toTeamDto()`（:1476-1523）返回 `preferredWorkerId: team.preferredWorkerId ?? null`。
  - 既有 `team.changed`/realtime 广播与 version 乐观锁**保持不变**（不改签名、不新增事件）。
  - Must NOT：不得加存在性校验/外键；不得改乐观锁语义与 `findOne` 的 include 形状；不得新增 route 或权限点（沿用 `teams.edit`，`teams.controller.ts:60-70`）。
  Parallelization: Wave 2 | Blocked by: 6 | Blocks: 10
  References (executor has NO interview context - be exhaustive): `server/src/teams/dto/update-team.dto.ts:1-46`；`server/src/teams/teams.service.ts:285-311`（findOne）、`:313-390`（update 全链 + version 乐观锁 + mainAgentMemberId 校验先例）、`:1476-1523`（toTeamDto）；`server/src/teams/teams.controller.ts:60-70`（PATCH :id + `@RequirePermission('teams.edit')`）；`server/src/teams/teams.service.spec.ts`（既有 update/乐观锁用例）；`web/src/api/teams.ts:42-83`（TeamDto/UpdateTeamPayload，前端契约，Todo 10 消费）
  Acceptance criteria (agent-executable): `cd server && npx jest src/teams` 全绿；新增 3 例：设置值往返、`""`/null 清空为 null、**不存在的 worker id 仍 200 且落库**（弱校验契约）；`grep -n "preferredWorkerId" server/src/teams/teams.service.ts` 命中写入 + DTO 投影
  QA scenarios (name the exact tool + invocation): happy——`PATCH /teams/:id {preferredWorkerId:'w_x', version:n}` 后 `GET /teams/:id` 回吐 `w_x`，version 递增；failure——带过期 version 复跑 → 409 `VERSION_CONFLICT`（既有行为不回归）；再以不存在的 `w_nope` 提交 → 200 且落库（记录为「弱校验」证据）。Evidence .omo/evidence/task-8-team-worker-node.txt
  Commit: Y | feat(teams): 团队级首选 worker 设置
  Recommended task executor category: `unspecified-high` — DTO + service + 投影三处同步，且要守住乐观锁与既有校验先例。

- [x] 9. 成员级写路径 + 三处 DTO 投影同步（团队 DTO / 任务实例 DTO / web 类型）
  What to do / Must NOT do:
  - `UpdateMemberDto`（`add-member.dto.ts:49-95`）加 `preferredWorkerId?: string | null`（描述同团队级，并注明「成员显式选择优先于团队设置」）。
  - `TeamsService.updateMember()`（`teams.service.ts:801-900`）加 `if (dto.preferredWorkerId !== undefined) data.preferredWorkerId = dto.preferredWorkerId?.trim() || null;`（形状照抄 `overrideModelId` :821-822，弱校验同上）。
  - **投影三处同步**（缺一处即回显丢失）：① `teams.service.ts:1477-1500` 成员行加 `preferredWorkerId: m.preferredWorkerId ?? null`；② `tasks.service.ts:2005-2035` 实例投影加同字段并在注释里点明「必须与团队 DTO 同步返回」；③ web 类型 `web/src/api/teams.ts:10-23`（TeamMemberDto）与 `web/src/components/tasks/task-detail-types.ts:22,128-137`（待 Todo 10/11 消费）。本 todo 只负责 server 两处 + **在证据里列出 web 两处的行号清单**（web 类型归 Todo 10，避免同文件并行写）。
  - Must NOT：不得改 `addMember`（新增成员时该列一律为空）；不得动 `resolveMemberBinding`/角色预填逻辑；不得给成员加存在性校验。
  Parallelization: Wave 3 | Blocked by: 6 | Blocks: 11
  References (executor has NO interview context - be exhaustive): `server/src/teams/dto/add-member.dto.ts:49-95`（UpdateMemberDto 及 overrideModelId 描述范式）；`server/src/teams/teams.service.ts:801-900`（updateMember 全链，含 :818-822 overrideModelId 写法与实时广播 :900-910）、`:1476-1500`（toTeamDto 成员投影，注意此处 `m: any` 无需改类型）；`server/src/tasks/tasks.service.ts:57-70`（**`type TeamMemberView` 是闭合对象类型、无索引签名 —— 必须在 `:63` 的 `overrideModelId?` 旁补 `preferredWorkerId?: string | null`，否则 `:2005-2035` 的读取会报 TS2339 并打红 `npx jest src/tasks`**）、`:2005-2035`（实例投影，⚠️「只改一处会被 null 覆盖」的既有注释实际在 `:2028-2030`）；`server/src/tasks/dto/update-instance.dto.ts`（同名兼容入口，本方案不改其语义）；`web/src/api/teams.ts:10-23`、`web/src/components/tasks/task-detail-types.ts:22,128-137`
  Acceptance criteria (agent-executable): `cd server && npx jest src/teams src/tasks` 全绿（含 `npx tsc --noEmit -p tsconfig.json` 通过——`TeamMemberView` 漏字段会在此暴露）；新增 4 例：成员设置/清空往返、团队 DTO 含成员 `preferredWorkerId`、任务实例 DTO 含同值（**两处同值**，防回显丢失）、空串归一为 null
  QA scenarios (name the exact tool + invocation): happy——`PATCH /teams/:id/members/:mid {preferredWorkerId:'w_y'}` 后 `GET /teams/:id` 与 `GET /tasks/:id` 的实例投影都返回 `w_y`；failure——只加团队 DTO 投影并跳过任务实例投影复跑，断言「两处同值」转红（复现既有踩坑）。Evidence .omo/evidence/task-9-team-worker-node.txt
  Commit: Y | feat(teams): 成员级首选 worker + 团队/任务实例 DTO 投影同步
  Recommended task executor category: `unspecified-high` — 两个 service 三处投影，且陷阱在「不同步」。

- [x] 10. web 契约类型 + 团队详情页团队级控件
  What to do / Must NOT do:
  - `web/src/api/teams.ts`：`TeamDto` 加 `preferredWorkerId?: string | null`；`UpdateTeamPayload` 加同字段；`TeamMemberDto` 加同字段（:10-23,42-100）。
  - `web/src/components/tasks/task-detail-types.ts:22,128-137` 成员展示项加同字段。
  - `web/app/(main)/teams/[id]/page.tsx` 在「记忆开关」区（:294-303）下方加同构一行：label「首选 Worker 节点」+ 原生 `<select data-testid="team-worker-select" aria-label="团队首选 Worker（未选则自动调度）">`，首项 `<option value="">自动调度（默认）</option>`，其余按「在线优先 + 名称」排序（照抄 `agents/page.tsx:1563-1568` 的排序与 `:2080-2087` 的 `name · 在线/离线` 文案），说明文字「未选则自动调度到任意可用节点；成员可在会话页覆盖」。change 时 `patchMutation.mutateAsync({ preferredWorkerId: v || null })`（沿用现有 `patchMutation`，带 `version`），成功后失效 `["team", id]`。
  - `web/app/(main)/teams/[id]/page.tsx:141-143` 的 `patchMutation` 载荷是**内联结构类型**（`{ name?; description?; reuseSession?; mainAgentMemberId? }`，**不是** `UpdateTeamPayload`）——必须同步加 `preferredWorkerId?: string | null`，否则 `mutateAsync({ preferredWorkerId })` 不过编译。
  - 存量/悬空 id 的 null-safe 回显：若当前值不在 worker 清单里（节点已删除），select 仍须能正确显示一个 `value=当前id` 的占位项（标签用原始 id），**不得**渲染成空选中或崩溃。
  - worker 数据源复用既有 `queryKey: ["workers"]`（`GET /workers`），不得新造请求形状。
  - Must NOT：不得新增页面/Tab/导航项；不得引入第三方 Select 组件（仓库无共享 Select，惯例是原生 select）；不得删除 agents 页的 workers 查询（Todo 3 同款守卫）；不得要求人工目视验收。
  Parallelization: Wave 3 | Blocked by: 8 | Blocks: 11, 12
  References (executor has NO interview context - be exhaustive): `web/app/(main)/teams/[id]/page.tsx:1-30`（页头职责注释）、`:41-72`（MemberRow 局部草稿范式）、`:79-90`（查询）、`:141-144`（patchMutation + version 乐观锁）、`:146-156`（立即写范式，mainAgentMemberId）、`:170-179`（保存后 invalidate `["team", id]`/`["teams"]`）、`:294-303`（记忆开关区——新控件的落点与样式参照）；`web/app/(main)/agents/page.tsx:1563-1568`（在线优先排序）、`:2065-2087`（选项文案）；`web/src/api/teams.ts:10-23,42-100,107-147`；`web/src/theme/tokens.ts`（neutral/space/radius/fontSize 用法）；`web/AGENTS.md`（改前先看 Next.js 版本差异文档）
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` + `npm run lint`（0 err）+ `npm run build` 全过；`grep -n "team-worker-select" "web/app/(main)/teams/[id]/page.tsx"` 命中；`grep -n "preferredWorkerId" web/src/api/teams.ts` 命中 3 处（TeamDto/UpdateTeamPayload/TeamMemberDto）
  QA scenarios (name the exact tool + invocation): happy——compose 栈上设置节点后 `GET /teams/:id` 回显，刷新页面 select 仍选中该值（`curl` 断言 + 可选 Playwright 手动跑）；failure——把该 worker 从 DB 删除后刷新，select 显示原 id 占位且不抛错（`curl` 无法覆盖 UI，故本项用 `npx playwright test`（需 :3001 已监听，**非默认 gate**）或在 F3 冒烟里断言）。Evidence .omo/evidence/task-10-team-worker-node.txt
  Commit: Y | feat(web): 团队详情页首选 Worker 节点设置
  Recommended task executor category: `visual-engineering` — 前端控件 + 既有视觉/交互惯例对齐（chip/select 与测试属性）。

- [x] 11. 成员面板 worker chip + 会话页接线 + testid 注册
  What to do / Must NOT do:
  - `TeamMembersPanel`（`web/src/components/teams/TeamMembersPanel.tsx`）：成员类型加 `preferredWorkerId?: string | null`（:131）；新增 prop `onChangeWorker?: (instanceId: string, workerId: string | null) => void`（:147 附近，与 `onChangeModel` 并列）；在模型 chip 旁加 worker chip：`data-testid={`agent-worker-chip-${a.instanceId ?? a.id}`}`，`aria-label="设置 Worker 节点"`，未设＝虚线态「跟随团队」、已设＝实线态显示节点名（样式照抄模型 chip :464-498 的两态）；展开列表首项「跟随团队」（清除，`onChangeWorker(id, null)`）＋在线/离线节点项（结构照抄 :643-724，列表项照抄 :689-717），点选即 `onChangeWorker(id, workerId)` 并收起。
  - `web/app/(main)/teams/[id]/session/page.tsx`：加 `instanceWorkerMutation`——`api.patch(\`/teams/${teamId}/members/${instanceId}\`, { preferredWorkerId: workerId ?? null })`，onSuccess 失效 `["team", teamId]`，并在队列有任务时同时失效 `["task", queueHeadTaskId]`（照抄 :1117-1119 的模型 mutation 与 :1120-1128 的失效注释）；把 `onChangeWorker` 接到 `<TeamMembersPanel>`（:1310-1330）；成员映射处补 `preferredWorkerId: m.preferredWorkerId ?? null`（:433 一带的 teamAgentMembers 与任务实例映射两处，缺一处即回显丢失）。
  - `web/e2e/reference/testids.ts`：在 `/agents` 段相邻位置注册新 testid（`team-worker-select`、`agent-worker-chip`、`agent-worker-option` 或与实现一致的确切名）。
  - Must NOT：不得把「跟随团队」实现成「跟随模板」；不得改模型 chip 行为与既有 `onChangeModel` 契约；不得新增页面；worker 清单复用 `["workers"]` 缓存。
  Parallelization: Wave 3 | Blocked by: 9, 10（**必须先有 T10 的类型声明**：本 todo 读 `m.preferredWorkerId`（`m: TeamMemberDto`）与任务实例类型，二者都由 T10 在 `web/src/api/teams.ts:10-23` 与 `task-detail-types.ts:22` 声明；并行会让 `tsc --noEmit` 报 TS2339，同文件 `:434` 的 `(m as {...})` 强转正是这类滞后留下的疤） | Blocks: 12
  References (executor has NO interview context - be exhaustive): `web/src/components/teams/TeamMembersPanel.tsx:110-149`（props 契约）、`:131`（成员元素形状）、`:208-216`（模型清单查询）、`:348`（有效值回退范式）、`:464-498`（chip 两态样式与 data-testid 命名）、`:643-724`（展开列表 + 首项默认项 + 行项）、`:996`（文件尾）；`web/app/(main)/teams/[id]/session/page.tsx:420-445`（teamAgentMembers 映射）、`:1117-1128`（模型 mutation + 失效）、`:1310-1330`（面板接线）、`:1580-1595`（右栏其它 mutation 参照）；`web/e2e/reference/testids.ts:140-160`（注册位置与格式）；`web/src/components/teams/TeamMembersPanel.tsx:996` 附近导出（`roleOptionsOf/customAgentsOf`）保持不动
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` + `npm run lint`（0 err）+ `npm run build` 全过；**行为断言（不得只有 grep 计数）**：`grep -n "api.patch(\`/teams/\${teamId}/members/\${instanceId}\`, { preferredWorkerId" "web/app/(main)/teams/[id]/session/page.tsx"` 命中（端点与字段名逐字正确）；`grep -n 'invalidateQueries({ queryKey: \["team", teamId\] })' "web/app/(main)/teams/[id]/session/page.tsx"` 在 `instanceWorkerMutation` 的 onSuccess 内命中，且队列任务缓存失效同时存在；`grep -c "preferredWorkerId" "web/app/(main)/teams/[id]/session/page.tsx"` ≥ 3（成员映射两处 + mutation）
  QA scenarios (name the exact tool + invocation): happy——compose 栈：成员 chip 设节点后 `GET /tasks/:id` 实例投影与 `GET /teams/:id` 成员投影都返回该值（防回显丢失），且**用 Todo 12 的冒烟脚本 B 段断言 PATCH 真实打到成员端点**（grep 无法证明接线正确）；failure——置空（点「跟随团队」）后断言成员值为 null 且团队值仍在（回退到团队而非自动调度的证据链在 Todo 5 单测覆盖）。Evidence .omo/evidence/task-11-team-worker-node.txt
  Commit: Y | feat(web): 成员 Worker 节点 chip 与会话页接线
  Recommended task executor category: `visual-engineering` — 复用既有 chip/展开列表交互，重点是与模型 chip 的视觉与失效一致性。

- [x] 12. 编写端到端冒烟脚本 `scripts/e2e-team-worker-node.sh`（F3 的可执行载体）+ 栈重建前置
  What to do / Must NOT do:
  - 新建 `scripts/e2e-team-worker-node.sh`，头部格式照抄 `scripts/e2e-roles-members.sh:1-25`（`#!/usr/bin/env bash`、`# e2e: <一句话>`、`# Proves against the LIVE compose stack (web :13001 + server :13000):`、`A./B./C./D.` 场景字母、`# Run (from repo root): bash scripts/e2e-team-worker-node.sh`、`# Screenshot: $EVIDENCE_DIR/task-12-*.png`），断言四项且全部经真实 HTTP/DB：
    - **A** 团队详情页可设首选节点：`PATCH /api/v1/teams/:id {preferredWorkerId, version}` → `GET /teams/:id` 回吐该值；再 `PATCH` 为 `""`/null → 回吐 `null`（自动调度）。
    - **B** 成员选择压过团队：团队设 `w_a`、成员设 `w_b` → 断言 `GET /teams/:id` 与 `GET /tasks/:id` 的实例投影**两处都**返回 `w_b`（防回显丢失）；随后清空成员值 → 两处回到 `w_a`（回退到团队而非自动调度）。
    - **C** 置顶节点离线 → 软回退：把 `w_b` 置 offline 后触发一次分派，断言**无 5xx**、会话最终绑定的 worker ≠ `w_b`，且 server 日志出现置顶未命中的 warn。**前置：栈上必须已有 ≥2 个在线 worker**（见下），否则「把唯一节点置离线」会让 `assignWorker` 返回 null 并命中 `worker-dispatcher.ts:2307` 的硬抛「无可用 worker」→ 5xx，正是 C 段要否定的结果。
    - **D** 无可用节点时不抛置顶错误：置顶 id 指向不存在/离线的 worker 时，分派仍按自动调度完成（不得抛「无可用 worker」因置顶）。同样要求栈上存在**另一个**可用节点。
  - **前置 1（必须先 build，再重建栈）**：`docker compose build server web && docker compose down && docker compose up -d`——`server/Dockerfile:13-18,24,28` 把 `prisma/`（含迁移）与 `dist/` 烤进镜像，只 `up -d` 会用旧镜像：新迁移不在镜像里（init 的 `migrate deploy` 建不出新列）、新 `PATCH` 字段被 whitelist 静默剥离（`server/src/main.ts:52-60`，不报 400）。仓库 8 个 `scripts/e2e-*.sh` 全部先 build，被本计划引用的 `scripts/e2e-roles-members.sh:19` 亦然。build 之后若 init Job 已完成，再删除它以重跑迁移。
  - **前置 2（≥2 个在线 worker，且第二个必须是真的、可达的）**：compose 只有单个 `worker` 服务，`container_name: vteam-compose-worker` 与 `WORKER_ID: w_compose_worker` 写死（`docker-compose.yml:126-135`），`--scale worker=2` 不可用，`server/prisma/seed.ts` 不建 `Worker` 行。**唯一可行构造**（写进脚本注释与文件头）：
    ```
    docker compose run -d --name vteam-e2e-worker2 -e WORKER_ID=w_e2e_second worker
    ```
    它复用同一镜像、注入同一 `SERVER_URL=http://server:3000` 与 `X_WORKER_TOKEN`，因此会正常注册并每 10s 心跳、保持在线且**可被分派**（`workerClient.createSession` 能连通）。
    **两条被否掉的捷径（写进注释以免执行者重踩）**：① 直接用 `docker compose exec db mysql` 插一行 `workers` —— 该行会被 `markStaleWorkersOffline()`（`workers.service.ts:829-845`，`onModuleInit` + 每 10s）在 ≤10s 内翻成 offline（判据 `lastHeartbeatAt IS NULL OR < now-30s`），且 `opencode_version` 为 NOT NULL 无默认值；即便撑住，DB-only 节点不可达，`dispatchForTeamTarget` 的 `createSession` 会 rethrow（`worker-dispatcher.ts:2479,2492`）→ 正是 C/D 要否定的 5xx。② `scripts/worker-stub-server.py` **不是 worker**：它是「假 server / 控制面 stub」（自己接收 register/heartbeat），跑它不会在真实 `:13000` 上多出在线节点。
    **与验收对齐**：C/D 两段在少于 2 个在线节点时**必须显式 FAIL 并说明**（不得静默 skip）——因为本 todo 的验收与成功标准 6 都要求 A/B/C/D 四项 PASS，skip 会让它们结构性不可满足；前置 2 失败即脚本非 0 退出。
  - **悬空 id 的可验证部分**：脚本用 API 断言「保存一个不存在的 worker id 仍 200 且原样回吐（弱校验），随后分派仍走自动调度且不报错」——这是可确定性验证的那一半。
  - **UI 占位回显（悬空 id 在 select 里显示原始 id）只能由浏览器断言**：把它写进脚本的**可选** Playwright 分支（显式标注前置 :3001、**不得**塞进默认 gate），并在证据文件里注明「未跑 Playwright ⇒ 该 UI 保证本轮无自动护栏，属 non-blocking」——**不得**把它写成任何 Success criteria 的必过项。
  - Must NOT：不得硬编码口令（用 compose 变量名或占位符）；不得把脚本挂进 `scripts/gate.sh` 的默认路径；不得依赖 `web/.next/` 构建产物做断言；不得跳过 build 直接 `up -d` 后把「新列不存在」当成功能缺陷来排查。
  Parallelization: Wave 4 | Blocked by: 10, 11 | Blocks: 13
  References (executor has NO interview context - be exhaustive): `scripts/e2e-roles-members.sh:1-25`（头部与用法范式，含 :19 的「先 build 再 up」前置）、`scripts/` 现有 15 个 `.sh`（命名与 `EVIDENCE_DIR` 用法；其中 8 个带 build 前置）、`scripts/gate.sh:15-19`（Playwright 只 opt-in 的说明）、~~`scripts/worker-stub-server.py`~~（**不是 worker**：它是「假 server / 控制面 stub」，见其文件头 `模拟 server 控制面最小实现`；第二个节点必须用上面的 `docker compose run … worker` 真实构造）；`server/Dockerfile:13-18,24,28`（镜像烤入 `prisma/` 与 `dist/`）；`docker-compose.yml:44-54`（init 服务 `npx prisma migrate deploy && node dist/prisma/seed.js`）、`:126-135`（单 worker 服务与被写死的 `WORKER_ID`/`container_name`）；`server/prisma/seed.ts`（**不建** `Worker` 行）；`server/src/chat/worker-dispatcher.ts:2307,2337`（无可用 worker 的硬抛，两次分派各一处）；`server/src/main.ts:52-60`（whitelist 静默剥离）；`server/src/teams/teams.controller.ts:61-63,89-98`（两个 PATCH 端点与 `teams.edit` 权限）；`server/src/teams/teams.service.ts:313-390,801-900,1476-1523`；`server/src/tasks/tasks.service.ts:2005-2035`；`.omo/evidence/`（证据目录与命名惯例）
  Acceptance criteria (agent-executable): `bash scripts/e2e-team-worker-node.sh` 退出码 0 且 stdout 明确列出 A/B/C/D 四项 PASS；证据 `.omo/evidence/task-12-team-worker-node.txt` 含脚本原文输出、**≥2 个在线 worker 的构造过程（命令与输出）**、以及 server 日志片段（warn 行）；`ls -l scripts/e2e-team-worker-node.sh` 存在且可执行（`test -x`）
  QA scenarios (name the exact tool + invocation): happy——栈重建后 `bash scripts/e2e-team-worker-node.sh`，A-D 全 PASS；failure（**必要性证明**）——把团队值写成不存在的 `w_nope` 复跑 C/D 段，脚本必须仍然 PASS（软回退生效），而把置顶代码临时改成硬绑定（不可回退）后 C 段必须失败——用一次临时突变验证脚本真的在检「软回退」而不是走过场（验证后立即还原）。Evidence .omo/evidence/task-12-team-worker-node.txt
  Commit: Y | test(e2e): 团队/成员首选 worker 端到端冒烟
  Recommended task executor category: `unspecified-high` — 需要起栈、构造离线节点、读 server 日志，四段断言都要真实可复现。

- [x] 13. 收口：全仓残留引用复核 + `bash scripts/gate.sh` 全绿
  What to do / Must NOT do:
  - 残留复核（逐条给出实际输出，不得只写"已检查"）。三条硬性约束：**① grep 必须限定源码路径**（否则命中被 gitignore 的 `web/.next/` 构建产物，实测 18 命中）；**② 计数类 grep 必须先用 `grep -v '^--'` 剔除注释行**（中文理由头会写进表名/关键字，实测先例 `20261010030000_worker_update_state/migration.sql` 的 `grep -c "workers"` = 4、`grep -c "ALTER TABLE"` = 2，全来自头部注释）；**③ 范围必须收窄到本计划真正删除的那一面**，不得写成全仓 grep——`server/src` 里有 46+ 处 `dto.workerId` 属 Worker 域（`RegisterWorkerDto`/`HeartbeatWorkerDto`/`WorkerEventDto`，见 `workers/dto/worker-dto.spec.ts`、`worker-event.ingress.ts`）：
    - `grep -rn "agent-worker-select" web/app web/src web/e2e docs` 零命中。
    - **Agent 级文案消失（收窄到 agents 面）**：`grep -rn "首选 Worker" "web/app/(main)/agents" web/src/components/agents docs/agent-platform` 零命中。
    - **同期正面断言**：新功能文案必须还在——`grep -c "首选 Worker" "web/app/(main)/teams/[id]/page.tsx"` ≥ 1（T10 新写的标签）。
    - **删除面（拆成两条，各自可满足）**：`grep -rn "dto\.workerId" server/src/agents` 零命中 **且** `grep -rn "agent\.workerId" server/src` 零命中。
    - **已知保留（正面断言，防误删）**：`grep -rn "dto\.workerId" server/src/workers | wc -l` 仍 ≥ 40（Worker 域入站 DTO 语义）；`OpencodeAgentsResult.workerId`、`AgentRolesTab.tsx:78-82`、`ExternalAgentsPanel.tsx:73-77`、`agents.controller.ts` 的 `?workerId=` 四处**仍然存在**。
    - `awk '/model Agent /,/^}/' server/prisma/schema.prisma | grep -c workerId` 输出 0。
    - **迁移计数（剔除注释行后）**：`grep -v '^--' server/prisma/migrations/*team_worker_node/migration.sql | grep -c "DROP COLUMN"` == 1；同法 `grep -c "ALTER TABLE"` == 3（2 个 ADD + 1 个 DROP）；同法 `grep -c '\`agents\`'` == 1；`grep -v '^--' server/prisma/migrations/*team_worker_node/migration.sql | grep -c "preferred_worker_id"` == 2（两条 ADD 各一次；**先剔注释**，否则中文理由头里的列名字面量会把计数顶高）。
  - 跑门禁：`cd server && npx prisma generate`，然后仓库根 `bash scripts/gate.sh`。**不得**加 `--with-playwright`（`scripts/gate.sh:15-19`：需 :3001 已监听，属 opt-in）。
  - Must NOT：不得为了让门禁变绿而放宽 lint 基线或跳过用例；不得 `git checkout` 回滚已完成的实现；不得提交任何 `.omo/evidence/ddl-*.sql`（判据 `git ls-files --error-unmatch` 须失败，**不得**用 porcelain 计数——该类文件被 `.gitignore:45` 忽略，计数恒 0 无检出能力）；不得抬头 bare-catch 基线（`scripts/gate.sh:70-71` 只允许降低）；**不得清理本计划开工前就已存在的无关脏文件**（见 References 的脏工作区清单）。
  Parallelization: Wave 4 | Blocked by: 2, 3, 5, 7, 10, 11, 12 | Blocks: -
  References (executor has NO interview context - be exhaustive): `scripts/gate.sh:1-30`（门禁步骤：`prisma generate` → lint:check → test → test:e2e → build；Playwright 仅 opt-in；lint 基线 0 err）、`server/package.json`、`web/package.json`、`worker/package.json`；**开工时已存在的无关脏文件（计划开始前后均存在，禁止清理、也从本计划的 diff 中排除）**：`server/src/platform-mcp/platform-mcp.service.ts`、`server/src/platform-mcp/platform-mcp.controller.ts`、`server/src/platform-mcp/platform-mcp.tools.ts`、`web/src/components/chat/msg-parts.tsx`、`.omo/evidence/*.json`；`web/e2e/reference/testids.ts`
  Acceptance criteria (agent-executable): **门禁按「无新增失败」判定，不得以 `gate.sh` exit 0 为判据**——开工前实测 `bash scripts/gate.sh` 已是红的：bare-catch 守卫 `176 > 基线 175`（`scripts/gate.sh:73-81`，同一守卫镜像在 `.github/workflows/ci.yml:41-46`），且 `176` 在 worktree 与 HEAD 处一致（`git grep -E 'catch[[:space:]]*{' <base-sha> -- server/src | grep -v '\.spec\.ts' | wc -l` = 176），属**预存在**红；`gate.sh:70-71` 明写该阈值「只能降低、不得抬高」，故本计划**不得**去改基线（Todo 13 的 Must NOT 亦禁止）。改为逐步骤跑并留证：`cd server && npx prisma generate && npm run lint:check && npm test && npm run test:e2e && npm run build`，再 worker 与 web（`scripts/gate.sh:90-95` 同一组步骤）——**除两项已记录的既存红外全部必须绿**：①bare-catch 守卫 `176 > 基线 175`（工作区/HEAD/开工基线三点实测一致，本项目零新增）；②**prettier/lint 既存积压**（T13 实测 `lint:check` 报 99 处、其中 93 处既存；本项目引入的 6 处由追加项 T16 修掉，修后计数必须回落到 93 且本计划文件零命中）——判据是「**无新增失败**」，不得以整体退出码 0 为判据，也不得抬任何基线；bare-catch 作为**预存在例外**如实记录（含上述 base-sha 处的实测命令与输出原文）；上述全部 grep 复核的**命令与原始输出**粘进证据文件（不得摘要），且每条都满足：注释剔除后的计数、agents 面收窄、Worker 域正面保留断言；`git status --porcelain | grep -c 'ddl-team-worker-node'` 输出 0；`git status --porcelain` 与开工快照（Todo 1）对比，**无新增**未跟踪/修改文件（除本计划自己的改动）
  QA scenarios (name the exact tool + invocation): happy——`bash scripts/gate.sh > .omo/evidence/task-13-gate.log 2>&1; echo exit=$?` 输出 exit=0；failure（**必要性证明**）——在源码目录故意保留一处 `agent-worker-select` 复跑对应 grep，输出非零（用完立即还原），证明复核项真的在检且不再被 `.next/` 噪声淹没。Evidence .omo/evidence/task-13-team-worker-node.txt
  Commit: N（证据并入 F 波）
  Recommended task executor category: `quick` — 机械复核 + 一条既定门禁命令。

- [x] 14. 证据回执准确性更正（T1 基线计数/分类 + T2 §6 diffstat）
  What to do / Must NOT do:
  - 按 `.omo/evidence/verify-task-1-team-worker-node.txt` 的 §D1 给出的替换文本，修正 `.omo/evidence/task-1-team-worker-node.txt` 第 30-31 行：porcelain 块实为 **14 行**（非 13），其中 **5 行是本计划自己的编排产物**（`.omo/boulder.json`、`.omo/ulw-execute/ledger.jsonl`、`.omo/plans/team-worker-node.md`、`.omo/drafts/team-worker-node.md`、`.omo/notepads/team-worker-node/`），**真正的开工前脏基线是 9 个文件**；两类必须分开表述（前者会随执行合法变动，后者禁止触碰）。
  - 修正 `.omo/evidence/task-2-team-worker-node.txt` §6 的 diffstat 数字：以 `git diff --shortstat -- server/src/agents` 的真实输出为准（当前实测 3 files changed, 1 insertion(+), 23 deletions(-)），原写的 8/3 是清理中途抓取的旧值。
  - Must NOT：**不得**追加「部署前须补 dump」这条 grep 满足行（D2 已裁定「意图已满足」，且计划第 47 行禁止把验收写成文档文本 grep 计数）；不得改动两份回执的其它内容；不得触碰任何产品文件；不得执行任何 git 写命令。
  Parallelization: Wave 1 | Blocked by: 1, 2 | Blocks: - 
  References (executor has NO interview context - be exhaustive): `.omo/evidence/verify-task-1-team-worker-node.txt` §D1（精确替换文本）与 §D2（裁定）；`.omo/evidence/task-1-team-worker-node.txt:30-31`；`.omo/evidence/task-2-team-worker-node.txt` §6；`docs/tech-debt-rollback.md:1-90`（该回执引用的契约来源）；`server/src/agents`（T2 §6 数字的来源路径）
  Acceptance criteria (agent-executable): `grep -c "14 行" .omo/evidence/task-1-team-worker-node.txt` ≥ 1 且 `grep -n "9 个文件\|9 files" .omo/evidence/task-1-team-worker-node.txt` 命中；`grep -n "23 deletions" .omo/evidence/task-2-team-worker-node.txt` 命中；`git diff --shortstat -- server/src/agents` 的输出与 T2 §6 内写明的数字逐字一致；`grep -c "部署前须补 dump" .omo/evidence/task-1-team-worker-node.txt` 仍为 0（**必须保持为 0**，证明没有为讨好 grep 而加行）
  QA scenarios (name the exact tool + invocation): happy——`sed -n '28,34p' .omo/evidence/task-1-team-worker-node.txt` 显示更正后的计数与两类分离表述，且 `git diff --shortstat -- server/src/agents` 与回执数字一致；failure——若把两类混为一谈（把 5 个编排产物算进「开工前脏基线」），`grep -n "9 个文件"` 将失配，即判红。Evidence .omo/evidence/task-receipt-fix-team-worker-node.txt
  Commit: N（证据并入 F 波）
  Recommended task executor category: `quick` — 两处文本更正 + 一条 shortstat 核对，机械可验。

- [x] 15. 注册 team-worker-select 到 testids 参考清单（Todo 11 验证发现的一行缺口）
  What to do / Must NOT do:
  - 在 `web/e2e/reference/testids.ts` 的 `PAGE_SMOKE` 映射里、紧邻现有的 "/teams" 键（约 :554）新增一个 "/teams/[id]" 键，列出团队**详情页**真实存在的 testid：最小忠实写法是 `["team-detail-root", "team-worker-select", "enter-team-session", "team-save-name"]`（以页面实际 testid 为准核对，多列的必须真的存在）。
  - 必须在 `PAGES` 数组里保持「无 /teams/[id] 审计条目」的现状（该页从未进入 Phase 0 审计，凭空加条目等于谎称其穷尽性）。
  - Must NOT：**不得**把 chip/option 条目（agent-worker-chip-*、agent-worker-option-*）从 `/teams/[id]/session` 段挪到 `/agents` 段——`TeamMembersPanel` 的唯一渲染点是会话页，会话页芯片放到 /agents 会让该文件的「按路由」契约变成事实错误；不得改任何产品代码；不得改其它 testid 条目。
  Parallelization: Wave 3.5（T11 之后、T13 之前） | Blocked by: 11 | Blocks: -
  References (executor has NO interview context - be exhaustive): `web/e2e/reference/testids.ts:554`（PAGE_SMOKE 的 "/teams" 与 "/teams/[id]/session" 键）、`:191`（2.3b team-session 的 PAGES 条目，chip 条目已在其 testids 列表中）、`:235-240`（T11 新增的三个 chip/option 条目）；`web/app/(main)/teams/[id]/page.tsx`（详情页真实 testid 的唯一来源：`team-worker-select` 在 :347，其余以 grep 实测为准）；`.omo/evidence/verify-task-11-team-worker-node.txt`（验证者给出的最小修法原文）
  Acceptance criteria (agent-executable): `grep -c "team-worker-select" web/e2e/reference/testids.ts` ≥ 1；`grep -n '"/teams/\[id\]"' web/e2e/reference/testids.ts` 命中且其数组内每个 testid 都能在 `web/app/(main)/teams/[id]/page.tsx` 里 grep 到（逐条给出命令与输出）；`grep -n "agent-worker-chip" web/e2e/reference/testids.ts` 仍只在会话段（行号仍在 team-session 条目区间内）；`cd web && npx tsc --noEmit; echo TSC_EXIT=$?` 为 0
  QA scenarios (name the exact tool + invocation): happy——列出新增键的每个 testid 并在详情页 grep 命中（命令与输出原文）；failure——把 `team-worker-select` 误写成不存在的名字 `team-worker-select-typo`，复跑上述逐条 grep 必须失配（用完立即还原）。Evidence .omo/evidence/task-15-team-worker-node.txt
  Commit: N（并入 F 波前的收口提交）
  Recommended task executor category: `quick` — 单文件一行映射 + 逐条 grep 核对。

- [x] 16. 修复本计划引入的 6 处 prettier lint 错误 + 把 lint 判据校正为「无新增失败」
  What to do / Must NOT do:
  - 先建立 **lint 基线证据**：在**开工基线 sha**（计划记录为 `b6840d1c…`）与当前 HEAD（`cb0ba6d1…`）两处分别取 `cd server && npm run lint:check` 的报告，记录各自的错误总数（T13 实测当前为 **99**：其中 **93 既存**、**6 本计划引入**）；同时在当前工作区确认这 6 处的具名清单（5 处在 `server/src/prisma/team-worker-node.migration.spec.ts`，1 处在 `server/src/chat/worker-dispatcher.spec.ts:3442`，属 T5 新增用例的 CJK 折行超宽）。
  - **只修本计划引入的 6 处**：对这两个文件跑 `npx prettier --write`（或按报告逐条修），禁止顺手动任何既存 prettier 债（尤其 `server/src/platform-mcp/*` 这类对路/既有脏文件）。
  - 修完必须复跑 `cd server && npm run lint:check; echo LINT=$?`，并给出**前后计数对照**：99 → 93（恰好 −6，且不再有本计划文件出现在报告里）。
  - 必须复跑受影响的两条测试与类型检查，证明格式改动未改语义：`npx jest src/prisma/team-worker-node.migration.spec.ts src/chat/worker-dispatcher.spec.ts; echo JEST=$?` 与 `npx tsc --noEmit -p tsconfig.json; echo TSC=$?`。
  - Must NOT：抬 lint 基线、跳过检查、改任何非本计划文件、跑任何 git 写命令；不得把「既存 93 处」当作可修范围。
  Parallelization: Wave 4 收口 | Blocked by: 13（T13 度量）| Blocks: F 波
  References (executor has NO interview context - be exhaustive): `.omo/evidence/task-13-team-worker-node.txt` §6（99/93/6 的实测与具名清单）与 `.omo/evidence/task-13-gate.log`（逐步骤退出码原文，含被作废的那次 `BUILD=254` 调用错误）；`server/src/prisma/team-worker-node.migration.spec.ts`（T7 新增，5 处 prettier 未格式化）；`server/src/chat/worker-dispatcher.spec.ts:3442`（T5 新增 fail-open 用例，CJK 折行超 80 列）；`server/package.json` 的 `lint:check` 脚本定义；`scripts/gate.sh`（lint 步骤的调用方式）
  Acceptance criteria (agent-executable): `cd server && npm run lint:check; echo LINT=$?` 的报告里**本计划文件零命中**，且错误总数由 99 降到 **93**（以实测为准，逐条对照给出）；`npx jest src/prisma/team-worker-node.migration.spec.ts src/chat/worker-dispatcher.spec.ts` 全绿；`npx tsc --noEmit -p tsconfig.json` 退出 0；`git log --oneline -1` 未变（不得提交）
  QA scenarios (name the exact tool + invocation): happy——prettier --write 后复跑 lint:check，粘前后计数与「本计划文件不再出现」的原始输出；failure——把改动临时还原一处（例如把 spec 里某行重新拉回超宽/错缩进），复跑 lint:check 确认该处**重新出现**（证明这些错误确实由我们引入、且修复有效），然后再次修好。Evidence .omo/evidence/task-16-team-worker-node.txt
  Commit: N（并入波次边界提交）
  Recommended task executor category: `quick` — 两文件格式化 + 前后计数对照 + 两条测试复跑。

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
>
> **验收处置（用户 2026-10-14 决定：approved-with-notes）**：双路高精度评审跑到收敛上限 5 轮，最后一轮仍有 **2 条单行级残留**（见 F1 ⑥ 与 F3 ②），用户选择**接受**并以下述方式处置 —— 本节条目即为这 2 条残留的**权威判据**；**凡计划其它位置与之冲突的表述，一律以本节为准**（冲突点已就地标注）。
- [x] F1. Plan compliance audit —— 逐 todo 对照本计划核算：① **13 个 todo** 的每一项「Acceptance criteria」是否都有真实执行输出（证据文件里必须是命令原文 + 原始输出，不接受「已通过」的摘要）；② 优先级链是否确为「成员显式 > 团队 > 现状」（读 `worker-dispatcher.ts` 组链处与 `workers.service.ts` 判定处两处源码，逐字核对）；③ 四道过滤是否全部保留（逐条对比 `workers.service.ts:884-891`）；④ 迁移是否**追加**而非改基线（`ls` 目录 + `git diff --stat server/prisma/migrations/20260925000000_squashed_baseline/migration.sql` 必须为空）；⑤ T6 是否真把 `workers.service.ts:1319-1322` 与其 spec 断言一并处理（列与写路径必须同生共死）；⑥ **【已知残留·权威判据】门禁按「无新增失败」判定，不得以 `gate.sh` 退出码 0 为判据** —— `scripts/gate.sh:76-81` 的 bare-catch 守卫在其它步骤之前 `exit 1`（计数 176 > 基线 175，worktree 与 base-sha 处一致，`gate.sh:70-71` 明写不得抬高），属**开工前既存**红；因此 **T13 的 QA happy 行「输出 `exit=0`」与第 253 行「8 个 `scripts/e2e-*.sh` 全部先 build」这两句均为被本节废止的旧表述**，执行者按本节执行：应观察到 `exit=1` 且唯一 FAIL 行为 bare-catch，其后逐步骤（`prisma generate`/lint/test/test:e2e/build + worker + web）各自 exit 0，且本计划未新增 bare catch、未改基线；`git status --porcelain | grep -c 'ddl-team-worker-node'` 一句亦为**零检出判据**，以 Todo 1 的 `git ls-files --error-unmatch` 必须失败为准。证据 `.omo/evidence/F1-team-worker-node.txt`
- [x] F2. Code quality review —— 独立复核者以「反方」立场找问题：置顶分支是否会静默改变模型结果（B2 的 warn 是否真的可达，且有可失败测试）、`assignWorker` 新增分支是否让 **9 处**调用方行为变化（逐一列出调用点并给出「未变化」的证据——`worker-dispatcher.ts:2305,2335`、`agents.service.ts:413,461,499,535,575`、`opencode-agent-name.validator.ts:31`、`teams.service.ts:923`。**注意例外**：只有分派的 2 处会携带 `assignmentReq`（`{} | { modelId }`），其余 7 处要么无参、要么仅 `opts.workerId` 兜底；判据是「`preferredWorkerId` 为 undefined 时行为不变」）、弱校验是否留下永久悬空 id 且无任何可观测痕迹、删除面是否误伤「取数 worker」语义四处、TypeScript/Prisma 是否零 `any` 新增滥用。**必须独立打开源码**，不得只读本计划。证据 `.omo/evidence/F2-team-worker-node.txt`
- [x] F3. Real manual QA —— 真跑（不是读代码）：`docker compose build server web && docker compose down && docker compose up -d`（**必须先 build**：`server/Dockerfile:13-18,24,28` 把 `prisma/` 与 `dist/` 烤进镜像，只 `up -d` 会用旧镜像——迁移文件不在镜像里、`PATCH` 的新字段被 whitelist 静默剥离；先例一致：本计划引为格式模板的 `scripts/e2e-roles-members.sh:19` 明写 `docker compose build server web && docker compose up -d server web`（**不要写脚本数量统计**——该数字不是判据，且本轮对「10 个 `scripts/e2e-*.sh` 里几个带 build」存在分歧）。或：build 之后删除已完成的 init Job 再 up）让新迁移经 init 服务应用 → `bash scripts/e2e-team-worker-node.sh`（A 团队设置回显 / B 成员选择压过团队 / C 置顶节点离线后回退且无 500 + 日志有 warn / D 无可用节点时不抛置顶错误）→ **门禁按「无新增失败」判定**（`gate.sh` 整体非 0 是开工前既存的 bare-catch 守卫红，见 F1 ⑥）：逐步骤跑 `prisma generate`/`npm run lint:check`/`npm test`/`npm run test:e2e`/`npm run build` + worker + web，除该守卫外全部 exit 0。所有断言必须来自真实 HTTP/DB/日志输出。
>
> ② **【已知残留·权威判据】第二个 worker 必须宣告**自己的**地址**：`docker-compose.yml:137` 硬编码 `WORKER_ADVERTISE_HOST: http://worker`，`docker compose run` 会原样继承，而服务端 `worker/client.ts:1102-1108` 优先读 `caps.baseUrl` ⇒ 不额外传参时两个节点上报**同一个** baseUrl，C 段会因错误原因 5xx，且会把误失败归因到「软回退被写成硬绑定」。执行者须在 Todo 12 的命令上追加 `-e WORKER_ADVERTISE_HOST=http://vteam-e2e-worker2`，并钉死 **`w_a` = `w_compose_worker`（service 容器）、`w_b` = `w_e2e_second`（run 出来的容器）**；第 258 行「保持在线且可被分派」的表述按此修正。证据 `.omo/evidence/task-12-team-worker-node.txt` + `.omo/evidence/task-13-gate.log`
- [x] F4. Scope fidelity —— 对照「Must have」8 条与「Must NOT have」**13 条**逐条判定：特别确认本计划**自己的提交**对 `platform-mcp` 目录零改动（用 `git diff <开工前 base-sha>..HEAD -- server/src/platform-mcp/` 核对，**不得**用工作区裸 `git diff`——该文件在开工前已被无关改动弄脏）、`server/src/workers/workers.service.ts` 内 **`matchesModelRequirement` 块零 diff**——可执行判据：`git diff <base-sha>..HEAD -U0 -- server/src/workers/workers.service.ts | grep '^@@'` 不得出现覆盖 `:901-938` 的 hunk（同文件本计划会改 `assignWorker` 与 `remove()`，故不能整文件比 diff）、baseline 零改动、无 FK/索引新增、`worker/` 目录零改动、Agent 级 worker 偏好确实不复存在（而非被改名保留）。证据 `.omo/evidence/F4-team-worker-node.txt`

## Commit strategy
- 按 todo 的 Commit 行提交，**11 次提交**（T1/T13 为 N，证据并入 F 波）。顺序：T2/T3/T4（移除面 + 调度核心）→ **T5/T6/T7/T8**（schema/类型/迁移/dispatcher 接线/团队写路径；T5 必须与 T6 相邻）→ T9（成员写路径 + 类型 + 投影）→ T10/T11（web 两处 UI）→ T12（冒烟脚本）。
- **提交边界即编译边界**：T2 之后到 T6 之前不得单独发布（T2 只是摘掉读写，schema 列仍在）；T6 与 T7 之间不得单独发布（schema 声明已摘而 DB 尚未 DROP）。T6 必须把 schema、`workers.service.ts:1319-1322`、其 spec 断言、以及 teams/team_members 两处新清理放在**同一次提交**内，否则 build 或 jest 必红。
- 迁移与守卫 spec 必须在**同一提交**（T7），且提交说明里写明「单向 DDL，回滚 = reset + dump restore」。
- 提交信息用仓库既有的 `<type>(<scope>): 中文摘要` 约定；不得把 `.omo/evidence/ddl-*.sql` 入库。
- 开工前先对 `git status --porcelain` **快照留档**（`.omo/evidence/task-1-team-worker-node.txt`）：本计划开始前该工作区已脏（`server/src/platform-mcp/*`、`web/src/components/chat/msg-parts.tsx`、`.omo/evidence/*.json` 等）。合并前只要求「相对快照无**新增**改动」，**禁止**用 `git checkout`/`git stash` 清理这些既有脏文件。

## Success criteria
1. 团队详情页可设「首选 Worker 节点」，成员面板可设成员级节点（默认「跟随团队」），两者均持久化且刷新后回显不丢（团队 DTO 与任务实例 DTO 一致）。
2. 分派优先级**可被测试证明**为「成员显式 > 团队 > 现状」：成员值存在时 `assignWorker` 收到成员值；仅团队有值时收到团队值；两级皆空时收到 `{}`（与今日完全一致）。
3. 置顶节点不可用时**永不阻塞**：行缺失/offline/容量不足/opencodeVersion 不符/**有模型能力但无一匹配（含 enabled=false）**/从未上报模型能力且 modelId 非空 —— 六种情况全部软回退自动调度，且各有单测与 `warn` 证据；degraded 节点被置顶时仍可用但必须留有 warn 痕迹。
4. `Agent.workerId` 在产品面上彻底消失：schema 无声明、DB 无列（迁移含 `DROP COLUMN`）、DTO 无字段、web 与原型无控件、testid 清单无条目；且四处「取数 worker」语义未被误删。
5. 迁移安全网成立：守卫 spec 六条断言全绿，且突变校验（注释掉 DROP）能转红；预检 dump 命令留档并明确「部署前须补 dump」。
6. `scripts/e2e-team-worker-node.sh` 的 **A/B/C/D 四项 PASS**（含为 C/D 准备的第二个真实在线 worker），且门禁相对开工基线**无新增失败**：`scripts/gate.sh` 的各步骤（server `prisma generate`/lint/test/e2e/build + worker + web）逐条绿，唯一的红是**预存在**的 bare-catch 守卫（176 > 基线 175，`<base-sha>` 处已红，本计划未新增 bare catch、未改基线）；全程无人工点击环节。
