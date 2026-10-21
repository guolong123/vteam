# OpenCode v2 迁移逆分析：vteam 自研机制 vs v2 原生能力对照

> 计划：`.omo/plans/opencode-v2-adaptation.md`　分支：`feat/opencode-v2-adaptation`　日期：2026-10-20
> 关联文档：`opencode-v2-spike-results.md`（T4/T5/T6 实测）· `opencode-v2-verification-report.md`（T21 三桶验证）· `opencode-v2-contract-baseline/`（契约快照）· **`opencode-v2-hot-reload-evidence/`（热重载实测证据——§2.3 U-a 的闭环交付物）**

## 0. 这份文档回答什么

**问题**：vteam 为了在 OpenCode v1 的限制下把平台跑起来，**自己造了哪些机制**？OpenCode v2 现在**原生提供了哪些**？⇒ 哪些自研可以退役，哪些必须留。

**答法**：15 行逐条判定，每行给出 vteam 侧机制（带 `file:line`）、v2 侧对应物（带契约出处）、**判定**、**置信度**、以及**为什么**。

> ⚠️ **这不是全量盘点**。**明确未验证的部分见 §2.3**；**覆盖面与未覆盖面见 §7**。

> ⚠️ **行号是快照，不是锚点**。本文档所有 `file:line` 均为 **2026-10-20 的工作树快照**（基线 commit `b5a403e`）。撰写期间 `worker/src/exec/exec-server.ts` **正在被并行的热重载工作流改写**（该文件的行号已在本文档成稿前漂移过一次）⇒ **符号名才是耐久引用**（`runInFlightPrompt` / `onReconnect` / `PendingQuestionDetector` / `dedupKeyOf` …），行号只用于快速定位。若发现行号对不上，**以符号名 + 上下文为准**，并顺手修回本文档。

---

## 1. 证据分级（先读这一节，再读任何结论）

| 等级 | 含义 | 本文档里的标记 |
|---|---|---|
| **A** | **实机实测**：在真实 `opencode v2.0.28` 二进制上跑过（含隔离 `HOME`/`XDG_*`）；**热重载一组已在锁版 `2.0.32` 上复检**（§2.4） | ✅ 实测 |
| **B** | **读发布类型 / 官方文档**：对**已发布**的 `@opencode/*@2.0.32` 类型定义或 v2 官方文档求证 | 📄 发布类型/文档 |
| **C** | **读 vteam 源码**：`file:line` 逐条核对 | 🔍 源码 |
| **D** | **未验证**：推断或待实测 | ⚠️ 未验证 |

**判定词表**（每个判定 = 一个动作结论，不是一个"像不像"）：

| 判定 | 含义 | 处置 |
|---|---|---|
| **redundant** | v2 原生能力**完全覆盖**了自研机制 | 可以退役（注意 §6.1 跨进程陷阱） |
| **partially-redundant** | v2 覆盖了**一部分**（"何时做"被覆盖，"做什么"还要自己写） | 只能收窄，不能删 |
| **different-scope** | 两边**解决的不是同一个问题**（维度/消费者/生命周期不同） | 保留；不要试图用 v2 顶替 |
| **still-needed** | v2 **没有**对应物（甚至把 v1 的能力**删了**） | 必须保留 |

**置信度**（high / medium）与证据等级**是两个轴**：一条 high 置信度结论也可能只是 📄 读发布类型得出的（发布类型 = 契约事实，等级高）。

### 1.1 契约基线的版本口径（**每次读契约前必须知道**）

- `docs/agent-platform/opencode-v2-contract-baseline/openapi.json`（**118 paths / 142 ops / 285 schemas**）**由本机 `opencode v2.0.28` 生成**，**不是** worker 镜像锁定的 `@opencode/cli@2.0.32`——它是**契约形态快照**（OpenAPI shape 捕获），**该重跑**（§6.6）。
- `docs/agent-platform/opencode-v2-hot-reload-evidence/`（热重载实测证据，**§2.3 U-a 的闭环交付物**）的**行为**证据**已由锁版 `2.0.32` 产出**（2026-10-21 复检完成，§2.4）——复检覆盖的路径上**未发现行为差异** ⇒ **行为**口径上它**就是**锁版版本的证据；**契约形态**口径上仍以 2.0.28 的快照为准（上一条）。
  ⇒ 两者是**不同性质的产物**（形态快照 vs 行为证据），**"锁版即锁证据"只对前者成立**。
- `@opencode/*@2.0.32` 的**发布类型**已单独核对（📄）——本文档凡标 📄 的都基于它。
- ⚠️ **`GET /api/model` 在 2.0.28 与 2.0.32 形态一致**（都是 `{location, data}`；2.0.32 见 `@opencode/client@2.0.32` 的 `ModelListOutput = { location: LocationPublicRef; data: Array<ModelInfo> }`）⇒ **代码里"容忍裸数组"是防御性的，不是已知版本漂移**。

### 1.2 事件耐久度速查（决定"哪个事件能驱动状态判定"）

| 类别 | 事件（本文档关心的部分） |
|---|---|
| **durable**（带 `durable:{aggregateID,seq,version}`，可作幂等键、可重放） | `session.execution.started/failed/succeeded/interrupted` · `session.inbox.enqueued/delivered/cancelled/delivery.changed` · `session.tool.called/success/failed` · `session.compaction.started/ended/failed` · `session.permissions` · `session.agent.selected` · `session.shell.started/ended` · `session.text.started/ended` · `session.step.*` |
| **ephemeral**（**不可重放、不得用于状态判定**） | `mcp.status.changed` · `mcp.tools.changed` · `permission.asked/replied` · `form.created/replied/cancelled` · `session.usage.updated` · `session.text.delta` · `session.reasoning.delta` · `session.idle` · `session.status` · `model.updated` · `models-dev.refreshed` · `config.updated` · `agent.updated` · `skill.updated` · `credential.updated/switched` · `session.compacted` · `session.tool.progress` |

> 📄 出处：`@opencode/schema@2.0.32` 的 `dist/event-manifest.d.ts`（共 104 个事件，44 durable / 60 ephemeral）。
> ⇒ **vteam 铁律「只有 durable 事件能驱动状态判定」与 v2 契约完全吻合**——这是本次分析里少见的、vteam 早就走对的地方。

---

## 2. 结论速览

### 2.1 判定分布

| 判定 | 条数 | 行 |
|---|---|---|
| **redundant** | 3 | R1 · R4 · R11 |
| **partially-redundant** | 6 | R2 · R5 · R6 · R7 · R10 · R15 |
| **different-scope** | 4 | R3 · R9 · R13 · R14 |
| **still-needed** | 2 | R8 · R12 |

### 2.2 一页纸对照表

| id | vteam 自研机制 | v2 原生对应物 | 判定 | 置信度 | 证据 | 详见 |
|---|---|---|---|---|---|---|
| **R1** | 在飞提示注入 / steer 投递 | `delivery:"steer"` + durable inbox | **redundant** | high | 🔍 + 📄 | §3.1 |
| **R2** | MCP 状态轮询探针（30s 节流） | `mcp.status.changed` 事件 | **partially-redundant** | high | 🔍 + 📄 | §3.2 |
| **R3** | 凭据写文件注入（provider 段 `settings.apiKey`） | `POST /api/credential`（SQLite `credential` 表，**integration 维度**） | **different-scope** | high | 🔍 + ✅ + 📄 | §3.3 |
| **R4** | 「改配置 → 重启 serve」编排 | 自动文件热重载 + `POST /api/location/reload` | **redundant** | high | 🔍 + ✅ + 📄 | §3.4 |
| **R5** | 事件去重（内存 TTL map + 环形缓冲） | durable 身份 `upstream:<aggregateId>:<seq>` | **partially-redundant** | medium | 🔍 + ✅ | §3.5 |
| **R6** | 断流后状态重同步 | `GET /api/experimental/session/{id}/log?after=&follow=` | **partially-redundant** | medium | 🔍 + 📄 | §3.6 |
| **R7** | 模型目录同步 | `GET /api/model` + `model.updated` 事件 | **partially-redundant** | high | 🔍 + 📄 | §3.7 |
| **R8** | 计划步骤（`plan_tasks` + `vteam_todo` MCP） | **v2 删掉了 todo** | **still-needed** | high | 🔍 + ✅ | §3.8 |
| **R9** | 权限矩阵（`ROLE_BOUNDARIES` + 服务端闸门） | `permissions[]` 引擎层规则 + `ctx.permission.hook("evaluate")` | **different-scope** | high | 🔍 + 📄 | §3.9 |
| **R10** | agent/skill/tool 注册（文件注入 + DB 注册表） | `ctx.<domain>.transform` + `ctx.<domain>.reload()` | **partially-redundant** | high | 🔍 + 📄 | §3.10 |
| **R11** | 写 `auth.json`（legacy 凭据文件） | 无——**v2 实测不读它** | **redundant** | high | 🔍 + ✅ | §3.11 |
| **R12** | 平台 MCP（`vteam_*` 业务工具） | 通用 MCP 能力（无业务工具） | **still-needed** | high | 🔍 + 📄 | §3.12 |
| **R13** | realtime SSE（浏览器 ↔ NestJS） | `GET /api/event`（serve ↔ worker 总线） | **different-scope** | high | 🔍 + ✅ | §3.13 |
| **R14** | 用量账（`model_usage` 落库） | `session.usage.updated`（会话维度瞬时值） | **different-scope** | medium | 🔍 + 📄 | §3.14 |
| **R15** | question/permission pending 检测（轮询） | `form.created` / `permission.asked` 事件 | **partially-redundant** | medium | 🔍 + 📄 | §3.15 |

**证据列读法**：`🔍` = 读 vteam 源码（每行都带 `file:line`）· `✅` = 实机实测（真 `opencode v2.0.28`；**热重载一组 = 锁版 `2.0.32` 复检后**，见 §2.4）· `📄` = 读发布类型 / 官方文档 / 契约快照。
⇒ **每一行都至少有"读代码"这一半**——判定的前提是"vteam 侧机制确实长这样"；"v2 侧有对应物"才有实测 / 发布类型支撑。

### 2.3 明确**未验证**的部分（不要把本文档当已完成的证明）

| # | 未验证项 | 涉及 | 影响 |
|---|---|---|---|
| **U-a** | ✅ **已闭环（证据已入库）**——**自动文件热重载的原始证据**现在在仓库里：`docs/agent-platform/opencode-v2-hot-reload-evidence/`（12 份逐条原始输出 + `README.md` + 可复现的 `repro.mjs` / `repro-deferred.mjs`）。**实测版本 = 2.0.28，锁版 `2.0.32` 的复检已完成**（§2.4）。覆盖：`agents.<name>.system` 改文件即生效（**无任何触发调用**）· `mcp.servers.<name>` · `.opencode/skills/<name>/SKILL.md` · `.opencode/plugins/<f>.ts` 新增与**原地编辑（`setup()` 重入——注入器依赖的那一行）** · 隔离全局配置的 provider 段 · `POST /api/location/reload`（**204 / serve PID 不变 / 会话存活 / 重建异步**）· **pending form + permission 被 reload 取消**（**所有 location**）· **对照组：没有 reload 时 pending 存活** · **文件监听路径保留 pending** · **不需要任何 `watcher` 开关** | R4 / §5.1 🥇 | **证据已入库**；实施热重载时直接引用该目录（不再依赖调查轮的现场记录）。**残余已清**：锁版 **2.0.32** 的复检**已完成**（§2.4）——清单里最关键的两条**都成立**：「`location/reload` **仍取消** pending form 与 permission」与「**原地编辑插件 → `setup()` 重入**」（marker 计数 1→2，**入库那轮 305 ms**；2.0.32 **3 轮实测区间 205 ~ 305 ms**）⇒ **闸门策略与 settle 窗口都不必改** |
| **U-c** | **`POST /api/credential` 的 integration 维度只验到"存得进、读得回、且不覆盖 `settings.apiKey`"**——没有穷举 integration 的完整语义（哪些 provider 能建成 integration） | R3 | vteam 自配 baseUrl provider 的最终归属**尚未定**（继续走配置文件？把 provider 建成 integration？），见计划 §10 新增项 |
| **U-d** | **`GET /api/experimental/session/{id}/log` 的 `?after=<seq>` 能否真的补齐断线期间的 durable 事件**，**未在真 serve 上端到端验过**（只验了契约里的参数与返回形态） | R6 | T13 的补齐逻辑仍需活栈验证；计划 §10 Q14 的残余项 |
| **U-e** | **v2 的 form → vteam question 的形状映射有损在哪几个字段，未逐字段列过** | R15 | 事件快路的**完整性**未定 ⇒ 兜底轮询必须保留（已如此设计） |
| **U-f** | **`ctx.permission.hook("evaluate")` 在 vteam 场景下能不能真的承载跨进程业务闸门**，**未做原型** | R9 | 用它替代 vteam 权限矩阵 = **新增架构**，不是换个 API（§6.1） |
| **U-g** | **本文档的"收益"全部是定性判断**（消掉几个连锁成本），**没有任何基准测量** | §5 | 排序（🥇🥈🥉）可信，但"值多少"未量化 |

> ✅ **原 U-a′ 与 U-b 两条登记已关闭**（2026-10-21）：这两条登记的就是"**锁版 `2.0.32` 上的热重载复检**"本身——复检**已完成**，逐条结果见 **§2.4**。⇒ §2.3 里**仍然未验证**的只剩 **U-c ~ U-g**（U-a 保留在表内作闭环记录）。

### 2.4 锁版 `2.0.32` 上的热重载复检（**已完成**，2026-10-21）

> **本节取代**原 §2.3 的 **U-a′**（"2.0.32 上的复检尚未做"）与 **U-b**（"`location/reload` 在 2.0.32 的行为细节未验"）两条登记。
> 复检清单 = `docs/agent-platform/opencode-v2-hot-reload-evidence/README.md` §5；**原始证据在该目录**（**已由锁版 `2.0.32` 产出**）。
> 复检前的证据来自 **2.0.28** ⇒ 下表是**两个版本逐条比对**的结果。
>
> **⏱ 数字口径（必读，否则容易把最坏值当成测量值）**：2.0.32 上这个探针**连跑了 3 轮** `repro.mjs`（UTC 04:29 前后 / 04:47~04:48 / **04:51~04:52**），**行为断言逐条一致、只有耗时不同**；证据目录**只保留"入库那一轮"**（04:51~04:52，产物即该目录 01~11 号），另两轮的原始输出**不入库** ⇒
> - 本节写的**"入库那轮"** = **能在入库产物（01~11 号）里逐条查到的那个数**；
> - 本节写的**"3 轮实测区间" / "多轮最坏"** = 三轮里的区间与最坏值（**区间、逐轮值与"哪一轮入库"见证据目录 `README.md` §5.3 / §5.4**）。
> ⇒ **余量结论一律按最坏值算**（单轮数字不能用来下结论），但**引用的实测值必须能在入库产物里查到**。

| # | 复检项（对应清单 §5 条目） | `2.0.32` 实测结果 | 与 `2.0.28` 的差异 | 结论 |
|---|---|---|---|---|
| **1** | **`location/reload` 的取消语义** | **仍然取消** pending form 与 pending permission | 无 | ⇒ `deferred` 闸门分支**仍有存在理由**，**闸门策略不变** |
| **2** | **是否仍在所有 location 上取消** | **是**（默认 location + 任务子目录各验一套） | 无 | ⇒ **location 作用域 vs per-session 的不对称仍成立**（`GET /api/form` 查不到子目录会话的待答复项，而 `GET /api/session/{id}/form` 查得到）⇒ 平台的**逐会话** pending 探针**仍然必要** |
| **3** | **重载后的重建滞后** | 新值 **+223 ms** 才可见（**3 轮实测区间 98 ~ 376 ms ⇒ 多轮最坏 +376 ms**）；紧跟 204 的那一次读**仍读到旧快照**（**入库那轮 +62 ms**，**多轮最坏 +137 ms**） | **放大约 3×**（2.0.28：+123 ms / +24 ms ⇒ 2.0.32 **多轮最坏** +376 ms / +137 ms） | ⇒ 仍在 **2000 ms** settle 窗口内（`worker/src/reload/config-reloader.ts` 的 `DEFAULT_SETTLE_MS`），**余量约 5.3×**（按**多轮最坏 376 ms** 算）⇒ **窗口不必重估** |
| **4** | **六条文件监听行**（agent `system` 改文件 / `mcp.servers` / skill 文件 / plugin 新增 / **plugin 原地编辑** / 有 pending 时改配置） | **六条全部与 2.0.28 一致** | 无 | ⇒ 注入器真正依赖的那一行（**原地编辑插件文件（无 unlink/rename）→ `setup()` 重入**）**仍成立**：marker 计数 **1→2**，**入库那轮 305 ms**（2.0.28：205 ms；2.0.32 **3 轮实测区间 205 ~ 305 ms**） |
| **5** | **`deferred` 分支端到端**（真实 `2.0.32` 栈） | 有 pending form **且** permission 在飞时，worker 的 `POST /config/reload` 返回 `{"reload":"deferred"}`；**四个 pending id 全部原样存活**；配置变更**之后仍然生效**（走 opencode 的文件监听路径，经 opencode API 读回） | 无 | ⇒ 闸门**不冗余**。**对照组**：答完四个 pending 后**同一端点**返回 `{"reload":"reloaded"}`（serve 日志显示完整 location 重建）；**再一组对照**：直接打 `POST /api/location/reload` ⇒ **pending 被取消**（204 → 两个列表都空） |
| **6** | （附带）**`settings.apiKey` 在 provider 响应里是否明文回显** | **仍然明文回显** | 无 | ⇒ 先前记录的结论（key **原样回显**，不只是"可见性"）**在锁版上成立** |

**其它延迟（相对 2000 ms settle 窗口）**：plugin 新增 → 首次 `setup()` 调用 **2.0.28 306 ms → 2.0.32 入库那轮 207 ms**（**3 轮实测区间 207 ~ 919 ms ⇒ 多轮最坏 919 ms**；余量 **6.4× → ≈2.2×**）· MCP server 出现 **211 → 入库那轮 219 ms**（3 轮实测区间 214 ~ 397 ms）· 隔离全局配置新增 provider **209 → 入库那轮 221 ms**（3 轮实测区间 221 ~ 373 ms）· reload 请求自身耗时 **2028 → 入库那轮 2216 ms**（3 轮实测区间 2126 ~ 2432 ms）。
⇒ **余量一律按最坏值算**（窗口仍然够用，最坏路径余量 ≈2.2×）；但 **plugin 路径的余量已从 6.4× 缩到 ≈2.2×** ⇒ **后续升级必须盯这一条**（若继续变慢，settle 窗口要重估）。

---

## 3. 逐行详述

### 3.1 R1 — 在飞提示注入 / steer 投递　**redundant**（high）

**vteam 侧（🔍 源码）**
- 分发守卫：`server/src/chat/worker-dispatcher.ts:2449-2455`（`busyInFlight` / `injectFlight`）——同一成员已有在飞执行时**不排队、不丢弃**，改走注入分支。
- 注入下发：`server/src/chat/worker-dispatcher.ts:2855-2856`（`...(injectFlight ? { inFlight: true } : {})`）。
- worker 侧轻路径：`worker/src/exec/exec-server.ts`——在飞分支 `if (payload.inFlight && payload.sessionId)` → 方法 `runInFlightPrompt` → 其内 `delivery: 'steer'`。⚠️ **该文件正在被并行工作流改写，行号会漂移——以符号名为准**。
- 驱动层：`worker/src/driver/v2-driver.ts:634`（`delivery: input.delivery ?? 'steer'`）；控制面 `server/src/workers/worker.client.ts:433-434`（**强制** steer，不依赖被驱动端默认值）。

**v2 侧（📄 契约）**
`POST /api/session/{id}/prompt` 带 `delivery:"steer" | "queue"`；`GET/PATCH/DELETE /api/session/{id}/inbox[/{inboxID}]`；durable 事件 `session.inbox.enqueued / delivered / cancelled / delivery.changed`（见 §1.2）。

**判定理由**
- vteam **迁移后已经直接用 v2 原生 `delivery:"steer"` + durable inbox**——这段"自研"实际上只剩**一条分发守卫**（决定"这次要不要插队"），**投递机制本身早已是 v2 原生的**。
- **vteam 没有自研提示队列**：FIFO 任务队列早已随 `parallel-tasks-and-task-tab` 计划退役（该计划 D2：`queued` 状态退役、不再产生；D3：**排队端点与排队代码路径删除**，`team_queues` 表**保留为空壳**、迁移只清数据——见 `server/prisma/schema.prisma:214-226`）。
- ⇒ 可退役的是**残留的"自研感"**（把 steer 当自研机制维护），不是代码本身。

**⚠️ 勿误退役**：守卫的**语义**（"同成员同时只允许一次在飞执行"）是 vteam 的**业务约束**，v2 没有对应物 ⇒ 守卫逻辑**要留**，只是它下游的投递已经原生了。

### 3.2 R2 — MCP 状态轮询探针　**partially-redundant**（high）

**vteam 侧（🔍 源码）**：`worker/src/mcp-status/mcp-status-probe.ts`
- 数据源 `GET /api/mcp`（`worker/src/mcp-status/mcp-status-probe.ts:11`）、30s 节流（同文件 `:122-123` 选项、`:294` 默认 `30_000`、`:395` 节流判断）、探测结局 `ok | probe_failed`（同文件 `:56`）。

**v2 侧（📄 发布类型）**
- 事件：`mcp.status.changed` / `mcp.tools.changed` / `mcp.resources.changed`（📄 `@opencode/schema@2.0.32` 事件清单）+ `mcp.prompts.changed`（📄 `@opencode/core@2.0.32` 的 MCP 模块，**未**出现在 schema 的事件清单里）。
- 端点：`GET /api/mcp`、`PUT/DELETE /api/experimental/mcp/{server}`、`POST /api/experimental/mcp/{server}/connect|disconnect`。

**判定理由**
- v2 的 `mcp.status.changed` 事件**载荷只有 `{ server: string }`**——**只有 server 名，没有状态**（📄 `@opencode/schema@2.0.32` `event-manifest.d.ts`：`data: Schema.Struct<{ readonly server: Schema.String }>`）。
- ⇒ 事件能替掉"**何时查**"，**替不掉"查什么"**：收到事件仍要回查一次 `GET /api/mcp` 才知道状态是 `connected` 还是 `failed`。
- ⇒ 探针**本体不能删**；能收窄的是**轮询频率**（事件到达时立刻查一次，平时退到兜底周期）。

**⚠️ 两条硬约束**
1. **`probe_failed` 语义必须保留**——"探针坏了"**绝不能**上报成"这个 worker 没接 MCP"（`worker/src/mcp-status/mcp-status-probe.ts:50-55` 已有明文约定）。
2. **五态线契约两端双写**（`server/src/mcp-servers/dto/mcp-status.dto.ts:20-26` 的 `MCP_STATUS` + `@IsIn` ↔ `worker/src/protocol/worker-protocol.ts:95-100` 的 `McpServerStatus`）——不同步 ⇒ **整个心跳 400** ⇒ worker 被判离线 ⇒ **必须先 server 后 worker**。

### 3.3 R3 — 凭据写文件注入　**different-scope**（high）

**vteam 侧（🔍 源码）**：`worker/src/credentials/model-credential-injector.ts:342`——provider 段 `settings: apiKey ? { baseURL: baseUrl, apiKey } : { baseURL: baseUrl }`（v2 真正会读的那一处，`worker/src/credentials/model-credential-injector.ts:295-301` 有实测结论）。

**v2 侧**
- 端点（📄 契约）：`GET/POST /api/credential`、`PATCH/DELETE /api/credential/{credentialID}`、`POST /api/credential/{credentialID}/activate`；CLI `opencode auth login|list|export|import|switch`。
- 存储（📄 发布类型）：SQLite `credential` 表，**以 `integrationID` 为键**（`@opencode/schema@2.0.32` `credential.d.ts`：`readonly integrationID: Schema.brand<Schema.String, "Integration.ID">`）。
- 实测（✅）：`POST /api/credential` **存得进去、读得回来**。

**判定理由**
- v2 凭据表是 **integration 维度**；vteam 自配 baseUrl provider 的 key 落在**配置文件的 provider 段 `settings.apiKey`**。
- 实测结论：**凭据表不覆盖 provider 段的 `settings.apiKey`** ⇒ vteam 自配 provider **仍必须走配置文件**。
- ⇒ **不是"v2 提供了、vteam 重复造了"**，而是**两个不同维度的东西**：v2 管的是"某个已登记 integration 的账号凭据"，vteam 管的是"一个自配 baseUrl + 模型的 API key"。

**⚠️ 别顺手改**：把 provider 段改成 `POST /api/credential` 会**直接让模型没有凭据**（`worker/src/credentials/model-credential-injector.ts:14-20` 已写明 v2.0.28 实测：legacy `auth.json` 导入是 no-op、凭据表始终为空、模型请求不带 `Authorization` 头；`settings.apiKey` 才可用）。

### 3.4 R4 — 「改配置 → 重启 serve」编排　**redundant**（high，✅ 实测）｜**实施中**

**vteam 侧（🔍 源码）**
- `worker/src/restart/restart-coordinator.ts`（全文 ~110 行）：`requestRestart()`（`worker/src/restart/restart-coordinator.ts:61-75`，有活跃会话 → 挂起等归零）、`checkPending()`（同文件 `:78-83`）、`performRestart()`（同文件 `:85-108`，stop+start + `reRegister`）。
- 三个触发点：`worker/src/index.ts:1136-1141`（`reload-config`）、`worker/src/index.ts:381-384`（`model-credentials`）、`worker/src/index.ts:1225-1230`（运维 `restart` 命令）。

**v2 侧**
- ✅ **实测（2.0.28；锁版 `2.0.32` 已复检，覆盖路径上无行为差异——§2.4）**：**自动文件热重载**——`agents` / `mcp.servers` / `skills` / `plugins` / 隔离域全局配置，**改文件即生效，serve PID 不变**。
  **证据已入库**：`docs/agent-platform/opencode-v2-hot-reload-evidence/`（12 份原始输出 + `repro.mjs` / `repro-deferred.mjs`，可一键复现；§2.3 U-a 已闭环，锁版 `2.0.32` 复检见 §2.4）。
- 📄 **契约**：`POST /api/location/reload` → `204`；OpenAPI 描述原文：*"Shut down and rebuild every loaded location. **Pending permissions and forms are cancelled**; running sessions continue with fresh services at the next step boundary. Emits `location.shutdown` for client recovery…"*。
- 📄 **CLI**：`opencode reload`（⚠️ **作用域错配**——CLI 绑共享后台服务 49374，不是 worker 自己 spawn 的 serve，同 §2.9 的坑 ⇒ vteam 必须走 **HTTP 端点**）。

**判定理由**
- v2 已经能用**两条零重启路径**吃到配置变更：自动热重载（改文件）+ 显式 `location/reload`（重载全部 location）。⇒ "改配置必须重启 serve" 这个**自研机制的前提没了**。
- 收益（消掉三个连锁成本）：**端口漂移 → 要 re-registration**（`worker/src/restart/restart-coordinator.ts:96-100`）、**活跃会话必须排空 → 变更延迟不可控**、**重启窗口内 serve 不可用**。

**当前状态：✅ 已确证，🚧 实施中**（另一条并行工作正在落地；**本文档不把它写成已完成**）。
**证据**：`docs/agent-platform/opencode-v2-hot-reload-evidence/`（2.0.28 实测 + **锁版 `2.0.32` 复检**，§2.4；逐条原始输出 + 复现脚本）。

**三条实施约束**
- **(a) 必须条件调用**：`location/reload` 会 **cancel pending 的 permission 与 form**（OpenAPI 描述如此）⇒ 有 pending 时**降级走文件监听**并**明确日志**。
  ⚠️ **实测还多两条**（`opencode-v2-hot-reload-evidence/` 的 07/08，**锁版 `2.0.32` 复检后仍成立**——§2.4 第 2/3 条）：
  ① **`GET /api/form` / `GET /api/permission/request` 是 location 作用域的**——会话被 move 到任务目录后，默认 location 的查询**查不到**它的待答复项，而 `location/reload` 取消的是**所有 location** ⇒ 闸门必须**逐会话**查，**绝不能**用全局端点；
  ② **重载后的重建是异步的**（2.0.28：新值 **+123 ms** 才可见、紧跟 204 的单次校验读会读到旧快照（+24 ms）；**锁版 `2.0.32` 复检：入库那轮 +223 ms / +62 ms（3 轮实测区间 98 ~ 376 ms、**多轮最坏 +376 ms / +137 ms**）**，仍在这个量级内）⇒ 效果确认必须走**有界 settle 窗口**（**2000 ms**，`worker/src/reload/config-reloader.ts` 的 `DEFAULT_SETTLE_MS`；2.0.32 下**余量约 5.3×** ⇒ **窗口不必重估**），否则会误判"未生效"并触发**不必要的真实重启**。
- **(b) 版本已复检（2026-10-21）**：复检在**锁版 `2.0.32`** 上完成（§2.4）——`location/reload` **仍取消** pending、**仍在所有 location 上取消**、重建滞后 **入库那轮 +223 ms（3 轮最坏 +376 ms）**（仍在 2000 ms 窗口内）、六条文件监听行**逐条一致** ⇒ **闸门策略与 settle 窗口都不必改**。
  ⚠️ **唯一要盯的**：**plugin 路径**的生效延迟从 **2.0.28 的 306 ms 涨到 2.0.32 的 3 轮最坏 919 ms**（**入库那轮只有 207 ms ⇒ 轮间抖动 3~4 倍**；settle 窗口余量 **6.4× → ≈2.2×**）⇒ **后续版本升级要重新量这一条**。
- **(c) 真重启能力必须保留**：运维 `RESTART`、worker 自更新、serve 崩溃恢复、`/config/restart` 都要真重启 ⇒ `RestartCoordinator` **收窄为运维/升级专用**，**不是删除**。

### 3.5 R5 — 事件去重　**partially-redundant**（medium）

**vteam 侧（🔍 源码）**：`server/src/workers/worker-event.ingress.ts`
- 幂等键唯一构造点 `dedupKeyOf()`（`server/src/workers/worker-event.ingress.ts:235-248`）：durable → `upstream:<aggregateId>:<seq>`；ephemeral 带 ordinal → `upstream:<eventId>:<ordinal>`；其余 → `worker:<workerId>:<eventId>`。
- 去重表 `seen: Map` + `order: string[]` 环形缓冲（`server/src/workers/worker-event.ingress.ts:359-361`）；判重入口同文件 `:467-471`。

**v2 侧**：事件自带 durable 身份 `durable:{aggregateID, seq, version}`（📄 契约 + ✅ 实测帧，见契约基线 `sse-sample.txt`）。

**判定理由**
- **键**已经改用 v2 的 durable 身份 ⇒ **跨 worker 重启**的重投仍判重（这一半已被 v2 覆盖）。
- **表**仍需：server 是**独立进程**，它必须自己记"这条我处理过了"（v2 只保证事件有身份，不保证消费方幂等）。

**已知缺口（必须写进台账）**：**server 重启后去重状态全丢**（纯内存；`server/src/workers/worker-event.ingress.ts:342-347` 与 `:355-358` 已明文记录）——修它要 **DDL**（DB 唯一索引），与本阶段"零 DDL"铁律冲突 ⇒ **是已知限制，不是待修缺陷**。

### 3.6 R6 — 断流后状态重同步　**partially-redundant**（medium）

**vteam 侧（🔍 源码）**
- `worker/src/exec/exec-server.ts` 的 `onReconnect` 回调（清增量缓冲 → 拉消息快照重建 → 补发 part）。⚠️ **该文件正在被并行工作流改写，行号会漂移——以符号名为准**。
- `worker/src/driver/serve-event-stream.ts:51`（`onReconnect` 选项）、`worker/src/driver/serve-event-stream.ts:275-278`（重连后调用，**等它做完再派发新帧**）。

**v2 侧**：`GET /api/experimental/session/{sessionID}/log?after=<seq>&follow=<true|false>`（📄 契约：`after` 是 `Event.SeqEncoded`，`follow` 是 `"true"|"false"`，`200` 返回 `text/event-stream`，元素 `SessionLogItemEncoded`）——**按聚合的 durable 事件日志，可重放**。

**判定理由（三个"仍然要自己写"）**
1. 端点在 **`/api/experimental/**`** ⇒ 显式不稳定（§6.4）。
2. log 是**事件流**，**不是消息快照** ⇒ 重建逻辑仍要写（vteam 要的是"消息快照"语义）。
3. 现有**轮询路同时**承担**首字超时 / 活性顺延 / 在途工具豁免 / 总超时**（`worker/src/exec/exec-server.ts` 的 `sendAndAwait` 调用处传 `firstTokenTimeoutMs` / `totalTimeoutMs` / `pollMs`）——**它不是只为重同步而存在的**，删不掉。

### 3.7 R7 — 模型目录同步　**partially-redundant**（high）

**vteam 侧（🔍 源码）**
- `server/src/models/models.service.ts:749-753`（`syncLiveModels`）；真值优先级注释 `server/src/models/models.service.ts:734-748`（**worker 上报的 `capabilities.executableModels` 是唯一真值源**）。
- worker 上报：`worker/src/index.ts:972-983`（`resolveExecutableModels(() => driver.listModels())` → `executableModels`）；协议字段 `worker/src/protocol/worker-protocol.ts:52`。

**v2 侧**：`GET /api/model`（📄 契约；形态 `{location, data}`，2.0.28/2.0.32 一致）+ `model.updated` 事件（ephemeral）。

**判定理由**
- 事件能替掉"**何时拉**"。
- 但 vteam 的 **DB 目录**与**可见性权威**（`Model.enabled` / `workerModelAvailability` / 剪枝 / 授可见性）是**业务资产**：v2 只回答"这个 location 现在有哪些模型"，**不回答"这个团队/这个 agent 能不能看见它"**。
- ⇒ 目录**同步动作**可以事件化，**目录本体**必须留在 vteam。

### 3.8 R8 — 计划步骤　**still-needed**（high）

**vteam 侧（🔍 源码）**
- `server/src/tasks/plan-steps.service.ts:14-22`（头注释写明"为什么不用 opencode todos"：todos 是**会话级**，换会话/重置即丢、跨成员与跨任务不可见、平台注入的工具清单里没有 todo 写入工具）。
- 表：`server/prisma/schema.prisma:983-984` + `server/prisma/schema.prisma:1031`（`plan_tasks`，`uk_plan_tasks_plan_seq` 唯一约束）。
- 写入口：`server/src/platform-mcp/platform-mcp.service.ts:5562-5566`（`vteam_todo` 薄委托到 `PlanStepsService`）；schema `server/src/platform-mcp/platform-mcp.tools.ts:594`（`vteamTodoSchema`）。

**v2 侧**：**v2 直接删掉了 todo 能力**——契约基线 **118 条 paths 中含 `todo` 的路径数 = 0**（✅ 逐条枚举）；v1 确有 `GET /session/{id}/todo`（见计划附录 A）。vteam 侧已优雅降级：`worker/src/driver/v2-driver.ts:917-926`（`listTodos` → 空数组 + 节流告警）。

**判定理由**
- v2 **不是"没提供"而是"删了"** ⇒ 不存在"等 v2 补上"的可能。
- 即使 v1 的 todos 还在，也是**会话级**（跨成员/跨任务不可见、重置即丢）⇒ **装不下** vteam 的"计划 Tab 步骤区"。
- ⇒ **vteam 的 `plan_tasks` + `vteam_todo` 是唯一承载**，**必须保留**。

### 3.9 R9 — 权限矩阵　**different-scope**（high）

**vteam 侧（🔍 源码）**
- 常量：`server/src/common/constants/agent.constants.ts:290`（`ROLE_BOUNDARIES`，含 `toolAllows` / `scopeSummary` / `mcpDenies`）。
- 服务端闸门：`server/src/platform-mcp/platform-tool-permission.service.ts:33`（`PlatformToolPermissionService`）。
- 投影到 v2：`worker/src/resources/injector.ts:476-486`（写出的 `permissions[]` **只覆盖控制面声明的动作**；v2 引擎层 `findLast` + 内置 catch-all allow ⇒ 未声明动作放行，平台已明确接受，07 篇 §3.2）、`worker/src/resources/injector.ts:686-700`（v1 `permission` 对象 → v2 `permissions[]` 翻译）。

**v2 侧**：`permissions[]` 有序规则数组（📄 契约 + 官方文档）；插件侧 `ctx.permission.hook("evaluate")`（📄 `@opencode/plugin@2.0.32` `permission.d.ts`：`PermissionEvaluation{ sessionID, agent?, action, resources, metadata?, source?, effect, message? }`）。

**判定理由**
- v2 的 `permissions[]` 是**引擎层**规则（同一个 opencode 进程内的工具放行判定）；vteam 的是**跨进程业务层**工具白名单（哪个岗位能调 `vteam_submit_artifact`、跨成员/跨任务的冒充防护）。
- `ctx.permission.hook("evaluate")` 在 **opencode 进程内** ⇒ 要用它覆盖 vteam 的 server 侧逻辑，**必须先有 worker 侧代理端点**（§6.1 跨进程陷阱）——这是**新增架构**，不是"换个 API"。

### 3.10 R10 — agent/skill/tool 注册　**partially-redundant**（high）

**vteam 侧（🔍 源码）**：`worker/src/resources/injector.ts`
- `ResourceInjector`（`worker/src/resources/injector.ts:291`）；`injectSkills()`（同文件 `:350`）、`injectTools()`（同文件 `:387`）、`injectMcp()`（同文件 `:452`）、`injectMcpAndAgents()`（同文件 `:531`）/ `applyMcpAndAgents()`（同文件 `:541`）——**文件注入 + DB 注册表**双轨。

**v2 侧（📄 发布类型，`@opencode/plugin@2.0.32`）**
- 七个域各有 `transform` + `reload`：`ctx.agent` / `ctx.tool` / `ctx.skill` / `ctx.model` / `ctx.provider` / `ctx.command` / `ctx.mcp`。
- 类型：`Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>`；`Registration.dispose: () => Promise<void>`（**`dispose()` 撤销那一次 transform**）。
- 编辑器形状：
  | 编辑器 | 方法 | 备注 |
  |---|---|---|
  | `ToolEditor` | `list` / `get` / `namespace` / `add` / `update` / `remove` | |
  | `AgentEditor` | `list` / `get` / `default` / `update` / `remove` | ⚠️ **没有 `add`** |
  | `SkillEditor` | `list` / `get` / `add` / `update` / `remove` | |
  | `ModelEditor` | `list` / `get` / `update` / `remove` / `default` / `provider` | |
  | `ProviderEditor` | `list` / `get` / `add` / `update` / `remove` / `models` | |
  | `CommandEditor` | `add` | |
  | `MCPEditor` | `list` / `get` / `set` / `update` / `remove` | |

**判定理由**
- "**如何**注册"已经原生（`transform` + `reload` + `dispose`）。
- "**注册什么**"仍以 vteam DB 为准（哪些 agent/skill/tool 对某个成员/团队可用，是业务事实）⇒ **注册表不能退役**。
- ⚠️ `AgentEditor` **没有 `add`** ⇒ **新造 agent 不能靠 transform**，只能靠配置文件 `agents.<name>`（这正是 vteam 现在注入的路子，也是它仍然成立的原因）。

### 3.11 R11 — 写 `auth.json`　**redundant**（high，✅ 实测）

**vteam 侧（🔍 源码）**
- `worker/src/credentials/model-credential-injector.ts:735-741`（`writeAuthJson`）、`worker/src/credentials/model-credential-injector.ts:760-770`（`cleanupAuthJson`——**只删 `auth.json` 这一个文件**，文件名不是 `auth.json` 直接跳过）。
- 生命周期：`worker/src/index.ts:361-370`（清旧 → 写新）、`worker/src/index.ts:1330-1338`（worker 退出时清理，明文 key 零留存）。

**v2 侧**：**v2 实测不读它**——`worker/src/credentials/model-credential-injector.ts:14-20` 已写死实测结论：v2 的凭据真值在 SQLite `credential` 表；其"一次性导入 legacy `auth.json`"的迁移在 **2.0.28 上是 no-op**（凭据表始终为空、模型请求不带 `Authorization` 头）。

**判定理由**
- "为 v1 兼容"是 `auth.json` **唯一**的保留理由，而 **v1 驱动已删**（`worker/src/index.ts:817-819`：`OPENCODE_V2_ENABLED=false` 现在**响亮抛错**，不再是"退回 v1"的代码级开关）⇒ **保留理由已失效**。
- ⇒ **停止写 `auth.json` 是安全的**（详见 §5.2 的 caveat 清单）。

### 3.12 R12 — 平台 MCP　**still-needed**（high）

**vteam 侧（🔍 源码）**：`server/src/platform-mcp/`（`platform-mcp.service.ts` / `platform-mcp.tools.ts` / `platform-mcp.controller.ts` / `platform-tool-permission.service.ts`）——`vteam_*` 业务工具族（`vteam_todo` / `vteam_task_create` / `vteam_submit_artifact` / 记忆族 / 团队族 …）。

**v2 侧**：v2 提供**通用 MCP 能力**（`GET /api/mcp`、`PUT/DELETE /api/experimental/mcp/{server}`、connect/disconnect、MCP 工具目录），**但不提供 vteam 的业务工具**。

**判定理由**
- v2 给的是**管道**（怎么挂一个 MCP server），vteam 要的是**内容**（挂什么工具、它们干什么、谁能调）。
- ⇒ **必须保留**。

### 3.13 R13 — realtime SSE　**different-scope**（high）

**vteam 侧（🔍 源码）**：`server/src/realtime/realtime.service.ts`
- 帧形态（`server/src/realtime/realtime.service.ts:28`）：**`{id, type, payload, timestamp}`**（`RealtimeEvent`，同文件 `:30`）。
- 服务（`server/src/realtime/realtime.service.ts:141` `RealtimeService`）、广播（同文件 `:249` `this.bus.emit('event', event)`）——**消费者是浏览器**。

**v2 侧**：`GET /api/event`（SSE）——**消费者是 worker**（serve ↔ worker 总线）；帧形态 **`{id, created, type, location?, data, durable?}`**（✅ 实测字节，见契约基线 `sse-sample.txt`）。

**判定理由**
- **消费者不同**（浏览器 vs worker）、**帧语义不同**（`payload` vs `data`；`timestamp` vs `created`）、**可靠性格不同**（vteam 的 SSE 有保留集与断线续拉语义；v2 的 `/api/event` 是 **volatile** 契约——慢消费者 overflow 会断流）。
- ⇒ **不能把 serve 的 SSE 直接转给浏览器**（帧形态与断线语义都不匹配）。

### 3.14 R14 — 用量账　**different-scope**（medium）

**vteam 侧（🔍 源码）**：`server/src/usage/usage.service.ts:89`（`UsageService`）、`server/prisma/schema.prisma:1293`（表 `model_usages`）——**成员 × 模型**的历史账。

**v2 侧**：`session.usage.updated` 事件（**ephemeral**，见 §1.2）——**会话维度的瞬时值**。

**判定理由**
- v2 给的是"**这个会话现在用了多少**"（瞬时、会被覆盖、丢了就没了）；vteam 要的是"**这个成员用这个模型花了多少、历史累计**"（可查、可聚合、可对账）。
- ⇒ **两个维度**，v2 顶不了。

### 3.15 R15 — question/permission pending 检测　**partially-redundant**（medium）

**vteam 侧（🔍 源码）**：`worker/src/exec/exec-server.ts` 的 `class PendingQuestionDetector`——挂在 `awaitCompletion` 的 `onPoll` 上做**旁路**轮询：调 `fetchPendingForms`（⇒ 驱动 `listQuestions`）与 `fetchPendingPermissions`（⇒ 驱动 `listPermissions`）；按任务隔离 + `requestId/permissionId` 去重。驱动实现 `worker/src/driver/v2-driver.ts:742`（`listQuestions`）/ `worker/src/driver/v2-driver.ts:801`（`listPermissions`）。⚠️ **该文件正在被并行工作流改写，行号会漂移——以符号名为准**。

**v2 侧**：`form.created` / `form.replied` / `form.cancelled`、`permission.asked` / `permission.replied`（**全是 ephemeral**）；端点 `GET/POST /api/session/{id}/form[/{formID}]`、`POST .../form/{formID}/reply`、`GET/POST /api/session/{id}/permission`、`POST .../permission/{requestID}/reply`（`decision: once|always|reject`）。

**判定理由**
- **可加事件快路**：`permission.asked` 载荷比轮询结果**更全**（含 `source` / `metadata`）⇒ 事件到达时不必再轮询。
- **但轮询不能删**：① 事件是 **ephemeral** ⇒ **会丢** ⇒ 必须有兜底；② **v2 form → vteam question 的形状映射有损**（v2 的 `form` 与 vteam 的 `question`（`header` / `prompt` / `choices` / `multiple`）不是同一形状）⇒ 事件快路拿不到完整问题，仍要回查。
- ⇒ **可以"事件快路 + 兜底轮询"，不能"删轮询"**。

---

## 4. 明确判定为 still-needed：请勿误退役

> 这一节是**反向护栏**。任何人拿着"v2 原生提供了 X"来砍 vteam 侧的东西，**先查这张表**。

| # | 机制 | 为什么不能退役 | 证据 |
|---|---|---|---|
| **R8** | 计划步骤（`plan_tasks` + `vteam_todo`） | **v2 直接删掉了 todo**（118 paths 中 0 条含 todo）；v1 的 todos 也不够用（会话级、跨成员不可见） | §3.8 |
| **R9** | 权限矩阵（`ROLE_BOUNDARIES` + 服务端闸门） | v2 `permissions[]` 是**引擎层**规则；vteam 的是**跨进程业务层**白名单 | §3.9 |
| **R12** | 平台 MCP（`vteam_*` 业务工具） | v2 只给通用 MCP 管道，不给业务工具 | §3.12 |
| **R13** | realtime SSE（浏览器 ↔ NestJS） | 消费者与帧语义都不同；v2 的 `/api/event` 是 volatile 总线 | §3.13 |
| **R14** | 用量账（`model_usage`） | v2 是会话维度瞬时值；vteam 要成员 × 模型历史账 | §3.14 |
| **R5** | 事件去重表 | 键已用 v2 durable 身份，但**消费方幂等**是 server 自己的事（server 是独立进程） | §3.5 |
| **R6** | 轮询路 | 轮询路**同时**承担首字超时 / 活性顺延 / 在途工具豁免 / 总超时 | §3.6 |

### 4.1 两条**极易被误认**的

| # | 东西 | 真相 |
|---|---|---|
| 1 | **FIFO 任务队列** | **早已退役**（`parallel-tasks-and-task-tab` 计划 D2/D3：`queued` 状态不再产生、排队端点与代码路径删除；`team_queues` 表**保留为空壳**、只清数据）。**不要重复退役一次**——它已经是历史，不是候选。 |
| 2 | **`worker-dispatcher` 的 `pending` / `pendingBySession` Map** | `server/src/chat/worker-dispatcher.ts:1540` / `:1543`——这两个 Map 是**看门狗 / 空闲判死账本**（事件静默滑动窗口重武装 + sessionId 反查），**不是提示队列**。⚠️ 名字像队列，语义不是。 |

---

## 5. 最值得退役的三件事

> 排序依据：**收益 × 安全**。收益 = 消掉的连锁成本；安全 = 会不会引入静默失败。

### 5.1 🥇 配置 / 凭据变更 → 热重载　（R4 + R3 的一半 + R11 的一半）

**要做什么**
1. `reload-config` / `model-credentials` 命令处理（`worker/src/index.ts:1136` / `worker/src/index.ts:381`）**先尝试热重载**，不再默认走重启。
2. 热重载路径：改文件 → 触发 v2 侧生效（自动热重载 ✅ 实测；必要时显式 `POST /api/location/reload`）。
3. `RestartCoordinator` **收窄为运维/升级专用**（保留 `RESTART` 命令、worker 自更新、serve 崩溃恢复、`/config/restart`）。

**收益（消掉三个连锁成本）**
- **端口漂移 → 要 re-registration**（`worker/src/restart/restart-coordinator.ts:96-100` 的 `reRegister`，失败时 server 报 degraded）。
- **活跃会话必须排空 → 变更延迟不可控**（`requestRestart` 挂起等会话归零）。
- **重启窗口内 serve 不可用**（stop+start 之间无服务）。

**caveat 清单**
- **(a)** `location/reload` **会 cancel pending 的 permission 与 form** ⇒ **必须条件调用**：有 pending 时降级走文件监听 + **明确日志**。
  ⚠️ 实测补充（`opencode-v2-hot-reload-evidence/` 的 08，**2.0.32 复检后仍成立**）：待答复项的**全局端点是 location 作用域的** ⇒ 闸门必须**逐会话**查；
  ⚠️ 实测补充（07，**2.0.32 复检后仍成立**）：重载后的重建**异步**（2.0.28 **+123 ms** / **2.0.32 入库那轮 +223 ms，3 轮最坏 +376 ms**）⇒ 效果确认要**有界 settle 窗口**（**2000 ms**，2.0.32 下余量约 5.3× ⇒ **不必重估**）。
- **(b)** **版本已复检（2026-10-21）**：锁版 `2.0.32` 上的复检**已完成**（§2.4）——**取消语义、全 location 取消、重建滞后、六条文件监听行、`deferred` 分支端到端、`settings.apiKey` 明文回显**六项**逐条复检通过，覆盖路径上**未发现行为差异** ⇒ **闸门策略与 settle 窗口都不必改**；**要盯的只有 plugin 路径**（生效延迟 **306 ms（2.0.28）→ 3 轮最坏 919 ms（2.0.32；入库那轮 207 ms）**，settle 窗口余量 **6.4× → ≈2.2×**）。
- **(c)** **真重启能力必须保留**（运维 `RESTART` / worker 自更新 / serve 崩溃恢复 / `/config/restart`）⇒ `RestartCoordinator` 收窄，**不是删除**。
- **(d)** **别顺手把 provider 段改成 `POST /api/credential`**——实测凭据表**不覆盖** provider 段的 `settings.apiKey`（§3.3；**2.0.32 复检：仍然明文回显**，§2.4 第 6 条）。

**当前状态：✅ 已确证，🚧 实施中**（本文档不写成已完成）。
**证据**：`docs/agent-platform/opencode-v2-hot-reload-evidence/`（2.0.28 实测 + **锁版 `2.0.32` 复检**，§2.4；12 份原始输出 + 复现脚本）。

### 5.2 🥈 停止写 `auth.json`　（R11）

**要做什么**：删掉 `writeAuthJson` 调用（`worker/src/index.ts:367`）与随之无用的 `cleanupAuthJson` 调用链（`worker/src/index.ts:365` / `worker/src/index.ts:1335`），**保留** `cleanupAuthJson` 函数本身（幂等清理存量文件 + D11 护栏）。

**收益**
- **明文 key 落盘面从 2 处减到 1 处**（只剩 provider 段 `settings.apiKey` 在配置文件里）。
- `cleanupAuthJson` 与"明文 key 零留存"整套逻辑消失（少一份易错代码）。

**caveat 清单**
- ⚠️ **D11 铁律**：`auth.json` 与 v2 会话库 `opencode.db` **同目录**（`<iso>/data/opencode/`）⇒ **只删文件逻辑，绝不能动"不删 data 目录"的保护**。`cleanupAuthJson` 现有的"文件名不是 `auth.json` 就跳过"护栏（`worker/src/credentials/model-credential-injector.ts:764-768`）**必须保留**。
- ⚠️ **别顺手把 provider 段改成 `POST /api/credential`**（§5.1 (d)）。
- ⚠️ 存量 worker 上已有的 `auth.json` 需要**一次性清理**（幂等）。

### 5.3 🥉 MCP 状态：30s 定时轮询 → 事件触发 + 兜底轮询　（R2）

**要做什么**：worker 侧订阅 v2 的 `mcp.status.changed` → 事件到达时**立刻**查一次 `GET /api/mcp` → 上报；平时退到低频兜底轮询。

**收益**：状态从"最坏 30s 滞后"变成"事件驱动（近实时）"；同时把兜底周期拉长，**省掉 serve 的周期性 HTTP 压力**。

**caveat 清单**
- ⚠️ **`probe_failed` 语义必须保留**——"探针坏了"**绝不能**上报成"这个 worker 没接 MCP"（`worker/src/mcp-status/mcp-status-probe.ts:50-55`）。
- ⚠️ **五态线契约两端双写**（server `MCP_STATUS` + `@IsIn` ↔ worker `McpServerStatus`）——不同步 ⇒ **整个心跳 400** ⇒ worker 被判离线 ⇒ **必须先 server 后 worker**。
- ⚠️ **事件在 worker 侧**（serve ↔ worker 总线），**server 拿不到** ⇒ 状态**仍要靠心跳上报**给 server（不能改成"server 订阅 v2 事件"）。
- ⚠️ `mcp.status.changed` **只带 server 名** ⇒ 事件到达后**仍要查一次**才知道状态（§3.2）。

---

## 6. 契约陷阱（写代码前必读）

### 6.1 跨进程陷阱　**（决定 §5 里大部分"冗余"其实不可直接退役）**

`ctx.*.transform` / `ctx.permission.hook` / `ctx.storage` / `ctx.event.subscribe` **全部只在 opencode 进程内生效**。

vteam 是**三层进程**：

```
server (NestJS)  ──HTTP──▶  worker (Node)  ──spawn──▶  serve (opencode v2)
```

⇒ **任何"v2 原生能力"要覆盖 vteam 的 server 侧逻辑，必须先有 worker 侧的代理端点。**

（旁证：vteam 自己的 D3 决策——"控制面彻底不直连 opencode"。这条纪律对 v2 原生能力同样成立。）

### 6.2 双写陷阱

worker ↔ server 的协议类型是**两份副本**：
- worker：`worker/src/protocol/worker-protocol.ts`
- server：`server/src/workers/worker-session-protocol.ts`

**改任一端必须同步另一端。**（T21 已补上三层断言：源码级逐字段对照 / 编译期类型恒等 / 运行时 wire 键集断言——见 `opencode-v2-verification-report.md` §3。）

### 6.3 v1 回滚路径已不存在

- v1 驱动已删（`worker/src/index.ts:817-819`）⇒ `OPENCODE_V2_ENABLED=false` 现在**响亮抛错**。
- ⇒ **不需要为 v1 保留任何双写**（这是 R11 可以退役的根本原因）。
- ⚠️ **真正的回退 = 回滚镜像到 v1.0.x 并连带回滚 opencode 数据卷**（v2 的会话库是 SQLite `opencode.db`；v1 读不了 v2 形态的卷）。详见计划 §9.3 与 `docs/deployment.md` §八。

### 6.4 `/api/experimental/**` 全部不稳定

`/api/experimental/session/{sessionID}/log` · `/api/experimental/mcp/{server}`（+ `/connect`、`/disconnect`）· `/api/experimental/session/{sessionID}/export` · `/api/experimental/session/import` · `/api/experimental/session/stats` · `/api/experimental/migration/v1` · `/api/experimental/session/{sessionID}/generate` ……

⇒ **凡依赖 experimental 端点的实现，必须有降级路径**（R6 的 log 补齐就是典型）。

### 6.5 ephemeral vs durable（完整清单见 §1.2）

⇒ **vteam 铁律「只有 durable 事件能驱动状态判定」与 v2 契约完全吻合。**
⇒ 但注意反面：**ephemeral 事件可以"触发一次动作"**（如收到 `mcp.status.changed` 就去查一次状态、收到 `permission.asked` 就去拉一次列表）——**这是 R2/R15 的事件快路能成立的原因**。

### 6.6 基线快照是 2.0.28，不是锁定的 2.0.32

- 快照（`opencode-v2-contract-baseline/openapi.json`）由 **2.0.28** 生成；锁版目标是 **2.0.32**。
- ⇒ **锁版即锁契约基线**：用 2.0.32 重跑快照，差异项逐条登记到计划 §10。
- ⚠️ **`GET /api/model` 两版形态一致**（都是 `{location, data}`）⇒ 代码里"容忍裸数组"是**防御性**的，**不是**已知版本漂移（⚠️ 别按"版本漂移"去"修"它）。
- ⚠️ **口径**：这条只针对**契约快照**（**OpenAPI 形态捕获**）；**行为**证据（热重载）**已由锁版 `2.0.32` 产出**，复检覆盖的路径上**未发现行为差异**（§2.4）⇒ **"锁版即锁证据"只对快照成立**，不适用于行为证据。

### 6.7 后台执行的"唤醒"是**状态落进会话历史**，不是推事件

- `shell` 工具的 `background: true` → 📄 官方文档：*"Background calls return immediately and **notify the session when they finish**"*。
- 背书机制：📄 契约 `POST /api/session/{id}/shell`（事件 `session.shell.started` / `session.shell.ended`，**durable**）；`Shell.Info{id, status: running|exited|timeout|killed, command, cwd, shell, file, pid, exit, signal, time}`；输出落**文件**，经 `GET /api/shell/{id}/output` 读（**按绝对字节游标** `cursor` 分页）；`DELETE /api/shell/{id}` 终止。
- 完成的载体是 **`Session.Message.Shell`** 消息（📄 `@opencode/schema@2.0.32`：`type:"shell"`，含 `shellID` / `command` / `status` / `exit` / `output{output,cursor,size,truncated}` / `time{created,completed}`）。
- `subagent` 的 `background: true` → 📄 官方文档：*"returns immediately and **notifies the parent** when the child finishes"*（真的建了带 `parentID` 的子会话）；父侧的通知是 **`Session.Message.Synthetic`**（📄 `type:"synthetic"`，含 `text` / `description`）。
- `POST /api/session/{id}/background` → 📄 契约：*"Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op."*

⇒ **"唤醒"不是把事件推给模型，而是把结果写进会话历史** ⇒ 天然可重放、天然跨断线不丢（模型下一轮读到的是历史里的那条 shell/synthetic 消息）。

---

## 7. 本次分析**没有**覆盖到的

> 防止读者把本文档误当成"vteam 自研机制全量盘点"。

| 未覆盖 | 说明 |
|---|---|
| **vteam 侧其它自研机制** | 只盘了 15 行。本文档**没有**覆盖：产出物 / 文档库（doclib）、记忆分层、评审轮次、派发回执配对、幂等与先查后派、团队模型与成员生命周期、渠道集成（企微等）、任务状态机、敏感命令工具、Git 凭据注入…… |
| **web 端** | 完全未覆盖。本文档只涉及 server / worker / serve 三层。 |
| **chart / 部署** | 未覆盖（灰度与回滚见 `docs/deployment.md` §八、计划 §9）。 |
| **v2 的 v3 兼容性** | 只对照到 2.0.32；`/api/experimental/**` 的形状在 2.0.32 未逐条实测。 |
| **OmO（`oh-my-openagent`）集成** | 仍是缺口（计划 §10 U8）——v1 插件实现在 v2 不运行，本分析未涉及。 |
| **受管配置目录** | `/etc/opencode` 等不受 XDG 控制（计划 §10 U9），本分析未涉及。 |
| **性能 / 容量** | 所有"收益"都是**定性**判断（消掉几个连锁成本），**没有**做基准测量。 |
| **§5 三件事的实施** | 🥇 **实施中**（并行工作）；🥈 / 🥉 **尚未开始**。本文档只给下一步与 caveat，不声称已完成。 |

---

## 8. 附：本次核对过的 v2 原生能力清单

> 这份清单是本文档所有"v2 侧"论据的索引。**HTTP 端点**来自 📄 契约基线（2.0.28）；**插件域**来自 📄 `@opencode/plugin@2.0.32`；**事件**来自 📄 `@opencode/schema@2.0.32` 的事件清单；**CLI** 来自 ✅ 本机 2.0.28 `--help`；**后台执行**来自 📄 官方文档 + 📄 契约。

### 8.1 HTTP 端点（📄 契约基线，118 paths）

| 能力 | 端点 |
|---|---|
| 凭据 | `GET/POST /api/credential` · `PATCH/DELETE /api/credential/{id}` · `POST /api/credential/{id}/activate` |
| MCP | `GET /api/mcp` · `GET /api/mcp/resource` · `PUT/DELETE /api/experimental/mcp/{server}` · `POST /api/experimental/mcp/{server}/connect\|disconnect` |
| 插件 RPC | `POST /api/rpc/{rpcID}/{method}`（客户端 `client.rpc(Acme)`；事件信封 `rpc.<rpcID>.<event>`） |
| durable 事件日志 | `GET /api/experimental/session/{sessionID}/log?after=&follow=` |
| durable inbox | `POST /api/session/{id}/prompt`（`delivery:"steer"\|"queue"`）· `GET/PATCH/DELETE /api/session/{id}/inbox[/{inboxID}]` |
| 事件总线 | `GET /api/event`（SSE；volatile） |
| 目录 / 资源 | `GET /api/skill` · `GET /api/command` · `GET /api/reference` · `GET /api/project` · `GET /api/location` · `POST /api/location/reload` · `GET/POST /api/pty` |
| 会话导入导出 | `GET /api/experimental/session/{id}/export` · `POST /api/experimental/session/import` · `GET /api/experimental/session/stats` |
| 会话查询 | `GET /api/session/{id}/diff?from&to&context` · `GET /api/session/{id}/context` |
| 表单（question） | `POST/GET/DELETE /api/session/{id}/form[/{formID}]` · `POST .../form/{formID}/reply` |
| 权限 | `POST/GET /api/session/{id}/permission` · `POST .../permission/{requestID}/reply`（`decision: once\|always\|reject`） |
| 后台执行 | `POST /api/session/{id}/shell` · `GET /api/shell` · `GET /api/shell/{id}` · `GET /api/shell/{id}/output` · `DELETE /api/shell/{id}` · `POST /api/session/{id}/background` |

### 8.2 插件域（📄 `@opencode/plugin@2.0.32`）

`ctx.{agent, tool, skill, model, provider, command, mcp}.transform` + `ctx.<domain>.reload()`；`ctx.permission.hook("evaluate")`；`ctx.storage.{get,set,remove,scan}`；`ctx.event.subscribe`；`ctx.rpc.register`；`ctx.credential.activate`；`ctx.shell`；`ctx.vcs`；`ctx.worktree`；`ctx.websearch`。
`Transform<Input> = (cb: (input: Input) => void) => Promise<Registration>`；`Registration.dispose()` 撤销该次 transform。

### 8.3 CLI（✅ 本机 2.0.28 `--help`）

`opencode models` · `opencode mcp list|add|auth|logout` · `opencode plugin list|add|check|update|remove` · `opencode auth list|login|logout|export|import|switch` · `opencode session list|delete|export|import` · `opencode service start|restart|status|stop|get|set|unset` · `opencode reload` · `opencode pair` · `opencode api` · `opencode debug paths`。
⚠️ **除 `--standalone` / `--server` 外，所有 CLI 子命令都绑共享后台服务（49374）**——不是 worker 自己 spawn 的 serve（同计划 §2.9）⇒ **不能拿 CLI 观测 worker 的 serve**。

### 8.4 后台执行（📄 官方文档 + 契约）

见 §6.7。
