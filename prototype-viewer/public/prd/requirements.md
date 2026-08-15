# Orchestra 通用任务编排平台 — 需求规格说明书（PRD）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.2（草案） |
| 编写日期 | 2026-08-03 |
| 文档状态 | 待评审 |
| 项目代号 | Orchestra |

---

## 1. 项目概述

### 1.1 背景

当前市面上的 AI Harness / Agent 工具大多以"单一主会话"方式运行：所有产物（计划、需求、设计、代码）都基于当前代码仓库即时生成，缺少**组织化的流程管理**——没有角色分工、没有阶段产物、没有人工评审关卡、没有可追溯的归档。

我们设想一种"像真实公司一样运转"的软件交付方式：GitHub issue 触发后，产品经理 Agent 产出需求文档与原型 → 人工评审通过 → 架构师产出设计文档、测试工程师产出测试用例（并行）→ 开发工程师产出 PR → CI/CD 自动部署测试环境 → 测试工程师 Agent 执行测试 → 人工验收后归档关闭。

### 1.2 定位

**Orchestra 是一个通用的任务编排平台**，而非"开发流程专用工具"：

- **平台本身与业务流程分离**：平台只提供编排内核（Agent 定义、流程编排、任务执行、审批、可观测），业务（如"软件公司开发流程"）以可安装的**业务包 / 模板**形式按需加载。
- **只做编排，不做实现**：具体的执行（编码、测试、构建、部署）交给专业工具完成，平台通过**插件 / 协议**对接（如 opencode、Jenkins、GitHub、Gitee 等）。
- **Agent 是一等公民**：Agent 的提示词、工具权限、技能范围、模型、运行时均可声明式配置。

### 1.3 目标

1. 提供声明式 + 可视化双模式的 Agent 与流程编排能力。
2. 支持多角色 Agent 协作（产品经理 / 架构师 / 测试工程师 / 开发工程师等），通过图编排串联，支持条件、并行、循环。
3. 支持人工审批关卡（approve / reject / request-changes），人类在关键阶段保留决策权。
4. 通过 MCP / 插件机制对接第三方系统（Jenkins、GitHub、Gitee、企业微信等），平台本身不绑定具体业务系统。
5. 任务支持多种触发方式（手动、定时、Webhook、IM 消息）。
6. 全链路可观测与审计：执行 trace、日志、Token 成本、审批记录。

### 1.4 非目标（本版本不做）

- 不做大模型训练 / 微调。
- 不内置代码托管、CI/CD、IM 等业务系统，只做对接。
- 不限制 Agent 的推理模式 / 框架（Agent 可基于 opencode、Claude Code、Codex 等运行时，首个版本运行时为 opencode）。

---

## 2. 名词与核心概念

| 概念 | 定义 |
|---|---|
| **Agent** | 一个可执行单元，包含提示词（prompt）、模型引用（model_ref）、工具权限、技能范围、执行上限（步数/超时）、运行时实例引用（runtime_ref）、工作目录（working_dir）、角色。运行时默认使用 opencode。 |
| **Skill（技能）** | 可复用的能力包（prompt 模板 + 工具绑定 + 说明文档），可被多个 Agent 引用。 |
| **Tool（工具）** | 一次原子能力调用（调用 GitHub API、触发 Jenkins 构建等），通过插件 / MCP 提供。 |
| **Plugin（插件）** | 第三方系统对接单元（如 Jenkins 插件、GitHub 插件、Gitee 插件），安装后注册一组 Tool 及配置界面。 |
| **Flow（流程）** | 对多个 Agent 的编排图：节点 = Agent，边 = 转移条件（顺序 / 条件 / 并行 / 循环）。 |
| **Task（任务）** | Flow 的一次运行实例，包含输入、状态、trace、输出、审批记录。 |
| **Approval（审批）** | 人工决策关卡，可挂载在流程节点之后或流程结尾；决策为 Approve / Reject / Request-Changes。 |
| **Blueprint（业务包/模板）** | 一组可安装的声明式资源集合（Agent 定义 + Flow + 审批点 + 默认配置），实现"平台与业务分离"。 |
| **Namespace（命名空间）** | 多租户隔离单位：Agent / Flow / 凭证 / 任务按命名空间隔离。 |
| **Runtime（运行时）** | Agent 的实际执行引擎。首个版本为 opencode（常驻 serve 实例方式），支持多实例（RuntimeInstance），Agent 选择实例执行。 |

---

## 3. 用户角色

| 角色 | 职责 | 关注点 |
|---|---|---|
| **平台管理员** | 命名空间管理、RBAC、插件安装、系统配置 | 治理、安全、审计 |
| **流程设计师** | 创建 Agent、设计 Flow、配置审批关卡 | 编排能力、版本管理 |
| **任务发起人** | 手动触发 / 查看任务、配置定时与 Webhook | 使用便捷性、状态可见 |
| **审批人** | 对审批关卡做出决策 | 审批通知、上下文可读性 |
| **Agent 执行者** | （系统角色）按流程定义执行任务 | — |

---

## 4. 功能需求

> 优先级定义：**P0** = MVP 必须；**P1** = 重要，Release 2；**P2** = 增强，后续迭代。

### 4.1 ~ 4.11 功能模块（详细设计见子文档）

> 每个功能模块的**详细需求设计说明**（核心概念、字段设计、状态机、边界情况、界面原型引用）已拆分为独立子文档，
> 在 prototype-viewer 文档视图（`#docs`）中以树形目录展示（挂在"需求规格说明书"下）。各模块需求编号汇总如下：

| 子文档 | 模块 | 需求编号 | 优先级 |
|---|---|---|---|
| [4.1 平台基础与治理](requirements/req-platform) | 命名空间 / RBAC / 审计 / API / 声明式资源 / CLI | FR-101 ~ FR-112 | P0（多数）+ P1/P2 |
| [4.2 Agent 管理](requirements/req-agent) | Agent 配置 / 模型路由 / 工具权限 / 委托 / 运行时引用 / 工作目录 | FR-201 ~ FR-206 | P0 |
| [4.3 Skill 管理](requirements/req-skill) | 技能包 / 版本 / 依赖 / 市场 | FR-301 ~ FR-303 | P1 |
| [4.4 流程编排](requirements/req-flow) | DAG / 条件 / 并行汇合 / 循环 / 审批关卡 / 版本 | FR-401 ~ FR-411 | P0（多数） |
| [4.5 任务执行与触发](requirements/req-task) | 手动 / 定时 / Webhook / 重试 / Worker | FR-501 ~ FR-507 | P0（多数） |
| [4.6 人工审批](requirements/req-approval) | 审批状态机 / 恢复 / 打回 / TTL / 工具级审批 | FR-601 ~ FR-608 | P0 |
| [4.7 运行时集成](requirements/req-runtime) | opencode serve 多实例 / SSE / 会话恢复 / 权限联动 | FR-701 ~ FR-706 | P0（多数） |
| [4.8 插件市场](requirements/req-plugin) | 插件安装 / MCP / 凭证隔离 / 沙箱 | FR-801 ~ FR-806 | P0（多数） |
| [4.9 可观测性](requirements/req-observability) | Trace / 日志 / 成本 / 指标 / 审计 | FR-901 ~ FR-905 | P0（多数） |
| [4.10 通知与 IM](requirements/req-notify) | Webhook / 企业微信 / 飞书钉钉 / IM 触发 | FR-1001 ~ FR-1004 | P1 |
| [4.11 Eval 评估](requirements/req-eval) | golden 数据集 / 评估运行 / 评分维度 / 评估报告 | FR-1005 ~ FR-1010 | P1 |
| [4.12 认证与用户管理](requirements/req-auth) | 密码登录 / 存量用户兼容 / 用户管理 / /me | FR-113 ~ FR-116 | P0（113/114）+ P1（115）/P2（116） |

> 各模块完整 FR 需求表、详细设计说明、界面原型引用见对应子文档。

#### 4.1 平台基础与治理 — CLI（命令行工具）功能需求（FR-108 ~ FR-112）

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-108 | 提供**命令行工具（CLI，基于 cliyard）**作为平台的 AI/自动化操作入口：命令与 REST API 一一映射（资源=命令组、动词=子命令），覆盖 Agent / Flow / Task / Approval / RuntimeInstance / Plugin / McpServer / Skill / Secret / Webhook / Namespace 等资源管理 | P1 |
| FR-109 | CLI 支持确定性无交互调用（非必填参数走默认值）、默认 **JSON 输出**（AI 可解析），可选表格输出供人阅读；错误输出携带 API 错误码（如 RESOURCE_NOT_FOUND） | P1 |
| FR-110 | CLI 认证与配置：通过 `_auth.yaml` 配置链（环境变量 `ORCHESTRA_TOKEN` / 登录换取 Bearer / 注入 Authorization），AI 场景 token 不落盘明文；支持多环境切换 | P1 |
| FR-111 | CLI 支持任务级操作与自省：`task get --trace --json` 获取结构化执行 Trace、审批决策（approval decide）、生命周期动作（cancel/retry/pause/resume）等 | P2 |
| FR-112 | CLI specs（命令定义 YAML）随平台仓库维护，与 RESTful API 演进同步；开发期 Library 模式（create_cli 动态生成），交付 Gen 模式生成独立包 | P2 |

> CLI 定位：**Web 前端给人用（可视化），CLI 给 AI/Agent/自动化用**（opencode 编码工具、脚本、CI 确定性操作平台）。命令树、specs 目录与资源 YAML 示例见架构设计「CLI 设计」与详细设计「CLI 实现设计」章节。

### 4.12 界面原型（UI Prototypes）

> 平台 Web 控制台的界面原型已在独立子项目 `prototype-viewer/`（Vite + React + TS + Tailwind v4）中以**可运行代码**形式落地，作为需求的可视化基准与后续开发依据。
>
> 模板能力：原型页面注册机制（`src/prototypes/registry.ts`）、PC / 移动端设备模拟切换、URL hash 直达（`#<id>`）、分组导航。
> 运行方式：`cd prototype-viewer && npm run dev` → http://localhost:5173/

| 原型页 | 对应需求 | 页面说明 |
|---|---|---|
| **平台总览**（`dashboard`） | FR-105、FR-903 | 平台首页：任务统计卡、运行中任务、待审批列表、系统健康（opencode serve 连接）、命名空间任务分布 |
| **流程定义**（`flow-list`） | FR-408 | 流程列表：版本 / 节点数 / 审批关卡数 / 状态（已发布 / 草稿 / 已停用），新建 / 编辑 / 发布 / 复制 / 停用 |
| **流程详情**（`flow-detail`） | FR-408 | 流程详情：概览（节点清单 / 审批 Gate / 触发方式）、版本历史（v1→v3、查看差异）、执行记录三 tab |
| **流程编排画布**（`flow-editor`） | FR-410、FR-401~406 | 核心交互页：节点库（Agent / 审批 Gate / 并行分支）+ SVG 连线 DAG 画布 + 属性面板（节点可点选联动）。数据驱动（NODES / EDGES / NODE_DETAILS），为真实编辑器预留扩展位 |
| **Agent 管理**（`agent-list`） | FR-201~205 | Agent 表格：模型 / 工具数 / 技能 chips / 状态 badge，搜索 + 筛选 + 新建 |
| **新建 Agent**（`agent-create`） | FR-201 | 4 步创建向导：基本信息 → 模型配置 → 提示词与技能 → 工具与权限（工具权限表 + 高风险工具需审批开关） |
| **任务列表**（`task-list`） | FR-105 | 任务表格：状态筛选、进度条、状态 badge（运行中 / 成功 / 失败 / 等待审批） |
| **任务详情**（`task-detail`） | FR-107、FR-505 | 执行进度步骤列表 + 深色 Trace 日志面板 + 审批待办提示 + 生命周期操作（暂停 / 恢复 / 重跑 / 取消） |
| **任务 Trace 全览**（`task-trace`） | FR-901、FR-902 | 纵向时间线 Trace：模型 / 工具 / 审批 / 错误类型色点，类型筛选，步骤点击展开请求 / 响应详情 |
| **触发器配置**（`trigger-manage`） | FR-502、FR-503 | 定时（cron 表达式 / 下次触发）与 Webhook（路径 / 签名状态）双 tab，启停 switch |
| **审批中心**（`approval`） | FR-601~605、FR-607 | 待审批列表：统计卡（待审批 / 已处理 / 平均耗时）、通过 / 驳回 / 打回操作 |
| **审批详情**（`approval-detail`） | FR-608 | 产物预览（Markdown 风格需求文档渲染）+ 审批信息（提交人 / Agent / Checkpoint / TTL）+ 决策区 + 审批历史轮次 |
| **蓝图市场**（`blueprint-market`） | FR-411 | 业务包市场：内容统计（N Agent / 流程 / 审批关卡）、安装到指定命名空间弹窗 |
| **插件市场**（`plugin-market`） | FR-801~803 | 插件卡片：Jenkins / GitHub / Gitee / MCP / 企业微信 / PostgreSQL，来源 badge、安装 / 配置状态 |
| **MCP 服务管理**（`mcp-server`） | FR-803 | MCP 服务注册（本地 stdio / 远程 HTTP）、连接状态、工具自动发现与风险标注 |
| **工具管理**（`tool-manage`） | FR-203、FR-801 | 已注册工具统一视图：来源（内置/插件/MCP）、风险等级、Agent 白名单引用 |
| **运行时管理**（`runtime-manage`） | FR-701 | opencode serve 多实例管理：列表 / 连接状态 / 新增编辑 / 默认工作区 |
| **Skills 管理**（`skill-manage`） | FR-301~303 | 分类栏（提示词 / 工具绑定 / 模板）+ 技能卡片（版本 / 适用 Agent 数 / 发布状态） |
| **凭证管理**（`secret-manage`） | NFR-01、FR-103 | 凭证表格（掩码展示 `sk-••••`）、类型 badge、新建弹窗、过期 / 轮换预警 |
| **命名空间管理**（`namespace-manage`） | FR-101、FR-102 | 多租户卡片：成员数 / 资源统计 / 凭证配额进度条 / system 保留标记 |
| **审计日志**（`audit-log`） | FR-106、FR-905 | 审计记录：操作类型 / 操作者 / 时间范围筛选，资源变更与审批决策记录，详情展开 |
| **全局设置**（`settings`） | FR-701、FR-801 | 左侧分组导航：基础（通用 / 运行时 opencode serve 多实例列表与连接状态）+ 集成（Jenkins / GitHub / Gitee / 企业微信 插件卡片，插件安装后联动显示设置项） |

> 说明：上表 19 个原型页为 v0.1 需求阶段的可视化基准；新增原型页按 `prototype-viewer/README` 的三步注册机制即可（创建组件 → 注册 registry → 自动出现在导航），无需改动模板。原型页数据（流程"软件公司开发流程 v3"、Agent 命名、审批人、命名空间）相互呼应，可作为后续开发联调的样例数据。

#### 4.12.1 原型嵌入标记（PRD 内嵌原型）

PRD 阅读器（`prototype-viewer` 的 PRD 视图）支持在本文档中通过**原型标记**直接内嵌可交互原型。标记格式为标准 Markdown fenced code block（语言 `prototype`），在普通 Markdown 编辑器 / GitHub 中显示为代码块，在 PRD 阅读器中渲染为可交互原型（支持 PC / 移动端切换）。

**块级标记（推荐，可内嵌原型）：**

````markdown
```prototype
id: agent-list        # 必填：原型注册 id（registry.ts 中的 meta.id）
title: Agent 管理     # 可选：覆盖显示标题
device: desktop       # 可选：desktop | mobile，默认 desktop
height: 520           # 可选：内嵌高度 px，默认 640
```
````

**清单标记（自动列出本 PRD 引用的所有原型）：**

````markdown
```prototype-list
```
````

**内联标记（段内提及，渲染为引用样式）：** `@prototype[agent-list]`

**示例——4.12 核心原型内嵌：**

```prototype
id: flow-editor
title: 流程编排画布（核心交互）
device: desktop
```

```prototype
id: approval-detail
title: 审批详情
device: desktop
```

```prototype
id: agent-create
title: 新建 Agent 向导
device: mobile
```

```prototype-list
```

---

## 5. 非功能需求

| 编号 | 类别 | 需求 |
|---|---|---|
| NFR-01 | 安全 | 凭证（API Key / Token）加密存储（AES），绝不落明文；Webhook 请求签名校验；工具调用 SSRF 防护（默认禁止访问内网 / 云元数据地址） |
| NFR-02 | 安全 | 治理规则执行期强制（fail-closed）：未授权动作在运行时被拒绝并记录，而非仅文档约定 |
| NFR-03 | 可靠性 | 任务执行支持持久化（Postgres）与断点恢复；进程崩溃后任务可恢复继续 |
| NFR-04 | 可靠性 | 幂等：定时 / Webhook / 消息重复投递不产生重复执行 |
| NFR-05 | 性能 | 编排内核本身不消耗模型 Token（编排决策为确定性逻辑，非 LLM 调用） |
| NFR-06 | 可扩展 | 平台内核与业务解耦：新增业务域 = 新增 Blueprint / 插件，不改平台代码 |
| NFR-07 | 部署 | 支持单机（内存存储 + 内嵌 worker）到生产（Postgres + 分布式 worker + 消息总线）的平滑演进，同一资源模型 |
| NFR-08 | 兼容 | 所有第三方对接优先走标准协议（MCP / A2A / REST），不绑定单一系统 |

---

## 6. 技术约束与架构原则

1. **平台与业务分离**：平台内核（编排 / 执行 / 审批 / 可观测）与业务内容（Agent 定义、Flow、审批点、产物 schema）严格解耦；业务以声明式资源 + Blueprint 形式按需安装。
2. **只做编排、不做实现**：具体执行委托给外部工具（opencode 负责编码，Jenkins 负责构建部署，GitHub / Gitee 负责代码托管），平台通过插件 / 协议对接。
3. **声明式优先**：一切皆资源（Agent / Flow / Task / Secret / Plugin / Approval），YAML Manifest 可版本化、可评审、可审计。
4. **人工在环**：审批关卡为结构强制（非 prompt 建议），未批准不推进。
5. **参照实现**：架构对标 Orloj（K8s 风格资源模型 + 控制器 + 审批状态机 + MCP 工具层），执行模型采用"调度外部 CLI Agent（opencode）"模式（参考 Red Queen 的确定性状态机设计）。
6. **首个版本运行时固定为 opencode**，后续可通过插件扩展其他运行时（Claude Code / Codex 等）。

---

## 7. 需求优先级与里程碑

| 里程碑 | 范围 | 对应需求 |
|---|---|---|
| **M1（MVP）** | 平台基础（命名空间 / RBAC / 审计 / API+CLI）+ Agent 管理 + Skill 管理（基础）+ 顺序流程编排 + 手动 / 定时 / Webhook 触发 + 人工审批（approve/reject/request-changes/TTL）+ opencode 运行时 + 任务 Trace / 日志 + Jenkins / GitHub 插件 + 企业微信通知 | FR-101~107、FR-201~205、FR-301~302、FR-401~403、FR-406、FR-501~505、FR-601~605、FR-608、FR-701~703、FR-705、FR-801~803、FR-901~902、FR-905、FR-1001~1002、NFR-01~05、NFR-08 |
| **M2** | 并行分支 / 汇合、循环、流程版本管理、任务暂停恢复 / 重跑、Worker 分布式执行、Blueprint 业务包、工具级审批、Token 成本统计、Gitee 插件、OTEL / Prometheus、飞书 / 钉钉通知 | FR-404~405、FR-408、FR-411、FR-506~507、FR-606~607、FR-704、FR-804~805、FR-903~904、FR-1003 |
| **M3** | 可视化编排画布、子流程、委托分发、A2A 对接、Skill 市场、插件沙箱强化、IM 发起任务、评估体系（Eval） | FR-206、FR-303、FR-407、FR-409~410、FR-706、FR-806、FR-1004、FR-1005~1010、P2 其余项 |

---

## 8. 开放问题（待评审确认）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | opencode 运行时与平台的状态同步粒度：按"Agent 整体完成"同步，还是按"步骤 / 工具调用"实时同步？（影响 Trace 精细度与实现复杂度） | 可观测性设计 |
| Q2 | 审批关卡是否允许"自动化前置审批"（如 LLM 预审 + 人工抽审）？ | 审批流程设计 |
| Q3 | Blueprint 的定制粒度：安装后仅可改参数，还是可改流程结构？ | 平台与业务分离边界 |
| Q4 | 多租户是否需要跨命名空间的共享资源（共享 Agent / 共享插件）？ | 资源模型设计 |
| Q5 | 产物（需求文档 / 设计文档 / 测试用例 / 测试报告）是否需要结构化 Schema 归档（与 issue / PR 关联），还是仅作为任务输出保存？ | 验收归档闭环（差异化点） |
| Q6 | 是否需要"仅用平台内置 Agent（opencode 无独立配置）"的轻量模式？ | 使用门槛 |

---

## 9. 附录：市场对标参考

| 参照物 | 借鉴点 | 差异 |
|---|---|---|
| **Orloj**（开源，Apache 2.0，Go） | K8s 风格资源模型、控制器模式、审批状态机、MCP 工具层、可观测 | 自研执行循环（ReAct），非调度外部 CLI Agent；无业务包、无产物归档 |
| **Red Queen**（开源，MIT，Node/TS） | 确定性状态机编排（零 Token）、人工 gate、YAML 声明式流水线 | 仅 Claude Code 运行时、无多角色/并行/多租户 |
| **Temporal / n8n / Dify** | 持久化执行（history-replay）、HITL 原语（Signal / Approval 节点） | 非 Agent 原生，需自行建模 Agent |
| **MCP / A2A**（Linux Foundation 标准） | 工具接入（MCP）与 Agent 互联（A2A）的开放标准 | — |
| **ChatPRD / p3x-architect** | 需求文档 / 设计文档生成（作为 Blueprint 的 Skill 参考） | 单点工具，无编排 |
