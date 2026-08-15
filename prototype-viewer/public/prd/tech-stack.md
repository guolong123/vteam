# Orchestra 技术栈选型

> 平台技术选型总览：每项给出选型、选项对比、决策理由与替代方案。详细决策见 [decisions.md](decisions.md)（ADR-007~014）与 [architecture.md](architecture.md)「技术选型」。
> 更新时间：2026-08-03（后端由 Go 改为 TypeScript）

---

## 1. 总体技术栈一览

| 层 | 选型 | 核心理由 |
|---|---|---|
| 后端语言与运行时 | Node.js 22 + TypeScript 5 | 与 opencode 同生态，复用官方 SDK，全栈 TS 共享类型（ADR-007） |
| Web 框架 | Hono | 轻量、REST 优先、TS 原生、类型安全路由 |
| 数据库 | PostgreSQL 14+ | jsonb 契合声明式资源模型，行级锁支持 Worker 租约，单事实源（ADR-008） |
| ORM 与迁移 | drizzle-orm + drizzle-kit | TS 类型优先、SQL 迁移版本化、贴近 SQL |
| 校验 | zod + 自研 Manifest 解析 | 运行时校验 + TS 类型推断，YAML→资源对象（Spec 校验） |
| API 契约 | OpenAPI 3.1 + redocly | 契约先行，前后端/CLI 对齐，可生成客户端 |
| opencode 集成 | `@opencode-ai/sdk`（官方 TS 客户端）+ `opencode serve` | 复用官方 SDK 免自研客户端及版本演进维护（ADR-010） |
| MCP 客户端 | `@modelcontextprotocol/sdk`（官方 TS） | 标准协议官方实现，工具发现/物化（ADR-011） |
| CLI | cliyard（YAML 驱动 CLI 框架） | 命令与 RESTful API 一一映射，声明式定义免手写命令代码（FR-108~112） |
| 前端 | React 19 + TypeScript + Vite + Tailwind v4 | 全栈 TS、与原型 prototype-viewer 同栈、独立 web/ 目录（ADR-012） |
| 任务队列 | MVP 内存队列 → M2 NATS JetStream | MVP 单机足够，分布式 worker 再引入（ADR-008） |
| 可观测 | prom-client + OpenTelemetry JS SDK | 标准观测栈：/metrics + 链路导出 + 结构化日志 + 审计表 |
| 安全与凭证 | AES 加密存储 + HMAC 签名 + urlguard SSRF 防护 + fail-closed | 多租户安全基线（NFR-01/02） |
| 测试框架 | vitest 4.x | Node 服务端测试、src 内联约定、TDD（§2.14） |

---

## 2. 逐项选型说明

### 2.1 后端语言与运行时：Node.js 22 + TypeScript 5

- **选项对比**：
  - A. Go：单二进制、高并发、部署简单（对标 Orloj/Temporal）
  - B. Python：生态好，性能与部署偏弱
  - C. TypeScript/Node：与 opencode 同生态，全栈 TS —— **已采纳**
- **决策**：TypeScript（Node 22 + TypeScript 5）。
- **理由**：opencode 官方提供 `@opencode-ai/sdk`（TS 类型安全客户端，覆盖 session/config/event/permission 全部 API）；平台与 opencode 深度集成（MCP 注入、SSE 事件解析、结构化输出 json_schema、permission 应答），复用 SDK 免自研客户端及其长期跟随 opencode 版本演进的维护成本；全栈 TS 使前端（React/TS prototype-viewer）与后端共享类型与工具链；编排内核为确定性状态机零 token 消耗（NFR-05），负载完全在 Node 舒适区（对标 n8n/Temporal-TS 等 JS 编排生态）。
- **替代方案/演进**：若未来编排规模极大可评估 Go 边车服务承载高吞吐路径。
- **对应**：ADR-007（2026-08-03 修订，原 Go 改为 TypeScript）。

### 2.2 Web 框架：Hono

- **选项对比**：Hono / Fastify / Express / NestJS。
- **决策**：Hono。
- **理由**：平台以 REST API 优先，Hono 轻量、TS 原生、类型安全路由（路径参数/响应体类型推导），依赖轻、边缘兼容，无需 Express 的中间件负担或 NestJS 的重型 DI 结构。
- **替代方案/演进**：若未来需要 DI/模块化重型框架、复杂拦截器体系，可评估迁移 NestJS（与 TS 生态兼容）。

### 2.3 数据库：PostgreSQL 14+

- **选项对比**：PostgreSQL / MySQL / SQLite（本地开发）。
- **决策**：PostgreSQL 14+（生产），本地开发支持内存后端（存储层抽象，双实现）。
- **理由**：资源状态/任务/Trace/审计单存储，避免多存储一致性成本（对标 Orloj）；jsonb 契合声明式资源模型（通用资源表 spec/status）；`SELECT ... FOR UPDATE` 行级锁支持 Worker 租约（任务 claim/lease）；单一事实源。
- **替代方案/演进**：本地开发用内存后端（架构 2.3 演进：memory → Postgres → 分布式）；Task/Trace 高频场景若 jsonb 通用表性能不足，可拆独立物理表。

### 2.4 ORM 与迁移：drizzle-orm + drizzle-kit

- **选项对比**：drizzle-orm / Prisma / TypeORM / node-pg 裸写。
- **决策**：drizzle-orm（迁移用 drizzle-kit）。
- **理由**：TS 类型优先（schema 即类型），查询贴近 SQL 无隐式开销；drizzle-kit 生成 SQL 迁移并版本化；相比 Prisma 更轻量、无 codegen 运行时；相比裸写 node-pg 提供类型安全查询。
- **替代方案/演进**：若需要自动迁移的可视化管控与更强 ORM 抽象，可评估 Prisma。

### 2.5 校验：zod + 自研 Manifest 解析

- **选项对比**：zod / joi / yup / JSON Schema。
- **决策**：zod（运行时校验 + TS 类型推断）+ 自研 YAML Manifest 解析（管线：YAML → zod → normalize → CAS upsert）。
- **理由**：zod 单一 schema 同时产出运行时校验与静态类型，资源 Spec 校验类型安全；自研解析管线处理 YAML 声明式资源（一切皆资源，声明式优先原则）；与 cliyard 参数校验风格统一。
- **替代方案/演进**：若需跨语言共享校验规则，可迁移 JSON Schema（zod 可生成 JSON Schema 桥接）。

### 2.6 API 契约：OpenAPI 3.1 + redocly

- **决策**：契约先行。Hono 路由定义同时生成 OpenAPI 3.1 描述，redocly lint 校验规范；CLI specs 与前端类型均以契约为对齐基准。
- **理由**：前后端/CLI 三方对齐；可生成客户端与文档；opencode 侧 `GET /doc` 亦暴露 OpenAPI 3.1 spec，平台侧同标准便于互操作。
- **替代方案/演进**：契约文件独立于路由代码手工维护（当前以路由生成优先）；未来可用 openapi-generator 生成类型化客户端。

### 2.7 opencode 集成：@opencode-ai/sdk + opencode serve

- **选项对比**：
  - A. 官方 `@opencode-ai/sdk`：TS 类型安全客户端，随 opencode 版本演进 —— **已采纳**
  - B. 自研 HTTP 客户端（基于 OpenAPI 生成）：完全可控，但需跟随 opencode API 演进持续维护
- **决策**：官方 `@opencode-ai/sdk`（`createOpencodeClient`、`event.subscribe` SSE 事件流、`session.prompt` 结构化输出 json_schema、`noReply` 注入、`postSessionByIdPermissionsByPermissionId` 应答审批联动），运行方式为 `opencode serve` 常驻实例（headless HTTP，默认端口 4096，`OPENCODE_SERVER_PASSWORD` Basic 认证）。
- **理由**：serve 是 opencode 官方程序化对接方式（TUI/Web/IDE 均为其客户端），提供 OpenAPI spec 与官方 SDK；复用 SDK 随版本演进免维护、类型安全、覆盖全 API；常驻进程避免每任务冷启动（含 MCP server）；session 原生持久化解决长任务恢复。
- **替代方案/演进**：自研客户端（仅当 SDK 无法满足场景时兜底）；serve 实例部署位置（与 worker 同机或独立节点）在部署设计确定。
- **对应**：ADR-010。

### 2.8 MCP 客户端：@modelcontextprotocol/sdk（官方 TS）

- **决策**：`@modelcontextprotocol/sdk`（TS 官方实现），负责握手、`tools/list` 工具发现、工具调用；外部系统实现 MCP Server，平台自动发现工具物化。
- **理由**：MCP 是 2026 年工具接入事实标准（对标 Camunda/Orloj 均以 MCP 为接入层），官方 SDK 实现协议细节，生态复用；插件抽象统一支持"原生实现"与"MCP 适配"两种后端（ADR-011）。
- **替代方案/演进**：若需非 TS 侧 MCP 能力或扩展协议，可评估其他语言 SDK，但当前全栈 TS 下官方 TS SDK 为唯一实现。
- **对应**：ADR-011。

### 2.9 CLI：cliyard（YAML 驱动 CLI 框架）

- **选项对比**：
  - A. cliyard：YAML 声明式定义命令，针对 REST API 生成 —— **已采纳**
  - B. 手写命令框架（commander/yargs/click）：需逐命令维护代码
  - C. 自研 CLI 框架：成本高，不必要
- **决策**：cliyard（github.com/guolong123/cliyard），两种模式：开发期 **Library 模式**（`create_cli('./specs/')` 动态生成，无编译）；交付 **Gen 模式**（`cliyard gen --name orchestra` 生成独立 pip 包）。生成产物为 click（Python）命令组，跨平台。
- **理由**：命令与 RESTful API 一一映射（资源=命令组、动词=子命令，FR-108）；specs/ 目录随仓库维护，命令与 API 演进同步（FR-112）；AI 场景确定性 JSON 输出、无交互默认值（FR-109）；无需手写命令代码；本机已验证（`cliyard usage` 完整可用）。
- **替代方案/演进**：若需深度自定义命令行为（非声明式可表达），可混用 cliyard plugins（Python）扩展。
- **对应**：hld-cli.md / dld-cli.md，FR-108~112。

### 2.10 前端：React 19 + TypeScript + Vite + Tailwind v4

- **选项对比**：React / Vue / Svelte。
- **决策**：React 19 + TypeScript + Vite，样式方案 Tailwind CSS v4；独立前端应用（`web/`），通过 REST API 与后端交互；编排画布 M3 预留图形库选型。
- **理由**：全栈 TS 与后端共享类型；生态成熟；与原型 prototype-viewer 同栈（React 19 + Tailwind v4，实证于 prototype-viewer/package.json），原型组件可直接迁移至正式控制台，避免引入第二套前端技术；画布晚做避免过早绑定图库。
- **替代方案/演进**：控制台界面复杂度上升时可选企业级组件库（如 Ant Design / shadcn/ui）补充；M3 画布时再评估图库（如 React Flow）。
- **对应**：ADR-012（前端形态）、ADR-013（PRD 文档内嵌原型，prototype-viewer 同栈）。

### 2.11 任务队列与消息

- **选项对比**：内存队列 / NATS JetStream / BullMQ / Temporal。
- **决策**：MVP 用**内存队列**（channel + worker pool，单机 worker，sequential / message-driven 两种模式）；M2 换 **NATS JetStream**（分布式 worker 消息驱动，FR-506）。
- **理由**：MVP 单机部署内存队列足够，避免过早引入消息总线复杂度（ADR-008）；消息总线仅当需要分布式 worker 时才引入；存储层与消息层抽象接口，演进替换透明。
- **替代方案/演进**：M2 若 NATS 运维成本偏高，可评估 BullMQ（Redis 生态）作为替代；Temporal 的重型持久化执行模型与"确定性状态机 + 资源控制器"定位重叠，当前不引入。
- **对应**：ADR-008。

### 2.12 可观测：prom-client + OpenTelemetry JS SDK

- **决策**：Prometheus 指标（`/metrics` 独立端口，prom-client）+ OTEL 链路导出（`@opentelemetry/sdk-node`）+ 结构化日志 + 审计表（双写）。
- **理由**：标准观测栈，Node 侧 prom-client 与 OTEL SDK 均成熟；导出编排控制链路（NFR-05，不导出 Agent 推理）；Trace 事件异步批量落库，观测不阻塞执行路径。
- **对应**：architecture 4.9 可观测性模块；FR-901~905。

### 2.13 安全与凭证

- **决策**：
  - 凭证：Secret AES 加密存储（`secrets` 表 `encrypted_data` + `sealing_key_id`，pgcrypto 或应用层加密），绝不落明文（NFR-01）；
  - Webhook：HMAC 签名校验（入站触发 `signature_secret_ref`；出站通知 HMAC-SHA256 签名）；
  - SSRF 防护：出站请求统一过 `urlguard` 预检（解析目标 IP，拒绝 RFC1918 / 169.254.0.0/16 等私网与云元数据地址，默认禁私网）；
  - 治理：fail-closed（NFR-02），未授权动作运行期强制拒绝并记录审计，而非仅文档约定。
- **理由**：多租户安全基线（NFR-01/02）：凭证隔离是安全底线（ADR-004），出站 URL 预检防内网探测/凭证窃取（hld-4.8-plugin），Webhook 双向签名防伪造。
- **替代方案/演进**：SealedSecret 模型（M2 强化）、插件沙箱（M3）。

### 2.14 测试框架：vitest 4.x

- **选项对比**：vitest / jest / node:test。
- **决策**：vitest（`environment: 'node'`，`include: ['src/**/*.test.ts']` src 内联约定，coverage provider v8，阈值后置）。
- **理由**：平台为 Node 服务端，无 DOM 依赖，不需要 jsdom；vitest 与 Vite 同工具链、TS 原生（E2E：直接吞 nodenext 模块解析含 `.js` 后缀 import 映射），启动快、watch 友好；src 内联 `*.test.ts` 保证"实现与测试同目录"的可发现性。
- **测试方式**：
  - **scaffold 任务**：TDD 三步（RED → GREEN → 复原断言验证失败可见），如 `src/store/__poc__/p4-lease.test.ts`（PoC P4 租约并发验证）；数据库依赖用例在 pg 不可达时整体 skip，不阻塞 CI。
  - **PoC 验证**：repro-script + assertion 模式——`scripts/poc/*.mjs` 脚本内嵌断言（子断言 a–f）输出 JSON 报告 + 退出码 0/1，供 QA 场景逐条核对（P1~P6 均按此执行）。
- **替代方案/演进**：若需浏览器端组件测试再引入 jsdom/Testing Library；node:test 可作零依赖兜底。
- **对应**：vitest 测试基建（Phase 0 Task 3）；CI `check` job 前置 `npx vitest run`。

---

## 3. 选型原则与权衡

1. **全栈 TypeScript 一致性**：后端/前端/原型/CLI 类型统一，减少上下文切换与契约漂移。
2. **复用官方 SDK 免维护**：opencode 与 MCP 均用官方 SDK，随上游版本演进，不重复造轮子。
3. **声明式优先**：一切皆资源（YAML Manifest 可版本化/评审/审计），CLI 命令、资源 Spec、配置均声明式定义。
4. **标准协议**：OpenAPI 3.1（API 契约）、MCP（工具接入）、Prometheus/OTEL（观测），标准先行，生态复用。
5. **编排零 Token**：编排内核为确定性状态机（NFR-05），执行委托 opencode，平台不做"实现"。
6. **平台与业务分离**：技术栈服务于平台内核，业务（Agent/Flow/Blueprint）以声明式资源按需安装。
7. **演进而非推翻**：本地 memory → Postgres → NATS，同一资源模型逐步演进（架构 2.3），替代方案均保留演进路径。

---

## 4. 演进路径

| 阶段 | 变更 |
|---|---|
| M1→M2 | 内存队列 → NATS JetStream；Skill 目录物化；Token 成本统计；OTEL/Prometheus 指标导出；Blueprint 参数化定制 |
| M1→M3 | 编排画布（React Flow 类图库选型）；插件沙箱强化；SealedSecret 强化 |
| 未来 | 若编排规模大评估 Go 边车服务承载高吞吐路径；CLI plugins 扩展深度自定义命令；多运行时（Claude Code/Codex）经插件扩展 |
