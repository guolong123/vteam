# 多用户 / 多工作空间隔离 · 现状评估与设计方案（v0.2 · 产品决策已确认）

> 生成日期：2026-11-12　｜　状态：**调研完成 + 设计草案，产品决策已由用户确认（见 §0），未提交实现**
> 触发需求：「当前主要都是以 admin 用户使用为主，后面要做多用户，每个用户拥有自己的工作空间，
> 工作空间内包含了模型、worker、成员、团队等信息都是隔离的……先看看当前缺哪些」。
>
> 本目录文件：
> - `README.md`（本文件）：总览、结论、缺口清单、设计方案、路线图、待决策项
> - `notes-empirical-probe.md`：运行态实证探测（双账号越权实测，含数据清理记录）
> - `notes-data-model.md`：数据模型层 53 张表归属分析 + schema 改造最小集
> - `notes-api-auth.md`：后端 API / JWT / Guard / 越权风险分析
> - `notes-runtime.md`：worker / MCP / 会话 / 凭据 / 文件 / SSE 运行时隔离分析
> - `notes-frontend-test.md`：前端状态 / 权限 / 测试体系现状 + 多用户场景测试矩阵
> - `notes-decisions.md`：**第 6 节待决策项的「背景说明」**（给不看代码的人：现状 → 冲突 → 选项 → 选错的代价 → 建议默认值）
>
> 所有结论均基于仓库实际代码与运行中的服务实测，行号见各分报告。
> 💡 若第 6 节的决策项看不懂「在问什么」，先读 `notes-decisions.md`。

---

## 0. 已确认的产品决策（2026-11-12，用户答复）

> 这 5 条答复把 §6 的待决策项基本定稿；其中第 4 条给出了一个**总原则**，优先级高于任何逐项判断。

| 决策项 | 用户答复（原意） | 定稿结论 |
|---|---|---|
| 一人多空间、空间内多成员 | 「需要一对多，空间内可以有多个成员」 | **Workspace 1 : N User**（`Workspace` + `WorkspaceMember` 关联表，一人可进多个空间、一个空间多个成员）。JWT 必须带当前 `workspaceId`，前端需要空间切换器 |
| 平台内置资源所有人可见 | 「模型这里指用户自己配置了 provider 的 API key；平台模板这些平台内置的，不需要区分，他们是全局资源，所有人都能看」 | **澄清术语**：用户说的「模型」= **provider API key / 凭据**，不是模型目录条目。**平台内置模板（Agent 角色 / 技能 / 工具 / 执行策略 / 模型目录 / 内置 Agent）所有人可见、只读共享、不复制、不做空间内覆盖**；其存储形式由后续的「系统空间统一模型」定为「归属系统空间 `ws_system`」，**用 `workspaceId` 表达而不是「不加列」** |
| 凭据私有、只下发本空间 worker | 「（API key）需要是私人的，空间内唯一，跨空间不可用，作用范围也只能下发到空间所属的 worker 上」 | **凭据 per-workspace 且下发范围收敛**：`ModelCredential` 唯一键改 `@@unique([workspaceId, providerID])`；`dispatchCredentialState` / `replayModelCredentials` / git 全量下发 → **只查本空间行、只广播本空间 worker**；worker 侧按空间起隔离域（多份 `auth.json` / `.keta-git-creds.json` / `opencode.json`） |
| 空间即租户、用户态资源全隔离 | 「成员的服务多个群也需要按照空间隔离，两个空间下不能互通，实际上**空间就是租户的概念，理论上所有用户态的资源都需要隔离**」 | **总原则（最高优先级）**：`workspace = tenant`。**所有用户态资源一律隔离**，包含成员、会话、跨群记忆/上下文、私聊、全局记忆、任务/群聊/产出物、凭据、渠道、文件、SSE、用量账本等。⇒ 推翻设计文档 37 篇里「一成员一条全局会话 / 跨群记忆有意为之 / 不做技术隔离」的旧决策，改为「**一空间内一成员一条会话**」「跨群记忆仅在同空间内共享，跨空间绝不互通」「全局记忆降为空间内全局」；`SESSION_SCOPE=member` 灰度改为空间内语义或下线 |
| worker 按空间隔离 | 「（worker）需要隔离」 | **worker 按空间归属（方案 A）**：`Worker` 加 `workspaceId` + per-worker 密钥；`assignWorker` 只在本空间节点池挑；`broadcastCommand` / 凭据回放 / `GET /workers/register-token` 全部按空间收敛。共享池方案 B 不采用（用户明确要隔离） |
| **平台管理员跨空间读取与资源空间迁移** | 「能，且需要能够有权限修改资源的空间，某些场景下可能需要让一个 worker 或者模型能够给多个空间使用，在这个时候可以修改资源的空间为系统默认空间」 | **新增两条受控能力**：<br>· **跨空间读**：平台管理员可读任意空间（写仍限当前空间），前端提供「查看其他空间」入口；<br>· **资源空间迁移**：管理员（或获授权的运维账号）可把资源在空间之间移动；**移动到 `ws_system` = 发布为平台共享**（如一个 worker / 模型给多个空间用），移出系统空间 = 回收共享（需依赖检查）。<br>迁移走独立审计端点，**仅对「配置/能力类」资源开放**（Agent / 角色 / 技能 / 工具 / 执行策略 / 模型目录 / 模型凭据 / MCP / Git 仓库+凭据 / Worker），**团队、任务、会话、成员等业务数据不允许迁移**。详见 §4.6 |
| **系统空间承载平台资源** | 「用户创建的就是所属于用户啊，加一个空间概念，**默认系统的空间是一个特殊的空间，所有人都拥有**，然后用户创建的属于他所属的空间就好了吧」 | **统一建模（取代「部分表不加 workspaceId」的例外方案，也解决「用户自建与内置共存」）**：**所有资源表统一带 `workspaceId`（NOT NULL）**；<br>· **系统空间 `ws_system`**：`Workspace` 上的特殊行（`isSystem=true`，不可删改），**所有人隐式拥有**（不落 `WorkspaceMember` 行），承载全部 seed / 平台内置数据；**普通用户只读，仅平台管理员可维护**；<br>· **用户空间**：用户创建的一切数据都写入其**当前所在空间**；<br>· 读取语义 = `workspaceId IN (当前空间, 'ws_system')`（**仅限平台资源类模型**）；写入语义 = 必须当前空间。<br>⇒ `agents` 表「内置模板 + 用户自建」混装问题自动消解：模板行归 `ws_system`、用户行归用户空间，同一套 `@@unique([workspaceId, ...])` 即可 |

### 由已确认决策推导出的资源归属（**最终判定依据**）

| 类别 | 具体资源 | 归属 | 读写语义 |
|---|---|---|---|
| **平台资源** | 内置 Agent 模板（`type=\'template\'`）、`AgentRole`、`Skill` / `SkillVersion`、`Tool`、`ExecutionPolicy`、`Model` 目录条目、内置 `McpServer`（`vteam` / `vteam-api`） | **`workspaceId = ws_system`** | 所有空间可读；非管理员只读；管理员可在系统空间维护（后续可加「发布到平台」动作） |
| **用户态资源** | Team / TeamMember / TeamQueue / TeamUserMember、Member / MemberNotificationChannel、Session / SessionTurn、ChatChannel / Message / MessageReceipt、Task / TaskEvent、Artifact / ArtifactVersion、Issue / IssueActivity / Plan / PlanTask、Memory、AgentQuestion、Agent（`type=\'custom\'` 自建/克隆行）、**ModelCredential / ProviderTombstone / GitCredential / GitRepo / GitRepoGrant / 用户自建 McpServer / MessageChannel / MessageDelivery / NotificationChannel / NotificationDelivery / 4 张绑定表 / ExternalUser**、Worker / TaskGroupInstance、RealtimeEvent、Trigger / Hook、ModelUsage、**uploads / workdir 文件**、**SSE 订阅与连接池** | **`workspaceId = 当前空间`** | 严格隔离：读只能本空间、写只能本空间，**不回落 `ws_system`** |
| **系统本体（无空间维度）** | `User`、`Role`、`Workspace`、`WorkspaceMember` | 全局 | 账号全局唯一；空间归属靠 `WorkspaceMember`；`Role` 是认证基础设施，不按空间切 |

> **判定口诀**：① seed / 平台随包提供的 → `ws_system`；② 用户（或管理员）在某个空间里创建的 → 该空间；③ 不是「资源」而是账号 / 空间 / 角色本体 → 不加 `workspaceId`。
>
> **为什么这个模型比原方案好**：不再需要「哪些表加列、哪些表不加列」的例外清单，也不需要 `workspaceId` 可空 + 生成列 `scopeKey`（MySQL 无 partial index）那套补丁。统一 `workspaceId NOT NULL`、统一由 Prisma 中间件注入，`agents` / `mcpservers` 的「内置行 + 用户行混装」问题一并解决（模板行归 `ws_system`，用户行归用户空间，无需新增 `isBuiltin` 列）。
>
> ⚠️ **三处必须守住**：
> 1. `ws_system` 不可删除、不可被普通用户写入：写操作一律强制 `workspaceId = 当前空间`；维护平台资源仅允许平台管理员走专门入口。
> 2. `User` **不能**加 `workspaceId`（一人多空间）；当前空间由 JWT 的 `wid` 表达，合法性由 `WorkspaceMember`（或 `wid='ws_system'` 的隐式全员）校验。
> 3. 「读 `IN (当前空间, ws_system)`」**只对平台资源类模型生效**；用户态资源（Team/Task/Session/凭据…）必须严格 `= 当前空间`，否则等于把别人的平台数据也放进来。
> 4. 可空父的盲点：`Task.teamId?` / `Session.teamId?` / `ChatChannel.teamId?` / `Memory.teamId?` 为 NULL 时 join 不到 Team ⇒ 这 4 张表**必须直接加 `workspaceId` 列**兜底（见 §4.4 末）。
> 5. `WorkerModelAvailability` 主键 `(workerId, modelId)`：Worker 已带 `workspaceId`（worker 按空间隔离）、Model 归属按系统空间模型也有 `workspaceId` ⇒ 可不加列，join 传递即可。

### 决策对原方案的影响（差异速览）

| 原草案 | 定稿后 |
|---|---|
| §4.3 提供「系统级只读共享 + 空间内覆盖」两条路线待拍板 | **采用「系统空间 + 统一 workspaceId」**：平台资源归 `ws_system`、用户资源归当前空间；不做空间内覆盖，也不需要生成列 `scopeKey` |
| 「模型目录」和「模型凭据」原本混在一起讨论 | 拆开：**模型目录条目归 `ws_system`（所有空间可读）**、**provider API key 私有且下发范围受控**（平台内置资源共享 / 凭据私有且下发受控） |
| 「全局会话与跨群记忆是否反转」 | **明确反转**：跨群共享记忆降为「同空间内」，跨空间绝不互通（空间即租户总原则） |
| 「worker 共享池还是按空间归属」 | **确定方案 A**（每空间独占 worker 节点池） |
| M2 原写「方案 A（推荐）或方案 B」 | 只保留方案 A；M2 增加「凭据只下发本空间 worker」的验收项 |
| §5 S8 只写「看不到 key」 | 增加「**key 只下发到本空间 worker**」的断言（凭据下发范围的硬要求） |
| §4.4 原把 `ProviderTombstone.providerID` 列为「保持全局唯一」 | **复核后纠正**：删除意图是用户态，主键改 `@@id([workspaceId, providerID])`（A 的删除不能压过 B 的上报） |
| §4.4 原漏 `MessageDelivery` / `NotificationDelivery` / `MemberNotificationChannel` | 补齐唯一键与直加列清单；`MessageChannel/NotificationChannel.name` 是**新增**唯一键（现状无 @unique）非「改前缀」 |
| §4.1 原以为所有下游可靠 join Team 传递 | **纠正**：`Task/Session/ChatChannel/Memory` 的 `teamId` 可空，NULL 行 join 不到 ⇒ 这 4 张表必须直加列兜底；`WorkerModelAvailability` 反而可 join Worker 免加列 |
| **原判断「`agents` / `mcpservers` 一表混装无法两全」** | **系统空间统一模型已消解**：模板行归 `ws_system`、用户自建行归用户空间，同表共存于统一 `workspaceId` 模型；`agents.type` 天然区分（`template`/`custom`），`mcpservers` 用 `workspaceId='ws_system'` 区分内置行，**不需要新增 `isBuiltin` 列** |
| 原方案「平台内置表不加 `workspaceId`、整表豁免」 | **系统空间统一模型取消了整表豁免**：所有资源表统一加列，Prisma 中间件白名单只剩 `User`/`Role`/`Workspace`/`WorkspaceMember` 与 seed/迁移/worker 注册链路 |

---

## 1. 一句话结论

**当前系统是一个「单租户 + 双层 RBAC + 团队内共享」的应用，不是「多用户各自隔离」的应用。**
「每个用户拥有自己的工作空间」在**数据模型、认证鉴权、API、运行时、前端、测试**六层**全部缺失**，
且现有若干设计决策（全局团队、全局成员库、全局会话、全局模型凭据）与隔离目标**方向相反**，
需要一次有计划的租户化改造，而不是补几个过滤条件。

实测印证（详见 `notes-empirical-probe.md`）：在运行中的服务上注册两个普通账号 A/B，
两者看到**完全相同的** 44 个模型 / 280 个成员 / 1 个 worker / 1 个团队 / 7 个 Agent / 8 个技能 / 3 个 git 仓库；
A 新建的私有团队 B 立刻可见，且 **B 能成功 PATCH 改名 A 的团队**（DELETE 被角色权限拦住，不是被归属拦住）。

---

## 2. 当前架构事实（速览）

| 层 | 现状 | 隔离能力 |
|---|---|---|
| 认证 | JWT payload `{sub, username, roleId, type}`，全局 `JwtAuthGuard` | ❌ 无 workspaceId |
| 授权 | `AdminGuard`（是否 admin）+ `PermissionGuard`（资源×操作权限点）+ `TeamMembershipGuard`（存在但未挂在 teams 路由） | ❌ 只判「能不能做」，不判「数据是谁的」 |
| 数据 | Prisma 53 model，**零** `workspaceId/tenantId/ownerId`；唯一用户归属表是 `TeamUserMember` | ❌ 无隔离根；`Team.name`、`Member.name`、`ModelCredential.providerID` 等全部全局唯一 |
| 运行时 | 单 worker 节点池、全局模型凭据（一个 provider 一份 token）、全局会话（一成员一条，跨群共享上下文）、单 `uploads/` 目录、SSE `scope=global` 登录即订阅 | ❌ 全部按「平台唯一」建模 |
| 前端 | `authStore` 只存 `token/refreshToken/user`，无 workspace 概念；所有列表页拉全平台数据；无空间切换器 | ❌ 无 |
| 测试 | E2E 全部单账号（seed-admin / admin），`workers:1` 不并发；0 条隔离用例 | ❌ 无 |

关键设计文档早已把多租户列为「明确不做」：
- `docs/agent-platform/01-背景与目标.md:63`「**不做多租户 SaaS**（第一版）…多租户、计费、跨组织隔离等留待后续迭代」
- `docs/agent-platform/05-非功能与验收边界.md:235/251`「SSO 单点登录、多租户」→ 后续迭代 / 范围外
- `docs/agent-platform/29-团队化改造需求说明.md:124`「**首版团队为全平台可见，不做按项目隔离**」
- `docs/agent-platform/37-成员与群聊解耦设计.md`「成员库是全局资源」「一成员全局只有一条会话」「跨群记忆是有意为之，不做技术隔离」
- `server/prisma/seed.ts:894`「**项目维度已拆除**（remove-project-dimension）」——连旧的「项目」隔离维度都被主动删掉了

> 也就是说：这不是「实现有 bug」，而是**产品能力尚未立项**。好处是不用背负半吊子租户模型的历史包袱。

---

## 3. 缺口清单（按优先级）

### P0 · 安全红线（不修不能上多用户）

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| P0-1 | **跨用户越权读写**：`PATCH /teams/:id` 等按 id 的接口不校验 `createdBy`/团队成员 | `teams.controller.ts:57-60`；`notes-empirical-probe.md` 实测 B 改名 A 的团队成功 | 任意登录用户可改/读他人团队、任务、产出物、成员、Agent（大面积 IDOR） |
| P0-2 | **凭据全局共享**：`ModelCredential @@unique([providerID])` 全平台一份 provider token；`McpServer.oauth`、`MessageChannel/NotificationChannel.secrets`、`GitCredential.credentialRef` 均无归属 | `schema.prisma:1018-1032`、`:1104-1111`、`:1346-1351`、`:1052-1067`；`notes-data-model.md` P0-1~5 | A 能看到/改/吊销 B 的 API key、webhook secret、git 私钥；A 改 key 直接影响 B |
| P0-3 | **用户态资源的全局唯一键撞名**：`Team.name`、`Member.name`、`Session.memberKey`、`GitRepo.repoUrl`、用户自建 `McpServer.name`、`MessageChannel/NotificationChannel.name`、`ExternalUser.externalId` 等缺少空间前缀 | `notes-data-model.md` 的唯一键改造表；定稿清单见 §4.4 | 两个用户不能建同名团队/成员/仓库/渠道；且可通过 409 枚举他人资源名。<br>**注意**：`Skill.name`、`Tool.action`、`AgentRole.key`、`Model(providerID,modelID)` 是**平台内置模板的全局唯一键，按「平台内置资源共享」的定稿保持不动**，不属于缺口 |
| P0-4 | **JWT / 请求上下文无 workspaceId**，`@CurrentUser()` 只有 `{id,username,roleId}` | `jwt-payload.interface.ts:4-11`、`jwt.strategy.ts:22-32` | 后端无处得知「当前请求属于哪个空间」，无法做任何过滤 |
| P0-5 | **SSE `scope=global` 登录即订阅、无过滤**；`RealtimeEvent` 无 workspaceId | `realtime.controller.ts:386-388` | B 能收到 A 的全部实时事件（消息、任务状态、Agent 输出） |
| P0-6 | **worker token 与用户 JWT 完全隔离**，worker 请求无用户上下文；`PermissionGuard` 见 `workerToken` 直接放行；`GET /workers/register-token` 普通 member 可取 `WORKER_TOKEN` 明文 | `permission.guard.ts:67-71`、`workers.controller.ts:129-139` | 可冒充 worker 拉取全平台资源（模型/技能/工具/MCP） |
| P0-7 | **MCP「双空上下文回填」把调用归属到别人的任务/团队**：`PlatformMcpContext` 只有 `workerId`，工具未显式传 taskId/teamId 且未传 `selfInstanceId` 时按「该 worker 最近会话」推断，代码注释自承「可能误归属」 | `platform-mcp.service.ts:383-398`、`:8439-8440`、`:8485-8488`；`notes-runtime.md` 的运行时风险清单 | A 的 Agent 可读 B 的群聊历史/产出物/任务上下文，甚至把产出物提交进 B 的任务 |
| P0-8 | **事件回流串会话/串消息**：ingress 只验 `workerId` 已注册，`instanceRef` 全局 `findFirst` 反查；反查未命中时把新 `ses_` 回写到「该 worker 唯一 running 会话」；流式增量聚合键 `${channelId}\|${agentId}` 不含空间/会话 | `worker-event.ingress.ts:1890-1898`、`:1950-1956`、`:827`、`:879-887`；`notes-runtime.md` 的运行时风险清单 | 共享 worker 上两空间并发时消息追加到对方 processing 行、会话状态被改错 |
| P0-9 | **uploads 单一全局目录 + 静态无鉴权 + 任意 taskId 归档**：`POST /uploads` 带任意 `taskId` 即归档到他人任务且无归属校验；`/uploads/*` 走 `useStaticAssets` 不经 JWT，知道文件名即可读；worker `GET /file` 可读任意绝对路径 | `uploads.controller.ts:92-120`、`main.ts:44-74`、`exec-server.ts:1365-1415`、`workers.controller.ts:159-229`；`notes-runtime.md` 的运行时风险清单 | 往他人任务文档库写文件、跨空间读附件/明文凭据文件、路径穿越 |

### P1 · 数据与语义冲突（改造时要反转的既有决策）

| # | 缺口 | 说明 |
|---|---|---|
| P1-1 | `Team` 是全局根 | `Task/Session/ChatChannel/Message/Artifact/Issue/Memory/ModelUsage/...` 全部挂 `teamId`，但 Team 本身无空间归属 ⇒ 隔离链从根断掉。给 `Team.workspaceId` 后下游多数表可「join Team 过滤」，不必逐表加列 |
| P1-2 | 全局会话 + 跨群共享上下文 | `Session.memberKey @unique` 语义「一成员一条全局会话」（设计文档 37 篇的旧全局会话语义）。多用户共用一个成员库 ⇒ 上下文/记忆/私聊全串 |
| P1-3 | 全局成员库 | `Member.name @unique`、成员是「平台级数字员工」，@ 寻址全局；两个空间不能有同名「架构师」 |
| P1-4 | 「模板」与「用户态数据」混在同一张全局表里 | **`Agent` / `AgentRole` / `Skill` / `Tool` / `ExecutionPolicy` / `Model` 目录 / 内置 `McpServer` 按「平台内置资源共享」保持全局共享（不算缺口）**；但 `McpServer`（用户自建）/ `GitRepo` / `GitCredential` / `ExternalUser` / `MessageChannel` / `NotificationChannel` 是用户创建/配置的，现在也全局共享 ⇒ 必须私有化。另：用户**克隆出来的 Agent 实例**若与内置模板同表，需按「谁创建的」区分归属 |
| P1-5 | `Memory.level='global'` + `autoInject` | 存在显式无归属的全局记忆，会注入「本团队主 Agent」的 prompt |
| P1-6 | 账本无归属 | `ModelUsage`、`RealtimeEvent`、`Trigger`、`Hook`、`MessageReceipt`（`dedupKey`）、`AgentQuestion` 全为软关联，无 userId/workspaceId ⇒ 无法按空间计费/配额；`dedupKey` 跨空间互吃回执 |
| P1-7 | 文件系统单目录 | `server/uploads/`（compose 卷 `uploads_data`）全局一个目录；`<WORK_DIR>/tasks/<taskId>`、`<WORK_DIR>/teams/<teamId>` 无空间前缀 ⇒ 产出物/附件跨空间可见、`.execution-config.json`/`attachments/` 同名覆盖 |
| P1-8 | 前端缓存/SSE 连接池 | react-query key 是裸 `["teams"]`/`["workers"]`/`["tasks"]`，SSE 连接池 key 是 `${token}\|all`、URL 恒 `scope=all`；前端 `matchesScope` 只是 UI 过滤且 `session.updated` 无条件放行 ⇒ 切空间命中旧缓存、复用旧连接串台 |
| P1-9 | `createdBy` 不能当隔离键 | ~12 处 `createdBy` 只是审计列，且 Agent 创建的 Task/Memory/Issue 的 `createdBy` 是**实例 id 而非登录用户**，多数可空、部分不建 FK |
| P1-10 | 运行时标识无空间维度（18 项） | Session id / `memberKey` / `instanceRef` 反查 / 事件 `dedupKey` / SSE scope / workdir / uploads / `WORKER_TOKEN` / `x-worker-id` / MCP context / 凭据下发范围 / worker 池 —— 详见 `notes-runtime.md` (B) 全表 |
| P1-11 | 全局 MCP Server / skills / tools 配置 | `McpServer` 无 owner，注入到每个 worker **单份** `opencode.json`；一个用户改 MCP/技能影响所有空间的所有会话（`notes-runtime.md` D11） |
| P1-12 | 产出物/任务 REST 成员校验不一致 | `assertTeamMember` 只挂 `GET /teams/:id/artifacts`，`GET /tasks/:id`、`GET/POST/DELETE /artifacts/*` 只有权限点 ⇒ 按 id 即可读/写他人产出物（`notes-runtime.md` D9） |

### P2 · 工程与验收

| # | 缺口 |
|---|---|
| P2-1 | 前端无空间切换器、无 `X-Workspace-Id` 请求头、无空间内权限判定、无 403 统一空态 |
| P2-2 | 无「建空间 / 邀请成员 / 退出空间」的 API 与 UI（只有 `system/users` 账号 CRUD 与 `team-user-members` 团队用户成员） |
| P2-3 | E2E 单账号、`workers:1`、0 条隔离用例；`docs/test-cases` 里的 TC-TASK-060/TC-ROLE-006 等越权项长期 BLOCKED（需人工浏览器） |
| P2-4 | `05-非功能与验收边界.md` 现有条款只覆盖「团队粒度」，需补「空间内隔离 + 跨空间不可见 + 切空间刷新 + SSE 不串台」验收项 |
| P2-5 | `team-membership.guard.ts` 已实现但 `TeamsController` 未挂载；`tasks`/`artifacts` 部分方法校验、部分不校验——守卫使用不一致 |

---

## 4. 设计方案（建议）

### 4.1 建模：Workspace 为最外层硬边界，系统空间承载平台资源

```
Workspace (ws_)  ──┬─ 普通空间（用户创建，owner + WorkspaceMember）
   │               └─ ws_system【特殊行 isSystem=true，所有人隐式拥有，不可删改】
   │
   ├── 1 ── N  WorkspaceMember  N ── 1  User (u_)
   │        role: owner|admin|member       （ws_system 不落成员行，隐式全员）
   │
   └── 资源（统一 workspaceId NOT NULL）
         ├─ 平台资源：Agent 模板 / AgentRole / Skill / Tool / ExecutionPolicy / Model 目录 / 内置 McpServer → ws_system
         └─ 用户资源：Team / Task / Session / Member / 凭据 / 渠道 / Worker / 文件 …          → 当前空间
```

**统一规则（系统空间统一模型）**：
1. **所有资源表统一带 `workspaceId NOT NULL`**，不再有「全局表不加列」的例外。唯一键统一 `@@unique([workspaceId, ...])`。
2. **系统空间 `ws_system`**：`Workspace` 中的一个特殊行（`isSystem=true`），seed / 平台内置数据全部归属它；所有人可读、普通用户只读、仅平台管理员可维护；不可删除。
3. **用户创建的数据写入当前空间**；`User` 本身不加 `workspaceId`（一人多空间，当前空间由 JWT `wid` 表达）。
4. 读语义：**平台资源类模型** → `workspaceId IN (当前空间, ws_system)`；**用户态模型** → 严格 `= 当前空间`。写语义：一律 `= 当前空间`。

**为什么用系统空间而不是「全局表豁免」**：`agents` / `mcpservers` 这类表同时装内置行与用户自建行，豁免方案无法只对部分行不加列，且 `agentKey` / `name` 的全局唯一键会导致跨空间撞名；统一 `workspaceId + ws_system` 后，内置行与用户行天然分开，唯一键也统一，无需 nullable 列或生成列 `scopeKey`。

**请求上下文（已定稿：一人多空间）**：因「一人可进多个空间」，必须能表达「当前在哪个空间」。采用 **JWT 带 `wid`（当前 workspaceId）+ 服务端用 `WorkspaceMember` 校验该用户确实属于这个空间**（防伪造）；切换空间时重签 access token，前端提供空间切换器。不采用「请求头 `X-Workspace-Id` 由前端指定」的方案（不可信、易越权）。

### 4.2 隔离策略：三层防线（缺一不可）

```
第 1 层  全局 WorkspaceGuard（JwtAuthGuard 之后）
          · 校验 workspaceId 存在、workspace 未归档、用户在成员表内
          · 平台管理员：读操作允许任意空间（跨空间只读），写操作仍限当前空间
          · 资源空间迁移走独立端点（platform.relocate_resource 权限 + 审计），不经通用写链路
          · @Public() 与 worker 通道按白名单豁免
          · 建立 AsyncLocalStorage<{userId, workspaceId}> 请求上下文

第 2 层  Prisma query 中间件（PrismaService，当前无任何 $use / APP_INTERCEPTOR）
          · findMany/findFirst/count/groupBy/aggregate → 用 AND 合并 where.workspaceId
          · create/createMany/upsert → 自动写入 workspaceId（忽略 DTO 传入值，防伪造）
          · update/delete/updateMany/deleteMany → where 叠加 workspaceId（防按主键跨空间改删）
          · 白名单（**不加 workspaceId、不注入过滤**）：
            - 系统本体：User / Role / Workspace / WorkspaceMember 自身
            - seed / 迁移脚本、worker 注册链路
          · 读过滤策略（按模型登记，不是整表豁免）：
            - PLATFORM_READABLE（= 平台资源类）：Agent / AgentRole / Skill / SkillVersion / Tool /
              ExecutionPolicy / Model / McpServer → where.workspaceId IN (当前空间, ws_system)
            - PRIVATE（= 用户态，默认）：其余全部 → where.workspaceId = 当前空间（不回落 ws_system）
          · 写过滤：一律强制 workspaceId = 当前空间；写 ws_system 仅允许平台管理员走专门入口
          ⚠️ $queryRawUnsafe（workers.service.ts:1153）、message.groupBy 等中间件覆盖不到，须手工补条件

第 3 层  显式归属校验（中间件兜不住的路径）
          · 所有按 :id 的详情/改删 → assertWorkspace(id, workspaceId)
          · POST /teams/:id/users（加人即授权）→ 校验目标 userId 同空间
          · 文件 /uploads/*、artifact contentRef、worker 透传端点 → 按空间分目录 + 显式校验
          · platform-mcp / swagger-mcp / 入站 webhook → 在 resolveExecContext 挂 workspaceId
            （现成挂点：assertWorkerTask / assertWorkerTeam）
          · SSE → RealtimeEvent 加 workspaceId；global scope 也要过滤；历史补拉同步
          · worker token → 绑定 workspaceId，或明确定义为「平台级共享资源」并单独豁免
```

**为什么不能只靠 service 层手写 where**：实测 `GET /teams`、`GET /models` 等十几个列表接口都是全表查询，
`PATCH /teams/:id` 完全没有归属校验；逐接口补既容易漏（现有守卫使用已经不一致），又挡不住 raw SQL / 文件 / MCP 通道。

**运行时的额外关键动作**（详见 `notes-runtime.md` E1~E6）：
- **会话票据**：把静态 `x-worker-id` 升级为按会话签发的 `x-workspace-id + sessionTicket`，`PlatformMcpContext` 增加 `workspaceId/userId/sessionId`；MCP 工具 schema 不接受模型自传 workspaceId。
- **事件回流**：payload 强制带 `workspaceId + platformSessionId`，ingress 先校验 `(workerId, workspaceId)` 绑定；删除「该 worker 唯一 running 会话」adopt 启发式；`dedupKey` 与流式 `streamKey` 加空间前缀。
- **凭据下发**：`dispatchCredentialState` / `replayModelCredentials` / git 全量下发由「全表 + 广播全部 worker」改为「按空间过滤 + 只下发该空间 worker」；worker 侧按空间起多份隔离域或多份 `auth.json` / `.keta-git-creds.json`。
- **文件**：`taskDirOf(root, workspaceId, taskId)`、`resolveUploadDir(workspaceId)`；静态 `/uploads` 改签名 URL 或加鉴权；worker `/file` 用 `fs.realpath` 限定在 `workspaces/<id>/` 内（可复用 `sensitive-command.ts:72-73` 的 cwd 唯一合法根写法）。
- **SSE**：`RealtimeEvent` 加 `workspaceId`；`global` 收敛为「空间内全局」且校验成员；`resolveVisibleTeamIds` 改为「该空间内」；前端连接池 key 改为 `${token}|${workspaceId}|all`，切空间重建连接。
- **worker 策略（已定稿：按空间隔离，方案 A）**：`Worker` 加 `workspaceId` + per-worker 密钥；`assignWorker` 只在本空间节点池挑；`broadcastCommand` / 凭据回放 / `replayModelCredentials` / `dispatchGitCredentials` / `GET /workers/register-token` 全部按空间收敛；**不采用共享池方案 B**。无论哪种形态都必须把 `WORKER_TOKEN` 从「全平台一枚」改为 per-worker 密钥。<br>**共享例外（用户 2026-11-12 追加）**：管理员可把某 worker 迁到 `ws_system` 作为**共享计算节点**，此时候选池 = 本空间 + `ws_system`；但共享节点**只允许使用系统空间凭据**，私有凭据任务必须留在本空间 worker（详见 §4.6.4）。

### 4.3 平台资源 vs 空间私有（**已定稿**，见 §0 的已确认决策）

统一按「seed/平台随包提供 → `ws_system`；用户在某个空间里创建 → 该空间」判定，**不再有「整表豁免不加列」**：

- **平台资源 → `ws_system`（所有人可读、普通用户只读）**：`Agent`（`type='template'`）、`AgentRole`、`Skill` / `SkillVersion`、`Tool`、`ExecutionPolicy`、`Model` 目录条目、内置 `McpServer`（`vteam` / `vteam-api`）。
- **用户态资源 → 当前空间（严格隔离，不回落 `ws_system`）**：Team / Task / Session / Member / Artifact / Issue / Plan / Memory / 凭据 / 渠道 / Worker / ExternalUser / 事件与账本 / 文件 等（完整清单见 §0 分类表）。
- **凭据类必须私有且下发受控**：`ModelCredential`、`GitCredential`、`GitRepo`、用户自建 `McpServer`、渠道 `secrets`。`dispatchCredentialState` / `replayModelCredentials` / `dispatchGitCredentials` / `resolveAuthorizedRepoUrls` / `buildGitCredentialsPayload` 全部按 `workspaceId` 过滤，`broadcastCommand` 只发给 `Worker.workspaceId` 匹配的节点；worker 侧按空间多份 `auth.json` / `.keta-git-creds.json` / `opencode.json`。
- **worker 注入 = 平台资源 + 本空间资源**：每个 worker 的 `opencode.json` 要包含 `ws_system` 的内置 MCP（`vteam`/`vteam-api`、平台技能/工具）+ 本空间自建 MCP/技能，**不能包含其它空间的任何行**。

> 判据示例：`Model` 目录行（谁都能看的 gpt-4o 条目）归 `ws_system`；用户为它填的 `sk-xxx` 归用户空间且只下发本空间 worker。两者靠 `workspaceId` 天然分开，不冲突。

#### 4.3.1 统一模型下的实现注意（容易踩）

1. **`Model` 目录不是「纯平台数据」**：它是 worker 上报时由 `syncFromWorkerCapabilities()` upsert 出来的（`models.service.ts:774-825`）。所以正确切分是：
   - seed 的内置/免费模型行 → `ws_system`；
   - **worker 上报产生的行 → 该 worker 所属空间**（与 worker 按空间隔离一致）。
   - 读取时会出现「同一 `(providerID, modelID)` 在 `ws_system` 与本空间各一行」⇒ **列表必须按 `(providerID, modelID)` 去重，优先取当前空间行**，否则前端模型下拉会重复。
2. **跨表引用要校验空间**：用户空间的 `Agent.defaultModelId` / `Team.defaultModelId` / `Member.defaultModelId` / `Worker.defaultModelId` 只能引用「本空间或 `ws_system`」的 Model；`Agent.baseAgentId` 允许指向 `ws_system` 的模板（克隆的正当用法），但**不能指向其它空间的 Agent**。
3. **`ws_system` 行只读**：Prisma 中间件的 update/delete 都叠加 `workspaceId = 当前空间`，因此普通用户天然改不到 `ws_system` 行；平台管理员维护内置资源需走**显式豁免的 service 方法**（不要给通用端点开后门），并记审计日志。
4. **不建议用复合外键**（如 `(workspaceId, agentId)` 指向 agents）：FK 会大幅增加迁移复杂度，且现有 schema 全是单列 FK。归属校验放在「中间件 + service 断言」两层，DB 只保证引用存在。
5. **回填顺序**：`workspaces` 建表 → 插入 `ws_system` / `ws_default` → 各表加可空 `workspace_id` → 回填（平台行 `ws_system`、存量 `ws_default`）→ 校验无 NULL → 建复合唯一索引 → 改 `NOT NULL` → drop 旧唯一索引。

### 4.4 唯一键改造（统一为 `(workspaceId, ...)`）

> 统一原则：**所有资源表 `workspaceId NOT NULL`，唯一键一律加 `workspaceId` 前缀**；不再有「保持全局唯一、不加列」的资源表。只有 `User` / `Role` / `Workspace` / `WorkspaceMember` 是系统本体。

**（A）用户态资源改复合唯一键**：
`Team.name`(89)、`Member.name`(262)、`Session.memberKey`(423)、`Session.teamMemberKey`(447)、
`ModelCredential(providerID)`(1032)、**`ProviderTombstone` 主键 → `@@id([workspaceId, providerID])`**(1044)、
`GitCredential.name`(1055)、`GitRepo.repoUrl`(1071)、`GitRepoGrant(agentId,repoId)`(1094)、
`ExternalUser.externalId`(540)、`MemberNotificationChannel.notificationChannelId`(313)、
`MessageDelivery` / `NotificationDelivery` 的 `@@unique([channelId,externalId])`(1378/1416)、
`MessageReceipt` / `Trigger` / `Hook` 的 `dedupKey`(621/680/715)、
`TeamUserMember(teamId,userId)`(247) 保留并在「加人」时校验目标用户同空间、
`Plan.taskId`(1213) / `TeamQueue.taskId`(226) / `AgentQuestion.requestId`(1320)（若 id 生成器改为 per-workspace 序号则必须加前缀）。

**（B）平台资源同样加 `workspaceId` 前缀（不再全局唯一）**：
`AgentRole.key`(139) → `@@unique([workspaceId, key])`；`Agent.agentKey`(847) → `@@unique([workspaceId, agentKey])`
（内置模板行得到 `ws_system`，用户自建行得到各自空间，**跨空间可同名**）；`Skill.name`(910) → `@@unique([workspaceId, name])`；
`Tool.action`(952) → `@@unique([workspaceId, action])`；`Model(providerID,modelID)`(999) → `@@unique([workspaceId, providerID, modelID])`；
`McpServer.name`(1106) → `@@unique([workspaceId, name])`（内置行在 `ws_system`，用户自建在各自空间，**不需新增 `isBuiltin` 列**）。
> `User.username/email`(44/47) 仍**全局唯一**（账号体系平台内置，一人多空间靠 `WorkspaceMember`）；`Role.name`(71) 全局唯一（认证基础设施）。

**（C）新增唯一键（现状本来没有 @unique，不是「改前缀」）**：
`MessageChannel.name`(1348)、`NotificationChannel.name`(1385) → `@@unique([workspaceId, name])`。

**（D）子表 / 关联表：父 id 已含空间归属，不加列（显式豁免）**：
`TeamMember`(219)、`ChatChannel` 的 `teamGroupKey`(517) 与 `uk_channels_team_member`(516)、
`ArtifactVersion`(770)、`PlanTask`(1256)、`SessionTurn`(472/480)、`AgentSkill`(900)、`SkillVersion`(944)、
`TaskEvent`(379)、`IssueActivity`(815)、`MessageReceipt`(611，其 `dedupKey` 见 A)、
4 张 `Task/Team × Message/NotificationChannel` 绑定表(1421-1467)、`WorkerModelAvailability`(1010，join Worker 传递即可)。

**（E）语义反转（不只是加列）**：`Session.memberKey @unique` 由「一成员一条全局会话」改为
「`@@unique([workspaceId, memberKey])` = 一空间内一成员一条会话」；`Memory.level='global'` 降为「空间内全局」；
「跨群共享记忆」限定为**同空间内的多个群**，跨空间绝不互通（空间即租户）。

**（F）必须直接加 `workspaceId` 列兜底（不能只靠 join Team）**：
`Member`(259)、`MemberNotificationChannel`(310)、`MessageReceipt`(611)、`Trigger`(663)、`Hook`(703)、
`ModelCredential`(1018)、`ProviderTombstone`(1043)、`GitCredential`(1052)、`GitRepo`(1069)、`GitRepoGrant`(1082)、
`McpServer`(1104)、`Worker`(1123)、`TaskGroupInstance`(1161)、`RealtimeEvent`(1183)、
`MessageChannel`(1346)、`MessageDelivery`(1365)、`NotificationChannel`(1383)、`NotificationDelivery`(1403)、
`ExternalUser`(537)、`ModelUsage`(1492)、4 张绑定表(1421-1467)、
**`Task`(347) / `Session`(403) / `ChatChannel`(494) / `Memory`(1270) 因 `teamId` 可空、NULL 行 join 不到父 Team，必须直加列**、
`Agent`(837)、`AgentRole`(135)、`Skill`(908)、`SkillVersion`(932)、`Tool`(949)、`ExecutionPolicy`(879)、`Model`(970)（**平台资源同样要列**，只是值固定为 `ws_system`）、
uploads / workdir 文件（无表，按 `workspaces/<id>/` 分区）。
其余挂 `teamId` 且非空的表可靠 join Team 传递归属。

### 4.5 迁移策略（沿用本仓已验证的 expand → backfill → dual-read → contract）

1. **expand**：新建 `workspaces`（含 `isSystem` 列）/ `workspace_members`；**给所有资源表加可空 `workspace_id`**；先不建新唯一索引。
2. **建两个基础空间**：`ws_system`（`isSystem=true`，owner 可为 admin，**不落 `WorkspaceMember` 行**，隐式全员可读）与 `ws_default`（owner=现有 admin，存量用户全部挂进 `workspace_members`）。
3. **回填**：seed / 平台内置行（模板 Agent、AgentRole、Skill、Tool、ExecutionPolicy、Model 目录、内置 McpServer）→ `ws_id='ws_system'`；存量**用户态**业务行 → `ws_default`（或按 `Team.createdBy` 反查创建者所在空间）；存量用户自建/克隆 Agent → 其 `createdBy` 所在空间。
4. **backfill 校验**：脚本确认所有资源表无 `workspace_id IS NULL`（统一模型下应 100% 有值，不再有「模板行 NULL」的例外）。
5. **dual-read**：服务层查询按 §4.2 模型登记注入（PLATFORM_READABLE → `IN (当前, ws_system)`；PRIVATE → `= 当前`）；修 `TeamsController` 未挂 `TeamMembershipGuard` 的问题。
6. **contract**：`workspace_id` 改 `NOT NULL`；**先建新复合唯一索引验证无重复，再 drop 旧全局唯一索引**；`Session.memberKey` 语义反转需单独评审。
7. **回滚**：本仓无 down-migration 约定，按「重建库回滚」口径，生产先 mysqldump。

### 4.6 平台管理员跨空间读取与资源空间迁移（共享机制）

> 用户 2026-11-12 答复：**平台管理员可以跨空间读数据**；并且需要「**有权限修改资源的空间**」——某些场景下要让一个 worker 或模型能被**多个空间共用**，做法是**把资源的空间改到系统空间**（`ws_system`），它就变成对所有空间可见/可用的平台共享资源。

#### 4.6.1 两条新增能力

| 能力 | 对象 | 规则 |
|---|---|---|
| **跨空间读取** | 平台管理员（`permissions.all=true` 或新增权限点） | `WorkspaceGuard` 对**读**操作放行任意已存在空间（`GET/列表` 可直接指定目标空间）；**写**仍只能写自己当前空间（避免误改用户数据）。前端给管理员一个「查看其他空间」入口并显式标注「跨空间只读」 |
| **资源空间迁移** | 平台管理员（默认），可通过角色权限点授予他人 | 独立受审计的端点（如 `POST /api/v1/platform/relocations`），入参 `{resourceType, resourceId, targetWorkspaceId, reason}`。**不是通用 PATCH**，不走普通更新链路 |

#### 4.6.2 迁移语义

| 方向 | 含义 | 处理 |
|---|---|---|
| 用户空间 A → 用户空间 B | 转移归属 | 校验目标空间存在；**同空间内唯一键冲突要显式报 409**（如目标空间已有同名团队/成员/仓库），不自动改名；被其它空间资源引用时拒绝并返回引用清单 |
| 任意空间 → `ws_system` | **发布为平台共享**（worker / 模型等给多空间用） | 迁移后所有空间可读；对「可共享类型」同时可**使用**（如 Worker 进入共享候选池、Model/Credential 对所有空间可用） |
| `ws_system` → 用户空间 | **回收共享**（下架） | 先做依赖检查：若仍被其它空间资源引用（如某空间的 Agent 引用了该系统 Model），**拒绝**并列出引用方；确认无依赖才允许 |

#### 4.6.3 哪些资源允许迁移（按类型白名单）

| 允许迁移（可共享资源） | 不允许迁移（用户业务数据） |
|---|---|
| `Agent`（自定义/克隆）、`AgentRole`、`Skill`、`Tool`、`ExecutionPolicy`、`Model`（目录条目）、`ModelCredential`（**共享即所有空间共用该密钥，需二次确认 + 强审计**）、`McpServer`、`GitRepo` + `GitCredential`（成组迁移）、`Worker` | `Team`、`Task`、`Session`、`Member`、`ChatChannel` / `Message`、`Artifact`、`Issue`、`Plan`、`Memory`、`ModelUsage`、`ExternalUser`、`RealtimeEvent` 等 |

理由：判断标准是「这行数据是**配置/能力**（可跨空间复用）还是**业务上下文**（迁移即破坏语义）」。团队/任务/会话一旦迁移，其下属群聊、消息、会话、产出物、worker 绑定全部要跟着走，语义上等于「把别人的工作搬给你」，不适合做成通用能力；确需转移时按「导出/重新创建」处理。

#### 4.6.4 共享 worker 与凭据的交互（最容易出安全问题的一处）

- **系统空间的 Worker = 共享计算节点**：`assignWorker` 的候选池 = `本空间 worker ∪ ws_system worker`。
- **必须遵守的规则**：共享 worker **只使用系统空间凭据**（`ModelCredential.workspaceId='ws_system'`）与系统空间注入配置；**不得**把某用户空间的私钥下发到共享 worker（否则违背「凭据只下发本空间 worker」）。
- **派发时校验**：任务的模型/凭据若属于私有空间，则**只能派到该空间自己的 worker**；若模型/凭据是系统共享的，才允许派到共享节点。找不到可用节点时明确报错（而不是悄悄降级）。
- 若将来确实需要「共享 worker 跑私有凭据任务」，就得让 worker 按空间起多个隔离域（多份 `auth.json` / 运行目录），属于后续增强，不在首版。

#### 4.6.5 实现要点

1. **权限点**：新增 `platform.view_all_workspaces`（跨空间读）与 `platform.relocate_resource`（迁移），默认只授予 admin 角色，可在角色矩阵里授权给特定运维账号。
2. **审计**：每次迁移写一条审计记录（`audit_logs` / `resource_relocations`：操作人、资源类型/ID、源空间、目标空间、原因、时间、结果）。现有 schema 里 `audit_logs` 是「预留表、本版不建」，这次需要真正建表。
3. **事务与幂等**：迁移 = 单事务内「校验 → 改 `workspaceId` → 写审计 → 发事件」；同一操作重复提交返回幂等结果（或 409 明确已迁移）。
4. **副作用重放**：迁移后要触发对应刷新——`McpServer`/`Skill`/`Tool`/`ExecutionPolicy` 变更 → 重新注入相关 worker；`Worker` → 更新派发候选池；`Model`/`ModelCredential` → 重新下发凭据（目标空间或系统空间 worker）；发 `workspace.resource.relocated` SSE 让前端刷新。
5. **禁止跨空间引用**：迁移后若目标空间资源仍被源空间引用（如源空间的 Agent 指向已迁走的 Model），迁移应**连带校验**：要么拒绝，要么同事务把这些引用改成系统共享版本（建议前者，行为可预测）。
6. **共享的安全权衡**：迁移到 `ws_system` 等于**主动放弃隔离**，必须二次确认 + 强审计 + UI 标识 + 可回收；凭据类共享（模型 key / git 私钥）默认禁用，仅按需临时开启并记录原因，因为它会让所有空间共用同一把钥匙。

### 4.7 最小可行切片（MVP，建议分 4 期）

| 期 | 内容 | 验收 |
|---|---|---|
| **M0 · 止血（可先于租户化）** | 给所有按 `:id` 的写接口补 `assertTeamMember/assertWorkspace`（尤其 `PATCH /teams/:id`、`/tasks/:id`、`/artifacts/*`）；`POST /teams/:id/users` 限制同空间；`global` SSE scope 收敛；`GET /workers/register-token` 收归 admin；上传带 `taskId` 必校验归属、`/file` 按 realpath 限定目录；**停用 MCP「worker 最近会话」回填启发式，双空上下文一律 fail-closed** | 双账号 curl 越权断言全绿（可复用 `docs/test-cases` 的 TC-TASK-060 等）；共享 worker 双会话不误归属 |
| **M1 · 租户骨架** | Workspace（含 `ws_system`）/WorkspaceMember 表 + JWT `wid` + WorkspaceGuard + AsyncLocalStorage + Prisma 中间件（PLATFORM_READABLE / PRIVATE 两类策略）+ 全表 `workspaceId` 回填（平台行→`ws_system`、存量→`ws_default`）+ `Team.workspaceId` | 现有单账号（admin）功能全量回归不炸；A/B 各自建团队互不可见；内置 Agent 模板在所有空间可见且只读 |
| **M2 · 资源与运行时** | 唯一键改造（§4.4）；**资源空间迁移端点 + 审计表 + 共享节点派发规则（§4.6）**；凭据/渠道/用户自建 MCP/git 私有化且**下发只到本空间 worker**；成员库、会话/记忆、文件目录、SSE、MCP context、ModelUsage 全部加空间维度，**反转 37 篇全局会话语义**；会话票据替代静态 `x-worker-id`、事件 payload 强制带 workspaceId、`instanceRef` 反查带空间条件、`dedupKey`/streamKey 加前缀；workdir/uploads 按 `workspaces/<id>/` 分区；**worker 按空间归属（方案 A）**：`Worker.workspaceId` + per-worker 密钥 + `assignWorker`/广播/注册 token 按空间收敛 | 模型 key/成员/会话/产出物/git/渠道/凭据全部隔离且两空间不互通；SSE 不串台；A 的 key 不出现在 B 的 worker 上；跨空间 worker 不互相接任务 |
| **M3 · 前端与验收** | 空间切换器（一人多空间；`ws_system` 不作为一个可切换的工作空间，平台资源直接合并在各空间列表并标「内置」）+ `X-Workspace-Id` + 按空间前缀的 queryKey + SSE 连接池重建 + **空间成员管理 UI（邀请/移除）** + **管理员「查看其他空间」入口 + 资源「移动到空间 / 共享到平台」操作（含二次确认与审计展示）** + 403/404 统一态；E2E 多账号 storageState + 并发 + 越权断言 helper | §5 的 25 条矩阵全绿；内置模板在任意空间都可见只读 |

---

## 5. 多用户场景测试矩阵（摘要，完整版见 `notes-frontend-test.md` (E)）

统一前置：两个空间 WSA/WSB，账号 A（WSA owner）、A2（WSA member）、B（WSB owner），各自独立浏览器上下文/storageState，有造数与级联清理 helper。

| # | 场景 | 核心预期 | 优先级 |
|---|---|---|---|
| S1 | 两用户各自建模型/团队互不可见 | 列表/搜索/响应体均不含对方 workspaceId 的行 | P0 |
| S2 | 跨空间 ID 越权访问（GET/PATCH/SSE/页面直输 URL） | 读 403/404（防枚举待定）、写 403 且资源未变 | P0 |
| S5 | 切换空间后数据刷新 | 每次切换重取、无 stale 缓存串台、landing 重算 | P0 |
| S6 | SSE 串台（含 `since` 补拉重放） | B 收不到 A 任何事件 | P0 |
| S10 | 账号/登录态隔离（双 tab、登出、旧 token） | localStorage 按 context 隔离、A 登出不影响 B | P0 |
| S3 | 两空间并发任务 / worker 调度 | 事件不交叉、状态不互覆盖、无 5xx | P1 |
| S4 | 成员邀请/加入/移除空间边界 | 移除后立即不可见且 SSE 断推 | P1 |
| S7 | worker / 同名产出物共享冲突 | 配置按空间隔离、文件不串、无丢失更新 | P1 |
| S8 | 凭据 / 密钥隔离（provider key、git、secret_input） | B 看不到 A 的 key/变量名与值，跨空间引用 403/404；**A 的 key 只下发到 WSA 的 worker**（B 空间 worker 的 `auth.json`/`.keta-git-creds.json` 里没有 A 的条目）；A 改/吊销 key 不影响 B 的 worker | P0 |
| S9 | 角色 × 空间组合权限（垂直越权） | A2 不能靠切空间拿到 WSA 管理权 | P2 |
| S11 | **共享 worker 上 MCP 不误归属**（运行时补充） | 两空间会话跑同一 worker、工具双空上下文 → fail-closed，A 的 `chat_history/doclib/task_context/submit_artifact` 不落到 B 的任务 | P0 |
| S12 | **事件回流不串会话**（运行时补充） | 并发 running 会话下 `instanceRef` 反查、`message.part.delta` 聚合、`session.updated` 全部按空间+会话定位，A 的增量不追加到 B 的 processing 消息 | P0 |
| S13 | **上传/文件路径越权**（运行时补充） | `POST /uploads` 带他人 taskId 被拒；`/uploads/*` 未授权读不到；worker `/file` 路径穿越被 realpath 拦住；同名产出物落盘不串目录 | P0 |
| S14 | **凭据互不影响**（运行时补充） | A 改/吊销自己的 provider key 或 git 凭证，B 的模型可用性/仓库授权不变；`git_repos_list` 不返回 A 的仓库 | P1 |
| S15 | **平台资源所有空间可见且只读**（系统空间模型的反向断言） | 任意空间都能看到 `ws_system` 的 5+ 个内置 Agent 模板 / 角色 / 技能 / 工具 / 模型目录条目，且内容一致；普通用户 PATCH/DELETE 内置行 → 403；各空间**不能**看到/修改别人空间的自建 Agent | P0 |
| S16 | **跨空间成员/会话不互通**（空间即租户总原则） | WSA 与 WSB 可各有一个同名「架构师-老周」；A 空间成员的会话记忆/私聊/跨群上下文不出现在 B 空间；`Memory.level='global'` 只在本空间注入 | P0 |
| S17 | **空间内多成员共享**（一人多空间的正向断言） | A 邀请 A2 进 WSA 后，A2 能看到 WSA 的团队/任务/成员，但看不到 WSB 任何资源；移除后立即不可见 | P0 |
| S18 | **worker 按空间归属** | WSA 任务只会被派到 WSA 的 worker；`broadcastCommand`/凭据回放/注册 token 不含 WSB 节点；WSA worker 下线不影响 WSB | P0 |
| S19 | **系统空间不可写、不可删**（系统空间模型的边界） | 普通用户不能把任何数据写入 `ws_system`（create/update 的 workspaceId 被强制改写为当前空间或被拒）；`DELETE /workspaces/ws_system` 返回 403；`ws_system` 不出现在空间切换器的可切换列表（或标记为只读「平台资源」） | P0 |
| S21 | **管理员跨空间读**（新增能力） | 管理员可读任意空间的团队/任务/成员列表与详情，且界面明确标注「跨空间只读」；普通用户访问其它空间仍 403/404；管理员写其它空间业务数据仍被拒绝 | P0 |
| S22 | **把资源共享到系统空间**（新增能力） | 管理员把 WSA 的自定义 Agent / 模型 / worker 迁移到 `ws_system` 后：WSB 能读到该资源；可共享类型在 WSB 可直接使用（如模型可用、worker 进入共享候选池）；迁移有审计记录 | P0 |
| S23 | **共享回收（移出系统空间）** | 若该资源仍被其它空间引用（如 WSB 的 Agent 引用了系统空间的模型），移出被拒绝并返回引用清单；无依赖时可移出，移出后其它空间不再可见/可用 | P0 |
| S24 | **共享 worker 的凭据边界** | 共享节点上的任务只使用系统空间凭据；带私有凭据的任务不会被派到共享节点（派发时校验并明确报错）；共享节点的 `auth.json` 不含任何用户空间私钥 | P0 |
| S25 | **迁移的边界与冲突** | 迁移团队/任务/会话等业务数据被拒绝；迁移到已有同名对象的目标空间返回 409（不自动改名）；重复提交同一迁移幂等；无 `platform.relocate_resource` 权限的账号调用返回 403 | P1 |
| S20 | **用户自建 Agent 跨空间隔离**（系统空间模型下） | A 在 WSA 创建 `type=custom` 的「数据分析师」，B 在 WSB 看不到也无法引用；A、B 可各自创建同名/同 `agentKey` 的自建 Agent（不再 409）；内置模板行在两边都可见且 `workspaceId='ws_system'` | P0 |

> 当前 E2E 是 `fullyParallel:false, workers:1`、单账号、0 条隔离用例；需要先补
> 「多账号 storageState + 空间级 fixture + 越权断言 helper + 双 context 并发」基础设施，
> 再逐条落地 `web/e2e/workspace-isolation.spec.ts`。
> S11~S14、S16、S18 是后端/运行时契约级用例，建议用 API + 单元测试（`worker-event.ingress.spec.ts`、
> `platform-mcp.service.spec.ts`、`uploads.service.spec.ts` 扩展）覆盖，比纯 UI 更可靠。
> S15 是**反向断言**（豁免项必须仍然全局可见），防止改造时把平台内置模板误隔离掉。

---

## 6. 产品决策状态（2026-11-12）

### 6.1 已由用户确认（见 §0，背景说明见 `notes-decisions.md`）

| 决策项 | 原问题 | 定稿 |
|---|---|---|
| 空间与成员关系 | 一人一空间 vs 可进多个 / 可共享 | ✅ **一对多，空间内可多个成员**（WorkspaceMember） |
| 平台内置资源是否区分空间 | 内置模板是否区分空间 | ✅ **不区分，平台内置全局资源，所有人可见**；且澄清「模型」指的是用户自配的 provider API key |
| 凭据是否按空间私有 | 凭据是否 per-workspace | ✅ **必须私人、空间内唯一、跨空间不可用、只下发到本空间 worker** |
| 全局会话与跨群记忆是否反转 | 全局会话 / 跨群记忆是否反转 | ✅ **反转**；总原则「**空间 = 租户，所有用户态资源都需要隔离**」 |
| worker 共享还是按空间归属 | worker 共享池 vs 按空间归属 | ✅ **按空间隔离**（方案 A） |
| 账号是否全局唯一 | 账号名全局唯一 vs 每空间独立 | ✅ 由「一人多空间」推导：**账号全局唯一**，多空间归属靠 `WorkspaceMember`（非每空间独立账号） |
| 会话作用域灰度开关如何处置 | `SESSION_SCOPE=member` 灰度处置 | ✅ 由「空间即租户」推导：改为**空间内语义**或下线，不再有「跨空间共享记忆」 |
| **用户自建 Agent / MCP 如何与内置共存** | 用户自建/克隆 Agent、自建 MCP Server 如何与内置模板共存 | ✅ **由系统空间统一模型解决**：所有资源统一 `workspaceId NOT NULL`；内置行归 `ws_system`（所有人可读、只读），用户创建行归其当前空间；唯一键统一 `(workspaceId, ...)`，跨空间可同名；`McpServer` 无需 `isBuiltin` 列 |
| **系统空间是否作为可切换工作空间** | `ws_system` 是否作为可切换的工作空间出现在 UI | 建议**不出现**：平台资源直接合并在每个空间的列表里并标「内置」，避免用户误以为能在系统空间里干活（实现上 `ws_system` 仍可通过内部身份访问） |
| **平台管理员跨空间读取与资源空间迁移** | 管理员能否跨空间读？能否修改资源的空间以让 worker / 模型多空间共用？ | ✅ **可以**：管理员可跨空间读（写仍限当前空间）；可把资源迁移到其它空间或 `ws_system` 以实现共享（worker / 模型等），走独立审计端点，仅限配置/能力类资源。详见 §4.6 |
| **其余技术实现项** | 跨空间不可见返回码、MCP 会话票据形态、存量回填空间、每空间 worker 交付形态 | ✅ 用户答复「其它都按建议」，按下列默认值执行（见 §6.2） |

### 6.2 默认值确认（用户答复「其它都按建议」）

以下技术实现项**已按建议默认值确认**，不再是待决问题；实施时直接采用：

| 事项 | 采用值 |
|---|---|
| 跨空间访问不存在或无权访问的资源时返回什么 | **404**（防枚举；测试断言统一按 404 写） |
| AI 执行时（MCP 工具调用）如何携带空间身份 | **按会话签发 `x-workspace-id` + 会话票据**，服务端校验它与 worker 的绑定；不采用「请求带引擎会话 id 反查」 |
| 存量数据回填到哪个空间 | 平台内置行 → `ws_system`；存量用户数据 → 管理员默认空间 `ws_default` |
| 每个空间的 worker 交付形态 | **起步用独立容器**；共享节点通过「迁移到系统空间」实现（§4.6.4） |
| 系统空间是否出现在前端空间切换器 | **不出现**；平台资源合并在各空间列表并标「内置」 |

---

## 7. 本次调研做了什么 / 没做什么

- ✅ 静态分析：53 个 Prisma model、全部 controller/guard/service 抽查、29 个迁移 + seed、worker/MCP/SSE/上传前端源码、20+ 篇设计文档、E2E/单测/测试用例/报告。
- ✅ 运行态实证：在 compose 五服务（db/server/web/worker 全 healthy）上注册双账号、逐接口比对返回集合、实测跨用户越权写，并**完整清理**（测试团队 `DELETE`、测试账号从 DB 删除，恢复为探测前 3 用户 / 1 团队）。
- ✅ 产出 1 份总览 + 6 份分报告，全部位于 `.design/multi-workspace/`；产品决策经用户 6 轮答复全部定稿，并做过一次独立完整性复核。
- ❌ **未修改任何业务源码、未执行任何数据库迁移、未实现任何隔离逻辑**——本次只做「看看当前缺哪些」的设计评估。
- ❌ 未验证「跨空间 SSE 实时串台」的实际收包（需两个登录浏览器上下文，留待 M3 测试基建）。
- ❌ 未做多用户并发压测、未评估性能/容量影响。

---

## 8. 建议的下一步

1. **所有产品决策与技术默认值均已确认**（§6.1 / §6.2），可以直接进入实施方案阶段，不再有待拍板项。
   - 其中一条从「不能」改成了「能」：**平台管理员可以跨空间读**，并可把资源迁移到其它空间或系统空间实现共享（§4.6）。对应改法是 `WorkspaceGuard` 对管理员读操作放行、写操作仍限当前空间，迁移走独立审计端点。
2. **开工前先做一次 Prisma 中间件技术验证（spike）**：确认 `$extends` 能按要求做到「读：平台资源类 `IN (当前空间, ws_system)`」「写：强制 `workspaceId = 当前空间`」，并列出 `$queryRawUnsafe` 等覆盖不到的路径（已知 `workers.service.ts:1153` 的裸 SQL）。这是 M1 的最大技术风险点。
3. 若近期就要给外部用户用，**先做 M0 止血**（不改 schema，纯补归属校验 + 停用 MCP 回填启发式），可以立刻消掉最严重的跨用户越权。
4. 再按 M1 → M2 → M3 排期推进；M2 里**资源空间迁移（共享/回收）建议放在最后**，因为它依赖前面的隔离与凭据下发都改完。
5. 测试基建（多账号 storageState + 空间 fixture + 越权断言 helper）建议与 M1 并行启动，否则改造完没有自动化手段证明「真的隔离了」。

> ⚠️ **关于「共享」的安全权衡**：把资源迁移到系统空间 = **主动放弃这部分隔离**。因此必须做到：管理员二次确认、写审计、UI 上明确标「平台共享」、可随时回收；**凭据类共享（模型 API key、git 私钥）尤其敏感**，等于让所有空间共用一把钥匙，建议默认禁用、仅按需临时开启并记录原因。共享 worker 只能使用系统空间凭据，私有凭据任务必须留在本空间节点（§4.6.4）。
