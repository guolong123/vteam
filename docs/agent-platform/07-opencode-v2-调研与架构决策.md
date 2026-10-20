---
title: opencode v2 调研与架构决策
id: opencode-v2-research
order: 7
kind: 技术调研
description: opencode 2.x 技术调研结论与平台基于 v2 实现、定期同步的架构决策，作为后续完整平台开发的技术基线
---

# opencode v2 调研与架构决策

本文档记录对 opencode 2.x（以下简称 v2）的技术调研结论，以及据此作出的架构决策。它是平台从"产品愿景"走向"完整平台开发"的技术基线：后续完整平台阶段的技术设计、SDK 封装、版本管理均以本文档为锚点。调研基于 v2 源码结构、官方动机说明与 2026-08 的生态实测；**其中若干条判断已在 2026-10 被真实二进制实测推翻**（订正就地标注，见下方订正块与 §12）。

> ⚠️ **2026-10-20 订正块（opencode v2 适配 · T23）**
>
> 2026-08 的调研基于 **v2 beta 阶段的源码结构**，其中若干判断在 v2 **正式发版**后被**实测推翻**（"beta"、包名、"端点已移除"、"控制面从不直连"等）。订正点**就地标注**在各节（每处注明证据来源），并在 **§12** 汇总本次适配的**实测结论**、交付链与回滚形态。
>
> 证据来源（本文档所有订正的依据）：
> - `docs/agent-platform/opencode-v2-spike-results.md` —— T4 / T5 / T6 三个阻塞 spike 的实测结论（可一键复现：`bash docs/agent-platform/opencode-v2-spike-results/repro.sh`）；
> - `docs/agent-platform/opencode-v2-contract-baseline/` —— 锁版契约基线（OpenAPI spec、原始 SSE 帧、配置归一化回显）；
> - `.omo/plans/opencode-v2-adaptation.md` —— 迁移计划及其 **D13 订正表**（本节各条订正的出处）；`.omo/plans/opencode-v2-progress.md` —— 执行记录。

## 1. 决策

**平台基于 opencode 2.x 实现，v2 演进期间定期同步。**

- ✅ **v2 已正式发版**（订正，2026-10-20）：npm 包 **`@opencode/cli`**（`latest` = **2.0.32**），SDK 包 **`@opencode/sdk`**（v1 线从未以 v2 tag 重发）。**不再有 beta tag 节奏**——"will become OpenCode 2.0"（官方 2026-08 原话）已经是既成事实。
- 因此平台采用**锁版本 + 定期跟进**策略：锁定一个经过验证的**正式版**作为开发基线（当前锁版目标 `@opencode/cli@2.0.32`，即 `worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`），同时跟踪正式版 release notes、`https://opencode.ai/config.json` 的 schema 变更与 `https://opencode.ai/v2/docs/migrate-v1/` 的破坏性变更清单（§7）。
- **该决策已落地**：worker 侧已于 2026-10 完成 v2 适配（锁版 + 版本闸门 + v2 驱动 + 配置 v2 形态 + 隔离配置域）。§1–§11 的原调研判断按各处的订正标记阅读，**§12 是本次适配的实测结论**（自洽，可单独阅读）。

## 2. v2 定位与动机

v2 不是 opencode 的功能性迭代，而是一次**引擎级重写**。重写针对 v1 的三类核心痛点：

| 痛点 | v1 表现 | v2 的解法方向 |
|------|--------|--------------|
| 热重载 | 配置、插件、agent 变更需要整体重启服务实例，开发与运行体验割裂 | 服务发粒度事件、按组件自重组，不再整体 tear down |
| 单体臃肿 | 功能集中在一个进程与代码库中，schema、协议、核心逻辑、CLI 耦合 | 多包拆分，按依赖方向强制边界 |
| 会话持久化 | 会话状态以内存为主，中断后难以恢复 | durable session，prompt 先落库，事件可重放 |

v2 对破坏性变更保持克制。官方明确只有 **3 个有意破坏性变更**：插件 API、server API、TUI 配置。除此之外的用户资产（配置、agent、prompt 等）保持兼容。这一克制使平台迁移到 v2 的成本可控，也是"基于 v2 实现"决策成立的前提。

## 3. v2 核心变更

| 变更 | 说明 |
|------|------|
| 热重载 | 服务发出粒度事件后按组件自重组（Dax 亲述："redesigned it for hotreloading"；"The v2 goal is granular reconfiguration"），不再整体 tear down。agent、插件、配置变更只影响对应组件 |
| 多包拆分 | 拆为 schema / protocol / server / core / cli 等多个包，依赖方向代码强制：Schema → Core / Protocol → Server → Client，Client 禁止依赖 Core 与 Server，以 import-boundary 测试保证边界不被破坏 |
| 嵌入 SDK | 提供 **`@opencode/sdk`**（2.0.32），支持 in-process 组装（内存 router），嵌入场景与远程场景共用同一 HttpApi 契约（官方："In-process is only transport"）。平台可按场景选择进程内或进程外驱动。**订正（2026-10-20）**：原文写的 `@opencode-ai/sdk-next` **从未公开发布过**——v2 的正式 SDK 包名是 `@opencode/sdk`（子包 `@opencode/client` / `core` / `plugin` / `schema` / `server` / `util` / `protocol`）。**平台本次未采用 in-process 托管**：其多租户持久化能力未验证（计划 §10 Q4/Q5），仍走 HTTP serve（§12.3） |
| Location | 引入 `Location.Ref{directory, workspaceID}`，全部 API 变为 location-scoped，Session 绑定创建时的 Location。官方约束："A caller cannot swap context for an existing Session by passing a new path"，即不能靠传路径偷换已有 Session 的上下文 |
| durable session | 采用 "Durable admission precedes execution"：prompt 先落库，再以事件日志 + projections + replay 的方式恢复会话，中断后状态可重建 |
| Effect 全面采用 | 以 Effect 生态为基础设施：Schema 契约、typed errors、HttpApi 一次定义同时生成 server 与 client 两端，契约单一来源 |
| 插件 v2 | hooks 进入 core domain（不再游离在外），配套 `State.Transformable`（transform / reload / Scope 回滚），插件与 agent 的运行时变更有了官方机制 |
| Question / Permission 交互请求正式化 | 工具请求确认、权限请求等从隐式通道改为正式的 request → reply 事件流，平台可统一拦截与授权 |

### 3.1 工具权限模型（PermissionV2）

工具权限是 Agent 能力边界的关键机制。基于 v2 源码验证，权限模型要点如下：

**权限点是开放命名空间，不是固定枚举。** 内置基础能力（`bash`、`read`、`edit` 等）是预置的枚举权限点；但每个工具在注册时自动以其名字成为新的权限点（源码：bash.ts 等工具定义中 `action: name`），团队注册的自定义工具、MCP 接入的工具都按同一规则进入权限命名空间。因此权限点集合随工具注册动态扩展，不依赖枚举表维护。

**effect 三态 + 通配符。** 每个权限点的执行策略取值 `allow`（允许）/ `ask`（每次确认）/ `deny`（禁止），并支持通配符（Wildcard，如 `jenkins-*` 一次覆盖全部 jenkins 前缀工具）。该模型与 opencode PermissionV2 对齐：permission action 是自由字符串（schema 定义中为 `Schema.String`，非枚举），effect 三态与通配匹配由运行时规则表承载。

**权限链路。** 一条工具权限从定义到生效分三步：

1. **创建工具**：工具注册时确定能力与默认权限（工具名即 action，源码 `action: name`）。
2. **逐工具配置 effect**：agent-config 中为每个工具选择 allow / ask / deny（有副作用工具默认 ask，见 04 篇 FR-35 / FR-48）。
3. **运行时执行**：opencode 运行时代 Agent 调用工具，按 effect 放行或经 request → reply 事件流请求确认（第 3 章 Permission 交互请求正式化）。

该模型同时约束 04 篇 FR-48 工具权限需求与 agent-config 原型的交互设计：每工具一行 = 启用开关 + 工具名（action）+ 来源徽章（内置 / 自定义 / MCP）+ effect 三态选择。

> §3.1 描述的是 v2 权限**模型**（开放命名空间 + effect 三态）。**v2 的默认取值口径**与平台据此作出的**已采纳决策**见 §3.2——两者不要混读。
>
> ⚠️ **订正（2026-10-20）· action 命名在 v2 变了**：v1 的 `bash` / `task` 在 v2 是 **`shell`** / **`subagent`**（`read` / `edit` 同名；v1 的 `write` / `patch` 已并入 `edit`）。配置形态也从 v1 的**对象**（`permission: {edit:"allow"}`）变成 v2 的**有序数组**（`permissions: [{action, resource, effect}]`，按 `findLast` 求值）。本节描述的"工具名即 action"这一**模型**不变。

### 3.2 v2 权限的默认取值口径与平台已采纳决策【T17 补充块 · 2026-10-20】

> ⚠️ **本节是独立补充块**（opencode v2 适配 T17 追加），可与本文档后续的整体订正**独立合并**；本节内容自洽，不依赖其它章节的修订。

**实测事实（opencode v2.0.28：活二进制 + `GET /api/agent` 回显）**

| 事实 | 值 |
|------|-----|
| 每个 v2 agent 的**内置**默认规则集**首条** | `{action:"*",resource:"*",effect:"allow"}` |
| 配置 `permissions[]` 的位置 | **追加在内置规则集之后** |
| 规则集求值方式 | `findLast`（**最后一条命中者生效**） |
| 未命中任何规则时的引擎默认 | `ask`（但**先被上面的 catch-all allow 命中**，故实际不生效） |

**后果（vteam 语境）**：vteam 控制面只声明**四个原生 action**（`edit` / `read` / `bash` / `task`，即 `NATIVE_PERMISSION_KEYS`）与已注册的 vteam MCP 工具名；而 MCP 工具名在**发射投影**（`projectNativePermission`）里被丢弃（`vteam_*` 一律剔除）。⇒ 在 v2 下，**凡未被声明的 action 一律放行**（`webfetch` / `glob` / `grep` / `todowrite` / `skill` / `websearch` 以及全部 MCP 工具）；v1 下它们会落到引擎的**逐 action ask/deny 默认**。

**已采纳决策（平台负责人裁定）：接受 v2 更宽松的默认值。**

- ❌ **不**补 `{action:"*",resource:"*",effect:"ask"}` 兜底规则；
- ❌ **不**引入逐 action 默认值表；
- ✅ 代价（未声明 action 放行）**被接受**；但必须**显式记录**（本节 + worker 侧翻译处注释 + 相关脚本注释），不得让仓库继续"默默断言"v1 的更严口径；
- ✅ 平台侧**真正的权威仍是服务端权限闸门**（`ROLE_BOUNDARIES[*].toolAllows` → platform-mcp 闸门）：MCP 工具能否被调用由服务端裁决，与引擎的默认取值无关（见 16 篇 §2.1.2 的 role × tool 授权矩阵；该矩阵不因 v2 迁移而改变）。

**给后续实现者的红线**：不要"顺手"给未声明 action 加 catch-all ask，也不要引入逐 action 默认表——那会**静默改变**平台已采纳的行为（把 v2 的放行收回成 v1 的逐 action 询问），属于未经决策的行为变更。真要收紧，须走产品决策并同步更新本节。

## 4. v2 API 与 v1 差异

| 维度 | v1 | v2 |
|------|----|----|
| 路由前缀 | 部分接口无统一前缀 | 统一 `/api` 前缀。**订正（2026-10-20）**：v1.19.3 **同时**提供 legacy 根路径面（`/session`、`/event`、`/config`…）**和**一套过渡性的 `/api/*` 面；v2 **只保留 `/api/*`，legacy 面已移除** |
| 作用域 | 全局或按 path 参数 | location-scoped，通过 `location[directory]` 与 `x-opencode-workspace` 头指定 Location |
| prompt API | 以 parts 数组为主的消息结构 | 简化：`PromptInput{text, files, agents}` 替代 v1 的 parts 结构 |
| 模型列表 | 分散在会话相关接口 | 独立 `GET /api/model` |
| 已移除端点 | 旧实验接口 | ❌ **订正（2026-10-20）**：原文断言"`instructions/entries` 与 `/api/experimental/migration/v1`（当前 dev 分支）已移除"**是错的**——**两者都还在**：`PUT/DELETE /api/experimental/session/{id}/instructions/entries/{key}` 存在；`GET /api/experimental/migration/v1` 实测返回 **`{"status":"completed"}`**（v2 的**一次性 legacy 导入**：仅当 legacy 路径上**确有 v1 数据**时才发生）。⚠️ **在平台的隔离部署下它不会触发**——v1 数据不在 v2 worker 的作用域内 ⇒ **v1 时代的历史原样留在盘上**（见 §12.8） |

> ⚠️ **legacy 面"消失"不是 404，而是 200 + web SPA 的 HTML**（实测，2.0.28）：v2 上 `GET /session`、`GET /event`、`GET /config` 全部返回 **200**，body 是 web SPA 的 HTML（既不是 JSON，也不是 404）。**只查状态码的健康/契约自检会因错误的原因判"服务正常"**——契约自检必须断言 **body 形态**（JSON / `Content-Type`）。同理，v2 的 `GET /` 未鉴权也返回 200（web SPA）⇒ 健康探针必须用 **`GET /api/info`**（未鉴权 401 / 已鉴权 200）。
> 证据：`docs/agent-platform/opencode-v2-contract-baseline/`、`.omo/plans/opencode-v2-adaptation.md` §2.3。

平台在设计 SDK 封装层时，应以 v2 的 API 形态为准，不要沿用 v1 的 parts 消息结构与 path 传参习惯。

## 5. 平台基于 v2 的架构落地

以下为完整平台阶段的技术方向，作为 v2 调研结论在平台架构上的落地预案：

- **Worker 概念**：每个任务组在 Worker 节点内运行一个 opencode 实例（v2 演进为 Location 级），任务组隔离由 Worker 节点承载。agent 变更只重启对应任务组的实例，不触碰其他任务组，呼应 v2 的粒度热重载能力。本节描述的是单机形态下的落地；完整形态见第 11 章分布式 Worker 架构。
- **agent 创建**：⚠️ **订正（2026-10-20）**：原文设想"通过 v2 插件 API（`ctx.agent.transform` / `State.Transformable`）注册自定义 agent"。**平台实际走的是配置路径**：角色 agent 由 worker injector 写进 `<workDir>/opencode.json` 的 **`agents` 节**（提示词落 `agents.<name>.system`，权限落 `permissions[]`），运行期用 **`POST /api/session/{id}/agent`** 激活。`ctx.agent.transform` 是 v2 提供的官方机制，但平台**没有**用它承载角色（原因与实测见 §12.4）。这同样是"补足 v1 缺少 agent 创建接口"的官方路径——只是载体是**配置**而不是**插件注册**。
- **多任务组 = 多 Location 图**：Session 绑定创建时的 Location，不能靠传 path 偷换上下文。平台每个任务组拥有独立的 Location 图，天然形成任务间上下文隔离。
- **消息模型**：基于 v2 的 Part 类型（共 12 种），叠加平台三层错误模型（工具级、消息级 8 种、重试级），与 03 篇 FR-10（消息模型）/ FR-21（错误反馈）定义对齐。

## 6. v2 生态可用性（2026-10-20 订正 · 取代 2026-08 的 beta 结论）

| 包 | 版本 | 可用性 |
|----|------|--------|
| `@opencode/cli` | **2.0.32**（`latest`） | ✅ **正式发版**（不再是 beta）。平台锁版目标即此版本（`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`） |
| `@opencode/sdk` | **2.0.32** | ✅ **已公开发布**。子包：`@opencode/client` / `core` / `plugin` / `schema` / `server` / `util` / `protocol`。❌ 原文写的 `@opencode-ai/sdk-next` **从未发布过** |
| `@opencode/plugin` | 2.0.32 | ✅ v2 插件包（v1 的 `@opencode-ai/plugin` 已废弃） |
| `opencode-ai` / `@opencode-ai/sdk`（v1 线） | **1.19.3**（**已冻结，不再发版**） | ⚠️ 原文写的 `1.18.14` 已过期。**v1 线已死 ⇒ "以 v1 SDK 兜底"不是安全网**，而是一条死线（回滚形态见 §12.8） |

结论（订正）：v2 的 cli / sdk / plugin **均已正式发布**，平台可直接以"锁版 CLI + v2 server API"落地——**不再需要"SDK 未发布所以先直连"的临时形态**。v1 线不再作为兜底选项。

## 7. 定期同步策略

| 动作 | 频率 | 说明 |
|------|------|------|
| 跟踪 `@opencode/cli` **正式版** release notes | 随发布 | 关注版本号与 release notes（**不再是 beta 每日发布**——v2 已正式发版） |
| 跟进 `https://opencode.ai/config.json` 的 **schema 变更** | 随发布 | 配置契约的事实来源（48 个顶层键）；schema 变更 = 破坏性变更的先行指标 |
| 跟进 `https://opencode.ai/v2/docs/migrate-v1/` 的**破坏性变更清单** | 随发布 | 官方 v1→v2 迁移指南；已列出的"有意破坏"区：插件 API / server API / TUI 配置 |
| 跟进 V2 Schema Changelog | 随发布 | 识别契约变更（端点、字段、类型） |
| 锁版本 | 每次基线升级 | 每次升级锁定已验证版本号，记录于本文档（当前：`@opencode/cli@2.0.32`）。**锁版即锁契约基线**——用锁定版二进制重跑一次契约基线快照（`docs/agent-platform/opencode-v2-contract-baseline/`） |
| 契约变更时更新本文档与 SDK 封装层 | 随契约变更 | 本文档保持与技术基线同步，封装层按新契约适配 |

> 附注：v2 的仓库已从 `sst/opencode` 迁到 `anomalyco/opencode`（依赖升级路径与 issue 追踪路径都变了）；原文提到的 `specs/v2/` 目录属于 beta 期仓库布局，已由上表的两条在线事实来源取代。

## 8. 风险与缓解

| 风险 | 说明 | 缓解 |
|------|------|------|
| beta 数据可被 wipe | **订正（2026-10-20）**：这是 **beta 阶段**的风险；v2 已正式发版，存储模型已定（会话状态在 SQLite，落点 = `opencode debug paths` 的 `data` 目录下的 `opencode.db`；平台隔离域下 = `<HOME>/.opencode-iso/data/opencode/opencode.db`） | 平台核心数据（任务、消息、产出物）存平台侧数据库，opencode 实例仅作工作引擎，可随时重建。⚠️ **订正**：原写"v2 启动时会**就地迁移** v1 磁盘数据 ⇒ 复用旧 v1 数据卷不可回滚到 v1"——**在平台隔离部署下这个前提不成立**（v1 数据不在 v2 worker 的作用域内 ⇒ **不会被迁移**，历史原样留在盘上）；**读不了的是 v2 期间的会话**（隔离域内的 v2 形态 SQLite）。⇒ 回滚的真实口径见 **§12.8**（可执行步骤见 `docs/deployment.md` §八） |
| API 契约未冻结 | **订正（2026-10-20）**：v2 已正式发版、契约已冻结到**可锁版本**的程度（不再是 beta） | 锁版本号（`@opencode/cli@2.0.32`）+ **锁版即锁契约基线**（`docs/agent-platform/opencode-v2-contract-baseline/`）；升级走评审；SDK 封装层集中隔离契约变化 |
| Desktop 仍捆绑 v1 server | 桌面端当前仍带 v1，v2 主要面向 serve / SDK 场景 | 平台不依赖桌面端，以 v2 server 为唯一工作引擎 |
| sharing / cluster 未实现 | v2 的多用户共享与集群能力尚未落地 | 平台自身承担多任务组调度与隔离，不依赖 v2 共享能力 |

## 9. OpenCodeDriver 抽象层（落地路径）

本章是第 5 章「平台基于 v2 的架构落地」的落地化修订。基于 2026-08-06 的 v1 SDK 实测结论（第 6 章），平台现阶段以 v1 起步、架构按 v2 演进方向设计，通过 OpenCodeDriver 抽象层将 opencode 的版本差异收敛在一个封装层内，v2 稳定后只换 driver 即可平滑迁移。

> ⚠️ **订正（2026-10-20）**：本章描述的是 **2026-08 的"落地路径设计"**。该路径**已经走完**——v2 适配已于 2026-10 落地（单轨 v2，锁版 `@opencode/cli@2.0.32`）。本章中"v1 起步 / v2 迁移目标 / `resolveRole` 走插件注册"等表述**按 §9.1 的订正块与 §12 读取**。本章**保留原设计文本**作为决策演进的记录，不做结构重排。

### 9.1 决策：v1 起步，v2 就绪

> **订正块（2026-10-20）· 已切换为单轨 v2**
>
> | 项 | 2026-08 的决策 | 2026-10 的实际 |
> |---|---|---|
> | 驱动形态 | v1 起步，v2 稳定后一次性切换 | **单轨 v2**：`V2Driver`（实现 `OpenCodeDriver` 接口）；**v1 驱动已在 T18 删除**（计划 D1）——`OPENCODE_V2_ENABLED=false` 现在**响亮抛错**，不再是退路 |
> | 切换代价的估计 | "只动 V2Driver 一个实现，业务层零改动" | ❌ **低估**：实际改动覆盖 driver + 事件层 + 语义层 + 配置/凭据 + 控制面收敛 + 工具插件六层（§12.8；`.omo/plans/opencode-v2-adaptation.md` 的 P0–P8） |
> | 依据 | "v1 SDK 可用、v2 的 SDK 未发布" | ❌ **依据均已失效**：v1 线冻结于 1.19.3、v2 的 SDK 已正式发布（§6） |
> | 回退形态 | v1 driver 保留作退路 | **不是运行时开关**：v1 driver 删除后，回滚 = **代码/镜像**回滚（**建议**连数据卷一起快照恢复——但**不是**因为"v1 读不了那个卷"，见 §12.8 的订正） |
>
> 抽象层的价值**确实兑现**了——但兑现方式是"**换实现即可**"，而不是"**零改动**"。

> 分布式语境修正：OpenCodeDriver 的落地实现（V1Driver/V2Driver）位于 **worker 节点内部**（即 11.6 的 WorkerRuntime），控制面只通过 Worker HTTP 接口远程调用，**平台进程从不直接起 opencode 进程，也不直连 opencode**。本章接口定义与迁移路径不变——它正是 WorkerRuntime 对外暴露的 HTTP 语义，控制面感知不到底层是 v1 还是 v2。⚠️ **该"不直连"在迁移落地前并不成立**（控制面曾直连 opencode 5 处），见 §11.5 的订正。

**平台现阶段基于 v1 SDK（`@opencode-ai/sdk` 1.x）起步，架构上按 v2 演进方向设计；v2 稳定后通过替换 driver 平滑迁移。**

- v1 SDK 已实测可用（见 9.6），不阻塞平台开发；v2 的 SDK 封装包（`@opencode-ai/sdk-next`）尚未公开发布（第 6 章），现阶段直接依赖 v2 将引入未冻结契约。
- 该决策不推翻第 1 章的「基于 v2」方向，而是把 v2 落地时点从「开发基线」调整为「迁移目标」：平台开发期间持续跟踪 v2 契约（第 7 章同步策略不变），v2 正式可用后一次性切换。
- 版本差异被 OpenCodeDriver 封装层隔离，业务层（任务、群聊、产出物、状态机，见 03 篇 FR-xx 与 04 篇）感知不到底层是 v1 还是 v2。

### 9.2 Driver 接口

> 分布式语境修正：以下接口定义在分布式架构下原样保留，作为 Worker 节点对外暴露的 HTTP 语义（服务端→worker 的 `/instances`、`/sessions`、`/prompt`、`/abort`、`/models` 调用与 worker→服务端的 SSE 事件流，见 11.3）。接口的落地实现（V1Driver/V2Driver）在 **worker 节点内部**；分布式形态下控制面通过 Worker HTTP 接口远程调用，平台进程从不直接起 opencode 进程或直连 opencode，接口语义不变。

> ✅ **订正（2026-10-20）**：本章的接口定义此前是**"声明但未实现"**的设计稿。**现已落地**：接口 + vteam 自有类型在 `worker/src/driver/opencode-driver.ts`（14 个方法：`createSession` / `sendMessage` / `getMessages` / `listQuestions` / `replyQuestion` / `rejectQuestion` / `listPermissions` / `replyPermission` / `abort` / `listAgents` / `listTodos` / `listModels` / `isHealthy` + `baseUrl` / `authPassword`），两代实现各一份，并接入**共享契约套件**（`opencode-driver.conformance.ts`）。落地时对设计稿做了两处调整：① **`resolveRole` 没有成为独立方法**——角色解析在 v2 侧收敛为"配置键 `agents.<n>.system` + `POST /api/session/{id}/agent` 激活"，不需要单独的驱动方法（§12.4）；② 消息读取是**分页**的（`getMessages(sessionID, options?)`）。**接口的入参/出参全部用 vteam 自有类型**，opencode 的 `Session.Inbox.User` / `Content[]` 等类型不外泄到业务层。

封装层定义统一驱动接口，V1Driver 与 V2Driver 各自实现，业务层只依赖接口：

```typescript
interface OpenCodeDriver {
  createSession(taskId: string, roleAgent: RoleAgent): Promise<SessionRef>
  sendMessage(sessionId: string, input: { text: string; mentions?: string[] }): Promise<MessageResult>
  listModels(): Promise<ModelInfo[]>
  getMessages(sessionId: string): Promise<MessagePart[]>
  resolveRole(roleAgent: RoleAgent): Promise<ResolvedRole>  // v1: system 注入 / v2: 插件注册 agent
  abortSession(sessionId: string): Promise<void>
}
```

说明：

- `createSession` 以任务组与角色为输入，返回会话引用；`sendMessage` 的 `mentions` 对应 03 篇 FR-11 定向 @ 触发与 FR-13 Agent 间互 @，驱动层将其转换为对应版本的上下文注入（v1 的 system 提示或 v2 的 agents 字段）。
- `resolveRole` 是版本差异最集中的方法：同一「角色解析」语义，v1 与 v2 的落地机制完全不同（见 9.4），因此从驱动内部提为显式方法，便于迁移期逐角色切换。
- `abortSession` 对应「已中断」语义（03 篇 FR-21 用户中断显示「已中断」、FR-10 消息内容类型中的中断片段），确保异常路径可被平台主动收口。

### 9.3 双实现对比

> ⚠️ **订正（2026-10-20）**：下表的"角色注入"一行**方向对但不完整**——v2 的 prompt body **没有 `system` 字段**（`additionalProperties:false`，带上也不报错但被完全忽略），而"插件 `ctx.agent.transform` 注册角色 agent + 会话 `switchAgent`"**不是 v2 实际生效的路径**。实测结论见 §12.4，摘要：**v2 原生的角色提示载体是配置键 `agents.<name>.system`，激活机制是 `POST /api/session/{id}/agent`（或建会话时带 `"agent"`）**；`ctx.agent.transform` 存在，但平台**没有**用它承载角色提示。

| 维度 | V1Driver（`@opencode-ai/sdk` 1.x，**已冻结**） | V2Driver（opencode v2，**当前基线**） |
|------|--------------------------------------------|-------------------------------|
| 路由前缀 | 路径无 `/api` 前缀 | 统一 `/api` 前缀（legacy 根路径面已移除） |
| 消息结构 | parts 数组结构 | `PromptInput{text, files, agents}` 替代 parts；**无 `system` 字段** |
| 角色注入 | 在 message body 传 `system` 字段注入角色提示词 | **配置键 `agents.<name>.system`**（v2 原生节 `agents`）+ **`POST /api/session/{id}/agent`** 激活；❌ prompt body 的 `agents:[{name}]` attachment 是 **no-op**（实测） |
| 会话作用域 | 全局会话，任务隔离靠平台侧按任务组管理 | location-scoped，Session 绑定创建时的 Location |
| 模型列表 | 分散在会话相关接口 | 独立 `GET /api/model` |
| 角色能力 | system 注入仅为提示词层，无独立 agent 生命周期 | 注册的 agent 可携带配置、工具、权限，运行时变更走 `POST /api/session/{id}/agent` |

### 9.4 角色解析差异（关键）

> ⚠️ **订正（2026-10-20）**：原文说 v2 的 `resolveRole` 是"启动时通过插件 `ctx.agent.transform` 注册角色 agent，会话建立后 `switchAgent` 切换"。**实测**：v2 侧角色提示的原生载体是**配置键 `agents.<name>.system`**（在 v2 原生 `agents:` 节内原样保留），**激活机制是 `POST /api/session/{id}/agent`**（官方文档背书为"switch the agent used by subsequent provider turns"）；而**在 v1 形 `agent:` 节内的 `prompt` 键会被迁移为 `system`，在 v2 原生 `agents:` 节内的 `prompt` 键则被静默丢弃**（无任何告警）⇒ **节名 `agent`→`agents` 与键名 `prompt`→`system` 必须作为同一次原子改动落地**。逐条实测见 §12.4 与 `docs/agent-platform/opencode-v2-spike-results.md` §2。
>
> 另外：**逐消息**的角色提示（v1 的 `system` 是逐消息的）在 v2 没有原生承载——等价载体是插件 `ctx.session.hook("context", cb)`（往模型请求的 system 推段，已实测生效），平台当前仍以**文本前缀**兜底。

`resolveRole` 的语义在两版实现中是「升级」而非「退化」：

| 版本 | resolveRole 落地方式 | 能力边界 |
|------|---------------------|---------|
| v1 | 发消息时在 body 传 `system` 字段，注入角色提示词（产品经理、架构师、开发者、测试等角色描述） | 角色仅为提示词层，平台侧仍需自行管理角色与工具、权限的关联 |
| v2 | **配置侧**：角色提示写进 `agents.<name>.system`；**运行时侧**：`POST /api/session/{id}/agent` 激活该 agent（建会话时带 `"agent"` 等价）。⚠️ 不是 `ctx.agent.transform` 注册 | 角色是平台一等对象，可携带提示词、技能、工具与权限配置（对齐 04 篇 FR-33~36）；**但静态 `system` 装不下"逐消息现拼"的角色提示**——那部分需插件 hook 或文本前缀兜底（§12.4） |

v1 是「提示词即角色」，v2 是「agent 即角色」。迁移时 resolveRole 由「拼 system 字符串」改为「配置里声明 + 会话内激活」，角色配置的载体从平台侧数据结构迁移到 opencode 侧 agent 定义，业务层调用不变。

### 9.5 每任务组隔离

第 5 章的 Worker 概念在 driver 抽象下落地为**每任务组一个 opencode 实例（由 worker 节点承载）**：

- **v1 现状**：每个任务组由 worker 节点承载一个 opencode 实例（v1 在节点内 spawn 子进程，见第 10 章），agent 变更只重启对应任务组的实例，不触碰其他任务组（呼应第 2 章粒度热重载诉求；完整形态见第 11 章分布式 Worker 架构）。
- **v2 演进**：多任务组天然映射为多 Location 图，Session 绑定创建时的 Location、不能靠传 path 偷换上下文（第 4 章），隔离语义由框架保证。任务组实例化从「节点内 spawn 子进程」演进为「节点内 Effect Scope / Location 级」，控制面调度逻辑不变。

该设计同时覆盖第 8 章风险表中的「sharing / cluster 未实现」：多任务组调度与隔离由平台自身承担，不依赖 v2 共享能力。

### 9.6 v1 可行性实测结论（2026-08-06 实证）

对 `@opencode-ai/sdk@1.18.14` 的全链路实测通过：

- 安装与 ESM 导入正常；
- 创建会话成功；
- 列 agent 返回 16 个内置 agent；
- 通过 body 传 `system` 注入角色提示词后发消息成功；
- 取消息历史完整返回。

结论：v1 SDK 具备平台起步所需的全部能力，可作为 V1Driver 的稳定实现基础；该实测同时确认 v1 的 `system` 注入路径可用，为 9.4 的 v1 resolveRole 提供事实依据。

> ⚠️ **订正（2026-10-20）**：本节是 **2026-08 的历史实测记录**，保留作为"v1 曾可用"的证据。但它的**版本前提已过期**——v1 线冻结于 **1.19.3**（不再发版），本节实测的 `1.18.14` 更早。⇒ **v1 不再是平台起步的可行基线**，也不再是可依赖的兜底（§6、§12.8）。

### 9.7 迁移动作清单

v2 稳定后，迁移只动 V2Driver 一个实现，业务层零改动：

| 动作 | 说明 |
|------|------|
| 路径加 `/api` 前缀 | V2Driver 内统一拼接前缀，收敛路由差异 |
| body 改 `PromptInput` | `sendMessage` 从 parts 结构改为 `{text, files, agents}`，`mentions` 映射到 `agents` |
| `resolveRole` 改为插件注册 | 启动时 `ctx.agent.transform` 注册角色 agent，会话内 `switchAgent` 替换 system 注入 |
| 绑定 Location | `createSession` 按任务组绑定 `Location.Ref{directory, workspaceID}`，接续 9.5 隔离语义 |
| 模型列表切 `GET /api/model` | `listModels` 换端点 |

> ⚠️ **订正（2026-10-20）**：上表是 **2026-08 的估计清单**。实际落地时：
> - ✅ "路径加 `/api` 前缀""body 改 `PromptInput`""绑定 Location""模型列表切 `GET /api/model`" **按预期落地**；
> - ❌ "`resolveRole` 改为插件注册" **未按此形态落地**——实测的 v2 原生载体是**配置键 `agents.<name>.system`** + **`POST /api/session/{id}/agent`** 激活（§12.4）；
> - ➕ **清单漏了实际改动最大的几处**：事件层整层重写（v2 帧无 `event:` 名、类型在 `data.type`、幂等键换成上游 `durable.seq`）、语义层（v2 无 `step-finish` part，需**合成**）、配置/凭据（v2 形态配置 + 隔离 `HOME`/`XDG_*` + 凭据双写）、控制面收敛、工具产物形态从"文件"改成"插件注册代码"（§12.8）。

### 9.8 预计迁移工作量

- 封装层：新增 1 个 V2Driver 实现 + 角色注册机制调整（插件注册代码 + 角色到 agent 的映射表）。
- 业务层：任务、群聊、产出物、状态机（03/04 篇）零改动。
- 总量约为平台总代码的 **10-15%**，且集中在封装层与角色注册两点，可控可评审。

> ⚠️ **订正（2026-10-20）**：该估计**低估**了实际改动面（见 §9.7 的订正块）。实际交付横跨 **P0–P8 八个阶段 / 23 个任务**，改动集中在 driver、事件层、语义层、配置与凭据、控制面收敛、工具插件六处，而非"封装层与角色注册两点"。**业务层零改动这一条成立**——vteam 的落库/渲染形态未变（零数据迁移、零 web 改动），这是原判断中最有价值的部分。

## 10. Worker 节点内部运行时（V1Runtime / V2Runtime）

> ⚠️ **订正（2026-10-20）**：本章原文假设 v2 改用 **in-process Effect Scope**（`OpenCode.create()`）承载运行时。**平台最终没有走这条路**——计划 §1.3 把"引入 `@opencode/sdk` 进程内托管（in-process host）"列为**非目标**（其多租户持久化能力未验证，计划 §10 Q4/Q5）。**v2 与 v1 一样，由 worker 节点 spawn 一个独立的 `opencode serve` 子进程**，差别在**协议**（`/api` 前缀、`content[]`、`durable.seq`…）而不是在**进程模型**。本章以下对 v1 的描述仍然成立（它描述的是 v1 的真实进程模型），对 v2 的"Effect Scope"描述请按 §12.3 读取。

> 本章说明 opencode 运行时在 **worker 节点内部**的承载方式：v1 以 spawn 子进程承载（V1Runtime），v2 以 Effect Scope 承载（V2Runtime）。**服务端（控制面）从不直接起 opencode 进程**，只通过 Worker HTTP 接口（11.3）向 worker 下发实例/会话/消息指令；worker 节点内部自行管理 opencode 进程。

本章回答第 9 章落地路径背后的一个常见架构疑问：**opencode 到底在哪里运行？服务端要不要自己起一个进程来操作 opencode？** 结论先行：**服务端（控制面）永远不自己起 opencode 进程**。opencode 只承载于 worker 节点内部；控制面通过 Worker HTTP 接口（11.3）管理 worker，worker 节点内部再以 v1 spawn 子进程或 v2 Effect Scope 的方式承载 opencode 实例。本章同时澄清 v1 三种集成方式在进程模型上的真实差异，并给出 v1 阶段 skill/tool 变更的推荐流程（呼应第 5 章 Worker 概念、第 9 章 OpenCodeDriver 与第 11 章分布式 Worker 架构）。

### 10.1 核心澄清：opencode 只运行在 worker 节点内部（控制面永不直接起进程）

用户问"集成 SDK 后服务端是不是就是 worker、能否重启自己"，背后的误区是把 SDK 当作**进程内函数库**，进而以为服务端进程要直接承载 opencode。以 v1 SDK 的 `createOpencodeServer()` 为例，其实现真相（源码 `packages/sdk/js/src/server.ts`）是：

```typescript
// 源码证据：server.ts 的核心逻辑（行号对应 v1.18.14）
const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`]

const proc = launch(`opencode`, args, {            // ← spawn 独立子进程
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),  // ← 配置经环境变量注入
  },
})
// ...
return {
  url,                                              // 子进程 serve 的 HTTP 地址
  close() { clear(); stop(proc) },                  // ← close() 杀掉子进程
}
```

要点：

- **`createOpencodeServer` 的本质是 spawn 一个独立 opencode 子进程**，配置通过 `OPENCODE_CONFIG_CONTENT` 环境变量注入。它返回的 `url` 指向子进程的 serve 端口，`close()` 则杀掉该子进程。
- 这个 spawn 动作发生在 **worker 节点内部**：worker 节点以 spawn 子进程的方式承载 opencode 实例（这正是 V1Runtime 的实现方式），进程关系是 worker 节点进程为父、opencode 子进程为子，全部收敛在节点内部。
- **服务端（控制面）不参与任何 spawn**：控制面从不直接起 opencode 进程，只通过 Worker HTTP 接口（11.3）向 worker 下发"创建实例 / 重启实例 / 发消息"等指令，由 worker 节点自行完成 opencode 进程的创建、管理与销毁。
- **"重启实例"的正确含义**：worker 节点对该节点上的 opencode 子进程执行 `close()` 杀掉 → 重新 spawn 一个新进程（对应 11.4 的 `/stop` / `/kill` 指令）。控制面只需向 worker 发一条重启指令，控制面自身进程的生命周期由部署侧（systemd / 容器）管理，与 worker 重启解耦。
- 这条澄清同时修正了"集成 SDK 后进程内嵌、无法重启"的担忧：只要 worker 节点采用 spawn 子进程的方式承载 opencode，worker 天然可重启，无需任何 hack。

### 10.2 v1 三种承载方式对比（worker 节点视角）

v1 SDK（`@opencode-ai/sdk@1.x`）导出三种集成入口，worker 节点可据此选择如何在节点内部承载 opencode 实例，进程模型与可管理性差异显著：

| 方式 | opencode 位置 | 能否重启实例 | skill 变更路径 |
|------|--------------|----------------|--------------|
| `createOpencodeServer`（spawn 子进程）| 节点内独立子进程 | ✅ `close()` 杀掉 + 重新 spawn | 写文件 + 重启该节点上的实例 |
| `createOpencode`（server + client 组合封装）| 内部仍是 spawn 子进程（源码：`createOpencodeServer` + `createOpencodeClient` 组合，`index.ts`）；若误作"进程内运行"则无独立进程 | ✅ 可复用 `server.close()`（等价 createOpencodeServer）；按"进程内"理解则 ⚠️ 需销毁重建运行时，v1 无完整 Scope 模型，尴尬 | 与 createOpencodeServer 相同；进程内理解则受限 |
| `createOpencodeClient`（纯 HTTP 客户端）| 外部独立 server | ✅ 节点不管理（需外部重启）| 外部处理 |

说明与结论：

- **`createOpencode` 是组合封装而非独立模式**：v1 源码中它只是 `createOpencodeServer()` + `createOpencodeClient()` 的语法糖（`index.ts`），返回 `{ client, server }`，其 `server` 部分与直接调 `createOpencodeServer` 完全等价，同样可 `close()` + 重新 spawn。所谓"进程内模式"是常见误读——若 worker 节点真的绕过 spawn 把 opencode 运行时直接嵌进自身进程，v1 缺乏完整的 Scope 模型来销毁重建，才会陷入"无法重启"的困境。**worker 节点不应走这条路。**
- **`createOpencodeClient` 不管理进程**：它只负责 HTTP 通信，进程生命周期由外部负责。适用于已有独立部署的 opencode server、仅需远端连接的场景。
- **v1 阶段建议采用 `createOpencodeServer`（spawn 子进程）**：它与第 5 章 Worker 概念、第 9 章"每任务组一个 opencode 实例"完美契合——worker 节点为每个任务组 spawn 子进程、按需重启，天然满足"agent 变更只重启对应任务组实例"的隔离诉求。

### 10.3 v1 阶段 skill/tool 变更流程（worker 节点视角）

v1 的 skill 发现在启动时一次性完成（`discoverSkills` 绑定 `InstanceState.make`，无 watch 热加载），因此运行时新增 skill/tool 文件的唯一生效路径是**重启该 worker 节点上的 opencode 实例**。控制面只需向 worker 下发"重启实例"指令（11.3），由 worker 节点执行如下流程：

1. **写文件**：worker 节点把 SKILL.md 写入该任务组 opencode 的 skills 目录（或 `.opencode/tools/*.ts`）。
2. **杀进程**：worker 节点对该任务组实例执行 `close()`，杀掉 opencode 子进程。
3. **重新 spawn**：worker 节点以新端口/新配置重新启动该任务组实例。
4. **发现生效**：新进程启动时 `discoverSkills` 扫描到新增 skill/tool，进入可用状态。

```
服务端（控制面）                          Worker 节点
      │  下发"重启实例"指令                  │  write SKILL.md ──────────▶ 磁盘目录
      │  POST /worker/{id}/...  ────────────▶  close()  ────────────────▶ 杀掉子进程（会话中断）
      │                                     │  createOpencodeServer() ──▶ spawn 新进程，启动时 discoverSkills
      │                                     │                            扫描到新 skill，生效
```

代价与收益：

- **代价**：仅该任务组内的会话中断，正在进行的任务需要重试或续接（对应 03 篇 FR-21 中断语义与重试模型）。
- **收益**：其他任务组不受影响，隔离收益完整保留（呼应第 5 章"agent 变更只重启对应任务组的实例"）。相比"改全局配置重启整个平台"，代价收敛在单任务组粒度。

### 10.4 v2 内嵌的演进（worker 节点视角）

> ⚠️ **订正（2026-10-20）**：本节描述的是 v2 SDK 的**能力**，**不是平台最终采用的形态**。平台**没有**用 in-process Effect Scope 承载运行时（见 §10 章首的订正块与 §12.3），因此下表"运行单元 / 销毁"两行对平台而言**仍是"spawn 子进程 / `close()` 杀子进程"**；"skill/tool/agent 变更无需重启"这条能力平台**也没有依赖**——注入器写完 `.opencode/plugins/*.ts` 与 `opencode.json` 后仍按既有流程**重启 serve**（`reload-config` 命令 → 注入 → 重启，见 34 篇 §3.2）。保留本节原文作为 v2 能力边界的记录。

v2（sdk-next）将"重启"这个动作从**进程级**降为**运行时级**，worker 节点承载 opencode 的方式随之演进：

- `OpenCode.create()` 基于 Effect Scope 组装运行时，**Scope 关闭即释放**（router / location / fibers / 插件注册全部随之回收），节点内同样可以干净地销毁与重建，解决了 v1 进程内模式"无 Scope 模型、无法销毁"的痛点。
- skill / tool / agent 变更走 `ctx.skill.transform` / `ctx.tool.transform` / `ctx.agent.transform`，**运行时热更新，无需重启**，直接消灭 10.3 的"写文件 + 杀进程 + 重新 spawn"三步操作。
- 对应到第 9 章 OpenCodeDriver：**接口不变**，V2Driver 的实现比 V1Driver 更优——`resolveRole` 从"重启后生效的插件注册"演进为"运行时 transform 注入"，`createSession` 从"spawn 新子进程"演进为"创建新 Scope / 新 Location"。

演进对照：

| 维度 | v1（当前基线） | v2（迁移目标） |
|------|--------------|--------------|
| 运行单元 | spawn 独立子进程（createOpencodeServer）| Effect Scope（OpenCode.create）|
| 销毁 | `close()` 杀子进程 | Scope 关闭释放运行时 |
| skill/tool 变更 | 写文件 + 重启实例 | `ctx.skill.transform` / `ctx.tool.transform` 热更新 |
| agent 变更 | 重启实例（system 注入无 agent 生命周期）| `ctx.agent.transform` 注册 + `switchAgent` |

### 10.5 结论

1. **opencode 只承载于 worker 节点内部，服务端（控制面）永远不自己起 opencode 进程**。控制面只通过 Worker HTTP 接口（11.3）管理 worker；worker 节点内部自行管理 opencode 实例（v1 spawn / v2 Scope）。
2. **v1 阶段用 `createOpencodeServer`（spawn 子进程）承载"可重启的 opencode 实例"**：`close()` 杀掉 → 重新 spawn，天然契合第 5 章每任务组一个实例的 Worker 架构；worker 节点不要走 `createOpencode` 的"进程内"误读路径。
3. **v2 阶段用 Effect Scope + transform 实现"无需重启的热更新"**：OpenCodeDriver 接口保持不变，迁移时只替换 worker 节点内的驱动实现（V2Runtime），控制面零改动（接续第 9 章迁移动作清单）。
4. 两条演进路径共享同一架构骨架：worker 节点内的运行时生命周期管理收敛在 WorkerRuntime（11.6）内，控制面感知不到底层是"杀进程重 spawn"还是"Scope 关闭重开 / transform 热更新"。

## 11. 分布式 Worker 架构（控制面 / 数据面分离）

第 5/9/10 章分别从 Worker 概念、OpenCodeDriver 抽象与 worker 节点内部运行时三个角度描述落地。本章给出**分布式 Worker 架构**的完整蓝图：控制面（平台服务端）与数据面（分布式 Worker 节点池）分离，worker 通过配置主动连接服务端注册，服务端管理生命周期与任务下发，v2 改造只动 worker 侧集成逻辑。该架构满足 05 篇 1.4 节"水平扩展预留"的非功能要求，并把第 8 章风险表中的多任务组调度与隔离完全收敛在平台侧。

### 11.1 总体形态

控制面承载全部用户侧能力（Web UI、任务、群聊、产出物、Agent 配置）与 worker 管理能力（注册表、调度器、生命周期管理）；数据面是分布在任意网络位置的 Worker 节点池，每个节点内运行 opencode 引擎与任务组实例。两平面之间仅通过控制协议通信，控制面不直连 opencode，也不要求网络可达 worker 节点（worker 主动 outbound 连接）。

```
┌─────────────────────────── 控制面（平台服务端） ───────────────────────────┐
│  Web UI：任务 / 群聊 / 产出物 / Agent 配置                                  │
│  Worker 注册表 │ 调度器 │ 生命周期管理                                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ 控制协议
                                   │ 服务端→worker：HTTP 调用（instances/sessions/prompt…）
                                   │ worker→服务端：SSE 事件流（heartbeat/delta/status…）
                                   │ （worker 主动 outbound 连接，可跨网络边界）
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                       数据面：Worker 节点池                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐      ┌────────────┐        │
│  │ Worker A   │  │ Worker B   │  │ Worker C   │      │ Worker N   │        │
│  │ opencode   │  │ opencode   │  │ opencode   │      │ opencode   │        │
│  │ 引擎+任务组 │  │ 引擎+任务组 │  │ 引擎+任务组 │      │ 引擎+任务组 │        │
│  └────────────┘  └────────────┘  └────────────┘      └────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 11.2 Worker 注册协议

worker 启动后不等待控制面发现，而是主动向控制面注册并维持心跳（outbound 连接，因此 worker 可部署在任意网络位置，无需控制面反向可达）：

1. **读配置**：worker 启动读取本地配置 `{serverUrl, workerId, 能力声明}`（serverUrl 指向控制面注册端点，workerId 全局唯一，能力声明包含支持的 opencode 版本、并发上限、可用 skill/tool 清单）。
2. **注册**：`POST /api/workers/register`，上报 `workerId / opencodeVersion / 能力 / 负载 / 健康状态`，控制面写入 Worker 注册表。
3. **心跳循环**：注册成功后周期性上报心跳（见 11.4 心跳检测）。
4. **控制面可见**：`GET /api/workers` 返回在线节点列表，供调度与运维查看。

> 注册/心跳均走 worker→控制面的 outbound 连接，SSE 事件流复用同一通道（11.3），worker 节点不需要公网入站端口，安全面收敛为控制面单向暴露注册与调度端点。

### 11.3 控制协议（服务端 ↔ worker 接口调用）

控制协议 = 第 9 章 OpenCodeDriver 的**远程化**：WorkerRuntime 内部把 Driver 的每个方法暴露为 worker 节点的 HTTP 端点，控制面按 driver 语义远程调用。接口语义与 9.2 的 Driver 接口一一对应，仅是传输从"worker 节点内的函数调用"变为"HTTP 调用 + SSE 事件流"。

**服务端 → worker（HTTP 调用）：**

| 端点 | 对应 Driver 方法 | 说明 |
|------|-----------------|------|
| `POST /worker/{id}/instances` | `createSession` | 按任务组创建实例，绑定任务组与角色 |
| `POST /worker/{id}/sessions` | `createSession` | 在实例内创建会话 |
| `POST /worker/{id}/sessions/{sid}/prompt` | `sendMessage` | 发送消息（含 `mentions`） |
| `POST /worker/{id}/abort` | `abortSession` | 中断进行中的会话 |
| `DELETE /worker/{id}/instances/{gid}` | 销毁实例 | 任务归档后回收实例，释放节点资源 |
| `GET /worker/{id}/models` | `listModels` | 查询节点可用模型 |

**worker → 服务端（SSE 事件流）：**

| 事件 | 说明 |
|------|------|
| `instance.created` | 实例创建成功，返回实例句柄 |
| `session.updated` | 会话状态变更（消息历史更新） |
| `message.part.delta` | 增量消息片段（支撑实时会话查看） |
| `agent.status` | agent 运行状态变更 |
| `task.completed` | 单轮任务完成 |
| `worker.heartbeat` | 周期心跳（合并到心跳循环上报） |

> 服务端通过实例/会话事件重建第 9 章的 `SessionRef` 与 `MessageResult` 语义；控制面保存任务、消息、产出物等核心数据（第 8 章风险缓解：opencode 仅作工作引擎，可随时重建），事件流只用于同步会话进度与实时呈现。

### 11.4 Worker 生命周期管理

| 维度 | 机制 | 说明 |
|------|------|------|
| 心跳检测 | 心跳超时标记离线 | worker 周期上报心跳（11.2），连续超时 N 个周期标记离线，其上任务组进入待重调度 |
| 主动启停 | `POST /stop` 优雅、`/kill` 强制 | 优雅：先收口进行中的会话再退出；强制：直接杀进程，任务组交由自愈重调度 |
| 自愈 | 崩溃重调度 | worker 离线/崩溃后，调度器把其上的任务组按亲和与负载策略迁移到存活节点 |
| 任务亲和性 | 任务组绑定 worker | 任务组→实例映射记录在注册表（11.6 TaskGroupRegistry），调度器按能力/负载选择节点，尽量减少迁移 |
| 水平扩容 | 随时加节点自动发现 | 新 worker 注册即入池（11.2），调度器自动利用，无需重启控制面 |

### 11.5 v2 迁移只动 Worker 侧（用户核心诉求）

> ⚠️ **订正（2026-10-20）· 本节此前描述的是一个"承诺"，不是一个事实**
>
> 原文断言"v2 迁移的改动面被完整约束在 worker 节点内部，控制面零改动"。**迁移前的代码并不满足这条**：控制面 `server/src/workers/worker.client.ts` **直连 opencode 5 处**（`POST /session`、`POST /session/{id}/prompt_async`、`POST /session/{id}/abort`、`GET /session/{id}/message`、`GET /api/model`）——**"控制面从不直连 opencode"在代码里是假的**。
>
> 计划 **D3** 把这 5 处收敛进 worker 已有的 exec HTTP 面（worker 侧新增 `POST /sessions`、`POST /sessions/:id/prompt`、`POST /sessions/:id/abort`、`GET /sessions/:id/messages`、`GET /models`），控制面只调 worker。
>
> ⚠️ **当前状态（2026-10-20）**：**worker 侧已完成单轨收口**（v1 driver 已删、驱动模式开关 `OPENCODE_V2_ENABLED=false` 已改为响亮抛错，见 §12.8），但**控制面这 5 处直连尚未收敛**——`server/src/workers/worker.client.ts` 仍持有 v1 的端点字面量（`POST /session`、`POST /session/{id}/prompt_async`、`POST /session/{id}/abort`、`GET /session/{id}/message`、`GET /api/model`）。**在 v2 serve 上这些端点已不存在**（且不是 404，而是 200 + web SPA HTML ⇒ 会被当成 JSON 解析失败）。⇒ **这是当前代码与文档之间的已知缺口**，D3/T18 的控制面侧仍待落地。
>
> 收敛的动机不只是"纯洁性"：两处 prompt 构造已经**分叉**（控制面漏传 `system`，worker 侧带 `system`），v2 的 `PromptInput` + `delivery` + `agents` 语义会保证第二次分叉——两套 prompt 构造器 = 必然出第二个 bug。
>
> 证据：`.omo/plans/opencode-v2-adaptation.md` 的 D3 / T18；`.omo/plans/opencode-v2-progress.md` 的 T18 条目。

v2 迁移的改动面被完整约束在 worker 节点内部，控制面零改动：

| 层 | v1 阶段 | v2 迁移 | 改动面 |
|----|---------|---------|--------|
| 控制面 | 注册表 / 调度器 / 生命周期 / 任务 / 群聊 / 归档 / Agent 配置 | **协议层不变**，但**要收敛 5 处 opencode 直连**（D3 / T18） | ⚠️ **不是零改动**——是"**协议层零改动 + 去掉直连**" |
| Worker 对外 HTTP 接口 | `/register`、`/instances`、`/sessions`、SSE 事件流 | 不变（协议层 v1/v2 无感知） | **零改动**（另**新增**会话/模型代理端点，供控制面替代直连） |
| WorkerRuntime（worker 节点内部） | V1Runtime：spawn opencode 子进程（createOpencodeServer） | V2Runtime：仍是 **spawn `opencode serve` 子进程**（**不是** in-process Effect Scope），但**协议换成 v2**（`/api` 前缀、`content[]`、`durable.seq`、恒开鉴权） | **主要改动面在这里** |

控制面始终通过第 11.3 节的 HTTP/SSE 语义与 worker 通信，感知不到 worker 内部是"杀进程重 spawn"还是"Scope 关闭重开 / transform 热更新"（与第 10 章 10.5 结论第 4 条的骨架一致，只是进程关系换成了节点间网络关系）。v2 稳定后只需升级 worker 节点上的运行时并重启节点，控制面注册表、调度器与既有任务组全部无感。

### 11.6 Worker 内部结构

Worker 节点由三个组件构成，v2 迁移只触碰其中 Runtime 一层：

```
Worker 节点
┌──────────────────────────────────────────────┐
│ WorkerServer（HTTP 对外，协议层 v1/v2 不变）  │
│   /register /instances /sessions /prompt     │
│   SSE 事件流（outbound 回传控制面）            │
├──────────────────────────────────────────────┤
│ TaskGroupRegistry（任务组 → 实例映射）        │
│   记录 gid → 运行时实例句柄，支撑亲和与销毁    │
├──────────────────────────────────────────────┤
│ WorkerRuntime（抽象，v2 迁移只动这一层）      │
│   V1Runtime：spawn opencode 子进程            │
│   V2Runtime：spawn opencode serve 子进程      │
│              （v2 协议：/api 前缀 / content[]）│
└──────────────────────────────────────────────┘
```

- **WorkerServer**：对外唯一入口，负责协议编解码（注册、实例、会话、消息、事件回传）。协议层 v1/v2 无差异，v2 迁移不改动。
- **WorkerRuntime**：抽象接口，对应第 9 章 OpenCodeDriver 的落地实现。V1Runtime 用 `createOpencodeServer` spawn 子进程（第 10 章）；V2Runtime **同样 spawn 子进程**（`opencode serve`），差别在协议与配置形态，不在进程模型（§10 章首订正块）。
- **TaskGroupRegistry**：维护任务组（gid）与运行时实例的映射，供亲和性调度、销毁回收与重调度使用，是 11.4 生命周期管理的数据基础。

### 11.7 与既有决策呼应

| 既有决策（前文章节） | 分布式形态下的演进 |
|----------------------|-------------------|
| OpenCodeDriver 抽象层（第 9 章） | 演进为 Worker 节点内的 WorkerRuntime（11.6），Driver 接口语义原样保留并远程化为 11.3 的 HTTP/SSE 协议 |
| 每任务组一个 opencode 实例（第 5/9 章） | 每任务组在 Worker 节点内运行一个实例，TaskGroupRegistry 维护 gid→实例映射，隔离语义不变 |
| skill/tool 变更流程（10.3） | v1：节点内写文件 + 重启该任务组实例；v2：worker 内 `ctx.skill.transform` / `ctx.tool.transform` 热更新，无需重启 |
| v2 定期同步策略（第 7 章） | 只升级 worker 侧运行时（11.5），控制面无感；同步节奏与锁版本策略不变 |

分布式 Worker 架构是第 5 章「平台基于 v2 的架构落地」的完整形态：第 5/9/10 章的落地描述是它的退化特例（单节点部署：控制面与 worker 节点同主机，但仍通过 11.3 的 HTTP/SSE 语义通信，控制面不直连 opencode）。后续完整平台阶段以本章为架构基线，第 5/9/10 章对应演进为本章的子集。

---

## 12. v2 适配落地的实测结论【T23 补充块 · 2026-10-20】

> ⚠️ **本节是独立补充块**（opencode v2 适配 T23 追加），**自洽、可单独阅读**。全部结论来自**真实二进制实测**，不掺推测；每条都注明证据出处。
>
> 证据基线：
>
> | 项 | 值 |
> |---|---|
> | 实测二进制 | `opencode v2.0.28`（`opencode --version`）；锁版目标 `@opencode/cli@2.0.32` |
> | 契约基线 | `docs/agent-platform/opencode-v2-contract-baseline/`（OpenAPI 3.1 spec：276KB / **118 paths** / **142 ops** / 285 schemas；原始 SSE 字节；配置归一化回显） |
> | Spike 结论 | `docs/agent-platform/opencode-v2-spike-results.md`（T4 / T5 / T6；可一键复现 `bash docs/agent-platform/opencode-v2-spike-results/repro.sh`） |
> | 迁移计划 / 执行记录 | `.omo/plans/opencode-v2-adaptation.md`（D1–D13 决策、§9 交付链与回滚）/ `.omo/plans/opencode-v2-progress.md` |

### 12.1 v2 没有 `--pure` 的等价物：唯一可靠的手段是隔离配置域

v1 的 `opencode serve --pure`（禁第三方插件 / `AGENTS.md` 注入）在 v2 **不存在**——传 `--pure` 直接 exit 1（`opencode mcp list --pure` 同样 exit 1，是**显式失败**而非静默失败）。T6 用 **13 例候选矩阵**逐条实测，结论：

| 候选手段 | 实测结论 |
|---|---|
| `"plugins": []` / 省略 `plugins` 键 | ❌ **no-op**——v2 的 `plugins` 数组在**多份配置文件之间是"合并"而不是"替换"**，空数组不清空全局列表 |
| `"instructions": []` | ❌ **no-op**——`instructions` 只能**追加**额外指令文件，关不掉 `AGENTS.md` 发现 |
| `experimental` 里的开关 | ❌ **不存在**——v2 的 `experimental` 只有 `portable_shell_scanner` / `subagent_depth` / `policies` 三个字段，没有插件/AGENTS.md 开关 |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` | ❌ **是"追加"不是"替换"**——全局配置、全局插件、全局 `AGENTS.md` 仍会加载，不能用来隔离全局配置 |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | ❌ **副作用过大**——连项目 `AGENTS.md` **和**项目 `opencode.json` 一起禁掉（项目里的 `plugins` 键被忽略 → 全局插件又回来） |
| `"plugins": ["-*"]` | ❌ **不可用**——会把内置的 `opencode.agent` / `opencode.provider.*` 一起关掉 → `GET /api/agent` 与 `GET /api/model` 都变空、会话直接失败 `Agent not found: "build"`；且 `["-*"]` 之后**无法**把自家插件加回来 |
| `"plugins": ["-<id>"]` | ✅ **可用且精确**——按插件 ID 精确禁用，内置插件不受影响，自家插件照常加载。⇒ 可作**补强**，不是主手段 |
| **隔离 `HOME` + `XDG_CONFIG_HOME` 启动 serve** | ✅ **唯一可靠手段**——全局配置 / 全局插件 / 全局 `AGENTS.md` 全部不在作用域内 |

**平台落地（T16b）**：serve 子进程的 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` **全部指向隔离根**（缺省 `<worker HOME>/.opencode-iso`，下挂 `home/ config/ data/ state/ cache/`），并**删除**宿主残留的 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG`。隔离根在启动日志里显式打印。**实测验收 20/20**：宿主机全局配置零痕迹、项目配置被正确拾取、凭据真的被读、DB 落在隔离域、宿主的 `opencode.json(c)` / `auth.json` / 全局 `AGENTS.md` 前后逐字节相同、work dir 无 `AGENTS.md`。

> ⚠️ **两条残留（不是 100% 等价于 `--pure`）**：
> ① **受管/系统配置目录**（`/etc/opencode`、`/Library/Application Support/opencode`）**不受 `XDG_CONFIG_HOME` 控制**（v2 serve 会 watch 它），只有 `policies` 能压而 policies 属托管配置、项目配置覆盖不了（计划 §10 U9，**已知残留、不可修**）；
> ② v1 的 `--pure` 禁的是**全部** `AGENTS.md`，v2 隔离方案只禁**全局**那份，**项目目录里的 `AGENTS.md` 仍会被发现** ⇒ **workDir 根上不得有 `AGENTS.md`**。

### 12.2 `prompt` 与 `system` 的键规则：节名与键名必须**同时**改

v2 接受 v1 形配置并**静默归一化**。角色提示键 `prompt` 的处置**取决于它所在的节**（隔离 HOME/XDG，同一份配置里 `agent:` 与 `agents:` 两节并存时实测）：

| config 节 | 键 | v2 归一化结果 |
|---|---|---|
| `agent:`（v1 形） | `prompt` | **迁移为 `system`** ✅（值不丢） |
| `agent:`（v1 形） | `prompt` + `system` 并存 | `prompt` 胜出 → 成为 `system`；原 `system` 被挪到 `request.body.system`（inert） |
| `agents:`（v2 形） | `prompt` | ❌ **未知键 → 静默丢弃，无任何告警** |
| `agents:`（v2 形） | `system` | **原样保留** ✅ |

⇒ **节名 `agent`→`agents` 与键名 `prompt`→`system` 必须作为同一次原子改动落地。** 只改节名会让**所有角色提示静默丢失**——代码评审看不出、线上无任何错误信号。

> ⚠️ **"无归一化诊断"这个闸门是必要但不充分的**：**完全 v1 形的配置 → 0 条归一化诊断**；**半改名配置（v2 `agents:` + v1 `prompt` 键）→ 也 0 条诊断**，而角色提示已被静默丢弃。⇒ 检测不出半改名的只有**结构性回归测试**。平台据此把 `prompt` 守卫做成"**测试 + 构造期报错**"（builder 输出白名单把它变成构造期报错；injector 迁移时把 `agents.<n>.prompt` 挪进 `system`），而不是注释提醒。
>
> 补充：v2 原生 `Config.AgentEncoded` 是 `additionalProperties:false`，**只列 `system`、不列 `prompt`**（`prompt` 只在 legacy `AgentConfig` 里）。

### 12.3 运行时承载与契约形态

| 项 | v1 | v2（平台已落地） |
|---|---|---|
| 承载方式 | worker spawn `opencode serve` 子进程 | **同样是 spawn 子进程**——**不是** in-process Effect Scope（计划 §1.3 把"进程内托管"列为非目标） |
| 路由 | 无前缀面 + 过渡 `/api/*` 面 | **只有 `/api/*`**；legacy 根路径面已移除（且返回 **200 + web SPA HTML**，不是 404） |
| 消息 | `parts[]` | `content[]`（v2 无 `step-finish` part，**由 driver 合成**——它是控制面"本轮完成"的幂等键） |
| 事件 | `message.part.delta` 等 v1 事件名 | SSE 帧**无 `event:` 行**，类型在 `data.type`；**只有 durable 事件**带 `durable:{aggregateID,seq,version}` ⇒ 幂等键用上游身份 |
| 鉴权 | 密码可空 = 不鉴权 | **恒开**：`OPENCODE_SERVER_PASSWORD` 必填（空则 worker 启动 fail-fast）；未设置则 opencode 自动生成随机密码打到 stdout |
| 存储 | `~/.local/share/opencode/storage/…`（JSON） | **SQLite** `opencode.db`（与 `auth.json` 同目录，同卷）。⚠️ **落点由 `XDG_DATA_HOME` 决定**（`opencode debug paths` 的 `data` 目录）：平台隔离域下 = `<HOME>/.opencode-iso/data/opencode/opencode.db`——**与 v1 线的 `~/.local/share/opencode/` 不是同一个目录**（这条决定了回滚时的数据口径，见 §12.8） |
| 版本闸门 | — | 启动期解析 `opencode --version`（v2 形 `opencode v2.0.28`），**major < 2 → fail-fast**；上报值规范化为 semver 串 |

**落库/渲染形态未变**：`content[]` 在 **driver 边界**就归一成 vteam 既有的内部模型（server 侧 `message-parts.ts` 的 `normalizeParts()` 收口）⇒ **零数据迁移、零 web 改动**（这是本次迁移中最被低估的正收益）。

### 12.4 角色提示：`agents.<n>.system` 进入模型请求 + 激活机制

| # | 结论 | 证据 |
|---|---|---|
| T4.1 | ✅ **`agents.<name>.system` 确实进入最终模型请求**——system 消息的**第一行**就是角色提示原文，其后才是 opencode 内置 system 段（`# Your Model` / `# Code Mode` …）⇒ 角色提示被**前置**（不是替换、不是追加到末尾） | `opencode-v2-spike-results/evidence/t4-role-prompt.txt` |
| T4.2 | ✅ **`POST /api/session/{id}/agent {"agent":"<name>"}`（204）会把该 agent 的 system 应用到后续 turn**；会话里同时新增一条 `type=agent-switched` 消息并发出 `session.agent.selected` 事件。**追加发现**：`POST /api/session` 时 body 带 `"agent":"<name>"` 同样生效 | 同上 |
| T4.3 | ❌ **prompt body 的 `agents:[{"name":…}]` attachment 是 no-op**——最终请求的 system 是默认 `build` agent 的提示；assistant 消息的 `agent` 字段仍是 `build`；**没有** `agent-switched` 消息、**没有** `session.agent.selected` 事件（三条独立证据同时指向 no-op）⇒ **不得依赖** | 同上 |
| T4.5 / T4.5b | ✅ **插件 hook 两条都生效**：`ctx.session.hook("prompt", cb)` 可改写 `prompt.text`；`ctx.session.hook("context", cb)` → `event.system.push({type:"text",text})` 可把任意段**直接注入模型请求的 system**——这是**最贴近 v1 逐消息 `system` 语义**的载体（`agents.<n>.system` 是**逐 agent** 的）。⚠️ `context` hook 只作用于 **primary** 请求（标题/压缩/generate 各有独立 hook） | `opencode-v2-spike-results/evidence/t4-plugin-hooks.txt` |

**平台当前的承载分工**（重要，别混读）：

- **`agents.<name>.system`** = **逐 agent 的静态**角色提示（配置是按 agent 名的静态量）；
- **逐消息的 system blob**（控制面每次派发按成员现拼的身份段 + `【岗位职责】` + `【职责】`…）= **装不进静态配置** ⇒ 当前仍以**文本前缀**兜底（进 **user 段**，优先级低于 system 段——这是一个**已知的语义降级**）；
- **正解** = 插件 `ctx.session.hook("context")`（**逐消息**语义），**本轮未实现**（需要额外维护一个 v2 插件 + 每会话文件交接）；
- **不变式**：若被激活的 agent **已配置了非空 `system`**，驱动就**不再**把 blob 前缀进正文（否则角色提示在 system 段与 user 段各出现一次）。

### 12.5 凭据：v2 **不从 `auth.json` 取 provider 的 API key**

**实测（2.0.28，mock OpenAI 兼容端点）**：把 `auth.json` 放进 XDG 位置后，模型请求**没有 `Authorization` 头**、SQLite 的 `credential` 表**为空**；放 HOME 位置同样如此；已知集成（`openai`/`anthropic`）同样如此。⇒ **v2.0.28 的"一次性导入 legacy auth.json"迁移实测是 no-op。**

**真正生效的载体只有两个**：① 配置里的 **`providers.<id>.settings.apiKey`**（实测请求带 `Authorization: Bearer <key>`）；② v2 原生 `POST /api/credential` → SQLite `credential` 表。

> ⇒ **若沿用 v1 的 `auth.json` 注入路径，切到 v2 后 worker 会"静默地没有可用模型"**（不报错、只是没模型）——这是整个迁移里最容易踩且最难查的一类坑。

**平台对策（凭据双写）**：`auth.json` 照写（v2 的 legacy 路径 + 形态兼容）**同时**把 key 写进 provider 段的 `settings.apiKey`（v2 真正会读的那一处），且**以 `auth.json` 为真源**——写配置的入口会为缺 key 的 provider **回填**，所以任何写入方都无法悄悄抹掉凭据。代价如实记录：明文 key 也落在 `opencode.json`（0600，隔离域内）——v2 自己的 credential store 本来也是同卷明文，暴露面没有实质增加。

### 12.6 权限默认取值在 v2 下变宽（平台**已采纳**）

v2 的规则集用 **`findLast`**（最后一条命中者生效）求值，且**每个 agent 的内置兜底以 `{action:"*",resource:"*",effect:"allow"}` 开头**、配置规则**追加在其后** ⇒ **凡未被声明的 action 一律放行**（`webfetch` / `glob` / `grep` / `todowrite` / `skill` / `websearch` 及全部 MCP 工具）；v1 下它们落到引擎的逐 action ask/deny 默认。

**平台负责人已裁定：接受该放宽**（不补 catch-all ask、不引入逐 action 默认表）。**完整事实、后果与红线见 §3.2**——本节不重复。工具类权限的**真正权威仍是服务端闸门**（`ROLE_BOUNDARIES[*].toolAllows`），该矩阵不因 v2 迁移而改变。

### 12.7 工具注册：产物形态从"文件"改成"插件注册代码"

| # | 结论 |
|---|---|
| T5.1 | 声明签名 = `ctx.tool.transform(editor => editor.add({name, description, input: <JSON Schema>, options?, execute(input, ctx) => Promise<Tool.Result>}))`——**入参从 Zod 改 JSON Schema**，**返回值从 string 改 `{content}`**（`content` 接受 `string \| Content[]`，事件侧是**数组**） |
| T5.2 | ⚠️ **`ToolContext` 的键集合实测 = `{sessionID, agent, messageID, id, signal, progress}`** ⇒ **没有 `directory`**（取 `ctx.location.directory`） |
| T5.3 | ❌ **`.opencode/tools/*.ts` 的文件自动发现在 v2 已移除**——放在该目录的探针文件**连 import 副作用都没发生** ⇒ 工具**只能**经 `ctx.tool.transform` 注册 |
| T5.4 | ✅ `.opencode/plugins/*.ts` **会被自动发现**（`GET /api/plugin` 出现 `{"id":…,"source":{"type":"local","path":"…/.opencode/plugins/tools.ts"}}`） |
| T5.5 | ✅ 插件文件里的 `import { Plugin } from "@opencode/plugin"` **能被解析**（宿主内置该模块，**不需要** node_modules / package.json） |
| T5.8 | ⚠️ **插件工具默认只能经 Code Mode 调用**——不写 `options` 时工具只出现在 system 的 Code Mode 目录里，模型必须写 JS 经 `execute` 调它；**必须显式写 `options:{codemode:false}`** 才进模型的 `tools[]`（v1 的工具是直接暴露给模型的，语义等价于 `codemode:false`）。⚠️ **官方插件文档从未提及 `codemode`**（活二进制 vs 官方文档的冲突） |
| T5.9 | ⚠️ **`GET /api/plugin` 不可靠**（location 作用域 + 惰性发现 + `setup` 异步；实测出现过"同一次运行里返回 89 条 / 返回 `total=0` 而插件明明已加载"）⇒ **不要拿它当"插件是否加载"的判据**，改用 serve 日志的 `msg="loading plugin"` 行 + 工具是否出现在模型请求的 `tools[]` |

**平台的产物形态**：三个生成器（自定义工具 / git 工具 / 浏览器工具）改为**双形态插件模块**——同一文件同时导出 v2 的 `Plugin.define({id, setup})` 与 v1 的 `server()` 回退形态（v1 调 `server()`、v2 读 `id`/`setup()` 并忽略 `server()`）。⚠️ **v1 也会尝试调用 `setup`** ⇒ v2 分支必须防呆 `if (!ctx?.tool?.transform) return`。

> ⚠️ **开发模式已知限制（仅 dev，生产 `tsc` 不受影响）**：git 工具的辅助函数是**用 `toString()` 内联**进生成的插件产物的。在 **`tsx`（`npm run dev`）**下，esbuild 的 `keepNames` 会把 `__name(...)` 辅助调用**一起注入**到函数源码里，而生成的产物**没有** `__name` 的定义 ⇒ 该产物在运行时会在加载阶段报 `ReferenceError`。生产构建（`tsc`，无 esbuild）产出的产物不含 `__name`，**不受影响**。
> 复现（`worker/` 目录下）：把 `import { renderGitToolsFile } from './src/git/git-tools'` 写进一个临时 `.ts` 再 `npx tsx <file>` → `renderGitToolsFile().includes('__name')` 为 `true`；同样代码经 `npm run build`（`tsc`）后用 `node` 执行 → 为 `false`。
> 详见 `worker/README.md` 的「已知限制（仅开发模式）」。

### 12.8 v1 驱动退役与回滚形态：**不是运行时开关**

**决策（计划 D1）**：单轨切到 v2，落地 `OpenCodeDriver` 接口，**删除 v1 driver**。删除动作从 T8 延后到 **T18（P5 控制面收敛）一次性完成**——P0–P7 期间保留"退回 v1"的代码级退路（vteam 侧环境开关 `OPENCODE_V2_ENABLED=false`，**不是** opencode 的 CLI flag）。

> ✅ **当前状态（2026-10-20，T18 已落地）**：
> - `worker/src/driver/v1-driver.ts` **已删除**（单轨 v2）；
> - `OPENCODE_V2_ENABLED=false` **不再受支持**——`loadConfig` 阶段**直接抛错**（`parseDriverModeSwitch`），`resolveOpencodeDriverMode(false)` / `selectOpencodeDriverImplementation('v1')` 也**抛错**。错误文案**直接指向真正的回退手段**（回滚镜像/代码到 v1.0.x + 回滚 opencode 数据卷）。
> - ⇒ **没有"关个开关就退回 v1"的代码级开关**。留着"看起来能切、实际切不了"的开关 = 运维在故障时按错的方向排查。

**回滚形态（计划 §9.3）**：

| 层次 | 手段 | 限制 |
|------|------|------|
| 镜像层 | 把 `ARG OPENCODE_CLI_SPEC` 回退到 `opencode-ai@1.19.3` 并重建 | ❌ **不是有效回滚手段**——v1 driver 已删，镜像回退后 worker 跑不起来 |
| 代码层 | 回滚到 v1 线最后一个绿 tag（`v1.0.x`）+ helm 回滚到该 tag | ✅ 有效，但需确认没有存量 v2 形态消息（v2 写过的 `Message.content` v1 worker 渲染不了） |
| 数据层（**已订正**） | **仍然建议"连数据卷一起回滚"**（灰度前快照 → 回滚时恢复）——但**理由不是**"v1 读不了那个卷" | ⚠️ **订正**：隔离域下 v2 **没有**就地迁移 v1 数据 ⇒ **只回滚代码/镜像（不恢复卷）时，v1 期历史仍在原处、v1 二进制仍读得到**；**读不了的只是 v2 期间新建的会话**（隔离域内的 v2 形态 SQLite）。⇒ **没有快照时的损失是"有界的"（仅 v2 窗口期会话），不是"全部历史"**。恢复卷仍是**保守且正确**的推荐（能把 v2 窗口期的会话一并带回） |
| 结论 | **安全回滚路径 = 代码回滚到 v1.0.x tag + （建议）数据卷快照恢复 + helm 回滚** | 因为 D1 删除了 v1 driver，**没有"关个开关就退回 v1"的代码级开关**——这是 D1 决策的已知代价（已评估：v1 已冻结，维护双驱动不划算）。**可执行步骤见 `docs/deployment.md` §八.6（本文档不复述步骤）** |

⇒ **"退回 v1" = 代码/镜像回滚（+ 建议的卷快照恢复）**，不是运行时开关。

#### 12.8.1 实测依据：v2 **不会**迁移 v1 数据卷（原判断已作废）

> ❌ **原判断（已作废）**："v2 启动时已**就地迁移** v1 磁盘数据（`opencode.db`），v1 读不了该卷"。
> ✅ **实测结论**：在平台的**隔离配置域**（T16b）部署下，这个前提**不成立**。

**测量方法**：真实 `opencode v2.0.28`，`opencode debug paths`，**带 / 不带隔离各测一次**：

| 部署形态 | opencode `data` 目录 | `db` |
|---|---|---|
| v2 worker **带隔离域**（`XDG_DATA_HOME` → `<iso>/data`） | `<iso>/data/opencode` | `<iso>/data/opencode/opencode.db` |
| v1 worker（真实 `HOME`） | `<realHOME>/.local/share/opencode` | `<realHOME>/.local/share/opencode/opencode.db` |

⇒ **两个目录不是同一个** ⇒ **v1 时代的存储落在隔离后的 v2 worker 根本看不到的地方** ⇒ v2 **不会**迁移它（一次性 legacy 导入在 legacy 路径上找不到东西、**不触发**）⇒ **v1 时代的历史原样留在盘上**。

**三条由此推出的操作结论**：

1. **代码/镜像级回滚（同卷）仍读得到 v1 期历史**——v1 二进制读的是 `<realHOME>/.local/share/opencode/`，那里**原封未动**。
2. **真正读不了的是 v2 窗口期的会话**（在 `<iso>/data/opencode/opencode.db`，v2 形态 SQLite）⇒ **无快照时的损失有界**：只丢 v2 窗口期内新建的会话（产出物**文件**在 `uploads` 卷 / MySQL 里，不丢）；**平台侧数据（任务 / 消息 / 产出物 / 凭据）零 DDL、回滚不碰**。
3. **仍推荐灰度前做卷快照**——它是"回到 v1"的**保守且正确**的做法（能把 v2 窗口期的会话一并带回），**不是**因为"不恢复卷就会全丢"；并且它兜住了"**隔离域被关掉**"那种退化情形（那时迁移是就地的、v1 连卷都读不了）。

> 📖 **可执行的灰度 / 回滚步骤不在本文档**——见 **`docs/deployment.md` §八**（§八.0 五条硬事实 / §八.2 灰度步骤与闸门 / §八.6 回滚步骤 / §八.7 回滚时的数据影响）。本文档只给**结论与依据**。

### 12.9 交付链与灰度观察项

**交付链（计划 §9.1）**：P0（版本闸门 + 契约基线快照 + 三个 spike 结论）→ P1–P3（driver + 事件层 + 语义层）→ P4–P5（配置/凭据 + 隔离 env + 控制面收敛）→ P6–P7（工具插件 + 存储形态边界〔web 零改动〕）→ P8（契约/e2e + 文档订正）→ CI 绿 → 合并 → tag → Release Images → helm 灰度（1 worker → 10% → 50% → 100%）→ 集群验证。

**CI 必须包含**：与 Dockerfile 同 `ARG` 的 v2 二进制安装 → 集成测试真跑（无二进制时**显式跳过标记**）。

**灰度观察项（计划 §9.2）**：

| 观察项 | 判据 |
|--------|------|
| 会话成功率 | 与灰度前基线持平（不下降） |
| 首字延迟 | ≤15s 通过线、5s 目标线 |
| 完成判定准确率 | "有文本无终态"不再被误判完成（用 `session.execution.*` 事件计数交叉验证） |
| MCP 状态上报 | 不再出现"全部未连接"（探针失败即报错）。⚠️ v2 是**五态**（见 §12.10）：`pending`/`disabled` **不是** failed；**心跳 400** ⇒ server 还没接受五态 ⇒ 升级顺序错了 |
| 归一化 WARN 计数 | **必须为 0**；>0 即视为配置未改干净 |
| 401 计数 | **必须为 0**；>0 即查密码下发 |
| `durable.seq` 幂等 | 重放测试下重复落库为 0 |
| **v1 期会话历史仍在盘上**（回滚安全性的现场证据） | 隔离域**不碰** v1 的存储目录 ⇒ v1 期会话应**仍完整存在于** `<HOME>/.local/share/opencode/`；v2 窗口期新建的会话落在 `<HOME>/.opencode-iso/data/opencode/opencode.db`（见 §12.8.1） |

**硬约束：server 与 worker 必须一起切换**（计划 §9.1）：v2 把控制面↔opencode 的通道换成"控制面调 worker 的执行端点"（`POST /sessions` / `POST /sessions/:id/prompt` / `GET /sessions/:id/messages` / `POST /sessions/:id/abort` / `GET /models`）⇒ **v1 worker 没有这些端点**；反过来 **v1 server 直连的是 opencode 的 v1 路由**（v2 已移除）⇒ **两种混搭都不互通**（会话链路直接断，不是"降级可用"）。⇒ 灰度是**硬切**：先下线全部 v1 worker，server + worker 一起换到 v2 线，再逐档扩副本数。**可执行步骤见 `docs/deployment.md` §八.1 / §八.2。**

### 12.10 v2 的 CLI **不是 serve 的探针**（作用域错配）+ MCP **五态**契约【真栈实测补充块 · 2026-10-20】

> ⚠️ **本节的全部结论来自真跑本地 compose 栈的实测**（worker 容器内），**不是读文档推出来的**。
> 这也是"离线验证全绿、上线才炸"的那一类事实：**v1 下每次 CLI 调用都起自己的临时 serve
> （cwd 作用域）⇒ CLI 输出 ≈ serve 输出；v2 不是了。**

#### 12.10.1 CLI 子命令绑的是"共享托管后台服务"，不是 worker 的 serve

| 调用（worker 容器内） | 实测结果 | 真相 |
|---|---|---|
| `opencode mcp list`（裸） | `No MCP servers configured` | 答的是**它自己**的作用域；而 worker 的 serve 实际 `GET :4000/api/mcp` → 平台 MCP **connected** |
| `opencode mcp list --standalone` / `opencode --standalone mcp list` | 只打印**帮助文本** | `mcp` 命令组不接受 `--standalone` |
| `opencode models --standalone` | 能跑（起私有 server） | 但读的是 **CLI 自己的**配置作用域 |
| `opencode models`（worker 启动时） | **exit 1**：`ServiceUnavailableError: Location plugins did not finish activating` | ⇒ worker 注册**降级不带 `executableModels`** |

⇒ **v2 的 CLI 子命令绑的是"共享托管后台服务"（默认端口 49374）**，读的是**它自己那套配置作用域**——
**不是 worker spawn 的那个 serve**。⇒ **凡是用 CLI 探针去"观测 serve"的设计，在 v2 + 隔离下
原理上就是错的**：可能报出**不含 vteam 自配模型**的模型清单，可能报出"没有 MCP"而 serve 的
MCP 明明 connected——**两个都是静默错误答案**（不报错、只是答错）。

⇒ **v2 的正确探针是 serve 自己的 HTTP API**（Basic 鉴权，口令 = serve 密码；端点与口令从 serve
对象读——serve 换端口重启会自动跟上）：

| 探什么 | 端点 | 备注 |
|---|---|---|
| 模型清单（可执行集） | `GET /api/model` | 两种响应形态（2.0.28 `{location,data}` / 2.0.32 裸数组）都要容错；`enabled:false` 不算可执行；空/非法响应 ⇒ `undefined`（**不断言"零可用"**） |
| MCP 状态 | `GET /api/mcp` | **五态**，见 §12.10.2 |

> ⇒ **平台结论**：worker 侧**两个 CLI 探针都不留兜底**（留兜底 = 让作用域错配重新变成"正常路径"）；
> 有回归守卫禁止再 `spawn('opencode', …)`。

#### 12.10.2 MCP 状态是**五态**（不是 CLI 文本的三个）

`GET /api/mcp` 的 `Mcp.Server = {name, status: {status, error?}, integrationID?}`，其中
`status ∈` **`connected` / `pending` / `disabled` / `failed` / `needs_auth`**。

**1:1、不折叠**——`pending`（还在连，几秒后变 connected）与 `disabled`（**已配置但停用**）
**都不是 `failed`**：把"即将连上"报成"连接失败"、把"人为关掉"报成"环境故障"**都是撒谎**。
⇒ **线契约两端同步扩到五态**：worker 的 `McpServerStatus`（`worker/src/protocol/worker-protocol.ts`）
↔ server 的 `MCP_STATUS` + `@IsIn`（`server/src/mcp-servers/dto/mcp-status.dto.ts`）。
未知/缺失 `status` ⇒ 保守落 `failed` **并响亮告警**（带原始状态串），**不静默丢服务器**。

⚠️ **升级顺序是硬约束：先 server 后 worker**——server 的 `@IsIn` 必须**先**接受五值，否则 worker
一旦上报 `pending`/`disabled` ⇒ **整条心跳 400**（心跳 DTO 里 `mcpStatus` 是
`@ValidateNested({each:true})` ⇒ **数组里混进一个非法值 ⇒ 整包校验失败**）⇒ worker 心跳全丢 ⇒
**30s 内被判离线**（3 个心跳周期）。⇒ **滚动更新 worker 只有在 server 已是新版之后才安全**；
"先起新 worker、后升 server" 正是这个故障模式（表现得像"worker 起不来"）。
⇒ 运维口径见 **`docs/deployment.md` §八.0 事实 5 / §八.1 / §八.2 阶段 1** 与
**`chart/vteam/templates/NOTES.txt` 第 9 条**。

**web 侧同步（爆炸半径）**：worker 详情页的徽章主题表是 MCP 状态联合的 `Record`
⇒ 联合少一个键就**查表得 `undefined` ⇒ 详情页渲染报错**。现按五态渲染：
`connected`=已连接 / `pending`=连接中 / `disabled`=已停用 / `failed`=连接失败 / `needs_auth`=待授权；
并有纯单元门（`web/app/(main)/workers/shared.spec.ts`，Playwright `app-unit` 项目）守住
"主题表对五态完备"。

> 📖 **计划侧的完整记录**：`.omo/plans/opencode-v2-adaptation.md` **§2.9**（本节的计划版）
> + **D9 / T17**（探针决策与验收标准）+ **Q16**（已关闭）。
