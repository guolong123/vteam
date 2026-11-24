【vteam 前端 / 测试体系 · 多租户（多工作空间）隔离现状调研报告】
调研范围：只读，未修改任何文件。基于 web/、server/、docs/、e2e-evidence/ 实际文件内容，行号为文件内真实行号。

═══════════════════════════════════════════
(A) 前端登录 / 状态 / 权限现状
═══════════════════════════════════════════
【登录态保存】
- `web/lib/stores/authStore.ts`：zustand + persist，key `agent-platform-auth`（L12）。
  - 记住我 → **localStorage**，否则 sessionStorage（L14-40，`dualStorage`）。
  - 持久化字段仅 `token / refreshToken / user`（L124-128），`user` 结构见 L43-57：id / username / displayName / email? / roleId? / roleName? / permissions? / enabled?——**没有任何 workspaceId / tenantId / 当前空间字段**。
  - 水合时 `onRehydrateStorage` 把 token 同步给 api 层并排期主动续期（L129-141）。
- `web/.auth/user.json` 实证据：storageState 里 `localStorage["agent-platform-auth"]` 的 state 只有 token/refreshToken/user，user.permissions=`{"all":true}`，无 workspace 概念（L9）。

【请求如何带 token】
- `web/lib/api.ts`：模块级变量 `accessToken`（L14），`setAuthToken` 由 authStore 调用（L17-19）；`buildHeaders()` 注入 `Authorization: Bearer <token>`（L102-114）。401 自动 refresh 单飞重试（L146-157），彻底失败走 `unauthorizedHandler` 清登录态跳 `/login`（L162-164、authStore.ts L237-242）。
- `web/middleware.ts` **不是鉴权中间件**：它是 Next 运行时同源 API 代理（`/api/v1/*`、`/uploads/*` 透传到 server），注释明确「Set-Cookie 完整透传」（L14），matcher 只含 `/api/v1/:path*`、`/uploads/:path*`（L98-100）。**前端无服务端路由守卫**，纯客户端守卫。
- SSE 特殊：`web/hooks/use-sse.ts` L151 `new EventSource('/api/v1/events?token=<accessToken>&scope=all&since=...')`，token 走 **query 参数**（EventSource 不能设 header）；连接池 key = `${token}|all`（L281、L32-33），按 token 分池。

【全局状态】
- 只有 `useAuthStore`（用户/token）和 `useChatPrefsStore`（`web/lib/stores/chat-prefs-store.ts`，仅聊天气泡样式 + 页面特效，localStorage `vteam-chat-stream-style`）。**全站没有「当前工作空间 / currentWorkspace / workspaceId / tenantId」全局 store 或 context**（对 web/src、web/app、web/lib、web/hooks 全量 grep `workspace|工作空间|currentWorkspace|tenant` 零命中，仅注释里出现「协作工作区」字样）。

【路由守卫】
- `web/src/components/layout/app-shell.tsx`（(main) 组外壳，`web/app/(main)/layout.tsx` 仅渲染 AppShell）：
  - 登录守卫：等待 zustand 水合完成后 `hydrated && !token → router.replace('/login')`（L201-215）。
  - 权限守卫：`ROUTE_GUARD`（L111-117）按 pathname 首段判定，失败重定向到首个有权限导航项（L219-229）。
- `web/app/page.tsx`：根路由按 token 有无 + `resolveLandingPath` 分流（未登录→/login）。
- `web/lib/landing.ts`：管理员（isPlatformAdmin）→ `/stats`，普通成员 → `/teams`（L22-34）。

【权限菜单控制】
- `web/lib/permissions.ts`：`hasPermission(perms, resource, action)`（L18-28）与 `isPlatformAdmin`（L34-39），数据源是登录响应里 `role.permissions`（`{all:true}` / `{all:false}` / 矩阵）。
- `app-shell.tsx` `NAV_VISIBLE`（L98-109）/ `visibleItems`（L232-238）过滤 Dock 导航；`cmdkItems`（L241-251）过滤命令面板；`web/src/components/layout/nav-dock.tsx` NAV_ITEMS 10 项（L38-51，teams/chat/agents/workers/models/git-repos/skills/integrations/stats/system）。
- `web/src/components/layout/nav-top-bar.tsx` 顶栏只显示 `userName / userRole`（L37-47、L177-181）＋ 主题切换 / 登出按钮（app-shell.tsx L327-364）——**无空间切换器、无「只看自己数据」开关**。
=> 结论：**权限模型是「平台角色 × 资源操作矩阵」，不是「工作空间归属」模型**。权限只控制「能不能进某模块/写某资源」，不控制「看到哪一批数据」。

(B) 结论：前端是否有 workspace 概念、是否所有页面都是全局数据视图
═══════════════════════════════════════════
- **前端完全没有 workspace / 工作空间概念**：无 store 字段、无切换器 UI、无路由参数、无请求头/参数携带 workspaceId。对 `web/app/(main)/*.tsx` grep `userId|ownerId|workspaceId|currentWorkspace|tenantId|mine` 的 141 处命中里，只有「当前登录用户 id 用来做 query 的 enabled 开关」（如 board L354、agents L2582、docs L672、system/users L1087）和 `createdBy` 展示字段（system/memories L104 等），**没有任何一处把 userId/工作空间当作数据过滤条件传给后端**。
- 隔离维度只有「团队 teamId」且是 URL 参数形态：`web/src/api/teams.ts` L171-173 `GET /teams` 参数只有 `{page, pageSize, name}`；`web/app/(main)/teams/page.tsx` L51-54 直接 `teamsApi.list({page, pageSize, name})`，列表「共 N 个团队」是平台全量（L132）；`web/app/(main)/models/page.tsx` L10 注释「主入口——Provider 管理单视图」，ProvidersTab 取全局模型；`web/app/(main)/workers/page.tsx` L585-586 `queryKey:["workers"] → api.get("/workers")` 无参；`web/app/(main)/stats/page.tsx` L84-99 是「跨团队经营全貌」且 AdminGuard（35 篇 §301/576 佐证 admin-only）；`web/app/(main)/system/users/page.tsx` L1104-1106 `GET /users?page=1&pageSize=100` 全平台用户；`web/app/(main)/system/settings/page.tsx` 明确「仅影响当前浏览器；不改变服务端数据」（L41）——是浏览器本地偏好，不是空间配置。
- 少数页面有 `?teamId=` 上下文（board L259、docs、chat?c=group:<id>），但那是「团队选择」，不是「工作空间切换」；且 `web/app/(main)/artifacts/page.tsx` 只是 `/docs` 重定向（L20-23）。
- 服务端佐证：`server/src/teams/teams.controller.ts` L42-48 `GET /teams` 只挂 `PermissionGuard('teams.view')`，`server/src/teams/teams.service.ts` L420-455 `findAll` 的 `where` 只有 `name` 模糊搜索，**没有按 userId/workspace 过滤**；`server/prisma/schema.prisma` 里也不存在 workspace/tenant 表或字段（只有 teamId/userId/teamUserMember 关联，L239-247）。注意：`docs/test-cases/02-项目与任务管理.md` L41 与 TC-PRJ-011（L77）写「GET /teams 仅返回调用者已加入的团队」，与当前 controller/service 源码不一致（文档为 2026-08-10 旧基线，之后「Task 14 全局团队」改造过，app-shell.tsx L92-96 注释「全局 team」）——以源码为准：**当前团队列表是平台全量**。
- 设计文档口径：`docs/agent-platform/05-非功能与验收边界.md` L251 把「多租户：跨组织隔离、计费与订阅」明确列入**后续迭代/范围外**；`01-背景与目标.md` L63「不做多租户 SaaS（第一版）」；`29-团队化改造需求说明.md` L124「首版团队为全平台可见，不做按项目隔离」。即：**多工作空间是尚未立项的新能力，不是现有实现的 bug**。

(C) 测试体系现状：单账号还是多账号、隔离用例数
═══════════════════════════════════════════
【E2E（web/e2e/，27 个 *.spec.ts + auth.setup.ts + worker-readiness.ts）】
- 账号事实（全量 grep `username|password|storageState`）：
  - `web/e2e/auth.setup.ts` L13-28：唯一 setup 项目用 **`seed-admin` / `Admin@123456`** 真实表单登录，产出唯一一份 `.auth/user.json`（L11）。
  - `.auth/user.json`（L9）：user = `u_seed_admin` / `seed-admin`，`permissions:{all:true}`。
  - `web/playwright.config.ts` L36-158：绝大多数 project 复用 `{ storageState: ".auth/user.json" }`（pages/docs/team-users/perf/mcp-status/session-unification/member-history/group-member-panel/external-users 等，L69/L75/L81/L87/L128/L134/L142/L148/L155）；`login` 和 `guard` 无 storageState（测登录本身/未登录跳转，L65/L90）。
  - 另一批 self-login spec（create-agent-role / native-rule-editor / no-agent-picker / policy-restart-notice / policy-serialize / role-first-member-add / task-permission-editable / team-create-role-list / dark-mode-role-warning / roles-members / third-party-agents）用 **`admin` / `admin123`**（如 task-permission-editable.spec.ts L58、L66；dark-mode-role-warning.spec.ts L38、L70），仍是**同一个管理员身份**，只是换成真后端 compose 栈 :13000/:13001。
  - `docs/test-cases/00-总览与索引.md` L27-28 登记账号：`admin/admin123`、`seed-admin/Admin@123456`；`server/prisma/seed.ts` L903/L955-992 还有 `seed-member/Admin@123456`，但 **e2e 里 seed-member 只作为「被查询/被添加的用户 ID 数据」出现**（team-user-members.spec.ts L19-25 用 `/users?search=seed-member` 取 id），**从没用 seed-member 登录过浏览器**。
  - 计划类 spec（plan-archive/plan-finalize/plan-status）用 `addInitScript` 注入**假 token** 的「成员」localStorage（plan-status.spec.ts L245-258：`token:"e2e-member-token"`, `user:{username:"e2e-member", permissions:{all:false}}`），且注释明说「假 token ⇒ 401 ⇒ 前端 api 层」（plan-status.spec.ts L107、plan-archive.spec.ts L132）——是**单页 route-mock 的权限 UI 态模拟，不是多账号并发/真实隔离**。
- **隔离相关用例：E2E 中 0 条**。全量 grep 用例标题（越权/隔离/403/401/两用户/并发/切换/串台）无命中；`web/e2e/guard.spec.ts` L7-26 是「未登录 → /login」的 8 条路由守卫，不是登录态隔离；`web/e2e/team-user-members.spec.ts` L10-88 是「单账号给团队加/删用户成员」的 CRUD 往返；`web/e2e/login.spec.ts` L8-60 是登录页元素/错误密码/注册跳转。对 `browser.newContext` / `newContext(` 二次上下文、双账号并发、`test.describe.parallel` 多用户场景，全目录零命中（仅 `playwright.request.newContext()` 出现在 docs-unified.spec.ts L137/L316，是单账号 API 请求上下文）。
- `web/playwright.config.ts` L22-24：`fullyParallel: false, workers: 1, retries: 0`——物理上也不跑并发。

【server 单元测试（216 个 *.spec.ts）】
- 有「权限守卫」类单测，但都是**单用户 RBAC 语义**，不是工作空间隔离：
  - `server/src/users/admin.guard.spec.ts`（L14-105：all:true 放行 / users.manage 放行 / 无权限 403 FORBIDDEN_ADMIN）
  - `server/src/common/guards/permission.guard.spec.ts`（L26-191：矩阵权限点、all:false 只放行 view）
  - `server/src/common/guards/team-membership.guard.spec.ts`（L8-88：**最贴近隔离的一份**，验 `teamUserMember` 成员关系，非成员 403 PERMISSION_TEAM_NOT_MEMBER，L44-56）
  - `server/src/auth/guards/jwt-auth.guard.spec.ts`（L7-53：@Public / 401）
  - `server/src/workers/worker-token.guard.spec.ts`（X-Worker-Token 与用户 JWT 隔离）
  - `server/src/realtime/realtime-subscribers.spec.ts`（事件订阅者清单，非隔离）
- 对 216 个 spec 全量 grep `workspaceId|tenantId|多租户|跨空间` 命中 0（仅 artifacts/uploads.service.spec.ts 里 `/data/workspace/...` 是文件路径字符串）。**没有任何「用户 A 的数据用户 B 不可见」的 spec**；`server/src/realtime/realtime.controller.ts` L124-132/L439-443 虽有 `resolveVisibleTeamIds(userId)`（按 teamUserMember 推可见团队集），但那是团队维度，且无对应多用户单测。
- `server/test/e2e/team-queue.e2e-spec.ts` 是任务队列 e2e，非多用户并发隔离。

【docs/test-cases（9 个文档，索引称 488 条用例，00-总览 L101）】
- **确有越权/跨团队用例，但都是文档+curl 手工执行、单会话顺序调用、无浏览器并发、无工作空间概念**：
  - `02-项目与任务管理.md`：TC-PRJ-011（L77 非成员团队不可见）、TC-TASK-010（L105 越权创建）、TC-TASK-014（L121 跨团队数据隔离）、TC-TASK-018（L137 查他人任务）、TC-TASK-023（L154 编辑他人任务）、TC-TASK-060（L281 Web 越权不可见）。
  - `03-群聊与实时通信.md`：TC-CHAT-024（L239 非成员读频道）、TC-CHAT-025（L247 非成员发消息）、TC-CHAT-037（L333 dm 越权）、TC-RT-016（L521 SSE 非成员订阅 scope 越权）。
  - `09-DSH引擎Worker环境测试用例.md` L136 TC-DSH-058：seed-admin 对 tm_0000000002 频道操作 403（「团队归属门」）。
  - `01-认证与用户角色管理.md`：TC-USER-011（L113 member token 访问 /users 403）、TC-ROLE-007（L147）等；`05-技能工具与MCP管理.md` TC-SKL-020（L97）/ TC-TOL-015（L129）/ TC-MCP-014（L160）；`04-Agent与模型管理.md` L667/L751 等。
  - 账号口径：`00-总览与索引.md` L27-28；`03` 测试报告（docs/test-reports/03 L17）用过 `admin/admin123` + 临时 userB `chatuserb.../pass1234`（**非成员越权专用**）——说明**历史上有个第二账号，但只用于「被拒绝」断言，且是 curl 顺序调用，没有两个登录浏览器上下文**。
- `docs/test-reports/00-测试报告总览.md` L11-28：366 条执行、339 PASS / 8 FAIL / **19 BLOCKED（16 条为 Web 交互类「需人工浏览器验证」）**；`02-项目与任务管理-测试报告.md` L121/L134 明确 TC-TASK-060「页面侧展示需人工浏览器复核」、`01-...-测试报告.md` L108 TC-ROLE-006 BLOCKED。=> **页面级隔离从来没有被自动化验证过**。
- `docs/test-reports/90-回归验证-权限矩阵修复.md`：只回归 member 角色权限矩阵（8 资源 × 操作），与空间隔离无关。

【e2e-evidence/（40 个文件）】
- 全是截图/JSON 证据：`after-agent-policies.json`、`f2-*`、`external-users-*.png`、`team-members-chips.png`、`office-preview-*.png`、`tool-schema-introspection/` 等；grep `多用户|隔离|跨团队|workspace|工作空间|越权|串台` 仅命中 policy JSON 里的字段，无多用户/隔离证据文件。

(D) 缺口清单：要支持「多用户使用」前端与测试需要补什么
═══════════════════════════════════════════
【前端缺口】
1. **数据模型/契约层**：引入 workspace（或 tenant）实体与 `workspaceId`；`User`/登录响应需带「所属空间列表 + 默认空间」；`authStore` 持久化 `currentWorkspaceId`，并提供 `switchWorkspace(id)`（切换时清 token 重登或换签 token、清 react-query 缓存、重建 SSE 连接）。
2. **请求层**：`web/lib/api.ts` `buildHeaders` 除 Bearer 外注入 `X-Workspace-Id`（或统一 query/路径前缀）；`middleware.ts` 透传该头；SSE URL（`use-sse.ts` L142-151）也要带 workspace 维度，且连接池 key 从 `${token}|all` 扩成 `${token}|${workspaceId}|all`，否则**切空间后复用同一条 SSE 连接会串台**（L281-295）。
3. **UI**：顶栏/NavDock 增加「工作空间切换器」（位置参考 app-shell.tsx L327-364 插槽、nav-top-bar.tsx L176-200 右侧区）；切换后 `queryClient.clear()`/按空间前缀的 queryKey（现在大量裸 `["workers"]`、`["teams"]`、`["users"]`、`["tasks"]`，会跨空间命中旧缓存，见 use-realtime.ts L355 也是裸 `["tasks"]` 失效）。
4. **路由/守卫**：`app-shell.tsx` 守卫增加「当前空间有效性 + 空间内权限」判定（`ROUTE_GUARD`/`NAV_VISIBLE` 现在只看 role.permissions）；每个列表页（teams/models/workers/members/agents/stats/issues/docs/git-repos/integrations/providers/skills/memories/system/*）按空间过滤或由后端按空间隔离后前端无需改；`resolveLandingPath`（landing.ts）切空间后要重算。
5. **数据准备/清理**：前端现在没有「建空间 / 邀请成员 / 成员加入空间」的入口（只有 system/users 的账号 CRUD 与 team-user-members 的团队用户成员，team-user-members.spec.ts L10-88、web/app/(main)/teams/[id]/user-members.tsx）；多用户测试必须有可自动化的空间/成员创建 API 或 UI。
6. **并发/越权反馈**：api.ts 现在 403 只是抛 `ApiError`（L159-183）无统一「无权访问该资源」UI；需统一 403 空态/跳转，便于断言。

【测试基础设施缺口】
1. **多账号登录态**：现在只有一份 `.auth/user.json`（seed-admin）。需要为每个空间/角色生成独立 storageState（如 `.auth/wsA-admin.json`、`.auth/wsA-member.json`、`.auth/wsB-admin.json`），`playwright.config.ts` 增 setup 项目与 per-project storageState；或提供 `loginAs(user, ws)` helper 用 `browser.newContext()` 造隔离上下文。
2. **并发能力**：`playwright.config.ts` L22-24 是 `fullyParallel:false, workers:1`；要测并发任务/SSE 必须支持单 spec 内 `Promise.all` 双 context，或 `workers>1` + 资源隔离。
3. **数据工厂与清理**：现有 e2e 用 seed 数据（auth.setup.ts L7-8 注释「admin 登录后团队列表为空，数据型 testid 无法断言」）+ 时间戳命名（team-user-members.spec.ts L46 `e2e-UserMembers-${Date.now()}`）+ `finally` 删（L85-87）；缺「空间级」fixture（建空间→建用户→建模型/团队/任务→teardown 级联清理），否则用例间互相污染。
4. **越权断言**：没有「B 用户拿 A 的资源 ID 直接 GET/PATCH/SSE 订阅 → 403/404/空」的断言 helper；现有 403 断言都在 curl 文档里（docs/test-cases），没进 Playwright。
5. **SSE 串台验证**：无双连接同时订阅、检查 A 收不到 B 事件的用例（`use-sse.ts` scope=all + 连接级游标 L39/L163，`realtime.controller.ts` L130-132 可见团队集过滤是后端唯一防线，未被测）。
6. **凭据隔离**：模型/Provider 凭据（models/providers-tab、git-repos 凭证）现在全局，缺「A 空间配的 API key 不出现在 B 空间」用例。

【验收条款对照】
- `docs/agent-platform/05-非功能与验收边界.md` L32「团队级权限模型：成员仅在所属团队内可见任务、群聊与 Agent；跨团队数据不可见」、L34「产出物仅任务所在团队成员可查看」——**当前只实现了「团队」粒度（且团队列表本身全局可见），没有「工作空间」粒度**；L235/L251 明确「SSO、多租户」属后续迭代。=> 多用户/工作空间是**新验收条款**，05 篇现有条款不足以覆盖，需补「空间内隔离 + 跨空间不可见 + 切换空间数据刷新 + SSE 不串台」验收项。
- `docs/agent-platform/02-用户与场景.md` L15「平台采用『仅团队』的组织模型」、L51-55「平台权限=资源×操作矩阵 + 权限范围（全局/指定团队/团队内角色）」、L149-159 US-13/US-14/US-15——全部是**单平台内团队**模型，无「每用户一个空间」的用户故事；`09-API设计.md` L73 `[team]` 标记也是团队内端点。=> 需求侧也要新增 US「用户拥有独立工作空间」。

(E) 建议的「多用户场景测试矩阵」初稿（10 个场景）
═══════════════════════════════════════════
统一前置（P0）：已补 workspace 能力；存在两个空间 WSA/WSB，账号 A（WSA owner/admin）、A2（WSA member）、B（WSB owner/admin）；每个账号有独立 storageState/浏览器上下文；有 `createWorkspace/createUser/createModel/createTeam/createTask` 的 API 或 UI 造数 helper，用例结束级联清理。

S1 两用户各自建模型/团队互不可见（数据可见性基线）
- 前置：A、B 分别登录各自空间，模型/团队列表为空。
- 步骤：A 在 WSA 建模型 M-A、团队 T-A；B 在 WSB 建 M-B、T-B；各自刷新 /models、/teams。
- 预期：A 列表仅 M-A/T-A，B 列表仅 M-B/T-B；任一方搜索对方名称返回 0 条；后端 `GET /teams`、`GET /models` 响应不含对方 workspaceId 的行（断言响应体而非仅 UI）。

S2 跨空间 ID 越权访问（水平越权）
- 前置：S1 已产生资源 ID（modelId/teamId/taskId/artifactId/channelId/sessionId/workerId）。
- 步骤：在 B 的上下文用 B 的 token 直接请求 A 的资源：`GET /teams/{T-A}`、`GET /tasks?teamId={T-A}`、`GET /tasks/{tA}/artifacts`、`GET /channels/{cA}/messages`、`PATCH /models/{M-A}`、`POST /workers/{wA}/restart`；以及浏览器直接输入 `/teams/{T-A}` URL。
- 预期：读端点统一 403（或 404 防枚举，需产品定调）、写端点 403 且资源未被修改、页面为空态/无权提示而非渲染 A 的数据；SSE 订阅 `task:{tA}` / `channel:{cA}` 返回 403（对齐 realtime.controller.ts L379-395 assertScopeAccess）。

S3 两个空间并发执行任务互不干扰（并发 + worker 调度）
- 前置：两空间各有在线 worker 与已启动任务。
- 步骤：`Promise.all` 双上下文同时发消息触发 Agent、同时改状态；观察两边看板/群聊、worker 日志。
- 预期：双方各自收到自己的 task.status.changed / agent.status；无事件交叉、无任务状态被对方覆盖、无死锁；服务端并发压测下无 5xx。

S4 成员邀请 / 加入空间的边界
- 前置：WSA 存在，A 为 owner；准备一个待邀请账号 C。
- 步骤：A 邀请 C 进 WSA（或 C 注册后默认自建空间 WSC）；C 接受后登录；A 把 C 移除；C 再访问 WSA 资源。
- 预期：邀请前 C 看不到 WSA 任何资源；接受后可见授权范围；移除后**立即**（含已打开的页面刷新后）不可见且 SSE 断线/不再推送；越权邀请（非 owner）返回 403。

S5 切换空间后数据刷新（前端状态/缓存）
- 前置：A 同时属于 WSA 与 WSA2（或多空间成员）。
- 步骤：A 在 WSA 页面停留（已加载 /teams、/workers、/stats 缓存）→ 顶栏切换器切到 WSA2 → 再切回 WSA；切换瞬间抓包。
- 预期：每次切换所有列表按新空间重取（请求带新 workspace 维度）；切换期间不短暂显示上一个空间的数据（无 stale 缓存串台）；react-query 缓存按 workspaceId 前缀隔离；`resolveLandingPath` 按新空间权限重算。

S6 SSE 串台（实时通道隔离）
- 前置：A、B 同时在线，各有一条 `?token=...&scope=all` 的 SSE 连接。
- 步骤：A 空间触发 chat.message.new / task.status.changed / agent.loading；B 空间同时不触发；随后 B 触发自己的事件。
- 预期：B 的连接收不到任何 A 的事件（含断线 `since=<lastId>` 补拉重放，use-sse.ts L143-149）；服务端 `resolveVisibleTeamIds`（realtime.controller.ts L130-132、L440-443）按用户可见空间过滤；前端连接池 key 含 workspaceId，切空间重建连接（L281-295）。

S7 worker 共享冲突（资源竞争）
- 前置：单 worker 节点/共享模型凭据被两空间同时使用。
- 步骤：A、B 同时在各自空间把团队首选 worker 指向同一 worker、同时改 `defaultModelId` / 同时 restart / 同时提交产出物到同名文件。
- 预期：配置写入按空间隔离互不覆盖（或明确「共享 worker 需队列化」并验证排队语义）；产出物落盘目录按空间/任务隔离不串文件；无 409 误报、无一方配置丢失（参照 policy-serialize.spec.ts L166-167 的「无丢失更新」思路扩到多空间）。

S8 凭据 / 密钥隔离
- 前置：WSA 配置了 provider API key、git 仓库凭证、secret_input 变量。
- 步骤：B 在 WSB 打开 /models、/git-repos、agent.question 的 secret_input 弹窗；B 直接 GET 凭据相关端点；检查 worker 注入的 opencode 配置。
- 预期：B 看不到任何 WSA 的 key/token/变量名与值（secret_input 契约见 use-realtime.ts L236-251「不含也不会含任何 secret 值」）；跨空间引用 A 的 credentialId 返回 403；A 改 key 不影响 B。

S9 角色 × 空间 组合权限（垂直越权）
- 前置：WSA 内 A2 是 member（`permissions:{all:false}`），WSA 有 /system/users、/system/roles、/stats 等 admin 页面。
- 步骤：A2 访问管理端点/页面、尝试创建团队/模型、访问 /stats/overview；再用 A（owner）执行同样操作。
- 预期：A2 被 `ROUTE_GUARD`/AdminGuard 拦截（对齐 app-shell.tsx L111-117、admin.guard.spec.ts L87-104），A 放行；且 A2 不能通过切到 WSB 获得 WSA 的管理权（空间间权限不串）。

S10 账号/凭据隔离与会话串号（登录态）
- 前置：同一浏览器先后登录 A、B（或两 tab 双 context）。
- 步骤：A 登录 → 新 tab 登录 B → 回 A tab 刷新 → A 登出 → 检查 B tab；再用 A 的旧 accessToken/refreshToken 请求 B 空间资源。
- 预期：localStorage 的 `agent-platform-auth` 按 context 隔离不互相覆盖；A 登出只清 A（不误踢 B）；A 的 token 换不到 B 空间数据；refresh 轮换后旧 token 失效（api.ts L146-157 / authStore.ts L175-207）；401 处理不会把另一个 tab 跳登录。

优先级建议：P0 = S1/S2/S5/S6/S10（隔离与串台红线）→ P1 = S3/S4/S7/S8 → P2 = S9。
落地顺序建议：先补 (D) 的「多账号 storageState + 空间 fixture + 越权断言 helper + workers>1 并发配置」，再按矩阵逐条写成 `web/e2e/workspace-isolation.spec.ts`，并把 docs/test-cases 里 TC-TASK-060/TC-ROLE-006 等 BLOCKED 项转为自动化。

关键证据文件清单（供复核）：
- web/middleware.ts L14/98-100；web/lib/api.ts L14-19/102-114/146-164；web/lib/stores/authStore.ts L12-40/43-57/124-141；web/lib/permissions.ts L18-39；web/lib/landing.ts L22-34；web/hooks/use-sse.ts L32-33/142-151/281-295；web/hooks/use-realtime.ts L339-357
- web/src/components/layout/app-shell.tsx L11/98-117/201-251/327-364；nav-dock.tsx L38-51；nav-top-bar.tsx L37-47/176-200；web/app/(main)/layout.tsx L9-10
- web/app/(main)/teams/page.tsx L51-54/126-133；models/page.tsx L10/18-34；workers/page.tsx L585-586；stats/page.tsx L84-99；system/users/page.tsx L1104-1106；system/settings/page.tsx L41；artifacts/page.tsx L20-23；providers/page.tsx L10-11
- web/e2e/auth.setup.ts L7-28；web/.auth/user.json L9；web/playwright.config.ts L22-24/36-158；web/e2e/guard.spec.ts L7-26；login.spec.ts L8-60；team-user-members.spec.ts L10-88；plan-status.spec.ts L245-258
- server/src/users/admin.guard.spec.ts；common/guards/permission.guard.spec.ts；common/guards/team-membership.guard.spec.ts L44-56；auth/guards/jwt-auth.guard.spec.ts；realtime/realtime.controller.ts L124-132/439-443；teams/teams.controller.ts L42-48；teams/teams.service.ts L420-455；prisma/schema.prisma L239-247；prisma/seed.ts L898-903/955-992
- docs/test-cases/00-总览与索引.md L27-28/79-101；02 L39-41/74-77/105/121/137/154/281；03 L239-251/333/521；09 L136；docs/test-reports/00 L11-28；02 L121/134；03 L17/115/141；90 全文；docs/agent-platform/05 L29-35/235/251；02 L15/51-55/149-159；01 L63；29 L124
