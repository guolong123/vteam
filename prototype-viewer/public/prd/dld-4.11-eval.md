<!-- 详细设计：在 hld-4.11 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.11 Eval 评估体系 — 详细设计

## 1. 模块范围

本模块承载 M3 的评估体系：`EvalDataset`（golden 数据集，FR-1005/FR-1006）、`EvalRun`（评估运行，FR-1007/FR-1008）、评分维度（FR-1009）与评估报告（FR-1010）。实现上复用 4.5 Task 执行链路与 4.7 opencodeExecutor（评估只编排不执行），评分素材来自 Task.output 与 4.9 `task_trace_events`；新表 `eval_datasets`/`eval_runs`/`eval_case_results` 承接资源与运行结果。本文档给出三表 DDL、`src/eval` 目录与核心类型、评分器/编排器/采样器实现、RESTful API 与测试要点。需求基线 req-4.11（FR-1005~1010），概要见 hld-4.11。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `eval_datasets` | golden 数据集（spec + cases jsonb，按 name 版本化） | 独立表 |
| `eval_runs` | 评估运行（配置 + 结果汇总 + 报告引用） | 独立表 |
| `eval_case_results` | case 级评分明细（关联 run 与 task） | 独立表 |

### 2.2 表结构

**`eval_datasets`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| namespace | text | not null | |
| name | text | not null | |
| version | int | not null default 1 | 数据集版本（不可变快照，运行固定引用） |
| description | text | | |
| target_agent_ref | text | | 评估目标：Agent（与 target_flow_ref 二选一） |
| target_flow_ref | text | | 评估目标：Flow |
| scoring_dimensions | jsonb | not null | `[{name, matchType, weight, params}]` |
| cases | jsonb | not null | `[{id, input, expectedOutput, expect?, weight?}]` |
| created_by | text | | 创建人（审计） |
| created_at | timestamptz | not null default now() | |
| updated_at | timestamptz | not null default now() | |

索引：`unique(namespace, name, version)`（版本链）、`(namespace, name)`（列表）。**删除约束**：被 eval_runs 引用的版本禁止删除（应用层校验）。

**`eval_runs`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| namespace | text | not null | |
| name | text | not null | |
| dataset_id | uuid | not null references eval_datasets(id) | |
| dataset_version | int | not null | 运行固定数据集版本（快照） |
| target_agent_ref | text | | 覆盖数据集级评估目标 |
| target_flow_ref | text | | |
| concurrency | int | not null default 3 | 并行驱动 Task 数 |
| timeout_seconds | int | not null default 3600 | 单 case 执行超时 |
| scoring_override | jsonb | | 覆盖评分配置 `[{name, weight}]` |
| case_filter | jsonb | | 运行子集 `{caseIds: []}` |
| phase | text | not null | pending/running/succeeded/failed/cancelled |
| total_cases | int | not null default 0 | |
| passed_cases | int | not null default 0 | |
| failed_cases | int | not null default 0 | |
| score | numeric(5,4) | | 加权总分（0~1） |
| report | jsonb | | 报告聚合（汇总 + 维度得分 + 对比引用） |
| started_at | timestamptz | | |
| finished_at | timestamptz | | |
| last_error | text | | phase=failed 时的错误 |
| created_by | text | | |
| created_at | timestamptz | not null default now() | |

索引：`(dataset_id, started_at)`（历史对比）、`(namespace, phase)`（运行列表）。

**`eval_case_results`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| run_id | uuid | not null references eval_runs(id) | |
| case_id | text | not null | 数据集内 case id |
| task_id | uuid | references tasks(id) | 驱动产生的真实任务（跳转 trace） |
| expected_output | jsonb | | 期望输出（快照） |
| actual_output | jsonb | | 实际输出（Task.output 快照） |
| dimension_scores | jsonb | | `{dimensionName: score}` 各维度得分 |
| score | numeric(5,4) | not null | case 加权得分 |
| passed | bool | not null | score ≥ passThreshold |
| duration_ms | int | | 执行耗时 |
| tokens_input | int | not null default 0 | 来自 task_trace_events 聚合 |
| tokens_output | int | not null default 0 | |
| detail | jsonb | | 失败原因 / 判定旁证（trace 摘要） |
| created_at | timestamptz | not null default now() | |

索引：`(run_id)`、`(task_id)`（task → 评估反查）、unique `(run_id, case_id)`（重跑幂等）。

### 2.3 枚举/常量

```ts
// src/eval/constants.ts
export const EVAL_RUN_PHASE = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const EVAL_MATCH_TYPE = ['exactMatch', 'partialMatch', 'custom'] as const;
export const EVAL_PASS_THRESHOLD_DEFAULT = 0.7;  // case 通过阈值
export const EVAL_SAMPLE_LIMIT = 100;            // /sample 采样上限（防爆炸）
export const EVAL_LLM_JUDGE_COST_TAG = 'eval-llm-judge'; // custom+LLM 判定的成本独立标注（NFR-05 例外）
```

## 3. 实现设计

### 3.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/eval/constants.ts` | 枚举/常量（§2.3） |
| `src/eval/dataset.ts` | EvalDataset 类型 / zod schema / 版本校验（cases 结构、target 引用存在性） |
| `src/eval/registry.ts` | EvalDataset / EvalRun 注册进 REGISTRY（schemas.ts），接入通用 CRUD / RBAC / 审计 |
| `src/eval/runner.ts` | 评估运行编排器：case → Task（复用 4.5 管线）、并发控制、等待回收、超时/失败隔离 |
| `src/eval/scorer.ts` | 评分器：exactMatch / partialMatch / custom + 加权聚合（FR-1009） |
| `src/eval/sample.ts` | 从 task_trace_events 采样生成 cases 草稿（输入侧自动，期望输出留空） |
| `src/eval/report.ts` | 报告聚合（汇总/明细/历史对比）与查询 |

### 3.2 核心类型与 Schema（zod）

```ts
// src/eval/dataset.ts
export interface EvalScoringDimension {
  name: string;
  matchType: 'exactMatch' | 'partialMatch' | 'custom';
  weight: number;                        // 维度权重（总和 1）
  params?: {                             // 按 matchType 解析
    keywords?: string[];                 // partialMatch 关键词
    similarityThreshold?: number;        // partialMatch 相似度阈值
    customScriptRef?: string;            // custom 脚本引用（复用 Skill/插件脚本机制）
    llmJudgerPrompt?: string;            // custom LLM 判定 prompt（显式计费）
    caseSensitive?: boolean;             // exactMatch 归一化选项
  };
}
export interface EvalCase {
  id: string;
  input: Record<string, unknown>;        // 对齐 4.5 Task.input
  expectedOutput: unknown;               // 期望输出（unknown 兼容文本/JSON）
  expect?: { matchType?: EvalScoringDimension['matchType']; params?: EvalScoringDimension['params'] };
  weight?: number;                       // case 权重（默认 1）
}
// src/eval/runner.ts
export interface EvalRunSpec {
  datasetRef: string; datasetVersion: number;
  targetAgentRef?: string; targetFlowRef?: string;
  concurrency?: number; timeoutSeconds?: number;
  scoringOverride?: Array<{ name: string; weight: number }>;
  caseFilter?: { caseIds: string[] };
}
export interface EvalRunStatus {
  phase: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  totalCases: number; passedCases: number; failedCases: number;
  score: number; reportRef?: string;
  startedAt?: string; finishedAt?: string; lastError?: string;
}
// src/eval/scorer.ts
export interface ScorerInput {
  input: unknown; expectedOutput: unknown; actualOutput: unknown;
  trace?: TraceEventSummary[];           // 评分旁证（耗时/工具/错误）
}
export interface ScorerResult { score: number; passed: boolean; reason?: string; }
export type Scorer = (dimension: EvalScoringDimension, ctx: ScorerInput) => Promise<ScorerResult>;
export function resolveScorer(matchType: string): Scorer;  // 按 matchType 分发（可插拔）
```

### 3.3 核心函数/服务

```ts
// src/eval/runner.ts
export async function startEvalRun(deps: EvalDeps, runId: string): Promise<void>;
  // 加载 dataset 版本快照 → 解析 cases/评分维度 → 并发创建 Task（4.5 管线）
  // → 等待完成 → 采集 output + trace → scorer 逐 case 评分 → 聚合写回 eval_runs + eval_case_results
export async function cancelEvalRun(deps: EvalDeps, runId: string): Promise<void>;
  // 取消 running：级联取消未完成 case Task（复用 4.5 task cancel）→ phase=cancelled
// src/eval/scorer.ts
export async function exactMatchScorer(dim, ctx): Promise<ScorerResult>;
  // 字符串 trim + caseSensitive 归一化后全等；JSON 用 deepEqual
export async function partialMatchScorer(dim, ctx): Promise<ScorerResult>;
  // 关键词命中率 hits/keywords ≥ similarityThreshold，或子串包含/余弦相似度 ≥ 阈值
export async function customScorer(dim, ctx): Promise<ScorerResult>;
  // customScriptRef → 平台脚本执行（复用 Skill/插件脚本机制）；llmJudgerPrompt → modelgw 调用（独立计费 tag）
// src/eval/sample.ts
export async function sampleFromTrace(deps, filter): Promise<EvalCase[]>;
  // 按任务/节点/Agent 从 task_trace_events 关联 task.input 提取，期望输出留空 → 草稿
// src/eval/report.ts
export async function buildReport(deps, runId): Promise<EvalReport>;
  // 汇总：总分/维度得分/通过率/总耗时/Token+成本（与 4.9 成本口径共用）
export async function compareRuns(deps, datasetId): Promise<RunTrend[]>;
  // 同数据集多轮 (dataset_id, started_at) 序列 → 得分趋势/维度波动
```

### 3.4 RESTful API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/eval-datasets` | 数据集列表/创建（创建=version 1） |
| GET/PUT/DELETE | `/api/v1/eval-datasets/{name}` | 详情/更新（PUT 产生新版本）/删除（被引用版本拒绝） |
| GET | `/api/v1/eval-datasets/{name}/versions` | 版本历史 |
| POST | `/api/v1/eval-datasets/{name}/cases` | golden 批量导入（JSON Lines / YAML，FR-1006 API 路径） |
| POST | `/api/v1/eval-datasets/{name}/sample` | 从 task_trace_events 采样生成 cases 草稿（FR-1006） |
| GET/POST | `/api/v1/eval-runs` | 运行列表/创建（phase=pending） |
| GET | `/api/v1/eval-runs/{name}` | 运行详情（含 status） |
| POST | `/api/v1/eval-runs/{name}/start` · `/cancel` · `/rerun` | 生命周期（rerun 生成新实例） |
| GET | `/api/v1/eval-runs/{name}/report` | 评估报告（汇总 + case 明细 + 历史对比） |
| GET | `/api/v1/eval-runs/{name}/cases?page=` | case 级结果分页 |

### 3.5 关键流程实现

**评估运行（start）**：

```
startEvalRun:
1. 读 eval_runs → 校验 phase=pending → 读 eval_datasets（dataset_id + dataset_version 快照）
2. 解析 cases（caseFilter 子集）→ 解析评分维度（scoringOverride 覆盖）
3. 未标注期望输出（expectedOutput === null）→ 拒绝运行（fail-closed，FR-1006）
4. 按 concurrency 并发：每 case 创建 Task（4.5 管线，input=case.input，agentRef/flowRef 解析）
5. 等待各 Task 终态（4.5 租约/重试）；超时 timeoutSeconds 截断 → 该 case 计 failed(timeout)
6. 采集：Task.output → actualOutput；task_trace_events 聚合 → durationMs/tokens
7. scorer 逐 case：dimensionScorer → 加权 → case score → passed（≥ passThreshold）
8. 写 eval_case_results（逐 case）+ eval_runs（汇总：total/passed/failed/score/report）
9. phase = succeeded（完整结束）/ failed（致命错误：引用失效/配额拒绝）
```

**评分聚合（scorer）**：

```
caseScore = Σ(dimScore_i × dimWeight_i)           # 各维度加权
runScore  = Σ(caseScore_j × caseWeight_j) / Σ caseWeight_j
passed    = caseScore ≥ EVAL_PASS_THRESHOLD_DEFAULT（维度/case 可覆盖）
```

**采样（sample）**：

```
sampleFromTrace:
1. 过滤条件（taskId? / nodeId? / agent? / 时间范围）→ 查 task_trace_events 关联 tasks
2. 提取 task.input → EvalCase{ id: "sample-<seq>", input, expectedOutput: null }（草稿）
3. 上限 EVAL_SAMPLE_LIMIT；返回草稿列表（人工补标后入库）
```

**报告（buildReport / compareRuns）**：

```
buildReport:
- 汇总：Σ passed/total、runScore、各维度均分、总 durationMs、Σ tokens + cost（4.9 口径）
- 明细：eval_case_results 分页（含 task_id 跳转 Trace）
- cost 单列 eval-llm-judge tag（custom+LLM 判定独立计费，NFR-05 例外）
compareRuns:
- 同 dataset 的 eval_runs 按 (dataset_id, started_at) 序列 → 得分趋势 + 维度波动表
```

### 3.6 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 单 case Task 失败/超时 | 不中断整体：计 failedCases（detail 记原因），`failFast` 可配全停 |
| 数据集被引用后删除 | 应用层拒绝删除被引用版本；运行引用版本快照，删除不影响已运行记录 |
| 期望输出未标注 | start 前 fail-closed 拒绝（返回校验错误明细） |
| 目标引用失效（agent/flow 不存在） | 运行置 phase=failed + lastError；不创建半量 Task |
| 并发配额拒绝 | 复用 4.5 队列/配额错误码（429），phase=failed 可重试 |
| custom+LLM 判定失败 | 该 case 重试（指数退避），仍失败计 failed(error)，报告标注 |
| 采样无匹配 trace | 返回空草稿 + 200（提示调整过滤条件），非错误 |
| eval_case_results 重跑冲突 | unique(run_id, case_id) → upsert 覆盖（重跑幂等） |
| LLM 判定成本膨胀 | 独立计费 tag + 判定次数上限（每 case 默认 1 次） |

### 3.7 测试要点

- 单元：scorer 三种 matchType（exact 命中/未命中、partial 阈值边界、custom 脚本与 mock LLM 判定）加权聚合正确；constants 枚举完整。
- 集成：mock/opencode executor 驱动"EvalDataset → EvalRun → case Task → 评分 → 报告"闭环，case 失败/超时不中断整体；采样从 fixture trace 正确提取 input 草稿且未标注 case 被拒运行；报告明细与汇总一致，compareRuns 趋势排序正确；被引用数据集删除被拒、重跑幂等。
