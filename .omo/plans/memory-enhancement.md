# memory-enhancement - Work Plan

## TL;DR (For humans)

**What you'll get:** 记忆模块三项强化：① **引用计数指标**（`refCount`，agent 每次主动检索命中 +1，配合 `lastUsedAt` 时间衰减出重要度分，注入与检索改为按重要度排序，管理页/新 tab 展示）；② **记忆整理管线**（定时 Trigger + 手动端点触发，服务端只收集候选清单并派 prompt 给各团队主 Agent，分类/合并去重/归档全部由 Agent 经新增 MCP 工具 `memory_archive`/`memory_merge` 执行，群聊落灰色 system 条留痕）；③ **会话页记忆子 tab**（右侧团队 tab 下新增"记忆"子 tab，列出本团队+全局记忆，支持禁用=归档/删除=硬删/恢复，团队成员可操作团队记忆、全局记忆操作仅管理员）。

**Why this approach:** 沿用仓库既定架构——平台不直接调 LLM（AI 判断全在 Agent 侧，平台只派 prompt，对齐"平台不做 LLM 摘要/提取"护栏）；调度复用 DB 持久化 Trigger 引擎（本仓的 cron 替代，无 @nestjs/schedule）；归档复用既有 `deletedAt` 软删（禁用=归档，不加新状态列）；派发复用 `dispatchAgentMention`（prompt 不落 messages，群聊无感）；排序改为重要度是"按需注入"哲学的自然升级（top-5 预算不变）。

**What it will NOT do:** 不做定时硬删（硬删仅 UI 人工触发）；自动注入不计 refCount（仅主动 search 计数，防主 Agent 每轮刷新刷爆指标）；定时整理不处理 global/role 级记忆（无宿主团队，global 写操作仅管理员 UI 单条处理）；不引入向量/embedding/服务端 LLM 调用；不放开 PATCH 编辑权限（仍 AdminGuard）；不给 Agent 暴露硬删/恢复工具。

**Effort:** Large（9 个实现任务，跨 server + web 双端，含权限改造）
**Risk:** Medium — GET/PATCH 权限从全 AdminGuard 放宽为成员感知（**`findAll` 成员过滤是安全必做，漏掉=泄露全部团队记忆**）；其余核心（迁移/计数/排序/tab）低风险
**Decisions to sanity-check:** ① 仅主动 search 计数（注入不计）② 禁用=归档复用 deletedAt，不加 enabled 列 ③ 团队成员可操作团队记忆、global 行写操作仅 admin（推翻原"不扩展权限矩阵"立场，需同步更新 controller 注释）④ `DELETE` 保留归档（软删）语义保管理页兼容，新增 `POST /:id/purge` 承载硬删（对讨论稿"DELETE=硬删"的接口细化，UI 行为不变：tab"删除"按钮调 purge）⑤ 定时整理仅 team 级、全 Agent 驱动、平台不调 LLM ⑥ team 级派发跳过【团队接待】人格。

Your next move: approve 后执行 `$start-work memory-enhancement`，或先运行高精度评审（momus + oracle 双评审）。完整执行细节如下。

---

> TL;DR (machine): Large effort, Medium risk — 记忆模块强化（9 todos + F1-F4 终验）：refCount 指标与重要度排序（P1）、成员感知权限+归档/恢复/硬删+记忆子 tab（P2）、Agent 驱动定时整理管线（P3）。

## Scope

### Must have

**P1 指标（todos 1/4/5）**
- **mem-metric-schema**：`Memory` 模型加 `refCount Int @default(0) @map("ref_count")`、`lastUsedAt DateTime? @map("last_used_at")`、`mergedIntoId String? @map("merged_into_id")` + `@@index([refCount])` + 迁移 + 守卫测试；新增重要度公式纯函数 `computeMemoryImportance`（半衰期 30 天默认，env 可调）
- **mem-search-rank**：`memorySearch` 返回结果按重要度重排 + 命中 id 集合 `updateMany({increment:1, lastUsedAt})` fire-and-forget 计数
- **mem-inject-rank**：`buildTeamMemoryIndex` 候选改 `orderBy refCount desc take 50` → 内存按重要度精排 → top5（1200 字预算不变）

**P2 权限 + tab（todos 2/3/6/7）**
- **mem-rest-perm**：`GET /memories` 去 AdminGuard → 成员感知过滤（非 admin 仅 `global ∪ 自己的团队`）+ `archived` 筛选；`DELETE` 去 AdminGuard → per-row 鉴权（语义仍=归档软删）；新增 `POST /:id/restore`（撞活跃同 hash → 409）与 `POST /:id/purge`（硬删）；`PATCH` 保留 AdminGuard
- **mem-web-api**：抽 `web/src/api/memories.ts` typed wrapper + 导出 `memoriesQueryKey`，管理页等价迁移
- **mem-tab**：`TeamRightPanel.tsx` `TeamSubTab` 加 `"memories"`，新组件 `TeamMemoriesTab.tsx`（本团队/全局两组列表 + 禁用/删除/恢复 + refCount 徽标 + 活跃/已归档切换；全局行操作仅 admin）
- **mem-admin-archive**：管理页 delete 按钮改"归档"文案 + 已归档视图（恢复/永久删除）+ refCount 展示 + `mergedIntoId` 合并追溯只读标记

**P3 Agent 整理管线（todos 8/9）**
- **mem-mcp-tools**：新增 `vteam_memory_archive` / `vteam_memory_merge`（服务端不变量：merge 累加 refCount+写 mergedIntoId+软删败者；scope 仅本团队 team 级，global/role 403）+ capability 点 + 角色 allowlist
- **mem-trigger-pipeline**：`TRIGGER_KIND.MEMORY_MAINTENANCE`（4 处注册）+ 全局单行 interval 触发器（env `MEMORY_MAINTENANCE_INTERVAL_MS` 默认 24h、0=禁用）+ 冷却 guard + 每团队候选收集（同 hash 组/低频未引用/标签不规范，cap 50）+ 灰色 system 条 + 派发主 Agent（`kind:'wake'`、private→group 频道、跳过接待人格）+ 手动 `POST /memories/maintain` + 结果统计回填

### Must NOT have (guardrails, anti-slop, scope boundaries)
- **定时硬删 / 任何自动 purge**（硬删仅 tab/管理页人工 ConfirmDialog 触发）
- **自动注入计 refCount**（仅 `memorySearch` 主动检索计数；管理端 GET、去重探查 `findDuplicateMemory`、save/update 一律不计）
- **global/role 级定时整理**（本轮不做——无宿主团队；global 行写操作仅 admin UI 单条处理）
- **服务端直接调 LLM / 引入 embedding / 向量库**（AI 判断全在 Agent 侧，平台只派 prompt 与候选清单）
- **放开 PATCH 编辑权限**（编辑仍 AdminGuard-only）
- **`findAll` 无成员过滤的全量返回**（非 admin 必须 OR 过滤——安全红线）
- **给 Agent 暴露 purge/restore 工具**（Agent 只有 archive/merge；refCount/mergedIntoId 对 agent 只读，不可作入参）
- **`DELETE` 改硬删语义**（DELETE 保持软删=归档，管理页既有调用零破坏；硬删走新端点 `POST /:id/purge`）
- **category / enabled 新状态列**（归档复用 deletedAt；分类复用既有 tags 约定 `howto|pitfall|constraint`）
- 向量化/全文索引检索；合并操作的 UI 回滚向导（`mergedIntoId` 只读追溯标记即可）；role 级记忆进 tab

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（server 单测随实现写入，对齐既有 spec 风格：platform-mcp.service.spec / worker-dispatcher.spec / memories.service.spec / memories.controller.spec + 迁移守卫 spec）；web 用 `npm run build` + `npm run lint`，环境允许时 Playwright 冒烟
- Evidence: .omo/evidence/task-<N>-memory-enhancement.<ext>（attemptDir = currentAttemptDir from 'omo ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/）
- 安全专项验收（todo 2 必测）：非 admin GET 跨团队不可见；成员 purge global 403；成员 archive/purge 仅限本团队行

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- **Wave 1**（3 todos，可并行，文件零冲突）：Todo 1（mem-metric-schema，prisma/migrations/新文件）、Todo 2（mem-rest-perm，memories 服务/控制器/DTO/constants）、Todo 3（mem-web-api，web 新 wrapper 文件）
- **Wave 2**（3 todos，可并行）：Todo 4（mem-search-rank，platform-mcp.service）、Todo 5（mem-inject-rank，worker-dispatcher）、Todo 6（mem-tab，web TeamRightPanel+新文件）
- **Wave 3**（3 todos，可并行）：Todo 7（mem-admin-archive，web 管理页）、Todo 8（mem-mcp-tools，platform-mcp）、Todo 9（mem-trigger-pipeline，timers/memories/chat）
  - 8/9 工具名以契约 `vteam_memory_archive`/`vteam_memory_merge` 固定，编译互不依赖（9 的 prompt 只引用字符串），集成正确性由 F 波验证；若执行时发现 platform-mcp.service.ts 被 4 与 8 同波冲突——4 在 Wave 2 已完成，无重叠
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. mem-metric-schema | - | 4, 5, 6, 7 | 2, 3 |
| 2. mem-rest-perm | - | 3(端点契约), 6, 7, 8, 9 | 1 |
| 3. mem-web-api | 2(契约) | 6, 7 | 1, 2 |
| 4. mem-search-rank | 1 | - | 5, 6 |
| 5. mem-inject-rank | 1 | - | 4, 6 |
| 6. mem-tab | 1, 2, 3 | - | 4, 5 |
| 7. mem-admin-archive | 1, 2, 3 | - | 8, 9 |
| 8. mem-mcp-tools | 2 | F 波 | 7, 9 |
| 9. mem-trigger-pipeline | 2, 8(契约) | F 波 | 7, 8 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. mem-metric-schema：Memory 三新列 + 迁移守卫 + 重要度公式
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` `model Memory`（:1020-1057）新增：`refCount Int @default(0) @map("ref_count")`、`lastUsedAt DateTime? @map("last_used_at")`、`mergedIntoId String? @map("merged_into_id")`；索引 `@@index([refCount], map: "idx_memories_ref_count")`（命名对齐既有 `idx_memories_*` 风格）
  - 生成迁移：`cd server && npx prisma migrate dev --name memory_refcount`（产物 server/prisma/migrations/<ts>_memory_refcount/migration.sql，仅 `ADD COLUMN` + `CREATE INDEX`，**无回填 UPDATE**）；`npx prisma generate`
  - 新建 `server/src/memories/memory-importance.ts`：常量 `MEMORY_IMPORTANCE_HALF_LIFE_DAYS = 30`（env `MEMORY_IMPORTANCE_HALF_LIFE_DAYS` 覆盖，`Number.isFinite` 校验，对齐 trigger.service.ts:678-685 惯例）+ 纯函数 `computeMemoryImportance(row: {refCount: number; lastUsedAt: Date|null; createdAt: Date}): number`，公式 `score = ln(1 + refCount) + exp(-ageDays / halfLifeDays)`（age 基准 = `lastUsedAt ?? createdAt`；含义：全新未引用记忆 ≈1.0，被引用 2 次 ≈1.1+，引用多者压过新鲜度）
  - 新建守卫测试 `server/src/prisma/memory-refcount.migration.spec.ts`，**逐条克隆** `memory-role-inject.migration.spec.ts`（:38-40, :70-125）的断言结构：① schema.prisma 含三新列与索引声明 ② 基线迁移（20260925000000_squashed_baseline）中**不**含这些列（防重复 ADD）③ `CREATE INDEX` 名与 `@@index` 声明一致 ④ 新迁移无回填 UPDATE ⑤ 死列 `taskId` 未被删除
  - 新增 `server/src/memories/memory-importance.spec.ts`：0 引用新记忆 score∈(0.9,1.1]；同龄下 refCount 升 score 单调升；同 refCount 下越老 score 越低；`lastUsedAt` 比 `createdAt` 更新则以 lastUsedAt 计龄
  - Must NOT：不加 category/enabled 列；不删死列 taskId；不引入 Prisma enum；不改其他模型；不写回填
  Parallelization: Wave 1 | Blocked by: - | Blocks: 4, 5, 6, 7
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:1020-1057（Memory 模型）；server/prisma/migrations/20260930010000_memory_role_inject/migration.sql:15-20（加列迁移先例）；server/src/prisma/memory-role-inject.migration.spec.ts（守卫测试模板，逐条照抄结构）；server/prisma/migrations/20260925000000_squashed_baseline/migration.sql:373-401（基线 DDL）；server/src/timers/trigger.service.ts:678-685（env+Number.isFinite 惯例）；server/src/memories/memory.constants.ts（constants 文件风格）
  Acceptance criteria (agent-executable): `cd server && npx prisma migrate status` up to date；`npx tsc --noEmit` 通过；`npm run test -- memory-importance memory-refcount` 全绿
  QA scenarios (name the exact tool + invocation): happy——`npx prisma migrate dev --name memory_refcount` 生成迁移、`npx prisma migrate deploy` 幂等通过；failure——守卫测试在人为向迁移注入回填 UPDATE 时失败（验证断言真实生效）。Evidence .omo/evidence/task-1-memory-enhancement.txt
  Commit: Y | feat(memory): 记忆引用计数字段与重要度公式

- [x] 2. mem-rest-perm：成员感知查询 + 归档/恢复/硬删端点
  What to do / Must NOT do:
  - `dto/query-memories.dto.ts`：`QueryMemoriesDto` 加 `archived?: boolean`（@Transform "true"/"false"→bool + @IsIn([true,false])，抄 :46-57 `autoInject` 三态模式；undefined=只查活跃 `deletedAt:null`，true=只查已归档 `deletedAt not null`）
  - `memories.service.ts`：
    - **成员感知 `findAll`**：admin 判定抽谓词（抄 `users/admin.guard.ts:55-61`：`permissions.all===true || permissions.users.manage===true`，从 `@Req()` 用户上下文取）；非 admin 的 where **必须** `AND: [{ OR: [{level:'global'}, {teamId: {in: 我的团队id集}}] }]`（我的团队集 = `prisma.teamUserMember.findMany({where:{userId}, select:{teamId}})`，先例 chat.service.ts:190-279）；admin 维持现状全量；`archived` 组合进 where
    - **per-row 鉴权 helper**（如 `assertRowWritable(row, userId, isAdmin)`）：`row.teamId` 非空 → 查 `teamUserMember` 含 userId 否则 403 `MEMORY_FORBIDDEN`（抄 :127-142 既有校验模式）；`row.teamId` 为空（global 行）→ 必须 admin 否则 403
    - `remove(id)` 语义**不变**（写 deletedAt 软删=归档），仅：去 controller 守卫后改走 per-row 鉴权；软删行重复调用维持既有 404
    - 新增 `restore(id)`：per-row 鉴权 → 行必须已软删否则 404 → **先查同 scope 活跃重复**（同 `contentHash` + 同 level/teamId/roleId 且 `deletedAt:null` 且 id 不同，抄 `findDuplicateMemory` platform-mcp.service.ts:3374-3390 条件）存在 → 409 `MEMORY_RESTORE_DUPLICATE` → 否则 `deletedAt: null` 清除
    - 新增 `purge(id)`：per-row 鉴权 → `prisma.memory.delete`（**真硬删**）→ 不存在 404
  - `memory.constants.ts` `MEMORY_ERRORS`（:30-34）追加 `MEMORY_FORBIDDEN`(403)、`MEMORY_RESTORE_DUPLICATE`(409)
  - `memories.controller.ts`：`GET` 去 `@UseGuards(AdminGuard)`（仍受全局 JwtAuthGuard 保护）；`DELETE` 去 AdminGuard（service 层 per-row）；新增 `POST /memories/:id/restore`、`POST /memories/:id/purge`（无 AdminGuard，per-row）；**`PATCH` 保留 AdminGuard**；更新 :22-26 过期注释（说明新权限模型：读=成员感知、团队行写=成员、global 行写=admin、编辑=admin）
  - 单测扩展 `memories.service.spec` + `memories.controller.spec`：非 admin GET 只见 global+自己团队（他人团队记忆不可见）；admin GET 全量回归；成员 archive(DELETE)/purge 本团队行成功；成员 purge/restore global 行 403；成员操作他人团队行 403；restore 活跃行 404、归档行成功回列表、撞活跃同 hash 409；purge 后行彻底消失（findUnique 返回 null）；archived 三态筛选正确
  - Must NOT：不改 PATCH 语义/权限；**不改 DELETE 的软删语义**（硬删走 purge）；不动 platform-mcp 的 memorySearch（属 todo 4）；非 admin 路径漏 OR 过滤=红线；不引入新权限资源位（roles.constants 不动）
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3, 6, 7, 8, 9
  References (executor has NO interview context - be exhaustive): server/src/memories/memories.controller.ts:22-26,41-85；server/src/memories/memories.service.ts:54-195（findAll/remove、:127-142 per-row 校验先例、:167-195 软删）；server/src/memories/dto/query-memories.dto.ts:25-126；server/src/users/admin.guard.ts:25-67（admin 谓词）；server/src/chat/chat.service.ts:190-279（用户团队集合查询先例）；server/src/memories/memory.constants.ts:14-61；server/src/platform-mcp/platform-mcp.service.ts:3374-3390（findDuplicateMemory 条件）；server/src/prisma/memory-role-inject.migration.spec.ts（若 controller spec 引 403/409 错误码风格，对齐 MEMORY_ERRORS 用法）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿（含新增权限矩阵用例）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言成员 GET 响应 items 全部满足 `level==='global' || teamId===自己团队`；failure——构造跨团队 purge 断言 403、global purge 断言 403、restore 撞重复断言 409、漏过滤时专用测试用例失败。Evidence .omo/evidence/task-2-memory-enhancement.txt
  Commit: Y | feat(memory): 记忆接口成员感知权限与归档恢复硬删

- [x] 3. mem-web-api：web 记忆 API wrapper 抽取
  What to do / Must NOT do:
  - 新建 `web/src/api/memories.ts`（对齐 `web/src/api/teams.ts` typed helper 风格）：
    - 类型 `MemoryItem`（含新字段 `refCount: number`、`lastUsedAt?: string|null`、`mergedIntoId?: string|null`、既有全字段）、`MemoriesResponse {items, total, page, pageSize}`
    - 方法：`list(params: {level?, teamId?, archived?, keyword?, page?, pageSize?})` → `api.get<MemoriesResponse>('/memories', {query})`；`archive(id)` → `api.delete('/memories/'+id)`（注释注明=归档软删）；`restore(id)` → `api.post('/memories/'+id+'/restore')`；`purge(id)` → `api.post('/memories/'+id+'/purge')`；`setAutoInject(id, v)` → `api.patch`
    - 导出 `memoriesQueryKey(params)`（对齐 TeamRightPanel.tsx:2120-2144 `triggersQueryKey` 导出模式），供管理页与 tab 共用失效
  - `web/app/(main)/system/memories/page.tsx` **等价替换**：`api.get("/memories"...)`/`api.patch`/`api.delete` 调用点（:1056-1145）改为 wrapper 调用，类型 `MemoryItem`/`MemoriesResponse`（:57-83）改为从 wrapper import——**纯重构，UI 与行为零变化**（delete 仍调 DELETE 路径=归档，文案改动属 todo 7）
  - Must NOT：不改管理页 UI/文案/行为；不重复定义类型；不改接口路径语义
  Parallelization: Wave 1 | Blocked by: 2(端点契约，可先按本 plan 契约编写) | Blocks: 6, 7
  References (executor has NO interview context - be exhaustive): web/src/api/teams.ts（typed helper 模板）；web/app/(main)/system/memories/page.tsx:57-83（现有类型）、:1056-1145（query/mutation 调用点）；web/src/components/teams/TeamRightPanel.tsx:2120-2144（exported queryKey 模式）；web/lib/api.ts（api.get/post/patch/delete 签名）；web/lib/errors.ts（isApiError）
  Acceptance criteria (agent-executable): `cd web && npm run build` 通过；`npm run lint` 通过；grep 确认管理页不再裸调 `api.get<MemoriesResponse>("/memories"...)`（改经 wrapper）
  QA scenarios (name the exact tool + invocation): happy——build+lint 绿且管理页列表/筛选/删除按钮行为与改前一致（Playwright 冒烟：/system/memories 渲染、分页、删除确认弹窗出现）；failure——类型错误导致 build 失败即验收不通过。Evidence .omo/evidence/task-3-memory-enhancement.txt
  Commit: Y | refactor(web): 记忆 API wrapper 抽取

- [x] 4. mem-search-rank：memorySearch 重要度排序 + 引用计数
  What to do / Must NOT do:
  - `server/src/platform-mcp/platform-mcp.service.ts` `memorySearch`（:3849-3994）两处改动：
    1. **计数（在最终 `.slice(0, limit)` 之后）**：取 slice 结果的 `id` 数组 → `void this.prisma.memory.updateMany({ where: { id: { in: ids } }, data: { refCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(err => this.logger.warn(...))`——fire-and-forget，**失败仅告警绝不影响返回值**；ids 为空跳过；`{increment:1}` 惯例抄 trigger.service.ts:589
    2. **排序**：`filterMemoryByTags`（:7532-7541）过滤后、slice 前，对候选全量计算 `computeMemoryImportance(row)` 降序排列（importance 相同则 `lastUsedAt/createdAt` 新者在前），再 `slice(0, limit)`；返回对象结构不变
  - 单测扩展 `platform-mcp.service.spec`：返回 N 条时 `updateMany` 仅收到这 N 个 id（不是 DB 候选全量）；tags 过滤淘汰的行**不**计数；`updateMany` reject 时 memorySearch 正常返回结果不抛错；排序断言（构造 refCount 高但较旧 vs refCount 0 最新 → 前者在前）；limit 截断后仍只计截断后的 id
  - Must NOT：不改 where 过滤语义（deletedAt/scope/keyword/limit 归一化）；不给管理端 GET/`findDuplicateMemory`/save/update 计数；不做自动注入计数（决策②）；计数失败不得影响工具返回；不改返回字段结构
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/platform-mcp/platform-mcp.service.ts:3849-3994（memorySearch 全流程，:3987 findMany、:3993 filter、:3994 slice）、:7525-7541（limit 归一化/tags 过滤）、:3374-3390（不计数路径）；server/src/timers/trigger.service.ts:589（increment 惯例）；server/src/memories/memory-importance.ts（todo 1 产出）；server/src/platform-mcp/platform-mcp.service.spec.ts（既有 mock/prisma 测试风格）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿（含上述新增断言）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言命中 2 条时 updateMany 的 `id.in` 恰为这 2 个；failure——mock updateMany 抛错断言 memorySearch 仍返回、断言候选集中未返回的行不在 `id.in` 中。Evidence .omo/evidence/task-4-memory-enhancement.txt
  Commit: Y | feat(memory): 检索命中计数与重要度排序

- [x] 5. mem-inject-rank：自动注入按重要度选 top5
  What to do / Must NOT do:
  - `server/src/chat/worker-dispatcher.ts` `buildTeamMemoryIndex`（:1954-2014）：候选查询从 `orderBy:{createdAt:'desc'}, take:5` 改为 `orderBy:[{refCount:'desc'},{createdAt:'desc'}], take:50`（走 idx_memories_ref_count）→ 内存 `computeMemoryImportance` 降序 → `slice(0, 5)` → 进入既有 1200 字预算/截断逻辑（:2008 附近，保持不变）
  - 检查 `MEMORY_INSTRUCTION`（:272-300）与注入文案（:686-688）：若含"最新 N 条"类表述则改为"按重要度"；无则不动
  - 单测扩展 `worker-dispatcher.spec`：构造 refCount=3 昨天 vs refCount=0 但 7 天前 → 前者入选；全新 refCount=0 记忆不被饿死（同龄 fresh 记忆可入池——验证公式 recency 项生效）；5 条上限与 1200 字预算回归断言；受众过滤（isMainAgent/roleId/autoInject）回归断言
  - Must NOT：不改受众过滤（autoInject:true、team/global 仅主 Agent、role 记忆按 role）；不超 5 条/1200 字预算；此处**不计数**（决策②：注入不算引用）；不改 prompt 其他段
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/chat/worker-dispatcher.ts:1954-2014（buildTeamMemoryIndex 全流程）、:272-300（MEMORY_INSTRUCTION）、:686-688（memoryIndex 注入点）、:2389-2427（调用与 taskId 门控）；server/src/chat/worker-dispatcher.spec.ts（prompt 断言用例，:7712-7727 团队模式断言风格）；server/src/memories/memory-importance.ts（todo 1 产出）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿（含上述新增断言）；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy——jest 断言高引用行胜出且注入条数=5；failure——断言若无 recency 项则全新记忆永不可见的用例（防饿死验证）。Evidence .omo/evidence/task-5-memory-enhancement.txt
  Commit: Y | feat(memory): 自动注入按重要度选记忆

- [x] 6. mem-tab：会话页团队 tab 下新增"记忆"子 tab
  What to do / Must NOT do:
  - `web/src/components/teams/TeamRightPanel.tsx` 三处接线：`:586` `type TeamSubTab = "overview" | "channels" | "memories"`；`:945-955` 按钮数组追加 `{ key: "memories" as const, label: "记忆" }`（按钮行已 overflowX:auto，无需布局改动）；`:1325` channels 块之后追加 `{subTab === "memories" && <TeamMemoriesTab teamId={team?.id ?? ""} teamName={team?.name} />}`（`team` prop 在 TeamSubTabs 作用域内已有）
  - 新建 `web/src/components/teams/TeamMemoriesTab.tsx`（tab body 抽独立文件，对齐 modal 抽离惯例）：
    - **状态**：`archived`（false=活跃/true=已归档，SegmentedTabs 切换）、`keyword`（300ms 防抖，抄管理页 :1036-1042）、两组各自 page（pageSize 20，"加载更多"式追加或独立翻页，实现取简）
    - **查询**（react-query，经 `memoriesApi` wrapper + `memoriesQueryKey`）：`list({level:'team', teamId, archived, keyword, page, pageSize})` + `list({level:'global', archived, keyword, page, pageSize})` → 分组渲染 **"本团队"** / **"全局"** 两段（全局组标题加说明"平台级记忆"）
    - **行卡片**（视觉语义复制管理页局部组件：LevelBadge/TypeChips/AutoInjectSwitch 样式 :298-529，改为 tab 内局部函数组件）：content 摘要（展开/收起可选）、tags chips、autoInject 徽标（注入中/仅检索）、**refCount 徽标「引用 N」**、relative time；`mergedIntoId` 非空显示「已合并至 <id>」只读标记
    - **操作**：活跃视图——团队行显示 `禁用`（= `memoriesApi.archive`，文案"归档后可恢复"）与 `删除`（= `memoriesApi.purge`，ConfirmDialog"永久删除，不可恢复"）；**全局行仅 `isAdmin` 显示操作**；已归档视图——团队行全员可 `恢复` / `永久删除`，全局行仅 admin；所有 mutation `onSuccess` → `queryClient.invalidateQueries({queryKey: memoriesQueryKey(...)})` 及 `["memories"]` 前缀失效（管理页同步刷新）
    - `isAdmin`：`useAuthStore((s) => s.user?.roleName === "admin")`（抄 git-repos/page.tsx:385-386；仅控按钮显隐，服务端 per-row 鉴权为准）
    - 空态 `EmptyState`、错误态沿用既有组件；加载骨架可选
  - Must NOT：不改 `session/page.tsx`（TaskRightTabs 已传 team）；不提供内容/tags 编辑（编辑仍管理页）；不做 merge 操作 UI（合并走 Agent）；不列 role 级记忆；不自建 fetch（一律经 wrapper）
  Parallelization: Wave 2 | Blocked by: 1, 2, 3 | Blocks: -
  References (executor has NO interview context - be exhaustive): web/src/components/teams/TeamRightPanel.tsx:391-529（TeamMemoryCard 既有卡片可参考/复用）、:586（TeamSubTab）、:891-957（TeamSubTabs 按钮与 scroll 容器）、:1325（body 插入点）、:3725-3870（TaskRightTabs 传参链）、:146-1504（viewer/isMember 读取）；web/app/(main)/system/memories/page.tsx:108-335（helpers/chips）、:454-529（AutoInjectSwitch）、:1029-1048（防抖与状态重置）、:1501-1517（ConfirmDialog）；web/app/(main)/git-repos/page.tsx:385-386（isAdmin 惯例）；web/src/api/memories.ts（todo 3）；web/src/components/ui/{segmented-tabs,confirm-dialog,empty-state}.tsx
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过；Playwright/手测冒烟：团队 tab 出现"记忆"子 tab；两组列表渲染；团队行禁用→行消失且切"已归档"可见；恢复→回活跃列表；删除弹"不可恢复"确认后行消失；非 admin 账号全局行无操作按钮；tab 内操作后 /system/memories 同步刷新
  QA scenarios (name the exact tool + invocation): happy——浏览器打开会话页 → 团队 tab → 记忆子 tab，执行归档+恢复闭环；failure——API 403（成员操作 global）时按钮本就隐藏，直接调接口返回 403 且 UI 显示 isApiError 消息。Evidence .omo/evidence/task-6-memory-enhancement.txt
  Commit: Y | feat(web): 会话页记忆子 tab

- [x] 7. mem-admin-archive：管理页归档视图 + refCount 展示
  What to do / Must NOT do:
  - `web/app/(main)/system/memories/page.tsx`：
    - `deleteMutation` 语义改为归档：按钮/确认文案从"删除…不可恢复"改为"归档（可在已归档视图恢复）"，调用仍为 `memoriesApi.archive`
    - 列表区加"活跃 / 已归档"切换（复用 SegmentedTabs 或 LEVEL_TABS 旁次级 toggle），`archived=true` 时查询走 `list({archived:true,...})`（level/keyword 筛选仍生效）
    - 已归档视图行操作：`恢复`（restore，成功提示）+ `永久删除`（purge，ConfirmDialog 保留"不可恢复"警示）
    - 卡片与详情抽屉加 **refCount 展示**（「引用 N」）；`lastUsedAt` 有值显示"最近引用"相对时间（helper 抄 :260 formatRelativeTime）
    - `mergedIntoId` 非空 → 只读标记「已合并至 <id>」（卡片+抽屉）
    - 全部调用经 todo 3 的 `memoriesApi` wrapper，失效用 `memoriesQueryKey`
  - Must NOT：不改 level 筛选/关键词/分页既有行为；不加编辑新能力；不动导航与权限（页仍 admin 语义，但 GET 已成员感知——不需额外处理，admin 看到的不变）
  Parallelization: Wave 3 | Blocked by: 1, 2, 3 | Blocks: -
  References (executor has NO interview context - be exhaustive): web/app/(main)/system/memories/page.tsx:126-133（LEVEL_TABS）、:260-296（时间格式化/cardTitle）、:298-529（徽章/chips/开关组件）、:548-747（MemoryCard）、:747-1020（抽屉）、:1023-1200（页面状态与 hooks）、:1394-1445（分页）、:1501-1517（ConfirmDialog）；web/src/api/memories.ts（todo 3）
  Acceptance criteria (agent-executable): `cd web && npm run build` + `npm run lint` 通过；冒烟：删除按钮现文案为归档语义；归档一条 → 切已归档可见 → 恢复回活跃；已归档行永久删除弹"不可恢复"；卡片显示「引用 N」
  QA scenarios (name the exact tool + invocation): happy——归档/恢复/永久删除三操作闭环 + refCount 徽标渲染；failure——restore 遇活跃重复返回 409 时 UI 显示后端 message。Evidence .omo/evidence/task-7-memory-enhancement.txt
  Commit: Y | feat(web): 记忆管理页归档视图与引用展示

- [x] 8. mem-mcp-tools：memory_archive / memory_merge MCP 工具
  What to do / Must NOT do:
  - `server/src/platform-mcp/platform-mcp.tools.ts`：新增 `memoryArchiveSchema`（`{memoryId: string, selfInstanceId: string}`）与 `memoryMergeSchema`（`{sourceId: string, targetId: string, selfInstanceId: string}`），注册 `vteam_memory_archive`（description：归档=可恢复软删，从检索/注入消失）与 `vteam_memory_merge`（description：把 source 内容并入 target、引用计数累加、source 归档，用于语义重复合并）——注册位置与风格抄 :1095-1117 三工具
  - `server/src/platform-mcp/platform-mcp.service.ts`：
    - `memoryArchive(ctx, args)`：定位行（软删行 404）→ **scope 校验：仅 `level==='team'` 且 `row.teamId === 调用方团队`，global/role 行 403**（P3 只整理 team 级，决策⑤）→ 复用与 REST 相同的归档逻辑（写 `deletedAt`）。**复用方式二选一**：若 `MemoriesModule` 可被 platform-mcp 无环注入则注入 `MemoriesService` 调其 `remove`（鉴权改按 agent 团队上下文）；若存在循环依赖则抽 `server/src/memories/memory-state.ts` 纯 helper（传入 prisma+id+预期 scope），REST 与 MCP 共用——执行时以 tsc 无环为准择一，并在 commit message 注明选择
    - `memoryMerge(ctx, args)`：两行定位（任一软删 404）→ scope 校验同上（两行都必须是本团队 team 级）→ **服务端不变量**（agent 不可绕过）：`target.refCount += source.refCount`、`source.mergedIntoId = target.id`、`source.deletedAt = now`，单事务执行；`transferredRef` 一并返回；source 与 target 同 id → 400；返回 `{merged: true, targetId, transferredRef}`
    - **入参不含 refCount/mergedIntoId/deletedAt**（对 agent 只读，防污染指标）
  - 注册面同步三处：`platform-capability.constants.ts`（:182-197 模式）加 `memory.archive` / `memory.merge` 能力点；`agent-role.constants.ts`（:348-539）仅**主 Agent 相关角色** allowlist 加 `vteam_memory_archive`/`vteam_memory_merge`（整理派给主 Agent；普通成员角色不加）；`web/src/api/role-capabilities.ts`（:208-225）加映射（工具名→中文标签"归档记忆"/"合并记忆"）
  - 单测扩展 `platform-mcp.service.spec`：跨团队 archive/merge 403；global 行 archive/merge 403；merge 后断言 target.refCount=两者之和、source.deletedAt 非空、source.mergedIntoId=target.id（事务单次提交）；重复 merge（source 已软删）404；同 id 400；archive 后 memorySearch 不再返回
  - Must NOT：不暴露 purge/restore 给 Agent；不接收 refCount/mergedIntoId 入参；不动 memory_save/memory_search/memory_update 既有语义与 zod；不做 global/role 整理入口
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: F 波（9 依赖其工具名契约）
  References (executor has NO interview context - be exhaustive): server/src/platform-mcp/platform-mcp.tools.ts:370-487（既有 memory zod schema）、:1095-1117（注册模式）；server/src/platform-mcp/platform-mcp.service.ts:3374-3390（findDuplicateMemory/scope 条件）、:3542-3711（memorySave 的 scope/团队上下文与 selfInstanceId 校验模式）、:3849-3994（memorySearch 过滤）；server/src/memories/memories.service.ts:167-195（归档逻辑）；server/src/common/constants/platform-capability.constants.ts:182-197；server/src/common/constants/agent-role.constants.ts:348-539；web/src/api/role-capabilities.ts:208-225,35；server/src/memories/memories.module.ts + server/src/platform-mcp/platform-mcp.module.ts（注入方向，验环）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿（含不变量断言）；`npx tsc --noEmit` 通过（无循环依赖）
  QA scenarios (name the exact tool + invocation): happy——jest 断言 merge 事务：refCount 累加+mergedIntoId+软删原子完成；failure——跨团队/global 调用 403、已归档 source 404、同 id 400 断言。Evidence .omo/evidence/task-8-memory-enhancement.txt
  Commit: Y | feat(memory): 记忆归档与合并 MCP 工具

- [x] 9. mem-trigger-pipeline：定时整理触发器 + Agent 派发 + 手动端点
  What to do / Must NOT do:
  - **Trigger 注册四处**：`common/constants/trigger.constants.ts` `TRIGGER_KIND`（:15-22）加 `MEMORY_MAINTENANCE: 'memory_maintenance'`；`TRIGGER_KIND_LABEL`（:87-94）加「记忆整理」；`timers/triggers.service.ts` :712-770 per-kind 描述 switch 加分支；`QueryTriggersDto.kind` 的 `@IsIn(Object.values(TRIGGER_KIND))` 自动跟随（确认即可）。另 grep web 端是否有 kind 文案映射（搜 `progression_patrol`/`TRIGGER_KIND`），有则同步加标签
  - **新建 `server/src/memories/memory-maintenance.service.ts`**（注册进 `MemoriesModule` providers；module 加 import `TimersModule`、`ChatModule`、`RealtimeModule`（已 import）——先确认 ChatModule 不反向依赖 MemoriesModule：worker-dispatcher 直用 prisma 不依赖 MemoriesService，应无环，以 tsc 为准；若环则改走 handler 注册在 chat 侧+service 只出数据的两段式，commit 注明）
    - `onModuleInit`：① `registerHandler(TRIGGER_KIND.MEMORY_MAINTENANCE, handler)` ② `registerGuard(cooldownKey, guard)`（冷却窗口内拒绝重入，对齐 progression guard）③ **全局单行调度**：抄 `hook.service.ts:923-948 ensureGlobalPoll()`——`schedule(kind, dueAt, payload, dedupKey='memory_maintenance:global:main', { intervalMs, guardKey })`，幂等（已存在即跳过）
    - env（抄 trigger.service.ts:678-685 校验惯例）：`MEMORY_MAINTENANCE_INTERVAL_MS` 默认 86400000（24h），**0=禁用**（不 schedule 且取消已有行）；`MEMORY_ORG_UNUSED_DAYS` 默认 30；`MEMORY_ORG_CANDIDATE_LIMIT` 默认 50。接线 `docker-compose.yml` env 段（:71-74 旁）与 chart configmap（若存在 env 清单）
    - **handler 流程**（单轮）：
      a) 查有活跃 team 级记忆的团队（`groupBy teamId where level='team' and deletedAt:null`）
      b) 每团队收集**候选清单**（服务端只列表化，判断权在 Agent）：同 `contentHash` 组（同 scope ≥2 条）｜`refCount=0` 且 `lastUsedAt ?? createdAt` 早于 N 天 ｜ `tags` 缺失或含非 `howto|pitfall|constraint` 项（tags 是 Json，内存过滤）；按组 cap `MEMORY_ORG_CANDIDATE_LIMIT`，每条带 `{id, 摘要(前80字), tags, refCount, 建议动作}`
      c) **灰色 system 条**：抄 `task-progression.scheduler.ts:740-793 postStallNoticeToTeamGroup`——向该团队 `team_group` 频道写 `senderType=system` 消息 + 广播；文案：`【记忆整理】本轮检测：疑似重复 X · 低频未引用 Y · 标签不规范 Z，已派发整理` + **上轮实际结果**（服务端统计：`lastRunAt` 以来 `mergedIntoId` 非空/`deletedAt` 落点的 team 记忆数，无上轮则省略）
      d) **派发**：`dispatchAgentMention({ teamId, channelId, targetInstanceId: team.mainAgentMemberId, kind: 'wake', text: prompt })`——channelId 解析抄 `task-progression.scheduler.ts:846-857`（主 Agent private 优先 → team_group 回退）；mainMember 取 `Team.mainAgentMemberId`（无则跳过该团队并 logger.warn）
      e) 记录 `lastRunAt`（Trigger payload 内存字段或 DB）；单团队失败 try/catch 隔离，不影响其他团队
    - **prompt 模板**（中文，风格抄 `triggerMemoryHarvest` :800-819）：说明本轮任务（团队记忆整理）+ 候选清单（id/摘要/tags/建议动作）+ 指令：先 `vteam_memory_search` 核对内容 → 语义重复对调 `vteam_memory_merge`、低频/无效调 `vteam_memory_archive`、标签不规范调 `vteam_memory_update` 归一到 `howto|pitfall|constraint` → **单轮处理上限 20 条**（超出留待下轮）→ 结束后简要汇报处理结果
    - **跳过接待人格**：`worker-dispatcher.ts` `dispatchAgentMention` 输入加可选 `internal?: boolean`；prompt 组装处（team 级分支 :711-720 / :732-746 接待人格注入点，:2389-2427 teamMode 分支）当 `internal===true` 时不注入 `TEAM_SYSTEM_RECEPTION_INSTRUCTION`（维持 kind:'wake'，不受门禁）；`memory-maintenance` 派发传 `internal:true`。其他调用方零影响
    - **手动端点**：`memories.controller` 加 `POST /memories/maintain`（AdminGuard）→ 调同一 handler 单轮 → 返回 `{teams: N, candidates: {duplicates, unused, untags}}` 摘要
  - 单测（`memory-maintenance.service.spec` + worker-dispatcher.spec 增补）：候选收集三分组正确、cap 生效；system 条消息落库断言（senderType=system、目标 team_group）；dispatch 参数断言（kind='wake'、target=mainAgentMemberId、private 频道优先）；interval=0 不调度且清已有行；guard 冷却内不重入；`internal:true` 的 prompt **不含**接待人格文案、`internal` 缺省时既有 team 派发仍含（回归）；单团队异常不中断全局循环
  - Must NOT：不做 global/role 定时整理；不做定时硬删/purge；服务端不直接调 LLM（只组 prompt+候选清单）；报告不依赖 Agent 回传（结果=服务端统计）；不改既有 6 个 TRIGGER_KIND 行为；`POST /maintain` 不对非 admin 开放
  Parallelization: Wave 3 | Blocked by: 2, 8(工具名契约：`vteam_memory_archive`/`vteam_memory_merge`) | Blocks: F 波
  References (executor has NO interview context - be exhaustive): server/src/common/constants/trigger.constants.ts:15-94；server/src/timers/trigger.service.ts:196-297（registerHandler/registerGuard/schedule）、:317-350（fireDue）、:663-692（ticker）、:678-685（env 校验）；server/src/triggers/hook.service.ts:923-948（ensureGlobalPoll 全局单行模板）；server/src/tasks/task-progression.scheduler.ts:214-310（handler/guard/persist 幂等模板）、:740-793（postStallNoticeToTeamGroup system 条模板）、:800-870（triggerMemoryHarvest prompt+dispatchToMainAgent 频道解析）；server/src/chat/worker-dispatcher.ts:1646-1736（dispatchAgentMention 签名）、:711-746（接待人格/GROUP 触发指令注入点）、:2389-2427（teamMode 分支）、:1896-1908（resolveTeamChannel）；server/src/memories/memories.controller.ts（AdminGuard 端点模式）；server/src/memories/memory.constants.ts（tags 约定 howto|pitfall/constraint，见 worker-dispatcher.ts:273 与 web TYPE_TAGS）；docker-compose.yml:71-74（env 接线先例）；server/src/memories/memories.module.ts + server/src/timers/timers.module.ts（exports TriggerService）+ server/src/chat/chat.module.ts:42（import 先例）
  Acceptance criteria (agent-executable): `cd server && npm run test` 全绿；`npx tsc --noEmit` 通过（无循环依赖）；`POST /memories/maintain`（admin token）返回摘要并产生 system 条+dispatch（集成环境）；interval=0 时 `/triggers` 列表无 memory_maintenance 行
  QA scenarios (name the exact tool + invocation): happy——jest：handler 跑一轮断言 system 条落库+dispatch 被调+候选计数正确；failure——interval=0 断言不调度、冷却期二次触发被 guard 拒绝、internal 缺省回归断言接待人格仍在。Evidence .omo/evidence/task-9-memory-enhancement.txt
  Commit: Y | feat(memory): 定时记忆整理触发与派发

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit：逐条核对 Scope Must have / Must NOT have（重点：DELETE 仍=软删、PATCH 仍 AdminGuard、非 admin findAll OR 过滤存在、注入路径无 updateMany 计数、global 行 agent 侧 403、无服务端 LLM 调用、无定时硬删）
- [x] F2. Code quality review：`cd server && npm run test && npx tsc --noEmit` + `cd web && npm run build && npm run lint`；检查无 `as any`/`@ts-ignore`、空 catch、错误吞没（计数 catch 必须 logger.warn）
- [x] F3. Real manual QA：集成环境冒烟——会话页记忆子 tab 全操作闭环（列表/归档/恢复/硬删/refCount 徽标/非 admin 全局行只读）；`POST /memories/maintain` → 群聊出现灰色 system 条 + 主 Agent 被派发；管理页归档视图与 tab 双向同步失效；`GET /memories` 非 admin 跨团队不可见
- [x] F4. Scope fidelity：git diff 范围核对——未动 roles.constants 权限矩阵、未动任务状态机、未动 worker/、未引入新依赖（package.json 零 diff）

## Commit strategy
- 每个 todo 完成后单独 commit（约定式提交，scope=memory/web）：`feat(memory): <subject>` / `feat(web): <subject>` / `refactor(web): <subject>`；执行完成后如用户要求可 squash（AGENTS.md「同一需求不要新增 commit」优先，用 `git commit --amend` 合并后续小改）
- 提交前跑 `npx tsc --noEmit`（server）+ `npm run build`（web）确认无编译错误（本改动无 Java，无需 googleJavaFormat）
- 分支流程（AGENTS.md）：基于 xishuhq 远端默认分支 checkout 开发分支 → 推送 ketabot → PR 指向 xishuhq/develop（head=ketabot:<branch>）
- 迁移文件（server/prisma/migrations/<ts>_memory_refcount/migration.sql）随 Todo 1 的 commit 一并提交

## Success criteria
- **P1**：agent 每次 `vteam_memory_search` 命中后对应行 `refCount+1`、`lastUsedAt` 更新（计数失败不影响检索）；自动注入与检索结果按重要度排序，全新记忆不被饿死；管理页与 tab 展示「引用 N」
- **P2**：非 admin `GET /memories` 仅见 global+自己团队（跨团队不可见）；成员可归档/恢复/硬删本团队记忆，global 行写操作 403，编辑仍 admin；会话页团队 tab 下"记忆"子 tab 完成列表/归档/恢复/硬删闭环，管理页归档视图同步；恢复撞活跃重复被 409 拦截
- **P3**：`MEMORY_MAINTENANCE_INTERVAL_MS` 到期自动按团队派发整理（system 条留痕+主 Agent 执行），0=禁用；手动 `POST /memories/maintain` 可触发；Agent 经 `vteam_memory_merge` 合并时服务端保证 refCount 累加与 `mergedIntoId` 追溯，Agent 无法硬删、无法操作 global/role 记忆
- server 全部单测通过（含新增/扩展 spec 与迁移守卫），web build+lint 通过，既有 suites 无回归；F1-F4 全部 APPROVE
