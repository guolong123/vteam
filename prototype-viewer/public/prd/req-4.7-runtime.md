<!-- 子文档：对应主 PRD 4.7 章节，由 docs/requirements.md 拆分扩展 -->

# 4.7 运行时（opencode）集成（需求设计说明）

## 模块概述

运行时是 Agent 的实际执行引擎。首个版本固定为 opencode，集成方式为「常驻 `opencode serve` 实例 + 平台作为 HTTP 客户端」：平台不 fork CLI 子进程，而是通过 REST + SSE 驱动会话执行、订阅事件流、管理会话生命周期。本模块解决"如何把外部 Agent 运行时的执行过程转化为平台可编排、可观测、可恢复的受控执行"问题。

本模块与 4.5 Task（任务驱动 opencode 会话执行与断点恢复）、4.6 审批（工具级审批与 opencode permission 联动）、4.9 可观测（SSE 事件转化为 Task Trace）紧密联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-701 | Agent 默认运行时为 **opencode**：平台通过 `opencode serve` 的 HTTP API（REST + SSE）驱动 Agent 执行（常驻 serve 实例 + 平台作为 HTTP 客户端，非 CLI 子进程） | P0 |
| FR-702 | 订阅 opencode serve 的 SSE 事件流（`/event`、`/global/event`），解析步骤/工具调用/结果/Token 消耗，转化为平台 Task Trace | P0 |
| FR-703 | 支持长时间运行任务的会话保持与断线恢复：平台持久化 opencode session id，重启后通过 `GET /session/:id` 恢复续跑；运行中可 `abort` 中止 | P0 |
| FR-704 | 支持每任务独立工作区（worktree / 独立 clone），多任务并行时互不干扰 | P1 |
| FR-705 | 平台工具权限与 opencode 自身权限**双层约束**：opencode 运行中的 permission 请求通过 `/session/:id/permissions/:permissionID` 与平台工具审批（ToolApproval）联动；平台侧另有工具白名单 / 审批 | P1 |
| FR-706 | 支持 Agent 级别的模型 / 参数透传（session 消息 body 的 model/agent 参数、`PATCH /config` 下发 opencode 配置） | P2 |

## 详细设计说明

### 常驻 serve 架构（FR-701）

```
                    ┌──────────────────────────────┐
                    │        opencode serve         │
                    │  REST API      SSE 事件流      │
                    │  /session/:id  /event          │
                    └──────▲───────────────▲────────┘
                           │ HTTP           │ SSE 订阅
                    ┌──────┴───────────────┴────────┐
                    │      Orchestra 运行时桥接层      │
                    │  会话管理 / 事件解析 / 权限联动    │
                    └──────────────────────────────┘
```

设计要点：

- 平台配置 opencode serve 地址（HTTP Base URL），通过设置页维护连接状态与健康检查（对应 `settings` 原型的运行时配置区）。
- 平台作为 HTTP 客户端创建会话、发送消息、读取事件，不依赖 CLI 子进程生命周期，便于 Worker 分布式部署（一个 serve 实例可服务多个 Worker 的任务）。
- serve 连接断开时任务进入可恢复状态，依赖 FR-703 的会话恢复机制续跑。

#### 多实例支持（RuntimeInstance）

- 引入 `RuntimeInstance` 资源：一个可选的 opencode serve 部署实例，字段如下：

| 字段 | 说明 |
|---|---|
| name | 实例名（唯一标识，Agent 通过 `runtimeRef` 引用） |
| endpoint | serve 地址（host:port，即 HTTP Base URL） |
| auth | 认证方式：Basic Auth 用户名/密码，或无认证 |
| defaultWorkdir | 实例默认工作区，Agent 未指定工作目录时使用（见 FR-704） |
| status | 连接状态（正常 / 异常 / 未知），由平台健康检查维护 |

- 平台管理多个 RuntimeInstance：新增 / 编辑 / 删除 / 测试连接（探测 `/global/health`），全局设置页的运行时配置区由单一地址升级为实例列表。
- 多实例使用场景：
  - **环境隔离**：dev / cicd / prod 各部署一个 serve 实例，Agent 按环境选择执行。
  - **就近执行**：不同节点 / 区域部署实例，任务路由到数据近、延迟低的实例。
  - **容灾**：实例故障时任务切换到健康实例，配合 FR-703 会话恢复（工作区路径需在实例间可达或重新 checkout）。
- Agent 创建时通过 `runtimeRef` 引用具体实例（见 4.2），未指定时使用默认实例。

### SSE 事件流与 Trace 转化（FR-702）

- 平台订阅 `/event`（会话级）与 `/global/event`（全局级）事件流，按事件类型映射为 Task Trace 步骤：

| opencode 事件 | Trace 映射 |
|---|---|
| message / step 开始 | step 节点（含模型调用） |
| tool 调用 / 结果 | 工具步骤（记录输入输出摘要、耗时、错误） |
| token 消耗 | 步骤级 token input/output，汇总入 4.9 成本统计 |
| permission 请求 | 暂停点，等待 ToolApproval（FR-606） |
| error | 错误步骤（可分类为可重试 / 非可重试） |

- 事件解析容错：未知事件类型跳过不阻塞；事件乱序时按会话时间戳与序号对齐，保证 Trace 时间线正确。
- Trace 写入是异步批量落盘，避免高频事件阻塞执行路径（性能，NFR-05）。

### 会话保持与断线恢复（FR-703）

- 平台为每个任务持久化 opencode session id 与工作区路径（存储于 Task status，见 4.5）。
- 断线 / 平台重启后，通过 `GET /session/:id` 恢复会话并续跑，从最近 Checkpoint 继续（与 4.6 审批 Checkpoint、4.5 Worker 接管恢复一致）。
- 运行中可发起 `abort` 强制中止：任务进入 Cancelled 终态，Trace 记录中止点与原因。
- 会话恢复失败（serve 不可用 / 会话过期）时任务按可重试错误处理，重试仍失败则进入失败终态。

### 每任务独立工作区（FR-704）

- 每任务使用独立 worktree / 独立 clone，多任务并行互不干扰；工作区路径记录在任务 status 中，重跑与接管 Worker 复用同一路径。
- 工作区生命周期随任务清理：任务终态后按保留策略（保留 / 归档 / 删除）处理，避免磁盘膨胀。
- 工作区隔离是工具副作用隔离的基础：并发任务不会互相覆盖仓库文件。

#### Agent 工作目录（workingDir）

- Agent 可指定 `workingDir`（工作目录，通常是仓库路径），任务在指定路径下执行；未指定时使用所引用 RuntimeInstance 的 `defaultWorkdir`（见上文多实例支持）。
- 工作目录与 worktree 隔离的关系：Agent 级 `workingDir` 决定任务在哪个仓库 / 路径下执行；每任务 worktree 在该工作目录内创建（如 `<workingDir>/.orchestra-worktrees/<task-id>`），隔离并行的任务，两者层级不同、互为补充。
- 校验：工作目录必须位于所引用实例可达的文件系统内（同一主机或共享挂载）；创建任务前校验目录存在且可访问，校验失败任务按可重试错误处理。

### 双层权限约束（FR-705）

- 第一层：平台侧工具白名单（Agent `allowedTools`）与高风险工具审批（ToolApproval，4.6 FR-606），在任务进入运行时前与工具调用落库前生效。
- 第二层：opencode 运行中自身的 permission 请求经 `/session/:id/permissions/:permissionID` 上报，平台根据策略（放行 / 拒绝 / 转人工审批）应答。
- 双层合并规则：两层都放行才执行，任一层拒绝即中止该工具调用；平台策略优先于 opencode 会话内策略（fail-closed，NFR-02）。

### CLI 工具环境安装（Skill 自安装 + 平台审批观测）

设计决策见 ADR-014。核心原则：平台不实现安装器——CLI 依赖安装由 opencode 会话内 Agent 自行完成（skill 描述安装方式），平台负责声明清单、授权审批、执行观测、状态感知四件事。

#### 分层环境策略

| 层级 | 覆盖范围 | 典型 CLI | 安装方式 | 说明 |
|---|---|---|---|---|
| 基础层（镜像预装） | 高频 CLI | git / node / python / gh | 容器镜像 / VM 模板预装 | 保证零安装延迟与确定性（NFR-07） |
| 长尾层（Skill 自安装） | 低频 / 插件 CLI | jenkins-cli / kubectl | 会话内按需安装 | 安装方式由 skill 描述，Agent 自治 |

#### 长尾 CLI 自安装流程

任务开始 → 环境预检（worker 内）：读 `runtime.requirements` → 探测 custom tool 执行 `which` / `--version` → 缺失清单记入 Task 状态（前端可见"环境缺失"）→ 创建会话

任务执行中：skill 描述安装命令（curl / npm i -g / pip install）→ Agent 通过 bash 工具安装 → 安装命令命中 permission ask（如 `"curl *": ask`）→ SSE permission 事件 → ToolApproval → 前端审批 → 应答继续 → 安装 bash 调用 / 成败进 Trace

#### 平台四抓手（解决前端无法管理）

| 抓手 | 载体 | 说明 |
|---|---|---|
| 声明清单 | `runtime.requirements` | Agent 详情显示依赖清单，用户可预知环境要求 |
| 授权审批 | 安装命令 permission ask → ToolApproval | 审批中心出现"环境安装"待审批卡片，人工把关安装动作 |
| 执行观测 | bash 调用进 Trace | 时间线可见"安装 kubectl 成功"，安装过程可回溯 |
| 状态感知 | 预检结果写入 Task status | 任务详情显示缺失项，环境缺口对用户透明 |

#### 安全约束

- 安装命令 permission 规则由平台下发（`PATCH /config`），统一管控安装动作的权限策略。
- 高风险安装（下载执行脚本、写入系统目录等）默认 ask 转人工审批，fail-closed（NFR-02）。
- 安装动作同审计链路（FR-905），审批记录与安装成败一并留痕。
- 安装失败按可重试错误处理，不污染任务状态机。

#### 与原型的关系

- `settings`：运行时分区展示依赖预检状态，用户可查看 Agent 环境缺失项。
- `approval`：承接安装命令触发的 ToolApproval，审批卡片可定位到具体安装命令。
- `task-trace`：安装命令作为 bash 调用进时间线，安装成败一目了然。

### 模型与参数透传（FR-706）

- 创建会话与发送消息时透传 Agent 的 model / agent 参数（与 4.2 模型路由一致）。
- 平台可通过 `PATCH /config` 下发 opencode 配置（模型端点、代理、超时等），全局设置页的运行时配置联动生效。
- 参数透传属于 P2：M1 阶段默认使用 opencode 默认配置，Agent 级模型路由在 M2 随 ModelEndpoint 能力补齐。

### 与原型的关系

- `settings` 全局设置：基础分组展示运行时 opencode serve 地址与连接状态，即 FR-701 的运维视图。
- `runtime-manage` 运行时管理：RuntimeInstance 实例列表（endpoint / 连接状态 / 默认工作区），新增 / 编辑 / 删除 / 测试连接操作，承载 FR-701 多实例运维。
- `agent-create` 新建 Agent：选择运行时实例（`runtimeRef`）+ 设置工作目录（`workingDir`，留空用实例默认工作区），承载 Agent 与 RuntimeInstance 的绑定。
- `task-trace` 任务 Trace 全览：纵向时间线中模型 / 工具 / 审批 / 错误类型色点，是 FR-702 事件转化结果的界面呈现。
- `task-detail` 任务详情：会话恢复状态、abort 中止操作与 Trace 日志面板承载 FR-703 / FR-705 的用户侧交互。

## 界面原型

```prototype
id: settings
title: 全局设置
device: desktop
```

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

| 原型页 | 对应需求 |
|---|---|
| settings（全局设置） | FR-701、FR-801 |
| task-trace（任务 Trace 全览） | FR-901、FR-902 |
| task-detail（任务详情） | FR-107、FR-505 |

## 验收要点

- 任务通过 opencode serve 的 HTTP API 执行，平台进程与 serve 进程可独立启停，serve 重启后任务可恢复续跑。
- 一次 Agent 执行产生的消息、工具调用、Token 消耗在 Task Trace 中按时间线完整呈现。
- 平台重启后未完成任务通过持久化的 session id 恢复，从中断点继续而非从头执行。
- 两个并行任务使用不同工作区，文件操作互不可见；abort 后任务进入 Cancelled 并记录中止点。
- opencode 发出的 permission 请求被平台拦截，批准前不执行对应工具；平台白名单外工具在两层约束下均被拒绝。
