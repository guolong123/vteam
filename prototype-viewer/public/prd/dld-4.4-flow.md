<!-- 详细设计：在 hld-4.4 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.4 流程编排（Flow）— 详细设计

## 1. 模块范围

本模块是核心编排能力：Flow 声明（DAG 图：节点=Agent/审批关卡/并行/循环/子流程，边=转移条件，FR-401~406）、版本快照（FR-408）、Blueprint 业务包打包安装（FR-411）。实现上 Flow 资源存通用表，发布时生成不可变版本快照入 `flow_versions` 独立表；`Compile(flowVersion)` 编译为确定性状态机（Machine），由 4.5 任务控制器驱动推进（ADR-009 编排零 Token）。本文档给出 FlowSpec 完整结构、flow_versions 表 DDL、编译管线（DAG 环检测/输出引用校验/条件求值）与执行引擎设计。需求基线 req-4.4（FR-401~411）。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `resources(type='flow')` | Flow 声明式资源（Draft 可编辑） | 通用资源表 |
| `flow_versions` | 已发布版本快照（不可变） | 独立表 |
| `resources(type='blueprint')` | Blueprint 打包资源（M2） | 通用资源表 |

### 2.2 表结构

**`flow_versions`（版本快照，不可变）**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| namespace | text | not null | |
| flow_name | text | not null | |
| version | int | not null | 发布版本号，递增 |
| definition | jsonb | not null | Flow 定义全量快照（spec 深拷贝） |
| compiled | jsonb | not null | 编译产物缓存（节点表/邻接表/条件闭包） |
| published_at | timestamptz | not null default now() | |
| published_by | text | not null | 发布者 |

索引：`(namespace, flow_name, version)` **唯一**；`(flow_name, version desc)`。
不变量：definition 一经写入不修改；任务按 `(flow_name, version)` 定位执行定义。

**`resources.spec (type='flow')`**：

```jsonc
{
  "version": 3,                          // 当前最新版本号（草稿态显示 next）
  "description": "软件公司开发流程",
  "nodes": [
    { "id": "pm-analyze", "type": "agent", "agentRef": "requirement-analyst",
      "outputs": ["requirement_doc"], "retry": { "maxAttempts": 2 } },
    { "id": "review-gate", "type": "approval-gate", "agentRef": "pm-analyze",
      "approvers": { "mode": "role", "value": "product-owner" }, "ttlSeconds": 86400 },
    { "id": "architect-design", "type": "agent", "agentRef": "architect",
      "inputs": { "requirement_doc": "{{node.pm-analyze.output.requirement_doc}}" } }
  ],
  "edges": [
    { "from": "pm-analyze", "to": "review-gate", "type": "sequential" },
    { "from": "review-gate", "to": "architect-design", "type": "conditional",
      "condition": { "type": "field", "field": "decision", "op": "==", "value": "approved" } },
    { "from": "review-gate", "to": "end", "type": "conditional", "isDefault": true }
  ],
  "contextAdapter": null,                // 预留：节点间输入转换
  "inputSchema": { "issueNumber": { "type": "number", "required": true } }
}
// status: { "phase": "Draft|Published|Disabled", "publishedVersion": 3 }
```

**节点类型**：`agent | approval-gate | parallel | loop | subflow`。**边类型**：`sequential | conditional | parallel`。**条件类型**：`contains | regex | field`。

### 2.3 枚举/常量

```ts
// src/flow/types.ts
export const NODE_TYPE = ['agent','approval-gate','parallel','loop','subflow'] as const;
export const EDGE_TYPE = ['sequential','conditional','parallel'] as const;
export const CONDITION_TYPE = ['contains','regex','field'] as const;
export const JOIN_POLICY = ['wait_for_all','quorum','fail-tolerant'] as const;
export const LOOP_MAX_DEFAULT = 10;                     // 循环最大迭代默认（必填校验）
export const APPROVAL_TTL_MIN_SECONDS = 60;
```

## 3. 实现设计

### 3.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/resources/flow.ts` | FlowSpec zod schema、节点/边结构校验 |
| `src/flow/compile.ts` | `Compile(flowVersion)` → Machine（拓扑排序、环检测、输出引用校验、条件闭包） |
| `src/flow/graph.ts` | 图结构（邻接表）、Kahn 拓扑排序、环检测、可达性 |
| `src/flow/condition.ts` | 条件求值器（contains/regex/field 惰性求值） |
| `src/flow/exec.ts` | 执行引擎：节点推进、并行分支、汇合聚合、循环计数（供 4.5 驱动） |
| `src/controllers/flow.ts` | 发布（生成版本快照）、引用校验（agentRef/审批人）、enable/disable/copy |
| `src/blueprint/index.ts` | Blueprint 打包/安装/参数定制（M2） |

### 3.2 核心类型与 Schema（zod）

```ts
// src/flow/types.ts
export interface FlowNode {
  id: string;
  type: NodeType;
  agentRef?: string;                 // agent/approval-gate(agentRef=上游节点)
  outputs?: string[];                // 命名输出声明
  approvers?: { mode: 'user'|'role'|'multi-level'; value: string };
  ttlSeconds?: number;
  joinPolicy?: { policy: JoinPolicy; min?: number };   // 汇合节点
  loop?: { maxIterations: number; exitCondition?: Condition };  // 循环节点
  subflowRef?: { name: string };     // subflow 节点
}
export interface Machine {           // Compile 产物，不可变
  nodes: Map<string, FlowNode>;
  adjacency: Map<string, Edge[]>;
  entryNode: string;
  conditions: Map<string, Condition>;
  nodeIndex: string[];               // 拓扑序
}
```

### 3.3 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/flows` | 列表（版本/节点数/审批关卡数）/ 创建 |
| GET/PUT/DELETE | `/api/v1/flows/{name}` | 详情 / 编辑（Draft CAS）/ 删除（有运行中任务 409） |
| POST | `/api/v1/flows/{name}/publish` | 发布：静态校验 → 版本快照 v+1 |
| GET | `/api/v1/flows/{name}/versions` | 版本历史与差异对比 |
| POST | `/api/v1/flows/{name}/copy` · `/disable` · `/enable` | 复制 / 停用 / 启用 |
| GET | `/api/v1/flows/{name}/validate` | 校验预览（不落库，编辑器实时校验） |
| POST | `/api/v1/blueprints` · `/{name}/install` | Blueprint 打包 / 安装（M2） |

### 3.4 核心函数/服务

```ts
// src/flow/compile.ts
export function Compile(definition: FlowDefinition): Machine;
  // 1. 建图 2. Kahn 拓扑（检测环→ValidationError 含环路径）3. 校验输出引用 4. 条件闭包 5. 缓存
export function validateFlowSpec(spec: FlowSpec): void;
  // 静态校验：节点 id 唯一/边引用合法/approval-gate 有 ttl/loop 有 maxIterations/默认边必填

// src/flow/exec.ts（由 4.5 调用，纯状态推进）
export interface FlowExecState { currentNode: string; outputs: Record<string, unknown>;
  branchStates?: Record<string, string>; loopCounters?: Record<string, number>; }
export function step(machine: Machine, state: FlowExecState, event: StepResult): NextStep;
  // StepResult = { node, output, decision? } → { next: NodeTransition, waitFor?: Approval, blocked?: string }
export function evaluateCondition(cond: Condition, output: unknown): boolean;  // 惰性求值

// src/controllers/flow.ts
export async function publishFlow(ns, name): Promise<{ version: number }>;
  // validateFlowSpec → 校验 agentRef 存在且 Active → Compile（环/引用）→ 写 flow_versions → status.publishedVersion+1
export async function getFlowVersion(ns, name, version?): Promise<Resource<FlowDefinition>>;
  // version 缺省取最新 publishedVersion；任务创建时固定版本
```

### 3.5 关键流程实现

**发布管线**：

```
publish(ns, name)
  → spec = get(ns,name).spec；validateFlowSpec（结构）
  → 每个 agentRef 节点：4.2 assertAgentActive(ns, agentRef)（引用 Active Agent）
  → approval-gate：ttlSeconds 合法（>=60）、approvers 模式合法
  → Compile(spec)：Kahn 环检测 + 输出引用校验（{{node.<id>.output.<key>}} 与 outputs 声明比对）
  → 通过 → 写 flow_versions(namespace, flow_name, version=spec.version+1, definition=spec)
  → 更新 status.publishedVersion → phase=Published → 审计(action=publish)
```

**执行推进（4.5 驱动，伪代码）**：

```
任务开始：machine = loadCompiled(task.flow_ref.version)
state = { currentNode: machine.entryNode, outputs: {}, ... }

loop:
  node = machine.nodes[state.currentNode]
  switch node.type:
    'agent'       → 4.7 执行 ResolvedAgent(node) → 输出入 state.outputs[node.id]
    'approval-gate' → 创建 TaskApproval(4.6) → Task=WaitingApproval → 等待 decide
                      → 通过后按 resume_context 恢复到 gate 之后
    'parallel'    → fan-out：各出边分支独立提交子执行（M2）
    'loop'        → loopCounters[id]++; 超 maxIterations → 按策略终止
    'subflow'     → 引用另一 Flow 最新版本（M3）
  edges = machine.adjacency[node.id]
  conditional → evaluateCondition(edge.condition, state.outputs[node.id]) 命中或 default
  全部完成 → Task=Succeeded
```

**条件求值器**：

```ts
export function evaluateCondition(c: Condition, output: unknown): boolean {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  switch (c.type) {
    case 'contains': return text.includes(c.match);
    case 'regex':    return new RegExp(c.match).test(text);
    case 'field':    { const v = getPath(output, c.field); return compare(v, c.op, c.value); }
  }
}
```

**汇合聚合伪代码（M2，FR-404）**：

```
joinNode 进入时记录待汇合分支集合（上游节点 id 列表）
每完成一个分支 → branchStates[branchId] = 'done'
放行判定：
  wait_for_all  → 全部上游 done → 放行
  quorum        → done 数 >= min → 放行（未完成分支标记 skipped，产物不阻塞落盘）
  fail-tolerant → 任一分支 failed 标记不阻断，其余 done 即放行
超时：quorum 等待超时（默认 5min）→ 按配置失败或按已成功分支继续
```

**循环节点推进（M2，FR-405）**：

```
loop 节点：loopCounters[id]++
  → 退出条件未满足且未达 maxIterations → 继续循环体（重新执行子节点序列）
  → 达 maxIterations 仍未满足退出条件 → 按配置：标记失败 或 强制退出沿用末次迭代结果
  → 循环计数写入 trace（observability span detail.iterations）
```

**Blueprint 打包/安装（M2，FR-411）**：

```
Blueprint 资源 = 资源集合打包：{ agents: AgentSpec[], flows: FlowSpec[], approvals: 审批点声明,
                          secretPlaceholders: [{name, default}], productSchemas: {} }
打包格式：单目录多 YAML（API 版本 + 引用名连接），引用替换模型（ADR-003）
安装（一键到命名空间）：
  → 复制全部资源到目标命名空间（agentRef/approvers 引用按命名空间解析）
  → 参数定制：secretPlaceholders 填默认值（写入 Secret）；提示词/模型/工具白名单可改（参数层）
  → M2 覆盖层：基于引用替换修改流程结构，不改原始包（升级跟随保留）
示例：软件公司开发流程 = 需求分析 Agent → 审批 → 架构设计 → 审批 → 开发 → CI/CD → 测试 → 验收审批 → 归档
```

**版本差异对比（FR-408）**：

```
GET /api/v1/flows/{name}/versions?from=v2&to=v3
  → 读取 flow_versions 两行 definition
  → 差异计算：节点集合 diff（增/删/改 agentRef）、边集合 diff、approval-gate TTL 变更
  → 输出结构化 diff 供前端展示（flow-detail 版本历史 tab）
```

### 3.6 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| DAG 存在环 | 拒绝发布 + 环路径提示（Kahn 残留节点即环） |
| 输出引用未声明 | 静态校验拒绝（422 + 缺失变量与引用位置） |
| 条件求值运行期异常 | 走默认边（default 必填）；无默认边视为编译期错误已拦截 |
| 汇合未达 quorum | 等待超时策略（默认 5min）→ 失败或按已成功分支继续（M2） |
| 循环达上限未满足退出条件 | 按配置：标记失败或强制退出沿用末次结果（M2） |
| 版本升级后旧任务恢复 | resume_context 携带 flow_version，恢复按原版本（architecture 风险表） |
| disable 后创建任务 | 409；运行中任务不受影响 |

### 3.7 测试要点

- 单元：Kahn 环检测（单环/多环/自环）；输出引用模板解析与校验；contains/regex/field 三条件求值；Compile 产物不可变（同一 definition 幂等）。
- 集成：顺序三节点流转且产物按边传递；审批 gate 挂起→批准→从 gate 后恢复（已完节点不重跑）；发布 v3 后 v2 任务不受影响且版本差异可查；循环未配上限发布被拒。
