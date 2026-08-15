<!-- 子文档：对应主 PRD 4.6 章节，由 docs/requirements.md 拆分扩展 -->

# 4.6 人工审批（Human-in-the-Loop）（需求设计说明）

## 模块概述

人工审批是 Orchestra "像真实公司一样运转"的关键差异点：人类在关键阶段保留决策权。本模块解决"如何让审批结构化、可恢复、可审计"的问题：审批关卡挂载在流程节点后或流程结尾，决策分为批准、驳回、打回三种，并支持 TTL 超时、工具级审批、多级审批人分配。审批是结构强制而非 prompt 建议，未批准不推进。

本模块与 4.4 Flow（审批关卡节点 FR-406）、4.5 Task（等待审批状态）、4.7 运行时（工具级审批与 opencode permission 联动 FR-705）、4.9 可观测（审批决策入审计）、4.10 通知（审批待办卡片提醒）直接联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-601 | 审批状态机：`Pending → Approved / Rejected / ChangesRequested / Expired` | P0 |
| FR-602 | 审批**通过后精确恢复**：任务从暂停点继续执行（保留上下文），而非整条重跑 | P0 |
| FR-603 | 审批**驳回（Rejected）**：任务标记失败，保留驳回意见 | P0 |
| FR-604 | 审批**打回（ChangesRequested）**：携带意见打回对应 Agent 重做，进入下一轮 review 循环；必须支持**最大循环次数**（达到上限后升级为阻塞 / 失败） | P0 |
| FR-605 | 审批支持 **TTL 超时**：待审批超过有效期自动 Expired，按策略处理（失败 / 升级 / 提醒） | P0 |
| FR-606 | 支持**工具级审批**（ToolApproval）：高风险工具调用（如删除资源、推送代码）在执行前暂停等待审批，与流程级审批（TaskApproval）并存 | P1 |
| FR-607 | 审批人分配：指定用户 / 角色 / 多级审批；审批意见与决策人完整记录 | P1 |
| FR-608 | 审批内容可审计：展示被审批的产物（文档 / 输出）、产生 Agent、Checkpoint 上下文 | P1 |

## 详细设计说明

### 审批状态机与审批资源（FR-601）

审批是一个独立资源类型，承载流程级（TaskApproval）与工具级（ToolApproval）两类：

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Approval
metadata:
  name: approval-20260803-0001
  namespace: dev-team
spec:
  kind: TaskApproval               # TaskApproval | ToolApproval
  taskRef: task-20260803-0001
  nodeRef: review-gate             # 挂载节点 / 工具调用点
  producerAgent: requirement-analyst
  artifactRef:                     # 被审批产物（FR-608）
    type: output                   # output | tool-call
    key: requirement_doc
  approvers:                       # FR-607
    mode: role                     # user | role | multi-level
    value: product-owner
  ttlSeconds: 86400
  maxReviewRounds: 3               # 打回最大循环次数（FR-604）
status:
  phase: Pending
  round: 2                         # 当前轮次
  decidedBy: li.wei
  decidedAt: "2026-08-03T12:00:00Z"
  comment: 补充验收标准后重新提交
```

状态机：

```
Pending ──approve──────────▶ Approved
   │──reject───────────▶ Rejected
   │──request-changes──▶ ChangesRequested ──(打回 Agent 重做)──▶ Pending(round+1)
   │──ttl 到期──────────▶ Expired
Approved/Rejected/Expired 为终态；round 达到 maxReviewRounds 仍未通过时升级为 Blocked
```

### 精确恢复（FR-602）

- 审批通过后，任务从暂停的节点边界精确恢复：Agent 上下文、会话状态、中间产物全部保留（见 4.7 会话保持与断点恢复）。
- 恢复点 = 审批关卡节点的 Checkpoint，而非整条流程重跑；重跑只发生在显式触发（FR-107），与审批无关。
- 恢复后下游节点继续执行，不再重复已完成的节点，避免 Token 浪费与结果漂移。

### 驳回与打回（FR-603 / FR-604）

- 驳回（Rejected）：任务进入失败终态，保留驳回意见与审批人；不自动重试（见 4.5 重试策略）。
- 打回（ChangesRequested）：携带结构化意见打回产生该产物的 Agent 重做；Agent 在新一轮执行中接收意见作为输入，产出修订产物后再次进入审批。
- 循环控制：`maxReviewRounds` 必填（默认 3），达到上限仍未通过时升级为 Blocked（阻塞，需管理员介入）或按配置转为失败。
- 每一轮的审批意见、决策人与产物差异均完整记录，供多轮 review 追溯。

### TTL 超时（FR-605）

- 待审批超过 `ttlSeconds` 自动进入 Expired，并按策略处理：

| 策略 | 行为 |
|---|---|
| fail | 任务标记失败（默认） |
| escalate | 升级给上级审批人 / 管理员，重置 TTL |
| remind | 向审批人重复提醒（可配置提醒次数与间隔） |

- TTL 到期扫描由调度器周期执行，Expired 决策写入审计；升级路径支持多级（一级超时升二级，二级超时按 fail 处理）。

### 工具级审批（FR-606 / FR-705 联动）

- 高风险工具调用（删除资源、推送代码、修改生产配置）在执行前暂停，生成 ToolApproval。
- 审批通过后平台放行对应工具调用并通知 opencode 会话继续（联动 `/session/:id/permissions/:permissionID`）；驳回则终止该调用，Agent 收到被拒结果并调整策略。
- 工具级审批与流程级审批并存：同一任务可同时有多个挂起的 ToolApproval 与一个 TaskApproval，审批中心按类型与任务聚合展示。

### 审批人分配（FR-607）

- 三种分配模式：指定用户、指定角色（角色内任一成员可决策）、多级审批（一级通过后转二级，任意级驳回即驳回）。
- 审批人操作需二次确认（防止误触），决策后不可撤回；审批记录含决策人、时间、意见、IP 与关联 trace。
- 审批待办通过 4.10 企业微信卡片推送，卡片直达审批详情页。

### 与原型的关系

- `approval` 审批中心：统计卡（待审批 / 已处理 / 平均耗时）、待审批列表与通过 / 驳回 / 打回操作，覆盖 FR-601 至 605、FR-607 的列表与操作入口。
- `approval-detail` 审批详情：产物预览（Markdown 风格需求文档渲染）、审批信息（提交人 / Agent / Checkpoint / TTL）、决策区与审批历史轮次，对应 FR-608 与打回循环展示。

## 界面原型

```prototype
id: approval
title: 审批中心
device: desktop
```

```prototype
id: approval-detail
title: 审批详情
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| approval（审批中心） | FR-601 ~ FR-605、FR-607 |
| approval-detail（审批详情） | FR-608 |

## 验收要点

- 审批节点未决策时任务保持 WaitingApproval 状态，任何路径都不会绕过审批推进。
- 批准后任务从暂停节点精确恢复，已完成的节点不重复执行；驳回后任务进入失败终态并保留意见。
- 打回后 Agent 接收意见重做并进入下一轮，达到最大轮次后任务升级为 Blocked。
- 待审批任务超过 TTL 自动 Expired，并按配置策略（失败 / 升级 / 提醒）正确处理。
- 高风险工具调用在批准前不产生实际外部副作用；审批中心可完整查看某任务的审批历史轮次与决策人。
