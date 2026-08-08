---
title: opencode v2 调研与架构决策
id: opencode-v2-research
order: 7
kind: 技术调研
description: opencode 2.x 技术调研结论与平台基于 v2 实现、定期同步的架构决策，作为后续完整平台开发的技术基线
---

# opencode v2 调研与架构决策

本文档记录对 opencode 2.x（以下简称 v2）的技术调研结论，以及据此作出的架构决策。它是平台从"产品愿景"走向"完整平台开发"的技术基线：后续完整平台阶段的技术设计、SDK 封装、版本管理均以本文档为锚点。调研基于 v2 源码结构、官方动机说明与 2026-08 的生态实测，所有事实均已确认，未引入推测信息。

## 1. 决策

**平台基于 opencode 2.x 实现，v2 演进期间定期同步。**

- v2 处于官方 beta 阶段，定位是"will become OpenCode 2.0"（官方原话），尚未正式发布。
- v2 的 beta 包每日发布，契约仍在演进，因此平台采用**锁版本 + 定期跟进**策略：锁定一个经过验证的 beta 版本作为开发基线，同时持续跟踪 schema-changelog 与 `specs/v2/` 目录，按契约变更节奏升级基线。
- 该决策不影响本迭代（PRD + 原型），本迭代与 v2 无耦合；它约束的是后续完整平台阶段的实现方向。

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
| 嵌入 SDK | 提供 `@opencode-ai/sdk-next`，支持 in-process 组装（内存 router），嵌入场景与远程场景共用同一 HttpApi 契约（官方："In-process is only transport"）。平台可按场景选择进程内或进程外驱动 |
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

## 4. v2 API 与 v1 差异

| 维度 | v1 | v2 |
|------|----|----|
| 路由前缀 | 部分接口无统一前缀 | 统一 `/api` 前缀 |
| 作用域 | 全局或按 path 参数 | location-scoped，通过 `location[directory]` 与 `x-opencode-workspace` 头指定 Location |
| prompt API | 以 parts 数组为主的消息结构 | 简化：`PromptInput{text, files, agents}` 替代 v1 的 parts 结构 |
| 模型列表 | 分散在会话相关接口 | 独立 `GET /api/model` |
| 已移除端点 | 旧实验接口 | `instructions/entries` 与 `/api/experimental/migration/v1`（当前 dev 分支）已移除 |

平台在设计 SDK 封装层时，应以 v2 的 API 形态为准，不要沿用 v1 的 parts 消息结构与 path 传参习惯。

## 5. 平台基于 v2 的架构落地

以下为完整平台阶段的技术方向，作为 v2 调研结论在平台架构上的落地预案：

- **Worker 概念**：每个任务组在 Worker 节点内运行一个 opencode 实例（v2 演进为 Location 级），任务组隔离由 Worker 节点承载。agent 变更只重启对应任务组的实例，不触碰其他任务组，呼应 v2 的粒度热重载能力。本节描述的是单机形态下的落地；完整形态见第 11 章分布式 Worker 架构。
- **agent 创建**：通过 v2 插件 API（`ctx.agent.transform` / `State.Transformable`）注册自定义 agent（产品经理、架构师、开发者、测试等角色）。这是补足 v1"缺少 agent 创建接口"问题的官方路径，平台不再需要自造 agent 注册机制。
- **多任务组 = 多 Location 图**：Session 绑定创建时的 Location，不能靠传 path 偷换上下文。平台每个任务组拥有独立的 Location 图，天然形成任务间上下文隔离。
- **消息模型**：基于 v2 的 Part 类型（共 12 种），叠加平台三层错误模型（工具级、消息级 8 种、重试级），与 03 篇 FR-10（消息模型）/ FR-21（错误反馈）定义对齐。

## 6. v2 生态可用性（2026-08 实测）

| 包 | 版本 | 可用性 |
|----|------|--------|
| `@opencode-ai/cli`（beta tag） | `0.0.0-beta-202608060524` | 可用，官方每日发布 |
| `@opencode-ai/sdk-next` | 未公开发布 | 短期以 server API 直连或源码构建替代 |
| `@opencode-ai/sdk`（v1） | `1.18.14` | 仍可用，作为迁移期兜底 |

结论：v2 的 server 与 cli 已可实测，SDK 封装层尚未发布正式包。平台落地初期以 v2 server API 直连为主，SDK 包发布后再切换到封装层。

## 7. 定期同步策略

| 动作 | 频率 | 说明 |
|------|------|------|
| 跟踪 `@opencode-ai/cli` beta 每日发布 | 每日 | 关注版本号与 release notes |
| 跟进 V2 Schema Changelog | 随发布 | 识别契约变更（端点、字段、类型） |
| 跟进 `specs/v2/` 目录 | 随发布 | 以官方 spec 为契约事实来源 |
| 锁版本 | 每次基线升级 | 每次升级锁定已验证版本号，记录于本文档 |
| 契约变更时更新本文档与 SDK 封装层 | 随契约变更 | 本文档保持与技术基线同步，封装层按新契约适配 |

## 8. 风险与缓解

| 风险 | 说明 | 缓解 |
|------|------|------|
| beta 数据可被 wipe | beta 阶段官方可能清理存储数据，本地数据不承诺持久 | 平台核心数据（任务、消息、产出物）存平台侧数据库，opencode2 实例仅作工作引擎，可随时重建 |
| API 契约未冻结 | v2 尚未发布正式版，接口可能继续变化 | 锁版本号，升级走评审；SDK 封装层集中隔离契约变化 |
| Desktop 仍捆绑 v1 server | 桌面端当前仍带 v1，v2 主要面向 serve / SDK 场景 | 平台不依赖桌面端，以 v2 server 为唯一工作引擎 |
| sharing / cluster 未实现 | v2 的多用户共享与集群能力尚未落地 | 平台自身承担多任务组调度与隔离，不依赖 v2 共享能力 |

## 9. OpenCodeDriver 抽象层（落地路径）

本章是第 5 章「平台基于 v2 的架构落地」的落地化修订。基于 2026-08-06 的 v1 SDK 实测结论（第 6 章），平台现阶段以 v1 起步、架构按 v2 演进方向设计，通过 OpenCodeDriver 抽象层将 opencode 的版本差异收敛在一个封装层内，v2 稳定后只换 driver 即可平滑迁移。

### 9.1 决策：v1 起步，v2 就绪

> 分布式语境修正：OpenCodeDriver 的落地实现（V1Driver/V2Driver）位于 **worker 节点内部**（即 11.6 的 WorkerRuntime），控制面只通过 Worker HTTP 接口远程调用，**平台进程从不直接起 opencode 进程，也不直连 opencode**。本章接口定义与迁移路径不变——它正是 WorkerRuntime 对外暴露的 HTTP 语义，控制面感知不到底层是 v1 还是 v2。

**平台现阶段基于 v1 SDK（`@opencode-ai/sdk` 1.x）起步，架构上按 v2 演进方向设计；v2 稳定后通过替换 driver 平滑迁移。**

- v1 SDK 已实测可用（见 9.6），不阻塞平台开发；v2 的 SDK 封装包（`@opencode-ai/sdk-next`）尚未公开发布（第 6 章），现阶段直接依赖 v2 将引入未冻结契约。
- 该决策不推翻第 1 章的「基于 v2」方向，而是把 v2 落地时点从「开发基线」调整为「迁移目标」：平台开发期间持续跟踪 v2 契约（第 7 章同步策略不变），v2 正式可用后一次性切换。
- 版本差异被 OpenCodeDriver 封装层隔离，业务层（任务、群聊、产出物、状态机，见 03 篇 FR-xx 与 04 篇）感知不到底层是 v1 还是 v2。

### 9.2 Driver 接口

> 分布式语境修正：以下接口定义在分布式架构下原样保留，作为 Worker 节点对外暴露的 HTTP 语义（服务端→worker 的 `/instances`、`/sessions`、`/prompt`、`/abort`、`/models` 调用与 worker→服务端的 SSE 事件流，见 11.3）。接口的落地实现（V1Driver/V2Driver）在 **worker 节点内部**；分布式形态下控制面通过 Worker HTTP 接口远程调用，平台进程从不直接起 opencode 进程或直连 opencode，接口语义不变。

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

| 维度 | V1Driver（`@opencode-ai/sdk` 1.x，当前基线） | V2Driver（opencode2，迁移目标） |
|------|--------------------------------------------|-------------------------------|
| 路由前缀 | 路径无 `/api` 前缀 | 统一 `/api` 前缀 |
| 消息结构 | parts 数组结构 | `PromptInput{text, files, agents}` 替代 parts |
| 角色注入 | `resolveRole` 在 message body 传 `system` 字段注入角色提示词 | 插件 API `ctx.agent.transform` 注册自定义 agent + 会话 `switchAgent` |
| 会话作用域 | 全局会话，任务隔离靠平台侧按任务组管理 | location-scoped，Session 绑定创建时的 Location |
| 模型列表 | 分散在会话相关接口 | 独立 `GET /api/model` |
| 角色能力 | system 注入仅为提示词层，无独立 agent 生命周期 | 注册的 agent 可携带配置、工具、权限，运行时变更走 State.Transformable |

### 9.4 角色解析差异（关键）

`resolveRole` 的语义在两版实现中是「升级」而非「退化」：

| 版本 | resolveRole 落地方式 | 能力边界 |
|------|---------------------|---------|
| v1 | 发消息时在 body 传 `system` 字段，注入角色提示词（产品经理、架构师、开发者、测试等角色描述） | 角色仅为提示词层，平台侧仍需自行管理角色与工具、权限的关联 |
| v2 | 启动时通过插件 `ctx.agent.transform` 注册角色 agent，会话建立后 `switchAgent` 切换 | 角色是平台一等对象，可携带提示词、技能、工具与权限配置（对齐 04 篇 FR-33~36），运行时变更走官方机制 |

v1 是「提示词即角色」，v2 是「agent 即角色」。迁移时 resolveRole 由「拼 system 字符串」改为「启动时注册 + 会话内 switchAgent」，角色配置的载体从平台侧数据结构迁移到 opencode 侧 agent 定义，业务层调用不变。

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

### 9.7 迁移动作清单

v2 稳定后，迁移只动 V2Driver 一个实现，业务层零改动：

| 动作 | 说明 |
|------|------|
| 路径加 `/api` 前缀 | V2Driver 内统一拼接前缀，收敛路由差异 |
| body 改 `PromptInput` | `sendMessage` 从 parts 结构改为 `{text, files, agents}`，`mentions` 映射到 `agents` |
| `resolveRole` 改为插件注册 | 启动时 `ctx.agent.transform` 注册角色 agent，会话内 `switchAgent` 替换 system 注入 |
| 绑定 Location | `createSession` 按任务组绑定 `Location.Ref{directory, workspaceID}`，接续 9.5 隔离语义 |
| 模型列表切 `GET /api/model` | `listModels` 换端点 |

### 9.8 预计迁移工作量

- 封装层：新增 1 个 V2Driver 实现 + 角色注册机制调整（插件注册代码 + 角色到 agent 的映射表）。
- 业务层：任务、群聊、产出物、状态机（03/04 篇）零改动。
- 总量约为平台总代码的 **10-15%**，且集中在封装层与角色注册两点，可控可评审。

## 10. Worker 节点内部运行时（V1Runtime / V2Runtime）

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

v2 迁移的改动面被完整约束在 worker 节点内部，控制面零改动：

| 层 | v1 阶段 | v2 迁移 | 改动面 |
|----|---------|---------|--------|
| 控制面 | 注册表 / 调度器 / 生命周期 / 任务 / 群聊 / 归档 / Agent 配置 | 不变 | **零改动** |
| Worker 对外 HTTP 接口 | `/register`、`/instances`、`/sessions`、SSE 事件流 | 不变（协议层 v1/v2 无感知） | **零改动** |
| WorkerRuntime（worker 节点内部） | V1Runtime：spawn opencode 子进程（createOpencodeServer） | V2Runtime：`OpenCode.create()` Effect Scope + `ctx.agent.transform` 热更新 | **只动这里** |

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
│   V2Runtime：OpenCode.create() Effect Scope  │
│              + ctx.agent.transform 热更新     │
└──────────────────────────────────────────────┘
```

- **WorkerServer**：对外唯一入口，负责协议编解码（注册、实例、会话、消息、事件回传）。协议层 v1/v2 无差异，v2 迁移不改动。
- **WorkerRuntime**：抽象接口，对应第 9 章 OpenCodeDriver 的落地实现。V1Runtime 用 `createOpencodeServer` spawn 子进程（第 10 章），V2Runtime 用 `OpenCode.create()` 组装 Effect Scope 运行时、以 transform 热更新 agent/skill/tool。迁移只新增 V2Runtime 实现。
- **TaskGroupRegistry**：维护任务组（gid）与运行时实例的映射，供亲和性调度、销毁回收与重调度使用，是 11.4 生命周期管理的数据基础。

### 11.7 与既有决策呼应

| 既有决策（前文章节） | 分布式形态下的演进 |
|----------------------|-------------------|
| OpenCodeDriver 抽象层（第 9 章） | 演进为 Worker 节点内的 WorkerRuntime（11.6），Driver 接口语义原样保留并远程化为 11.3 的 HTTP/SSE 协议 |
| 每任务组一个 opencode 实例（第 5/9 章） | 每任务组在 Worker 节点内运行一个实例，TaskGroupRegistry 维护 gid→实例映射，隔离语义不变 |
| skill/tool 变更流程（10.3） | v1：节点内写文件 + 重启该任务组实例；v2：worker 内 `ctx.skill.transform` / `ctx.tool.transform` 热更新，无需重启 |
| v2 定期同步策略（第 7 章） | 只升级 worker 侧运行时（11.5），控制面无感；同步节奏与锁版本策略不变 |

分布式 Worker 架构是第 5 章「平台基于 v2 的架构落地」的完整形态：第 5/9/10 章的落地描述是它的退化特例（单节点部署：控制面与 worker 节点同主机，但仍通过 11.3 的 HTTP/SSE 语义通信，控制面不直连 opencode）。后续完整平台阶段以本章为架构基线，第 5/9/10 章对应演进为本章的子集。
