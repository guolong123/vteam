<!-- 概要设计总览：对应 docs/architecture.md 第 7 章模块划分，为各模块 hld-4.x 的索引与导览 -->

# Orchestra 概要设计（High-Level Design）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（草案） |
| 编写日期 | 2026-08-03 |
| 关联文档 | [需求 PRD](requirements.md) · [需求子文档](requirements.md#41--410-功能模块详细设计见子文档) · [架构设计](architecture.md) · [ADR](decisions.md) |
| 设计状态 | 待评审 |

---

## 1. 文档定位

本文档位于**需求（做什么）**与**架构（整体蓝图）**之间，回答"**每个模块怎么实现**"的问题：

- **需求文档（req-4.x）**：定义每个功能模块的业务规则、字段设计、状态机与验收要点（FR-101 ~ FR-1010）。
- **架构设计（architecture.md）**：给出整体分层、技术选型、数据模型与目录结构（`src/`），是全局蓝图。
- **本文档（hld-overview + hld-4.x）**：在两者之间，为每个模块产出**可行性分析**与**实现初步方案**，作为开发排期与详细设计（DB 表结构、API 定义、模块代码结构）的输入。

各模块概要设计文档的正文结构统一为：`1 模块定位` → `2 可行性分析`（技术可行性 / 依赖前置 / 风险评估 / 结论）→ `3 实现初步方案`（组件划分 / 数据模型 / 关键流程接口 / 关键技术点 / 实施步骤），便于逐模块对照评审与排期。

## 2. 总体技术栈

技术选型均已在 ADR 中定案（本文档不重复论证，仅列引用）：

| 领域 | 选型 | 决策依据 |
|---|---|---|
| 后端 | Node.js 22 + TypeScript，Hono 路由，REST 优先 | ADR-007 |
| 存储 | Postgres 14+（node-pg / drizzle-orm），MVP 内存后端，存储层抽象 | ADR-008 |
| 消息 | MVP 内存队列；M2 NATS JetStream | ADR-008 |
| 编排模型 | 确定性状态机 + 资源控制器（编排零 Token） | ADR-009 |
| 运行时 | opencode serve API（REST + SSE，常驻实例） | ADR-010 |
| 插件 | MCP 一等标准 + 原生插件 | ADR-011 |
| 前端 | React + TypeScript（独立应用，M3 画布） | ADR-012 |
| 审批 | 纯人工，预留 auto_review_policy 扩展位 | ADR-002 |
| CLI 环境 | 镜像预装 + Skill 自安装，平台四抓手治理 | ADR-014 |

## 3. 模块划分与依赖关系

十一个功能模块与架构目录（`src/`）的对应关系如下：

| 编号 | 模块 | 概要设计文档 | 主要 src 模块 | 里程碑 |
|---|---|---|---|---|
| 4.1 | 平台基础与治理 | [hld-4.1-platform.md](hld-4.1-platform.md) | `resources/ store/ api/ auth/ controllers/` | M1 |
| 4.2 | Agent 管理 | [hld-4.2-agent.md](hld-4.2-agent.md) | `resources/ modelgw/` | M1 |
| 4.3 | Skill 管理 | [hld-4.3-skill.md](hld-4.3-skill.md) | `resources/ plugins/` | M1（基础）/ M2-M3（市场） |
| 4.4 | 流程编排 | [hld-4.4-flow.md](hld-4.4-flow.md) | `flow/ resources/` | M1（顺序/条件）/ M2（并行/循环/版本） |
| 4.5 | 任务执行与触发 | [hld-4.5-task.md](hld-4.5-task.md) | `controllers/ trigger/ executor/` | M1 |
| 4.6 | 人工审批 | [hld-4.6-approval.md](hld-4.6-approval.md) | `approver/ resources/` | M1 |
| 4.7 | 运行时集成 | [hld-4.7-runtime.md](hld-4.7-runtime.md) | `executor/ mcp/` | M1 |
| 4.8 | 插件市场 | [hld-4.8-plugin.md](hld-4.8-plugin.md) | `plugins/ mcp/` | M1 |
| 4.9 | 可观测性 | [hld-4.9-observability.md](hld-4.9-observability.md) | `observability/` | M1（Trace/审计）/ M2（成本/OTEL） |
| 4.10 | 通知与 IM | [hld-4.10-notify.md](hld-4.10-notify.md) | `notify/ trigger/` | M1（企业微信）/ M2-M3（多渠道） |
| 4.11 | Eval 评估 | [hld-4.11-eval.md](hld-4.11-eval.md) | `eval/` | M3 |

模块间依赖关系（实现顺序依据）：

```
4.1 平台基础（资源模型 / RBAC / 审计）
 ├─→ 4.2 Agent（引用 ModelEndpoint / Tool / Skill）
 ├─→ 4.8 插件（工具注册源，4.2/4.3 依赖）
 │     ├─→ 4.3 Skill（声明 requiredPlugins）
 │     └─→ 4.7 运行时（插件工具在会话内执行）
 ├─→ 4.4 Flow（节点 = Agent，审批关卡节点）
 │     └─→ 4.5 Task（Flow 实例化）
 │           ├─→ 4.6 审批（TaskApproval / ToolApproval）
 │           ├─→ 4.7 运行时（opencode 会话执行）
  │           ├─→ 4.9 可观测（Trace / 成本 / 审计检索）
  │           ├─→ 4.10 通知（状态变更事件出向投递）
  │           └─→ 4.11 Eval（golden 驱动 Task 跑分，trace 采样评分）
 └─→ 4.9 审计（跨全部模块横切）
```

要点：**4.1 是所有模块的地基**（命名空间隔离 + RBAC + 通用资源表），必须先落地；**4.7 是执行链路的咽喉**（opencode serve 客户端 + SSE 解析），其可用性决定 4.5/4.6/4.9 是否成立；**4.8 为 4.2/4.3 提供工具来源**，三者存在引用校验的闭环。

## 4. 与 opencode 的集成机制（总览）

平台声明的三类资产（MCP 服务 / Tools / Skills）通过三条通道注入 opencode 会话，执行结果经 SSE 事件流回传平台：

| 平台资产 | 注入通道 | opencode 内形态 | 执行与回传 |
|---|---|---|---|
| **McpServer**（4.8） | 注入 opencode 配置（M1：会话/工作区级注入；M2/M3：`PATCH /config` 全局基线） | `serverName_toolName` 工具 | 会话内工具调用 → SSE tool 事件 → Trace |
| **Tool**（4.2/4.8，CLI/原生） | 物化为 opencode custom tools（`.opencode/tools/*.ts` 壳，内部调 CLI）+ 工具白名单/权限规则 | 命名工具（Zod schema） | 工具调用/输出 → SSE → Trace；permission ask → ToolApproval |
| **Skill**（4.3） | 合并进 Agent prompt（M1）；物化为 opencode skills 目录条目（M2） | prompt 上下文 / skill 条目 | 影响 Agent 行为，无独立回传（token 计入 Trace） |

统一回传链路（所有通道共用）：opencode SSE 事件流（`/event`/`/global/event`）→ 平台事件解析器 → Task Trace 步骤（模型/工具/审批/错误）；permission 请求 → ToolApproval 审批 → `POST /session/:id/permissions/:permissionID` 应答。
（详细机制见 hld-4.7「资产注入机制」）

## 5. 里程碑对齐

| 里程碑 | 涉及模块 | 对应需求（主 PRD 第 7 章） |
|---|---|---|
| **M1（MVP）** | 4.1 平台基础、4.2 Agent（无委托）、4.3 Skill（基础）、4.4 顺序/条件编排、4.5 手动/定时/Webhook 触发 + 重试、4.6 审批全状态机、4.7 opencode serve 全链路、4.8 Jenkins/GitHub/MCP、4.9 Trace/日志/审计、4.10 出站 Webhook + 企业微信 | FR-101~107、FR-201~205、FR-301~302、FR-401~403、FR-406、FR-501~505、FR-601~605、FR-608、FR-701~703、FR-705、FR-801~803、FR-901~902、FR-905、FR-1001~1002 |
| **M2** | 4.4 并行/汇合/循环/版本管理、4.5 Worker 分布式 + NATS + 暂停恢复重跑、4.6 工具级审批、4.8 Gitee + 沙箱、4.9 Token 成本 + OTEL/Prometheus、4.10 飞书/钉钉、Blueprint（FR-411 贯通 4.1~4.5） | FR-404~405、FR-408、FR-411、FR-506~507、FR-606~607、FR-704、FR-804~805、FR-903~904、FR-1003 |
| **M3** | 4.4 可视化画布/子流程、4.2 委托、4.7 模型透传（PATCH /config）、4.8 A2A/沙箱强化、4.3 Skill 市场、4.10 IM 发起任务、4.11 Eval 评估 | FR-206、FR-303、FR-407、FR-409~410、FR-706、FR-806、FR-1004、FR-1005~1010 |

## 6. 文档清单

| 文档 | 模块 | 可行性结论（摘要） |
|---|---|---|
| [hld-4.1-platform.md](hld-4.1-platform.md) | 平台基础与治理 | 可行，复杂度中；K8s 风格资源模型 + 通用资源表 + RBAC 中间件 |
| [hld-4.2-agent.md](hld-4.2-agent.md) | Agent 管理 | 可行，复杂度低；声明式 Spec + 引用解析 + 模型路由 |
| [hld-4.3-skill.md](hld-4.3-skill.md) | Skill 管理 | 可行（市场部分需 PoC），复杂度低；不可变版本 + 依赖校验 |
| [hld-4.4-flow.md](hld-4.4-flow.md) | 流程编排 | 可行，复杂度高；状态机编译 + DAG 校验 + 版本快照 |
| [hld-4.5-task.md](hld-4.5-task.md) | 任务执行与触发 | 可行，复杂度高；租约 + 幂等 + 状态机 + 消息队列抽象 |
| [hld-4.6-approval.md](hld-4.6-approval.md) | 人工审批 | 可行，复杂度中；resume_context 精确恢复 + TTL + 工具审批联动 |
| [hld-4.7-runtime.md](hld-4.7-runtime.md) | 运行时集成 | 有条件可行，复杂度高；依赖 opencode serve API 稳定性（PoC P1/P2/P6） |
| [hld-4.8-plugin.md](hld-4.8-plugin.md) | 插件市场 | 可行（MCP 物化需 PoC P5），复杂度中；MCP 一等接入 + 原生插件 |
| [hld-4.9-observability.md](hld-4.9-observability.md) | 可观测性 | 可行，复杂度中；Trace 事件模型 + 异步批量落盘 + 成本聚合 |
| [hld-4.10-notify.md](hld-4.10-notify.md) | 通知与 IM | 可行，复杂度低；事件订阅 + 渠道适配器 + 出站签名/SSRF |
| [hld-4.11-eval.md](hld-4.11-eval.md) | Eval 评估 | 可行，复杂度中；复用 Task 执行链路 + 可插拔评分器 + trace 采样 |
