<!-- 子文档：对应主 PRD 4.9 章节，由 docs/requirements.md 拆分扩展 -->

# 4.9 可观测性与审计（需求设计说明）

## 模块概述

Agent 执行是黑盒，可观测性把黑盒打开：每个模型调用、工具调用、耗时、错误、Token 消耗都被记录为可检索的 Trace 与日志。本模块解决"任务执行过程可追溯、成本可核算、外部监控可对接"的问题，同时承担审计日志的检索能力（与 4.1 平台治理的审计写入侧呼应）。

本模块与 4.5 Task（Trace 挂在任务下）、4.7 运行时（SSE 事件转化为 Trace）、4.6 审批（审批决策入审计）、4.1 平台基础（审计日志存储与权限）联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-901 | 任务执行 **Trace**：记录每个步骤（模型调用、工具调用、耗时、错误、Token 消耗 input/output） | P0 |
| FR-902 | 任务日志查看：Agent 运行输出结构化存储与检索 | P0 |
| FR-903 | Token / 成本统计：按任务、Agent、命名空间维度汇总 | P1 |
| FR-904 | 提供 Prometheus 指标与 OpenTelemetry 链路导出 | P1 |
| FR-905 | 审计日志可检索：谁在什么时间对哪个资源做了什么操作、审批决策全文 | P0 |

## 详细设计说明

### Trace 数据模型（FR-901）

```yaml
kind: TraceSpan
spec:
  traceId: trace-20260803-0001
  taskRef: task-20260803-0001
  parentSpanId: ""                # 根步骤为空，其余挂父步骤
  type: model | tool | approval | error | step | subflow
  name: github.create_issue_comment
  startTime: "2026-08-03T10:00:01Z"
  endTime: "2026-08-03T10:00:03Z"
  durationMs: 2100
  status: ok | error | skipped
  detail:
    model: openai/gpt-4o
    tokens: { input: 1200, output: 340 }
    error: { code: rate-limit, retryable: true }
```

设计要点：

- Trace 为树状 span 结构，根是任务，子 span 是步骤；审批节点产生审批类型 span，与 4.6 决策关联。
- 步骤间父子关系由 opencode 事件流还原（4.7 FR-702），事件缺失时以任务顺序兜底，不阻断流程。
- 高风险：Trace 只存步骤摘要与输入输出截断，全文日志独立存储（FR-902），避免 Trace 表膨胀。
- Trace 数据保留期可配置（默认 30 天），成本统计与审计数据保留期独立。

### 任务日志（FR-902）

- Agent 运行输出（stdout、工具调用请求 / 响应、错误栈）结构化存储，按任务、节点、步骤、时间范围检索。
- 日志与 Trace 通过 `traceId + spanId` 关联，任务详情页深色日志面板按需加载（虚拟滚动），大日志不阻塞页面。
- 日志内容涉及凭证时自动脱敏（Token、密钥掩码），与审计日志脱敏规则一致。

### Token 与成本统计（FR-903）

- 汇总维度：任务、Agent、命名空间三级；时间维度支持日 / 周 / 月。
- Token 数据来源：opencode 会话事件（4.7 FR-702），按模型单价换算成本（单价配置在 ModelEndpoint 上）。
- 统计口径：input / output / total 与折算成本并列展示；`dashboard` 平台总览的命名空间任务分布联动成本趋势。
- 成本统计为 P1，M1 阶段先落地原始 Token 记录，M2 接入单价换算与命名空间汇总。

### 指标与链路导出（FR-904）

- Prometheus 指标：任务状态计数、执行耗时直方图、队列深度、审批 TTL 到期数、Token 消耗速率、opencode serve 连接状态。
- OpenTelemetry：平台内部编排请求链路导出（编排内核不消耗模型 Token，NFR-05，导出的是编排控制链路而非 Agent 推理）。
- 导出目标通过全局设置配置（endpoint / 采样率），默认关闭避免压垮外部监控。

### 审计检索（FR-905）

- 检索维度：操作者、时间范围、资源类型、操作类型（create / update / delete / approve / reject / request-changes / exec）、关键字。
- 审批决策全文可检索：决策人、意见正文、关联 Task 与 Trace 均可联查（与 4.6 FR-608 产物上下文呼应）。
- 审计接口只读、追加写（见 4.1 FR-106），检索结果分页与导出。

### 与原型的关系

- `task-trace` 任务 Trace 全览：纵向时间线展示模型 / 工具 / 审批 / 错误类型色点，支持类型筛选与步骤展开，是 FR-901 / FR-902 的核心交互原型。
- `task-detail` 任务详情：执行进度步骤列表加 Trace 日志面板，是单任务可观测入口。
- `audit-log` 审计日志：操作类型 / 操作者 / 时间范围筛选与详情展开，对应 FR-106 / FR-905。
- `dashboard` 平台总览：任务统计卡与运行中任务，承接成本与健康指标的趋势展示（FR-903 联动）。

## 界面原型

```prototype
id: task-trace
title: 任务 Trace 全览
device: desktop
```

```prototype
id: task-detail
title: 任务详情
device: desktop
```

```prototype
id: audit-log
title: 审计日志
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| task-trace（任务 Trace 全览） | FR-901、FR-902 |
| task-detail（任务详情） | FR-107、FR-505 |
| audit-log（审计日志） | FR-106、FR-905 |

## 验收要点

- 一次任务执行完成后，其 Trace 中模型调用、工具调用、耗时、错误、Token 消耗均可按时间线完整回放。
- 任务日志支持按节点与时间范围检索，日志中的凭证内容自动脱敏。
- 按命名空间维度的 Token 汇总与明细一致，成本换算基于模型单价配置。
- Prometheus 端点暴露任务计数与执行耗时指标；配置 OTel 导出后编排链路可在外部追踪系统查看。
- 通过操作者与时间范围可检索到指定审批决策的全文意见，并跳转到关联任务 Trace。
