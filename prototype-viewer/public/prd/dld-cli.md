<!-- 详细设计：在 hld-cli 之上细化到 specs 目录结构与资源 YAML 定义，可直接指导编写 specs 与生成命令 -->

# CLI（cliyard）— 详细设计

## 1. 模块范围

CLI（`orchestra`）是 Orchestra 的**横切能力**，覆盖全部资源操作：Agent / Flow / Task / Approval / RuntimeInstance / Plugin / McpServer / Skill / Secret / Webhook / Namespace。它与 RESTful API（`/api/v1`，OpenAPI 3.1 契约先行）一一映射：资源=命令组、动词=子命令。本文档在概要设计 [hld-cli.md](hld-cli.md) 之上，给出 specs/ 目录结构、`_auth.yaml` 认证配置、资源 YAML 的定义规则与示例、生成分发流程、给 AI 使用的要点与测试要点，可直接指导编写 specs 并生成命令。需求基线 req-4.1 FR-108~112，实现约束沿用 [dld-overview.md](dld-overview.md) 第 4 节 RESTful API 约定（分页/过滤/动作 POST 子路径/错误响应体）。

## 2. specs 目录结构（平台仓库内，命令定义唯一源）

```
specs/
├── _auth.yaml            # server（平台 base_url + prefix /api/v1）+ auth 链
├── _groups.yaml          # 命令分组
├── resources/
│   ├── agents.yaml       # agent: list/create/get/update/delete/publish/enable/disable
│   ├── flows.yaml        # flow: list/create/get/publish/copy/disable/enable
│   ├── tasks.yaml        # task: list/create/get(--trace)/cancel/retry/pause/resume
│   ├── approvals.yaml    # approval: list/decide
│   ├── runtime_instances.yaml  # runtime-instance: list/create/update/delete/test/sync
│   ├── plugins.yaml      # plugin: list/install/configure/uninstall/upgrade
│   ├── mcp_servers.yaml  # mcp-server: list/create/sync
│   ├── skills.yaml       # skill: list/create/update/delete
│   ├── secrets.yaml      # secret: create(--seal)/list/delete
│   ├── webhooks.yaml     # webhook: trigger
│   └── namespaces.yaml   # namespace: list/create
├── flows/                # （可选）cliyard flow 编排
└── plugins/              # （可选）Python 插件
```

## 3. 认证配置（_auth.yaml 示例）

```yaml
name: orchestra
server:
  - name: main
    base_url: '{{ env("ORCHESTRA_URL") }}'   # 默认 http://127.0.0.1:4096 平台地址
    prefix: /api/v1
auth:
  id: orchestra-token
  steps:
    - name: token
      type: env
      config: { name: ORCHESTRA_TOKEN }
    - name: inject
      type: inject
      config:
        source: token
        into: header
        name: Authorization
        prefix: 'Bearer '
```

要点：

- AI 场景通过环境变量 `ORCHESTRA_TOKEN` 注入 token，不落盘明文（FR-110）。
- 多环境切换通过 `ORCHESTRA_URL` / 多 server 配置实现（dev / staging / prod）。

## 4. 资源 YAML 设计

### 4.1 通用规则

每个资源一个 `resources/*.yaml`，定义命令组；每个命令一个 `methods` 下的方法，统一结构：

| 字段 | 规则 |
|---|---|
| `name` | 命令组名（如 `agent` / `task`） |
| `path` | RESTful 资源路径（复数，如 `agents` / `tasks`） |
| `methods` | 子命令定义：`list/create/get/update/delete` 及动作命令 |
| `params.path` | 路径参数，`required: true`（如 `{ name: name, type: string, required: true }`） |
| `params.query` | 查询参数，可带 `default`（分页/过滤与 REST 约定一致：page/pageSize/namespace/state） |
| `params.body` | 请求体字段，`required: true` 标记必填 |
| `request_body` | 请求体模板：`'{{ name }}'` 占位符绑定命令参数；`field` 指定参数到请求体字段的映射（如 `runtime_ref` → `runtimeRef`） |
| `output.items_path` | 列表输出的 JSONPath（`$.items`），对应 REST 列表响应 `{ items, total, page, pageSize }` |
| `output.fields` | 表格输出的列定义（`name` 字段名 + `alias` 中文表头） |

动作命令约定：`cancel/retry/pause/resume/publish/decide/install/test/trigger` 映射为 POST + 子路径（见 4.3）。

### 4.2 示例：agents.yaml / tasks.yaml

**agents.yaml 片段**（CRUD + body 绑定）：

```yaml
name: agent
description: Agent 管理
path: agents
group: 管理
methods:
  list:
    description: 列出 Agent
    http: { method: GET }
    params:
      query:
        - { name: namespace, type: string }
        - { name: page, type: integer, default: 1 }
        - { name: pageSize, field: pageSize, type: integer, default: 20 }
    output:
      items_path: $.items
      fields:
        - { name: name, alias: 名称 }
        - { name: model, alias: 模型 }
        - { name: status, alias: 状态 }
  create:
    description: 创建 Agent
    http: { method: POST }
    params:
      body:
        - { name: name, type: string, required: true }
        - { name: prompt, type: string, required: true }
        - { name: runtime_ref, field: runtimeRef, type: string }
        - { name: workdir, type: string }
        - { name: model_ref, field: modelRef, type: string }
    request_body:
      name: '{{ name }}'
      prompt: '{{ prompt }}'
      runtimeRef: '{{ runtime_ref }}'
      workingDir: '{{ workdir }}'
      modelRef: '{{ model_ref }}'
  get:
    description: 获取 Agent 详情
    http: { method: GET, path: 'agents/{{ name }}' }
    params:
      path:
        - { name: name, type: string, required: true }
  delete:
    description: 删除 Agent
    http: { method: DELETE, path: 'agents/{{ name }}' }
    params:
      path:
        - { name: name, type: string, required: true }
```

**tasks.yaml 片段**（含动作命令 cancel）：

```yaml
name: task
description: 任务管理
path: tasks
group: 任务
methods:
  list:
    description: 任务列表
    http: { method: GET }
    params:
      query:
        - { name: namespace, type: string }
        - { name: state, type: string }
        - { name: page, type: integer, default: 1 }
        - { name: pageSize, field: pageSize, type: integer, default: 20 }
    output:
      items_path: $.items
      fields:
        - { name: name, alias: 任务名 }
        - { name: phase, alias: 状态 }
  get:
    description: 任务详情（可含 trace）
    http: { method: GET, path: 'tasks/{{ name }}' }
    params:
      path: [{ name: name, type: string, required: true }]
      query: [{ name: trace, type: boolean, default: false }]
  cancel:
    description: 取消任务
    http: { method: POST, path: 'tasks/{{ name }}/cancel' }
    params:
      path: [{ name: name, type: string, required: true }]
```

### 4.3 动作命令约定

非 CRUD 动作用 **POST + 子路径动名词**，与 [dld-overview.md 4.3](dld-overview.md) 动作约定、architecture.md 命令树一致，输出 JSON：

| 动作命令 | API | 说明 |
|---|---|---|
| `task cancel / retry / pause / resume` | POST /api/v1/tasks/{name}/cancel 等 | 任务生命周期动作 |
| `flow publish` | POST /api/v1/flows/{name}/publish | 发布流程版本 |
| `approval decide` | POST /api/v1/approvals/{name}/decide | 审批决策 |
| `runtime-instance test` | POST /api/v1/runtime-instances/{name}/test | 运行时实例测试 |
| `plugin install` | POST /api/v1/plugins/{name}/install | 插件安装 |
| `mcp-server sync` | POST /api/v1/mcp-servers/{name}/sync | MCP 工具同步 |
| `secret create --seal` | POST /api/v1/secrets（seal） | 凭证加密 |
| `webhook trigger` | POST /api/v1/webhooks/{name}/trigger | 手动触发 webhook |

## 5. 生成与分发

- **开发期**：Library 模式 `create_cli('./specs/')` → click.Group（无编译步骤），便于在平台仓库内迭代。
- **交付**：Gen 模式 `cliyard gen --name orchestra --defs-path ./specs/` → pip 包，与平台版本同发。
- **CI**：specs 变更走 PR 评审；API 变更同步更新 specs（FR-112），OpenAPI → specs 部分可生成。
- **版本一致性**：CLI 包版本与平台版本同发，避免命令漂移（FR-112 验收）。

## 6. 给 AI 使用的要点

- 默认 JSON 输出（`ORCHESTRA_OUTPUT=json` 或 `--output json`），AI 可稳定解析（FR-109）。
- 确定性无交互（非必填走默认），适合无头调用（FR-109）。
- 错误携带 API 错误码（`RESOURCE_NOT_FOUND` 等），AI 按 code 处理（FR-109）。
- `orchestra task get --trace --json` 获取结构化 trace 供 AI 自省（FR-111）。
- 认证经 `_auth.yaml` 链自动完成（`ORCHESTRA_TOKEN` 环境变量），AI 调用侧无需关心 token 细节（FR-110）。

## 7. 测试要点

- **单元**：specs 校验（必填参数缺失 / path 占位符与 `params.path` 不一致 / output JSONPath 非法）；参数绑定（`field` 映射与 `request_body` 占位符渲染）；动作命令到 POST 子路径的映射正确性。
- **集成**：对真实 API 的命令回归（list 分页 / get / create / 动作命令），响应与 `items_path`/`fields` 定义一致；认证链（`ORCHESTRA_TOKEN` 注入 Bearer）打通。
- **AI 场景**：无头调用（无 TTY、非必填走默认）稳定输出 JSON；错误码可解析；`task get --trace --json` 返回结构化 trace。
- **一致性**：命令树与 OpenAPI 契约逐项对齐（FR-108 / FR-112），specs 变更触发契约比对。
