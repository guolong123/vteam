# remove-project-dimension - Work Plan

## TL;DR (For humans)

- What you'll get：项目维度一次性拆除后的代码库——任务直连团队，记忆为 task/team/global 三级，权限只认团队成员。
- Why this approach：Team 与 Project 无直接 FK，耦合集中在“成员校验链 + 路由 pid + 记忆/事件 project 分支”三处，按“先换门、再改路由、后删表”顺序拆除，每一步都可独立验证。
- What it will NOT do：不动团队排队/会话/群聊、任务状态机、Issue 流转、产出物、计划模式；不改 `Task.createdBy` 建模；不保留任何 `/projects` 兼容路由。
- Effort：约 12 个执行项 + 4 项终验，跨后端 8 模块 + 前端 + e2e + migration。
- Risk：硬删除不可逆——执行前必须 `mysqldump` 备份；存量 project 记忆多团队复制可能产生重复行（可接受，属经验复用）。
- Decisions：硬删除 / 团队成员门（错误码同步改名为 `PERMISSION_TEAM_NOT_MEMBER`）/ tests-after / project 记忆转 team 级（1 团队直转、多团队复制、`CONCAT('me_mig_',UUID_SHORT())` 新 id、0 团队降 global；realtime 历史事件归属丢失为可接受损失）。

## Scope

IN：
- 后端：`projects/` 模块删除；`tasks` 路由去 pid + 守卫切换；`issues/plans/chat/docs-site/questions/memories/realtime/platform-mcp` 去 project 分支；`Memory.teamId` 新增；roles 权限矩阵清理。
- 数据：新 migration（删表删列 + 建 teamId 列/索引 + 存量记忆迁移）；`seed.ts` 去种子项目。
- 前端：删 `projects/` 页；`board/issues/artifacts/tasks/new` 切 team 上下文；导航/跳转/抽屉/roles 选择器；e2e 全量更新。
- 文档：09/15/28 篇 + 两处 README 相关描述更新。

OUT（Must-NOT-Have）：
- 不得新增任何 `/projects` 或 `:pid` 兼容路由/代理。
- 不得保留 `projectId` 字段做“预留”（删干净，grep 零命中为终验标准之一）。
- 不得改动团队 FIFO 排队、`reuseSession`、群聊分区、任务状态机语义。

## Verification strategy

- tests-after：每个 Todo 自带单测更新，改完即跑该模块 `npx jest <path>`；整波完成后跑 `npm run test`。
- Agent 实跑 QA（每个后端 Todo 至少一组）：happy（建任务/查列表/记忆读写/MCP 调用 200）+ failure（非成员 403、缺 team 上下文 400、孤儿记忆迁移）路径，证据落 `.omo/evidence/remove-project-dimension/`。
- 终验：`projectId|ProjectMember|/projects|:pid|p_seed_|PERMISSION_PROJECT_NOT_MEMBER|PROJECT_MEMBERSHIP` 全仓 grep 零命中（`md-docs` 归档目录与 `docs/test-reports` 历史报告除外，见 F4）；`npm run test` + `test:e2e` 全绿。

## Execution strategy

- 顺序执行 Wave 1→4（后一波依赖前一波的接口形状）；波内各 Todo 可并行开工、串行合入。
- 每个 Todo = 实现 + 测试一体；合入前跑通本模块单测。
- DB 相关（Todo 9）先在本地 MySQL 验证 migration + 回滚（重建）流程，再合入。

## Todos

- [x] 1. TasksService 去 pid：签名、校验、DTO 映射与单测（含错误码改名）
  - References：`server/src/tasks/tasks.service.ts:202-273`（create/createByAgent/requireCreateTeam）、`:281-540`（createTaskInternal）、`:597-624`（findAll）、`:1675-1700`（toTaskDto）；`server/src/tasks/tasks.service.spec.ts`；`server/src/common/guards/team-membership.guard.ts:13,22,32-33`（改 import 源）；`server/src/issues/issues.service.ts:10,101-134`、`server/src/plans/plans.service.ts:16,95-109`、`server/src/chat/chat.service.ts:18,214-288,1324-1374`、`server/src/realtime/realtime.controller.ts:16,252-258`（改 NOT_MEMBER 引用，见 Todo 4/6/8 联动——本 Todo 只改 tasks 侧与 guard 常量定义，其余文件引用随各 Todo 改）。
  - Acceptance：`create/createByAgent/createTaskInternal/findAll` 签名无 `pid`；`create` 内 `projectMember` 校验替换为 `teamUserMember` 存在性校验；**错误码改名**：`TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER` 改为自有常量值 `'PERMISSION_TEAM_NOT_MEMBER'`（不再复用 `PROJECT_MEMBERSHIP_ERRORS`，`team-membership.guard.ts:13` 的 import 删除；前端全仓无此 code 匹配，可安全改名）；`tasks.service.ts:211` 同步新 code；`toTaskDto` 无 `projectId`；`TEAM_REQUIRED` 保留；**注释同步**：`server/src/tasks/dto/create-task.dto.ts:14`（`POST /projects/:pid/tasks`→`POST /tasks`）、`server/src/tasks/dto/query-tasks.dto.ts:9`（`GET /projects/:pid/tasks`→`GET /tasks?teamId=`）注释重写（归属 Todo 1/2，本 Todo 改前者、Todo 2 改后者）。
  - QA happy：经 service 直调建任务（teamId 合法）返回 pending/queued，证据：单测输出 + `.omo/evidence/remove-project-dimension/t1-happy.log`。QA failure：teamId 为空 → `TEAM_REQUIRED` 400；非团队成员 userId → 403 `PERMISSION_TEAM_NOT_MEMBER`；证据同目录 `t1-failure.log`。
  - Commit：`refactor(tasks): drop project dimension from TasksService, gate by team membership`。

- [x] 2. TasksController 路由去 pid 与守卫切换
  - References：`server/src/tasks/tasks.controller.ts`（全文件 235 行）；`server/src/tasks/tasks.module.ts`（guard 注册）；`server/src/common/decorators/project-id.decorator.ts`（删除）；`server/src/tasks/tasks.controller.spec.ts`；`server/src/tasks/task-channel-bindings.controller.ts`（同改类级守卫）；`server/src/tasks/dto/query-tasks.dto.ts:9`（注释重写，归属本 Todo）。
  - Acceptance：`POST /tasks`、`GET /tasks?teamId=&status=&priority=` 生效；`projects/:pid/tasks` 两路由删除；类级 `ProjectMembershipGuard` 换 `TeamMembershipGuard`；`project-id.decorator.ts` 文件删除；`GET /tasks` 无 teamId 时返回调用者所有可见团队任务（按 teamUserMember 反查 teamIds，`teamId IN (...)` 过滤，**pageSize 默认 20 上限 100**，与看板 DTO 一致，防无 teamId 全量分页爆炸）；`teamId` 传入时走成员校验；`TeamMembershipGuard` 支持“无团队参数”模式（无 id/taskId 参数时仅要求登录，成员过滤下沉到 service 层）。
  - QA happy：`POST /tasks` 201 + `GET /tasks?teamId=` 分页正确 + 无 teamId 全可见团队分页正确，证据 `t2-happy.log`。QA failure：无 token 401；非成员 teamId 403/400；证据 `t2-failure.log`。
  - Commit：`refactor(tasks): team-scoped task routes, drop pid and ProjectMembershipGuard`。

- [x] 3. 删除 projects 模块与权限矩阵清理（A 相先行：装饰器搬迁）
  - References：`server/src/projects/`（controller/service/module/dto/current-user.decorator）；`server/src/app.module.ts:8,52`；`server/prisma/seed.ts:37-48`（memberPermissions.projects）；`server/src/common/guards/project-membership.guard.ts` + `.spec.ts`（删除）；`server/src/projects/projects.service.spec.ts`（删除）；**装饰器导入方（必须先改）**：`server/src/tasks/tasks.controller.ts:19`、`server/src/issues/issues.controller.ts:15`、`server/src/plans/plans.controller.ts:6`、`server/src/teams/teams.controller.ts:15`、`server/src/chat/chat.controller.ts:24`、`server/src/docs-site/docs-site.controller.ts:15`、`server/src/git-repos/git-repos.controller.ts:15`、`server/src/git-repos/git-credentials.controller.ts:15`、`server/src/agents/agents.controller.ts:18`、`server/src/questions/questions.controller.ts:11`。
  - Acceptance：**A 相**：`current-user.decorator.ts` 搬迁至 `server/src/common/decorators/current-user.decorator.ts`（`AuthenticatedUser` 一并搬迁），上述 10 处 import 同步更新，`tsc` 通过后方可进 B 相。**B 相**：删除 `server/src/projects/` 整个目录；删除 `project-membership.guard.ts` 及其 spec；`app.module.ts` 去注册；`memberPermissions` 无 `projects` 域；`GET /projects`、`POST /projects` 返回 404（路由不存在，非业务 404）。
  - QA happy：A 相后 `npx tsc --noEmit` 通过；B 相后全量单测中无引用残留，证据 `t3-happy.log`。QA failure：调用 `GET /api/v1/projects` → 404，证据 `t3-failure.log`。
  - Commit：分两次提交：`refactor(common): relocate current-user decorator` ＋ `refactor!: remove projects module, guards and permission domain`。

- [x] 4. issues/plans 成员校验改 team 链与 Issue 过滤改 teamId
  - References：`server/src/issues/issues.service.ts:62-135`（assertTaskMember/assertProjectMember）、`:344-360`（findAll 二选一过滤）；`server/src/issues/dto/query-issues.dto.ts`；`server/src/issues/issues.constants.ts:50-52`；`server/src/plans/plans.service.ts:65-104`；两者 spec 文件；`server/src/issues/issues.service.ts:10,106,134`、`server/src/plans/plans.service.ts:16,109`（NOT_MEMBER 引用改新 code）。
  - Acceptance：`assertProjectMember` 删除，统一经 `taskId → task.teamId → teamUserMember` 校验；`GET /issues` 过滤为 `taskId`/`teamId` 二选一（均缺仍 400，code 保持 `ISSUE_FILTER_REQUIRED`）；`teamId` 路径按 `issue.task.teamId` 过滤；plans 同理去 projectId 反查；所有 `PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER` 引用改为 `TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER`（新值 `PERMISSION_TEAM_NOT_MEMBER`，随 Todo 1 常量定义）。
  - QA happy：按 teamId 查 issue 列表正确，证据 `t4-happy.log`。QA failure：`GET /issues` 无过滤 400；非团队成员 403；证据 `t4-failure.log`。
  - Commit：`refactor(issues,plans): team-scoped membership and filters`。

- [x] 5. Memory 团队级：schema、service、DTO 与 worker 注入
  - References：`server/prisma/schema.prisma:847-873`（Memory 模型）；`server/src/memories/memories.service.ts:36-47`；`server/src/memories/dto/query-memories.dto.ts`；`server/src/memories/memory.constants.ts`；`server/src/memories/memories.controller.ts:16,29,37`（注释/描述更新）；`server/src/platform-mcp/platform-mcp.service.ts:1104-1290`（memorySaveForTeam/memorySave/memorySearch）；`server/src/chat/worker-dispatcher.ts:1295-1454`（记忆注入）；`server/src/tasks/task-progression.scheduler.ts:273`（提示词 `写 "project"` → 改 `"team"`）；各 spec。
  - Acceptance：`level` 仅接受 `task/team/global`（`level=project` 入参 400）；`Memory.teamId` 可空列生效；`memory_save level=team` 落 `teamId`（任务上下文从 `task.teamId` 解析，团队上下文直接用当前 team）；`memory_search` OR 分支为 task/team/global；`GET /memories` 过滤 `projectId`→`teamId`（**字段改名**：`query-memories.dto.ts` 的 `projectId?: string` 字段改为 `teamId?: string`，描述 `level/projectId/taskId`→`level/teamId/taskId`、`项目级过滤`→`团队级过滤`、`task/project/global`→`task/team/global`）；worker 注入 project 分支删除，team 分支按 `task.teamId` 或会话 `teamId` 生效；`memorySaveForTeam` 改写 team 级而非 global； progression 调度提示词与 memories controller 描述同步更新。
  - QA happy：task/team/global 三级写入与聚合检索正确，证据 `t5-happy.log`。QA failure：`level=project` 入参 400；跨团队 teamId 写入 403；证据 `t5-failure.log`。
  - Commit：`refactor(memories): project level replaced by team level`。

- [x] 6. Realtime 去项目维度，保留团队放行
  - References：`server/src/realtime/realtime.service.ts:32-37,126-138,254,304-355,441,484-576`；`server/src/realtime/realtime.controller.ts:230-300`（resolveProjectId/resolveVisibleProjectIds）；`server/prisma/schema.prisma:777-789`（RealtimeEvent）；两处 spec；`server/src/realtime/realtime.controller.ts:16`（NOT_MEMBER import 改新常量，注释 35/232 同步更新）。
  - Acceptance：`resolveProjectId/resolveVisibleProjectIds` 删除；事件 `projectId` 字段删除（落库不再写；**历史 realtime_events 行随列删除而丢失事件归属，属可接受损失**——事件为 transient 通知流，非审计）；`scope=all` 可见性仅按 `teamUserMember` 的 teamIds + team 维度放行；`visibleProjectIds` 过滤删除；403 code 统一为 `PERMISSION_TEAM_NOT_MEMBER`。
  - QA happy：团队成员收到本团队 task/channel/team 事件，非成员收不到，证据 `t6-happy.log`。QA failure：伪造他团队 scope 订阅无事件；证据 `t6-failure.log`。
  - Commit：`refactor(realtime): team-scoped visibility, drop projectId`。

- [x] 7. platform-mcp：task_create 简化与 my_projects 删除
  - References：`server/src/platform-mcp/platform-mcp.service.ts:955-1097`（taskCreate/myProjects/resolveTeamProjectIds）；`server/src/platform-mcp/platform-mcp.tools.ts:620-658,859-872`；`server/src/platform-mcp/platform-mcp.controller.spec.ts:436-443`；`server/src/platform-mcp/platform-mcp.service.spec.ts` 相关用例；`server/src/swagger-mcp/swagger-mcp.handlers.ts:163-165`（`match: m('get','/projects/{pid}/tasks')` + `this.tasks.findAll(String(args.pid),…)`——随 Todo 1 签名变更必须处理：删除该 handler 分支及对应 `swagger-mcp.controller.spec` 用例，或改为 team 语义；默认删除）。
  - Acceptance：`task_create` inputSchema 删除 `projectId`（必填只剩 `selfInstanceId+title`）；service 删除 pid 防提权门与 `resolveTeamProjectIds` 调用（方法一并删除）；`my_projects` 工具及 service 方法删除；工具描述中“先调 my_projects”文案全部更新；`createByAgent` 调用去 pid（依赖 Todo 1）；swagger-mcp pid 分支删除且 `tsc` 通过。
  - QA happy：主 Agent 无任务团队会话中 `task_create` 直接建任务成功，证据 `t7-happy.log`。QA failure：非主 Agent 调用 403；缺 title 400；证据 `t7-failure.log`。
  - Commit：`refactor(platform-mcp): task_create without project, drop my_projects`。

- [x] 8. chat/docs-site/questions 校验改 team 链
  - References：`server/src/chat/chat.service.ts:139-140,214-285,1276-1370,1740`（projectIds 过滤与三段校验）；`server/src/chat/chat.module.ts:23`；`server/src/docs-site/docs-site.controller.ts:33,118-128`；`server/src/questions/questions.controller.ts`；`server/src/chat/chat.service.spec.ts`、`worker-dispatcher.spec.ts`；`server/src/chat/chat.service.ts:18,273,288,1330,1346,1374`（NOT_MEMBER 改新 code）。
  - Acceptance：`findAccessibleChannels` 按调用者 teamIds（经 teamUserMember）而非 projectIds 过滤；`channel → taskId → teamId → teamUserMember` 校验替换所有 `→ projectId → project_members` 链；team_group 零任务频道按 team 成员放行保留；chat 侧 403 code 统一为 `PERMISSION_TEAM_NOT_MEMBER`；**注释同步**：`chat.controller.ts:34-36`、`chat.module.ts:23`、`chat.service.ts:139-140` 的 `channel → taskId → projectId → project_members` 改为 team 链，删除 `:pid`/`ProjectMembershipGuard` 字样。
  - QA happy：团队成员可列出本团队频道并收发消息，证据 `t8-happy.log`。QA failure：非成员列频道为空集、发消息 403；证据 `t8-failure.log`。
  - Commit：`refactor(chat,docs-site,questions): team-scoped access checks`。

- [x] 9. Prisma migration + 存量记忆迁移 + seed 清理
  - References：`server/prisma/schema.prisma`（Project/ProjectMember/Task.projectId/Memory.projectId/RealtimeEvent.projectId/idx_tasks_project_status）；`server/prisma/seed.ts:108-125`（种子项目）、`:984-996`（日志行）；`server/prisma/migrations/`（expand-contract 惯例，参考 `20260901000000_team_refactor_expand`）。
  - Acceptance：新 migration 按**先加后删**顺序执行——(1) `memories` 加 `team_id` + 索引；(2) 数据回填 SQL：project 级记忆按“项目下任务 distinct teamIds”迁移（1 个→直转 team；多个→每团队复制一行，**新行 id 用 `CONCAT('me_mig_', UUID_SHORT())`**；0 个→level 改 global；task 级记忆 `project_id` 置空；`task.project_id` 无效引用不存在——`team_id` 早已必填，直接删列）；(3) 删 `tasks.project_id`（含 `idx_tasks_project_status` 重建为 `idx_tasks_team_status`）、`memories.project_id`（及 `idx_memories_project_time`）、`realtime_events.project_id`（及索引）；(4) 删 `projects`/`project_members` 表；`seed.ts` 去种子项目落行与日志；本地 `migrate deploy` + `seed` 一遍通过（含示例团队 `tm_0000000001` 保留验证）。
  - QA happy：迁移后种子任务/团队/记忆读写正常，证据 `t9-happy.log`（migrate+seed 输出）。QA failure：在备份库演练迁移失败回滚（重建卷 `down -v + up --build`）流程可用，证据 `t9-failure.log`。前置要求：执行前 `mysqldump` 备份并记录备份路径到证据。
  - Commit：`refactor(db)!: drop project dimension, migrate memories to team level`。

- [x] 10. 前端去 pid：删项目页、四页切团队上下文
  - References：`web/app/(main)/projects/page.tsx`（删除）；`web/app/(main)/board/page.tsx:195,414-436,458-522`；`web/app/(main)/issues/page.tsx:664-708`；`web/app/(main)/artifacts/page.tsx:779-808`；`web/app/(main)/tasks/new/page.tsx:35-39,308`；`web/src/components/layout/app-shell.tsx:103-144,189,316-372`；`web/src/components/layout/nav-dock.tsx:7`；`web/app/page.tsx`、`web/app/login/page.tsx:75-109`、`web/app/register/page.tsx:49`；`web/src/components/tasks/TaskDetailDrawer.tsx:42`、`task-detail-types.ts:36`；`web/app/(main)/roles/page.tsx:151,416,929-932`；`web/app/(main)/docs/[taskId]/page.tsx:31,46`；`web/app/(main)/teams/[id]/session/page.tsx:976`；`web/app/(main)/memories/page.tsx:32,50,55,65`（level 过滤 `"task"|"project"|"global"`→`"task"|"team"|"global"`，“项目”标签→“团队”）；`web/app/(main)/layout.tsx:6`（`/projects` 注释清理）。
  - Acceptance：`projects/` 路由删除，登录/首页默认跳转团队；四页 `?pid=`→`?teamId=`（无 teamId 重定向 `/teams`，不再回退 `p_seed_1`）；API 调用改为 `/tasks`、`/issues?teamId=`、`/memories?teamId=`；抽屉/types 去 `projectId`；roles 页项目选择器删除；docs 回退链去 projectId 分支；session 页产出物入口改传 teamId；记忆页 team 级过滤可用。
  - QA happy：Playwright 手工走查登录→团队→建任务→看板展示，证据截图 `t10-happy.png`。QA failure：无 teamId 直访 board 重定向 `/teams`，证据截图 `t10-failure.png`。
  - Commit：`refactor(web): drop project pages, team-scoped navigation`。

- [x] 11. e2e 与测试脚手架去 pid
  - References：`web/e2e/guard.spec.ts`、`pages.spec.ts`、`perf.spec.ts`、`login.spec.ts`、`auth.setup.ts`、`reference/testids.ts`、`playwright.config.ts`；`server/test/e2e/team-queue.e2e-spec.ts`；`server/src/**/*.spec.ts` 中 `projectId` mock（tasks/chat/issues/plans/memories/realtime/platform-mcp/**+notifications**`notification-dispatcher.service.spec.ts:125,164,195`、`project-membership.guard.spec.ts`（随守卫删除）、`swagger-mcp` 相关 spec、`git-repos/agents/questions/teams` 引用装饰器的 spec、`seed.spec.ts:14`、`users.service.spec.ts`）。
  - Acceptance：e2e 全量路径无 `pid/p_seed_1//projects` 引用；登录后断言跳转团队页；`POST /projects/p_seed_1/tasks` 改调 `POST /tasks`；所有单测 mock 的 projectId 替换为 team 语义（含 `PERMISSION_TEAM_NOT_MEMBER` code 断言更新）并通过；**追加（执行中发现）**：`users.service.ts:48-69` 的 `_count.projectMembers` 改为 `_count.teamUserMembers`（“所属团队数”，DTO/注释同步），`web/app/(main)/users/page.tsx:24,79-90,261-263` 同步改显示；`seed.ts` 的 `memory_save` 工具描述 `task/project/global`→`task/team/global`；`issues.controller.ts:26-28`、`issues.module.ts:11`、`plans.controller.ts:15-17`、`plans.module.ts:10` 注释去 ProjectMembershipGuard 字样；**不得触碰** `chat.service.spec.ts`、`worker-dispatcher.spec.ts`、memories 相关 spec（T5/T8 各自收尾中）。
  - QA：`npm run test:e2e`（web）全绿，证据 `t11-e2e.log`；`npm run test`（server）全绿。
  - Commit：`test: e2e and specs without project dimension`。

- [x] 12. 文档更新
  - References：`docs/agent-platform/09-API设计.md`、`15-数据模型细化（ER图）.md`、`28-团队模型与排队设计.md`、`08-平台架构设计.md`、`13-任务状态机与全生命周期.md`、`14-Agent配置与虚拟团队模型.md`、`17-模型与仓库权限.md`（如存在）、`18-推进计划.md`（如存在，上述三篇以实际 glob 为准，原则是全量 `docs/agent-platform/*.md` 过一遍 project 引用）；`docs/test-cases/`（02-项目与任务管理、04-Agent与模型管理等全量过一遍）；`docs/deployment.md:81`（种子项目行）；`docs/agent-platform/prototypes/role-permission/index.tsx`（project 引用）；`README.md`（种子项目行、迁移章节）；`server/README.md`（模块表 users/projects/roles 行、种子数据行）；`web/README.md`（页面结构 projects 行）。
  - Acceptance：上述文档中项目维度描述更新为团队维度（含 ER、API 路由表、种子说明）；全仓（除 `md-docs/` 归档与 `docs/test-reports/` 历史报告）`projectId|ProjectMember|/projects|:pid|p_seed_|PERMISSION_PROJECT_NOT_MEMBER|PROJECT_MEMBERSHIP` 零命中。
  - QA：grep 证据 `t12-grep.log`。无 failure 场景（文档项）。
  - Commit：`docs: remove project dimension from design docs and READMEs`。

## Final verification wave

- [x] F1. 计划合规审计：12 个 Todos 全部合入，残留 grep（`projectId|ProjectMember|/projects|:pid|p_seed_|PERMISSION_PROJECT_NOT_MEMBER|PROJECT_MEMBERSHIP`）逐条过审：允许项仅为 (a) spec 中断言“无 projectId”的反向断言行（如 `not.toHaveProperty('projectId')`、`'projectId' in` 为 false 断言、无 pid 路由 sweep），(b) `md-docs/`、`docs/test-reports/` 历史归档，(c) `.omo/` 计划/证据文档（记录拆除本身），(d) 根目录 scratch `*.mjs` 与 `.playwright-mcp/` 日志（计划外预存文件）——每条须逐项列出理由；其余零命中；`GET /api/v1/projects` 404；`POST /tasks` + `GET /tasks?teamId=` 正常。
- [x] F2. 代码质量复核：`npm run lint`（server+web）零 error；`npx tsc --noEmit`（server+web）通过；无孤立 import/死文件（以 lint + tsc 为准）。
- [x] F3. 真实 QA 通关：`npm run test`（server）全绿；`npm run test:e2e`（web）全绿；手工走查登录→团队→建任务→群聊→Agent `task_create`→记忆 team 读写→看板，全程截图存 `.omo/evidence/remove-project-dimension/final/`。
- [x] F4. 范围保真：团队排队/会话复用/群聊分区/任务状态机/Issue 流转/产出物行为与拆除前一致（以现有 e2e team-queue 与状态机用例通过为准）；确认未新增任何 pid/兼容路由；备份路径已记录。

## Commit strategy

- 每 Todo 独立提交（message 见各 Todo Commit 行），顺序 1→12；Todo 3/9 为 breaking（`!` 标记）。
- Todo 9 合入前必须在证据目录留下 `mysqldump` 备份路径记录。
- 终验通过后可选 squash（`git-master` 技能规范），由执行会话决定并报备。

## Success criteria

- 功能：登录后以团队为工作台，建任务/看板/Issue/产出物/记忆/MCP 自建任务全链路可用，无任何项目概念外露。
- 数据：`projects/project_members` 表消失，project 级记忆按既定规则全部落到 team/global，无孤儿 `projectId` 引用。
- 质量：lint + tsc + 单测 + e2e 全绿；终验 grep 零命中（约定排除目录除外）。
