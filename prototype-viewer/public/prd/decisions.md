# Orchestra 设计决策记录（ADR）

> 本文件记录需求评审阶段的关键设计决策（对应 PRD 第 8 章开放问题 Q1~Q6，及架构评审新增决策 D1~D6）。
> 每条决策含：背景、选项、决策、理由、影响、状态。
> 状态：`已采纳` = 进入架构设计；`待验证` = 架构实现时需 PoC 验证。

---

## ADR-001：opencode 运行时状态同步粒度（PRD Q1）

- **背景**：Agent 运行时为 opencode，平台需要了解任务执行进度。粒度越细，Trace 越精细，但解析与状态同步实现越复杂。
- **选项**：
  - A. Agent 整体完成同步（粗粒度，简单）
  - B. 步骤/工具调用实时同步（细粒度，复杂）
  - C. 双轨：状态机用粗粒度驱动（Agent 级），Trace 用细粒度记录（步骤级）——**已采纳**
- **决策**：**双轨制**。任务状态机以"Agent 节点完成"为粒度推进（决定流程下一步）；同时解析 opencode serve 的 SSE 事件流（`/event`、`/global/event`），将步骤/工具调用/Token 消耗写入 Task Trace（仅观测，不驱动流程）。
- **理由**：状态机粒度粗 → 实现简单、故障恢复可控；Trace 粒度细 → 满足排障与成本统计需求（PRD FR-901~903）。两者解耦，互不阻塞。
- **影响**：平台订阅 opencode serve 的 SSE 事件流（`GET /event`）并异步写入 Trace；事件流不可用时降级为"Agent 级状态同步 + session 轮询"。
- **状态**：已采纳

## ADR-002：审批前置自动化（PRD Q2）

- **背景**：是否允许 LLM 预审 + 人工抽审，减少人工负担。
- **选项**：
  - A. 纯人工审批（MVP）
  - B. LLM 预审 + 人工复核（复杂，可信度存疑）
  - C. 纯人工为主，预留"自动化预审"扩展点——**已采纳**
- **决策**：MVP 审批关卡**仅人工决策**。在 Approval 资源中预留 `auto_review_policy` 字段（空 = 不启用），架构上留接口，但不实现。
- **理由**：人工审批是本平台区别于"全自动 agent"的核心价值（PRD 1.2），MVP 必须保证决策完全由人做出；自动预审涉及可信度、误杀/漏放、审计责任等复杂问题，后续独立迭代。
- **影响**：审批状态机无自动分支；`auto_review_policy` 仅占位。
- **状态**：已采纳

## ADR-003：Blueprint 业务包定制粒度（PRD Q3）

- **背景**：用户安装"软件公司开发流程"业务包后，能定制到什么程度。
- **选项**：
  - A. 仅参数化定制（改配置不改结构）
  - B. 结构可改（改流程图/增删 Agent）
  - C. 分层：参数可改（MVP）+ 结构可覆盖（M2）——**已采纳**
- **决策**：**分层定制**。MVP：Blueprint 安装后允许修改参数（提示词、模型、工具白名单、审批人、TTL）；M2：允许通过"覆盖层"修改流程结构（基于引用替换，不修改原始包）。
- **理由**：结构修改在 MVP 引入"包升级与定制冲突"问题（fork 后无法跟随上游更新），先以参数化满足大部分需求；引用覆盖机制作为 M2 增强。
- **影响**：Blueprint 需要资源引用模型（引用名 → 实际资源），参数需 schema 声明。
- **状态**：已采纳

## ADR-004：跨命名空间共享资源（PRD Q4）

- **背景**：多租户下是否需要共享 Agent/插件/Skill。
- **选项**：
  - A. 严格隔离，无共享
  - B. 全局（system 命名空间）共享 + 命名空间私有——**已采纳**
  - C. 完全共享
- **决策**：**系统命名空间（`system`）共享 + 命名空间隔离**。全局插件、通用 Agent、共享 Skill 定义在 `system` 命名空间，各命名空间可引用；凭证始终隔离。
- **理由**：插件市场、通用 Agent（如"通用代码评审 Agent"）天然需要全局共享；凭证隔离是安全底线（NFR-01）。命名空间解析规则：优先本命名空间，未命中回退 `system`。
- **影响**：资源引用需要作用域解析逻辑；跨命名空间引用权限需受控（RBAC）。
- **状态**：已采纳

## ADR-015：SealedSecret 资源与双键轮换（M2-12，2026-08-04 补）

- **背景**：architecture.md §4.2 资源清单已有 `Secret / SealedSecret | data（加密）/encryptedData | phase`，但 spec/status 结构、rotate 语义、密钥轮换细节未定义（dld-4.8/tech-stack §2.13 缺口）。M1 已实现 `src/store/secret-crypto.ts`（AES-256-GCM 单主键 `env-master-v1`，加密块 `base64(iv‖tag‖ciphertext)`）。
- **决策**：**引入 `SealedSecret` 资源 kind（`resources(type='sealed-secret')`），密文块直接置于 spec.data（与 Secret 的"明文不入资源表"特例不同——密文经 jsonb 序列化是安全的），状态回写 status**。
  - **spec**：`{ data: Record<string,string> }` —— 每个 value 为独立 AES-256-GCM 加密块（base64），格式沿用 `secret-crypto.ts` `SealedBlock`（iv 12B‖authTag 16B‖ciphertext），**逐 key 独立加密**（支持逐条目轮换/宽限期回退）。
  - **status**：`{ phase: 'Sealed'|'Unsealed'|'Error', sealingKeyId, previousKeyId?, graceUntil?, dataKeys[], lastError? }`。phase 语义：`Sealed`=密文就绪未验证；`Unsealed`=最近一次 unseal 成功（密钥可用）；`Error`=unseal 失败（密钥缺失/密文损坏/宽限期后旧键条目未轮换）→ fail-closed 禁止注入。
  - **双键轮换**：`POST /api/v1/sealed-secrets/{name}/rotate` → 用当前 activeKey 解密全部条目（previousKey 兜底）→ 用新 activeKey 重加密 → status.activeKeyId 更新、旧键降为 previousKey 进入宽限期（`graceUntil`，默认 7d）；宽限期内旧密文仍可解，过后旧键条目未轮换 → `Error`。
  - **并发**：rotate 以 `metadata.resourceVersion` CAS 防并发轮换；幂等（已是最新 activeKey → 200 不重复重加密）。
- **理由**：SealedSecret 密文可备份/迁移/审计（密文不可逆），密钥轮换不暴露明文；逐 key 加密块与 M1 `SealedBlock` 复用，双键宽限期兼容分布式副本延迟与旧数据回退。
- **影响**：`src/resources/schemas.ts` REGISTRY 增 `sealed-secret` kind；rotate 控制器走 GenericStore CAS；解密仍复用 `secret-crypto.ts` unseal（需支持 previousKey 兜底）。
- **状态**：已采纳（M2-12 前置）

## ADR-016：Artifact 产物资源数据模型（M2-11，2026-08-04 补）

- **背景**：ADR-005 已定"引入 Artifact 资源，M2 实现"，但表 DDL 与 type/schema_ref/issue_ref/pr_ref 语义未细化。
- **决策**：**Artifact 独立表 `artifacts`**（refine 后 DDL 如下），`(namespace, name, version)` 唯一，版本递增：
  - **type 枚举**：`requirement/design/testcase/testreport/code/diagram`（可扩展，Registry 校验）。
  - **content**：`{ format: 'markdown'|'json'|'file', body?, ref? }` —— markdown/json 内联内容，file 类型存工作区相对路径引用（**不落文件内容**，路径沙箱校验防越权）。
  - **schema_ref**：可选，引用平台 Schema 资源名或内联 JSON Schema 标识；存在则内容写入/更新时按 schema 校验（T11 实现校验器，MVP 可先存引用后校验）。
  - **issue_ref / pr_ref**：**引用字段，非真实联动**——存外部 issue/PR 标识符字符串（跳转/归档用），不调用 Gitee/GitHub API、不校验存在性。
  - **task_id**：可空；关联产生该产物的任务（taskRef 归一化），归档闭环。
- **DDL（refine 版）**：

```sql
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  name text not null,
  type text not null,               -- requirement/design/testcase/testreport/code/diagram
  task_id uuid references tasks(id),
  content jsonb not null default '{}', -- {format: markdown|json|file, body?, ref?}
  schema_ref text,                  -- 产物 Schema 校验引用（可选）
  issue_ref text,                   -- 关联 issue（引用字段，非真实联动）
  pr_ref text,                      -- 关联 PR（引用字段）
  version int not null default 1,
  created_by text,                  -- 发起人（审计）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifacts_uniq unique (namespace, name, version)
);
-- 索引：idx_artifacts_ns_name (namespace, name)、idx_artifacts_task (task_id)
```

  - 相对计划草案 refine：`content` 补 `not null default '{}'` + 结构化 `{format, body?, ref?}`；补 `created_by`/`updated_at`（审计对齐 tasks 表）；`id` 显式 `primary key`；补 task 索引。
- **理由**：版本化 + 引用语义满足 ADR-005 验收归档闭环；issue/pr 仅引用避免反向集成耦合（与 M2 排除真实集成决策一致）。
- **影响**：M2-11 建表 + REST CRUD + 版本 latest 查询（`max(version)`）；Task 输出模型预留升级路径。
- **状态**：已采纳（M2-11 前置）

## ADR-005：产物 Schema 归档（PRD Q5）

- **背景**：需求文档/设计文档/测试用例/测试报告是否做结构化归档。
- **决策**：**引入 Artifact（产物）资源，M2 实现**。产物类型（`type`：requirement/design/testcase/testreport/code/diagram…）、内容（Markdown/JSON/文件引用）、Schema 校验、与关联对象（issue/PR/Task）的引用关系、版本化。MVP 阶段任务输出完整保存，可升级为 Artifact。
- **理由**：这是平台差异化点（验收归档闭环），但 MVP 优先跑通编排主链路；产物 Schema 过早固化会阻碍流程演进。
- **影响**：Task 输出模型需预留升级路径；M2 增加 Artifact 资源与 API。
- **状态**：已采纳（M2 实现）

## ADR-006：轻量模式（PRD Q6）

- **背景**：是否需要"零配置 Agent"模式降低门槛。
- **决策**：**MVP 不提供轻量模式**。Agent 必须显式声明运行时、模型引用、提示词；提供"快速创建"模板（预置常用 Agent 模板）降低录入成本。轻量模式列入 P2。
- **理由**：Agent 定义是平台核心资产，隐式默认值会带来"跑起来但说不清在跑什么"的问题，违背声明式优先原则（技术约束 3）。
- **影响**：预置 Agent 模板库（需求分析/架构设计/测试用例/编码/评审等）随 MVP 提供。
- **状态**：已采纳

---

## ADR-007：后端技术栈（架构新增，2026-08-03 修订）

- **背景**：平台后端语言选型。
- **选项**：
  - A. Go（对标 Orloj/Temporal：单二进制、高并发、部署简单）
  - B. Python（生态好，性能/部署弱）
  - C. TypeScript/Node（复用官方 SDK，全栈 TS）——**已采纳**
- **决策**：**TypeScript（Node + TS）**。
- **理由**：opencode 官方提供 `@opencode-ai/sdk`（TS 类型安全客户端，覆盖 session/config/event/permission 全部 API）；平台与 opencode 深度集成（MCP 注入、SSE 事件解析、结构化输出 json_schema、permission 应答），复用 SDK 省去自研客户端及其长期跟随 opencode 版本演进的维护成本；全栈 TS 使前端（React/TS prototype-viewer）与后端共享类型与工具链；编排内核为确定性状态机零 token 消耗（NFR-05），负载完全在 Node 舒适区（对标 n8n/Temporal-TS 等 JS 编排生态）。
- **影响**：后端采用 Node + TypeScript；直接依赖 `@opencode-ai/sdk`；MCP client 用 `@modelcontextprotocol/sdk`（TS 官方）；部署为 Node 服务（Docker 镜像）；原 Go 包结构（internal/）改为 TS 模块（src/）；概要设计中的 Go 表述相应更新。
- **状态**：已采纳（2026-08-03 修订：由 Go 改为 TypeScript，理由见上）

## ADR-008：存储与消息

- **背景**：资源状态、任务执行、Trace 的持久化与分布式消息。
- **决策**：
  - 存储：**Postgres**（资源状态 + 任务 + Trace + 审计；任务表含租约字段）。本地开发支持内存后端。
  - 消息：MVP 用**内存队列**（单机 worker）；M2 引入 **NATS JetStream** 支持分布式 worker 消息驱动（FR-506）。
- **理由**：Postgres 单一事实源，避免多存储一致性成本（对标 Orloj）；消息总线仅当需要分布式 worker 时才引入。
- **影响**：存储层需抽象接口（memory/sql 双实现）；任务 claim/lease 用 SQL 行级锁实现。
- **状态**：已采纳

## ADR-009：编排执行模型

- **背景**：流程如何驱动执行。
- **决策**：**确定性状态机 + 资源控制器**（融合 Orloj 与 Red Queen）：
  - 资源模型/控制器循环（Orloj 风格）：资源有 desired state/status，控制器 reconcile 驱动状态前进。
  - 流程执行为**确定性状态机**（Red Queen 风格）：编排决策（下一步执行谁、是否进入审批、重试路由）由**纯逻辑**完成，**编排内核不消耗模型 Token**（NFR-05）。
- **理由**：可预测、可审计、故障可恢复；编排与执行（opencode）彻底解耦。
- **影响**：Flow 定义编译为状态机图；状态持久化于 Postgres，支持断点恢复。
- **状态**：已采纳

## ADR-010：opencode 集成方式（serve API 模式）

- **背景**：opencode 作为运行时如何被调度。
- **决策**：**通过 `opencode serve` 以 HTTP API 对接（非 CLI 子进程）**。平台在 Agent 运行时所在节点部署常驻 `opencode serve` 实例（headless HTTP 服务器，默认端口 4096，`OPENCODE_SERVER_PASSWORD` HTTP Basic 认证），通过其 REST API + SSE 事件流驱动：
  - **会话管理**：每 Task 通过 `POST /session` 创建独立会话（session 级隔离），`POST /session/:id/prompt_async` 异步提交任务（返回 204 即受理），也可 `POST /session/:id/command` 执行 slash command、`POST /session/:id/shell` 执行 shell；
  - **状态同步**：订阅 `GET /event` / `GET /global/event`（SSE 事件流，首个事件 `server.connected`）解析为平台步骤事件与 Trace（满足 ADR-001 双轨）；`GET /session/status` 轮询兜底；
  - **会话恢复**：长任务会话保持/断线恢复由 opencode session 机制原生支持（session 持久化于 opencode 本地存储），平台持久化 session id，重启后 `GET /session/:id` 恢复续跑；运行中可 `POST /session/:id/abort` 中止；
  - **产物获取**：编码产物通过 `GET /session/:id/diff` 获取，供归档（关联 ADR-005）；
  - **审批联动**：opencode 运行中的高风险操作会触发 permission 请求，平台通过 `POST /session/:id/permissions/:permissionID` 应答，将其与平台 ToolApproval（FR-606）联动——高风险工具调用在平台侧暂停审批，通过后注入 opencode 继续；
  - **工作区隔离**：每 Task 独立工作区（git worktree/独立 clone，FR-704）；
  - **API 契约**：`GET /doc` 暴露 OpenAPI 3.1 spec，可据此生成/实现客户端。
- **理由**：serve 是 opencode 官方程序化对接方式（提供 OpenAPI spec 与官方 SDK，TUI/Web/IDE 均为其客户端）；常驻进程避免每任务冷启动（含 MCP server 冷启动）；session 原生持久化天然解决长任务恢复；SSE 事件流满足双轨 Trace；permissions 端点使平台审批与 opencode 运行时权限请求可双向联动。
- **影响**：需要 opencode serve 的进程生命周期管理（守护/健康检查 `/global/health`/崩溃重启）；API 契约随 opencode 版本演进（以 OpenAPI spec 为准）；Node/TS 侧直接复用官方 `@opencode-ai/sdk` 作为 opencode API client，无需自研；serve 实例部署位置（与 worker 同机或独立节点）需在部署设计确定。
- **状态**：已采纳（附 PoC 验证项）

## ADR-011：插件架构

- **背景**：第三方系统对接方式（Jenkins/GitHub/Gitee）。
- **决策**：**MCP 协议为一等接入标准**（外部系统实现 MCP Server，平台自动发现工具物化）；首批内置插件（Jenkins/GitHub/Gitee）以**平台原生 Plugin 实现**（含配置界面），同时提供 MCP 接入能力。凭证按命名空间隔离加密存储。
- **理由**：MCP 是 2026 年事实标准（对标 Camunda/Orloj 均以 MCP 为接入层），生态复用；内置插件保证开箱体验。
- **影响**：Plugin 抽象需同时支持"原生实现"与"MCP 适配"两种后端；凭证注入点统一（tool_auth）。
- **状态**：已采纳

## ADR-012：前端形态

- **背景**：Web 控制台技术选型。
- **决策**：**React 19 + Tailwind CSS v4**（独立前端应用 `web/`，通过 REST API 与后端交互）；编排画布 M3 图形库选型见下「ADR-012a」。
- **理由**：生态成熟；与原型 prototype-viewer 同栈（React 19 + Tailwind v4），原型组件可迁移复用，避免引入第二套前端技术（原 Ant Design 方案废弃）。
- **影响**：前端独立仓库目录 `web/`（与 prototype-viewer 分开，原型组件迁移后原型仅保留文档展示职责）；API 契约先行（OpenAPI）。
- **状态**：已采纳

### ADR-012a：编排画布图形库选型（M3-1，2026-08-04 增补）

- **背景**：FR-410 可视化编排画布（拖拽 Agent 节点/连线/配置条件）的图形库选型。M3 规划前画布实现路径未定：flow-editor 原型为自绘 SVG（604 行静态演示，无真实拖拽/缩放/连线交互），web/ 与 prototype-viewer/ 均无图库依赖。
- **候选方案**：
  1. **React Flow（`@xyflow/react` v12）**——成熟图库（周下载 ~970 万），拖拽/连线/平移缩放/自定义节点与边开箱即用；
  2. **自绘 SVG**——基于 flow-editor 原型扩展，零依赖但拖拽/连线吸附/平移缩放/选择框全需自研（预计 2000+ 行）并长期自维护；
  3. **React DnD + 自绘**——仅解决节点拖拽，连线/缩放仍自研，两头不讨好。
- **决策**：**采用 `@xyflow/react@^12.11.2`（React Flow v12）作为编排画布图形库**，与前端形态（React 19 + Tailwind v4）同栈落地。
- **理由**：
  - **交互能力全覆盖**：拖拽节点/连线（`onConnect` + `addEdge`）/平移缩放（`panOnDrag`/`zoomOnScroll`/`fitView`）/受控模式（`nodes`/`edges` + `onNodesChange`/`onEdgesChange`）开箱即用；flow-editor 原型的节点库/属性面板/并行分组框交互模型可用自定义 `nodeType`/`edgeType` 完整复刻；
  - **特殊节点支持**：parallel/join/loop/subflow（M3-2 预留）均可实现为自定义节点，loop 回边/任意环边原生支持，无需自研连线算法；
  - **只读模式复用**：flow-detail（FR-408）以 `nodesDraggable={false}` `nodesConnectable={false}` `elementsSelectable={false}` 复用同一画布组件渲染已发布流程与版本历史，双模式零成本；
  - **React 19 兼容已验证**：v12 peerDependencies `react>=17`（含 React 19；此前 zustand 4 的 peer 冲突已由 zustand 4.5.6 修复）；
  - **包体积可控**：gzip 58.7KB（unminified 184KB），画布路由懒加载后对首屏无影响；
  - **生态与维护**：事实标准（n8n 等低代码/工作流产品通用），MIT，文档/示例丰富，社区持续维护。
- **影响**：
  - `web/package.json` 新增依赖 `@xyflow/react@^12.11.2`；可选 `dagre@^0.8.5` 自动布局（首次反序列化缺 position 时使用）；
  - 需引入 `@xyflow/react/dist/style.css`；画布路由懒加载分摊体积；
  - **双 schema 映射层**（M3 Wave 2 T2.2）：Flow spec（业务 `nodes[]`/`edges[{from,to}]`，无坐标）↔ React Flow（UI `nodes[{id,position}]`/`edges[{source,target}]`）；业务边 type（sequential/conditional/parallel）须存于 `data` 字段，不得直接复用 React Flow 边 type；position 建议存可选 `layout` 字段，保证 JSON↔画布往返一致（M3 DoD）；
  - flow-create 保留 JSON 模式切换（Wave 2 T2.3）；flow-detail 改为画布只读视图（T2.4）；
  - 原型 flow-editor（自绘 SVG）保持文档展示用途，不迁移为生产画布。
- **备选方案**：自绘 SVG——仅当出现"零运行时依赖"硬约束时回退。
- **状态**：已采纳（M3-1 落地；Wave 2 实施时按此版本安装）

---

## ADR-013：PRD 文档内嵌原型（需求文档可视化）

- **背景**：PRD 文档（需求）与界面原型（UI）分离维护，评审时需在文档与原型间反复跳转；希望文档即评审入口，原型嵌入文档随文展示。
- **决策**：**在 PRD Markdown 中引入原型标记（fenced code block 语言 `prototype`），由 prototype-viewer 的 PRD 阅读器解析并内嵌渲染可交互原型**。
  - 块级标记 ```` ```prototype ````（id/title/device/height 参数）→ 内嵌原型（含 PC/移动端切换）；
  - 清单标记 ```` ```prototype-list ```` → 自动列出本文档引用的全部原型；
  - 内联标记 `@prototype[<id>]` → 段内引用样式；
  - 说明性示例用 4+ 反引号围栏包裹，解析器跳过文档示例区。
  - 技术实现：`parser.ts` 将标记替换为占位符行 → remark 插件转为自定义 mdast 节点 → `remark-rehype unknownHandler` 转为 `data-proto` div → react-markdown `components` 拦截渲染为原型组件。
- **理由**：标准 Markdown 语法（GitHub/IDE 中为代码块，阅读器中为可交互原型），零 DSL 成本；文档与原型单点关联（`id` 即注册表 id），评审闭环（文档内直接看原型、切设备、跳转原型视图）。
- **影响**：PRD 文档需按 4.11.1 节规范书写标记；`public/prd/requirements.md` 需随 `docs/requirements.md` 同步（`cp` 命令，暂未自动化）。
- **状态**：已采纳（v0.2 实现）

## 待验证项（PoC 清单）→ 验证结果（Phase 0 已全部验证 · 2026-08-03）

> Phase 0 六项 PoC 全部 **已验证（通过）**，结论摘要、opencode 版本快照与 M1 风险提示如下；完整结论见 `docs/poc/p1~p6-*.md`。
> opencode 版本快照：容器 serve `1.18.9`（compose `orchestra-opencode-serve`，端口 4100）、宿主 `1.18.11`（可用）、`@opencode-ai/sdk` `1.18.11`。

| 编号 | 验证内容 | 关联决策 | 状态 | 结论摘要 | opencode 版本 | M1 风险提示 |
|---|---|---|---|---|---|---|
| P1 | `opencode serve` 的会话/消息/SSE 事件流接口（`/session`、`prompt_async`、`/event`）能否满足步骤级 Trace 解析与任务状态同步 | ADR-001/010 | ✅ 已验证（通过） | SSE 事件流可满足步骤级 Trace 解析与任务状态同步：事件类型在 `payload.type`，sync 事件嵌 `payload.syncEvent`（type 带 `.N` 后缀，去后缀须用 `replace(/\.\d+$/, "")`）；终态信号为 `session.idle`（非文档 `agent_complete`）；tokens 在 `message.updated` 的 `info.tokens` | 容器 1.18.9 | 内置模型 tokens 实测值 0，M1 成本统计需确认计费 provider 是否上报明细；事件名需按实测映射（`message.part.updated`/`session.idle`/`session.status`）；SDK `promptAsync` path bug 已修复（1.18.11） |
| P2 | opencode 长任务会话恢复机制（session 持久化、进程重启后 `GET /session/:id` 续跑、`abort` 中止） | ADR-010 | ✅ 已验证（通过） | abort 后会话保留可 GET；`docker compose restart` 后 13-24s 恢复，同一 sessionId 可续跑（happy 6/6 断言） | 容器 1.18.9 | ⚠️ opencode.db 在 `/root/.local/share/opencode/`（compose 未挂载），`down/up` 重建容器丢会话——M1 需为数据目录补挂卷；`/session/status` 仅列 busy/active 会话，终态判定以事件流为准 |
| P3 | git worktree 方式的多任务并行工作区隔离可行性 | ADR-010/FR-704 | ✅ 已验证（通过） | 3 并行 worktree 隔离成立（task-a 改动对 task-b/c/main 不可见）；保留策略三态（delete/archive/retain）可用；残留清理闭环（broken-worktree/orphaned-record/orphaned-dir 三类） | 不涉及（git 层面） | `.orchestra-worktrees/` 必须加入主仓库 `.gitignore`，否则污染 main 工作树 status；worker 启动时先 `git worktree prune` 清孤儿记录 |
| P4 | Postgres 行级锁实现任务 claim/lease 的并发正确性 | ADR-008 | ✅ 已验证（通过，含 1 项实现注意事项） | 5 worker 并发 20 任务每任务恰好 1 认领（conflicts=0，无重复执行风险）；心跳续约/未过期保护/失联判定正确；`LEASE_TTL_MS=60_000` 与 `(phase, worker_lease_expires_at)` 索引可用 | 不涉及（Postgres） | ⚠️ 认领条件 `phase='Pending'` 下，崩溃滞留 `Running` 的过期任务无法直接接管——需 watchdog 重置回 Pending 或放宽为 `phase IN ('Pending','Running')`，并与 checkpoint 恢复联动 |
| P5 | MCP Server 工具自动发现与物化的端到端流程 | ADR-011 | ✅ 已验证（通过） | 握手/tools-list/call 全通（`@modelcontextprotocol/sdk` 1.30.0，stdio）；物化两层形状 `{name,description,inputSchema}` → `status.discoveredTools` 快照 + `RegisteredTool`（fullName/risk/executorRef/configRefs/timeoutMs）与 dld-4.8 §2.2/§3.2 对齐 | 不涉及（MCP SDK 1.30.0） | stdio 注册失败须走降级路径（原生插件 Jenkins/GitHub 优先，MCP 接入降为 P2）；server 生命周期（按需启动/保活/回收）与 toolFilter 过滤留 M1 |
| P6 | opencode permission 请求（`/session/:id/permissions/:permissionID`）与平台 ToolApproval 审批联动的可行性 | ADR-010/FR-606 | ✅ 已验证（通过） | permission 请求-应答-行为反馈链路可用（4/4 断言）：deny `{"response":"reject"}` 工具不执行，approve `{"response":"once"}` 继续执行；payload 结构 `{id, sessionID, permission, patterns, metadata, always, tool:{messageID, callID}}` 已记录 | 宿主 1.18.11（happy 独立 serve）；容器 1.18.9（降级验证） | ⚠️ 需 serve 配置 `permission.bash: "ask"` 才触发（默认 `*→allow` 全放行）；`/config` PATCH 不持久化，M1 须经启动 config 文件或会话级 agent 配置注入权限规则；事件类型为 `permission.asked`（非 SDK 的 `permission.updated`）；重复应答 404 需幂等 |

**Phase 0 汇总**：6/6 全部通过（P1/P2/P6 的降级路径仅作兜底验证，happy path 均真实执行通过）。无降级项，无需修改 req/hld/dld 正文；上述 M1 风险提示由 M1 任务分解时落实（P2 补数据卷、P4 watchdog 恢复器、P6 permission 配置注入与幂等、P1 事件名映射与 token 统计）。

## ADR-014：CLI 工具环境安装（Skill 自安装 + 平台审批观测）

- **背景**：CLI 类型工具（jenkins-cli / kubectl 等）需在 opencode 运行环境存在才能被调用。此前设计未明确"CLI 如何安装到环境"，存在架构缺口。
- **决策**：**平台不实现安装器**。采用混合分层：
  1. **基础层（镜像预装）**：高频 CLI（git/node/python/gh）由 opencode 运行环境（容器镜像/VM 模板）预装，保证确定性与零安装延迟；
  2. **长尾层（Skill 自安装）**：低频/插件 CLI 的安装方式写在 skill 中，由 opencode 会话内 Agent 通过 bash 工具按需安装。
  平台通过四抓手管理：声明清单（runtime.requirements）、授权审批（安装命令 permission ask → ToolApproval）、执行观测（bash 调用进 Trace）、状态感知（环境预检写入 Task status）。
- **理由**：Skill 自安装零平台安装代码、Agent 自治灵活；前端"无法管理"问题通过审批 + 观测 + 声明三个抓手解决，不牺牲治理（NFR-02 fail-closed、FR-905 审计）。
- **影响**：Plugin 资源新增 runtime 字段（requirements/installHints）；worker 任务流程增加环境预检步骤；opencode permission 规则需下发安装命令的 ask 策略。
- **状态**：已采纳

## ADR-020：插件沙箱运行时选型（M3-6，2026-08-04）

- **背景**：FR-805 插件沙箱在 M1/M2 以配置校验 + 运行时拦截为主（urlguard SSRF 预检 + 凭证按命名空间隔离 + `assembleAuth` 最小化注入）；M3 强化为"进程隔离、能力最小化"（dld-4.8 §3.8）。现状梳理：native 插件（Jenkins/GitHub/Gitee）为**进程内 TS 函数调用**（`PluginBackend.ExecTool` + `safeFetch` 出站预检 + `ToolCtx.auth` 凭证注入）；MCP stdio 已是**子进程天然隔离**（`StdioClientTransport`）；MCP http 为远端调用。沙箱需覆盖的核心缺口是 **native 插件不可信代码的隔离执行**（防崩溃拖垮/资源滥用/越权访问/凭证泄露）；注册表、生命周期、ToolApproval、urlguard 均已具备，沙箱作为执行边界接入。外部依赖无现成，需选型：进程隔离 / 容器 / WASM（M3 规划 T0.6）。
- **选项**：
  - **A. 进程隔离**（Node worker_threads / child_process）
    - worker_threads：独立 V8 堆 + `resourceLimits`（`maxYoungGenerationSizeMb`/`maxOldGenerationSizeMb`/`codeRangeSizeMb`/`stackSizeMb`，仅限 JS 堆、不覆盖 ArrayBuffer 与原生模块、无 CPU 时间限制）→ 达限终止 Worker；但 **Worker 共享进程内存空间、文件系统与网络**，社区共识（Node 官方 sandbox 研究）非安全边界。
    - child_process：独立进程 + 独立 V8 实例；`--max-old-space-size` 堆限制 + 宿主侧超时 `kill()`；**文件系统/网络仍与宿主共享**（除非 OS 层 seccomp/降权或出站代理化）。
  - **B. 容器（OCI Docker/Podman）**：namespace（PID/网络/挂载/IPC）+ cgroup（`--memory`/`--cpus`/`--pids-limit`）+ seccomp/AppArmor + 只读 rootfs + Capability drop——**隔离最强**，每插件/每工具容器化执行。
  - **C. WASM（wasmtime / wasmer）**：内存级强沙箱——wasmtime 能力模型（WASI preopens/environment）+ fuel（确定性 CPU 时间）+ `max_memory_size` + epoch 中断；插件编译为 WASM 执行。
- **决策**：**主选方案 A（进程隔离，采用 child_process；明确不采用 worker_threads）**。容器（B）作为演进路径（高风险第三方插件启用），WASM（C）作为长期探索（插件生态 WASM 化后）。M3（Wave 5）按 child_process 落地，不并行尝试多种。
- **理由**：
  1. **隔离目标与现实威胁匹配**：M3 沙箱要防的是插件**异常崩溃/资源滥用/越权凭证访问**（崩溃隔离 + 资源限额 + 凭证最小化），而非对抗国家级逃逸。child_process 独立进程 + 独立 V8 天然提供崩溃隔离；`--max-old-space-size`（如 128MB）+ 宿主 `TOOL_DEFAULT_TIMEOUT_MS`（30s）超时 `kill()` 提供资源限额；`assembleAuth` 已按 `tool.configRefs` 最小化组装凭证，跨进程传递即凭证沙箱。
  2. **集成成本最低**：现有 native 插件工具函数签名统一 `(ctx, args) => Promise<ToolResult>`，几乎零改动——加一层 RPC 壳（message channel 传 `{tool, args, ctx:{auth}}` → 回传 `ToolResult` + 脱敏日志）即可；`urlguard` 为纯函数可在子进程内复用（SSRF 预检不丢）；与 MCP stdio 子进程模式一致，运维已具备子进程生命周期管理能力。
  3. **worker_threads 排除**：共享进程内存空间，`resourceLimits` 不覆盖 ArrayBuffer/原生模块，V8 引擎漏洞可波及主进程，非安全边界；且 Node `--permission` 不继承 Worker。
  4. **容器排除（首期）**：实测每调用冷启动 500~1900ms（SSD warm ~568ms / cold ~1850ms）、`docker run` 单次 ~340~1000ms 开销、吞吐较本地降 13~16%——插件工具典型出站 HTTP 100~500ms，叠加开销显著；主进程需 docker socket 权限（新增攻击面）；镜像构建/仓库/磁盘运维成本高。强隔离需求场景（per-plugin 网络 namespace + cgroup 硬限）复用 compose/deployment 现有容器基础作为演进。
  5. **WASM 排除（首期）**：`node:wasi` 官方明确"不提供安全沙箱，文件系统沙箱可被多种技术逃逸，勿用于不可信代码"；wasmtime-node 为 Rust native addon 且 WASI preview2 网络（wasi:http）需宿主自行实现桥接；`@wasmer/sdk` 至 2026-05 才支持 Node（浏览器优先 + web-worker polyfill + 网络能力未完成）；且**现有 TS 插件进 WASM 需完整编译链**（`jco componentize`/componentize-js 基于 SpiderMonkey/StarlingMonkey 而非平台 V8，或插件用 Rust/WAT 重写）——集成成本远高于首期收益。WASI preview2 能力配置（`preopens`/`env`/`enableNetwork`）留作插件生态 WASM 化后的选型。
- **影响**：
  - Wave 5 新增 `src/plugins/sandbox/`：`runner.ts`（子进程管理：`spawn node --max-old-space-size=128 --experimental-strip-types <worker> + IPC + 超时 kill + per-plugin 进程池/空闲回收）、`rpc.ts`（请求/响应协议 + 脱敏日志回传）、`sandbox-backend.ts`（`PluginBackend` 的 Sandboxed 变体：`ExecTool` 走子进程 IPC，`Health` 走宿主或沙箱）。registry `executorRef` 扩展 `sandbox:<plugin>.<tool>` 分支。
  - 凭证最小化：`ctx.auth` 跨进程仅传 `tool.configRefs` 命中的键（`assembleAuth` 已保证）；子进程环境剥离宿主敏感 env（不注入 `ORCHESTRA_SECRET_KEY` 等）；工作目录隔离到临时目录。
  - 网络：子进程内出站仍走 `safeFetch`（urlguard 预检在子进程执行，SSRF 语义不丢）；可选叠加 Node `--permission`（`--allow-net` 白名单）作纵深防御。
  - ToolApproval 联动不变：沙箱内工具调用仍先经 `isHighRiskToolPermission` → ToolApproval 审批后放行（perms 判定在宿主进程，dld-4.8 §3.5）。
- **风险预案**：
  1. **恶意插件绕过 urlguard 直接联网** → ① M3 内：出站审计（urlguard 放行记录与子进程实际出站比对）；② 演进：**网络代理化**——子进程不直接出站，全部 HTTP 经宿主代理执行 `safeFetch`（urlguard 强制，SSRF 不可绕过）；③ 强隔离：容器网络 namespace。
  2. **子进程读写宿主文件系统** → 凭证不落盘（只读注入）+ 工作目录隔离 + 可选低权限 OS 用户运行；强隔离需求升级容器方案。
  3. **进程数膨胀** → per-plugin 进程池 + 空闲回收（复用 MCP Server 生命周期模式，dld-4.8 §3.6）。
  4. **WASM 生态成熟后迁移** → `sandbox-backend` 接口隔离，未来可替换执行器而不动注册表/审批层。
  5. **Node `--permission` 为 experimental 且有绕过 CVE**（CVE-2025-55130 symlink 路径绕过、CVE-2026-21636 UDS 绕过网络限制、CVE-2025-55132 futimes）→ 仅作纵深防御不作主边界，启用时规避已知绕过。
- **状态**：已采纳（M3-6 前置；Wave 5 按选定方案实现）

## ADR-017：FR-407 节点级委托分发（fan-out）纳入 M3（M3-3，2026-08-04 补）

- **背景**：FR-407（req-4.4）定义"节点可派生子任务到其他 Agent（fan-out），子任务结果回传后触发重审"，优先级 P2。M3 规划（`.omo/plans/orchestra-m3-planning.md`）的 9 个任务中，M3-3 仅覆盖 Agent 级委托（FR-206），节点级 fan-out 无归属；同时 development-plan.md 将 FR-407 误标到 M3-2（子流程，实为 FR-409）。规划评审（Momus）核实错位属实，需对 FR-407 的 M3 归属做出决策。
- **选项**：
  - A. 纳入 M3-3（委托分发任务），作为 T3.4 节点级并行分发——**已确认**
  - B. 单列独立任务（M3-10）
  - C. 排除出 M3（保持 P2 延后）
- **决策**：**纳入 M3-3**，落在 Wave 3 T3.4（节点级并行分发）。流程节点声明 fan-out（上游输出分发给多个 Agent 并行处理，如多个 issue 分给多个开发 Agent），**复用 T3.3 的子任务分发/回收机制**，粒度从"Agent 级"扩展到"流程节点级"；子任务全部回传后触发重审节点；委托深度与 task trace 关联。
- **理由**：平台愿景是"像真实公司一样运转"的多 Agent 协作交付（PRD 1.1 / 1.3），节点级 fan-out 是把"一个 Agent 拆出多份并行工作"固化为流程节点的核心能力；M2 已实现并行分支/汇合（FR-404）与 Task 生命周期，fan-out 的并行执行、结果聚合、重审恢复均有既有机制可复用（M2 并行分支基础 + M3-3 委托机制），增量成本可控；FR-407 在 M3 里程碑集合（requirements §7）内，纳入符合里程碑范围定义。
- **影响**：M3-3 任务范围扩展（Wave 3 新增 T3.4）；flow schema 节点类型/字段扩展（fan-out 声明、分发目标、聚合策略）；executor 在流程节点级复用 T3.3 的子任务机制；development-plan.md M3-3 增补 FR-407 引用；验收增加"节点级 fan-out 多子任务并行回传重审"。
- **状态**：已确认（用户确认纳入 M3，T3.4）

## ADR-018：FR-706 模型/参数透传（2026-08-04 补）

- **背景**：FR-706（req-4.7）"支持 Agent 级别的模型 / 参数透传（session 消息 body 的 model/agent 参数、`PATCH /config` 下发 opencode 配置）"，优先级 P2。M3 里程碑集合（requirements §7）含 FR-706，但 9 个 M3 任务无归属；development-plan.md 将 FR-706 误标到 M3-4（A2A，实为 FR-806）。规划 T0.5 要求决策：并入 M3 或列入 Out-of-Scope。
- **选项**：
  - A. 纳入 M3：低成本（opencode 客户端已透传 model/agent 参数，executor 直接传递即可），并入 Wave 3 委托实现或单列低成本任务——**推荐**
  - B. 列入 Out-of-Scope：需求属 P2，非 M3 核心，M3 不排
- **决策**：**推荐纳入 M3，并入 Wave 3**（不单列任务、不占用独立 Wave）：随 T3.3 委托实现的 executor 改动一并落地 session 创建 / 消息发送的 model/agent 参数透传与 `PATCH /config` 配置下发。
- **理由**：M3 里程碑集合显式含 FR-706，纳入与里程碑范围一致；低成本——`@opencode-ai/sdk` 的 session 创建与 promptAsync 天然支持 model/agent 参数，executor 封装层直接传递即可，`PATCH /config` 已由 P6 PoC 验证可用，无需新协议 / 新组件；与 M2 已落地的 ModelEndpoint（FR-205 模型路由）形成闭环——FR-205 定义 Agent 级模型引用与 fallback，FR-706 补足"参数下发到运行时"的最后一公里，否则模型路由仅在平台侧生效、运行时仍用默认配置；与 M3 生态主题契合（Agent 配置差异化 → 模型参数差异化执行）；不占关键路径，风险低。
- **影响**：Wave 3 增加低成本透传实现；executor session/message 创建逻辑参数化；全局设置页运行时配置联动 `PATCH /config`（settings 原型已有运行时配置区）；若执行中成本超预期，可降级为 Out-of-Scope（防超支预案，届时需同步 requirements §7 M3 集合的 FR-706 条目与规划 Out-of-Scope 段）。
- **状态**：推荐纳入（待规划定稿确认）

## ADR-019：A2A 对接选型（M3-4 / FR-806，2026-08-04 调研）

- **背景**：M3 需实现 A2A（Agent-to-Agent）对接（FR-806）：外部 Agent 系统可经 A2A 暴露为平台可调用的"工具"，也可被编排为流程节点，调用结果入 Trace。平台自身需同时扮演 **A2A Server**（暴露 Agent Card + tasks 端点，接受外部系统调用）与 **A2A Client**（调用外部 A2A agent）。关键分叉：opencode serve 是否原生支持 A2A。
- **调研结论**：
  - **opencode serve 不原生支持 A2A**：其 HTTP API 为私有协议（OpenAPI 3.1 于 `/doc`，含 `/session`、`prompt_async`、`/event`、permissions 等），**无 Agent Card、无 tasks 端点**；`@opencode-ai/sdk`（v2）是私有协议客户端，非 A2A 标准。opencode 社区请求（issue #3023）未合入；PR #10452（A2A 支持）已关闭未合并。第三方 `a2a-opencode`/`opencode-a2a` 以适配层桥接 opencode serve，印证需自建适配。
  - **A2A 规范已定稿 v1.0.0**（Linux Foundation 托管，a2a-protocol.org）：三层结构（L1 数据模型 Task/Message/AgentCard/Part/Artifact；L2 操作 SendMessage/GetTask/ListTasks/CancelTask/GetAgentCard 等；L3 协议绑定 JSON-RPC / gRPC / HTTP-REST 三选一）。核心端点（REST）：`POST /message:send`、`GET /tasks/{id}`、`POST /tasks/{id}:cancel`、`GET /.well-known/agent-card.json`。
  - **官方 JS SDK：`@a2a-js/sdk`**（npm 周下载 1.6M，Apache-2.0，v1.0.0 stable）。Server 侧：`AgentExecutor`（业务逻辑）+ `DefaultRequestHandler`（路由/任务存储/取消/推送）+ express/grpc 传输适配器，多传输可同挂一个 handler；Client 侧：`ClientFactory.createFromUrl` 自动抓 Agent Card 并按 `supportedInterfaces` 协商传输，方法 `sendMessage`/`sendMessageStream`/`getTask`/`cancelTask`；内置 v0.3 兼容层。
- **选项**：
  - A. 平台自实现 A2A 端点（服务端 Agent Card + tasks 端点 + 客户端桥接 opencode SDK）
  - B. 采用官方 `@a2a-js/sdk`（服务端 AgentExecutor + DefaultRequestHandler，客户端 ClientFactory），内部桥接 `@opencode-ai/sdk`——**已采纳**
  - C. 复用 opencode serve 原生 A2A（若支持）——**已证伪**（serve 无 A2A 能力）
- **决策**：**采用方案 B：`@a2a-js/sdk`（官方 A2A TS SDK）+ 平台侧适配层桥接 `@opencode-ai/sdk`**。协议层全部由官方 SDK 承担（JSON-RPC/REST/gRPC、SSE、错误码、幂等、v0.3 兼容、多轮语义）；平台只实现两块适配：**服务端 `AgentExecutor`**（把平台已有 opencode 执行管线——`session.promptAsync` + SSE 事件映射 + permission 联动——转换为 A2A `Task` 状态推进与 `Artifact` 输出）与**客户端 `ClientFactory` 消费层**（外部 A2A agent 的 Agent Card 抓取/缓存、工具物化为 `a2a.<agent>` 或流程节点）。接入复用 `src/executor/opencode.ts`（`createOpencodeClient` + `sdkCall` + `resolveRuntimeConfig` 多实例路由）与 `src/executor/index.ts` 的 SSE/Trace 双轨管线；调用结果写 task_trace_events（FR-806）。
- **理由**：① 协议层零自研，规避 JSON-RPC/REST/SSE/错误码/版本协商的实现与长期跟随 A2A 演进（对标 ADR-007 复用官方 SDK 免维护原则）；② 全栈 TS 与平台技术栈一致，类型安全；③ 服务端只需写 `AgentExecutor`（把 opencode 私有会话语义适配到 A2A Task），客户端 `ClientFactory` 自动协商传输与抓卡，工作量集中在薄适配层而非协议实现；④ 与 opencode 官方 PR #10452 的社区路线一致（官方未合并但均基于 `@a2a-js/sdk`），未来 opencode 若合入原生 A2A，桥接层可平滑替换。
- **影响**：
  - 新增依赖 `@a2a-js/sdk`（^1.x，Server + Client 一体）；Wave 7 新增 `src/a2a/` 模块（服务端 AgentExecutor / Agent Card 发布 / tasks 端点挂载 + 客户端 ClientFactory 包装 + 工具物化注册）。
  - Agent Card 由平台按 Agent 资源生成（name/description/skills/security_schemes），端点挂载到平台 HTTP 服务（对齐 ADR-010 serve 常驻）。
  - 外部 A2A agent 注册沿用 dld-4.8 §3.11 预留 `backend: { type: 'a2a', cardUrl, auth }`；物化为 `a2a.<agent>` 工具或流程节点，结果入 Trace。
  - 凭证隔离对齐 NFR-01（跨命名空间不可读取），A2A 调用鉴权复用平台 token 注入。
- **风险预案**：
  - **超支降级（最小可用）**：Wave 7 若成本超预算，仅交付 **A2A Server 参与方最小可用**——Agent Card + `message/send` + `tasks/get` + `tasks/cancel`（JSON-RPC over HTTP，`@a2a-js/sdk` 默认传输），不做 streaming/push/多轮，与 M3 Out-of-Scope 对齐；A2A Client 侧仅支持按 Agent Card 调外部 agent。
  - **版本漂移**：锁 `@a2a-js/sdk` 主版本（^1.x），随 minor 升级并跑官方 TCK 一致性用例。
  - **多租户**：A2A 端点经命名空间鉴权（Bearer），Agent Card 不落敏感凭证（仅声明 security_schemes）。
  - **Trace 贯通**：A2A 调用作为平台子任务/工具调用写入 task_trace_events（FR-806 验收），失败/超时走可重试语义。
- **状态**：已采纳（M3 Wave 0 选型；Wave 7 按此实现）

## ADR-021：密码哈希选型（用户体系 Wave 0，2026-08-05）

- **背景**：P0 密码登录（替代粘贴 token）需要密码哈希模块 `src/auth/password.ts`（`.omo/plans/orchestra-user-system.md` Wave 1 T1.1）。现有 `users.password_hash` 字段已预留（dld-4.1 §2.2 注释为 bcrypt），seed 用户用 `'seed-only'` 占位。需对密码哈希算法选型。
- **选项**：
  - **A. Node crypto scrypt**（`node:crypto` 内置 `scrypt`/`randomBytes`，零依赖）
    - 内存硬（Memory-Hard），参数 N/r/p 可配，抗 GPU/ASIC 并行破解；无 node-gyp、无 native 编译，与项目"直跑 TS（`node --experimental-strip-types`）+ 零原生依赖"风格一致（对标 ADR-007）；
    - 弱项：非 OWASP 首选（argon2id 之前），但 OWASP 明确 scrypt 为 argon2id 不可用时的替代推荐；参数调节较专业（N 须为 2 的幂）。
  - **B. argon2id**（`@node-rs/argon2` / `argon2`）
    - OWASP 首选（最低 19 MiB 内存 / 2 次迭代 / 1 并行度），内存硬 + 抗侧信道最佳；
    - 弱项：需 native 依赖（`@node-rs/argon2` 为 prebuilt napi，`argon2` 需 node-gyp），引入编译链与版本/平台风险；与项目当前"零第三方原生依赖"不一致。
  - **C. bcrypt**（`bcryptjs` / `bcrypt`）
    - 生态成熟、参数简单（cost factor），`bcryptjs` 纯 JS 无编译；
    - 弱项：非内存硬（抗 GPU 弱于 scrypt/argon2id）；密码输入 72 字节截断；`bcryptjs` 纯 JS 速度慢（登录时延更高）；原 schema 注释虽写 bcrypt 但从未落码。
- **决策**：**采用方案 A：Node crypto scrypt**。
  - **参数**：`N=2^17`（131072，128 MiB）、`r=8`、`p=1`、`saltLength=16`、`keyLength=64`（OWASP scrypt 推荐最小档之一，登录为低频操作，内存成本可接受）。
  - **存储格式**：`scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`（自描述，便于未来升参后按旧参数验证；salt 16 字节 hex、hash 64 字节 hex）。
  - **seed-only 兼容**：`password_hash='seed-only'` 为迁移占位符（非合法哈希，前缀非 `scrypt$`），`verifyPassword` 识别后走 T0.2 首次登录设密码流。
- **理由**：① 零依赖零编译——scrypt 是 `node:crypto` 内置，无需 node-gyp/native，与全仓无原生依赖现状（前端 `@xyflow/react` 亦为纯 JS）一致，避免 argon2id/bcrypt 的安装/平台风险；② 安全性达标——内存硬参数可调（128 MiB 档），抗 GPU 并行攻击能力与 argon2id 同级梯队，满足 NFR-02 最小安全基线；③ 维护成本最低——Node 内置 API 稳定，无第三方库升级/漏洞跟踪负担；④ bcrypt 排除因 72 字节截断 + 非内存硬，且原注释只是"预留说明"从未实现，选型变更无迁移成本。
- **影响**：
  - `src/store/schema.ts` L521 `users.passwordHash` 注释由「bcrypt」改为「scrypt（node:crypto，ADR-021）」；dld-4.1 §2.2 同步修订（本 ADR 已含修订，落档随 Wave 0 commit）。
  - Wave 1 新增 `src/auth/password.ts`：`hashPassword(plain): string`（生成 `scrypt$...` 串）、`verifyPassword(plain, stored): Promise<boolean>`（seed-only / 非法格式 → false，不抛错）、`isSeedOnly(stored): boolean`；`/api/v1/auth/login` 与 `/api/v1/auth/password` 端点使用。
  - 无新 npm 依赖；测试夹具用固定 salt 的预计算 scrypt hash（或低参 `N=2^10` 测试档）加速单测。
  - 未来如需升级参数：新登录写新参数哈希，verify 按存储串内嵌参数兼容旧哈希（逐步迁移）。
- **状态**：已采纳（用户体系 Wave 1 前置）
