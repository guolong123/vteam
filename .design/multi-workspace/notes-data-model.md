# 【数据模型层】多租户/多工作空间隔离现状分析报告

调研员：data-model｜只读分析，未修改任何文件。证据基于 `server/prisma/schema.prisma`（1520 行，53 个 model）、`server/prisma/migrations/`（重点 4 个迁移 + 1 个附加）、`server/prisma/seed.ts`、设计文档 01/02/05/13/15/17/29/37 篇。所有行号均指 `schema.prisma`（除显式标注文件）。

> 📌 **本文是调研归档**：正文中的 Q1 / Q2 / Q3 是本报告当时的待确认项编号，仅供追溯；**对外沟通一律写完整问题，不用编号指代**。其中「Q1 全局唯一」等字样引用的是源码注释原文，不是本文的编号。
>
> ⚠️ **2026-11-12 更新（D6）：用户已定稿「系统空间」统一建模——所有资源表统一 `workspaceId NOT NULL`，seed/平台内置行归 `ws_system`（所有人可读只读），用户创建行归当前空间，唯一键统一 `(workspaceId, ...)`。因此本文 (D) 节里「哪些表保持全局唯一、不加列」的结论全部作废：`AgentRole.key` / `Agent.agentKey` / `Skill.name` / `Tool.action` / `Model(providerID,modelID)` / `McpServer.name` 都改为带 `workspaceId` 的复合唯一键（内置行的 workspaceId 固定为 `ws_system`）。**
>
> ⚠️ **2026-11-12 更新：本报告 (A)/(B)/(C) 的「现状」部分仍然有效，但 (D) 改造建议已被用户产品决策部分推翻。**
> 定稿以 `README.md` §0 / §4.4 为准。主要差异（完整性复核结论）：
> - **§D3「模板类加 workspaceId」+「生成列 scopeKey」→ 全部作废**：平台内置模板（`Agent` 内置行 / `AgentRole` / `Skill` / `SkillVersion` / `Tool` / `ExecutionPolicy` / `Model` 目录）按 D2 **保持全局只读共享，不加列、不复制、不覆盖**。
> - **§D4 唯一键表反转**：`AgentRole.key`(139) / `Agent.agentKey`(847) / `Skill.name`(910) / `Tool.action`(952) / `Model(providerID,modelID)`(999) **保持全局唯一**，不加前缀；`ProviderTombstone.providerID`(1044) 反而**应改**复合主键 `@@id([workspaceId, providerID])`（删除意图是用户态，A 的删除不能压过 B 的 live 上报）。
> - **§D6 的三项待确认已由用户拍板**：空间与成员 = 一对多（WorkspaceMember）；平台内置资源 = 不区分空间、所有人可见；会话与记忆 = 设计文档 37 篇「全局会话 / 跨群记忆」明确**反转**（总原则：空间 = 租户，所有用户态资源都隔离）。
> - **新增漏项 / 纠正**：`MessageDelivery`(1365) / `NotificationDelivery`(1403) / `MemberNotificationChannel`(310) / `ProviderTombstone`(1043) 属用户态，需加列；`MessageChannel.name`(1348) / `NotificationChannel.name`(1385) 现状**无 @unique**，是「新增」非「改前缀」；`ChatChannel.teamGroupKey`(517) 与 `uk_channels_team_member`(516) **保持按 team 唯一、不加前缀**（teamId 已含归属）。
> - **join-Team 传递的盲点**：`Task.teamId?`(347) / `Session.teamId?`(403) / `ChatChannel.teamId?`(494) / `Memory.teamId?`(1270) 可空，NULL 行 join 不到父 Team ⇒ 这 4 张表**必须直加 `workspaceId` 列**兜底；`WorkerModelAvailability`(1003) 可 join Worker（D5）免加列。
> - **一表混装**：`Agent`(837) 与 `McpServer`(1104) 同表存内置行 + 用户克隆/自建行，`McpServer` 无 `isBuiltin` 区分列、`name @unique`(1106) 会先撞全局键 ⇒ 已由「系统空间统一模型」解决（内置行归 `ws_system`、用户行归当前空间，统一 `workspaceId` + 复合唯一键）。
>
> 本文件保留原分析全文作为「现状证据」存档，但**实施时不要直接照抄 (D) 节**。

---

## (B) 核心结论（先给结论）

**当前 schema 完全没有 workspace / tenant 概念。** 具体证据：

1. 全库 53 个 model 中，`grep -niE 'workspace|tenant|ownerId|owner_id' server/prisma/schema.prisma` **零命中**；仅 `userId`/`createdBy` 类字段存在，但都是「关联/审计列」，不是隔离维度。
2. 唯一带真实用户归属 FK 的表是 **`TeamUserMember.userId`（L240）** + `@@unique([teamId,userId])`（L247）；其余 52 张表都没有任何用户/工作空间级别的归属键。
3. 设计文档明确把多租户列为「第一版不做」：
   - `docs/agent-platform/01-背景与目标.md:63`：「**不做多租户 SaaS**（第一版）…多租户、计费、跨组织隔离等留待后续迭代」。
   - `docs/agent-platform/05-非功能与验收边界.md:235` 把「SSO 单点登录、多租户」列为「后续迭代（明确延后）」；`:251`「**多租户**：跨组织隔离、计费与订阅」在「范围外（后续迭代）」清单。
   - `docs/agent-platform/29-团队化改造需求说明.md:124`：「**首版团队为全平台可见，不做按项目隔离**」；`:50/:90`「团队名**全平台唯一**，重名提示冲突」。
   - `docs/agent-platform/02-用户与场景.md:15`：「平台采用**仅团队**的组织模型…账号体系为平台内置」；`:53` 权限范围是「全局/指定团队/团队内角色」，没有 workspace 维度。
   - `docs/agent-platform/15-数据模型细化（ER图）.md:6/11/117/119/124`：**团队为全局域**，`teams.name`「团队名全局唯一」，ER 图 `users ||--o{ teams : created_by`（`:413`）是唯一的用户↔团队连线，且只是创建者审计。
   - `server/prisma/seed.ts:894` 注释：「**项目维度已拆除**（remove-project-dimension Todo 9）」——连旧的「项目」隔离维度都被主动删掉了；`docs/agent-platform/17-仓库权限与凭证机制.md:101-102,109,118-119,127` 早期设计里出现过 `owner_type`/`owner_id`/`project_id`/`subject_type=project`，但**落地 schema 完全没采纳**（`GitCredential` L1052、`GitRepo` L1069、`GitRepoGrant` L1082 均无 owner_id / project_id）。

**关于你提到的「已埋点字段」**：最近这批迁移（members / global_session / external_users / team_default_model）**没有任何按用户隔离的意图**，恰恰相反——它们的方向都是「把资源进一步全局化/平台化」，与多工作空间隔离是相反方向：
- `20261106170000_members/migration.sql`：新增 `members` 平台级成员库，注释「**成员 = 平台级数字员工**」；`members.name` 建 `UNIQUE KEY members_name_key`（全局唯一），`created_by` 只是 FK→users 的审计列，**无 user_id/owner_id/workspace_id 任何归属列**。`schema.prisma:261` 原注释：「成员名（**全局唯一**，@ 与私聊列表寻址用）」。`docs/agent-platform/37-成员与群聊解耦设计.md:35/44/49`：「成员提升为平台级一等公民」「一成员全局只有一条会话」「**成员库是全局资源**」；`:54` D14「**跨群记忆是有意为之**…不做技术隔离」。
- `20261106190000_global_session/migration.sql`：**全局会话**，`sessions.member_key` 唯一索引（`uk_sessions_member`），语义是「**一成员一条会话，跨群/跨任务共享上下文**」；`session_turns` 冻结的是 team/channel/seat 轮次上下文，均与 user/workspace 无关。迁移注释明确「expand 阶段，只加可空列/索引」。`schema.prisma:419-423`。
- `20261108000000_team_default_model/migration.sql`：仅 `teams.default_model_id` 一个可空列 + FK→models（`schema.prisma:99,110`），纯配置增强，无隔离语义。
- `20261110160000_external_users/migration.sql`：把外部渠道发送者沉淀为**平台级全局目录** `external_users`，`external_id` 全局唯一（`schema.prisma:540`），回填历史消息按 `name:<展示名>` 全局分组（迁移注释自认「同名不同人会被合并成一条目录记录」）——是全局化，不是按用户隔离。
- `20261110150000_member_persona_prompt/migration.sql`：给 `members` 加 persona/prompt/prompt_mode，注释「**成员是平台级实例**」。
- `backfill-members.ts:189` 把 `createdBy` 取 `seat.team.createdBy`（团队创建者）填进 members，只是补一个非空审计 FK，不是归属切分。
- `seed.ts` 只有 3 个固定账号（`admin`/`seed-admin`/`seed-member`，L955-992）+ 1 个「全局示例团队 tm_0000000001」+ 1 行 `teamUserMembers` owner（L2771-2792）；模型/凭据/MCP/技能全部按全局唯一键 upsert，无任何 per-user 数据。

补充：我读了 `.design/multi-workspace/notes-empirical-probe.md`（你的实证探测）——其结论与静态分析完全一致：JWT 不含 workspaceId/tenantId、两个用户看到完全相同的全局数据、跨用户越权写确认。**schema 层没有任何东西可以承载隔离，实证也证实服务层没兜住。**

---

## (A) 53 个 model 归属分类表

说明：「归属字段」按「能否用于按用户/workspace 切分数据」判定。
- **无归属**：完全没有 userId/workspaceId/ownerId 类字段。
- **仅审计 creator**：有 `createdBy`/`created_by`/`grantedBy`/`actorId` 等，但只是记录操作人（多为 FK→users 或裸 id 串），**不承担隔离**，且大量可空/逻辑关联。
- **间接挂 team/task**：靠 `teamId`/`taskId` 挂到业务父实体；但 Team/Task 本身也无 workspace 归属 ⇒ 传递后仍无隔离根。
- **真·用户归属**：仅 `TeamUserMember.userId`。

**全库 0 个 model 有 workspaceId / tenantId / ownerId。**

### 组 1 · 认证 / 权限（2）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| User | 42 | `username @unique`(44)、`email? @unique`(47)、`roleId`(48) | 无归属；账号自身是主体，无 workspace 外键 |
| Role | 69 | `name @unique`(71)、`permissions`(72)、`scopes`(73) | 无归属；平台级全局角色模板，`scopes` 是 Json 权限范围非数据归属 |

### 组 2 · 团队 / 席位 / 成员库（8）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| Team | 87 | `name @unique`(89)、`createdBy`(103) FK→users | 仅审计 creator；**全局团队**，文档明示全平台可见 |
| AgentRole | 135 | `key @unique`(139)、`type`(144) builtin/custom | 无归属；全局岗位模板 |
| TeamMember | 186 | `teamId`(188)、`memberId?`(190)、`agentId`(191)、`roleId?`(200) | 间接挂 team；唯一键 `@@unique([teamId,agentId,seq])`(219) 无 workspace 前缀 |
| TeamQueue | 223 | `teamId`(225)、`taskId @unique`(226) | 间接挂 team；`taskId` 全局唯一 |
| **TeamUserMember** | 237 | **`userId`(240) FK→users**、`teamId`(239) | **唯一真·用户归属表**；`@@unique([teamId,userId])`(247) |
| Member | 259 | `name @unique`(262)、`defaultRoleId`(264)、`agentId`(266)、`createdBy`(289) FK→users、`originTeamMemberId? @unique`(288) | 仅审计 creator；**平台级全局成员库**，name 全局唯一 |
| MemberNotificationChannel | 310 | `memberId`(311)、`notificationChannelId @unique`(313)、`createdBy?`(315) | 间接挂 member；`uk_member_notif_channel`(313) 全局唯一（一个渠道只能属于一个成员） |

### 组 3 · 任务 / 会话 / 群聊（12）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| Task | 329 | `createdBy`(345) FK→users、`teamId?`(347) | 仅审计 creator + 间接挂 team |
| TaskEvent | 379 | `taskId`(381)、`actorId?`(386) | 间接挂 task；actorId 裸串 |
| Session | 400 | `taskId?`(402)、`teamId?`(403)、`agentId`(404)、`memberId?`(421)、`memberKey? @unique`(423) | 间接挂 team/task/member；`uk_sessions_member`(423) 全局唯一（一成员一条全局会话） |
| SessionTurn | 457 | `sessionId`(459)、`memberId`(461)、`teamId?`(463)、`channelId?`(464)、`taskId?`(465)、`runningKey? @unique`(472) | 间接挂 session；轮次上下文冻结，无用户维度 |
| ChatChannel | 491 | `teamId?`(494)、`memberId?`(496)、`teamMemberId?`(497)、`taskId?`(498) | 间接挂 team/task/member；`@@unique([teamId,teamMemberId])`(516)、`@@unique([teamGroupKey])`(517) |
| ExternalUser | 537 | `externalId @unique`(540)、`displayName`(542) | 无归属；平台级全局外部用户目录 |
| Message | 561 | `channelId`(563)、`taskId?`(564)、`senderId?`(566)、`externalUserId?`(574) | 间接挂 channel/task；sender 是展示名/实例 id，非登录用户 |
| MessageReceipt | 611 | `messageId`(613)、`fromInstanceId`(614)、`toInstanceId`(615)、`teamId`(617)、`taskId?`(616) | 间接挂 team/task（**逻辑关联不建 FK**，注释 L603-605） |
| Trigger | 663 | `scopeType?`(668)、`scopeId?`(669)、`ownerInstanceId?`(670)、`dedupKey @unique`(680) | 无归属；全局触发器账本 |
| Hook | 703 | `scopeType`(705)、`scopeId`(706)、`ownerInstanceId`(707)、`dedupKey @unique`(715) | 无归属；全局 hook 账本 |
| Artifact | 736 | `taskId`(738) | 间接挂 task |
| ArtifactVersion | 755 | `artifactId`(757)、`authorAgentId?`(763) | 间接挂 artifact；`@@unique([artifactId,version])`(770) |

### 组 4 · Issue / 计划 / 记忆 / 提问（8）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| Issue | 778 | `taskId`(780)、`assigneeUserId?`(788)、`createdBy?`(791)、`creatorAgentId?`(792) | 仅审计/指派（裸串，createdBy 可空）；主要挂 task |
| IssueActivity | 815 | `issueId`(817)、`actorId?`(822)、`instanceId?`(823) | 间接挂 issue；actorId 是 userId 或 agent 实例 id |
| AgentQuestion | 1317 | `requestId @unique`(1320)、`sessionId`(1322)、`taskId`(1323)、`agentId`(1324) | 间接挂 session/task；`requestId` 全局唯一 |
| Plan | 1211 | `taskId @unique`(1213)、`createdBy`(1219)、`reviewerInstanceId?`(1220)、`confirmedBy?`(1223)、`finalizedBy?`(1227) | 间接挂 task；createdBy 注释明确是「主 Agent 实例 id」非 user |
| PlanTask | 1243 | `planId`(1245)、`assigneeInstanceId?`(1249) | 间接挂 plan |
| Memory | 1266 | `level`(1268)、`taskId?`(1269 已废弃)、`teamId?`(1270)、`roleId?`(1272)、`createdBy`(1293)、`sourceAgentId?`(1294) | 间接挂 team/task/role；`level=global` 行**明确全局无归属**；`createdBy` 是 agent 实例或 user id 裸串 |
| RealtimeEvent | 1183 | `scopeType`(1186)、`scopeId?`(1187) | 无归属；全局事件流 |
| ModelUsage | 1492 | `teamId`(1495)、`teamMemberId`(1496)、`sessionId`(1497)、`channelId`(1498)、`agentId`(1499)、`taskId?`(1500) | 间接挂 team（**全部软关联不建 FK**，注释 L1479-1483）；无 user/workspace 维度，配额无法按用户算 |

### 组 5 · Agent / 模型目录 / 凭据 / 工具 / Worker（全局共享候选，18）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| Agent | 837 | `agentKey? @unique`(847)、`baseAgentId?`(841)、`createdBy`(858) FK→users | 仅审计 creator；平台级 Agent 模板/克隆，`agentKey` 全局唯一 |
| ExecutionPolicy | 879 | （无） | 无归属；全局策略 |
| AgentSkill | 891 | `agentId`(893)、`skillId`(894) | 间接挂 agent/skill；`@@unique([agentId,skillId])`(900) |
| Skill | 908 | `name @unique`(910)、`content`(916) | **无归属**；全局技能库（SKILL.md 全文入库） |
| SkillVersion | 932 | `skillId`(934)、`createdBy?`(939) | 间接挂 skill；`@@unique([skillId,version])`(944) |
| Tool | 949 | `action @unique`(952) | **无归属**；全局工具注册（action 即权限点） |
| Model | 970 | `providerID`(972)、`modelID`(973)、`baseUrl?`(977)、`headers?`(991) | **无归属**；全局模型目录；`@@unique([providerID,modelID])`(999) |
| WorkerModelAvailability | 1003 | `workerId`(1004)、`modelId`(1005) | 间接挂 worker/model；`@@id([workerId,modelId])`(1010) |
| ModelCredential | 1018 | `providerID`(1022)、`credentialRef`(1024)、`fingerprint`(1026) | **无归属**；`@@unique([providerID])`(1032) —— **全局 provider 级 token，全平台共用一份** |
| ProviderTombstone | 1043 | `providerID @id`(1044) | **无归属**；全局删除意图，按 providerID 单行 |
| GitCredential | 1052 | `name @unique`(1055)、`credentialRef`(1058)、`createdBy`(1061) | 仅审计；注释 L1054「**Q1 全局唯一**」；17 篇设计的 owner_id/project_id 未落地 |
| GitRepo | 1069 | `repoUrl @unique`(1071)、`credentialId`(1072)、`createdBy`(1073) | 仅审计；全局仓库注册表 |
| GitRepoGrant | 1082 | `agentId`(1086)、`repoId`(1087)、`grantedBy`(1090) | 仅审计；`@@unique([agentId,repoId])`(1094) |
| McpServer | 1104 | `name @unique`(1106)、`command/url/headers/oauth`(1108-1111) | **无归属**；全局 MCP Server（含 oauth clientSecret） |
| Worker | 1123 | `name?`(1125)、`tokenHash?`(1132)、`defaultModelId?`(1131) | **无归属**；全局 worker 节点池（tokenHash 是 worker 自身认证，非用户） |
| TaskGroupInstance | 1161 | `taskId?`(1163)、`teamId?`(1164)、`teamMemberId?`(1165)、`workerId`(1166) | 间接挂 task/team/worker |
| MessageChannel | 1346 | `name`(1348)、`config/secrets`(1350-1351) | **无归属**；全局入站渠道（含 secrets） |
| MessageDelivery | 1365 | `channelId`(1367)、`externalId?`(1369) | 间接挂 channel；`@@unique([channelId,externalId])`(1378) |
| NotificationChannel | 1383 | `name`(1385)、`config/secrets`(1387-1388) | **无归属**；全局出站渠道（含 secrets） |

### 组 6 · 关联表 / 用量（含上表未列的 5）
| model | 行 | 归属字段 | 判定 |
|---|---|---|---|
| NotificationDelivery | 1403 | `channelId`(1405)、`externalId?`(1407) | 间接挂 channel；`@@unique([channelId,externalId])`(1416) |
| TaskMessageChannel | 1421 | `taskId`(1422)、`messageChannelId`(1423) | 间接挂 task；`@@id`/`@@unique([taskId,messageChannelId])`(1427-1428) |
| TaskNotificationChannel | 1433 | `taskId`(1434)、`notificationChannelId`(1435) | 间接挂 task |
| TeamMessageChannel | 1445 | `teamId`(1446)、`messageChannelId`(1447) | 间接挂 team |
| TeamNotificationChannel | 1457 | `teamId`(1458)、`notificationChannelId`(1459) | 间接挂 team |

（以上 2+8+12+8+18+5 = 53，完整覆盖。注：任务清单里提到的 `Upload` model **不存在**——`uploads` 只在 `schema.prisma:580` 作为注释出现「客户端先 POST /uploads 拿 url」，文件以 URL/JSON 存于 `Message.attachmentUrl/attachments`，无独立表。）

---

## 全局共享 vs 用户数据 的划分（当前事实）

- **全局共享（平台级，跨所有账号共用一份）**：`Model`/`ModelCredential`/`ProviderTombstone`/`Worker`/`WorkerModelAvailability`/`Agent`(模板)/`AgentRole`(岗位模板)/`ExecutionPolicy`/`Skill`/`SkillVersion`/`Tool`/`McpServer`/`MessageChannel`/`NotificationChannel`/`GitCredential`/`GitRepo`/`GitRepoGrant`/`ExternalUser`/`Role`/`Member`(成员库)/`Team`(全局团队)。这些表在 seed 里全部按全局唯一键 upsert，且文档/注释明确写「全局」「平台级」「全平台唯一」。
- **用户数据（应随 workspace 隔离但当前无隔离根）**：`Task`/`Session`/`SessionTurn`/`ChatChannel`/`Message`/`Artifact`/`ArtifactVersion`/`Issue`/`IssueActivity`/`Plan`/`PlanTask`/`Memory`/`ModelUsage`/`MessageReceipt`/`Trigger`/`Hook`/`RealtimeEvent`/`AgentQuestion`/`TaskEvent`/`TaskGroupInstance`/各 Delivery/各关联表、`TeamMember`/`TeamQueue`/`TeamUserMember`/`MemberNotificationChannel`。它们只通过 `teamId`/`taskId` 挂到「全局团队」——而 Team 本身没有 workspace 归属，所以隔离链从根上断掉。

---

## (C) 关键风险点清单（按严重程度排序）

**P0 — 凭据/密钥跨用户泄露与覆盖（最严重）**
1. `ModelCredential.providerID`（L1022）+ `@@unique([providerID])`（L1032）——「token **全局 provider 粒度**」注释见 L1020。全平台所有用户共用同一个 provider 的加密 token 引用；用户 A 改/吊销凭据直接影响用户 B；无法做 per-workspace 密钥。凭据注入 worker 时（`model-credential-injector`）也按全局 provider 取，天然跨租户。
2. `McpServer.oauth`（L1111，注释「{clientId?, clientSecret?, scope?}」）+ `McpServer.headers`（L1110）+ `McpServer.name @unique`（L1106）——全局唯一名 + 全局明文/Json 形式的 secrets；多用户既会撞名，又能读到彼此的 clientSecret/头。
3. `MessageChannel.secrets`（L1351）、`NotificationChannel.secrets`（L1388）——全局渠道带 `secrets` Json，且 `name`(L1348/L1385) **没有 @unique 也无归属**；多用户可互相看到/改写对方 webhook 密钥。
4. `GitCredential`（L1052-1067）：`name @unique`（L1055）全局唯一、`credentialRef`（L1058）加密私钥/token、`createdBy`（L1061）仅审计；`GitRepo.repoUrl @unique`（L1071）全局唯一。A 用户录入的仓库+私钥对 B 完全可见可用，`GitRepoGrant`（L1082）授权主体只有 `agentId`（L1086）不区分用户。17 篇曾设计 `owner_type/owner_id/project_id`（17 篇 L101-102,109,118-119,127）但**落地全删**，是明确的「曾经想过归属、最终放弃」证据。
5. `Worker.tokenHash`（L1132）+ `Worker.name?`（L1125）——worker 节点池全局共享；`X-Worker-Token` 是 worker↔server 的全局认证（15 篇 L377 注释「与用户 JWT 完全隔离」），多用户共用一个节点池，无法按用户做算力/节点归属与配额。

**P0 — 全局唯一键导致多用户直接撞名/串数据**
6. `Team.name @unique`（L89）——文档明示「团队名全平台唯一」（29 篇 L50/L90、15 篇 L124）。两个用户不能建同名团队（如都叫「我的团队」），且 `GET /teams` 全平台可见（29 篇 L124「首版团队为全平台可见，不做按项目隔离」）。**这是用户数据隔离的根断点**：所有业务数据都挂 teamId，但 team 本身全局。
7. `Member.name @unique`（L262）——注释 L261「成员名（**全局唯一**，@ 与私聊列表寻址用）」；成员库是平台级全局资源（37 篇 L35/L49）。两个用户不能各自建同名「架构师」，@ 寻址串到对方成员。
8. `Session.memberKey @unique`（L423, `uk_sessions_member`）+ `Session.turns`（L437）——「一成员一条全局会话」（37 篇 L44 D4），跨群跨任务共享上下文（37 篇 L54 D14「跨群记忆有意为之，不做技术隔离」）。多用户共用一个成员 ⇒ 上下文、记忆、私聊全部串。这是 37 篇主动做的全局化决策，与 workspace 隔离直接冲突。
9. `ChatChannel.uk_channels_team_group_single`（L517 `@@unique([teamGroupKey])`）+ `uk_channels_team_member`（L516）——每 team 一条群、每 (team,member) 一条私聊，全局唯一；无 workspace 前缀。
10. `Skill.name @unique`（L910）、`Tool.action @unique`（L952）、`AgentRole.key @unique`（L139）、`Agent.agentKey @unique`（L847）、`McpServer.name @unique`（L1106）、`GitCredential.name @unique`（L1055）、`GitRepo.repoUrl @unique`（L1071）、`Model.@@unique([providerID,modelID])`（L999）、`ModelCredential.@@unique([providerID])`（L1032）、`ProviderTombstone.providerID @id`（L1044）——**全部缺少 workspace 前缀维度**，多用户要么撞唯一键，要么被迫共享同一份目录行。
11. `ExternalUser.externalId @unique`（L540）——全局外部用户目录；`20261110160000_external_users/migration.sql` 回填按 `name:<展示名>` 全局分组，注释自认「同名不同人会被合并成一条目录记录」。两个用户的外部渠道同名联系人会被错误合并。
12. `dedupKey @unique` 三处：`MessageReceipt.dedupKey`（L621）、`Trigger.dedupKey`（L680）、`Hook.dedupKey`（L715）——注释给的格式是 `from::to::sha1(...)` / `kind:scope:id` / `hook:<scope>:<id>`，**scope 里没有 workspace**；跨用户同业务 id 会互相幂等掉（A 的派发把 B 的同键回执吃掉）。
13. `Plan.taskId @unique`（L1213 「一任务一计划」）、`TeamQueue.taskId @unique`（L226）、`AgentQuestion.requestId @unique`（L1320）、`MessageDelivery/NotificationDelivery @@unique([channelId,externalId])`（L1378/L1416）——逻辑 id 全局唯一但无 workspace 命名空间，跨用户 id 生成器若复用序号会撞。

**P1 — 配额/统计/审计无法按用户归账**
14. `ModelUsage`（L1492-1519）：全部维度是 `teamId/teamMemberId/sessionId/channelId/agentId/taskId`（L1495-1500），**没有 userId/workspaceId**；索引 `idx_usage_team_member`/`idx_usage_team_model`（L1516-1517）只按 team 聚合。注释 L1479-1483 明确「软关联、只存 id 串、只读审计事实」。要做 per-workspace 计费/配额，这张表缺根维度，且历史行无法反推归属。
15. `RealtimeEvent.scopeType/scopeId`（L1186-1187）、`Trigger.scopeType/scopeId`（L668-669）、`Hook.scopeType/scopeId`（L705-706）——SSE 广播/定时器/hook 的作用域只有 team/task 类，没有 workspace；多用户会收到彼此的实时事件（与 `notes-empirical-probe.md` 实证的「两个用户看到相同全局数据」一致）。
16. `Memory.level='global'`（L1268 注释「task|team|role|global」；L1270「global 级为空」）——存在**显式无归属的全局记忆行**，`autoInject`（L1276）会把全局记忆注入「本团队主 Agent」；多用户下 A 的全局记忆会进 B 的 prompt。
17. `User.username @unique`（L44）/ `email? @unique`（L47）——账号全局唯一；若 workspace 内允许同名账号（不同租户各自有 admin），当前唯一键不允许。这是「改用 email+workspace 复合唯一」还是「保持全局账号 + 多 workspace 成员」的建模分叉点。

**P1 — 审计字段被误当隔离键的隐患**
18. `createdBy`/`created_by` 共 ~12 处（Team L103、Member L289、Task L345、Agent L858、SkillVersion L939、GitCredential L1061、GitRepo L1073、Plan L1219、Memory L1293、Issue L791、MemberNotificationChannel L315、Plan.confirmedBy/finalizedBy 等），以及 `assigneeUserId`（L788）、`actorId`（L386/L822）、`grantedBy`（L1090）——**全部是审计/指派语义，不是隔离键**：多数可空、部分是裸 id 串不建 FK（如 Memory.createdBy 注释 L1293「agent 实例 id 或 user id（兼容）」、Plan.createdBy 注释 L1219「主 Agent 实例 id」）、且查询路径没有任何基于它们的过滤。若后续有人想「拿 createdBy 当租户键」会踩空：Agent 创建的 Task/Memory/Issue 的 createdBy 根本不是登录用户。

---

## (D) 做 workspace 隔离，schema 层最小改动集合

### D1 · 新增表（2 张，最小集）
1. **`Workspace`**：`id @id`（`ws_` 前缀）、`name`、`ownerUserId` FK→User、`createdAt/updatedAt`、`@@unique([ownerUserId, name])`（允许同一用户多个 workspace 时名字不撞；若「一用户一 workspace」可让 `ownerUserId @unique`）。
2. **`WorkspaceMember`**（用户↔workspace，支持一个用户进多个空间 / 一个空间多用户 + 空间内角色）：`@@id([workspaceId,userId])`、可选 `role`（owner/admin/member）。若产品明确「每用户恰一个 workspace、无共享」，可省这张表，直接 `User.workspaceId?`。

> 建模分叉需产品拍板：①「User 属于 1 个 workspace」→ 只给 User 加 `workspaceId`；②「User 可进多个 workspace」→ 必须 WorkspaceMember + 请求上下文带 currentWorkspaceId + JWT 携带 workspaceId（实证探测 notes 第 9 行指出当前 JWT payload 只有 `{sub,username,roleId,type}`）。建议按 ② 设计，① 是其退化。

### D2 · 给「隔离根」表加 workspaceId（必须先做，否则下游全部无根）
- **`User`**：加 `defaultWorkspaceId?`（或仅靠 WorkspaceMember）。
- **`Team`**：加 `workspaceId`（NOT NULL，FK→Workspace）——**最关键的一行**。因为 `Task/Session/ChatChannel/Message/Artifact/Issue/Memory/ModelUsage/TeamQueue/TeamMember/各关联表` 全部通过 `teamId` 挂到 Team，Team 带上 workspaceId 后，绝大多数业务表**无需逐表加列**，靠 join Team 即可过滤（服务层统一注入 `where: { team: { workspaceId } }`）。

### D3 · 必须直接加 workspaceId 的表（不能只靠 Team 传递）
- **无 teamId 的全局共享/凭据类**（要么改共享为 per-workspace，要么保留全局只读 + 显式「系统级」标记）：`ModelCredential`（L1018，改唯一键为 `@@unique([workspaceId,providerID])`）、`GitCredential`（L1052）、`GitRepo`（L1069）、`GitRepoGrant`（L1082）、`McpServer`（L1104）、`MessageChannel`（L1346）、`NotificationChannel`（L1383）、`ExternalUser`（L537）、`ProviderTombstone`（L1043，主键改 `(workspaceId,providerID)`）。
- **成员/模板类**：`Member`（L259，改 `name` 唯一）、`Agent`（L837，改 `agentKey` 唯一）、`AgentRole`（L135，改 `key` 唯一）、`Skill`（L908）、`SkillVersion`（L932）、`Tool`（L949）、`ExecutionPolicy`（L879）、`Worker`（L1123，若要做 per-workspace 节点池/配额）、`Model`（L970，若允许各 workspace 自定义模型目录）。
  - 取舍建议：把「平台内置模板」标为 `workspaceId NULL`（系统级，全平台只读共享），用户自建行带 workspaceId；唯一键用 `@@unique([workspaceId, key])` 且对 NULL 行的全局唯一另建部分唯一索引（MySQL 无 partial index，可用生成列 `scopeKey = IF(workspaceId IS NULL,'__global__',workspaceId)` 再 `@@unique([scopeKey,key])`）。
- **账本/统计类**：`ModelUsage`（L1492，加 `workspaceId` 才能按租户计费/配额）、`RealtimeEvent`（L1183）、`Trigger`（L663）、`Hook`（L703）、`MessageReceipt`（L611）、`AgentQuestion`（L1317）——这些多为「逻辑关联不建 FK」的软关联表，**只能直接加列**，无法 join 传递。

### D4 · 唯一键必须改（缺 workspace 前缀维度）
| 现状（行） | 改为 |
|---|---|
| `Team.name @unique`(89) | `@@unique([workspaceId, name])` |
| `Member.name @unique`(262) | `@@unique([workspaceId, name])` |
| `Member.originTeamMemberId? @unique`(288) | 回填溯源键，可保留全局（回填一次性）或加 workspace 前缀 |
| `Session.memberKey @unique`(423) / `@@unique([teamMemberKey])`(447) | 改 `@@unique([workspaceId, memberKey])`；**注意**：37 篇 D4 的「一成员一条全局会话」语义要改成「一 workspace 内一成员一条」，这是产品决策反转点 |
| `ChatChannel @@unique([teamGroupKey])`(517) / `@@unique([teamId,teamMemberId])`(516) | 加 workspace 前缀或靠 team 唯一性传递（teamId 本身已全局唯一，后者可不改） |
| `AgentRole.key @unique`(139) | `@@unique([workspaceId, key])` |
| `Agent.agentKey? @unique`(847) | `@@unique([workspaceId, agentKey])` |
| `Skill.name @unique`(910) | `@@unique([workspaceId, name])` |
| `Tool.action @unique`(952) | `@@unique([workspaceId, action])` |
| `Model @@unique([providerID,modelID])`(999) | `@@unique([workspaceId, providerID, modelID])`（若模型目录 per-workspace） |
| `ModelCredential @@unique([providerID])`(1032) | `@@unique([workspaceId, providerID])` |
| `ProviderTombstone providerID @id`(1044) | 复合 PK `@@id([workspaceId, providerID])` |
| `GitCredential.name @unique`(1055) | `@@unique([workspaceId, name])` |
| `GitRepo.repoUrl @unique`(1071) | `@@unique([workspaceId, repoUrl])` |
| `GitRepoGrant @@unique([agentId,repoId])`(1094) | `@@unique([workspaceId, agentId, repoId])` |
| `McpServer.name @unique`(1106) | `@@unique([workspaceId, name])` |
| `MessageChannel.name`(1348) / `NotificationChannel.name`(1385) | 目前连唯一都没有；加 `@@unique([workspaceId, name])` |
| `ExternalUser.externalId @unique`(540) | `@@unique([workspaceId, externalId])`（外部 id 按租户命名空间，避免两用户同名联系人合并） |
| `MessageReceipt.dedupKey @unique`(621) | `@@unique([workspaceId, dedupKey])`（或把 ws 前缀拼进 dedupKey 应用层串） |
| `Trigger.dedupKey @unique`(680) / `Hook.dedupKey @unique`(715) | 同上，`kind:ws:<id>` 或加列 |
| `MessageDelivery/NotificationDelivery @@unique([channelId,externalId])`(1378/1416) | channelId 已含 workspace 语义时可不加；否则加前缀 |
| `Plan.taskId @unique`(1213) / `TeamQueue.taskId @unique`(226) / `AgentQuestion.requestId @unique`(1320) | taskId/requestId 全局唯一时可不改；若 id 生成器改为 per-workspace 序号则必须加前缀 |
| `User.username @unique`(44) / `email? @unique`(47) | 视 D1 建模分叉：若「账号全局唯一 + 多 workspace」则保留；若「每 workspace 独立账号」则改 `@@unique([workspaceId, username])` |

### D5 · 数据迁移策略（沿用本仓已验证的 expand→backfill→dual-read→contract 四段式，见 37 篇 D8 / 15 篇 §8.2）
1. **expand**：新建 `workspaces` / `workspace_members`；给上述表**全部加可空** `workspace_id`（nullable，旧代码不读不炸），**先不建任何新唯一索引**。
2. **建默认 workspace**：`INSERT workspaces(id='ws_default', ownerUserId=<现有 admin>)`；把所有存量 `users` 挂进 `workspace_members`；所有存量行 `UPDATE ... SET workspace_id='ws_default'`（按「Team.createdBy → 该用户的 workspace」推导；Team/Agent/Member 等无 createdBy 的全局模板行统一归 ws_default 或标 `workspace_id=NULL` 表示系统级）。
3. **backfill 校验**：写约束检查脚本确认无 `workspace_id IS NULL` 的**用户数据行**（Team/Task/Session/Message/Memory/ModelUsage…）；模板类 NULL 行显式登记为系统级。
4. **dual-read**：服务层所有 Prisma 查询注入 `workspaceId`（从 JWT `@CurrentUser()` + `x-workspace-id`/当前 workspace 上下文取），列表/详情/写路径都要过滤；特别修 `TeamsController` 未挂 `TeamMembershipGuard` 的问题（实证 notes 第 32-35 行）。
5. **contract**：`ALTER ... MODIFY workspace_id NOT NULL`（用户数据表）；**drop 旧全局唯一索引 → 建带 workspace 前缀的新唯一索引**（顺序：先建新复合索引验证无重复，再 drop 旧的，避免中间态唯一性真空）；`Session.memberKey`/`ModelUsage` 等语义反转需单独评审。
6. **回滚**：本仓无 down-migration 约定（见 `20261110160000_external_users` 头部注释「本仓库无 down-migration 约定」），按 15 篇 §8.3「重建库回滚」口径，生产需先 mysqldump。

### D6 · 两个必须先拍板的产品决策（否则 schema 无法定稿）
- **空间与成员**：workspace 是「一用户一个」还是「一用户多个 + 可共享」？决定是否需要 `WorkspaceMember` 与 JWT 是否要带 `workspaceId`（实证 notes 第 9 行：当前 JWT 只有 `{sub,username,roleId,type}`）。
- **平台内置资源与凭据**：全局模板是「每个 workspace 一份（完全隔离）」还是「只读共享」？凭据是否每空间一份？决定 `ModelCredential`/`McpServer`/`Skill`/`Agent` 是加 workspaceId 还是只加 `visibility` 标记。凭据类（P0-1~4）建议必须 per-workspace，否则泄露面无法收敛。
- **会话与记忆**：设计文档 37 篇的「全局会话 + 跨群共享上下文」是否要为空间隔离反转？这是与现有设计文档**直接冲突**的一处，不是纯加列能解决的。

---

## 附：重点 model 定义/关系速查（你点名的）
`User`(42)↔`Role`(69) 多对一 `roleId`；`Team`(87) `creator=User(createdBy)`、`defaultModel=Model(defaultModelId,110)`、`mainAgentMember=TeamMember(109)`；`TeamMember`(186) 挂 Team/Member/Agent/AgentRole，唯一 `(teamId,agentId,seq)`；`TeamQueue`(223) `taskId @unique`；`TeamUserMember`(237) 是**唯一** `(teamId,userId)` 用户↔团队关联；`Member`(259) 挂 AgentRole/Agent/Model/Worker/User(creator)；`MemberNotificationChannel`(310) `notificationChannelId @unique` 全局；`Task`(329) `createdBy`/`teamId?`；`Session`(400) `memberKey @unique` 全局会话；`SessionTurn`(457) `runningKey @unique`；`ChatChannel`(491) 两条唯一；`ExternalUser`(537)/`Message`(561) `externalUserId?` 全局目录指针；`MessageReceipt`(611) 逻辑关联；`Agent`(837) `agentKey @unique`/`createdBy`；`AgentRole`(135) `key @unique`；`Model`(970) `@@unique([providerID,modelID])`；`WorkerModelAvailability`(1003) 复合 PK；`ModelCredential`(1018) `@@unique([providerID])` **全局单份**；`ProviderTombstone`(1043) `providerID @id`；`GitCredential`(1052) `name @unique`「Q1 全局唯一」；`GitRepo`(1069) `repoUrl @unique`；`GitRepoGrant`(1082) `@@unique([agentId,repoId])`；`McpServer`(1104) `name @unique`；`Memory`(1266) `level=global` 无归属 + `autoInject`；`RealtimeEvent`(1183) scope 无 workspace；`NotificationChannel`(1383) `secrets` 无归属；`ModelUsage`(1492) 无 userId/workspaceId；`Skill`(908)/`Tool`(949)/`Trigger`(663)/`Hook`(703)/`Artifact`(736)/`Issue`(778) 均无归属字段；**`Upload` model 不存在**（仅 `schema.prisma:580` 注释提及 `/uploads`）。
