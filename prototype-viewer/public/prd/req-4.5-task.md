<!-- 子文档：对应主 PRD 4.5 章节，由 docs/requirements.md 拆分扩展 -->

# 4.5 任务执行与触发（需求设计说明）

## 模块概述

Task 是 Flow 的一次运行实例，是触发、执行、重试、并发控制的汇聚点。本模块解决"任务从哪来、怎么执行、异常怎么处理"的问题：手动、定时、Webhook、IM 四种触发方式把外部事件转化为任务；输入参数化定义任务的可变性；重试策略、Worker 租约、并发队列保障执行可靠性。

本模块与 4.4 Flow（Task 由流程版本实例化）、4.7 运行时（Task 驱动 opencode 会话执行）、4.9 可观测（Task trace 记录执行过程）、4.10 通知（任务状态变更触发通知）直接联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-501 | 支持**手动触发**：通过控制台 / API / CLI 创建 Task | P0 |
| FR-502 | 支持**定时触发**：cron 表达式创建 TaskSchedule，按计划生成任务 | P0 |
| FR-503 | 支持 **Webhook 触发**：签名校验的 HTTP 事件生成任务（如 GitHub issue 事件），要求幂等去重（同一事件不重复执行） | P0 |
| FR-504 | 任务支持输入参数化（`input`）与输出定义 | P0 |
| FR-505 | 支持任务级重试策略：最大次数、退避（backoff）、可重试错误分类（非可重试错误直接失败） | P0 |
| FR-506 | 支持 Worker 分布式执行：任务按需求（region / GPU / 模型）分配给 worker，worker 通过租约（lease）+ 心跳声明归属，租约过期可被接管 | P1 |
| FR-507 | 支持任务的并发控制与队列（排队、限流） | P1 |

## 详细设计说明

### 任务资源与输入输出（FR-504）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Task
metadata:
  name: task-20260803-0001
  namespace: dev-team
spec:
  flowRef:
    name: software-company-dev
    version: 3                      # 版本快照，运行时以该版本执行
  trigger:                          # 触发来源
    type: webhook
    source: github
    eventId: "issue-42"
  input:                            # 参数化输入
    issueNumber: 42
    repo: xishuhq/orchestra
  retryPolicy:                      # FR-505
    maxRetries: 3
    backoff: exponential            # fixed | exponential
    baseDelaySeconds: 10
    retryableErrors: [timeout, rate-limit, worker-leased-expired]
    nonRetryableErrors: [invalid-input, permission-denied]
status:
  phase: Running                    # Pending/Running/Paused/WaitingApproval/Succeeded/Failed/Cancelled/Expired
  currentNode: review-gate
  outputs: {}                       # 流程产物，逐节点落盘
```

设计要点：

- `input` 为 JSON 对象，Flow 节点模板通过 `{{input.xxx}}` 引用；输入在任务创建时做 schema 校验（若流程声明了输入 schema）。
- `outputs` 按节点粒度累积，最终产物与 Task 一同归档，供 4.9 与审批产物预览使用。
- 任务不可变更：`spec` 一旦创建只读，运行时只更新 `status`，保证可审计。

### 四种触发方式（FR-501 ~ FR-503）

| 触发 | 关键设计 |
|---|---|
| 手动 | 控制台 / API / CLI 直接创建，需指定 flowRef 与 input |
| 定时 | TaskSchedule 资源，cron 表达式；记录上次触发时间与下次触发时间；支持时区；错过触发点策略（补跑 / 跳过，默认跳过） |
| Webhook | 注册路径 `POST /api/v1/webhooks/{name}/trigger`，要求签名校验（HMAC 或平台下发 token，见 NFR-01）；事件去重见下 |
| IM 消息 | P2，企业微信指令触发，见 4.10 FR-1004 |

幂等去重设计（FR-503 / NFR-04）：

- Webhook 事件去重键 = 来源类型 + 事件 ID（如 `github:issue-42`），以唯一索引存储；重复投递返回 200 但不再创建任务。
- 定时触发以「调度周期 + 计划时间」为天然幂等键，Worker 重启后不会重复生成同一周期的任务。
- 幂等键持久化到 Postgres（生产模式），内存模式重启后以最近的完成记录兜底。

### 重试策略（FR-505）

- 重试只在可重试错误分类内生效：`timeout`、`rate-limit`、`worker-leased-expired`、`transient-io` 等；`invalid-input`、`permission-denied`、`approval-rejected` 等直接失败并终止。
- 退避策略支持固定与指数两种，指数退避上限封顶（如不超过 5 分钟），重试间隔写入任务状态供界面展示。
- 审批驳回（Rejected）与重试无关：走失败终态，不走自动重试，避免绕过人工决策。
- 重跑（FR-107）与重试语义区分：重试是同一 Task 实例内的自动恢复，重跑是生成新 Task 实例。

### Worker 分布式执行与租约（FR-506）

- 任务按需求标签（region / GPU / 模型 / 运行时）调度到匹配的 Worker。
- Worker 认领任务时获得租约（lease）：租约内含 TTL（如 60 秒），Worker 通过心跳续约；租约过期后任务可被其他 Worker 接管。
- 接管时执行恢复：任务具备持久化断点（见 NFR-03），接管 Worker 从最近检查点续跑（配合 4.7 的 opencode session 恢复）。
- 单机模式（NFR-07）由内嵌 Worker 承担全部任务，与分布式模式共享同一任务与租约资源模型，平滑演进。

### 并发控制与队列（FR-507）

- 两级限流：命名空间级并发上限 + 全局 Worker 队列深度。
- 超出并发上限的任务进入 Pending 队列，按优先级与 FIFO 出队；排队时间可查询。
- 同流程实例的串行依赖由流程引擎保证（4.4 的边约束），Worker 层不感知流程结构，避免分布式死锁。

### 与原型的关系

- `task-list` 任务列表：状态筛选、进度条、状态 badge（运行中 / 成功 / 失败 / 等待审批），覆盖 FR-105 的任务查看。
- `task-detail` 任务详情：执行进度步骤列表、深色 Trace 日志面板、审批待办提示与生命周期操作（暂停 / 恢复 / 重跑 / 取消），对应 FR-107 / FR-505。
- `trigger-manage` 触发器配置：定时（cron 表达式 / 下次触发）与 Webhook（路径 / 签名状态）双 tab，启停 switch，对应 FR-502 / FR-503。

## 界面原型

```prototype
id: task-list
title: 任务列表
device: desktop
```

```prototype
id: task-detail
title: 任务详情
device: desktop
```

```prototype
id: trigger-manage
title: 触发器配置
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| task-list（任务列表） | FR-105 |
| task-detail（任务详情） | FR-107、FR-505 |
| trigger-manage（触发器配置） | FR-502、FR-503 |

## 验收要点

- 手动 / 定时 / Webhook 三种方式均可创建任务，Task 的 `trigger` 字段正确标记来源。
- 相同 GitHub issue 事件重复投递 Webhook，只产生一个任务；定时任务在一个调度周期内不重复执行。
- 任务输入支持参数化并在流程节点中正确渲染；`input` 不匹配声明 schema 时任务创建被拒绝。
- 可重试错误自动重试并呈指数退避，非可重试错误立即失败；失败原因在任务详情可见。
- Worker 心跳停止后租约过期，任务被其他 Worker 接管并从断点恢复，任务详情中记录接管事件。
