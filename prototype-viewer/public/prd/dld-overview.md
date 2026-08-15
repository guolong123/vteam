<!-- 详细设计总览：在 hld 之上深化到"数据库表结构 + 具体实现"，可直接指导编码 -->

# Orchestra 详细设计（Detailed Level Design）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（草案） |
| 编写日期 | 2026-08-03 |
| 关联文档 | [需求 PRD](requirements.md) · [概要设计](hld-overview.md) · [架构设计](architecture.md) · [ADR](decisions.md) |
| 设计状态 | 待评审 |

---

## 1. 文档定位

本文档位于**概要设计（hld）**与**编码实现**之间，回答"每个模块的数据库表长什么样、代码怎么组织、关键函数签名是什么"的问题：

- **需求文档（req-4.x）**：定义业务规则、字段、状态机与验收要点，是字段与流程的唯一事实源。
- **概要设计（hld-4.x）**：给出可行性结论与实现初步方案，是模块切分与关键技术点的依据。
- **本文档（dld-overview + dld-4.x）**：在两者之上细化到可编码级别，产出 **数据库表结构（字段/类型/索引/约束）** 与 **具体实现设计（TS 模块/类型/函数/流程/错误处理）**，开发按表建库、按模块落码。

各模块详细设计文档正文结构统一为：`1 模块范围` → `2 数据库结构设计` → `3 实现设计`，其中数据库结构含表清单、逐表 DDL、枚举常量；实现设计含目录结构、zod schema、核心函数签名、关键流程伪代码/mermaid、错误处理、测试要点。

## 2. 数据库设计约定

### 2.1 命名约定

| 项 | 约定 | 示例 |
|---|---|---|
| 表名 | 全小写 snake_case，复数 | `resources`、`flow_versions`、`task_trace_events` |
| 主键 | `id`，`uuid` 类型，应用侧由 `crypto.randomUUID()` 生成 | `id uuid primary key default gen_random_uuid()` |
| 时间 | `timestamptz`，统一 UTC 存储，接口层按需转本地时区 | `created_at timestamptz not null default now()` |
| 结构化数据 | `jsonb`，写入前用 zod 校验；jsonb 列配 JSON Schema 注释（drizzle `.$type<TS 类型>()` 保留类型） | `spec jsonb not null` |
| 外键引用 | 业务引用用资源名（`{namespace,type,name}` 三元组），不跨库建物理外键 | `task_ref text` |
| 软删除 | `deleted_at timestamptz null`，默认查询过滤 `deleted_at is null` | 见 2.4 |

### 2.2 通用资源表（`resources`）

平台采用"通用资源表 + 独立高频表"双轨策略（architecture.md 4.4）。`resources` 是全部声明式资源（Agent/Flow/Skill/Plugin/ModelEndpoint/RuntimeInstance/TaskSchedule/TaskWebhook/Policy/NotificationRule/Blueprint 等）的统一存储：

```sql
create table if not exists resources (
  id                uuid primary key default gen_random_uuid(),
  type              text        not null,                 -- kind 小写化：agent/flow/skill/plugin/...
  namespace         text        not null,                 -- 归属命名空间；system 为全局共享
  name              text        not null,                 -- metadata.name，命名空间内唯一
  spec              jsonb       not null default '{}'::jsonb,  -- 用户声明期望态
  status            jsonb       not null default '{}'::jsonb,  -- 控制器回写实际态
  generation        bigint      not null default 1,       -- spec 变更次数，控制器可感知
  resource_version  bigint      not null default 1,       -- 乐观锁版本，每次 UPDATE 自增
  labels            jsonb       not null default '{}'::jsonb,
  annotations       jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint resources_uniq unique (namespace, type, name)
);

create index idx_resources_type         on resources (type) where deleted_at is null;
create index idx_resources_namespace    on resources (namespace) where deleted_at is null;
create index idx_resources_spec_skills  on resources using gin ((spec -> 'skills')) where deleted_at is null; -- Skill/Agent 反向引用扫描
create index idx_resources_updated_at   on resources (updated_at desc) where deleted_at is null;
```

**乐观并发（CAS）**：所有 PUT/PATCH 必须携带 `resource_version`，更新语句带版本条件，冲突返回 409：

```sql
update resources set spec = $1, generation = generation + 1,
       resource_version = resource_version + 1, updated_at = now()
where namespace = $2 and type = $3 and name = $4
  and resource_version = $5 and deleted_at is null
returning resource_version;   -- 返回 0 行即冲突
```

**各 kind 的 spec/status 结构**：由 `src/resources/*.ts` 中 zod schema 定义并在存入前校验，运行期以 `resources.type` 分派解码器。`spec` 中的敏感字段一律引用 Secret 名（如 `auth.secret_ref`），明文不入资源表。

### 2.3 分表策略

| 存储位置 | 资源/数据 | 理由 |
|---|---|---|
| **通用资源表** `resources` | Agent、ModelEndpoint、Skill、Flow、Plugin、McpServer、RuntimeInstance、TaskSchedule、TaskWebhook、Policy（AgentPolicy/AgentRole/ToolPermission）、Worker、NotificationRule、Blueprint、Namespace | 低频治理资源，jsonb 足够；统一 CRUD 与 RBAC，降低多表成本 |
| **独立表** | `tasks`、`task_messages`、`task_trace_events`、`approvals`、`audit_logs`、`notify_deliveries`、`flow_versions`、`users`、`tokens`、`roles`、`role_bindings`、`secrets` | 高频写入或需行级事务/唯一约束（任务状态机、Trace 批量写、审批决策、审计追加写、凭证加密块） |

**Secret 特例**：资源声明（metadata/引用关系）放 `resources(type='secret')`，而 `encrypted_data`、`sealing_key_id` 等加密块放独立表 `secrets`，原因：加密内容不应经过 jsonb 序列化（防误读/日志泄露），且密钥轮换需独立列维护（见 dld-4.8）。

**性能兜底**：独立高频表未来按需分区（如 `audit_logs` 按月、`task_trace_events` 按保留期）；任务列表/Trace 检索走独立表索引，不依赖通用资源表。

### 2.4 公共字段约定

| 字段 | 约定 |
|---|---|
| `id` | uuid 主键，全部表统一 |
| `created_at` / `updated_at` | timestamptz，`updated_at` 由应用层 UPDATE 语句同步维护（避免触发器），drizzle `.$onUpdate()` 兜底 |
| `deleted_at` | 软删除：治理资源（Agent/Flow/Skill/Plugin）删除 = 标记 `deleted_at` + 写审计，历史引用与审计完整保留；高频运行数据（task_trace_events/audit_logs）不做软删除 |
| 审计字段 | 关键操作表（tasks/approvals）含 `created_by`，供审计追溯 |

### 2.5 迁移策略

- 迁移工具：`drizzle-kit`（`drizzle-orm` 配套）。
- 流程：`src/store/schema.ts` 定义 drizzle schema（含 `.$type<T>()` jsonb 类型）→ `drizzle-kit generate` 生成 SQL 迁移 → `drizzle-kit migrate` 执行。
- 约定：每次变更一个迁移文件（`drizzle/` 目录），禁止手工改已发布的迁移；线上迁移先 `drizzle-kit check` 再做。MVP 内存后端不跑迁移，仅 sql 后端执行。

## 3. 全局实现约定

### 3.1 目录结构（src/）

```
src/
├── server/               # 主服务入口：Hono app 组装、中间件装配、/health /metrics
├── worker/               # worker 入口（M2 独立进程；MVP 内嵌）
├── specs/                # CLI 命令定义（cliyard YAML：_auth.yaml + resources/*.yaml）
├── api/                  # 路由注册（routes/*）、handler、OpenAPI 元数据
├── resources/            # 各 kind 类型定义、zod schema、Manifest 解析（YAML→对象）、normalize
├── store/                # 存储抽象（Store 接口 + memory/sql 实现）、schema.ts、事务
├── controllers/          # 资源控制器：reconcile 循环、生命周期操作（pause/resume/cancel/rerun）
├── flow/                 # Flow 编译（Compile→Machine）、图执行引擎、条件求值、环检测
├── executor/             # 任务执行器：opencode SDK 客户端、SSE 事件解析、会话/工作区/权限
├── approver/             # 审批状态机、resume_context、TTL 扫描器、审批人匹配
├── plugins/              # Plugin 抽象（native/mcp 双后端）、安装生命周期、工具注册表
├── mcp/                  # MCP client（@modelcontextprotocol/sdk）、工具发现/物化
├── modelgw/              # 模型网关：ModelEndpoint 路由、主备切换、健康探测、token 计量
├── trigger/              # cron 调度（node-cron）、Webhook 接收/签名/幂等
├── notify/               # 事件总线、渠道适配器（webhook/wecom/...）、模板引擎、投递重试
├── observability/        # trace 写入队列、task_logs、成本聚合、prom-client 指标、审计 SDK
└── auth/                 # 认证（Token）、RBAC 判定、命名空间解析、system 回退
```

### 3.2 分层依赖规则

```
api → controllers → store
api → approver/trigger/notify（薄 handler 直调服务）
resources（纯类型/校验，无 I/O，被所有层引用）
store（被 controllers/flow/executor/approver/observability 引用）
```

- **resources 是最底层**：只定义类型与 zod schema，不 import 任何运行时模块（除 zod/yaml）。
- **禁止循环依赖**：controllers 不得被 api 层以外反向 import；executor 依赖 store/flow/approver/observability，但 observability 不依赖 executor（事件由上层传入）。
- **错误类型放 `src/api/errors.ts`**（或 `src/shared/errors.ts`），跨层以 `AppError` 子类抛出，不跨层传裸 Error。
- ESLint 规则 `import/no-cycle` 开启，CI 强制。

### 3.3 统一错误处理

| 错误类 | HTTP | 场景 | 可重试 |
|---|---|---|---|
| `NotFoundError` | 404 | 资源/任务/审批不存在 | 否 |
| `ConflictError` | 409 | resourceVersion 冲突、资源被引用禁止删除、重复安装 | 否 |
| `ValidationError` | 422 | zod 校验失败（含字段级详情）、Manifest 解析失败 | 否 |
| `UnauthorizedError` | 401 | Token 缺失/过期/无效 | 否 |
| `ForbiddenError` | 403 | RBAC 拒绝（fail-closed），**必写审计** | 否 |
| `RateLimitError` | 429 | 命名空间配额超限、并发上限 | 是（入队等待） |
| `ExternalTimeoutError` | 504 | opencode serve/MCP/出站 Webhook 超时 | 是 |
| `TransientError` | 500+retryable | 网络抖动、serve 不可达、worker 租约过期 | 是 |

- 统一响应体：`{ error: { code, message, details?, retryable? } }`。
- 全局 handler：`app.onError((err, c) => errorToResponse(err))`，未分类错误按 500 处理并打 ERROR 日志（含 traceId）。
- `retryable` 标记直接喂给 4.5 重试决策器，业务层不重复分类。

### 3.4 日志与 Trace 接入约定

- 日志：`pino`（结构化 JSON），贯穿字段 `{ trace_id, task_ref, namespace, actor }`；`src/observability/logger.ts` 单点创建。
- 脱敏：`redact(obj)` 统一掩码 `secret/token/password/apiKey/authorization` 键，日志与审计共用（dld-4.9）。
- Trace 关联：REST 请求入口生成 `trace_id`（或复用入站事件 traceId），经 `Context` 传递；写入 `task_trace_events` 的每行必带 `trace_id`。
- 编排零 Token：编排内核（状态机/校验/调度）只写日志与 Trace 元数据，不发起任何模型调用（NFR-05）。

## 4. RESTful API 约定

统一前缀 `/api/v1`，Hono 路由注册，OpenAPI 3.1 契约先行（redocly lint）。所有模块（dld-4.1~4.11）的 API 端点遵循本节约定，实现与文档以本约定为唯一事实源。

### 4.1 资源与动词

| HTTP 动词 | 语义 | 示例 |
|---|---|---|
| GET | 读取（列表带分页/过滤） | `GET /api/v1/agents?namespace=dev&page=1&pageSize=20` |
| POST | 创建（返回 201 + Location） | `POST /api/v1/agents` |
| PUT | 全量替换 | `PUT /api/v1/agents/{name}` |
| PATCH | 局部更新 | `PATCH /api/v1/agents/{name}` |
| DELETE | 删除（软删除） | `DELETE /api/v1/agents/{name}` |

### 4.2 资源命名

- 资源名一律复数（agents/flows/tasks/approvals/skills/plugins/runtime-instances/...）
- 资源路径：`/api/v1/{resource}` 与 `/api/v1/{resource}/{id}`（id 用资源 name）
- 命名空间作为查询参数或子路径：推荐查询参数 `?namespace=`（缺省 default）
- 嵌套子资源：`/api/v1/tasks/{id}/trace`、`/api/v1/approvals/{id}/comments`

### 4.3 动作（非 CRUD）约定

- 非 CRUD 动作用 **POST + 子路径动名词**：`POST /api/v1/tasks/{id}/cancel`、`/retry`、`/pause`、`/resume`；`POST /api/v1/flows/{id}/publish`；`POST /api/v1/approvals/{id}/decide`；`POST /api/v1/plugins/{id}/install`；`POST /api/v1/runtime-instances/{id}/test`
- 动作端点必须 POST（副作用），返回 202 Accepted（异步）或 200（同步结果）

### 4.4 状态码与错误

- 2xx：200 OK / 201 Created / 202 Accepted / 204 No Content
- 4xx：400 Bad Request（zod 校验失败，body 含字段错误）、401 Unauthorized、403 Forbidden、404 Not Found、409 Conflict（resource_version 乐观锁冲突 / 命名冲突）
- 5xx：500 Internal / 502 / 503（依赖不可用，如 opencode serve 未连接）
- 错误响应统一 `{ "error": { "code": "RESOURCE_NOT_FOUND", "message": "...", "details": [...] } }`

> 注：`src/api/errors.ts` 的分类（3.3 统一错误处理）已覆盖上述状态码映射；422 语义合并到 400（zod 校验失败）。

### 4.5 分页 / 过滤 / 排序

- 分页：`?page=1&pageSize=20`（默认 pageSize 20，上限 100），响应含 `{ items, total, page, pageSize }`
- 过滤：`?field=value`（如 `?state=pending`）、状态多值 `?state=pending,running`
- 排序：`?sort=created_at&order=desc`
- 列表响应统一 `{ items: [...], total, page, pageSize }`

### 4.6 幂等与并发

- 创建幂等：`POST /api/v1/webhooks/{name}/trigger`（webhook 触发带 Idempotency-Key 头或事件 ID 去重）
- 更新乐观锁：PUT/PATCH 携带 `resourceVersion`，冲突返回 409

## 5. CLI 实现设计（cliyard）

CLI 为 AI/Agent 与自动化提供确定性操作入口，基于 **cliyard**（YAML 驱动 CLI 框架，github.com/guolong123/cliyard）针对平台 RESTful API（`/api/v1`）声明式生成命令。specs/ 目录随平台仓库维护，命令与 API 同步演进；详细命令树与生成分发见 architecture.md 第 6 章。

### 5.1 specs 目录结构（平台仓库内）

```
specs/
├── _auth.yaml            # server(平台 base_url/prefix /api/v1) + auth 链（env token → inject Bearer）
├── _groups.yaml          # 命令分组（如 平台/编排/任务/审批/运行时/生态/设置）
├── resources/
│   ├── agents.yaml       # 命令组 agent：list/create/get/update/delete/publish/enable/disable
│   ├── flows.yaml        # flow：list/create/get/publish/copy/disable/enable
│   ├── tasks.yaml        # task：list/create/get(+trace)/cancel/retry/pause/resume
│   ├── approvals.yaml    # approval：list/decide
│   ├── runtime_instances.yaml  # runtime-instance：list/create/update/delete/test/sync
│   ├── plugins.yaml      # plugin：list/install/configure/uninstall/upgrade
│   ├── mcp_servers.yaml  # mcp-server：list/create/sync
│   ├── skills.yaml       # skill：list/create/update/delete
│   ├── secrets.yaml      # secret：create(+seal)/list/delete
│   ├── webhooks.yaml     # webhook：trigger
│   └── namespaces.yaml   # namespace：list/create
├── flows/                # （可选）cliyard flow 编排：多命令组合
└── plugins/              # （可选）Python 插件：自定义 auth 步骤/输出
```

### 5.2 资源 YAML 示例（agents.yaml 片段）

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

### 5.3 与 RESTful 约定对齐

- 命令名 ↔ API 资源/动词一一映射（见 architecture.md CLI 章节命令树）。
- 动作命令（cancel/retry/publish/decide/install/test/trigger）→ POST 子路径，输出 JSON。
- 分页/过滤参数与 REST 约定一致（page/pageSize/namespace/state）。
- Auth 统一走 `_auth.yaml` 链，AI 场景用 `ORCHESTRA_TOKEN` 环境变量。

### 5.4 给 AI 使用的要点

- 默认输出 JSON（--output json 或环境变量 ORCHESTRA_OUTPUT=json），AI 可稳定解析。
- 命令确定性（无交互式提示，非必填参数用默认值），适合无头调用。
- 错误输出带 API 错误码（RESOURCE_NOT_FOUND 等），AI 可据 code 处理。
- 可通过 `orchestra task get --trace --json` 获取结构化 trace 供 AI 自省。

## 6. 文档清单

| 文档 | 模块 | 核心交付 |
|---|---|---|
| [dld-4.1-platform.md](dld-4.1-platform.md) | 平台基础与治理 | resources 通用表 DDL、RBAC 四表、audit_logs、Hono 路由、Manifest 解析 |
| [dld-4.2-agent.md](dld-4.2-agent.md) | Agent 管理 | AgentSpec/ModelEndpointSpec、引用解析、模型路由、工具交集校验 |
| [dld-4.3-skill.md](dld-4.3-skill.md) | Skill 管理 | SkillSpec、semver 版本、依赖双向校验、prompt 合并与物化 |
| [dld-4.4-flow.md](dld-4.4-flow.md) | 流程编排 | FlowSpec、flow_versions 快照表、状态机编译、DAG 环检测、Blueprint |
| [dld-4.5-task.md](dld-4.5-task.md) | 任务执行与触发 | tasks/task_messages DDL、八态状态机、租约、幂等键、队列抽象、触发器表 |
| [dld-4.6-approval.md](dld-4.6-approval.md) | 人工审批 | approvals DDL、审批状态机、resume_context、TTL、permission 联动 |
| [dld-4.7-runtime.md](dld-4.7-runtime.md) | 运行时集成 | RuntimeInstance 资源、opencode 客户端封装、SSE 解析、会话恢复、worktree |
| [dld-4.8-plugin.md](dld-4.8-plugin.md) | 插件市场 | Plugin/McpServer 资源、MCP client 工具发现、Secret 加密表、SSRF |
| [dld-4.9-observability.md](dld-4.9-observability.md) | 可观测性 | task_trace_events/task_logs DDL、批量写入队列、成本聚合、指标导出 |
| [dld-4.10-notify.md](dld-4.10-notify.md) | 通知与 IM | NotificationRule 资源、notify_deliveries 表、出站 HMAC、企业微信模板 |
| [dld-4.11-eval.md](dld-4.11-eval.md) | Eval 评估 | eval_datasets/eval_runs/eval_case_results DDL、评估运行编排器、评分器、trace 采样 |

> 依赖顺序与实现建议沿用 hld-overview 第 3 节：4.1 先行定稿（资源模型与 RBAC），4.7 的 P1/P2/P6 三项 PoC 在 4.5/4.6 开发前完成。
