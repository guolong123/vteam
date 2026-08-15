<!-- 子文档：对应主 PRD 4.1 章节，由 docs/requirements.md 拆分扩展 -->

# 4.1 平台基础与治理（需求设计说明）

## 模块概述

平台基础与治理是 Orchestra 的底座模块，负责解决三个核心问题：多租户资源隔离、细粒度权限控制、全量操作可审计。Agent、Flow、Task、Secret 等所有资源都归属命名空间，任何未经授权的跨命名空间访问一律拒绝（fail-closed）；权限通过预置角色加按命名空间授权实现；每一次资源变更、任务操作、审批决策都被完整记录，可检索、可追溯。

本模块是全局横切能力，与其余模块的关系如下：命名空间与 RBAC 约束 4.2 至 4.10 所有模块的资源访问边界；审计日志覆盖 4.6 审批决策、4.5 任务操作、4.8 插件安装等全部关键动作；任务的暂停 / 恢复 / 取消 / 重跑是任务生命周期治理能力，与 4.5 任务执行模块的 Worker 与队列机制联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-101 | 支持命名空间（Namespace）隔离：Agent、Flow、Secret、Task 等资源按命名空间归属，互不可见、互不调用 | P0 |
| FR-102 | 提供基于角色的访问控制（RBAC）：平台管理员 / 流程设计师 / 审批人 / 只读观察者等预置角色，支持按命名空间授权 | P0 |
| FR-103 | 所有资源以声明式 YAML Manifest 定义（apiVersion/kind/metadata/spec/status），可通过 API 或 CLI 应用（`apply`），并纳入 GitOps 管理 | P0 |
| FR-104 | 提供 REST API 作为所有能力的一等入口，CLI / Web 控制台 / SDK 均基于同一 API | P0 |
| FR-105 | 提供 Web 控制台：资源管理、任务查看、审批操作、可观测视图 | P1 |
| FR-106 | 全量审计日志：资源变更、任务操作、审批决策均记录操作者、时间、内容 | P0 |
| FR-107 | 支持任务的暂停 / 恢复 / 取消 / 重跑（可干预运行中的任务） | P1 |
| FR-108 | 提供命令行工具（CLI，基于 cliyard）作为平台的 AI/自动化操作入口：命令与 REST API 一一映射（资源=命令组、动词=子命令），覆盖平台全部资源管理 | P1 |
| FR-109 | CLI 支持确定性无交互调用（非必填参数走默认值）、默认 JSON 输出（AI 可解析），可选表格输出供人阅读；错误输出携带 API 错误码 | P1 |
| FR-110 | CLI 认证与配置：通过 `_auth.yaml` 配置链（`ORCHESTRA_TOKEN` 环境变量优先），AI 场景 token 不落盘明文；支持多环境切换 | P1 |
| FR-111 | CLI 支持任务级操作与自省：`task get --trace --json` 获取结构化执行 Trace、审批决策（approval decide）、生命周期动作（cancel/retry/pause/resume）等 | P2 |
| FR-112 | CLI specs（命令定义 YAML）随平台仓库维护，与 RESTful API 演进同步；开发期 Library 模式（create_cli 动态生成），交付 Gen 模式生成独立包 | P2 |

## 详细设计说明

### 声明式资源模型（FR-103）

所有资源统一遵循 K8s 风格四段式结构，作为 GitOps 与版本化的基础：

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Agent                    # Agent | Flow | Task | TaskSchedule | Secret | Plugin | Approval
metadata:
  name: requirement-analyst
  namespace: dev-team
  labels:
    blueprint: software-company
  annotations:
    description: 需求分析 Agent
spec:
  # 各 kind 的资源特有声明，见对应子文档
status:
  phase: Active                # 由控制器回写，用户不可直接编辑
```

设计要点：

- `metadata.name` 在命名空间内唯一；`metadata.namespace` 决定归属与隔离边界。
- `spec` 是用户声明的期望状态，`status` 由平台控制器维护的实际状态，二者分离保证 `apply` 的幂等性。
- 并发写保护：更新操作要求携带 `resourceVersion`（乐观锁 CAS），冲突返回 409，避免 GitOps 与 Web 控制台并发覆盖。
- 所有 kind 支持 `apply`（创建或更新）与 `delete`，删除遵循级联规则：删除 Flow 不自动删除其历史 Task（保留审计），但删除插件前会校验引用它的 Skill / Agent。

### 命名空间隔离规则（FR-101）

隔离边界明确如下：

- 资源归属唯一命名空间，列表、详情、变更接口默认只返回当前授权命名空间的数据。
- 跨命名空间引用一律禁止：Agent 不能引用其他命名空间的 Skill、Flow 不能引用其他命名空间的子流程、插件凭证不能跨命名空间读取。
- 保留 `system` 命名空间：放置预置角色绑定与平台级共享内容（如内置 Skill 模板），对所有命名空间只读可见、不可修改。
- 配额：命名空间可配置资源配额（Agent 数量、Task 并发上限、凭证数量），超限拒绝创建，与 4.9 成本统计联动展示。

### RBAC 权限模型（FR-102）

权限模型为「角色 × 命名空间」的二维授权：

| 预置角色 | 平台级 | 命名空间级能力（示例） |
|---|---|---|
| 平台管理员 platform-admin | 命名空间管理、插件安装、系统设置 | 全部能力 |
| 流程设计师 flow-designer | 无 | Agent / Flow / Blueprint 的增删改与发布 |
| 任务发起人 task-initiator | 无 | 触发任务、查看本命名空间任务 |
| 审批人 approver | 无 | 审批中心操作（按被分配或角色匹配） |
| 只读观察者 viewer | 无 | 只读查看资源、任务与审计 |

设计要点：

- 权限在 API 网关层与业务层双重校验（fail-closed）：未授权动作在运行时被拒绝并写入审计，而非仅隐藏入口。
- 审批人角色可与命名空间授权叠加：命名空间授权决定「能看哪些审批」，角色决定「能否决策」。
- 角色绑定可继承：用户加入命名空间时可按预置角色模板快速授权。

### 审计日志（FR-106，与 FR-905 联动）

审计事件为独立资源，结构与检索字段如下：

| 字段 | 说明 |
|---|---|
| id | 全局唯一，追加生成 |
| timestamp | 操作时间（UTC） |
| actor | 操作者（用户 / CLI token / 系统控制器 / webhook） |
| action | 操作类型：create / update / delete / approve / reject / request-changes / apply / exec |
| resource | 目标资源 {kind, namespace, name} |
| diff | 变更前后摘要（敏感字段脱敏后落盘） |
| trace_id | 关联任务 trace（若由任务触发） |
| source | 来源通道：console / api / cli / webhook / im |

审计日志为追加写、只读接口（不允许修改删除），按操作者、时间范围、资源类型可检索。Web 控制台的「审计日志」原型页即此能力的可视化承载。

### 任务干预治理（FR-107）

任务生命周期支持运行时干预，状态机如下：

```
Running ──pause──▶ Paused ──resume──▶ Running
   │                  │
   ├──cancel──────────┴──▶ Cancelled
   └──rerun──▶ 新 Task（继承输入与流程版本，保留原 Task 记录）
```

设计要点：

- 暂停是协作式干预：平台向 opencode 会话发送暂停请求，等待当前步骤边界停住后冻结上下文（见 4.7 会话保持）。
- 取消分为优雅取消（等待当前步骤收尾）与强制终止（abort，见 FR-703）。
- 重跑生成全新 Task 实例并保留原 Task 与 trace，不覆盖历史，保证可审计。

### CLI（命令行工具）需求设计（FR-108 ~ FR-112）

**定位**

Web 前端给人用（可视化），CLI 给 AI/Agent 与自动化用（确定性、可脚本化、无头调用）：opencode 等编码工具、CI、定时脚本通过 CLI 操作平台，与 4.11 界面原型形成"同一 API、两种入口"。

**实现技术**

- 基于 **cliyard**（YAML 驱动 CLI 框架，github.com/guolong123/cliyard）针对平台 RESTful API（`/api/v1`）声明式生成命令，命令与 REST API 一一映射（资源=命令组、动词=子命令）。
- specs/ 目录（`_auth.yaml`、`_groups.yaml`、`resources/*.yaml`）随平台仓库维护，命令定义即文档，与 API 演进同步。

**命令范围**

- 覆盖平台全部资源：Agent / Flow / Task / Approval / RuntimeInstance / Plugin / McpServer / Skill / Secret / Webhook / Namespace 等（见主 PRD FR-108 与架构设计命令树）。
- 动作命令走 POST 子路径：cancel / retry / pause / resume / publish / decide / install / test / trigger，输出 JSON（与 RESTful API 4.3 动作约定一致）。

**认证与配置（FR-110）**

- `_auth.yaml` 配置链：server（base_url 指向平台 /api/v1）+ auth 链（env 读取 `ORCHESTRA_TOKEN` / login 换取 Bearer / inject 注入 Authorization）。
- AI 场景通过环境变量注入 token（`ORCHESTRA_TOKEN`），不落盘明文；支持多环境切换（dev / staging / prod 配置切换）。

**输出与错误（FR-109）**

- 默认输出 JSON（`--output json` 或环境变量 `ORCHESTRA_OUTPUT=json`），AI 可稳定解析；可选 `--output table` 供人阅读。
- 命令确定性：无交互式提示，非必填参数走默认值，适合无头调用。
- 错误输出携带 API 错误码（如 `RESOURCE_NOT_FOUND`），AI 可据 code 决策处理。

**任务级操作与自省（FR-111）**

- `orchestra task get --trace --json` 获取结构化执行 Trace 供 AI 自省；`orchestra approval decide` 执行审批决策；cancel / retry / pause / resume 等生命周期动作与 4.5 / 4.6 模块联动。

**specs 维护与分发（FR-112）**

- specs/ 目录随平台仓库维护，命令与 API 同步演进（OpenAPI → specs 部分可生成）。
- 开发期 Library 模式（create_cli('./specs/') 动态生成，无需编译）；交付 Gen 模式（cliyard gen --name orchestra → 独立包）。

**与原型的关系**

- CLI 无对应页面（终端工具）；前端页面提供等价操作（原型页：agent-list、task-list、approval、secret-manage 等），CLI 面向 AI/自动化场景。审计日志按 `source`（console / api / cli）区分来源通道，CLI 操作同样可审计。

### 与原型的关系

- `dashboard` 平台总览：集中展示命名空间任务分布、待审批数量、opencode 运行时健康状态，是治理结果的全局视图。
- `namespace-manage` 命名空间管理：多租户卡片呈现成员数、资源统计、凭证配额进度条与 `system` 保留标记，是 FR-101 / FR-102 的交互承载。
- `audit-log` 审计日志：操作类型 / 操作者 / 时间范围筛选与详情展开，是 FR-106 / FR-905 的界面基准。

## 界面原型

```prototype
id: dashboard
title: 平台总览
device: desktop
```

```prototype
id: namespace-manage
title: 命名空间管理
device: desktop
```

```prototype
id: audit-log
title: 审计日志
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| dashboard（平台总览） | FR-105、FR-903 |
| namespace-manage（命名空间管理） | FR-101、FR-102 |
| audit-log（审计日志） | FR-106、FR-905 |

## 验收要点

- 在两个命名空间各创建一个同名 Agent，任一命名空间用户无法通过列表或详情接口访问另一个命名空间的资源。
- 未授权用户直接调用变更 API 被拒绝且返回明确错误码，同时审计日志中产生一条被拒记录。
- 对同一资源并发 `apply` 两次，后一次在版本冲突时返回 409 而非覆盖。
- 审批决策、插件安装、任务取消均在审计日志中可检索到操作者、时间与变更摘要。
- 运行中的任务可被暂停、恢复、取消与重跑，重跑后新旧 Task 记录并存且 trace 完整。
