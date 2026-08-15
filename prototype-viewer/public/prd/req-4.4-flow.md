<!-- 子文档：对应主 PRD 4.4 章节，由 docs/requirements.md 拆分扩展 -->

# 4.4 流程编排（Flow）（需求设计说明）

## 模块概述

Flow 是对多个 Agent 的编排图：节点是 Agent、审批关卡或子流程，边描述转移条件（顺序 / 条件 / 并行 / 循环）。本模块解决"如何把多角色协作固化为可复用的流程"问题，是整个平台的核心编排能力。它以 DAG 为骨架，辅以并行分支、循环、审批关卡与版本管理，把"像真实公司一样运转"的交付过程变成声明式资源。

本模块与 4.2 Agent（节点类型）、4.6 审批（审批关卡节点）、4.5 任务（Flow 实例化为 Task）、4.8 插件（外部工具作为节点能力）紧密联动；Blueprint 业务包（FR-411）是流程加 Agent 定义加审批点的打包复用形态。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-401 | 支持以图（DAG）方式串联多个 Agent：节点 = Agent，边 = 转移 | P0 |
| FR-402 | 支持**顺序执行**：Agent A 完成后执行 Agent B，A 的输出可传递给 B | P0 |
| FR-403 | 支持**条件路由**：基于上游 Agent 的输出（内容包含 / 正则 / JSON 字段取值）决定走哪条边 | P0 |
| FR-404 | 支持**并行分支与汇合**：多个 Agent 并行执行，按 `wait_for_all`（全部完成）或 `quorum`（部分完成）汇合后继续 | P1 |
| FR-405 | 支持**循环**：节点可循环执行，必须配置最大迭代次数（防死循环） | P1 |
| FR-406 | 支持**审批关卡**（human gate）作为流程节点：节点输出后暂停，等待人工审批（见 4.6） | P0 |
| FR-407 | 支持**委托分发**：节点可派生子任务到其他 Agent（fan-out），子任务结果回传后触发重审 | P2 |
| FR-408 | 支持流程**版本管理**：发布新版本后，运行中的任务不受影响；支持新旧版本并行 | P1 |
| FR-409 | 支持**子流程**：一个 Flow 可被另一个 Flow 引用为子节点（模板复用） | P2 |
| FR-410 | 提供可视化编排画布（拖拽 Agent、连线、配置条件） | P2 |
| FR-411 | 提供 Blueprint（业务包）：可将"Agent 定义 + Flow + 审批点"打包为可安装模板（如"软件公司开发流程"），一键安装到命名空间后按需定制 | P1 |

## 详细设计说明

### 流程资源与节点模型（FR-401 / FR-402）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Flow
metadata:
  name: software-company-dev
  namespace: dev-team
spec:
  version: 3                       # 当前版本号，每次发布递增
  nodes:
    - id: pm-analyze
      type: agent                  # agent | approval-gate | parallel | loop | subflow
      agentRef: requirement-analyst
      outputs: [requirement_doc]   # 声明节点输出名，供下游引用
    - id: review-gate
      type: approval-gate
      agentRef: pm-analyze         # 审批对象：上游节点产物
      approvers: [product-owner]   # 审批人 / 角色
      ttlSeconds: 86400
    - id: architect-design
      type: agent
      agentRef: architect
  edges:
    - from: pm-analyze
      to: review-gate
      type: sequential
    - from: review-gate
      to: architect-design
      type: conditional            # 条件见下
      condition:
        match: decision == "approved"
```

设计要点：

- 节点产物以命名输出（`outputs`）声明，下游节点通过 `{{node.xxx.output}}` 模板引用，实现 Agent A 的输出传递给 B。
- 数据依赖与执行顺序解耦：边声明决定执行顺序，输出引用做运行时校验，引用了尚未产出的变量在流程校验阶段即报错。
- 流程发布前执行静态校验：DAG 无环、节点引用存在、审批关卡 TTL 合法、循环有上限。

### 条件路由（FR-403）

`condition` 支持三类匹配，作用于上游节点输出：

| 类型 | 语义 | 示例 |
|---|---|---|
| 内容包含 contains | 输出文本包含子串 | `match: "approved"` |
| 正则 regex | 输出文本匹配正则 | `match: "v\\d+\\.\\d+"` |
| JSON 字段 field | 解析输出 JSON 取字段比较 | `field: decision` `op: "=="` `value: "approved"` |

- 所有分支必须声明默认边（default），匹配失败走默认边，防止死路。
- 条件表达式在运行时惰性求值，不匹配的边不产生下游执行。

### 并行分支与汇合（FR-404）

- 并行分支：一个节点可声明多个出边指向不同节点，多个节点同时进入运行态，各自独立提交给 Worker。
- 汇合策略在汇合节点声明：`wait_for_all`（所有上游完成才继续）或 `quorum`（设置最小完成数，如 `min: 2 of 3`）。
- 边界情况：并行分支中某一路失败时，`wait_for_all` 默认整条流程失败；允许配置"失败容忍"（分支失败标记但不阻断汇合）。quorum 未达成即触发超时策略（等待超时后按失败或按已成功分支继续）。
- 汇合节点在并行度不均衡时不阻塞其他分支的独立输出落盘，所有分支产物均可追溯。

### 循环（FR-405）

- 循环节点配置：循环体（子节点序列）、迭代条件、最大迭代次数（必填，默认上限 10）。
- 达到最大迭代次数仍未满足退出条件时，按策略处理：标记失败或强制退出并以最后一次迭代结果继续（可配置）。
- 循环体内部同样禁止产生未定义环，避免递归死循环；循环计数写入任务 trace。

### 审批关卡与委托分发（FR-406 / FR-407）

- 审批关卡（human gate）是结构强制的节点：上游完成后流程暂停，等待 4.6 审批决策，批准后从暂停点精确恢复。
- 委托分发（fan-out，P2）：节点可声明将上游输出分发给多个 Agent 并行处理（如把多个 issue 分给多个开发 Agent），子任务全部回传后触发重审节点。委托深度与任务 trace 关联（见 4.2 FR-206）。

### 版本管理与子流程（FR-408 / FR-409）

- 发布即生成新版本（v1 到 v2 到 v3），已发布的版本不可变；新任务默认使用最新发布版本，也可显式指定历史版本。
- 运行中的任务绑定创建时的流程版本快照，新版本发布不影响在跑任务，实现新旧版本并行。
- 子流程（P2）：Flow 的节点类型含 `subflow`，引用另一 Flow 的最新发布版本；子流程版本更新不影响父流程定义，但父流程校验时需确认子流程存在且版本可用。
- 跨命名空间引用子流程被 4.1 隔离规则禁止。

### Blueprint 业务包（FR-411）

- Blueprint 是打包单元：`Agent 定义 + Flow + 审批点 + 默认凭证占位 + 产物 schema`。
- 一键安装到命名空间后生成同名资源的副本，可自由定制（参数、提示词、流程结构），与源蓝图解耦。
- 示例："软件公司开发流程"包含需求分析 Agent、架构师 Agent、测试工程师 Agent、开发工程师 Agent，串联需求文档生成 → 审批 → 设计 → 审批 → 开发 → CI/CD 触发 → 测试 → 验收审批 → 归档。
- 蓝图市场原型（`blueprint-market`）展示内容统计（N Agent / 流程 / 审批关卡）与安装弹窗，即 FR-411 的可视化承载。

### 与原型的关系

- `flow-list` 流程定义列表：版本 / 节点数 / 审批关卡数 / 状态（已发布 / 草稿 / 已停用），提供新建、编辑、发布、复制、停用操作。
- `flow-editor` 流程编排画布：节点库（Agent / 审批 Gate / 并行分支）加 SVG 连线 DAG 画布加属性面板，是 FR-410 与 FR-401 至 406 的核心交互原型，数据驱动（NODES / EDGES / NODE_DETAILS）为真实编辑器预留扩展位。
- `flow-detail` 流程详情：概览（节点清单 / 审批 Gate / 触发方式）、版本历史（v1 至 v3 差异查看）、执行记录三 tab，对应 FR-408 版本管理。
- `blueprint-market` 蓝图市场：FR-411 的安装入口。

## 界面原型

```prototype
id: flow-list
title: 流程定义
device: desktop
```

```prototype
id: flow-editor
title: 流程编排画布
device: desktop
```

```prototype
id: flow-detail
title: 流程详情
device: desktop
```

```prototype
id: blueprint-market
title: 蓝图市场
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| flow-list（流程定义） | FR-408 |
| flow-editor（流程编排画布） | FR-410、FR-401 ~ FR-406 |
| flow-detail（流程详情） | FR-408 |
| blueprint-market（蓝图市场） | FR-411 |

## 验收要点

- 定义"需求分析 → 审批 → 设计"三段顺序流程并发布，可手工触发执行，产物按边正确传递。
- 审批关卡驳回后走打回分支重新进入分析节点，流程不继续推进。
- 并行分支两路同时执行并在汇合节点按 `wait_for_all` 聚合后继续，trace 中两路时间线可见。
- 循环节点未配置最大迭代次数时发布被拒绝；达到上限后按配置策略终止。
- 发布 v3 后运行 v2 启动的任务不受影响，流程详情可查看 v1 至 v3 差异；蓝图市场可一键安装"软件公司开发流程"到指定命名空间。
