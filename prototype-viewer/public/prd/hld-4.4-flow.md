<!-- 概要设计：对应需求文档 docs/req-4.4-flow.md -->

# 4.4 流程编排（Flow）— 概要设计

## 1. 模块定位

Flow 是对多个 Agent 的编排图：节点 = Agent / 审批关卡 / 并行分支 / 循环 / 子流程，边 = 转移条件。本模块是平台核心编排能力，负责把 Flow 声明编译为可执行的状态机图、执行静态校验（DAG 无环等）、管理流程版本快照，并支持 Blueprint 业务包的打包与安装。需求基线见 [req-4.4-flow.md](req-4.4-flow.md)（FR-401~411），本文档给出其实现方案：Flow 编译为状态机 + DAG 校验 + 版本快照 + Blueprint 打包。

## 2. 可行性分析

### 2.1 技术可行性

- **DAG 状态机编译**：把 `nodes + edges + conditions` 编译为可遍历的图结构，Node/TS 侧实现拓扑排序与环检测（Kahn 算法），确定性执行（ADR-009 编排零 Token），无新技术风险。
- **条件路由（FR-403）**：`contains / regex / JSON field` 三类匹配，Node 内置 + JSON 解析即可实现，正则匹配用标准 `RegExp`。
- **并行/汇合（FR-404，M2）**：并行分支并发提交任务，汇合节点按 `wait_for_all`/`quorum` 聚合，需要任务级并发控制（4.5 联动），实现复杂度中等。
- **循环（FR-405，M2）**：循环体 + 最大迭代次数（必填防死循环），状态机内维护迭代计数。
- **版本管理（FR-408）**：发布即生成不可变版本快照（Flow 定义 JSON 落盘），任务绑定版本执行，标准快照方案。
- **Blueprint（FR-411，M2）**：资源集合打包（Agent+Flow+审批点+凭证占位）→ 安装时复制到命名空间，YAML 打包无难度；定制粒度按 ADR-003 分层（参数可改 → 结构覆盖）。

### 2.2 依赖与前置

- 依赖 4.1：Flow 归属命名空间，跨命名空间引用子流程禁止；引用 Agent/审批人遵循命名空间规则。
- 依赖 4.2：节点 `agentRef` 引用 Agent（Active 状态）。
- 依赖 4.6：审批关卡节点（`approval-gate`）的审批状态机与恢复。
- 依赖 4.5：Flow 实例化为 Task，执行状态机推进由 Task 控制器驱动。
- 与 4.8 联动：节点内 Agent 使用的工具来自插件（间接依赖）。

### 2.3 风险与复杂度评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| 条件表达式在运行期求值错误（上游产物缺失） | 节点死路 | 静态校验检查所有引用的输出变量；所有分支声明默认边 |
| 并行汇合竞态（分支失败/超时策略不一致） | 流程状态不一致 | 汇合策略集中实现（wait_for_all/quorum/fail-tolerant），超时策略显式配置；汇合判定基于分支状态计数 |
| 循环死循环 | 任务无限消耗 | 最大迭代次数必填（默认 10），运行期计数校验，超限按配置策略终止 |
| 流程版本升级后旧任务恢复引用新版本 | 执行漂移 | 任务绑定创建时的版本快照，resume_context 携带 flow_version（architecture.md 风险表） |
| Blueprint 安装与上游升级冲突（fork 后无法跟随） | 定制与升级两难 | ADR-003 分层：MVP 仅参数化定制，M2 用引用覆盖层，不改原始包 |

### 2.4 可行性结论

**可行**，复杂度评级：**高**。核心状态机编译与静态校验在 M1 可落地（顺序/条件）；并行汇合、循环、版本管理与 Blueprint 归入 M2，复杂度集中在汇合聚合与版本快照的一致性。需在 M1 启动时先 PoC 拓扑编译 + 环检测的边界用例。

## 3. 实现初步方案

### 3.1 核心模块/组件划分

| 组件 | 职责 |
|---|---|
| `src/flow` | Flow 编译（nodes/edges/conditions → 状态机图）、拓扑排序、环检测、条件求值器 |
| `src/flow/exec` | 状态机执行引擎：节点推进、并行分支管理、汇合聚合、循环计数（供 4.5 驱动） |
| `src/resources` | `Flow` 资源定义、节点/边校验 schema |
| `src/controllers` | Flow 控制器：发布（生成版本快照）、引用校验（agentRef/审批人）、状态回写 |
| `src/blueprint` | Blueprint 打包/安装/参数定制（M2） |

### 3.2 关键数据模型（表/资源）

- **Flow 资源**：`spec{version, nodes[{id, type(agent|approval-gate|parallel|loop|subflow), agentRef, outputs[], approvers, ttlSeconds}], edges[{from, to, type(sequential|conditional|parallel), condition{contains|regex|field}}], context_adapter}`；`status{phase, published_version}`。
- **Flow 版本快照表 `flow_versions`**：`flow_ref, version, definition jsonb`（不可变），Task 通过 `flow_ref + version` 定位执行定义。
- **并行/循环运行时**：执行状态存于 Task status（`current_node`、分支状态、迭代计数），由 4.5 的 `task_messages`/状态字段承载。

### 3.3 关键流程/接口

核心 API：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/flows` · `/api/v1/flows/{name}` | Flow CRUD |
| POST | `/api/v1/flows/{name}/publish` | 发布：静态校验 → 生成版本快照（v+1）→ published_version 更新 |
| GET | `/api/v1/flows/{name}/versions` | 版本历史与差异查看 |
| POST | `/api/v1/flows/{name}/copy` · `/disable` | 复制/停用 |
| POST | `/api/v1/blueprints` · `/{name}/install` | Blueprint 安装（M2） |

关键流程（发布校验与执行推进）：

```
发布 → 静态校验：DAG 无环（Kahn）→ agentRef 存在且 Active → 输出变量引用合法
     → 审批关卡 TTL 合法 → 循环有上限 → 通过则写 flow_versions 快照

执行（4.5 驱动）→ 加载版本快照 → 编译状态机 → 顺序推进节点
     → 条件节点：求值 condition（contains/regex/field）→ 路由
     → 审批关卡：创建 TaskApproval 挂起（4.6）→ 决策后 resume_context 恢复
     → 并行节点（M2）：fan-out 各分支 → 汇合节点聚合（wait_for_all/quorum）→ 继续
```

```mermaid
stateDiagram-v2
    [*] --> Node1: 编译版本快照
    Node1 --> Cond: 完成并产出 output
    Cond --> Node2: condition 匹配
    Cond --> Default: 默认边
    Node2 --> Gate: 挂 review gate
    Gate --> Waiting: 创建 TaskApproval(Pending)
    Waiting --> Node3: approve + resume_context
    Waiting --> Failed: reject
    Waiting --> Rework: request-changes(round+1)
    Rework --> Node2: 携带意见重做
    Node3 --> [*]: 全部节点完成
```

### 3.4 关键技术点

1. **编译与执行分离**：`Compile(flowVersion)` 产出一个不可变的 `Machine`（节点表 + 邻接表 + 条件闭包），执行期只推进不重编译，保证确定性与可恢复（ADR-009）。
2. **输出变量引用校验**：静态阶段遍历所有 `{{node.xxx.output}}` 模板引用，与节点 `outputs` 声明比对，未产出即报错（req-4.4 设计要点）。
3. **条件求值惰性**：运行到条件节点时才求值，匹配失败走默认边（default 必填），不匹配的边不产生下游执行。
4. **版本快照不可变**：`flow_versions.definition` 一经写入不可修改；发布生成新版本而非覆盖，运行中任务不受影响（FR-408）。
5. **汇合聚合（M2）**：以"分支完成计数 + 策略（wait_for_all/quorum/fail-tolerant）"在汇合节点判断放行，分支状态存 Task status，支持失败容忍配置。
6. **Blueprint 引用模型（M2）**：包内资源用引用名（reference）连接，安装时解析为命名空间实际资源，参数按 schema 定制（ADR-003）。
7. **输出传递模板**：下游引用统一 `{{node.<id>.output.<key>}}`，渲染发生在节点入参阶段；引用未产出变量在运行期视为非可重试错误并给出缺失节点提示。
8. **停用语义**：`disable` 后新任务不可创建（409），运行中任务不受影响；重启用 `enable`，沿用原已发布版本。

### 3.5 实现步骤（MVP → 增强）

1. **M1**：Flow 资源定义 + 静态校验（拓扑/环检测/agentRef/输出引用）+ 顺序/条件执行状态机（architecture.md 附录第 2 步）。
2. **M1**：审批关卡节点（审批挂起 + 恢复续跑，与 4.6 联动）。
3. **M2**：并行分支与汇合（wait_for_all/quorum）、循环节点、版本管理（flow_versions + 差异查看）、Blueprint 打包/安装。
4. **M3**：可视化编排画布（前端，对接现有数据结构）、子流程节点、委托分发（fan-out，与 4.2 联动）。
