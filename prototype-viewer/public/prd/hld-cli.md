<!-- 概要设计：对应需求文档 docs/req-4.1-platform.md CLI 章节（FR-108 ~ FR-112）与架构 architecture.md 第 6 章 -->

# CLI（cliyard）— 概要设计

## 1. 模块定位

CLI（命令名 `orchestra`，基于 cliyard 生成）是 Orchestra 的**横切能力**：Web 前端给人用（可视化），CLI 给 AI/Agent 与自动化用（确定性、可脚本化、无头调用）。它不隶属于 4.1~4.10 任何单一模块，而是覆盖平台**全部资源操作**：Agent / Flow / Task / Approval / RuntimeInstance / Plugin / McpServer / Skill / Secret / Webhook / Namespace 的列表、创建、详情、更新、删除与动作命令（cancel / retry / pause / resume / publish / decide / install / test / trigger）。

需求基线 [req-4.1-platform.md](req-4.1-platform.md) FR-108~112：

- **FR-108**：CLI 命令与 REST API 一一映射（资源=命令组、动词=子命令），覆盖平台全部资源管理。
- **FR-109**：确定性无交互调用（非必填走默认值）、默认 JSON 输出（AI 可解析）、错误携带 API 错误码。
- **FR-110**：`_auth.yaml` 认证链（`ORCHESTRA_TOKEN` 环境变量优先，token 不落盘明文），支持多环境切换。
- **FR-111**：任务级操作与自省（`task get --trace --json`、approval decide、cancel/retry/pause/resume）。
- **FR-112**：specs 随平台仓库维护，与 RESTful API 演进同步；开发期 Library 模式、交付 Gen 模式。

CLI 以平台 RESTful API（`/api/v1`，OpenAPI 3.1 契约先行）为唯一契约源，命令通过 specs/ 目录声明式定义，**无需手写命令代码**。命令与 API 的一一映射关系见 [architecture.md ## 6.2 命令树](../architecture.md)。

## 2. 可行性分析

### 2.1 技术可行性

- **cliyard** 为 YAML 驱动 CLI 框架（针对任意 REST API 生成命令），本机已验证（`cliyard usage` 完整说明可用）。
- 平台已有 RESTful API（/api/v1）作为唯一契约源，命令可声明式映射，无需手写命令代码。
- 生成产物为 click（Python）命令组，跨平台可用，与 AI 无头调用场景契合。

### 2.2 依赖与前置

- cliyard（Python 生态，本机已装）。
- 依赖平台 RESTful API 稳定（OpenAPI 契约先行，architecture.md 第 3 节）。
- auth 链依赖平台登录接口或 token 注入（`_auth.yaml`：env `ORCHESTRA_TOKEN` → login → inject Bearer）。
- 前置：4.1 平台模块的 REST API 网关先行冻结（CLI 是 API 的客户端，不引入新的服务端能力）。

### 2.3 风险与复杂度评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| specs 与 API 演进不同步 | 命令漂移 | specs 随仓库维护，API 变更同步更新 specs（FR-112） |
| AI 调用不确定性（交互提示） | 无头调用失败 | 确定性无交互（非必填走默认值）、默认 JSON 输出（FR-109） |
| token 明文泄露 | 安全事件 | `ORCHESTRA_TOKEN` 环境变量注入，不落盘（FR-110） |
| 命令树与 API 命名不一致 | 使用者困惑 | 命令与 RESTful API 一一映射（资源=命令组、动词=子命令），以 OpenAPI 契约为准（FR-108） |

### 2.4 可行性结论

**可行**，复杂度评级：**低**。cliyard 声明式定义，无自定义命令代码；CLI 仅是 RESTful API 的客户端投影，风险集中在 specs 与 API 的同步维护（FR-112 已覆盖）。

## 3. 实现初步方案

### 3.1 组件与目录

- **specs/ 目录**（平台仓库内）为唯一命令定义源：`_auth.yaml`（server + auth 链）、`_groups.yaml`（命令分组）、`resources/*.yaml`（每资源一个命令定义文件）。
- **Library 模式**（开发期）：`create_cli('./specs/')` 动态生成 click.Group，无编译步骤，便于迭代。
- **Gen 模式**（交付）：`cliyard gen --name orchestra --defs-path ./specs/` 生成独立 pip 包，与平台版本同发。

### 3.2 命令树

命令与 RESTful API 一一映射（完整命令树见 [architecture.md ## 6.2](../architecture.md)），共 11 组资源命令：

| 命令组 | 覆盖 API | 主要子命令 |
|---|---|---|
| `orchestra agent` | /api/v1/agents | list / create / get / update / delete |
| `orchestra flow` | /api/v1/flows | list / create / get / publish |
| `orchestra task` | /api/v1/tasks | list / create / get（--trace）/ cancel / retry / pause / resume |
| `orchestra approval` | /api/v1/approvals | list / decide |
| `orchestra runtime-instance` | /api/v1/runtime-instances | list / create / test |
| `orchestra plugin` | /api/v1/plugins | list / install |
| `orchestra mcp-server` | /api/v1/mcp-servers | list / create / sync |
| `orchestra skill` | /api/v1/skills | list / create / update / delete |
| `orchestra secret` | /api/v1/secrets | create（--seal）/ list / delete |
| `orchestra webhook` | /api/v1/webhooks | trigger |
| `orchestra namespace` | /api/v1/namespaces | list / create |

### 3.3 认证与输出

- **认证**：`_auth.yaml` 链（env `ORCHESTRA_TOKEN` / login / inject Bearer），多环境切换（dev / staging / prod）。
- **输出**：默认 JSON（`ORCHESTRA_OUTPUT=json` 或 `--output json`），可选 table 供人阅读。
- **错误**：携带 API 错误码（如 `RESOURCE_NOT_FOUND`），AI 可据 code 决策处理。

### 3.4 与前端关系

- 双通道等价操作：Web 前端给人用，CLI 给 AI/Agent 与自动化用。
- CLI 无对应页面（终端工具）；前端页面提供等价操作（原型页：agent-list、task-list、approval、secret-manage 等）。
- 审计日志按 `source`（console / api / cli / webhook / im）区分来源通道，CLI 操作同样可审计。

## 4. 关联文档

| 文档 | 关系 |
|---|---|
| [req-4.1-platform.md](req-4.1-platform.md) | CLI 需求基线 FR-108 ~ FR-112 |
| [dld-cli.md](dld-cli.md) | CLI 详细设计（specs 结构 / 资源 YAML / 分发） |
| [architecture.md](../architecture.md) | 第 6 章 CLI 设计（命令树 / Auth / 生成分发） |
| [dld-overview.md](dld-overview.md) | 第 5 章 CLI 实现设计（与 RESTful 约定对齐） |
