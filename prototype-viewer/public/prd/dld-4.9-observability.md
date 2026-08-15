<!-- 详细设计：在 hld-4.9 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.9 可观测性 — 详细设计

## 1. 模块范围

本模块把 Agent 执行黑盒打开：任务 Trace（FR-901）、任务日志检索（FR-902）、Token/成本统计（FR-903）、Prometheus/OTEL 导出（FR-904）、审计检索（FR-905，写入侧在 4.1）。实现上 Trace/日志走独立表（高频），SSE 事件异步批量落库（ADR-001 双轨，观测不阻塞编排）；成本单价配置在 ModelEndpoint，聚合 SQL 单点实现；指标用 prom-client。本文档给出 `task_trace_events`/`task_logs` 表 DDL、批量写入队列、Trace 树查询、成本聚合与指标注册的实现设计。需求基线 req-4.9（FR-901~905）。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `task_trace_events` | Trace 树状 span（高频） | 独立表 |
| `task_logs` | 任务结构化日志（全文，独立保留期） | 独立表 |
| `cost_daily` | Token/成本日聚合（M2 物化视图） | 独立表 |

### 2.2 表结构

**`task_trace_events`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| trace_id | uuid | not null | 任务根 trace |
| task_id | uuid | not null references tasks(id) | |
| step_id | text | not null | 步骤 id（事件源） |
| parent_step_id | text | | 父步骤（树形）；空=根 |
| type | text | not null | model/tool/approval/error/step/subflow |
| name | text | not null | 步骤名（模型/tool 名） |
| agent | text | | 产生 Agent |
| start_time | timestamptz | not null | |
| end_time | timestamptz | | |
| duration_ms | int | | |
| status | text | not null | ok/error/skipped |
| tokens_input | int | not null default 0 | |
| tokens_output | int | not null default 0 | |
| detail | jsonb | | `{model, tool, error:{code,retryable}, approval_ref, ...}` |
| event_seq | bigint | not null | 事件序号（乱序对齐/断点续读） |
| created_at | timestamptz | not null default now() | |

索引：`(task_id, start_time)`（时间线）、`(trace_id)`、`(step_id)` unique、`(task_id, parent_step_id)`（建树）。**保留期默认 30 天**（可配），按分区清理。

**`task_logs`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigserial | PK | |
| task_id | uuid | not null | |
| node_id | text | | 产生节点 |
| step_id | text | | 关联 trace 步骤 |
| level | text | not null | info/warn/error/debug |
| message | text | not null | 已脱敏 |
| ts | timestamptz | not null default now() | |
| trace_id | uuid | | 关联 Trace |

索引：`(task_id, ts)`、`(task_id, node_id)`。**保留期 90 天**（可配）。

**`cost_daily`（M2 物化）**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| day | date | PK 组合 | 统计日 |
| namespace | text | PK 组合 | |
| task_id | uuid | PK 组合 | |
| agent | text | PK 组合 | |
| tokens_input | bigint | not null default 0 | |
| tokens_output | bigint | not null default 0 | |
| cost | numeric(12,4) | | 按 ModelEndpoint pricing 换算 |
| updated_at | timestamptz | not null default now() | |

### 2.3 枚举/常量

```ts
// src/observability/trace.ts
export const TRACE_EVENT_TYPE = ['model','tool','approval','error','step','subflow'] as const;
export const TRACE_STATUS = ['ok','error','skipped'] as const;
export const TRACE_RETENTION_DAYS = 30;
export const LOG_RETENTION_DAYS = 90;
export const TRACE_SUMMARY_TRUNCATE = 1024;    // 输入输出摘要截断（1KB）
export const BATCH_SIZE = 200;
export const BATCH_WINDOW_MS = 1000;
```

## 3. 实现设计

### 3.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/observability/trace.ts` | Trace 模型、写入队列、批量落库、树查询 API |
| `src/observability/logs.ts` | task_logs 写入（脱敏）、检索 |
| `src/observability/cost.ts` | Token 聚合、单价换算、命名空间成本（M2） |
| `src/observability/metrics.ts` | prom-client 指标注册与 /metrics |
| `src/observability/otel.ts` | OTEL 导出（M2，默认关） |
| `src/observability/audit.ts` | 审计写入 SDK（供 4.1 及各模块） |
| `src/observability/redact.ts` | 统一脱敏规则 |

### 3.2 核心类型与 Schema（zod）

```ts
// src/observability/trace.ts
export interface TraceEvent {
  traceId: string; taskId: string;
  stepId: string; parentStepId?: string;
  type: TraceEventType; name: string;
  agent?: string;
  startTime: string; endTime?: string; durationMs?: number;
  status: TraceStatus;
  tokensInput: number; tokensOutput: number;
  detail: Record<string, unknown>;
  eventSeq: number;
}
export async function writeTraceBatch(events: TraceEvent[]): Promise<void>;   // 批量 insert
export async function getTraceTree(taskId: string): Promise<TraceNode[]>;
  // 按 task_id 读取 → parent_step_id 建树 → 时间线排序
// src/observability/redact.ts
export function redact(obj: unknown, depth = 4): unknown;
  // 键匹配 /secret|token|password|api[_-]?key|authorization/i → 掩码 "••••"
```

**Trace / 日志查询 API**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/tasks/{name}/trace?type=&node=` | Trace 树（类型筛选，时间线） |
| GET | `/api/v1/tasks/{name}/logs?node=&ts=&level=` | 日志检索（分页/虚拟滚动） |
| GET | `/api/v1/tasks/{name}/cost` | 单任务 Token/成本（M2 起含金额） |
| GET | `/api/v1/namespaces/{name}/cost?period=day\|week\|month` | 命名空间成本汇总（M2） |
| GET | `/metrics` | Prometheus 指标（独立端口） |
| GET | `/api/v1/audit-logs` | 审计检索（FR-905，与 4.1 共用） |

### 3.3 核心函数/服务

```ts
// src/observability/metrics.ts
export function initMetrics(): Registry;
  // 指标集：task_phase_total{namespace,phase}、task_duration_seconds（直方图）、
  //         queue_depth、approval_expired_total、token_rate_per_second、
  //         runtime_instance_status{instance}、notification_delivery_failed_total
export function incTaskPhase(ns, phase, delta=1): void;
export function observeTaskDuration(seconds, labels): void;
// src/observability/cost.ts (M2)
export async function aggregateCost(taskId): Promise<{tokensInput,tokensOutput,cost}>;
  // SUM(tokens) + ModelEndpoint.pricing 换算；GROUP BY task/agent/ns + day/week/month
// src/observability/audit.ts
export async function writeAudit(entry): Promise<void>;     // 追加写，redact(diff) 后落库
export async function searchAudit(filters, page): Promise<Page<AuditRow>>;
```

### 3.4 指标注册清单（FR-904）

| 指标 | 类型 | labels | 说明 |
|---|---|---|---|
| `task_phase_total` | Counter | namespace, phase | 任务状态计数（成功/失败/等待审批/取消） |
| `task_duration_seconds` | Histogram | namespace, phase | 执行耗时直方图（桶：1/5/30/300/1800s） |
| `queue_depth` | Gauge | | Pending 队列深度 |
| `approval_expired_total` | Counter | namespace | 审批 TTL 到期数 |
| `token_rate_per_second` | Gauge | namespace | Token 消耗速率（input/output 分） |
| `runtime_instance_status` | Gauge | instance | 0/1（serve 健康状态，来自 4.7） |
| `notification_delivery_failed_total` | Counter | channel | 通知投递失败累计（来自 4.10） |

暴露方式：`/metrics` 独立端口（不鉴权，Prometheus 抓取）；OTEL 导出默认关、采样率可配（M2）。

### 3.5 关键流程实现

**事件 → Trace 落库（异步批量，不阻塞执行路径）**：

```
4.7 SSE 事件 → parser 产出 PlatformStepEvent
→ observability 入队（内存 channel）
→ 后台批量落库：积满 200 条 或 1s 窗口 → writeTraceBatch（单事务）
→ 每批同时：更新 Prometheus token 速率 / 步骤计数
→ 任务终态：aggregateCost(taskId)（M2）→ cost_daily 物化
```

**成本聚合 SQL（M2，口径单点）**：

```sql
-- 任务级 Token 汇总
SELECT task_id, SUM(tokens_input) AS in_total, SUM(tokens_output) AS out_total
FROM task_trace_events
WHERE task_id = $1 AND type IN ('model','tool')
GROUP BY task_id;

-- 成本换算：由 ModelEndpoint.pricing 在应用层完成
-- cost = in_total/1e6 * inputPerMtok + out_total/1e6 * outputPerMtok

-- 命名空间日聚合（物化到 cost_daily）
INSERT INTO cost_daily (day, namespace, task_id, agent, tokens_input, tokens_output, cost)
SELECT date_trunc('day', created_at)::date, t.namespace, e.task_id, e.agent,
       SUM(e.tokens_input), SUM(e.tokens_output), SUM(...)
FROM task_trace_events e JOIN tasks t ON t.id = e.task_id
WHERE e.created_at >= now() - interval '1 day'
GROUP BY 1, 2, 3, 4
ON CONFLICT (day, namespace, task_id, agent) DO UPDATE SET ...;
```

**Trace 树查询**：

```ts
export async function getTraceTree(taskId) {
  const rows = await db.select().from(taskTraceEvents)
    .where(eq(taskTraceEvents.taskId, taskId))
    .orderBy(taskTraceEvents.eventSeq);
  // 以 parent_step_id 构建 children map；缺失父节点 → 挂到根（任务顺序兜底，不阻断）
  return buildTree(rows);
}
```

**日志脱敏**：

```
Agent 输出/工具请求响应 → 过 redact()（与审计共用规则）→ 写入 task_logs
检索接口按 (taskId, nodeId?, ts?) 过滤 + 分页（前端虚拟滚动）
```

**审计检索 API（FR-905）**：```
GET /api/v1/audit-logs?actor=&action=&resourceKind=&ns=&from=&to=&keyword=&page=
  → 过滤：actor 精确 / action 枚举 / resource->>'kind' / 时间范围
  → keyword 对 diff/comment 做 ILIKE（审批决策全文可检索）
  → 结果分页 + 导出（CSV，M2）；接口只读（4.1 追加写约束）
  → 审批决策检索用例：action IN (approve,reject,request-changes) → 返回决策人/意见/关联 task_id → 跳转任务 Trace
```

**OTEL 导出（M2，默认关）**：

```
全局设置 otel.enabled=false、otel.endpoint、otel.sampleRate=0.01
enabled 时：@opentelemetry/sdk-node 注册资源属性（service.name=orchestra）
  → 导出编排控制链路（REST 请求/Task 状态机/审批决策），不导出 Agent 推理（NFR-05）
  → 采样基于 traceId 哈希，跨服务（server/worker）共享同一 traceId
```

### 3.6 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| Trace 批量写入失败 | 入队重试（指数退避），队列满则丢弃并计数告警（观测尽力而为，不阻断执行） |
| 事件乱序/丢失 | event_seq 对齐；缺失时任务顺序兜底建树 |
| Token 单价缺失 | 成本换算跳过（记 0），不阻断；与明细对账提示补配 |
| 日志含凭证 | redact() 写库前强制，界面只显示掩码 |
| 数据膨胀 | 三级保留期 + 分区清理（Trace 30 天/日志 90 天/审计长期） |
| OTEL 导出影响性能 | 默认关闭，采样率可配（全局设置） |

### 3.7 测试要点

- 单元：redact 覆盖 secret/token/password/apiKey 键；批量队列双阈值（200 条/1s）触发落库；getTraceTree 建树（含孤儿节点兜底）。
- 集成：一次任务执行后模型/工具/耗时/错误/Token 按时间线完整回放；日志按节点与时间范围检索且凭证脱敏；命名空间 Token 汇总与明细一致；/metrics 暴露任务计数与耗时指标；审计检索定位审批决策全文并可跳转任务 Trace。
