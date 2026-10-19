# 实现方案：团队任务并行执行 + 右侧任务 Tab 改版

> 状态：已实现（2026-10-19：P1/P2/P3/P4 完成，server 测试 4318 全绿，web tsc/build/eslint 干净）
> 涉及：server（调度语义）、web（右侧面板/会话页）、prisma（迁移）、worker（不改）

## 1. 目标

1. **并行执行**：同一团队允许多个任务同时 `in_progress`，不再 FIFO 串行排队。
2. **任务 Tab 改版**：右侧「任务 → 状态」不再展示"团队队列"卡片，改为**任务列表**（列出团队全部非归档任务 + 状态徽标）；进行中的任务行复用顶栏"进行中"胶囊样式，点击可切换/查看详情。
3. **子 Tab 任务筛选**：计划 / 产出 / 触发目前绑定"聚焦任务"，多任务并行时支持**切换查看某个任务的**计划、产出、触发。

## 2. 现状关键事实（探索结论）

- 无任何消息队列中间件；串行完全由 in-DB 单槽实现：
  - `Team.currentTaskId`（`server/prisma/schema.prisma`，`TeamQueue` 表 + `@@index([teamId, position])`）。
  - **控制点 1** `createTaskInternal`（`server/src/tasks/tasks.service.ts:361-391`）：`isIdle = !team.currentTaskId`，忙则新任务 status=`queued` 并插入 `TeamQueue`（MAX(position) FOR UPDATE）。
  - **控制点 2** `transition('start')`（`tasks.service.ts:1685-1735`，start preflight `1037-1074`）：非队首抛 `TEAM_NOT_QUEUE_HEAD`（"仅队首任务可启动"）。
  - **控制点 3** `promoteNextInTx`（`tasks.service.ts:557-657`，在 accept/archive 后 afterCommit）：队首 queued→pending、删 TeamQueue 行、重排 position、广播 `team.queue.changed`；reject 不推进（`:1162-1165`）。
- 排队端点：`POST /teams/:id/queue`（仅 pending 可排队）、`DELETE /teams/:id/queue/:taskId`（仅 queued 可取消）→ `web/src/api/teams.ts:148-152`。
- 状态机：`TASK_STATUS`（queued/pending/in_progress/blocked/pending_review/completed/archived）+ `TASK_TRANSITIONS`（`server/src/common/constants/task.constants.ts:9-57`）；前端镜像 `web/src/types/task-status.ts`（queued=排队中，ACTION_SETS.queued=null）。
- worker 已天然并行：`WORKER_MAX_INSTANCES` 默认 5（`worker/src/config.ts:59-64`），容量调度 `maxInstances - load.instances`（`server/src/workers/workers.service.ts:457-467`）；会话按 (team, member) 复用（`uk_sessions_team_member`），"切任务不切群"。
- 前端：`TeamRightPanel.tsx`（3906 行）内 `TaskRightTabs`(:3739) → `TaskSubTabs`(:2547)，四个子 tab：状态(:2753，内嵌 `TeamQueueCard` :44-388) / 计划(:2891) / 产出(:3375) / 触发(:3697)。badge 基于聚焦任务的各查询计数。
- 会话页 `web/app/(main)/teams/[id]/session/page.tsx`：`effectivePanelTaskId`(:216-254) 缺省回退 `team.currentTaskId`；群聊发送 pinned `taskId=queueHeadTaskId`(:1054)；实例 enable/reset 全部指向队首(:1105-1166)；顶栏(:1343-1365) 渲染聚焦任务胶囊 + "等待队列 N 个"。
- SSE：`task.status.changed` 全局可透传（`web/hooks/use-sse.ts:74-76`），`team.queue.changed` 仅 team scope(:49)。

## 3. 设计决策（默认取值，可调整）

| # | 决策 | 采用方案 |
|---|------|---------|
| D1 | 并发上限 | `Team.maxConcurrentTasks INT NULL`，NULL=不限。start 时校验，超限返回 409 `TEAM_PARALLEL_LIMIT`（文案："并行任务数已达上限 N"）。团队设置页可改。 |
| D2 | `queued` 状态 | **退役**。数据迁移后不再产生 queued；`pending`="待开始" 即列表中的等待态。`TASK_STATUS`/`STATUS_LABEL` 中保留字面值（兼容历史数据读取），但所有创建/转移路径不再写入。 |
| D3 | `TeamQueue` 表与排队端点 | 代码路径删除；表保留（迁移只清数据），排队端点 `POST/DELETE /teams/:id/queue*` 移除（前端同仓同步删除调用）。 |
| D4 | `Team.currentTaskId` | 语义降级为"最后交互任务的指针"（用于面板缺省聚焦），**不再参与任何调度判定**。start 时若为空则指向该任务；任务完成后不清空（保持上次聚焦）。 |
| D5 | 群聊消息归属 | 会话仍 (team, member) 复用；群聊发送绑定的 `taskId` 从 `queueHeadTaskId` 改为**面板聚焦任务**（且须为活跃任务）。消息渲染时若带 taskId 显示任务标签（已有能力的沿用现状，不在本期扩展）。 |

## 4. 后端改造（server）

### 4.1 数据模型（`server/prisma/schema.prisma`）
- `Team` 增加 `maxConcurrentTasks Int?`。
- 新迁移 `xx_parallel_tasks`：
  ```sql
  UPDATE tasks SET status = 'pending' WHERE status = 'queued';
  UPDATE tasks SET queue_position = NULL WHERE queue_position IS NOT NULL;  -- 清残留，避免陈旧数据被误读
  DELETE FROM team_queues;           -- 表保留、数据清空
  -- currentTaskId 不动（保留为聚焦指针）
  ```
- `ALTER TABLE teams ADD COLUMN maxConcurrentTasks INT NULL;`
- 注意：迁移若用 prisma migrate 自定义 SQL，需与 `tasks.status` 无 Prisma enum 现状一致（本来就是 String）。

### 4.2 `server/src/common/constants/task.constants.ts`
- 新增错误码 `TEAM_PARALLEL_LIMIT`（附 `max` 字段）。
- `TASK_ERRORS.TEAM_NOT_QUEUE_HEAD` 标记弃用（保留导出避免编译错，注释注明不再抛出）。

### 4.3 `createTaskInternal`（`tasks.service.ts:223-555`）
- 去掉入队分支：新任务一律 `status=pending`、`queuePosition=null`。
- 保留行锁 + version CAS（并发创建安全仍需要），但锁的语义从"抢队首"变为"写入安全"。
- `currentTaskId` 不在此处设置（首任务是缺省聚焦可保留现有"空闲则指向新任务"的行为，即 `isIdle` 时 `currentTaskId=新task`，仅作指针用途）。
- 删除 `TeamQueue.create`(:474) 与 `TEAM_QUEUE_CHANGED` 广播(:526)，改为广播已有的 `task.status.changed`。

### 4.4 `transition('start')` 与 preflight（`tasks.service.ts:1037-1074, 1685-1735`）
- 删除队首门（`TEAM_NOT_QUEUE_HEAD` 分支、queued 校验）。
- start 前置校验改为：团队活跃数（`in_progress` + `blocked` 计入占用；**`pending_review` 不计入**——非执行态，此为明确的占用口径决策）≥ `maxConcurrentTasks` → 409 `TEAM_PARALLEL_LIMIT`（error body 带 `max`）。防超卖：事务内 `SELECT ... FOR UPDATE` 团队行 + count；**不支持行锁的引擎**（沿用 `isRowLockUnsupportedEngine` 降级纪律，见 todo 22/23/25）→ 退化为 `team.version` CAS（对齐 claim 路径 :1697-1705 的既有模式），CAS 冲突 → 409 重试 3 次后失败。
- start 成功时：若 `team.currentTaskId` 为空 → 指向本任务（聚焦指针兜底）。
- reject 语义自动正确（任务回 in_progress，无队列推进概念）。

### 4.5 `promoteNextInTx` / `promoteNext`（`tasks.service.ts:557-657, 1149, 1209`）
- accept/archive 后不再推进队列：函数删除，替换为广播 `team.changed`（顶栏队列计数等旧 UI 依赖移除后无需专用事件）。

### 4.6 排队端点（`server/src/teams/teams.service.ts:1192-1344`，controller 对应路由）
- 删除 `enqueueQueue` / `cancelQueue` 及路由；团队 DTO 删除 `queue[]` 字段（`findMany` 的 include 调整，:267-272, 298-302，DTO 映射 :1573-1574），新增 `activeTaskCount` 便于前端校验展示。

### 4.7 任务列表查询
- `GET /tasks?teamId=` 已分页可用；排序优化：`in_progress/blocked/pending_review/pending` 在前（各自按最近时间倒序），`completed/archived` 靠后（摘要排序在前端亦可做，优先前端排序避免 SQL 复杂化）。

## 5. 前端改造（web）

### 5.1 状态子 Tab 改版（`TeamRightPanel.tsx`）
- **删除** `TeamQueueCard`(:44-388) 在状态 tab 的引用(:2888)；FIFO 说明、取消按钮、"当前执行中（队首）"一并移除。
- **新增 `TeamTaskListCard`**：
  - 数据源：`useQuery(["team-tasks", teamId, "panel"])` → `GET /tasks?teamId=&limit=50`（非归档 + 最近归档少量，与 tasks/page.tsx 复用同一 query key 便于共享缓存）。
  - 行结构：`[状态徽标] 标题 …（创建时间/负责人）`；`data-testid="team-task-item"`。
  - **进行中的行**：样式复用顶栏"进行中"胶囊（teal 描边+点状呼吸），点击打开 `TaskDetailDrawer`；`pending_review` 行内联"验收通过/驳回"快捷按钮（沿用现有 mutation）；`pending` 行内联"开始"按钮（`POST /tasks/:id/start`，超限时 toast 显示上限文案）。
  - **选中态**：当前聚焦任务行高亮 + 对勾。
  - 订阅 `task.status.changed`（team scope）→ invalidate 任务列表 query；30s 轮询保留为兜底。
- 状态 tab 布局：上方现有任务详情大卡（跟随聚焦任务）→ 下方任务列表。

### 5.2 子 Tab 任务筛选（计划/产出/触发）
- `TaskSubTabs` 内共享同一"聚焦任务"来源（已有的 `panelTaskId`），列表点击即切换（复用会话页 `?task=` 参数机制）。
- 另在计划/产出/触发三个子 tab 头部右侧增加**紧凑任务下拉**（仅列出活跃任务 + 最近完成），在不出子 tab 的情况下快速换绑：改的是同一个 `panelTaskId` 状态 → 所有子 tab 同步。
- badge（计划 2/产出 29/触发 1）继续按聚焦任务计数；下拉切换时各 query key（`["task", taskId, ...]`）自动重取，已有的 `planDocsQuery/planStepsQuery/artifactsQuery/triggersQueryKey` 无需改逻辑，只改 taskId 来源与 loading 骨架。

### 5.3 会话页 `?task=` 参数与 `currentTaskId` 兜底
- 改造 `page.tsx:216-254`：缺省 task 优先级改为"聚焦任务指针 ≥ 最近进行中 ≥ 最近待验收 ≥ 最近待开始 ≥ null"（避免依赖 `currentTaskId` 调度语义）。
- `use-sse.ts`：`team.queue.changed` 白名单项移除。
- `web/src/api/teams.ts`：删除 `enqueue/cancelQueue`；`TeamDto.queue` 字段移除（同步改打印处）。
- `types/task-status.ts`：`STATUS_LABEL.queued` 保留（历史态），`ACTION_SETS.queued` 保留 null。

### 5.4 顶栏（`page.tsx:1343-1365`）
- 团队名右侧：全部 `in_progress/blocked` 任务渲染为胶囊组（进行中样式），超出 2 个折叠为 "+N"，点击展开列表（即聚焦任务下拉）。
- "等待队列 N 个"文案改为"进行中 N · 待开始 M"。

## 6. worker

- 无代码改动（`maxInstances` 已支持并行会话）。文档提醒：并行任务数受 worker 容量约束，`TEAM_PARALLEL_LIMIT` 上限应 ≤ 各 worker `maxInstances` 之和的合理估计（文档说明，不硬编码联动）。

## 7. 事件与 SSE 清理

- 退役：`team.queue.changed`（server 不再广播、前端移除白名单与消费点）。
- 保留/依赖：`task.status.changed`（任务列表刷新主力）、`team.changed`（顶栏活跃计数）。

## 8. 测试

- 存量测试改造：`tasks.service.spec.ts` 中断言队列语义的用例需同步更新/删除（`TEAM_QUEUE_CHANGED` 相关断言在 :615, :713, :4417, :4504, :4665, :5146）；web 侧检查是否有断言 `TeamQueueCard`/"等待队列" 文本的测试。
- server 契约测试（追加新用例）：
  1. 两个 pending 任务连续 start → 均 in_progress；
  2. 设置 `maxConcurrentTasks=1` → 第二个 start 409 `TEAM_PARALLEL_LIMIT`；
  3. reject 后任务仍 in_progress 可继续操作（无队列推进）；
  4. accept/archive 后无 `team.queue.changed` 事件、无 promoteNext 副作用；
  5. 创建任务不再产生 queued / TeamQueue 行。
- 迁移脚本验证：存量 queued → pending。
- web：任务列表渲染/选中切换/筛选下拉/sse 刷新；手工 e2e 走查会话页顶栏、群聊发送绑定聚焦任务。

## 9. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 后端并行 | D1-D5 schema/迁移/+ 常量/createTask/transition/promote 清理 + 单测 | 同团队两任务可同时 in_progress；测试全绿 |
| P2 任务列表 Tab | TeamTaskListCard 替换 TeamQueueCard + SSE/轮询/快捷操作 | 列表展示全任务与状态；进行中样式与顶栏一致 |
| P3 筛选与会话页 | 子 tab 任务下拉、`?task=` 兜底顺序、api/types 清理、顶栏胶囊组 | 多任务并行下计划/产出/触发可切换查看 |
| P4 收尾 | 排队端点/DTO/`team.queue.changed` 全量移除、e2e 走查 | 无队列残留 UI 与接口 |

## 10. 风险与开放问题

1. **依赖队首语义的隐性逻辑**：会话页实例 enable/reset(:1105-1166)、群聊 pinned taskId(:1054) 需逐点改为聚焦任务；遗漏点会表现为"操作打到错误任务上"。缓解：全局 grep `currentTaskId/queueHeadTaskId` 收敛评审（P4 清单）。
2. **历史 queued 数据**：已迁移 pending，"排队取消"的用户习惯由任务列表的"开始"按钮替代。
3. **worker 容量**：并行上限与 worker 池容量解耦，极端情况任务 start 后排队等 worker 会话（已有 worker 排队逻辑，属既有行为）。
4. **`blocked` 占用并发槽**：设了上限的团队中，长期 blocked 任务会一直占槽；运营出口为 resume/archive（运营侧须知）。
5. **灰度/多实例发布**：若新旧 server 实例并存滚动发布，旧实例仍可能写入 team_queues——本仓库为单实例部署则无此问题，如有滚动发布计划需先全量停排队端点再跑迁移。
6. **待确认**：`maxConcurrentTasks` 默认值（建议 NULL=不限）与团队设置页是否本期加入设置入口（建议：本期先支持 API/DB 设置，UI 入口可后续补充）。
