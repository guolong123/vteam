<!-- 子文档：对应主 PRD 4.2 章节，由 docs/requirements.md 拆分扩展 -->

# 4.2 Agent 管理（需求设计说明）

## 模块概述

Agent 是 Orchestra 的一等公民：一个可执行单元，封装提示词、模型引用、工具权限、技能范围与执行上限。本模块解决"如何声明式定义和治理一个 Agent"的问题，让 Agent 像资源一样可版本化、可审计、可复用。平台只负责编排与调度，Agent 的实际推理委托给运行时（首个版本为 opencode）完成。

本模块与 4.3 Skill（Agent 引用技能包）、4.8 插件（工具权限引用的 Tool 来自插件注册）、4.7 运行时（Agent 配置下发给 opencode session）直接联动；Agent 定义本身是 4.4 流程编排中节点的编排对象。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-201 | 在平台页面创建 / 编辑 / 删除 Agent，配置项包括：名称、描述、提示词（prompt）、模型引用、备用模型、工具权限、技能范围、执行上限（最大步数 / 超时 / Token 预算） | P0 |
| FR-202 | Agent 的提示词与配置以声明式 Manifest 存储，支持版本化与 GitOps | P0 |
| FR-203 | 支持 Agent 级别的工具白名单（`allowed_tools`）与角色（roles）权限模型 | P0 |
| FR-204 | 支持 Agent 引用一个或多个 Skill（技能），运行时可加载 | P1 |
| FR-205 | 支持 Agent 的模型路由：主模型 + fallback 备用模型，模型切换不修改 Agent 定义（通过 ModelEndpoint 引用解耦） | P1 |
| FR-206 | 支持 Agent 之间的委托（delegation）：Agent 可派生子任务给其他 Agent，结果回传 | P2 |

## 详细设计说明

### AgentSpec 字段设计（FR-201）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Agent
metadata:
  name: requirement-analyst
  namespace: dev-team
spec:
  description: 负责需求文档与用户故事生成
  prompt: |
    你是资深产品经理，请基于 issue 描述输出需求文档...
  modelRef:
    primary: openai/gpt-4o          # 引用 ModelEndpoint
    fallback: openai/gpt-4o-mini     # 可选，主模型不可用时切换
  allowedTools:
    - github.create_issue_comment
    - github.get_issue
    - lark.send_message
  skills:
    - name: requirement-doc          # 引用 4.3 Skill
      version: "1.2.x"               # 版本范围，运行时可解析
  roles:
    - product-manager
  limits:
    maxSteps: 50                     # 最大推理步数
    timeoutSeconds: 1800             # 单次任务超时
    tokenBudget: 200000              # Token 预算，超限终止
  runtime: opencode                  # 默认运行时，可扩展
  runtimeRef: runtime-dev            # 引用 RuntimeInstance（见 4.7）；未指定用默认实例
  workingDir: /workspaces/requirement   # Agent 工作目录（仓库路径）；留空用实例默认工作区（FR-704）
```

设计要点：

- `prompt` 为 Agent 核心资产，与 Skill 模板合并后的最终提示词在任务创建时快照存档，保证结果可复现。
- 所有配置字段均可在 Web 控制台编辑，底层序列化为同一份 YAML Manifest（FR-202），`apply` 后产生新版本。
- 删除约束：被 Flow 引用为节点的 Agent 禁止删除，需先解除引用或提示级联影响。
- `runtimeRef`：Agent 引用的 opencode 实例（RuntimeInstance 资源名，见 4.7 多实例支持）；未指定时使用默认实例。实例决定任务执行的 endpoint、认证方式与默认工作区。
- `workingDir`：Agent 运行的工作目录（仓库路径，即上例 `workingDir` 字段）；留空时使用所引实例的默认工作区（`defaultWorkdir`）。每任务 worktree 在该目录内创建，隔离并行任务（见 4.7 FR-704）。

### 工具白名单与角色权限（FR-203）

- `allowedTools` 引用插件注册的工具全名（`<plugin>.<tool>`），运行时只注入白名单内的工具，白名单外的调用在平台侧直接拒绝并审计（fail-closed，见 FR-705 双层约束）。
- 工具可携带 `risk` 等级：普通 / 高风险。高风险工具（删除资源、推送代码）要求 Agent 启用"需审批"开关，运行中触发 4.6 工具级审批（ToolApproval）。
- `roles` 用于语义分组与审计归属，审批人可通过"按角色匹配"承接相关 Agent 的审批（FR-607）。

### 模型路由（FR-205）

- 平台维护全局 ModelEndpoint 资源（含 API 地址、模型名、配额），Agent 只引用 `modelRef`，模型变更不动 Agent 定义。
- Fallback 触发条件：主模型 429 / 5xx / 超时，或达到主模型的配额上限；切换事件写入任务 trace。
- 备用模型也需满足 Agent 的能力下限校验（如上下文窗口大小），不满足则直接标记任务失败而非降级运行。

### Skill 引用与委托（FR-204 / FR-206）

- Skill 引用支持精确版本与范围版本，任务创建时解析为快照；Skill 卸载后，引用它的 Agent 在下次编辑时提示断链。
- 委托（delegation，P2）：Agent 通过委托工具派生子任务给其他 Agent，父任务等待子任务结果回传。设计约束：
  - 委托深度上限（默认 3 层），防止委托环与爆炸；
  - 子任务继承父任务命名空间与权限上下文，但不继承 Token 预算（独立核算，见 4.9）；
  - 委托关系记录在父子 Task 的 trace 中，支持从任一 Task 双向跳转。

### Agent 生命周期

```
Draft ──▶ Active ──▶ Disabled
   ▲         │           │
   └─────────┴───────────┘  （可回到 Draft 修改再发布）
```

- Draft 可自由编辑；Active 为可被 Flow / 任务引用的状态；Disabled 后不再接受新任务，运行中的任务不受影响（与流程版本策略一致，FR-408）。

### 与原型的关系

- `agent-list` Agent 管理列表：表格展示模型 / 工具数 / 技能 chips / 状态 badge，支持搜索、筛选与新建入口。
- `agent-create` 新建 Agent 向导：4 步流程（基本信息 → 模型配置 → 提示词与技能 → 工具与权限），其中工具权限表包含"高风险工具需审批"开关，直接对应 FR-201 / FR-203。
- `agent-create` 向导中增加运行时实例选择（`runtimeRef`，选项来自 4.7 `runtime-manage` 的实例列表）与工作目录输入（`workingDir`，留空用实例默认工作区），对应 4.7 多实例支持。
- `runtime-manage` 运行时管理：RuntimeInstance 实例列表与默认工作区设置，是 Agent `runtimeRef` 引用的维护入口（见 4.7）。
- `settings` 全局设置：运行时 opencode 配置与模型端点属于 Agent 模型路由的底层依赖，此处展示连接状态。

## 界面原型

```prototype
id: agent-list
title: Agent 管理
device: desktop
```

```prototype
id: agent-create
title: 新建 Agent 向导
device: desktop
```

```prototype
id: settings
title: 全局设置
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| agent-list（Agent 管理） | FR-201 ~ FR-205 |
| agent-create（新建 Agent） | FR-201 |
| settings（全局设置） | FR-701、FR-801 |

## 验收要点

- 通过 4 步向导创建的 Agent 能导出为完整 YAML Manifest，并能反向 `apply` 回平台，字段不丢失。
- Agent 只暴露 `allowedTools` 白名单内的工具，白名单外工具调用被拒绝并写入审计。
- 主模型返回 429 时任务自动切换到备用模型，trace 中记录切换事件，Agent 定义文件无改动。
- Agent 被 Flow 引用时禁止删除；Skill 卸载后引用该 Skill 的 Agent 在编辑时出现断链提示。
- 委托场景下父 Task 与子 Task 通过 trace 双向可达，且子任务不继承父任务 Token 预算。
