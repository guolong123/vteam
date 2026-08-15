<!-- 详细设计：在 hld-4.5 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.5 任务执行与触发 — 详细设计

## 1. 模块范围

本模块是触发、执行、重试、并发控制的汇聚点：Task 八态生命周期状态机（FR-501/504）、四种触发方式（手动/定时/Webhook/IM，FR-501~503）、重试退避与错误分类（FR-505）、Worker 租约与分布式接管（FR-506）、并发队列与限流（FR-507）。本文档给出 `tasks`/`task_messages` 表 DDL、幂等三键设计、租约行级锁认领、内存队列抽象（M2 换 NATS）、TaskSchedule/TaskWebhook 触发器资源的实现设计。需求基线 req-4.5（FR-501~507），IM 触发（FR-1004）为 M3。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `tasks` | 任务实例（八态状态机） | 独立表 |
| `task_messages` | 节点间消息/分支状态（并行分支、幂等消息） | 独立表 |
| `resources(type='task-schedule')` | 定时触发器 | 通用资源表 |
| `resources(type='task-webhook')` | Webhook 触发器 | 通用资源表 |

### 2.2 表结构

**`tasks`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| namespace | text | not null | |
| name | text | not null | 任务名（命名空间内唯一） |
| flow_ref | text | not null | `{name, version}` 快照引用 |
| trigger | jsonb | not null | `{type: manual\|schedule\|webhook\|im, source?, eventId?}` |
| input | jsonb | not null default '{}' | 参数化输入（创建时校验 inputSchema） |
| phase | text | not null | Pending/Running/Paused/WaitingApproval/Succeeded/Failed/Cancelled/Expired |
| current_node | text | | 当前流程节点 id |
| blocked_on | jsonb | | `{approvalRef}` 挂起审批引用（4.6） |
| worker_id | text | | 租约持有者 |
| worker_lease_expires_at | timestamptz | | 租约过期时间（TTL 60s，心跳续约） |
| session_id | text | | opencode 会话 id（4.7） |
| workdir | text | | 任务工作区路径（4.7） |
| event_cursor | bigint | default 0 | 已消费 SSE 事件序号（断点续读） |
| outputs | jsonb | not null default '{}' | 按节点累积产物 |
| idempotency_key | text | **unique** | 幂等键（webhook/schedule/IM 去重） |
| retry_policy | jsonb | | `{maxRetries, backoff, baseDelaySeconds, retryableErrors[], nonRetryableErrors[]}` |
| retry_count | int | not null default 0 | |
| next_retry_at | timestamptz | | 退避等待后重新入队时间 |
| last_error | jsonb | | `{code, message, retryable}` |
| env_check | jsonb | | 环境预检结果（ADR-014） |
| created_by | text | | 发起人（审计） |
| created_at | timestamptz | not null default now() | |
| updated_at | timestamptz | not null default now() | |

索引：`(namespace, phase)`、`(phase, worker_lease_expires_at)`（认领查询）、`(idempotency_key)` unique、`(created_at desc)`。**唯一约束 `(namespace, name)`**。

**`task_messages`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| task_id | uuid | not null references tasks(id) | |
| node_id | text | | 产生节点 |
| branch_id | text | | 并行分支标识（M2 fan-out） |
| trace_id | uuid | | 关联 Trace |
| payload | jsonb | not null | 消息内容（Agent 间传递） |
| idempotency_key | text | **unique** | 消息幂等（重复投递去重） |
| created_at | timestamptz | not null default now() | |

### 2.3 触发器资源

**`resources.spec (type='task-schedule')`**：

```jsonc
{
  "cron": "0 9 * * *", "timezone": "Asia/Shanghai",
  "flowRef": { "name": "software-company-dev", "version": 3 },
  "inputTemplate": { "issueNumber": "{{date.YYYYMMDD}}" },
  "concurrency": 1, "enabled": true,
  "missedPolicy": "skip"                 // skip | catchup
}
// status: { "phase": "Active|Disabled", "lastRunAt": "...", "nextRunAt": "..." }
```

**`resources.spec (type='task-webhook')`**：

```jsonc
{
  "path": "github-issue",                 // POST /api/v1/webhooks/{name}/trigger（name = task-webhook 资源名）
  "flowRef": { "name": "dev-flow", "version": 3 },
  "inputTemplate": { "issueNumber": "{{event.number}}" },  // 从事件体提取
  "signatureSecretRef": "gh-hook-secret",  // HMAC 校验（4.1 Secret）
  "idempotency": { "keyFrom": "header:X-GitHub-Delivery" } // 幂等键来源
}
// status: { "phase": "Active|Disabled", "lastRunAt": "..." }
```

### 2.4 枚举/常量

```ts
// src/controllers/task.ts
export const TASK_PHASE = ['Pending','Running','Paused','WaitingApproval',
  'Succeeded','Failed','Cancelled','Expired'] as const;
export const TRIGGER_TYPE = ['manual','schedule','webhook','im'] as const;
export const RETRYABLE_ERRORS = ['timeout','rate-limit','worker-leased-expired','transient-io','serve-unavailable'];
export const NON_RETRYABLE_ERRORS = ['invalid-input','permission-denied','approval-rejected','validation-error'];
export const LEASE_TTL_MS = 60_000;
```

## 3. 实现设计

### 3.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/controllers/task.ts` | Task 状态机（显式转移表）、生命周期操作（pause/resume/cancel/rerun） |
| `src/controllers/task-trigger.ts` | 手动/Webhook/IM 创建入口，幂等键构造与去重 |
| `src/trigger/schedule.ts` | node-cron 调度器：TaskSchedule 扫描、生成任务、missedPolicy |
| `src/trigger/webhook.ts` | Webhook 接收、HMAC 签名校验、幂等去重、inputTemplate 渲染 |
| `src/queue/index.ts` | `Queue` 接口（Enqueue/Claim/Ack/Nack） |
| `src/queue/memory.ts` | 内存实现（channel + worker pool） |
| `src/queue/nats.ts` | NATS JetStream 实现（M2） |
| `src/executor/worker.ts` | worker 循环：认领（租约）→ 执行（4.7）→ 上报状态 |
| `src/store/task.ts` | tasks/task_messages 读写与事务 |

### 3.2 核心类型与 Schema（zod）

```ts
// src/store/task.ts
export interface TaskRecord {
  id: string; namespace: string; name: string;
  flowRef: { name: string; version: number };
  trigger: { type: TriggerType; source?: string; eventId?: string };
  input: Record<string, unknown>;
  phase: TaskPhase; currentNode?: string;
  workerId?: string; workerLeaseExpiresAt?: string;
  sessionId?: string; workdir?: string; eventCursor: number;
  outputs: Record<string, unknown>;
  idempotencyKey?: string;
  retryPolicy: RetryPolicy; retryCount: number; nextRetryAt?: string;
  lastError?: { code: string; message: string; retryable: boolean };
}
export async function createTask(rec, opts?: { idempotencyKey }): Promise<{ task, created: boolean }>;
  // idempotencyKey 唯一冲突 → 返回已存在任务（created=false），不抛错
```

### 3.3 核心函数/服务

```ts
// src/queue/index.ts
export interface Queue<T> {
  enqueue(item: T): Promise<void>;
  claim(timeoutMs: number): Promise<T | null>;   // 阻塞取任务
  ack(id: string): Promise<void>;
  nack(id: string, delayMs: number): Promise<void>;
}

// src/executor/worker.ts
export async function runWorkerLoop(): Promise<never>;
  // claim → 租约认领 → executeTask(task)（4.7 驱动）→ ack；失败 nack(delay)
// src/controllers/task.ts
export async function transition(task, to: TaskPhase, ctx): Promise<void>;  // 显式转移表校验
export async function pauseTask(ns, name, mode: 'graceful'|'force'): Promise<void>;
export async function cancelTask(ns, name, mode: 'graceful'|'abort'): Promise<void>;
export async function rerunTask(ns, name): Promise<TaskRecord>;   // 新实例，继承 input+flow_version
export function buildIdempotencyKey(trigger): string;   // webhook: `${source}:${eventId}` / schedule: `${ref}:${plannedAt}` / im: `wecom:${msgId}`
```

#### pause graceful/force 语义（M2-3，ADR 见 notepad）

`pauseTask(ns, name, mode: 'graceful'|'force')` 仅对 `Running` / `Pending` 有效（`WaitingApproval` 挂起中不可 pause → 409，先决审批或取消）：

- **graceful**：等当前 opencode 节点执行完成 → 用 `resume_context` 保存节点状态（flowRef/nodeId/nodeIndex/input/outputsSnapshot/sessionId/workdir，复用 dld-4.6 §2.2 结构）→ `Task=Paused`。执行中**不再接受新节点**（executor 节点推进前检查 pauseRequested 标志，命中即暂停，不 step 下一节点）。
- **force**：立即中断（abort opencode session，SDK prompt 终止）→ 同样构建 `resume_context` 快照当前节点 → `Task=Paused`。恢复时用 `resume_context` **重跑当前节点**（节点未完成）。
- **租约释放**：两种模式 pause 生效时均释放 worker lease（`worker_id=NULL, worker_lease_expires_at=NULL`），worker 心跳停止。
- **watchdog 排除**：watchdog/租约过期扫描只重置 `phase='Running'` 的过期任务（watchdog.sql `WHERE phase='Running'`），**不得触碰 Paused**——Paused 任务即使 resume_context 未完成也保持静止，直到 resume/cancel。
- **审批交互**：pause 期间已有审批记录（TaskApproval/ToolApproval）**保留不删**，phase/round/TTL 原样；resume 后审批记录继续有效（TTL 按原策略续跑）。
- **resume**：`POST /tasks/{name}/resume` → `Paused → Running` + 重新入队 → executor 从 `resume_context` 恢复（graceful 从已完节点之后继续；force 重跑当前节点）。

### 3.4 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/tasks` | 列表（状态/命名空间筛选）/ 手动创建（flowRef+input） |
| GET | `/api/v1/tasks/{name}` | 详情（含 trace 摘要/环境预检状态） |
| POST | `/api/v1/tasks/{name}/cancel` · `/retry` · `/pause` · `/resume` | 生命周期操作（4.1 治理层承接权限） |
| GET/POST | `/api/v1/task-schedules` · `/{name}` | 定时触发器 CRUD（cron 校验） |
| GET/POST | `/api/v1/task-webhooks` · `/{name}` | Webhook 触发器 CRUD |
| POST | `/api/v1/webhooks/{name}/trigger` | Webhook 触发入口（签名校验 + 幂等） |

**队列抽象（Queue）**：

```ts
export interface Queue<T> { enqueue / claim / ack / nack }
// memory 实现：内嵌单进程（channel + worker pool，并发数可配）
// nats 实现（M2）：JetStream 主题 per namespace，consumer 拉取 + ack
// 切换不动机器逻辑（4.5 只依赖 Queue 接口）
```

### 3.5 关键流程实现

**租约原子认领**（PoC P4 验证）：

```sql
-- 单条 UPDATE，靠条件 + 行级锁保证并发正确
UPDATE tasks SET worker_id = $1, worker_lease_expires_at = now() + interval '60 seconds',
       phase = 'Running'
WHERE id = $2 AND phase = 'Pending'
  AND (worker_id IS NULL OR worker_lease_expires_at < now())
RETURNING id;
-- 命中 0 行 → 已被他人认领；心跳续约：UPDATE ... SET lease = now()+60s WHERE id=$1 AND worker_id=$2
```

**Webhook 触发（幂等去重）**：

```
POST /api/v1/webhooks/{name}/trigger
  → 校验签名（HMAC-SHA256，body + secret；失败 401 + 审计）
  → 构造幂等键：buildIdempotencyKey({type:'webhook', source, eventId})
  → createTask(...{idempotencyKey})；created=false → 返回 200（已受理，不重复执行）
  → 渲染 inputTemplate（从事件体提取）→ 入队（Pending）
```

**状态机显式转移表**：

```ts
const TRANSITIONS: Record<TaskPhase, TaskPhase[]> = {
  Pending: ['Running', 'Cancelled', 'Expired'],
  Running: ['Pending','Paused','WaitingApproval','Succeeded','Failed','Cancelled'],
  Paused: ['Running','Cancelled'],
  WaitingApproval: ['Running','Failed','Expired'],
  Succeeded: [], Failed: [], Cancelled: [], Expired: [],
};
```

**执行失败重试决策**：

```
execute 抛 AppError
  → retryable = error.retryable && retryPolicy.retryableErrors.includes(code)
  → 非可重试（含 approval-rejected）→ transition Failed，保留 lastError
  → 可重试 && retryCount < maxRetries → 计算 delay（fixed/exponential，指数封顶 5min）
      → retryCount+1, nextRetryAt=now+delay → 重新入队（Pending）
  → 重试耗尽 → Failed（lastError.retryable=false）
```

**cron 调度器实现（FR-502）**：

```
node-cron 每分钟 tick → 扫描 resources(type='task-schedule', enabled=true)
  → 计算 nextRunAt（cron 表达式 + timezone）匹配当前分钟
  → 匹配 → 构造幂等键 `schedule:${name}:${plannedAt}` → createTask
  → missedPolicy: skip（默认，错过不补）| catchup（补跑最近一次）
  → 更新 status.lastRunAt/nextRunAt；调度周期与计划时间为天然幂等键（NFR-04）
  → 并发控制：schedule.spec.concurrency 限制同周期并发任务数（超限排队）
```

**Webhook 签名校验（FR-503）**：

```
POST /api/v1/webhooks/{name}/trigger
  → 校验 signatureSecretRef 存在（未配置 → 404，防未授权注册）
  → HMAC-SHA256(body, secret) 与 X-Orchestra-Signature 比对（timingSafeEqual）
  → 校验失败 → 401 + 审计(action=exec, result=denied)
  → 通过 → 构造幂等键 → createTask（重复 → 200 已受理）
```

### 3.6 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| Webhook 重复投递 | 幂等键 unique 冲突 → 返回 200 不创建（NFR-04） |
| Worker 崩溃任务悬挂 | 租约 60s 过期 → 其他 Worker 接管，从 checkpoint（session_id/event_cursor）恢复 |
| 租约续约竞态 | 续约 UPDATE 带 worker_id 条件，失败视为失联 |
| 审批驳回 | `approval-rejected` 归非可重试，不自动重试（不绕过人工决策） |
| 任务风暴 | 命名空间并发上限 + 全局队列深度两级限流，超出入 Pending 排队 |
| serve 不可达 | `serve-unavailable` 可重试，任务回 Pending 等待 |
| spec 不可变 | 任务创建后仅更新 status/lease 等运行字段（审计友好） |

### 3.7 测试要点

- 单元：状态机转移表非法转移拒绝；`buildIdempotencyKey` 三源格式；指数退避计算封顶；重试分类（retryable/nonRetryable）。
- 集成：相同 GitHub 事件重复投递只产生一个任务；定时一个周期不重复；可重试错误自动重试并呈指数退避；worker 心跳停止后租约过期被接管并记录接管事件；暂停/恢复/取消/重跑全链路（重跑生成新实例、原记录保留）。
