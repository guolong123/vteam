<!-- 子文档：对应主 PRD 4.11 章节，由 docs/requirements.md 拆分扩展 -->

# 4.11 Eval 评估体系（需求设计说明）

## 模块概述

Eval 评估体系解决"如何衡量 Agent 输出质量"的问题：把一组带期望输出的**golden 样例**（`EvalDataset`）喂给评估目标（Agent 或 Flow），通过复用现有任务执行链路真实跑出结果，再按可配置的**评分维度**对比打分，最终聚合成一份可追溯的**评估报告**。它是 M3 差异化能力：让 Agent 的提示词/工具/模型调整有可量化的回归依据。

本模块与 4.5 Task（评估运行驱动真实 Task 执行）、4.9 可观测（采样 `task_trace_events` 生成 golden 数据、采集 trace 作为评分素材）、4.2 Agent（评估目标引用 `agentRef`）、4.4 Flow（评估目标引用 `flowRef`）直接联动。评估运行本身是确定性编排逻辑，不额外消耗模型 Token（沿用 NFR-05）；自定义评分维度中的 LLM 判定除外，会显式标注并独立计费。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-1005 | **EvalDataset（golden 数据集）资源**：创建 / 编辑 / 删除 / 版本管理，定义 golden 样例（输入 + 期望输出 + 判定规则）与评分维度（可配置权重） | P1 |
| FR-1006 | **golden 数据来源与录入路径**：支持手工录入、API 批量导入、从 `task_trace_events` 历史采样三种方式生成数据集 | P1 |
| FR-1007 | **EvalRun（评估运行）资源**：创建评估运行（关联 EvalDataset 与固定版本、评估目标、并发与超时配置），状态 phase 跟踪，支持 start / cancel / rerun 生命周期 | P1 |
| FR-1008 | **评估运行流程**：golden 输入 → 驱动 Task（复用 TaskExecutor / opencode）→ 采集 trace 与输出 → 对比评分 → 报告聚合 | P1 |
| FR-1009 | **评分维度可配置**：支持精确匹配（exactMatch）/ 部分匹配（partialMatch）/ 自定义判定（custom，脚本或 LLM 判定），维度与 case 可配权重，支持通过阈值（passThreshold） | P1 |
| FR-1010 | **评估报告输出与查看**：报告聚合（总分 / 各维度得分 / 通过率 / case 级明细 / 耗时 / Token 成本），支持同数据集多轮运行的历史对比 | P1 |

## 详细设计说明

### EvalDataset 资源模型（FR-1005）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: EvalDataset
metadata:
  name: code-review-golden
  namespace: dev-team
spec:
  description: 代码评审 Agent 的 golden 评估集
  targetAgentRef: code-reviewer       # 评估目标：Agent（与 targetFlowRef 二选一）
  targetFlowRef: ""                   # 评估目标：Flow
  scoringDimensions:                  # 评分维度（FR-1009），运行时可被 EvalRun 覆盖
    - name: correctness
      matchType: partialMatch
      weight: 0.6
      params:
        keywords: ["安全", "边界", "性能"]
        similarityThreshold: 0.8
    - name: format
      matchType: exactMatch
      weight: 0.4
  cases:
    - id: case-001
      input: { issue: "评审：用户输入未做长度限制" }   # golden 输入，作为 Task.input
      expectedOutput: "指出输入校验缺失，并给出 maxLength 建议"
      expect:                                     # 可选：覆盖数据集级判定规则
        matchType: partialMatch
        params: { keywords: ["校验", "maxLength"] }
      weight: 1                                    # 可选：case 权重（默认 1）
```

设计要点：

- `EvalDataset` 按 `(namespace, name, version)` 版本化管理，**version 不可变**：评估运行必须固定引用创建时点的版本（快照语义），数据集后续编辑产生新版本，不回溯影响已运行记录。
- `targetAgentRef` 与 `targetFlowRef` 二选一指定评估目标：Agent 评估时平台构造单节点 Flow 驱动执行，Flow 评估时直接以指定 Flow 运行（对齐 4.4 子流程/4.2 委托的复用语义）。
- 删除约束：被任一 EvalRun 引用过的数据集禁止删除（提示级联影响，与 Agent 被 Flow 引用的删除约束一致，FR-202）。
- `cases[].input` 的结构与 4.5 Task 的 `input` 对齐，保证 golden 输入可直接驱动任务执行。

### golden 数据来源与录入路径（FR-1006）

| 路径 | 方式 | 说明 |
|---|---|---|
| 手工录入 | 控制台表单 / JSON 编辑器 | 逐条添加 case（输入 / 期望输出 / 判定规则），适合小样本与人工精标注 |
| API 导入 | `POST /api/v1/eval-datasets/{name}/cases` | 批量导入（JSON Lines / YAML），适合从测试资产或外部评估集迁移 |
| 历史采样 | `POST /api/v1/eval-datasets/{name}/sample` | 从 `task_trace_events`（4.9）按任务 / 节点 / Agent 提取历史 `Task.input` 生成 cases 草稿，期望输出留空待人工确认后补标（或标记为"参考样本"） |

设计要点：

- 采样是**草稿生成**：只自动提取输入侧（`task.input`）与执行元信息（Agent、节点、耗时），期望输出必须人工确认或补标后数据集才可运行（fail-closed，避免无标注数据跑分失真）。
- 三种路径产出的数据集结构一致，统一走 cases 校验（输入结构 / 期望输出类型 / 判定规则合法）。

### EvalRun 资源模型与生命周期（FR-1007）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: EvalRun
metadata:
  name: code-review-run-20260803
  namespace: dev-team
spec:
  datasetRef: code-review-golden
  datasetVersion: 1                    # 运行固定数据集版本（不可变快照）
  targetAgentRef: code-reviewer        # 可选：覆盖数据集级评估目标
  concurrency: 3                       # 并行驱动 Task 数（受 4.5 worker 容量约束）
  timeoutSeconds: 3600                 # 单 case 执行超时
  scoringOverride:                     # 可选：覆盖数据集级评分配置
    - name: correctness
      weight: 0.7
  caseFilter:                          # 可选：仅运行指定子集（回归局部验证）
    caseIds: ["case-001", "case-002"]
status:
  phase: pending                       # pending | running | succeeded | failed | cancelled
  totalCases: 10
  passedCases: 7
  failedCases: 3
  score: 0.72                          # 加权总分（0~1）
  reportRef: eval-run-20260803-report  # 报告引用（FR-1010）
  startedAt: "2026-08-03T10:00:00Z"
  finishedAt: "2026-08-03T10:05:30Z"
  lastError: ""
```

状态机：

```
pending ──start──▶ running ──完成──▶ succeeded
   ▲                  │  └─失败/部分失败──▶ succeeded（含 failedCases）
   │                  ├─取消──▶ cancelled
   │                  └─致命错误──▶ failed
   └─────────rerun────────┘
```

- `succeeded` 语义：运行过程完整结束（允许部分 case 失败，计入报告）；`failed` 指运行本身被致命错误中断（如目标引用失效、并发配额拒绝）。
- rerun 生成新的 EvalRun 实例，保留原记录与报告，供历史对比（FR-1010）。

### 评估运行流程（FR-1008）

```
EvalRun start
→ 读取 EvalDataset 指定版本快照 → 解析 cases 与评分维度
→ 按 concurrency 为每个 case 创建 Task：
    · 目标为 Agent：构造单节点 Flow（targetAgentRef）后走标准任务管线
    · 目标为 Flow：targetFlowRef + case.input 直接实例化
    （均复用 4.5 任务执行 / 租约 / 重试链路，执行侧复用 4.7 opencodeExecutor）
→ 等待各 Task 完成（超时 / 失败按 case 处理）
→ 采集评估素材：
    · Task.output = 实际输出
    · task_trace_events（4.9）= 耗时 / Token / 工具调用 / 错误，作为评分与报告的旁证
→ 评分器按评分维度逐 case 对比 expectedOutput vs actualOutput
→ 聚合：case 得分加权 → 总分 / 通过率 / 维度得分
→ 写入 EvalRun.status + 报告 → phase = succeeded / failed
```

设计要点：

- 评估运行**复用任务执行链路而非自建执行引擎**（对齐 development-plan M3-8"依赖 M3-4"的方向：评估目标可以是外部 Agent，经 A2A 注册后同样走 Task 管线），保证评估结果与线上行为一致。
- 每个 case 独立 Task，天然获得幂等、重试、trace 与成本计量（4.5 / 4.9），case 间互不阻塞。
- 编排决策（创建 Task、评分、聚合）为确定性逻辑，不消耗模型 Token（NFR-05）。

### 评分维度（FR-1009）

| matchType | 判定方式 | 适用场景 |
|---|---|---|
| `exactMatch` | 字符串归一化（trim / 大小写可配）后全等；JSON 输出用深比较 | 结构化输出、固定格式（JSON / 列表） |
| `partialMatch` | 关键词命中率、子串包含、相似度阈值（如余弦相似度） | 自然语言输出、要点覆盖检查 |
| `custom` | `customScriptRef` 引用平台脚本资源（复用 4.3 Skill / 4.8 插件脚本机制）或 `llmJudgerPrompt` 走 LLM 判定 | 复杂业务规则、主观质量评估 |

- 维度级 `weight` 决定总分构成，case 级 `weight` 决定样本重要度；case 得分 = 各维度得分按 weight 加权。
- `passThreshold`（默认 0.7）：case 得分 ≥ 阈值计为 passed，否则 failed；报告同时保留连续分值而非只记布尔。
- `custom` + LLM 判定显式标注会消耗模型 Token：评估报告单独统计该项成本，不并入"编排零 Token"口径（NFR-05 例外说明）。

### 评估报告（FR-1010）

- **汇总层**：总分（0~1）、各维度得分、通过率（passed / total）、总耗时、总 Token 与成本（复用 4.9 聚合口径）。
- **明细层**：case 级记录（输入 / 期望输出 / 实际输出 / 各维度得分 / 通过判定 / 耗时 / Token / 关联 Task 跳转）。
- **对比层**：同 `EvalDataset` 多轮 EvalRun 的趋势（得分变化、维度波动），支持定位"调整提示词后哪类 case 变好 / 变差"。

### 与原型的关系

- 评估相关界面（数据集管理、运行列表与详情、报告页）为 M3 实现期新增原型页（`eval-dataset` / `eval-run` / `eval-report`），按 prototype-viewer 三步注册机制接入，当前 PRD 阶段无独立原型页。
- `task-trace`（4.9）作为评分素材与 case 明细的跳转目标复用。
- `dashboard` 平台总览可在 M3 增加"最近评估"卡片（FR-903 联动展示评估成本）。

## 界面原型

> Eval 评估页为 M3 实现期新增原型（注册机制见 prototype-viewer README），当前需求阶段以资源模型与接口契约为准。

## 验收要点

- 创建含 3 个评分维度（精确 / 部分 / 自定义各一）与至少 5 个 case 的 EvalDataset 后，发起 EvalRun 能对目标 Agent 输出跑分并产出报告。
- 三种评分维度均有用例验证判定正确：exactMatch 命中 / 未命中、partialMatch 阈值边界、custom 脚本与 LLM 判定各一。
- golden 数据三种录入路径可用：手工逐条、API 批量导入（JSON Lines）、从历史 trace 采样生成草稿且未标注 case 被拒运行。
- 评估运行期间每个 case 对应一个可跳转的真实 Task（含 trace），case 执行失败不中断整体运行（计入 failedCases）。
- 报告可查看 case 级明细（输入 / 期望 / 实际 / 得分）与汇总（总分 / 维度 / 通过率 / 成本），同一数据集两轮运行可对比得分趋势。
- 引用过数据集的 EvalRun 删除被拦截；数据集编辑产生新版本不影响已运行记录的固定版本快照。
