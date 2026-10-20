# 计划：vteam 适配 OpenCode v2

一句话摘要：把 worker 侧对 opencode v1 的全部耦合（`worker/src/driver/v1-driver.ts` 14 处 REST、`serve-event-stream.ts` 4 个事件名、`prompt-await.ts` 的 `step-finish/stop` 语义、injector 的 v1 形配置、三个 `@opencode-ai/plugin` 生成器）一次性切到 v2 契约（`/api` 前缀、`content[]`、`durable.seq`、`delivery: steer|queue`、恒开鉴权），并兑现 doc 07 §9.2 已定义但从未实现的 `OpenCodeDriver` 抽象缝；同时把控制面 `server/src/workers/worker.client.ts` 的 5 处 opencode 直连收回 worker 侧。

## 状态 / 负责人 / 基线

| 项 | 值 |
|----|----|
| 状态 | 草案（待评审） |
| 负责人 | 待指派（worker 侧 1 人 + 控制面 1 人 + 前端 0.5 人） |
| 基线（实测二进制） | `opencode v2.0.28`（真实 boot server、拉 OpenAPI spec、采 SSE 帧） |
| 基线（类型定义） | `@opencode/*` 2.0.32 发布版类型（`@opencode/sdk` / `@opencode/plugin` / `@opencode/core`） |
| 基线（配置 schema） | `https://opencode.ai/config.json` 实时 schema（48 顶层键） |
| 锁版目标 | `@opencode/cli@2.0.32`（Dockerfile `ARG OPENCODE_CLI_SPEC`） |
| v1 现状 | `opencode-ai@latest` = 1.19.3（**已冻结**，不再发版）；`@opencode-ai/sdk` = 1.19.3 |
| 影响面 | worker 8 文件 / server 4 文件 / web 1 文件 / 文档 1 篇 / 镜像 1 个 |
| 依赖文档 | `docs/agent-platform/07-opencode-v2-调研与架构决策.md`（本文档订正其过期假设，见 D13） |
| 契约漂移风险 | **2.0.28 与 2.0.32 的 OpenAPI 存在差异**（如 `GET /api/model` 的响应包装：2.0.28 实测 `{location, data}`，2.0.32 spec 为裸数组）→ **以锁定版本重跑契约基线**（T1 交付物之一） |

---

## 1. 背景与目标

### 1.1 为什么是现在

| 事实 | 后果 |
|------|------|
| v1 npm 包 `opencode-ai` 的 `latest` 停在 **1.19.3**，不再发版；v1 SDK `@opencode-ai/sdk` 同版本冻结 | "v1 作为兜底"不是安全网，是一条死线。doc 07 §8 的"v1 兜底"策略失效 |
| v2 已正式发版：npm 包 `@opencode/cli`，`latest` = **2.0.32**；SDK 改名为 **`@opencode/sdk`**（v1 线从未以 v2 tag 重发） | 契约已冻结到可锁版本的程度，不再是 beta；doc 07 §1/§6 的"beta 阶段"判断过期 |
| v2 仓库从 `sst/opencode` 迁到 `anomalyco/opencode` | 依赖升级路径与 issue 追踪路径都变了 |
| v2 有三个"官方有意破坏"的区：插件 API / server API / TUI 配置 | 正好命中 vteam 的三处最硬耦合：driver、事件流、三个工具生成器 |
| v1.19.3 **同时提供两套 HTTP 面**：legacy 根路径面（`/session`、`/event`、`/config`…）**和**一套过渡性的 `/api/*` 面；v2 **只保留 `/api/*`，legacy 面已移除** | 解释了 vteam 现有 v1 代码打的是哪一面：`worker/src/driver/v1-driver.ts` 全部走 legacy 根路径面（`POST /session`、`GET /event`…），只有 `GET /api/model` 恰好落在过渡面上——切 v2 时这一条会同时断（要么端点没了，要么响应包装变了） |
| **契约在 2.0.28 → 2.0.32 之间有漂移**：live root spec（`https://opencode.ai/openapi.json`，144 ops）与 `/v2/openapi.json` 快照（143 ops）差一个端点；`GET /api/model` 的响应形状两版不同 | 本文的实测基线取自 2.0.28，锁版目标却是 2.0.32 → **锁版即锁契约基线**（T1 须用锁定版本重跑一次实测并出快照），否则实现按 2.0.28 的响应包装写、跑在 2.0.32 上会静默解包失败 |

vteam 当前的 worker 镜像装的是**未锁版本**的 `opencode-ai`（`worker/Dockerfile:30`），运行时无从回答"现在跑的是哪一版"；而 `server/src/workers/workers.service.ts:919-920` 用**精确字符串相等**过滤可调度 worker。因此"版本闸门"必须先于任何 v2 worker 上线。

### 1.2 "适配完成"的定义

- worker 能在 v2 serve 上跑通一条真实 agent 会话：建会话 → 下发 prompt → 收到首字 → 收到终态 → 产出物归档。
- vteam 事件流（`session.updated` / `message.part.delta` / `task.completed` / `agent.status` / `session.question` / `session.permission`）语义不变，web 与控制面零感知。
- 控制面**不再**持有任何 opencode 端点字面量（`/session`、`/prompt_async`、`/abort`、`/api/model`）。
- 存量消息（v1 `parts[]` 形态）在 web 上照常渲染。

### 1.3 非目标（明确不做）

| 非目标 | 理由 |
|--------|------|
| opencode 插件生态适配（不自研 v2 插件分发） | vteam 只需要"自定义工具 + 角色 agent"两个能力，不需要插件市场 |
| v1/v2 双驱动并存 / 双跑灰度 | v1 已冻结，双驱动等于为死线付双倍维护成本；灰度靠**镜像回滚**，不靠代码双轨 |
| 全量历史数据回填（`parts[]` → `content[]` 批量改写） | 存量体量大，且 v1→v2 映射有损（见 §6.3）；用渲染层双形态兼容 |
| 引入 `@opencode/sdk` 进程内托管（in-process host） | 该路径的能力映射与多租户持久化**未验证**（§10 Q4/Q5）；v2 HTTP serve 契约已完整可测，先走 HTTP |
| 改造 vteam 的 `platform-mcp`（暴露给 opencode 的 MCP server） | vteam 侧 MCP server 与 opencode 版本无关，本次不动 |
| 升级 opencode 到 v2 之外的任何 2.x | 锁版本，升级走独立评审 |

---

## 2. v2 契约基线（实测 v2.0.28）

> 下列每一条事实均在真实 `opencode v2.0.28` 二进制上验证：boot 起 serve、拉取 276KB OpenAPI 3.1 spec（118 paths / 285 schemas）、采真实 SSE 帧、读 `@opencode/*` 2.0.32 发布版类型定义、读 `https://opencode.ai/config.json` 实时 schema。完整参考见**附录 A/B/C**。

### 2.1 分发与包装

| 项 | v1 | v2 |
|----|----|----|
| CLI npm 包 | `opencode-ai`（1.19.3，冻结） | **`@opencode/cli`**（2.0.32） |
| SDK npm 包 | `@opencode-ai/sdk`（1.19.3，冻结） | **`@opencode/sdk`**（2.0.32）；子包 `@opencode/client` / `core` / `plugin` / `schema` / `server` / `util` / `protocol` |
| 插件包 | `@opencode-ai/plugin` | **`@opencode/plugin`** |
| 仓库 | `sst/opencode` | `anomalyco/opencode` |
| 安装 | `npm i -g opencode-ai` | `npm i -g @opencode/cli`（另有 curl / brew `anomalyco/tap/opencode-v2`） |

### 2.2 CLI 差异（逐条实测 `--help`）

| 命令/参数 | v1 | v2 | vteam 影响 |
|-----------|----|----|-----------|
| `opencode --version` | `opencode 1.19.0` | **`opencode v2.0.28`**（多 `v` 前缀 + 主版本） | 版本解析器必须改（`worker/src/index.ts:87`、`opencode-server.ts:292`） |
| `opencode serve --pure` | 有效（禁插件 / AGENTS.md 注入） | **不存在**——传 `--pure` 直接 exit 1 | **当前 worker 启动即失败**；必须移除（`opencode-server.ts:355-388`） |
| `opencode serve` banner | `listening on http://HOST:PORT` | `server listening on http://HOST:PORT` **+ 新增一行 `server password <PASSWORD>`** | 现有非锚定正则 `LISTENING_RE` 仍匹配 ✅；密码行是新信息（见 D10） |
| `opencode mcp list --pure` | 有效 | **无效**——打印帮助文本 + `Unrecognized flag: --pure` 并 **exit 1** | 探针**显式失败**（非零退出码 → 必须报错，**不得**报"无 MCP 服务器"）；`mcp-status-probe.ts:144-148` 必须改 |
| `opencode mcp list` 输出 | `● ✓ <name> …` | `✓ <name>   connected` | 现有正则把 bullet 列为可选 → 仍匹配 ✅。⚠️ **但 v2 下它答的不是 worker 的 serve**（作用域错配，见 **§2.9**）⇒ 探针已改为读 serve 的 `GET /api/mcp`（**五态**） |
| `opencode models` | 每行一个 `provider/model` | **格式完全相同** | ⚠️ **格式没变，但它读的不是 worker 的 serve**（见 **§2.9**）⇒ 探针已改为读 serve 的 `GET /api/model` |
| `opencode api` | — | 新增：`METHOD /path` 或 OpenAPI operation id | 可作为契约自检工具 |
| `opencode service` | — | 新增：`start\|restart\|status\|stop\|get\|set\|unset` 后台服务管理 | vteam 不用（自管 spawn），仅记录 |
| `opencode session` | — | 新增：`list\|delete\|export\|import` | vteam 不用 |
| `opencode auth` | — | 新增：`list\|login\|logout\|export\|import\|switch` | 凭据可移植性备选（D11） |
| `opencode debug paths` | — | 新增：`home, data(~/.local/share/opencode), cache, config(~/.config/opencode), state, tmp, bin, log, repos, db(~/.local/share/opencode/opencode.db)` | 存储路径探测 |
| `opencode --standalone/--server/--auto/-c/-s/--prompt` | — | **新增全局 flag**（v1 是逐命令 flag） | vteam 不用（自管 serve），仅记录 |
| `opencode run --format json` | — | 存在 | vteam 不用 |
| serve 默认端口 | `4096` | **后台服务默认 49374**（`opencode serve` 本身仍是 4096） | vteam 自管随机端口，但**必须显式指定端口**以避开后台服务占用 |
| `--print-logs` / `--log-level` | 存在 | **v2 CLI 文档已不收录**（改用环境变量 `OPENCODE_LOG_LEVEL`），但 2.0.28 实测 `--print-logs` 仍被接受（提示 "server logs require --standalone"）、`--log-level` 仍存在；**实测 v2 的 logfmt 诊断仍落 stderr、banner 落 stdout** ✅ | 落点对 `serve-log.ts` 有利（stderr 抓诊断、stdout 抓 banner/密码），但**未文档化行为不可依赖** → T2/T7 仍须回归断言落点，必要时改用 `OPENCODE_LOG_LEVEL` + 日志文件路径 |

### 2.3 HTTP API 差异（`/api` 前缀是 v2 头号破坏）

v1 无前缀路由（`/session`、`/event`、`/config`、`/provider`、`/agent`、`/question`、`/permission`、`/todo`）；**v2 全部带 `/api` 前缀**。实测：`GET /session` 在 v2 返回 **web SPA HTML**（不是会话列表）；`GET /openapi.json`（Basic 鉴权）返回完整 spec；`GET /api/openapi.json` → 404。v2 共 117 条 `/api` 路由 + 1 条 `/auth` 路由。

> ⚠️ **v1 legacy HTTP 面确认已消失——但不是 404，而是 200 + SPA HTML**：实测 `GET /session`、`GET /event`、`GET /config` 在 v2 **全部返回 200，且 body 是 web SPA 的 HTML**（既不是 JSON，也不是 404）。**只查状态码的健康/契约自检会因错误的原因判"服务正常"**——这是切 v2 时最容易踩的假阳性陷阱。契约自检必须断言 **body 形态**（JSON / `Content-Type`），不能只看 200。

> **补充（v1 也有 `/api/*` 面）**：v1.19.3 同时提供 legacy 根路径面与一套过渡性的 `/api/*` 面；**v2 只保留 `/api/*`，legacy 根路径面已移除**。vteam 现有代码基本打的是 legacy 面（只有 `GET /api/model` 落在过渡面上），因此切 v2 时"端点消失"与"响应包装变化"会同时发生。

逐条对照见**附录 A**。vteam 实际用到的 14 个 v1 端点在 v2 的落点与关键差异：

| v1 端点族 | v2 落点 | 关键差异 |
|-----------|--------|----------|
| `POST /session` | `POST /api/session` | body 用 `location:{directory}`，取代 v1 的 `?directory=` |
| `POST /session/{id}/prompt_async?directory=` | `POST /api/session/{id}/prompt` | body `{id?, text(必填), files?, agents?, skills?, metadata?, delivery?, resume?}`；**无 `system`、无 `parts`、无 `?directory=`**；返回 `200 {data: Session.Inbox.User}`（**入队而非同步执行**） |
| `GET /session/{id}/message` | `GET /api/session/{id}/message` | `{data:[], cursor:{previous,next}}`；**新增游标分页** |
| `GET /question` + `POST /question/{id}/reply` + `/reject` | `GET,POST /api/session/{id}/form` + `POST .../form/{formID}/reply` + `DELETE .../form/{formID}` | 从**全局**改为**会话内**正式 request→reply 流；`reject` 的等价端点语义 →【待确认 Q6】 |
| `GET /permission` + `POST /permission/{id}/reply` | `GET,POST /api/session/{id}/permission` + `POST .../permission/{requestID}/reply` | 同上，会话内 |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt`（`?resume=true\|false`） | 返回 `{interrupted:true\|false}`；`false` = 空闲空操作 |
| `GET /agent?directory=` | `GET /api/agent` | `{location, data: Agent.Info[]}`；**GET 类端点的 location 选择机制未验证 →【待确认 Q7】** |
| `GET /session/{id}/todo?directory=` | **v2 路由清单中无 todo 端点** | →【待确认 Q8】（"计划 Tab 步骤区"数据源） |
| `GET /provider` / `GET /api/model` | `GET /api/provider` / `GET /api/model` | 都是 `{location, data:[...]}`——**对象包装，不是裸数组**（⚠️ 2.0.32 spec 里 `GET /api/model` 已改为**裸数组** `Model.Info[]`，与 2.0.28 实测不同 → 见基线漂移，T1 锁版后重跑） |
| `GET /`（健康） | `GET /api/info` | ⚠️ **v2 的 `GET /` 未鉴权也返回 200**（body 是 web SPA HTML，**不校验鉴权**）→ 旧的 `GET /` 健康检查会**因错误的原因通过**；实现已把探针移到 `GET /api/info`（**未鉴权 401 / 已鉴权 200**）。响应：`{version, pid, urls[], paths{tmp}, capabilities{persistentPty}}` |
| `GET /event`（SSE） | `GET /api/event` | 帧**无 `event:` 字段**，类型在 `data.type`；见 §2.5 |
| —（新增） | `POST /api/session/{id}/agent` / `POST /api/session/{id}/model`（均 204） | 切换后续 turn 的 agent / model（角色激活机制）。**实测（T4）`POST /api/session/{id}/agent {"agent":"<name>"}` 会把该 agent 的 `system` 应用到后续 turn**（并新增一条 `type=agent-switched` 消息 + 发出 `session.agent.selected`）；**`POST /api/session` 时 body 直接带 `"agent":"<name>"` 同样生效**；❌ **prompt body 的 `agents:[{name}]` attachment 是 no-op** |
| —（新增） | `GET /api/plugin` | 插件清单；⚠️ **不可靠**（location 作用域 + 惰性发现 + `setup` 异步；实测出现过 `total=0` 而插件已加载）→ **不要当"插件是否加载"的判据**（见附录 A） |
| —（新增） | `GET /api/experimental/migration/v1` | v2 的**一次性 legacy 导入**：仅当 **legacy 路径上确实存在 v1 数据**时才发生；实测 `{"status":"completed"}`（doc 07 §4 称其已移除——**错**，见 D13）。⚠️ **在 vteam 的隔离部署下它不会被触发**（v1 数据不在 v2 worker 的作用域内）⇒ **v1 时代的历史原样留在盘上**（见 D11 / §9.3） |

### 2.4 数据模型差异：`parts[]` → `content[]`（最大破坏点）

v1：`Message {id, role, parts: Part[]}`，`Part` ∈ Text/Reasoning/Tool/StepStart/StepFinish/File/Snapshot/Patch/Agent。

v2：`Session.Message.Info` 是**按 `type` 判别的联合体**；assistant 消息用 **`content[]`** 取代 `parts[]`。

> ⚠️ **区分"上游形态变了"与"落库形态变了"**：变的是**上游消息形态**（`parts[]` → `content[]`）。**vteam 落库/渲染的形态没有变**——因为 **v2 driver 在边界就把 `content[]` 归一成了 vteam 既有的内部模型**（server 侧 `message-parts.ts` 的 `normalizeParts()` 收口，v1 形 `parts[]` 与 v2 形 `content[]` 归一到同一个模型）。⇒ **零数据迁移、零 web 改动**（见 D5 / T20）。

| v1 | v2 | 备注 |
|----|----|----|
| `Message {role:"user", parts:[{type:"text",text}]}` | `Session.Message.User {type:"user", text}` | **纯 `text`，无 parts 数组** |
| `parts[].type:"text"` | `content[].type:"text"` = `{type,text,state}` | — |
| `parts[].type:"reasoning"` | `content[].type:"reasoning"` = `{type,text,state,time}` | — |
| `parts[].type:"tool"` | `content[].type:"tool"` = `{type,id,name,executed,state,providerState?,providerResultState?,time}` | — |
| `parts[].type:"step-start"` | **不再存在** | 升级为**事件**（`session.step.started/ended/failed`）；v2 无对应、**也没有任何消费方** → **可丢弃** |
| `parts[].type:"step-finish"` | **上游不再存在**（变事件 `session.step.ended`） | ⚠️ **但它必须被"合成并保留"**——它是控制面的**「本轮完成」幂等键**（`worker-dispatcher.ts` 的 `findStepFinishPartKey` 读 `part.type === 'step-finish'`）。v2 没有这个 part，所以 **v2 driver 必须从 assistant 消息的 `finish`/`tokens`/`cost` 合成一个**再上送 ⇒ **归一化时不得丢弃 `step-finish`**（丢弃即"控制面永远看不到本轮完成"） |
| tool `state.output`（string） | tool `state.content`（**array**） | v2 tool state 的**实际 `status` 取值是小写** `running`/`streaming`/`completed`/`error`——**与 v1 同族**（`Running`/`Streaming`/`Completed`/`Error` 只是 OpenAPI 的**类型名**，不是取值）。web 的 `toToolStatus` 本就 `toLowerCase()` 后再映射 ⇒ 现有映射继续有效 |
| tool state `pending` | **无对应** | v2 无 `pending`；`streaming` 独立成变体（web 侧把 `pending`/`queued` 一并归 running） |
| 消息 `error` | assistant `error?` 字段保留 | vteam 错误抽取路径需重写（见下方「v2 的错误形状」） |
| — | `Session.Message.Idle {type:"idle", time, outcome, error?}` | 空闲现在是**消息**不是仅事件。⚠️ **v2 driver 丢弃 `idle` 消息**（vteam 的 role 模型只有 user/assistant 二值）⇒ 承载 run 级 `outcome` 的那条消息**轮询路看不到** ⇒ run 级结论只能走事件路（见 D7 / T14） |
| 文件 part `{type:"file",mime,filename,url:"file://…"}` | `Prompt.FileAttachment {data(base64), mime, source:{type:"inline"}\|{type:"uri",uri}, name?, description?, mention?}` | vteam 的附件装配要重写 |
| — | `Prompt.AgentAttachment {name, mention?}` / `PromptInput.SkillAttachment {id, mention?}` | `mention` = `{start,end,text}` |

**v2 的错误形状（P3 实测 2.0.28）**：模型调用失败时，assistant 消息的 `error` 字段是

> `{"type":"provider.auth","message":"Invalid API key.","status":401,"response":{"body":"…"}}`

且该消息**根本没有 `content` 数组**（vteam 内部模型 = `parts=[]`）——⇒ **v1 的「凭据错误 ⇒ parts 空、错误只在 `info.error` 里」这个坑在 v2 原样复现**（不是 v2 特有的新坑，但也不能假设 v2 会在别处给出错误）。**同一个对象也是 `session.execution.failed` 事件的 `data.error` 载荷**——它是**比 serve 日志正则更好的来源**（自带 HTTP 状态码与原始响应体）。⇒ 错误抽取**两代通吃**：消息文本 = `data.message`（v1）→ 顶层 `message`（v2）→ 类型名（`name` / `type`）；HTTP 码 = `data.statusCode`（v1）→ 顶层 `status`（v2），渲染成 ` (HTTP 401)`；**aborted 跳过**时 `name` 与 `type` 都要查；serve 日志正则保留为最后兜底。

### 2.5 事件流差异（帧格式完全重写）

v2 `GET /api/event` → `text/event-stream`。**SSE 帧没有 `event:` 字段**，事件类型在 JSON payload 的 `data.type`：

```
data: {"id":"evt_…","created":1792455218702,"type":"session.created","location":{"directory":"…"},
       "data":{…},"durable":{"aggregateID":"ses_…","seq":0,"version":1}}
```

心跳以 SSE 注释行（`: heartbeat`）到达。`durable = {aggregateID, seq, version}` 提供**每会话单调序号**——这是 vteam 事件幂等的现成键。

> ⚠️ **实机抓帧的三处更正（P2a / T4·T5 spike 复核）**：① **并非每个事件都带 `durable` 块**——`session.text.delta`、`session.reasoning.delta`、`session.tool.input.delta`、`session.tool.progress`、**`session.usage.updated`**、`permission.*` / `form.*` 都是**没有 durable 的 ephemeral 帧**（`session.usage.updated` 早前在本计划里被标成 durable，**是错的**）⇒ **只有 durable 事件能驱动状态**；② **`ordinal` 不是逐帧计数器**（同一条 assistant 消息的多帧 delta 全是同一个 `ordinal`）⇒ 逐帧去重只能靠帧 id；③ **增量字段名是 `delta`**（不是 `text`），而 `session.text.ended` / `session.reasoning.ended` 的 `data.text` 才是**权威全文**。详见附录 B 与附录 B.1。

> ⚠️ **D6(f) 实测：插件推的 system 段落在 opencode 内置 system 段之后**（D6 的插件交接落地时测出）——`event.system.push(...)` 落点是**内置 system 段之后**，所以**可缓存的前缀是 `[内置][blob][消息…]`**：常量部分（内置段）仍在 blob **之前** ⇒ **前缀缓存受益**（若落在内置段之前，常量部分会被推到可变 blob 后面，内置前缀的缓存就会受损）。⚠️ **与 v1 的顺序不同**：v1 把 blob 放在 body 级 `system` 里（**前置**在 system 段**最前**），v2 的插件**只能追加** ⇒ **blob 在 system 段的次序与 v1 相反**；这个差异**只在跨版本升级那一次**有影响（一次重新缓存），**v2 内部次序是稳定的**。

> ⚠️ **v2 的 OpenAPI SSE schema 声明 `{ id, event, data }`（`event` 必填），但 2.0.28 运行时根本不发出 `event:` 行** —— 实机抓原始字节：`grep -c "^event:"` → **0**，`grep -c "^data:"` → 2；类型只在 `data.type` 里。**以真实字节为准，不要以 schema 为准。**

v1 事件名（`server.connected` / `message.updated` / `message.part.updated` / `message.part.delta`）在 v2 **全部不存在**（但 v2 源码含 v1 legacy 事件定义，见 §3.2 备注）。

**v2 契约原文（来自 OpenAPI spec）**："Subscribe to native events and plugin RPC events across all server locations. **Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed.**" → vteam 的 SSE 消费者必须能断线重连 + 轮询消息重建状态（v1 现状已具备该能力）。

事件全集见**附录 B**（含 durability 标记与 vteam 映射）。

### 2.6 角色注入与插件载体差异

| 载体 | v1 | v2 |
|------|----|----|
| 角色系统提示 | prompt body 的 `system` 字段 | **prompt body 无 `system`**（`additionalProperties:false`）。v2 原生载体是配置键 **`agents.<name>.system`**（在 v2 原生 `agents:` 节内实测归一化后原样保留）。⚠️ **`prompt` 键的处置取决于它所在的节**（2.0.28 实测，同一份配置里 `agent:` 与 `agents:` 两节并存时）：在 **v1 形 `agent:` 节**内 → **被迁移为 `system`**（值不丢）；在 **v2 原生 `agents:` 节**内 → **是未知键，被静默丢弃、无任何告警**。⇒ **节名 `agent`→`agents` 与键名 `prompt`→`system` 必须同时改**，只改节名会让所有角色提示静默丢失（见 D6 / T15）。**运行时载体已实测生效**：`agents.<name>.system` 会被**前置**到 opencode 内置 system 段之前进入最终模型请求；激活机制 = **`POST /api/session/{sessionID}/agent`**（204）或建会话时 `POST /api/session` 带 `"agent":"<name>"`。❌ **prompt body 的 `agents:[{name}]` attachment 是 no-op**（实测：无 system 提示、assistant 消息的 `agent` 仍是 `build`、无 `agent-switched` 消息、无 `session.agent.selected` 事件）——**不得依赖**。备选：vteam 现有文本前缀（兜底 (d)）、插件 hook（见下行） |
| 权限声明 | `agent.<n>.permission: {edit:"allow", bash:"ask"}`（对象） | `agent.<n>.permissions: [{action,resource,effect}]`（**数组**，action 自由字符串，effect ∈ allow/ask/deny）；归一化时 `bash` → **`shell`**、`task` → **`subagent`**、`write`/`patch` → **`edit`** |
| 插件接口 | `export const P = (hooks) => ({ "chat.message": async()=>{}, event: async()=>{} })` | `export default Plugin.define({ id, async setup(ctx) { …; return () => {/* cleanup */} } })`；`ctx` 暴露**领域对象**（`app/location/agent/tool/skill/session/mcp/model/permission/…`）而非 hooks；热重载走 `ctx.agent.transform` / `ctx.tool.transform` / `ctx.skill.transform`；v1 hooks 迁到 `ctx.session.hook(...)` / `ctx.tool.hook("execute.before"/"execute.after")` / `ctx.shell.hook("create.before")` / `ctx.permission.hook("evaluate")`，签名从 v1 的 `(input, output)` 改为**单个可变 event 对象**。插件文件放 **`<project>/.opencode/plugins/*.ts`**（`import { Plugin } from "@opencode/plugin"` 由**宿主内置**解析，**不需要** node_modules）；⚠️ **插件发现按 location 惰性触发**（必须先建会话/发 prompt）且 `setup` 是**异步**的 → 断言前要等它跑完 |
| 插件 hook（**逐条**角色注入） | v1 的 `system` 字段是**逐消息**的（每条 prompt 都能带不同 system） | **`ctx.session.hook("context", cb)`** → `event.system.push({type:"text",text})` 可把任意段**直接注入模型请求的 system**；**`ctx.session.hook("prompt", cb)`** → 可在 durable admission 时**改写 `prompt.text`**。**两条都已实测生效**（T4.5 / T4.5b）→ 这是**最贴近 v1 逐消息 `system` 语义**的载体（`agents.<n>.system` 是**逐 agent**的）。⚠️ `context` hook 只作用于 **primary** 请求（标题 / 压缩 / generate 各有独立 hook） |
| **逐消息 blob 的落地载体**（D6(f) 插件交接，**已实现并实机证明 ✅**） | prompt body 的 `system` 字段（逐消息可变） | worker 把 blob **原样**写进 `<workDir>/.vteam-system-handoff/<sessionID>.txt`；插件 `<workDir>/.opencode/plugins/vteam-system-handoff.ts` 在 `ctx.session.hook("context")` 里按 `event.sessionID` 读该文件 → `event.system.push({type:"text",text})` ⇒ **落在模型请求的 system 段**（不再是 user 段的前缀）。**交接目录刻意放在 `.opencode/` 的同级兄弟**（不在 opencode 的配置发现作用域内）；插件把**绝对路径**在注入时写死，并在读之前用 `/^[A-Za-z0-9_-]{1,128}$/` 校验会话 id（路径穿越的唯一防线）。**插件只读不写**：读到啥推啥，**不重新序列化 / 不重排 / 不加时间戳** |
| 工具定义 | `tool({description, args:{…}, execute})` from `@opencode-ai/plugin`（文件 `.opencode/tools/*.ts`） | **`ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, options: { codemode: false }, execute(input, ctx) => ({ content }) }))`**——**入参从 Zod 改 JSON Schema，返回值从 string 改 `{ content }`**（`content` 接受 `string \| Content[]`，事件里是**数组**）。❌ **`.opencode/tools/*.ts` 的文件自动发现在 v2 已移除**（v2 连 import 都不发生）→ 工具**只能**经**插件注册**，插件文件放 **`<project>/.opencode/plugins/*.ts`**。⚠️ **必须显式写 `options:{codemode:false}`**——否则工具只出现在 system 的 Code Mode 目录里，模型无法直接 `tool_calls`（**官方插件文档从未提及 `codemode`**，属"活二进制 vs 官方文档"冲突）。⚠️ `ToolContext` 的键集合实测 = `{sessionID, agent, messageID, id, signal, progress}` → **没有 `directory`**（取 `ctx.location.directory`） |

### 2.7 配置差异（静默归一化是主要陷阱）

v2 **接受并归一化 v1 形配置**（实测：v1 形 `opencode.json` 被接受、serve 正常启动、`/api/config` 返回归一化结果）。归一化规则（**影响面最大的若干条**；完整清单见**附录 C**）：

| v1 形 | v2 形 | 备注 |
|-------|-------|------|
| `mcp: {name:{…}}`（扁平） | `mcp: {servers:{name:{…}}}` | v2 仍解析扁平 legacy 形（deprecated） |
| `mcp.<n>.enabled` | `mcp.servers.<n>.disabled` | ✅ **v2 归一化器把反转做对了**：v1 形 `"enabled": true` → 归一化为 `"disabled": false`（= 仍然启用）。⇒ **vteam 现写的 `enabled` 键本身不危险**，不构成"全被禁用"的风险 |
| `mcp.<n>.timeout: <ms>` | `timeout: {startup, catalog, execution}` | ⚠️ 实测 `"timeout": 30000` → `{"catalog":30000,"execution":30000}`：**`startup` 段丢失**（**不是**被默认值补齐）——v1 的单值 timeout 无处安放；T15 须显式写三段 |
| `plugin: [...]` | `plugins: [...]` | — |
| `agent: {name:{…}}` | `agents: {name:{…}}` | — |
| `agent.<n>.permission: {edit:"allow",bash:"ask"}` | `agent.<n>.permissions: [{action:"edit",resource:"*",effect:"allow"},{action:"shell",resource:"*",effect:"ask"}]` | **`bash` → `shell`**；另 `task` → `subagent`、`write`/`patch` → `edit` |
| **`agent.<n>.prompt`（v1 键）** | **取决于所在的节**（2.0.28 实测）：在 v1 形 **`agent:`** 节内 → **被迁移为 `system`**（值不丢；同节 `system` 与 `prompt` 并存时 `prompt` 胜出、原 `system` 被挪到 `request.body.system`）；在 v2 原生 **`agents:`** 节内 → **是未知键，静默丢弃、无任何告警** | ⚠️ **节名 `agent`→`agents` 与键名 `prompt`→`system` 必须同时改**——只改节名会让所有角色提示静默丢失。v2 原生载体是 **`agents.<n>.system`**（在 `agents:` 节内原样保留） |
| `provider.<p>.models.<m>.reasoning` | **被丢弃**（WARN：`kind=unsupported action="omitted unsupported legacy setting"`） | 同批被丢弃的 legacy 键：`tool_call` / `attachment` / `modalities`；⚠️ **v2.0.28 没有 per-model `reasoning` / `temperature` 的落点**（归一化后被剥除，`GET /api/model` 里也不存在）→ 能力只能改用 `capabilities:{tools,input[],output[]}` 承载。**T7 因此刻意不写这两个键**（基于实测的取舍，不是遗漏） |
| provider `npm` / `options` | `package` / `settings` | ⚠️ **`npm` → `package` 时归一化器会自动加 `aisdk:` 前缀**（实测 `"npm":"@ai-sdk/openai-compatible"` → `"package":"aisdk:@ai-sdk/openai-compatible"`）——T7/T16 显式写 `package` 时**不要再手动加前缀** |
| `provider`（节名） | `providers` | 重命名 |
| `McpLocalConfig.command`（string） | `string[]` | vteam 注入器当前**已产出数组**（`injector.ts:672-676`）——见 T15 |
| `agent.<n>.temperature` / `top_p` | `request.body` / `request.headers` | 实测 v1 形 `agent.<n>.temperature` → 归一化为 **`agent.<n>.request.body.temperature`**（v1 形态被保留），但 ⚠️ **v2 目前不随模型请求下发 `request.body`** → 该值**实际不生效**（inert），per-agent 温度/参数需改用 provider/model settings |
| v1 默认"项目外路径需询问" | v2 **默认允许** `external_directory` | ⚠️ **权限矩阵比 v1 宽松**；要保持 v1 语义必须显式加 `{action:"external_directory",resource:"*",effect:"ask"}` |
| `agent.<n>.maxSteps` / `disable` | `steps` / `disabled` | 重命名 |
| `snapshot` / `reference` / `command` | `snapshots` / `references` / `commands` | 重命名 |
| `attachment` | `media`（新增 `max_width/max_height/max_base64_bytes`） | 重命名 + 扩容 |
| `skills: {paths:[], urls:[]}` | `skills: ["./dir","https://…"]` | 扁平化为数组 |
| `compaction: {preserve_recent_tokens, reserved, tail_turns, prune}` | `{auto, keep:{tokens}, buffer}` | `tail_turns` / `prune` 被忽略并告警 |
| `server` / `logLevel` 顶层键 | 被接受但**忽略**（日志改用 `OPENCODE_LOG_LEVEL`） | 静默忽略 |
| 会话分享（`POST /session/:id/share`、`autoshare`） | **v2 移除** | vteam 不用，仅记录 |
| 语言服务器（v1 内置 LSP 工具） | **v2 不再运行 LSP、不暴露 LSP 工具** | vteam 不用，仅记录 |
| 顶层键总数 | 48 | `mcp/plugins/agents/permissions/policies/provider/model/default_agent/instructions/commands/skills/worktree/experimental/server/snapshot/compaction/...` |

### 2.9 v2 的 CLI **不是 serve 的探针**（作用域错配——真跑栈才发现）

> ⚠️ **这是"离线验证全绿、上线才炸"的那一类事实**：v1 下每次 CLI 调用都起自己的临时 serve
> （cwd 作用域）⇒ **CLI 输出 ≈ serve 输出**；**v2 不是了**——CLI 子命令绑的是
> **共享托管后台服务**（默认端口 **49374**），读的是**它自己那套配置作用域**，
> **不是 worker spawn 的那个 serve**。

| 调用（在 worker 容器里） | 实测结果 | 真相 |
|---|---|---|
| `opencode mcp list`（裸） | `No MCP servers configured` | 答的是**它自己**的作用域；而 worker 的 serve 实际 `GET :4000/api/mcp` → 平台 MCP **connected** |
| `opencode mcp list --standalone` / `opencode --standalone mcp list` | 只打印**帮助文本** | `mcp` 命令组不接受 `--standalone` |
| `opencode models --standalone` | 能跑（起私有 server） | 但读的是 **CLI 自己的**配置作用域 |
| `opencode models`（worker 启动时） | **exit 1**：`ServiceUnavailableError: Location plugins did not finish activating` | ⇒ worker 注册**降级不带 `executableModels`** |

⇒ **凡是用 CLI 探针去"观测 serve"的设计，在 v2 + 隔离下原理上就是错的**：它观测的是**另一个作用域**——
可能报出**不含 vteam 自配模型**的模型清单，可能报出"没有 MCP"而 serve 的 MCP 明明 connected。
**两个都是静默错误答案**（不报错、只是答错）。

⇒ **v2 的正确探针是 serve 自己的 HTTP API**（Basic 鉴权，口令 = serve 密码）：

| 探什么 | 端点 | 备注 |
|---|---|---|
| 模型清单（可执行集） | `GET /api/model` | 两种响应形态（2.0.28 `{location,data}` / 2.0.32 裸数组）用容错解包；`enabled:false` 不算可执行；空/非法响应 ⇒ `undefined`（**不断言"零可用"**） |
| MCP 状态 | `GET /api/mcp` | **五态**（见下） |

⇒ **附带拿到 v2 `/api/mcp` 的五状态**（CLI 文本只有 3 个）：
`connected` / `pending`（还在连）/ `disabled`（配了但关着）/ `failed` / `needs_auth`。
**五态 1:1、不折叠**——`pending` 与 `disabled` **都不是 `failed`**（把"即将连上"报成"连接失败"、
把"故意关掉"报成"环境故障"都是撒谎）⇒ **两端契约同步扩到五态**：worker 的 `McpServerStatus`
（`worker/src/protocol/worker-protocol.ts`）↔ server 的 `MCP_STATUS` + `@IsIn`
（`server/src/mcp-servers/dto/mcp-status.dto.ts`）。未知/缺失 `status` ⇒ 保守落 `failed`
**并响亮告警**（带原始状态串），**不静默丢服务器**、不静默报健康。

⚠️ **升级顺序是硬约束：先 server 后 worker**——server 的 `@IsIn` 必须**先**接受五值，
否则 worker 一上报 `pending`/`disabled` ⇒ **整条心跳 400**（`mcpStatus` 是
`@ValidateNested({each:true})`，一个非法值 ⇒ 整包校验失败）⇒ **worker 被判离线**。
**滚动更新 worker 只有在 server 已是新版之后才安全**。运维口径见
`docs/deployment.md` §八.0 事实 5 / §八.1 / §八.2 阶段 1 与 `chart/vteam/templates/NOTES.txt` 第 9 条。

### 2.8 认证与存储

| 项 | v1 | v2 |
|----|----|----|
| 鉴权 | 密码可空 = 不鉴权 | **恒开**。`OPENCODE_SERVER_PASSWORD` 设置则用它（实测 200/401）；**未设置则自动生成随机密码并打到 stdout**（`server password <pw>`，实测生成长度 **43 字符**） |
| 认证模型（文档侧） | Basic | 文档已切到 **pairing code + `opencode service set password` + 30 天会话**；但 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` 在 **2.0.28 实测仍然生效**（设置则用它 → 200；不设置 → 自动生成随机密码打到 stdout → 401） |
| Basic 用户名 | `opencode` | `opencode`（实测 ✅ 不变）；另有 `OPENCODE_SERVER_USERNAME` 可覆盖 → 列入 vteam 待配置项 |
| 会话存储 | `~/.local/share/opencode/storage/…`（JSON 文件） | **SQLite**（另有 `repos/`、`log/`）；落点 = `opencode debug paths` 的 `data` 目录下的 `opencode.db`，**`XDG_DATA_HOME` 可改写它**——T16b 隔离域下 = `<HOME>/.opencode-iso/data/opencode/opencode.db`（`<HOME>/.local/share/opencode/` 是 **v1 线**的落点，两者**不是同一个目录**） |
| 路径覆盖 | — | **`OPENCODE_DB`** 可覆盖 DB 路径；另有 `OPENCODE_LOG_LEVEL`（v2 的日志级别入口）、`OPENCODE_CLI_CONFIG_CONTENT` |
| v1→v2 数据迁移 | — | **一次性 legacy 导入**：仅当 **legacy 路径上确实存在 v1 数据**时才发生；`GET /api/experimental/migration/v1` → `{"status":"completed"}`。⚠️ **vteam 隔离部署下不触发**（v1 数据不在隔离域的作用范围内）⇒ **v1 时代的历史原样留在盘上**（见 D11 / §9.3） |

---

## 3. 现状盘点与影响面

### 3.1 耦合点清单

| 文件 | 规模 | v1 耦合点 | 风险 | 一句话原因 |
|------|------|-----------|------|-----------|
| `worker/src/driver/v1-driver.ts` | 633 行 | 14 处 REST：`POST /session`、`POST /session/{id}/prompt_async?directory=`、`GET /session/{id}/message`、`GET /question`、`POST /question/{id}/reply`、`POST /question/{id}/reject`、`GET /permission`、`POST /permission/{id}/reply`、`POST /session/{id}/abort`、`GET /agent?directory=`、`GET /session/{id}/todo?directory=`、`GET /provider`、`GET /api/model`、`GET /` | **高** | 端点全变、body 全变、返回包装全变、鉴权模型全变；且 5 处有 v1 响应归一化补丁（`body.id ?? body.sessionID`、`Array.isArray(body) ? body : body.data ?? []`），补丁在新契约下成为噪音 |
| `worker/src/driver/prompt-await.ts` | 928 行 | 完成判定 = assistant 含 `step-finish(reason=stop)`（:386-399）；聚合文本 = `type==='text' && !synthetic` 按 `part.time.start` 排序（:407-414）；首字 = 非空 text 或任意 reasoning（:445-460）；在飞工具豁免 = `status ∈ {pending,running}`（:468）；工具进度指纹 `TOOL_STATUS_RANK={pending:0,queued:0,running:1,streaming:1}`（:729-734）；tokens/cost 取自 `step-finish`（:428-429）；错误抽取 `info.error={name,data:{message,statusCode}}`（:167-203） | **高** | v2 上游**没有** `step-finish` part（变事件）→ **v2 driver 必须合成它**（从 assistant 消息的 `finish`/`tokens`/`cost`），否则控制面的「本轮完成」幂等键失效。**P3 已落地**：完成判定规则**没有被重写**（合成后的 `step-finish` 与 v1 兼容，`finish` 取值同名）；实际改动是 ①在飞豁免改 `∈ {running, streaming}`（v2 无 `pending`）、②错误形状两代通吃、③与事件路的**合流缝**（`EventSignal`）、④`state.output` 保持主形态 |
| `worker/src/driver/serve-event-stream.ts` | 276 行 | 硬编码 `server.connected` / `message.updated` / `message.part.updated` / `message.part.delta`；delta 载荷 `{partID, field, delta}`；`deltaPartTypes` 补丁（delta 帧不带 type） | **高** | v2 帧无 `event:` 名、类型在 `data.type`、无 `partID/field` 结构 → 整层重写；同时是 `durable.seq` 幂等键的接入点 |
| `worker/src/runtime/opencode-server.ts` | 483 行 | spawn argv 含 `--pure`（:355-388）；`LISTENING_RE=/listening on http:\/\/[^:\s\/]+:(\d+)/`（:99）；`spawnSync(cmd,['--version'])`（:292）；`OPENCODE_SERVER_PASSWORD` 注入（:380） | **高** | `--pure` 在 v2 无效 → **当前 worker 在 v2 上启动即 exit 1**；banner 需新增密码行解析；版本串格式变 |
| `worker/src/runtime/serve-log.ts` | 159 行 | v1 logfmt 解析：`SERVE_ERROR_KEYWORDS`(:32)、`SERVE_FATAL_KEYWORDS`(:49-50)、`SERVE_ERROR_LEVEL_RE`/`SERVE_ERROR_FIELD_RE`(:53-55)、`SESSION_ID_RE`(:57)；默认路径 `$XDG_DATA_HOME/opencode/log/opencode.log`(:84-88) | **高（静默降级陷阱）** | 日志格式一变 → 模型错误的快速 abort 死掉 → 用户只看到 300s "无输出"超时，而非真实 API 错误 |
| `worker/src/exec/exec-server.ts` | ~1900 行 | 编排 `createSession→sendMessage→awaitCompletion→SSE 桥`（:1513-1648、:1767-1913）；`PLAN_DOCS_DIRS=['.omo/plans','.opencode/plans','.omo/drafts']`（:158）；附件 part `{type:'file',mime,filename,url:'file://…'}`（:1706）；SSE→`message.part.delta` 桥（:1803-1873）；pending question/permission 轮询 → `session.question`/`session.permission`（:1953-1989）；serve 404 = 会话失效 → 重建（:1651-1653） | **高** | 编排骨架可复用，但附件 part、delta 桥、question/permission 通道三处要改；同时是 D3 新增 worker 端点的宿主 |
| `worker/src/resources/injector.ts` | 892 行 | 写 `<workDir>/opencode.json`：`mcp` 节（:670-701）、`agent` 节（:333-412 经 builder）、`plugin` 节（:512-525，`OMO_PLUGIN_ENTRY='oh-my-openagent@latest'`）；写 `.opencode/tools/<action>.ts`（:271-295）、`.opencode/skills/<name>/SKILL.md`（:250-260）、`.opencode-worker-inject.json`（:765-781） | **高** | v2 归一化会**静默丢弃** `reasoning` 等键；`mcp` → `mcp.servers`、`plugin` → `plugins`、`agent` → `agents`、`permission` 对象 → `permissions[]`；`--pure` 消失后"抑制插件"语义无载体 |
| `worker/src/resources/opencode-config-builder.ts` | 109 行 | 构造 `agent` 节 `{name:{description,mode,permission}}`（:48-64）；拒未知字段（:95-105）；拒 `write` 权限键（:87-91） | **中** | v2 `AgentConfig` 多了 **`system`**（角色提示落点）与 `permissions[]`；现有"未知字段即抛错"闸门会挡住新键，需同步扩白名单；且"拒 `write` 键"的闸门需按 v2 语义重写（`write`/`patch` 已并入 `edit`） |
| `worker/src/credentials/model-credential-injector.ts` | 330 行 | 写 `$HOME/.config/opencode/opencode.json` provider 段（:92-97、:197-292）+ `$HOME/.local/share/opencode/auth.json`（:301-311）；provider 形如 `{npm:'@ai-sdk/openai-compatible', name, options:{baseURL}, models:{id:{name,limit:{context,output},reasoning,temperature,attachment,tool_call,modalities,options}}}`（:139-232）；断言 `additionalProperties:false` 与 `limit.required:[context,output]`（:132-135） | **高** | v2 的 `npm`→`package`、`options`→`settings`、`reasoning/tool_call/attachment/modalities` 被丢弃 → **模型能力声明静默失效**，而 `executableModels` 仍按错误数据工作。**另：两个写入路径都按宿主 `$HOME` 拼** → T16b 隔离 env 后**必须一并改到隔离目录**，否则凭据写到 serve 读不到的地方（最易漏的一处耦合） |
| `worker/src/mcp-status/mcp-status-probe.ts` | 214 行 | `spawnSync('opencode',['mcp','list','--pure'])`（:144-148）；glyph 解析 `parseMcpListOutput`（:91-121） | **中（命令失败）** | v2 下 `mcp list --pure` 打印帮助 + `Unrecognized flag` 并 **exit 1** → 探针命令**显式失败**；须把非零退出码归因为"探针失败"，**不得**报"无 MCP 服务器"。**（✅ 已改为直读 serve 的 `GET /api/mcp`——v2 的 CLI 答的不是 worker 的 serve，见 §2.9）** |
| `worker/src/resources/custom-tool.ts` | 182 行 | 渲染 `import { tool } from "@opencode-ai/plugin";` + `tool({description,args,execute})`（:143-156、:164） | **高** | v2 包名与工具形态都变；**产物形态必须改**（T5 实测：`.opencode/tools/*.ts` 的文件自动发现**已移除** → 改为 `.opencode/plugins/*.ts` 插件注册代码；JSON Schema 入参 + `{content}` 返回值 + **`options:{codemode:false}` 必写**） |
| `worker/src/git/git-tools.ts` | ~800 行 | 同样的 import 与 `tool({…})` 渲染（:723-728、:746）；命名导出 → 工具名 `git_<name>` | **高** | 同上 |
| `worker/src/browser/browser-tools.ts` | ~213 行 | 同样的 import（:147）；`execute(args, context)` 用 `context.sessionID/directory/agent`（:166-180） | **高** | 同上 + **`context.directory` 在 v2 不存在**（T5 实测 `ToolContext` 键集合无 `directory`）→ 改取 `ctx.location.directory` |
| `worker/src/index.ts` | 1275 行 | `spawnSync('opencode',['--version'])`（:87）；`spawnSync('opencode',['models'])` 解析 `provider/model`（:591-602）；`DEFAULT_AUTH_JSON_PATH`（:264-271）；`new V1Driver(...)`（:737-739）；上报 `opencodeVersion`（:688） | **中** | 版本串格式变；driver 构造点要换实现；`models` 格式不变 ✅。**（✅ 模型探针已改为读 serve 的 `GET /api/model`——v2 的 CLI 读的是另一个作用域，见 §2.9）** |
| `worker/src/protocol/worker-protocol.ts` | 495 行 | `WORKER_EVENT_TYPES`（:13-25）含 `MESSAGE_PART_DELTA='message.part.delta'`（:18）；`WorkerCapabilities`（:33-70）；`opencodeVersion`（:93）；`SessionQuestionInfo`（:390-414）；`SessionPermissionPayload`（:481-495）；`UNKNOWN_MODEL_KEY`（:372） | **中** | `message.part.delta` 与 opencode v1 事件**同名碰撞**（v1 线死后自然消解，但 vteam 侧名要显式化）；question/permission 载荷形态随 v2 变 |
| `worker/Dockerfile` | — | `ARG OPENCODE_CLI_SPEC=opencode-ai`（**未锁版本**，:30-38）；OmO 安装器 `bunx oh-my-openagent@latest install --platform=opencode`（:56-84） | **高** | 未锁版本 ⇒ 镜像里跑的是哪一版不可知；且 `opencode-ai` 永远到不了 v2 |
| `.opencode/package.json` | — | `"@opencode-ai/plugin": "1.18.29"` | **中** | 包名错位；vteam 自身 `package.json` 无 opencode 依赖 ⇒ 生成的 `.opencode/tools/*.ts` 靠 opencode 二进制自带解析 |
| `server/src/workers/worker.client.ts` | ~1210 行 | 控制面**直连 opencode** 5 处：`POST /session`（:299-320）、`POST /session/{id}/prompt_async?directory=`（:336-355）、`GET /api/model`（:589-606）、`POST /session/{id}/abort`（:990-1000）、`GET /session/{id}/message`（:1007+）；baseUrl 解析 `capabilities.baseUrl→capabilities.port→WORKER_BASE_URL`（:1101-1112）；Basic 鉴权用 `SERVER_PASSWORD`（:283） | **高** | 违反 doc 07 §11.5；且 server 的 prompt body **已漏 `system`**，与 worker 侧（`v1-driver.ts:303` 带 `system`）**已分叉** —— v2 的 `PromptInput`/`delivery`/`agents` 语义会让第二次分叉成为必然 |
| `server/src/chat/message-parts.ts` | 289 行 | 硬编码 part 枚举：`RENDERABLE_PART_TYPES`（:60-65）、`TEXTUAL_PART_TYPES`（:133-137）、`NON_TERMINAL_TOOL_STATUS`（:215-220）；字段四元组 `text` / `summary` / `thoughts` / `detail`（:140-147）；`mergePartsById` 按 `part.id` last-write-wins（:184-212）；单调文本守卫（:158-182） | **中** | v2 的 `content[]` 结构与 tool `state.content[]` 需要归一化入口；web 直读 `parts[]` |
| `server/src/workers/worker-event.ingress.ts` | — | `message.part.delta` 入库（:596-829）：会话反查（:602-607）、part 累积、1000ms 落库节流、广播；持久化到 `Message.content = {text, parts[]}`（:710-712、:817-820） | **中** | 幂等原本靠内存 TTL Map（worker 自己的 `evw_<bootId>_<seq>` 随 worker 重启变 ⇒ worker 一重启重放就重复落库）→ **P2b 已改用上游身份键**（跨 worker 重启成立）；**server 重启仍丢去重状态**（内存表，见 §8.2 已知限制） |
| `server/src/workers/workers.service.ts` | — | 调度器**精确版本串相等**过滤：`x.worker.opencodeVersion === req.opencodeVersion`（:919-920） | **中** | 全仓唯一的版本闸门；没有 semver；新旧 worker 混跑时靠它天然隔离 |
| `server/src/tasks/tasks.service.ts` | — | 解析 `opencodeAgentName`（显式 > 角色默认 > null，:2049-2118），作为 `prompt_async` 的 `agent` 字段 | **中** | 该字段在 v2 变成"agent 注册键"（D6） |
| `server/src/agents/agents.service.ts` | — | `GET /agents/opencode` 代理 → worker → serve `GET /agent`，列表不可用时打 `degraded`（:551-610） | **中** | 端点换 `/api/agent`；`degraded` 降级路径是静默降级的另一个面 |
| `server/src/common/opencode-agent-duty.ts` | — | `VTEAM_PLAN_AGENT_NAME='vteam-plan'`（:29）；计划职责 agent 名集 `{plan, prometheus, vteam-plan}`（:39-46） | **低** | 是 vteam 侧字面名，不随 opencode 版本变；只需确认 v2 侧 agent 名仍可用 |
| `server/src/common/constants/event.constants.ts` | — | `MESSAGE_PART_DELTA='message.part.delta'`（:29） | **低** | 与 opencode v1 事件同名；v1 死后消解，但 vteam 侧应显式改名 |
| `server/src/realtime/realtime.service.ts` | — | `message.part.delta` 明确**排除**在 SSE 保留集外（:126-128）；web 用 React Query 轮询 messages 表，不走 `EventSource` | **低** | 事件名变更**到不了 web**；但 part schema 变更会（web 读 `p.state.status`/`p.tool`/`p.id`/`p.synthetic`） |
| `web/src/components/chat/msg-parts.tsx` | — | `PartShape` 是 opencode part 的宽松镜像（:58-77）；`toToolStatus` 把 `state.status` 映射 4 态（:111-121）；按 `part.type` 分派（:176-189、:262-282） | **低（已验证无需改动）** | web 消费的是 vteam 信封（DB 里的 `parts[]`），不是 opencode 原始事件；**P2b 已验证 v1 与 v2 的落库形态在 web 实际读取的字段上完全相同** ⇒ web **零改动**（见 T20） |
| `web/src/components/chat/msg-tool.tsx` | — | `MsgToolStatus = running/success/failed/awaiting-input`（:31-41） | **低（已验证无需改动）** | `toToolStatus` 本就 `toLowerCase()` 后按 `running\|streaming\|pending\|queued`→running、`failed\|error\|aborted\|cancelled`→failed、其余→success 映射；**v2 的工具态取值是小写、与 v1 同族** ⇒ 现有四态映射继续有效，**无需改动** |
| `server/prisma/schema.prisma` | — | `Session.instanceRef` 存 opencode `ses_` id（:328）；`Message.content` Json（:385-411）；`Worker.opencodeVersion`（:902）；`TeamMember.opencodeAgentName`（:198）；`AgentRole.defaultOpencodeAgentName`（:150） | **低** | **零 DDL**：v2 的 `ses_` id 前缀不变，`instanceRef` 无需改 |

### 3.2 v1 字面量清单（vteam 分支依赖的 opencode 字面量）

| 字面量 | 出现位置 | v2 现状 | 破坏形态 |
|--------|----------|--------|----------|
| `step-finish` | `prompt-await.ts:393`、`:297`、`:304`；`v1-driver.ts:139-154` | **上游不存在**（v2 是 `session.step.ended` 事件） | **完成判定失效** → 执行永不判终态。⚠️ **对策不是"忽略"，而是"合成"**：v2 driver 从 assistant 消息的 `finish`/`tokens`/`cost` **合成一个 `step-finish` part** 再上送——它是控制面的「本轮完成」幂等键（`worker-dispatcher.ts` 的 `findStepFinishPartKey`），**丢弃即失效** |
| `stop`（reason） | `prompt-await.ts:393` | 不存在 | 同上 |
| `tool-calls`（reason） | `prompt-await.ts:304` | 不存在 | 卡工具循环的诊断分支失效 |
| `reasoning` | `prompt-await.ts:454`、`:404`、`:435-460` | 存在（`content[].type:"reasoning"`） | 位置变（`parts`→`content`），语义保留 |
| `synthetic` | `prompt-await.ts:411`、`:451` | **v2 assistant content 项无 `synthetic` 字段** | 合成文本过滤失效 → 工具占位文本污染最终回复 |
| `native` | `v1-driver.ts:107`（agent 信息） | v2 `Agent.Info` 无 `native`（有 `hidden`/`mode`） | 内置/自定义 agent 区分失效（UI 展示） |
| `pending`（tool state） | `prompt-await.ts:468`、`:729` | **v2 无 `pending`** | 在飞工具豁免 + 进度指纹排序需重定义 |
| `running` | `prompt-await.ts:468`、`:729` | v2 有（**小写** `running`；`Running` 只是 OpenAPI 类型名）但 `input` 是 object 不是 string | 进度指纹的 input 长度计算需改 |
| `streaming` | `prompt-await.ts:729` | v2 是独立 state 变体 | rank 语义需重定义 |
| `state.output`（string） | `prompt-await.ts:747` | v2 改 `state.content`（**array**） | 工具输出长度/内容抽取失效 |
| `que_` | `v1-driver.ts:333`、`:348`（注释级前缀假设） | v2 form id 前缀未知 | ID 前缀假设失效（仅注释/诊断） |
| `per_` | `v1-driver.ts:378`、`:408` | v2 permission request id 前缀未知 | 同上 |
| `ses_` | `v1-driver.ts:259`；`prisma` `instanceRef`；`exec-server.ts:91` | v2 仍是 `ses_`（`Session.Info.id`） | ✅ 不变 |
| `prt_` | `prompt-await.ts:704-705`（part id 前缀） | v2 part id 语义变为 `content[].id`（tool 项有 `id`） | delta 键控失效（v2 事件用 `assistantMessageID`） |
| `msg_` | `prompt-await.ts`（v2 inbox item id `msg_…`） | v2 inbox item id 为 `msg_` | 与 v1 message id 前缀碰撞（v1 message id 也在 `msg_` 系） |
| `message.part.delta` | `worker-protocol.ts:18`；`event.constants.ts:29`；`ingress.ts` 全文 | v2 **无此事件名**（⚠️ v2 源码含 v1 legacy 事件定义 `schema/src/v1/legacy-event.ts`，**不得依赖**——vteam 按 v2 事件实现，legacy 事件若出现应忽略 → Q13） | vteam 侧同名碰撞；需改名 + 新映射 |
| `message.part.updated` | `serve-event-stream.ts:230` | v2 无（⚠️ 同上：v2 源码含 legacy 事件定义，**不得依赖** → Q13） | 整 part 快照通道消失 → 改为 `session.message.content.updated` |
| `message.updated` | `serve-event-stream.ts:225` | v2 无（⚠️ 同上：v2 源码含 legacy 事件定义，**不得依赖** → Q13） | assistant 消息集合建立通道消失 → 改为 `GET /api/session/{id}/message` 轮询 + `session.step.started` 事件 |
| `server.connected` | `serve-event-stream.ts:221` | v2 有同名事件 ✅ | ✅ 语义可用（仍为 ephemeral） |
| `bash`（权限 action） | 权限配置经 `opencode-config-builder` 透传 | v2 归一化为 **`shell`**（另 `task`→`subagent`、`write`/`patch`→`edit`） | 权限语义漂移（有副作用工具默认策略落到错 action） |
| **`prompt`（agent 配置键）** | vteam 角色提示的候选落点（本文档早期版本按此假设） | **处置取决于所在的节**（2.0.28 实测）：v1 形 **`agent:`** 节内 → **被迁移为 `system`**（值不丢）；v2 原生 **`agents:`** 节内 → **是未知键，静默丢弃、无任何告警** | ⚠️ **节名与键名必须同时改**——只把节名改成 `agents` 而沿用 `prompt` 键 ⇒ 所有角色提示静默丢失 |
| **`system`（agent 配置键）** | vteam 侧尚未使用 | **v2 原生键**（在 v2 原生 `agents:` 节内实测归一化后原样保留；⚠️ 放在 v1 形 `agent:` 节内则被挪到 `request.body.system`，**inert 不生效**） | 角色提示的正确落点：**`agents.<n>.system`**（T15 写入、T4 验证运行时生效） |
| `agent`（配置节） | `opencode-config-builder.ts:48-64`；`injector.ts:333-412` | v2 归一化为 `agents` | 键名改（归一化能兜，但显式写新键更稳） |
| `mcp`（配置节，扁平） | `injector.ts:468-491`、`:670-701` | v2 归一化为 `mcp.servers` | 键名改 |
| `plugin`（配置节） | `injector.ts:512-525` | v2 归一化为 `plugins` | 键名改 |
| `provider`（配置节） | `model-credential-injector.ts:92-97`、`:197-292` | v2 保留，但子键 `npm`→`package`、`options`→`settings` | 子键改 |
| `npm` | `model-credential-injector.ts`（provider 键） | v2 → `package` | 模型 provider 加载失败 |
| `options` | 同上 | v2 → `settings` | baseURL 丢失 → provider 不可用 |
| `reasoning`（模型能力） | `model-credential-injector.ts:156` | **被丢弃（WARN）**；且 **v2.0.28 也没有 per-model `reasoning` / `temperature` 的落点**（归一化后被剥除，`GET /api/model` 里也不存在） | 模型能力声明静默失效 → 改由 `capabilities:{tools,input[],output[]}` 承载；**T7 刻意不写该键**（基于实测的取舍，不是遗漏） |
| `tool_call` | `model-credential-injector.ts:159` | **被丢弃（WARN）** | 同上 |
| `attachment` | `model-credential-injector.ts:158` | **被丢弃（WARN）** | 同上 |
| `modalities` | `model-credential-injector.ts:160-161` | **被丢弃（WARN）** | 同上 |
| `@opencode-ai/plugin` | `custom-tool.ts:164`、`git-tools.ts:746`、`browser-tools.ts:147`、`.opencode/package.json` | v2 → `@opencode/plugin` | 生成的工具文件 import 失败 → 工具全部不可用 |
| `--pure` | `opencode-server.ts:355-388`；`mcp-status-probe.ts:144-148` | **不存在** | worker 启动 exit 1 / MCP 探针 `mcp list --pure` **exit 1**（**显式失败，非静默**） |
| `opencode 1.19.0`（版本串形） | `index.ts:87`；`opencode-server.ts:292` | v2 → `opencode v2.0.28` | 版本闸门解析失效 |

---

## 4. 架构决策

### D1. 单轨切到 v2，保留接口抽象，不做 V1/V2 双驱动并存

- **决策**：落地 doc 07 §9.2 已定义但从未实现的 `OpenCodeDriver` 接口；只交付一个 v2 实现；删除 `V1Driver`；保留接缝。
- **理由**：v1 线已冻结（`opencode-ai@latest`=1.19.3 不再发版），双驱动的维护面翻倍却服务一条死线；但没有接口抽象则下次 v3 是重写而不是换实现。
- **影响**：新增 `worker/src/driver/opencode-driver.ts`（接口）+ `worker/src/driver/v2-driver.ts`（实现）；`exec-server.ts` / `index.ts` 只依赖接口。
- **删除时机（采纳 §9.3 的回滚保险建议）**：`v1-driver.ts` **不在 T8 删除**，删除动作统一延后到 **T18** 一次性完成。这样 P0–P4 期间仍保留"退回 v1"的代码级退路；T18 完成即彻底单轨。
- **风险**：接口抽象容易在实现时泄漏 v2 细节。**对策**：接口方法的入参/出参全部用 vteam 自有类型（`SessionRef` / `PromptInput` / `ModelInfo` / `MessageSnapshot` / `RoleAgent`），v2 的 `Session.Inbox.User` / `Content[]` 等类型不外泄到 `exec-server.ts`。

### D2. 前置项：锁版本 + 启动期版本闸门（fast-fail）

- **决策**：`worker/Dockerfile:30` 改 `ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`；worker 启动解析 `opencode --version`（v2 形如 `opencode v2.0.28`），**要求主版本 ≥ 2**，否则 fail-fast 并给出可操作错误。
- **理由**：当前镜像装的是未锁版本的 `opencode-ai`（永远到不了 v2，且版本不可知）；而 `workers.service.ts:919-920` 用精确版本串相等做调度过滤——版本闸门必须先于任何 v2 worker 上线。
- **影响**：`opencode-server.ts:292` `detectVersion()` 改为解析 `opencode v(\d+)\.(\d+)\.(\d+)`，暴露 `major`；`index.ts:87` 同步；`Worker.opencodeVersion` 上报值改为规范化 semver 串。
- **风险**：`opencode --version` 输出格式若再变会误杀。**对策**：解析失败时**不**直接判死，而是报 `unknown` 并在启动日志里明确"无法判定版本"，同时由调度侧过滤（`workers.service.ts` 的精确串过滤已能挡住错版本 worker 被选中）。

### D3. 控制面彻底不直连 opencode（兑现 doc 07 §11.5）

- **决策**：把 `server/src/workers/worker.client.ts` 的 5 处 opencode 直连收进 worker 现有 exec HTTP 面：新增 `POST /sessions`、`POST /sessions/:id/prompt`、`POST /sessions/:id/abort`、`GET /sessions/:id/messages`、`GET /models`；控制面只调 worker。
- **理由**：今天 server 的 prompt body 已经**漏掉 `system`**（`worker.client.ts:336-355` vs `v1-driver.ts:303`），两处 prompt 构造已分叉；v2 的 `PromptInput` + `delivery` + `agents` 语义会保证第二次分叉。两套 prompt 构造器 = 必然出第二个 bug。
- **影响**：多一跳网络；`worker.client.ts` 缩到只调 worker；`agents.service.ts` 的 `GET /agents/opencode` 代理链不变（已是 worker→serve）。
- **风险**：worker 不可用时控制面拿不到模型列表（已有 `degraded` 降级路径，`agents.service.ts:551-610`），需确保该降级仍可用。

### D4. 事件层：v2 事件 → vteam 内部事件，`durable.seq` 做幂等键

- **决策**：新建映射层，把 v2 事件翻译成 vteam 现有信封；幂等键**优先用上游身份**（`durable.aggregateID + durable.seq`）替换"只用 worker 自己的 `(workerId, eventId)`"口径；**只依赖 durable 事件**做状态判定；断线重连后**优先**用 `GET /api/experimental/session/{sessionID}/log?after=<lastSeq>&follow=` 补齐 durable 事件，**消息轮询 `GET /api/session/{id}/message` 作为二级兜底**。
- **理由**：v2 帧无 `event:` 名、类型在 `data.type`；**只有 durable 事件**带 `durable.seq`，它提供了 per-session 单调序号（**ephemeral 帧没有 durable 块**——实测 `session.text.delta` / `session.usage.updated` / `permission.*` / `form.*` 都没有 ⇒ 状态判定只能用 durable 事件）。`/api/event` 的 volatile 契约（慢消费者 overflow、断线期间事件丢失）过去只能靠"轮询消息重建状态"来兜——**v2 现在提供了一等公民级的缓解手段：按聚合的 durable 事件日志可重放**（`/api/experimental/session/{id}/log?after=<seq>`），能**按 seq 精确补齐**断线期间的 durable 事件，而不只是"看一眼最终状态"。消息轮询保留为二级兜底（覆盖 ephemeral 语义与非消息类状态）。**幂等键为什么必须换成"上游身份"**：worker 自己生成的 `evw_<bootId>_<seq>` **随 worker 重启而变**，用它做键 ⇒ worker 一重启，重放同一条上游事件就会被当成新事件再落一次库。
- **幂等键的四层设计**（P2b 已落地，`dedupKeyOf()` 唯一构造点）：

  | 事件类别 | 键 | 跨 worker 重启仍成立 | 跨 server 重启仍成立 |
  |---|---|---|---|
  | durable 上游（有 `aggregateId` + `seq`） | `upstream:<aggregateId>:<seq>` | ✅ | ❌ |
  | ephemeral 上游帧（带 `ordinal`） | `upstream:<eventId>:<ordinal>` —— ⚠️ **唯一性来自 `eventId`**，`ordinal` 只是随行（它**不是**逐帧计数器，见下方更正） | ✅ | ❌ |
  | ephemeral 上游但**无** `ordinal`（拉取派生：permission / question） | `upstream:<eventId>`（**上游对象 id**，如 `per_…` / form id） | ✅ | ❌ |
  | **无上游身份**（心跳 / `instance.created` / `git.op` / 老 worker） | `worker:<workerId>:<eventId>`（今日行为，不变） | ❌ | ❌ |

  ⇒ **跨 worker 重启的重复落库已修掉**（上游身份稳定）；**跨 server 重启仍会丢全部去重状态**（去重表在**内存**里，见 §8.2 已知限制）。
  **⚠️ `ordinal` 的真实语义（P2a 实机抓帧更正）**：`ordinal` 是「同类内容流」的序号，**不是逐帧计数器**——同一条 assistant 消息的多帧 delta **全是同一个 `ordinal`**。⇒ **不可用它做逐帧单调闸门、也不可用它做逐帧去重判别**（否则同一消息的多个 delta 会被折叠成一条）；**逐帧去重只能靠帧 id**（`evt_…` 唯一）。上面的键里虽然带着 `ordinal`，但**唯一性完全由 `eventId` 贡献**。
  **刻意的设计决策**：**同 `ordinal` + 不同 `eventId` ⇒ 视为不同事件**——宁可多处理一次，也不吞掉一条真实增量；重复应用无害，因为 `mergePartsById` 是 last-write-wins、单调文本守卫又阻止文本回退。
- **影响**：`serve-event-stream.ts` 重写；`worker-event.ingress.ts` 的去重键改为上面的四层口径（上游身份随事件负载下发给 server）；**vteam 事件名 `message.part.delta` 保持原名**（原"改名以避开 opencode v1 同名碰撞"的提案**已取消**，理由见 T12 验收标准 4）；新增"断线 → 记 `lastSeq` → 重连 → 拉 log 补齐 → 再接 SSE"的恢复流程。
- **终态判定收口（P2a 已落地：终态闸门 `RunTerminalGate`）**：durable 的 `session.execution.succeeded/failed/interrupted` **不直接发送**——映射出的终态事件只标记 `terminal`，**交终态闸门统一裁决后再发**。闸门规则：① **事件证据优先于轮询证据**（事件路是权威，轮询路是兜底）；② `settle()` 是**一次性**的（第二次调用返回空 ⇒ 终态事件只允许发一次）；③ **陈旧的 durable `seq` 不能覆盖更新的证据**（SSE 与将来的 durable-log 补齐两条路会送来同一条事件）。**为什么必须收口**：事件路与消息轮询路**都**能判出终态，不收口就会发两次 `task.completed`——server 侧按 `step-finish` 幂等键挡得住用量落库，**但挡不住前端重复的「已完成」提示与 watchdog 计时**。
- ⚠️ **闸门的一条微妙不变量（P3 在实现时发现的真实 bug）："先问后记"**——`peek()` 返回的是「**事件证据 ?? 轮询证据**」，所以**如果先 `notePolling()` 再问 `peek()`**，闸门就再也分不清「**事件路还没说话**」与「**事件路说了 succeeded**」⇒ 一条**迟到的失败**会被**静默丢弃**（把失败判成成功）。⇒ **必须"先问闸门、再记自己的证据"**；在宽限期内尤其不能提前 `notePolling`（否则宽限期就失去了意义）。这条很容易被后来者无意破坏，**改动闸门相关代码时必须连带复核这条顺序**。
- **风险**：ephemeral 事件（`session.idle`、`permission.asked`、`form.created` 等）不可重放（durable log 只含 durable 事件），**不得**用于状态判定，只能用于"触发一次动作"（如拉一次 permission/form 列表）。映射表必须逐条标注 durability。另：log 端点在 `experimental` 命名空间下，**其路径与返回形态需在锁版基线里确认**（T1 快照 + T13 实现时复核）。**另：去重表在内存 ⇒ server 重启后去重状态全丢**（零 DDL 约束下不引入持久化去重表），这是**已知限制**而非待修缺陷。

### D5. 数据模型：`parts[]` → `content[]`，渲染层双形态兼容

- **决策**：**上游**消息形态变了（v1 `parts[]` → v2 `content[]`），但**落库/渲染形态不变**——因为 **v2 driver 在边界就把 `content[]` 归一成了 vteam 既有的内部模型**。历史 `Message.content.parts`（v1 形态）**不做全量回填**，改由**存储形态边界**归一：server 侧在 `server/src/chat/message-parts.ts` 落 `normalizeParts()`，把「裸数组」「v1 形 `{parts:[…]}`」「v2 形 `{content:[…]}`」三种输入收敛到**同一个内部渲染模型**。**web 侧不需要镜像归一**（P2b 已验证：v1 与 v2 的落库形态在 web 实际读取的字段上**完全相同**）⇒ **零数据迁移、零 web 改动**。
- **理由**：历史体量大；v1→v2 映射有损（v1 `step-finish` part 带 tokens/cost，v2 里在 message 顶层与 `session.usage.updated` 事件上，回填会丢信息或造信息）。**但"有损"只发生在上游形态之间**——归一之后落库的形态与 v1 时代**逐字段相同**，所以既不需要回填，也不需要动 web。
- **影响**：`message-parts.ts` 落一个**总函数**（任何输入都不抛错；不可识别输入降级为空 part 集 + 一条 WARN，且**只记形状不记内容**；`null`/`undefined` 静默降级）；`worker-event.ingress.ts` 与 `worker-dispatcher.ts` 落库时写**内部模型**（不是 v2 原始 `content[]`）；**web 侧零改动**（`msg-parts.tsx` / `msg-tool.tsx` 保持原样）。
- **part id 方案（P2a 已落地的口径，比原计划的 `${messageID}:${index}` 更细）**：driver 合成的 content id 与事件路必须**完全一致**——事件路只知道「这是哪条消息的哪类内容」，拿不到 index，两路 id 不一致时 server 侧按 id 合并（`mergePartsById`）会把**同一段正文存成两个 part**（正文重复）。因此 worker 在**上送边界**把两路统一到同一套 id：**文本** → `${messageID}:text`；**思考** → `${messageID}:reasoning`；**工具** → `${messageID}:tool:${callID}`（`callID` = provider 侧调用 id，两路都有）；**`step-finish`** → `${messageID}:step-finish`（**原样不动**——控制面的 `findStepFinishPartKey` 按 part id 做「本轮完成」幂等键，改了会打断既有键）。**同类内容在同一消息里出现多条时**（罕见）保留序号消歧（`${messageID}:text:${index}`）。⚠️ 两条硬约束：**① id 方案必须单点来源**（driver 与事件映射共用**同一个** helper）；**② id 必须在重复轮询之间稳定**（server 按 `part.id` 合并，不稳定就会把同一段正文存成多份）。v1 驱动的 serve 原生 id（`prt_…`）不匹配该形态 → 原样透传，**不动 v1 行为**。
- **风险**：同一会话内混形态（老消息 v1、新消息 v2）时 `mergePartsById` 的键冲突——v1 用 `part.id`，v2 tool content 有 `id`、text/reasoning 无 id。**对策**：归一后统一生成内部 id（v1 用 `part.id`，v2 用 `messageID + contentIndex`）。

### D6. 角色注入：v2 prompt body 没有 `system`，必须换载体

- **决策**：**三种内容、三个载体，互斥**——
  ① **逐 agent 的静态角色提示** → **(a′) 写进 `agents.<name>.system`**（v2 原生键；**节名 `agent`→`agents` 与键名 `prompt`→`system` 必须作为同一次原子改动落地**）**＋ (b) `POST /api/session/{sessionID}/agent` 激活**（或建会话时带 `"agent"`）——**两者均已实测生效 ✅**（T4）；② **逐消息、逐成员的 blob**（平台协议 / 岗位职责 / 派发规则 / 记忆规则 / 团队上下文…）→ **(f) 插件交接（`v2-system-handoff`）**：worker 把 blob **原样**写进 `<workDir>/.vteam-system-handoff/<sessionID>.txt`，插件在 `ctx.session.hook("context")` 里读它并 `event.system.push({type:"text",text})` ⇒ 落在**模型请求的 system 段**——**已实现并实机证明 ✅**（见下方「已落地的载体路由」）；③ **两者都拿不到时** → **(d) 文本前缀注入**（blob 拼在正文前，落在 **user 段**）——**永远是可用的地板**（与 opencode 版本无关）。❌ **候选 (c) prompt body `agents:[{name}]` attachment —— 已被 T4 证伪，是 no-op，从本决策中移除**。另：**(e) `ctx.session.hook("prompt", cb)`（改写 `prompt.text`）不用于 blob**——它改的是 **user 文本**、不是 system 段，与 blob 的语义不同；保留 T4 的实测记录即可。
- **理由**：v2 的 prompt body `additionalProperties:false` 且**没有 `system` 字段**——v1 的「逐消息 system」载体直接消失。**配置层实测结论（2.0.28，隔离 `HOME`/`XDG_*`，一份配置同时含 `agent:` 与 `agents:` 两节）**：`prompt` 键的处置**取决于它所在的节**——在 v1 形 **`agent:` 节**内 → **被迁移为 `system`**（值不丢；同节 `prompt` 与 `system` 并存时 `prompt` 胜出、原 `system` 落到 `request.body.system`）；在 v2 原生 **`agents:` 节**内 → **是未知键，被静默丢弃、没有任何告警**。⇒ 若 T15 只把节名改成 `agents` 而沿用 `prompt` 键，**所有角色提示会静默丢失且没有任何错误信号**——**这是本计划里最重要的静默降级陷阱**。**运行时层实测结论（T4）**：`agents.<name>.system` 的内容**确实进入最终模型请求**（被**前置**到 opencode 内置 system 段之前）；`POST /api/session/{id}/agent`（204）之后该 agent 的 system 会被应用到**后续 turn**。**但静态 `agents.<name>.system` 是「逐 agent」的，装不下 vteam 逐派发现拼的 blob** ⇒ (f) 插件交接补上这一段（**T4.5b 已实测 `ctx.session.hook("context")` 能往 system 推段**，本次把它**产品化**）。
- **已落地的载体路由**（`v2-driver.ts` 的 `routeSystemBlob` → `'none' | 'prefix' | 'plugin'`）：

  | agent 有配置化 `system`？ | 插件路径生效？ | 动作 | blob 落在 |
  |---|---|---|---|
  | 有 | – | **整段 blob 不注入**（T15 既有的闸门）＋ 清掉交接文件 | – |
  | 无 | 是 | 写交接文件，**不**拼文本前缀 | **模型请求 system 段** |
  | 无 | 否（产物缺失 / location 未就绪 / 写失败） | **文本前缀**（逐字节照旧）＋ 既有告警 | user 段 |

  **互斥是结构性的，不是巧合**：走前缀兜底时**总是** `clear()` 交接文件 ⇒ 插件永远不会也推同一段 blob；agent 配置化 `system` 的闸门位于两条路**上游**。
- **影响**：`opencode-config-builder.ts` 与 `injector.ts` 的 `agent` 节形态从"vteam 拼的字符串"变成"vteam 写的配置对象"（**节名 `agents` + 键名 `system`，二者是一次原子改动**）；`tasks.service.ts:2049-2118` 解析出的 `opencodeAgentName` 变成**agent 注册键**（用它查 `agents.<name>.system`，再 (b) 激活）；**driver 在发 prompt 前要先发 `POST /api/session/{id}/agent`（或建会话时带 `agent`）**——这是新增的一跳；**新增插件交接产物**：`<workDir>/.opencode/plugins/vteam-system-handoff.ts`（常驻产物，manifest 键 `systemHandoffPlugin`）+ 交接目录 `<workDir>/.vteam-system-handoff/`。
- **风险**：① **交接文件的逐字节稳定性是 load-bearing 的**（见 §8.2）：插件在 agent 循环的**每一次**模型请求都会触发，而 provider 的 prompt 缓存按 **token 前缀**命中 ⇒ 文件里多一个时间戳/计数器就会**击穿整个会话的前缀缓存**；**对策**：compare-then-write（同内容不重写）+ 插件只读不写 + 交接文件**逐字节等于 blob**（不重新序列化）+ 真二进制的"两次派发逐字节相同"断言。② **首次派发落到未就绪 location** ⇒ 退回文本前缀（安全、绝不丢 blob）；生产流里会话 `move` 会先启动该 location ⇒ 从第一次派发起就是插件路（已实机证明）。③ **`context` hook 只覆盖 primary 请求**（标题 / 压缩 / generate 各有独立 hook）——上游行为未变 ⇒ 标题请求不带 blob（与 v1 一致）。④ **T15 的节名+键名改写必须是原子的**——验收要断言最终配置里 `agents.<n>.system` 存在、`agents.<n>.prompt` 不存在，且 v2 归一化回显（`GET /api/config`）里角色提示仍在。

### D7. 在飞注入（direct-inject）改用 v2 原生 `delivery`

- **决策**：vteam 的"忙 → 注入同一会话"映射到 `POST /api/session/{id}/prompt` 的 `delivery:"steer"`；"等当前 run 跑完再处理"映射到 `delivery:"queue"`；v1 的 `abort` 映射到 `POST /api/session/{id}/interrupt`（`?resume=false` = 纯中断；`?resume=true` = 中断后恢复待投递的 steering 输入与队列中的下一项控制指令，排队中的 prompt 仍停放）。
- **理由**：v1 靠"agent 循环每 step 边界重读消息库"的 de-facto steer（仓库自己记录过竞态窗口）；v2 用 durable inbox 原生表达，无竞态。实测 `delivery:"queue"` 的事件序列：`session.inbox.enqueued` → `session.execution.started` → `session.instructions.updated` → `session.inbox.delivered` → `session.step.started`。**实测（T4）`delivery:"steer"` 在"当前无活跃 run"时 = 立即执行**：`session.inbox.enqueued` → `session.execution.started` 两者相隔 **2~33 ms**（多次运行观测），**不排队等待下一轮**。⇒ vteam 的"非在飞时也用 steer"分支可以放心走 steer，**无需**为"无 run"再分叉到别的 delivery。
- **影响**：`exec-server.ts` 的 `runExecution` 轻量注入路径（`direct-inject-inflight.md` B2）改为带 `delivery` 参数；**终态判定不是"改成事件优先"，而是"事件路与轮询路合流到同一个闸门"**——`prompt-await.ts` 通过 `EventSignal` 接口拿到本次 run 的终态闸门（`peek` / `notePolling` / 可选 `firstToken`），**先问后记**、**不自己发终态**（详见 T14）。**为什么不能"改成只看事件"**：v2 driver **丢弃了 `idle` 消息**（承载 run 级 `outcome` 的那条），轮询路**结构上看不到 run 级结论**（只看得到"某一步以 stop 收尾"）⇒ 轮询路只能**向闸门借**事件路的判定，而不是自己重写一套完成规则。**追加事实**：v2 的 prompt **默认 delivery 就是 `steer`**（body 不写也返回 `"delivery":"steer"`）；`POST /api/session/{id}/prompt` 返回的是**入队项**（`Session.Inbox.User`）**不是最终答复**——终态必须看 `session.execution.*` 事件或 `GET /api/session/{id}/message`。
- **风险**：① `delivery:"steer"` 在"当前无 run"时的行为**已实测为立即执行 ✅（Q11 关闭）**——残余风险不在语义，而在**实现**：driver 若不检查返回体是入队项，就会把"入队成功"误当"执行完成"。**对策**：终态只能由**闸门的一次性收口**发出，不认 prompt 的 200 响应。② **合流缝若不被激活**（exec-server 没把闸门交给 `sendAndAwait`）⇒ 两条判定路径各发一次终态——**T14 验收标准 8** 把这条列为硬闸门。

### D8. 插件 / 工具 API 重写

- **决策**：三个生成器（`custom-tool.ts` / `git-tools.ts` / `browser-tools.ts`）的**产物形态必须改变**：从"`.opencode/tools/<file>.ts` 导出 `tool({…})`"改为"**`.opencode/plugins/<file>.ts` 导出 `Plugin.define({id, setup})`，在 `setup` 里 `ctx.tool.transform(editor => editor.add({name, description, input: <JSON Schema>, options:{codemode:false}, execute(input, ctx) => ({content})}))`**"——入参从 Zod 改 JSON Schema、返回值从 string 改 `{content}`、**必须显式写 `options:{codemode:false}`**（否则模型只能经 Code Mode 调，与 v1 行为不等价）；`browser-tools.ts` 的 `context.directory` 改取 **`ctx.location.directory`**（v2 的 `ToolContext` 里**没有** `directory`）。采用**双形态插件模块**（同一文件同时导出 v2 `Plugin.define({id, setup})` 与 v1 `async server()` 回退形态），v1 调 `server()`、v2 读 `id`/`setup()` 并忽略 `server()` ⇒ **过渡期一份产物两版通用**；⚠️ **v1 也会尝试调用 `setup`**（实测），所以 v2 分支必须**防呆**：`if (!ctx?.tool?.transform) return`。
- **理由**：v2 插件接口从 hooks 改为 `{id, setup(ctx)}` + 领域对象；`ctx.tool` / `ctx.agent` / `ctx.skill` 是热重载入口。vteam 只需要"自定义工具 + 角色 agent"两个能力。**T5 实测结论**：`.opencode/tools/*.ts` 的**文件自动发现在 v2 已移除**（该目录下的文件**连 import 都不发生**——放在那儿写 marker 的探针没有留下 marker），工具**只能**经 `ctx.tool.transform` 注册；`.opencode/plugins/*.ts` 会被自动发现（`import { Plugin } from "@opencode/plugin"` 由宿主内置解析，**不需要** node_modules）。双形态模块让 P0–P7 的 v1 退路（§9.3 的保险）在**产物层**也成立，不必为过渡期维护两套生成器。
- **影响**：三个生成器的 import 与模板 + **产物落盘路径**（`.opencode/tools/` → `.opencode/plugins/`）；`.opencode/package.json` 改 `"@opencode/plugin": "2.0.32"`（目的不是运行时解析——宿主已内置——而是**编译期检查**）；生成代码需要**编译期检查**（vteam 自身 `package.json` 无 opencode 依赖，生成物靠 opencode 二进制自带解析 → 运行时才发现错误太晚）；v1 hooks 迁到 `ctx.session.hook(...)` / `ctx.tool.hook("execute.before"/"execute.after")` / `ctx.shell.hook("create.before")` / `ctx.permission.hook("evaluate")`（签名从 `(input, output)` 改为**单个可变 event 对象**）。
- **风险**：**"产物形态必须从文件改成插件注册代码"已由 T5 证实 ✅（不再是假设）**——三个生成器的模板要整段重写，工作量显著上升；**对策**：双形态模块方案**已经覆盖**这个形态（T5 已在 1.18.32 与 2.0.28 双侧实测可行），T19 按"插件注册代码"直接排期即可，不再需要为"文件发现是否保留"留分支。另：v1 的 `--pure` 是 vteam 抑制第三方插件/AGENTS.md 注入的手段，v2 无此 flag → **无等价物（T6 已关闭 Q3）**，唯一可靠手段是**隔离 `HOME`/`XDG_CONFIG_HOME`**（**T16b** 落地）；T19 生成的插件文件因此必须落在**项目** `.opencode/plugins/` 下，才能在隔离 env 里被正确发现。

### D9. 四个 CLI 探针逐一重做

> ⚠️ **本决策已被 §2.9 的实测事实修正（真跑栈后）**：v2 的 CLI 子命令绑的是**共享托管后台服务**
> （默认端口 49374），读的是**它自己那套配置作用域**，**不是 worker spawn 的那个 serve**
> ⇒ **"用 CLI 探针观测 serve"在 v2 + 隔离下原理上就是错的**（会静默答错）。
> ⇒ **模型探针与 MCP 探针都改为直读 serve 的 HTTP API**（`GET /api/model` / `GET /api/mcp`，
> Basic 鉴权 + serve 密码），**不留 CLI 兜底**（留兜底 = 让作用域错配重新变成"正常路径"）。
> ⇒ MCP 探针顺带拿到 **v2 的五状态**（`connected`/`pending`/`disabled`/`failed`/`needs_auth`），
> **两端契约同步扩到五态**（见 §2.9 与 T17 的补充验收标准）。

- **决策**：`--version` 解析器改（去 `v` 前缀 + 主版本）；`models` 格式不变不动；`mcp list` 去掉 `--pure` 并重验 glyph 正则；`serve` banner 增加 `server password <pw>` 行解析；`serve --pure` **彻底移除**。
- **理由**：`serve --pure` 在 v2 退出码 1 —— **这一条单独就会让所有 worker 起不来**；`mcp list --pure` **退出码 1**（打印帮助文本 + `Unrecognized flag: --pure`）—— 是**显式失败**而非静默失败：探针只要以**非零退出码**为准即可正确归因，**真正要防的是"忽略退出码、把失败当成空列表"**（那才会退化成静默误报）。
- **影响**：`opencode-server.ts`、`mcp-status-probe.ts`、`index.ts` 三处。
- **风险**：`mcp list` 的 v2 输出 `✓ <name>   connected` 与 v1 的 `● ✓ <name> …` 在 glyph 集合上可能不同（v1 兼容 ASCII `v`/`x`）。**对策**：正则以 v2 实测输出为准重写，并保留 v1 兼容分支直到 v1 线彻底退役。另：v2 CLI 文档已改用环境变量 `OPENCODE_LOG_LEVEL`，**`--print-logs` 属未文档化但 2.0.28 可用**——**不可依赖**，不过**实测确认 v2 的 logfmt 诊断落 stderr、banner 落 stdout**（对 `serve-log.ts` 有利），T2/T7 仍须回归断言落点，必要时改用 `OPENCODE_LOG_LEVEL` + 日志文件路径。

### D10. 认证模型：v2 恒开鉴权

- **决策**：v2 模式下 `OPENCODE_SERVER_PASSWORD` **必填**，为空则 worker 启动 fail-fast 并给出可操作错误；**同时**实现 stdout `server password <pw>` 解析作为显式兜底开关。
- **理由**：v2 恒开鉴权。密码为空时 v2 自动生成随机密码并打到 stdout —— 若 vteam 不解析它，worker 自己的所有请求都会 401，且**错误信息不会告诉运维密码在哪**。fail-fast 与仓库既有姿势一致（如 eabf4c4「模型不存在时快速失败并给出可操作错误」）。
- **影响**：`opencode-server.ts` 的 env 注入（:380）+ 启动校验；`v1-driver.ts`/`v2-driver.ts` 的 Basic 头构造（用户名 `opencode` 不变 ✅）；`worker.client.ts:283` 的 `SERVER_PASSWORD` 语义同步收紧。
- **补充（文档 vs 实测）**：v2 官方文档的认证模型已切到 **pairing code + `opencode service set password` + 30 天会话**，但 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` 在 **2.0.28 实测仍然生效**（设置则用它 → 200；不设置 → 自动生成随机密码打到 stdout → 401）。**vteam 继续用 Basic + `OPENCODE_SERVER_PASSWORD`**，并把 `OPENCODE_SERVER_USERNAME` 列入待配置项（默认沿用 `opencode`）。
- **风险**：`.env.example` 现写"空 = 不设鉴权"（v1 语义）→ 必须同步改文案，否则部署时静默失败。**对策**：T3 同时改 `.env.example` 与 helm values 模板。

### D11. 存储与凭据路径

- **决策**：worker 数据卷需持久化 **SQLite `opencode.db` 与 `auth.json`**（**同一目录、同一卷**）；`cleanupAuthJson` **只删 `auth.json`，绝不动同目录的 `opencode.db`**；`opencode auth export/import` 作为凭据可移植的备选路径。
- **理由**：v2 会话状态在 SQLite，JSON 存储时代不存在；误删 `opencode.db` = 丢会话历史。
- **影响**：`model-credential-injector.ts:301-311` 的清理逻辑；docker volume 挂载清单；`opencode debug paths` 的 `data`/`db` 路径需在 worker 上核对。**worker 可用 `OPENCODE_DB` 显式指定 DB 位置**，便于把会话库放到 vteam 期望的卷上（避免依赖 `~/.local/share` 的默认落点）。⚠️ **落点不是 `~/.local/share/opencode`，而是隔离域**（T16b）：`XDG_DATA_HOME=<HOME>/.opencode-iso/data` ⇒ `opencode.db` = `<HOME>/.opencode-iso/data/opencode/opencode.db`；`<HOME>/.local/share/opencode/` 是 **v1 线**的落点。
- **风险（已按实测订正 —— 原判断已作废）**：~~"v2 启动时会就地迁移 v1 磁盘数据、复用旧 v1 卷的 worker 首次启动会就地改写该卷"~~ ⇒ **在 vteam 的隔离部署下这个前提不成立**：隔离域让 **v1 时代的存储目录落在 v2 worker 的作用域之外** ⇒ v2 **不会**迁移它 ⇒ **v1 时代的历史原样留在盘上**。真正读不了的是 **v2 期间新建的会话**（在隔离域里、v2 形态 SQLite）。⇒ 回滚的正确姿势见 **§9.3**。
- **风险（仅当隔离域被关掉时才成立）**：若有人把 `XDG_DATA_HOME` 指回 v1 的数据目录（或让 `HOME` 回落真实 HOME），v2 的一次性 legacy 导入就**就地**改写旧卷（`GET /api/experimental/migration/v1` → `{"status":"completed"}`），此时 **v1 连卷都读不了**、损失才是灾难级。**对策**：**隔离域是硬要求**（`OPENCODE_ISOLATION_ROOT` 必须落在 v1 数据目录之外）；worker 上用 `opencode debug paths` 核对 `data`/`db` 落点。

**实测依据**（`opencode v2.0.28`，`opencode debug paths`，**带 / 不带隔离各测一次**）：

| 部署形态 | opencode `data` 目录 | `db` |
|---|---|---|
| v2 worker **带隔离域**（T16b：`XDG_DATA_HOME` → `<iso>/data`） | `<iso>/data/opencode` | `<iso>/data/opencode/opencode.db` |
| v1 worker（真实 `HOME`） | `<realHOME>/.local/share/opencode` | `<realHOME>/.local/share/opencode/opencode.db` |

⇒ **两个目录不是同一个** ⇒ 隔离后的 v2 worker **根本看不到** v1 的存储 ⇒ 一次性 legacy 导入在 legacy 路径上**找不到东西、不会触发**。

### D12. 配置静默降级必须可见化

- **决策**：worker 侧 `serve-log.ts` 扩展，识别 v2 的配置归一化 WARN（`message="configuration normalization diagnostic" … kind=unsupported action="omitted unsupported legacy setting"`），升级为 vteam 级**可操作错误**；同时把注入的 provider 段改成 v2 形态（`package` / `settings` / `capabilities`），不再依赖 `reasoning` / `tool_call` / `attachment` / `modalities`；**并把"配置写了 ≠ 生效"这一类静默降级也纳入可见化**——T6 实测：v2 的 `plugins` 数组在多份配置文件之间是**合并**而不是替换（写 `"plugins": []` 是 **no-op**），`instructions` 只能**追加**（写 `"instructions": []` 也**关不掉** `AGENTS.md`），`experimental` 里**没有任何**插件/AGENTS.md 开关 ⇒ 这三条"看着写了、其实没生效"的行为必须靠 **T16b 的隔离 env**（而不是靠配置键）来保证，并在启动日志里显式声明"当前 serve 处于隔离配置域"。
- **理由**：v2 静默丢弃 + 只 WARN ⇒ 模型能力声明悄悄消失，而 vteam 的 `executableModels` 与能力过滤仍按错误数据工作 → 表现为"模型可用但工具调用失败"这类幽灵故障。vteam 已有 `serve-log.ts` 这条"从 serve 日志抓致命条件"的通道（`SERVE_FATAL_KEYWORDS`），扩展它成本最低。**插件侧的同类陷阱更隐蔽**：vteam 写 `plugins: []` 以为清空了插件列表，实际全局插件照样被加载（v1 `--pure` 当初要解决的就是这个问题）——而且**没有任何 WARN**。
- **影响**：`serve-log.ts` 增加归一化诊断识别；`model-credential-injector.ts:197-292` 的 provider 段重写；`injector.ts` 的 `mcp`/`plugin`/`agent` 三节键名与结构改写；`plugins` 数组的**相对顺序**（v2 里顺序即优先级，`-` 前缀禁用）要与 T16b 的隔离方案一起设计。
- **风险**：**简报称注入器当前 `command` 是 string，而代码 `injector.ts:672-676` 实际已产出 `string[]`** → 实施时以代码为准复核；真正要改的是**节形态**（`mcp` → `mcp.servers`）。**另：受管目录残留**——`/etc/opencode`、`/Library/Application Support/opencode` **不受 `XDG_CONFIG_HOME` 控制**（v2 serve 会 watch 它），只有 `policies` 能压制而 policies 属托管配置、项目配置覆盖不了 ⇒ 隔离方案**不是 100% 等价于 `--pure`**（见 T16b 风险与 §10 U9）。

### D13. 文档订正（修正 doc 07 的过期假设）

- **决策**：修订 `docs/agent-platform/07-opencode-v2-调研与架构决策.md`，逐条订正下表，并补一份"实测基线"小节指向本计划。
- **影响**：仅文档；不改代码。
- **风险**：无技术风险；但不改会持续误导后续开发者按"beta + `@opencode-ai/sdk-next` 未发布 + `instructions/entries` 已移除"的错误前提做决策。

| doc 07 位置 | 原文主张 | 订正后（实测 2.0.28 / 2.0.32） |
|-------------|----------|-------------------------------|
| §1 | "v2 处于官方 beta 阶段，尚未正式发布" | v2 已正式发版：`@opencode/cli` 2.0.32；不再有 beta tag 节奏 |
| §6 | SDK 包名 `@opencode-ai/sdk-next`，"未公开发布" | 实际包名 **`@opencode/sdk`**（2.0.32）；v1 线从未以 v2 tag 重发 |
| §6 | 迁移期以 v1 SDK 1.18.14 兜底 | v1 线冻结于 1.19.3，**不再是可依赖的兜底** |
| §4 | "`instructions/entries` 与 `/api/experimental/migration/v1` 已移除" | **两者仍存在**（`PUT/DELETE /api/experimental/session/{id}/instructions/entries/{key}`、`GET /api/experimental/migration/v1` → `{"status":"completed"}`） |
| §9.4 | "v2 角色 = 插件 `ctx.agent.transform` + `switchAgent`" | 方向正确但**不完整**：v2 prompt body 无 `system`；**角色提示的 v2 原生载体是 `agents.<name>.system`**（`prompt` 键在 v1 形 `agent:` 节内被**迁移**为 `system`，在 v2 原生 `agents:` 节内是未知键 → **静默丢弃**），激活机制是 `POST /api/session/{id}/agent`；**T4 已实测该载体确实进入最终模型请求**；**prompt body 的 `agents:[{name}]` attachment 是 no-op**（不得依赖）；本计划以 (a′)+(b) 为主路径、(d) 为兜底 |
| §9.3 | "角色注入 = v1 body 传 `system` 字段" | v2 prompt body **无 `system`**；v1 的 body 字段在 v2 改为配置键 `agents.<n>.system`；**逐消息差异化**（v1 的 `system` 是逐消息的）由**插件交接**承接（`ctx.session.hook("context", cb)` 往 system 推段）——**已实现并实机证明**（D6(f) / T14b）；另有 `ctx.session.hook("prompt", cb)` 可改写 `prompt.text`（改的是 user 文本，不是 system 段） |
| §8 / §11（工具与插件） | "自定义工具写进 `.opencode/tools/*.ts` 即可被发现" | **v2 已移除该发现路径**（T5 实测：文件**连 import 都不发生**）→ 工具**只能**经插件 `ctx.tool.transform` 注册，插件文件放 **`.opencode/plugins/*.ts`**；且**必须显式写 `options:{codemode:false}`**，否则模型只能经 Code Mode 调用（官方插件文档未提及 `codemode`）；`ToolContext` **没有 `directory`** → 取 `ctx.location.directory` |
| §11.5 | "控制面从不直连 opencode" | **当前代码违反**：`server/src/workers/worker.client.ts` 直连 5 处 → D3 收敛 |
| §9.2 | `OpenCodeDriver` 接口"声明但未实现" | 本计划 D1 落地该接口并删 v1 实现 |
| §7 | "跟踪 `@opencode-ai/cli` beta 每日发布" | 改为"跟踪 `@opencode/cli` 正式版 release notes + `https://opencode.ai/v2/docs/migrate-v1/` 与 `https://opencode.ai/config.json` 的 schema 变更" |
| §4 | "v1 端点无统一前缀，v2 统一 `/api`" | 补充：v1.19.3 **同时有 legacy 根路径面与过渡 `/api/*` 面**，v2 **只保留 `/api/*`，legacy 面已移除** |

---

## 5. 实施任务分解

> 排序原则：**先把未知变成已知**（P0 的 spike 阻塞后续设计），再做**传输层**（P1）→**事件层**（P2）→**语义层**（P3）→**配置凭据**（P4）→**控制面收敛**（P5）→**工具插件**（P6）→**存量兼容**（P7）→**验证灰度**（P8）。
> 每个任务格式：编号 / 标题 / 涉及面 / 交付物 / 验收标准 / 依赖 / 风险。
> **P0 的三个 spike（T4 / T5 / T6）已全部关闭**（结论见 `docs/agent-platform/opencode-v2-spike-results.md`）——它们不再是任何后续任务的阻塞项。T6 的结论落地为一个**新任务 T16b**（P4，隔离 `HOME`/`XDG_CONFIG_HOME` 启动 serve）。

### P0 探针与阻塞项（先退役未知）

> **状态**：T4 / T5 / T6 三个 spike **已关闭**（结论见 `docs/agent-platform/opencode-v2-spike-results.md`，可一键复现）——**P0 不再有"待验证的阻塞项"**；剩余的开放未知统一收敛到 §10。T6 的结论落地为 **T16b**（P4）。

#### T1 版本闸门 + 镜像锁版

- **涉及面**：`worker/Dockerfile:30-38`、`worker/src/runtime/opencode-server.ts:289-302`（`detectVersion`）、`worker/src/index.ts:87`
- **交付物**：`Dockerfile` 的 `ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`（带注释说明锁版原因）；`parseOpencodeVersion()` 工具函数（输出 `{major, minor, patch, raw}`，兼容 `opencode v2.0.28` 与 `opencode 1.19.0` 两种形态）；启动期校验（major < 2 → fail-fast）；**选择锁版版本并产出该版本的契约基线快照**（用锁定版二进制重跑一次实测：boot serve → 拉 `openapi.json` → 抓 SSE 原始帧 → dump `/api/config`），快照入库（建议 `.omo/plans/` 同级或 `docs/agent-platform/`）
- **验收标准**
  1. `docker build` 后 `opencode --version` 输出含 `2.`；构建日志打印实际版本（沿用现有 `echo "opencode CLI installed: …"`）。
  2. 单测覆盖三例：`opencode v2.0.28` → major=2；`opencode 1.19.0` → major=1；`garbage` → `unknown` 且**不抛错**（只告警）。
  3. 用 v1 二进制（或 mock 版本输出 major=1）启动 worker → **启动失败**，错误信息含"需要 opencode ≥ 2，当前 1.x，镜像未换 OPENCODE_CLI_SPEC"这类可操作指引。
  4. `Worker.opencodeVersion` 上报值为规范化 semver 串（`2.0.28`），不再是 `opencode v2.0.28` 全文。
  5. **契约基线快照的 `opencode --version` 与锁定版本一致**；快照与本文档 §2 基线之间的**全部差异项逐条登记到 §10 未决问题**（已知差异：`GET /api/model` 的响应包装 2.0.28 `{location,data}` vs 2.0.32 spec 裸数组；live root spec 144 ops vs `/v2/openapi.json` 143 ops）。
- **依赖**：无
- **风险**：解析器对未来版本格式过拟合 → 用宽松正则 + 未识别降级为 `unknown`（不判死）。另：锁版版本与实测基线不一致 → **锁版即锁契约基线**，实现一律以快照为准，差异项先进 §10 再改代码。

#### T2 serve 启动参数重做（移除 `--pure`）

- **涉及面**：`worker/src/runtime/opencode-server.ts:99`（`LISTENING_RE`）、`:334-388`（`spawnServe` / `isPureMode`）、`worker/src/exec/exec-server.ts`（`/config/restart` 走 `restartServe`）
- **交付物**：spawn argv 去掉 `--pure` 分支；删除 `isPureMode()` 的"拼 flag"职责（其"是否启用 OmO"的语义迁移到 T6 的配置层）；`LISTENING_RE` 保留（v2 banner 仍含 `listening on http://…`，非锚定正则继续匹配 ✅）；新增 `SERVER_PASSWORD_RE = /server password (\S+)/` 解析
- **验收标准**
  1. 用真 v2 二进制 spawn：`opencode serve --port <p> --hostname 127.0.0.1 --print-logs` → 进程存活、`GET /api/info` 200；**未鉴权 `GET /api/info` 得 401**（健康探针**必须**用 `GET /api/info`，**不得**用 `GET /`——v2 的 `GET /` 是 web SPA，**未鉴权也 200**，会因错误的原因判活）。
  2. 单测：argv 不含 `--pure`；`OPENCODE_PURE=1` 环境变量存在时也**不**拼 `--pure`（仅记录一条 warn 日志说明该开关在 v2 已失效）。
  3. banner 解析单测：`server listening on http://127.0.0.1:4199` → 端口 4199；`server password AbC123` → 捕获密码。
  4. 端口探测在 v2 下仍工作（随机端口 + 冲突 +1 重试）。
- **依赖**：T1（需要 v2 二进制）
- **风险**：`--print-logs` 在 v2 仍存在但"server logs require --standalone" → **2.0.28 实测已确认 v2 的 logfmt 诊断落 stderr、banner 落 stdout** ✅（`serve-log.ts` 的错误源可用）→ T7 仍须**回归断言**该落点（`--print-logs` 属未文档化行为，**不可依赖**）；若落点变化则同步改 `serve-log.ts` 的路径与正则。

#### T3 认证强制化

- **涉及面**：`worker/src/runtime/opencode-server.ts:380`（env 注入）、`:289-302`（启动校验）、`worker/src/driver/*`（Basic 头）、`server/src/workers/worker.client.ts:283`（`SERVER_PASSWORD`）、`.env.example` 与 helm values 模板
- **交付物**：v2 模式下 `OPENCODE_SERVER_PASSWORD` 空 ⇒ 启动 fail-fast（错误文案指明"v2 恒开鉴权，请设置 OPENCODE_SERVER_PASSWORD"）；**vteam 侧**环境开关 `OPENCODE_ALLOW_GENERATED_PASSWORD=1`（非 opencode CLI flag）：开启时解析 stdout 的 `server password <pw>` 并采用（对应 D10 的兜底）
- **验收标准**
  1. 密码为空 + 未开逃生开关 → worker 启动失败，错误含可操作指引（改哪个环境变量）。
  2. 密码为空 + 开逃生开关 → 从 stdout 解析到密码，后续 `GET /api/info` 带 Basic 头返回 200；日志**不打印明文密码**（只打印"已从 stdout 捕获自动生成密码"）。
  3. 密码错误 → `GET /api/info` 得 401，driver 抛 `DriverRequestError` 且 status=401 被上层归类为**配置错误**而非网络错误。
  4. `.env.example` 与 helm values 的注释改为"v2 必填"，不再写"空 = 不设鉴权"。
  5. **健康探针断言**：未鉴权 `GET /api/info` → **401**，带 Basic 头 → **200**；**不得**用 `GET /` 当健康探针（v2 的 `GET /` 返回 web SPA HTML，**未鉴权也是 200** → 会因错误的原因判活）。
- **依赖**：T1
- **风险**：存量部署未配密码 → 滚动升级时全部 worker 起不来。**对策**：镜像灰度期先在 helm 里显式下发一个生成的密码（见 §9）。

#### T4 角色提示运行时落地验证　**✅ 已完成（PASS）**

> **状态**：**已关闭**。结论文档 = `docs/agent-platform/opencode-v2-spike-results.md`（§2），原始证据 = `docs/agent-platform/opencode-v2-spike-results/evidence/t4-role-prompt.txt` / `t4-plugin-hooks.txt` / `t4-sse-frames.log` / `t5-recorded-model-requests.jsonl`。
> **一键复现**（无需任何 provider 凭据、不连外网）：`bash docs/agent-platform/opencode-v2-spike-results/repro.sh`（可用 `OPENCODE_BIN=...` 换二进制）→ 打印 `T4_RESULTS {"switch_agent_puts_system_in_request": true, "agents_attachment_pulls_system": false, "agents_attachment_is_noop": true}` 与 `T4_STEER_EVENTS`。
> **本任务不再是 T15 的设计阻塞项**——D6 主路径已由实测坐实。

- **涉及面**（实测范围）：`agents.<n>.system` 的运行时生效、`POST /api/session/{id}/agent` 激活、prompt body `agents:[{name}]` attachment、`delivery:"steer"` 在空闲会话上的行为、`ctx.session.hook("prompt"/"context")` 插件钩子
- **实测结论**
  1. **T4.1 ✅ `agents.<name>.system` 确实进入最终模型请求**：mock provider 落盘的 chat-completions 请求体里，system 消息的**第一行**就是角色提示原文，其后才是 opencode 内置的 system 段（`# Your Model` / `# Code Mode` …）→ 角色提示被**前置**，不是替换、不是追加到末尾。
  2. **T4.2 ✅ `POST /api/session/{id}/agent {"agent":"<name>"}`（204）会把该 agent 的 system 应用到后续 turn**：切换后发一条 prompt，最终请求的 system 首行即角色提示；会话里同时新增一条 `type=agent-switched` 消息，并发出 `session.agent.selected` 事件。**追加发现**：`POST /api/session` 时 body 带 `"agent":"<name>"` 同样生效（比先建会话再切换更省事）。
  3. **T4.3 ❌ prompt body 的 `agents:[{"name":…}]` attachment 是 no-op**：最终请求的 system 是**默认 build agent** 的提示；assistant 消息的 `agent` 字段仍是 `build`；**没有** `agent-switched` 消息，**没有** `session.agent.selected` 事件（三条独立证据同时指向 no-op）→ **D6 候选 (c) 被证伪，从计划中移除**。
  4. **T4.4 ✅ `delivery:"steer"` 在无活跃 run 时立即执行**：`session.inbox.enqueued` → `session.execution.started` 相隔 **2~33 ms**（多次运行观测）→ **Q11 关闭**。追加事实：v2 的 prompt **默认 delivery 就是 `steer`**；`POST /api/session/{id}/prompt` 返回的是**入队项**不是最终答复。
  5. **T4.5 ✅ `ctx.session.hook("prompt", cb)` 能改写 `prompt.text`**（durable admission 时）：最终请求的 user 消息变成 `PLUGIN_HOOK_PROMPT_REWRITE::ORIGINAL_USER_TEXT`。
  6. **T4.5b ✅ `ctx.session.hook("context", cb)` 能直接往模型请求的 system 推段**：`event.system.push({type:"text",text})` → 最终请求的 system 里出现注入标记。⚠️ 该 hook **只作用于 primary 请求**（标题 / 压缩 / generate 各有独立 hook）→ 作为**逐条**角色注入载体时必须注意。
- **验收标准（已全部满足）**
  1. ✅ 至少一条路径能在**真实模型调用**的请求里看到角色提示词（用本地 mock provider 记录最终请求体）——`switch_agent_puts_system_in_request: true`。
  2. ✅ 产出包含**可复现的验证步骤**（`repro.sh` 一条命令 + 观察点 + 11 份原始 evidence 捕获）。
  3. ✅ 回答了"角色提示丢失时 vteam 的兜底是否足以维持角色行为"：**不需要兜底**——角色提示真实到达模型，(d) 文本前缀降级为"配置写错时的静默保险"。
  4. ✅ 附带断言：`GET /api/config` 回显里该 agent 的 `system` 存在且内容完整、**无** `prompt` 键（防回归到"`agents:` 节下 `prompt` 被静默丢弃"的老坑）——T15 验收标准 5 可直接沿用。
- **依赖**：T1、T2（已满足）
- **风险**：**已消解**。唯一需要持续留意的是 **`agents[]` attachment 的 no-op**——它是"发出去不报错、agent 收不到角色提示"的静默失败点，**代码评审时要显式检查 driver 没有用它**。

#### T5 v2 工具注册 API 落地方案　**✅ 已完成（PASS，但改变 T19 的产物形态）**

> **状态**：**已关闭**。结论文档 = `docs/agent-platform/opencode-v2-spike-results.md`（§3），原始证据 = `docs/agent-platform/opencode-v2-spike-results/evidence/t5-tool-registration.txt` / `t5-recorded-model-requests.jsonl` / `t5-published-types.txt` / `t5-dual-entrypoint.txt` / `t5-dual-v1.txt`。
> **一键复现**：`bash docs/agent-platform/opencode-v2-spike-results/repro.sh` → `T5_RESULTS {"session.tool.called": true, "session.tool.success": true, "tool": "spike_probe"}`。
> **样例产物**：`docs/agent-platform/opencode-v2-spike-results/v2-tool-plugin.ts`（最小 v2 工具插件）与 `dual-shape-plugin.ts`（v1+v2 双形态模块）。

- **涉及面**（实测范围）：v2 工具声明签名、`ToolContext` 的键集合、`.opencode/tools/*.ts` 与 `.opencode/plugins/*.ts` 的发现行为、插件工具的暴露方式、双形态模块在 v1/v2 双侧的加载
- **实测结论**
  1. **T5.1 声明签名**（发布版类型原文见 spike 文档 §3.2）：`ctx.tool.transform(editor => editor.add({name, description, input: <JSON Schema>, options?, execute(input, ctx) => Promise<Tool.Result>}))`；`Tool.Result.content` 接受 `string | Content[]`（**两种都合法**），但事件侧 `session.tool.success.content` 是**数组**（与附录 B 记载一致）。
  2. **T5.2 `ToolContext` 三项来源**：`sessionID` ✅ **同名保留**、`agent` ✅ **同名保留**、`directory` ❌ **v2 的 ToolContext 里没有**。实测键集合 = `{sessionID, agent, messageID, id, signal, progress}`。→ `browser-tools.ts` 的 `ctx?.directory` 在 v2 恒为 `undefined`，**必须改取 `ctx.location.directory`**（vteam 是"一 worker 一 workDir 一 serve"，语义等价）或 `ctx.session.get({sessionID}).location.directory`。
  3. **T5.3 ❌ `.opencode/tools/*.ts` 的文件自动发现在 v2 已移除**：放在该目录的探针文件**连 import 副作用都没发生**（marker 文件不出现）→ 工具**只能**经 `ctx.tool.transform` 注册（**T19 的产物形态因此改变**）。
  4. **T5.4 ✅ `.opencode/plugins/*.ts` 会被自动发现**：`GET /api/plugin` 出现 `{"id":…,"source":{"type":"local","path":"…/.opencode/plugins/tools.ts"}}`。
  5. **T5.5 ✅ 插件文件里的 `import { Plugin } from "@opencode/plugin"` 能被解析**（宿主内置该模块，**不需要** node_modules / package.json）；静态 import 与动态 `await import()` 都行 → **生成物不必依赖 `.opencode/package.json` 才能被解析**（该文件仍保留，用于 `tsc --noEmit` 编译期检查）。
  6. **T5.6 ✅ 一份 ≤30 行的样例能被真 serve 加载并被模型调用一次**（`session.tool.called` + `session.tool.success` 事件都出现）。
  7. **T5.7 ✅ 双形态插件模块可行**：v1 调 `server()`（并**也会**尝试调 `setup`），v2 调 `setup()` 且**完全忽略** `server()`。⚠️ **v1 也会调 `setup`** → v2 分支必须**防呆** `if (!ctx?.tool?.transform) return`，否则 v1 下会炸。
  8. **T5.8 ❌ 插件工具默认只能经 Code Mode 调用**：不写 `options` 时，工具**只出现在 system 的 Code Mode 目录**里，模型必须写 JS 经 `execute` 调它；写 `options:{codemode:false}` 才进模型的 `tools[]` → **vteam 三个生成器必须显式写 `codemode:false`**（v1 的工具是直接暴露给模型的，语义等价于 `codemode:false`）。⚠️ **官方插件文档从未提及 `codemode`**（活二进制 vs 官方文档的冲突之一）。
  9. **T5.9 ⚠️ `GET /api/plugin` 不可靠**（location 作用域 + 惰性发现 + `setup` 异步）：location 没起来时返回空数组；实测还有"同一次运行里返回 89 条 / 返回 `total=0` 而插件明明已加载"的情况 → **不要用它当"插件是否加载"的判据**，改用 serve 日志的 `msg="loading plugin"` 行 + 工具是否出现在模型请求的 `tools[]`。
- **验收标准（已全部满足）**
  1. ✅ 样例文件在 v2 serve 下被真实加载并被模型调用一次（`session.tool.called` / `session.tool.success`）。
  2. ✅ `browser-tools.ts` 依赖的三个 `context.*` 在 v2 的来源已全部回答（`directory` 需换源）。
  3. ✅ **`.opencode/tools/*.ts` 在 v2 不会被自动发现**——产物形态确定为"插件注册代码"。
  4. ✅ 生成的工具模块在 v2 下如何被解析已回答（宿主内置模块，无需 node_modules）。
  5. ✅ 双形态样例在 **v1 serve（1.18.32）与 v2 serve（2.0.28）下都能被加载**（v1 走 `server()`、v2 走 `setup()`），且两侧都能让工具被调用。
- **依赖**：T1（已满足）
- **风险**：**已消解**（结论确定）。**残留**：① `options.codemode` 未进官方文档 → 锁 `@opencode/plugin` 精确版本 + T19 验收里固化成断言；② `GET /api/plugin` 不可靠 → 不要拿它做判据；③ 插件发现是**按 location 惰性触发**的 → 契约测试里"先建会话/发 prompt、等 ≥6s 再断言"，否则会假阴性。

#### T6 `--pure` 等价物：如何抑制第三方插件 / AGENTS.md 注入　**✅ 已完成（无等价物，有可落地替代）**

> **状态**：**已关闭**（Q3）。结论文档 = `docs/agent-platform/opencode-v2-spike-results.md`（§4），13 例候选矩阵的原始输出 = `evidence/t6-matrix-round2.txt` / `t6-matrix-round3.txt` / `t6-matrix-round4-final-recipe.txt`。
> **结论**：**v2 没有 `--pure` 的等价物**；唯一可靠手段 = **以隔离的 `HOME` / `XDG_CONFIG_HOME` 启动 `opencode serve`**。落地任务 = **T16b**（P4）。

- **涉及面**（实测范围）：`plugins` 数组的跨配置语义、`instructions` 的语义、`experimental` 的可用键、`OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG` 三个环境变量、隔离 XDG 的效果、OmO 集成的影响
- **实测结论（候选矩阵，13 例）**
  1. **`"plugins": []` / 省略 `plugins` 键 / `"instructions": []` → 全部是 no-op**：v2 的 `plugins` 数组在多份配置文件之间是**合并**而不是替换（空数组不清空全局列表）；`instructions` 只能**追加**额外指令文件，关不掉 `AGENTS.md` 发现。
  2. **`experimental` 里没有相关开关**：v2 的 `experimental` 只有 `portable_shell_scanner` / `subagent_depth` / `policies` 三个字段。
  3. **`"plugins": ["-*"]` → 不可用**：会把内置的 `opencode.agent` / `opencode.provider.*` 一起关掉 → `GET /api/agent` 与 `GET /api/model` 都变空，会话直接失败 `Agent not found: "build"`；且 `-*` 之后**无法**把 vteam 自己的插件加回来（`["-*","opencode.*","./…/vteam-plugin.ts"]` 仍然起不来）。
  4. **`"plugins": ["-<id>"]` → ✅ 可用且精确**：能按插件 ID 精确禁用，内置插件不受影响，vteam 自己的插件照常加载。⇒ **可作为隔离方案的补强**（不是主手段）。
  5. **`OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` → 是追加不是替换**：全局配置、全局插件、全局 `AGENTS.md` 仍会加载 → **不能用来隔离全局配置**。
  6. **`OPENCODE_DISABLE_PROJECT_CONFIG=1` → 副作用过大**：连项目 `AGENTS.md` **和**项目 `opencode.json` 一起禁掉（项目里的 `plugins` 键被忽略 → 全局插件又回来）→ vteam 不能用。
  7. **✅ 唯一可靠手段：隔离 `HOME` + `XDG_CONFIG_HOME`**（全局配置目录不存在）：全局配置 / 全局插件 / 全局 `AGENTS.md` 全部不在作用域内；副作用 = vteam 自己注入的全局配置（provider / 凭据）也必须搬到隔离目录 → **T16b**。
  8. **与 v1 `--pure` 的差异**：v1 禁的是**全部** `AGENTS.md`；v2 隔离方案只禁**全局**那份，**项目目录里的 `AGENTS.md` 仍会被发现** → **vteam 必须保证 workDir 根上没有 `AGENTS.md`**。
  9. **残留**：系统/受管配置目录（`/etc/opencode`、`/Library/Application Support/opencode`）**不受 XDG 控制**（v2 serve 会 watch 它），只有 `policies` 能压制而 policies 属托管配置、项目配置覆盖不了 → **不是 100% 等价于 `--pure`**（→ §10 U9）。
  10. **OmO 影响**：v1 插件实现在 v2 不会运行（官方迁移指南明写 "V1 plugin implementations do not run in V2"）；vteam 现在把 OmO 注册在**全局** `~/.config/opencode/opencode.json` → 隔离后该注册失效 ⇒ **OmO 条目必须搬进项目 `opencode.json` 的 `plugins`**，且需要一个 **v2 形态入口**（`{id, setup}`）→ §10 U8。
- **验收标准（已全部满足）**
  1. ✅ 每条候选都给出了**实测结论**（能抑制 / 不能抑制 / 副作用是什么），不接受推测——13 例矩阵见 spike 文档 §4.1。
  2. ✅ 无等价物 → 给出替代方案（隔离配置发现路径 + 必要时 `plugins:["-<id>"]` 精确禁用），并评估了对 OmO 集成的影响。
  3. ✅ 结论落地为一条可执行形态：**隔离 `HOME`/`XDG_CONFIG_HOME` + 项目侧显式 `plugins`**，并写成 **T16b** 的验收标准（不再是一个待验证的探针）。
- **依赖**：T1、T2（已满足）
- **风险**：**已消解**（结论确定）。**残留**：① 受管目录不受控（U9）；② 隔离后凭据/配置的落点必须同步改（→ T16b，最容易漏的一处）；③ OmO 缺 v2 入口（U8）。

#### T7 配置归一化 WARN 可见化 + provider 段重写

- **涉及面**：`worker/src/runtime/serve-log.ts:32`、`:49-55`、`worker/src/credentials/model-credential-injector.ts:139-232`、`:301-311`
- **交付物**：`serve-log.ts` 增加归一化诊断识别（匹配 `configuration normalization diagnostic` + `omitted unsupported legacy setting`），归类为**配置错误**并升级为 vteam 级可操作告警；provider 段改 v2 形态（`package` / `settings:{baseURL}` / `models.<id>.capabilities:{tools,input[],output[]}` / `limit:{context,output}`）；**刻意不写 per-model `reasoning` / `temperature`**——v2.0.28 **没有这两项的落点**（归一化时被剥除、`GET /api/model` 里也不存在），写进去只会被丢弃并刷 WARN；能力改由 `capabilities` 承载（**基于实测的取舍，不是遗漏**）
- **验收标准**
  1. 单测喂入真实形态的 WARN 行 → 被识别为"配置归一化丢弃了 legacy 设置"，错误信息点名被丢的键路径（如 `$.provider.x.models.y.reasoning`）。
  2. 喂入不含该关键字的普通 INFO 行 → **不误报**（对齐现有 `SERVE_ERROR_LEVEL_RE` 白名单思路）。
  3. 注入后的 provider 段能被 v2 正常加载：`GET /api/config` 回显里 provider 段的 `package` / `settings` / `capabilities` **原样存在**（无归一化诊断）；`package` 的值为 `aisdk:@ai-sdk/openai-compatible`（**归一化器在 `npm`→`package` 迁移时自动加 `aisdk:` 前缀**——显式写 `package` 时**不要**再手动加，否则会重复前缀）。
  4. `cleanupAuthJson` 清理后**同目录下的 `opencode.db` 仍存在**（D11 铁律）——注意隔离域下的落点是 `<HOME>/.opencode-iso/data/opencode/opencode.db`（**不是** `~/.local/share/opencode/opencode.db`，后者是 v1 线的路径）。
  5. **日志落点回归断言**：v2 的 logfmt 诊断落 **stderr**、banner 落 **stdout**（2.0.28 实测）→ `serve-log.ts` 仍能从 stderr 抓到归一化诊断行；落点若变化须同步改识别规则与路径（`--print-logs` 属未文档化行为，**不可依赖**）。
- **依赖**：T1、T2
- **风险**：v2 WARN 文案再变 → 识别失效又回到静默降级。**对策**：识别规则做成"宽松匹配 + 兜底断言"——归一化后 provider 段若**缺少**预期键，则主动报错（不依赖日志文案）。

### P1 传输层

#### T8 `OpenCodeDriver` 接口落地（D1 的缝）

- **涉及面**：新增 `worker/src/driver/opencode-driver.ts`；`v1-driver.ts` **本任务不删**（删除动作延后到 T18，见 D1「删除时机」与 §9.3）
- **交付物**：接口定义（方法名与语义对齐 doc 07 §9.2，但按 D1 收敛为 vteam 自有类型）：`createSession` / `sendMessage` / `getMessages` / `listQuestions` / `replyQuestion` / `rejectQuestion` / `listPermissions` / `replyPermission` / `abort` / `listAgents` / `listTodos` / `listModels` / `isHealthy`（**方法名一律用 vteam 自己的词汇**，不出现 `prompt_async` / `resolveRole` / `abortSession` 这类带 opencode 味的名字；`listTodos` 在 **Q8 未决时先留空实现并标注**；`isHealthy` = `GET /api/info` 探针，**不是** `GET /`——v2 的 `GET /` 是 web SPA、未鉴权也 200）
- **验收标准**
  1. 接口文件不含任何 opencode v1/v2 的类型字面量（`Session.Info` / `Content[]` / `Part` 等一律不出现）。
  2. `exec-server.ts` 与 `index.ts` 的 import 全部指向接口文件，不再 import `v1-driver.ts`。
  3. v1 driver 及其 spec 在本任务**保持不动**（删除统一在 T18）；但 `exec-server.ts` / `index.ts` **不得再 import `v1-driver.ts`**，只依赖接口文件。
- **依赖**：T2
- **风险**：接口设计不足 → v3 又是重写。**对策**：接口入参/出参全部用 vteam 领域类型（`SessionRef` / `PromptSpec` / `ModelInfo` / `MessageSnapshot`），并为"vteam 还不知道但 v2 有"的能力预留可选方法。

#### T9 v2 driver 实现

- **涉及面**：新增 `worker/src/driver/v2-driver.ts`；参考实现对应 §2.3 端点表
- **交付物**：v2 REST 客户端（端点全带 `/api` 前缀；Basic 鉴权用户名 `opencode`；`POST /api/session` 用 `location:{directory}`；`POST /api/session/{id}/prompt` 用 `{text, files?, agents?, skills?, delivery?}`；`GET /api/session/{id}/message` 用 `{data,cursor}` 解包；`GET /api/model` / `GET /api/provider` 用 `{location,data}` 解包（⚠️ 2.0.32 spec 已改裸数组 → 解包集中在**一个** `unwrapData()` 里容忍两种形态）；`POST /api/session/{id}/interrupt`）
- **验收标准**
  1. 契约测试（打真 v2 serve）：`createSession` 返回 `ses_` 开头 id；`sendMessage` 返回 inbox item；`listModels` 返回非空且 id 形如 `provider/model`；`getMessages` 返回 `{data:[]}` 结构被正确解包；`abort` 在空闲会话上返回 `{interrupted:false}` 而**不报错**。
  2. 错误码归一：401 → 配置错误；404 → 会话失效（触发现有 `isSessionNotFound` 重建路径，`exec-server.ts:1651-1653`）；429/5xx → 保留 status 供上层区分。
  3. 不再有 v1 的响应归一化补丁（`body.id ?? body.sessionID` 等）——v2 契约确定，无需兼容。
  4. 单测覆盖：无 `location` 的会话创建、prompt body 缺 `text`（v2 必填）、`delivery` 值非法。
  5. **契约测试覆盖 v1→v2 的"同名不同形"body 键名**（这两处是**发出去不报错但 agent 收不到答复**的静默失败点）：`POST /api/session/{id}/permission/{requestID}/reply` 的 body 是 **`{decision:"once"\|"always"\|"reject", message?}`**（v1 是 `{reply:…}`，**键名变了**）；`POST /api/session/{id}/form/{formID}/reply` 的 body 是 **`{answer*}`**（v1 是 `{answers: string[][]}`，**形状变了**）。断言 driver 发出的是 v2 键名，且 v1 键名**不会**出现在请求体里。
- **依赖**：T8、T1、T3
- **风险**：v2 返回包装形态再变 → 建议所有解包集中在**一个** `unwrapData()` 工具函数（单一改动点）。

#### T10 worker exec 端点扩展（D3 的承载面）

- **涉及面**：`worker/src/exec/exec-server.ts:550-590`（路由分发）、`worker/src/protocol/worker-protocol.ts`
- **交付物**：新增 worker 端点：`POST /sessions`、`POST /sessions/:id/prompt`、`POST /sessions/:id/abort`、`GET /sessions/:id/messages`、`GET /models`；沿用 `X-Worker-Token` 鉴权（除 `/execute` 外的既有规格）
- **验收标准**
  1. 五个端点均带 `X-Worker-Token` 校验：缺失/不匹配 → 401（与 `/file` 同规格）。
  2. `POST /sessions/:id/prompt` 支持 `delivery` 参数透传（`steer` / `queue`），并在响应里回传 v2 的 inbox item id。
  3. `GET /models` 返回 vteam 自有 `ModelInfo[]`（不是 v2 原始 `{location,data}`）。
  4. 与 `worker/src/protocol/contract.spec.ts` 同步：新增端点的请求/响应形状在 worker 与 server 两侧类型一致。
  5. **v2 新增能力按需透传**（不阻塞主链路，可分批）：`PATCH /sessions/:id/inbox/:inboxID`（body `{delivery:"steer"|"queue"}` → 204，**运行期改投递策略**）、`GET /sessions/:id/context`（末次压缩后的消息）、`GET /sessions/:id/diff?from=&to=&context=`（按轮次按文件的结构化 diff）、`POST /sessions/:id/permission`（body `{id?, action*, resources*[], save?[], metadata?, source?{type:"tool",messageID,id}, agent?}` → `{data:{id, effect:"allow"|"deny"|"ask"}}`，供 vteam **主动发起权限询问**）、`POST /sessions/:id/form/:formID/reply`（body **`{answer*}`**）、`DELETE /sessions/:id/form/:formID`（query `message?` → 204，取消/拒绝路径）、`POST /sessions/:id/permission/:requestID/reply`（body **`{decision:"once"|"always"|"reject", message?}`**）。
- **依赖**：T9
- **风险**：worker 端点增多 → 攻击面扩大。**对策**：全部走统一 token 校验，不新增免鉴权端点。

### P2 事件层

#### T11 SSE 帧解析重写（v2 帧格式）

- **涉及面**：`worker/src/driver/serve-event-stream.ts`（全文重写）
- **交付物**：v2 帧解析器：`data:` 行（可多行拼接）→ JSON → 取 `type` / `data` / `durable`；**不要求 `event:` 字段**（v2 运行时不发该行，见 §2.5 的 schema/运行时不一致告警）；`event:` / `id:` / `retry:` 行若出现则**优先取 `event:`、缺失时回退 `data.type`**（两种形态都接受）；`: heartbeat` 注释行识别为心跳；空行分帧
- **验收标准**
  1. 单测喂入**真实抓取的 v2 原始帧**（`data: {"id":"evt_…","created":…,"type":"session.created","location":{…},"data":{…},"durable":{"aggregateID":"ses_…","seq":0,"version":1}}` + 空行）→ 解析出 `type` + `durable`；该 fixture 直接取自实机 `curl -N --no-buffer` 的原始字节（`grep -c "^event:"` = 0）。
  2. 单测喂入 v1 帧（带 `event:` 名）→ 类型解析走 `event:` 分支；**不与 `data.type` 混淆**（v1 事件名在 v2 不存在，误认会引入幽灵逻辑）。
  3. **解析器不要求 `event:` 字段**：喂入无 `event:` 行的帧必须正常解析（`event` 必填只是 OpenAPI schema 的声明，2.0.28 运行时不发）。
  4. 心跳注释行不触发错误，且计入"连接成活"。
  5. 多行 `data:` 拼接与分帧正确（沿用现有帧解析测试数据扩展）。
- **依赖**：T9
- **风险**：帧解析出 bug 会静默丢事件。**对策**：解析失败的帧必须计数并打 WARN（不静默丢）。另：**以实机抓帧为准，不要以 OpenAPI schema 为准**（schema 声明 `event` 必填但运行时不发）。

#### T12 事件映射表 + `durable.seq` 幂等

- **涉及面**：新增 `worker/src/driver/v2-event-map.ts`（映射表，附录 B 的代码化）、`worker/src/protocol/worker-protocol.ts:13-25`、`server/src/workers/worker-event.ingress.ts:596-829`、`server/src/common/constants/event.constants.ts:29`
- **交付物**：v2 事件 → vteam 事件映射（**P2a 已落地：26 条（16 durable / 10 ephemeral），见附录 B.1**；覆盖 `session.text.delta`→文本 delta、`session.reasoning.delta`→reasoning delta、`session.tool.*`→工具态迁移、`session.execution.*`→run 终态（交终态闸门）、`session.step.ended`→**合成 `step-finish` part**、`permission.*`/`form.*`→**只触发一次拉取**、`session.usage.updated`→token/cost 指标）；**另有一份 72 条「已知未支持」清单**（每条带理由，见附录 B.1）；**幂等键改为"上游身份优先"的四层口径**（`upstream:<aggregateId>:<seq>` / `upstream:<eventId>:<ordinal>` / `upstream:<eventId>` / `worker:<workerId>:<eventId>`，见 D4）
- **验收标准**
  1. 映射表逐条标注 durability（`[D]` / `[E]`），且**状态判定只允许使用 `[D]` 事件**；**ephemeral 映射不得产出终态**（映射层另有一道防御）。
  2. 幂等测试：同一 `(aggregateID, seq)` 重放 3 次 → 只落库 1 次；**worker 重启后**重放仍只落 1 次（上游身份稳定，worker 自己的 `evw_<bootId>_<seq>` 会变——这一条是本次修复的**核心**）。⚠️ **server 重启后仍会丢全部去重状态**（去重表在**内存**里；本计划**零 DDL**，不引入持久化去重表）→ 这是**明确记录在案的已知限制**，**不在本次范围内**。
  3. `ephemeral` 事件（`session.idle` / `permission.asked` / `form.created`）只触发动作、不写状态。
  4. **事件名 `message.part.delta` 保持原名并加注释说明原因**（原"改名以避开 opencode v1 同名碰撞"的提案**已取消**）：`worker-protocol.ts` 的 `WORKER_EVENT_TYPES.MESSAGE_PART_DELTA` 与 `event.constants.ts` 的 `MESSAGE_PART_DELTA` **都不改名**，但**两侧都要补上同一段注释**（server 侧已落地，worker 侧待补）：
     > `message.part.delta` — 名称**刻意保留**：v1 线已冻结待删、web 不消费这些 worker 事件（它轮询 messages 表）、且 server 侧本就把它排除在 SSE 保留集外 ⇒ 改名只会 churn 四个文件、零功能收益。
     ⇒ `ingress.ts` / `realtime.service.ts:126-128`（不保留集合）**同步保持原样**即可（无需改名跟随）。
  5. **目录覆盖度断言**：v2 事件目录里的**每一条**，要么在映射表里、要么显式列进「已知未支持」清单（且**必须带理由**）；两边不得重叠、不得有游离项——**不允许「没想过」的静默空洞**（P2a 已落地 ✅：26 条映射 + 72 条已知未支持）。
  6. **终态只发一次**：事件路与轮询路**都**观察到终态时，终态事件**只上送一次**（终态闸门的 `settle()` 一次性）；**陈旧的 durable `seq` 不能覆盖更新的终态证据**。
- **依赖**：T11
- **风险**：映射表漏事件 → 功能静默缺失。**对策**：映射表覆盖度用"附录 B 全集 vs 已映射"做单测断言（未映射的 `[D]` 事件必须显式列在"已知未支持"白名单里）。

#### T13 断线重连与状态重同步

- **涉及面**：`worker/src/driver/serve-event-stream.ts`（重连逻辑）、`worker/src/driver/prompt-await.ts`（兜底轮询）
- **交付物**：SSE 断线后指数退避重连（1s→2s→4s…封顶 10s）；断线时记下最后收到的 `durable.seq`；**重连后优先用 `GET /api/experimental/session/{sessionID}/log?after=<lastSeq>&follow=` 补齐断线期间的 durable 事件**，消息轮询 `GET /api/session/{id}/message` 作为二级兜底；重连后**清空 delta 缓冲**（v2 同样是实时总线、不重放历史帧）；执行判定改为"事件为主 + 轮询兜底"的双通道，**终态统一收口到终态闸门**（D4 的 `RunTerminalGate`）
- **重连与重同步（P2a 已落地的形态）**
  - **`onReconnect` 被 `await` 完成之前不派发任何新帧** ⇒ **补齐先于实时帧**，避免"旧状态覆盖新状态"。
  - **重连时清空增量累积器**：`/api/event` 是 volatile 实时总线、**不重放历史帧** ⇒ 续用旧缓冲会拼出一段**从未存在过**的正文。
  - **权威快照走 `driver.getMessages()`**（v2 游标分页）拉取，**part id 先归一**（与事件路同一套 id，见 D5），再由 tracker 判定哪些 part 是**新的 / 推进的**并**只重发这些**。
  - **三条可观测日志**：① 事件流重连（第 N 次）→ 已清空增量缓冲，开始状态重同步；② 重连后状态重同步完成（补发 N 个 part）；③ 重同步失败（轮询兜底路继续跑）。
- **验收标准**
  1. 杀掉 serve → worker 侧检测断流 → 重连尝试（退避序列可观测）→ serve 恢复后自动接上。
  2. 断线期间发生的执行，在重连后**仍能判出终态**（durable log 补齐；若 log 端点不可用则靠消息轮询兜底）。
  3. **断线期间产生的 durable 事件可通过 log 端点（`?after=<lastSeq>`）补齐，且补齐的事件不重复落库**——与上游身份幂等键联动（同一事件经 SSE 与 log 两条路到达只落 1 次）。
  4. 重连后不出现"delta 从零累积导致文本回退"（沿用现有单调准入守卫的等价约束）。
  5. 慢消费者导致的流失败有明确日志（v2 契约：慢消费者会 overflow 并断流）。
  6. **终态只发一次**：事件路与轮询路**都**观察到终态时，`task.completed` / `agent.status{error}` **只上送一次**（终态闸门的 `settle()` 一次性）；且**陈旧的 durable `seq` 不能覆盖更新的终态证据**。
  7. **重连时序**：断线 → 重连 → `onReconnect` 完成后才派发新帧；重连后**累积器已清空**（断言：重连后收到的首个 delta 不会与重连前的缓冲拼接）；重同步**只补发 tracker 判定为新/推进的 part**（不整段重发）。
  8. **重连日志可观测**：断线日志能区分"一帧未收到就断（serve 不可达）"与"收到过帧再断（事件流中断 / volatile overflow）"；另有重连、清空缓冲、重同步完成（含补发 part 数）三条日志。
- **依赖**：T11、T12
- **风险**：双通道（log + SSE + 消息轮询）都可能判终态 → 重复触发 `task.completed`。**对策**：终态判定收口到**一个**函数，且以 `durable.seq` 单调性做一次性闸门。另：log 端点在 `experimental` 命名空间下，路径与返回形态需在锁版基线里确认（T1 快照 + 实现时复核）；若不可用则退化为纯消息轮询兜底。

### P3 语义层

#### T14 `prompt-await` 语义层（五条语义：完成判定 / 首字 / 工具态 / 文本聚合 / 错误抽取）

> **P3 已落地 ✅（worker 1129 用例全绿）**。**关键认知：完成判定规则本身没有被重写**——因为 v2 driver **合成**了一个与 v1 兼容的 `step-finish` part（`finish` 取值与 v1 同名：实测 `stop`/`tool-calls`/`error`），所以轮询路可以**沿用 v1 铁律**；本任务真正做的是①修掉 v1 专属的字面量与错误形状、②把**事件路**接进来做**合流**。

- **涉及面**：`worker/src/driver/prompt-await.ts`（核心语义；**v1 回退路与 v2 共用同一套判定**）、`worker/src/driver/prompt-await.spec.ts`；**`worker/src/driver/v2-driver.ts` 无需改动**（它已经合成 `step-finish` part、并把 `state.content[]` 归一成 `state.output`）；**接线面**：`worker/src/exec/exec-server.ts`（把每次 run 的终态闸门交给 `sendAndAwait`——见下方「激活要求」）
- **五条语义的落地口径**（v1 → v2）

  | 语义 | v1 | v2（已落地） |
  |---|---|---|
  | 完成判定 | assistant 含 `step-finish(reason=stop)` | **同**（驱动合成 `step-finish`，`finish` 取值与 v1 同名：实测 `stop`/`tool-calls`/`error`）**＋** 事件路 `session.execution.succeeded` 为**同等权威来源**；**事件证据优先**；有界宽限期 |
  | 首字 | 非空 text part 或**任意** reasoning part | **同**（轮询路）**＋** 事件路等价物（非空 `session.text.delta` / 任意 reasoning 事件） |
  | 在飞工具豁免 | `state.status ∈ {pending, running}` | `∈ {running, streaming}`（**v2 无 `pending`**；`pending` **保留**以免 v1 回退路径退化）；大小写不敏感 |
  | 文本聚合 | `type=text && !synthetic`，按 `time.start` 升序 | **同**（v2 `content[]` 本身有序，驱动给同消息各 part 同一时间戳 ⇒ 排序退化为「按消息时间 + 消息内原序」）；**`synthetic` 过滤保留**（v2 下是空操作） |
  | 错误抽取 | `info.error={name,data:{message,statusCode}}` | **两代都认**：v1 形 + v2 形 `{type,message,status,response{body}}`；**事件载荷优先**；serve 日志兜底 |

- **交付物**
  1. **五条语义按上表落地**（见验收标准 1–6）。
  2. **终态与事件路的合流缝（`EventSignal`）**——`prompt-await.ts` **不自己发终态事件**（它结构上做不到），只做三件事：① **先问闸门**：每轮开始读 `eventSignal.peek()`——事件路已判 failed/interrupted 时**轮询路不得宣告成功**；② **记下自己的证据**：`eventSignal.notePolling(...)`，**绝不消耗**闸门的一次性 `settle()`（那是调用方的活）；③ **给事件路一个有界宽限期**（`eventGraceMs`，缺省 **500 ms**，**仅在提供了事件信号时**才生效）——让「轮询先到」与「事件先到」**得到同一个结论**。判定结果带 `CompletionResult.terminalEvidence`（`'event' | 'polling'`）**留痕**，两路证据不一致时打一条日志。
  3. **错误抽取两代通吃**：消息文本优先级 = `data.message`（v1）→ 顶层 `message`（v2）→ 类型名（`name` / `type`）；HTTP 码 = `data.statusCode`（v1）→ 顶层 `status`（v2），渲染为 ` (HTTP <code>)`；**aborted 跳过**同时查 `name` 与 `type`；serve 日志正则仍是最后兜底。**v2 形状（实测 2.0.28）**：`{"type":"provider.auth","message":"Invalid API key.","status":401,"response":{"body":"…"}}`。
  4. ⚠️ **激活要求（接线）**：合流缝在 `prompt-await.ts` 里已就绪，但**必须由 exec-server 把"每次 run 的终态闸门"交给 `sendAndAwait`**（`eventSignal` 选项）才真正生效——**否则轮询路与事件路仍是两条独立的判定**，会各发一次终态。**本项是 T14 的验收项，不是"已完成的事实"**（接线由并行任务落地）。
- **验收标准**
  1. 单测：完成判定在"有 assistant 文本但无终态"时**不判完成**（对齐 v1 铁律：不能是"有消息"）。
  2. 单测：首字判定覆盖 4 例（非空 text 到达 / 仅 reasoning 到达 / 空 text 到达 / 无任何输出）——与 v1 语义逐例对齐。
  3. 单测：工具态映射覆盖 v2 四态——⚠️ **实际取值是小写** **`running` / `streaming` / `completed` / `error`**（`Running`/`Streaming`/`Completed`/`Error` 只是 OpenAPI 的**类型名**，不是取值）→ vteam 终态判定（`completed`/`error` = 终态；`running`/`streaming` = 在飞豁免）。**与 v1 同族** ⇒ web 的 `toToolStatus`（`toLowerCase()` 后映射）继续有效、**无需改动**。实现侧在边界再做一次防御性小写化。
  4. 单测：工具输出抽取——⚠️ **`state.output` 仍是主形态**（vteam 内部 part 模型里它就是**字符串**，server 与 web 都读它；v2 driver 在边界已把 `state.content[]` **归一**成 `state.output`）⇒ **不改模型**，只**增加对原始 `state.content[]` 数组形态的容错**（两者都读得到）。**不得**把内部模型改成数组形态——那会与已落地的 server/web 契约相悖。
  5. 单测：token/cost 取值路径改为 v2 的 assistant 消息 `tokens`/`cost` 字段（`session.usage.updated` 事件亦可）；**同时必须"合成并上送"一个 `step-finish` part**（从消息的 `finish`/`tokens`/`cost` 构造）——⚠️ **它不是"不再依赖"，而是"改由合成提供"**：控制面的「本轮完成」幂等键读的就是 `part.type === 'step-finish'`（`worker-dispatcher.ts` 的 `findStepFinishPartKey`）⇒ **不合成 ⇒ 控制面永远看不到本轮完成**。单测要断言合成出的 part 带 `reason`/`cost`/`tokens`。
  6. 回归：v1 的"卡在工具循环"诊断（`reason==='tool-calls'`）在 v2 有对应判据或明确标注为不支持。
  7. **合流缝的单测**：① 事件路已判 failed/interrupted 时，轮询路**不得**宣告成功；② 轮询路的证据经 `notePolling` 记进**同一个**闸门，且**不**消耗 `settle()`；③ 轮询先到时按 `eventGraceMs` 等一段（默认 500 ms），事件先到时立即采用 ⇒ 两种顺序**同一结论**；④ 结果带 `terminalEvidence`（`'event'` / `'polling'`），两路不一致时打日志。
  8. ⚠️ **激活验收（接线）**：exec-server 在每次 run 时**新建**一个终态闸门并把它交给 `sendAndAwait`（`eventSignal`），最终由**调用方**执行**唯一一次** `settle()` 并据此发终态事件 ⇒ **一次 run 只发一个终态事件**（`task.completed` / `agent.status{error}` 各至多一次），且**失败不会被判成成功**。
  9. **错误形状回归**：v1 形（`{name,data:{message,statusCode}}`）与 v2 形（`{type,message,status,response{body}}`）**都能抽出可读消息**；v2 形要带上 ` (HTTP 401)`；aborted（`name` 或 `type` 含 aborted）**跳过**不抛。
- **依赖**：T9、T12（+ 接线由 exec-server 侧并行任务落地）
- **风险**：① **合流缝没被激活** ⇒ 两条判定路径各发一次终态（前端重复「已完成」+ watchdog 计时）——**对策**：验收标准 8 把"exec-server 交闸门"列为硬闸门；② **闸门的 `peek()` 语义微妙**（见 D4 的告警）——**必须"先问后记"**；③ v2 assistant 消息的"终态字段"名未在契约基线中显式给出 → T9 实测确定后写入；**不得**在实现里臆造字段名。

#### T14b D6(f) 逐消息 blob 的 v2 载体：插件交接　**✅ 已完成（实机证明）**

> **为什么放在 P3（语义层）**：这件事回答的是"**vteam 的 blob 怎么进到模型请求里**"——与 T14 同一族问题（语义层），且它依赖 T9（v2 驱动）、T12（事件/闸门）与 T19 沉淀下来的插件约定（动态 import / `setup` 护栏 / 双形态），但必须**早于** T15 的"agent 自带 `system` ⇒ 整段 blob 不注入"闸门被真正使用。

- **涉及面**：新增 `worker/src/driver/v2-system-handoff.ts`（交接存储 + 插件生成器 + 按 location 的就绪协商）、`worker/src/driver/v2-system-handoff.spec.ts`（19 个单测）、`worker/src/driver/v2-system-handoff.real.spec.ts`（opt-in 真二进制契约测试）；改动 `worker/src/driver/v2-driver.ts`（载体路由 `routeSystemBlob`）、`worker/src/driver/index.ts`（工厂选项上**可选**的 `systemHandoff`——⚠️ **`OpenCodeDriver` 接口本身不变**）、`worker/src/index.ts`（建存储、装产物、每次 serve（重）启清空就绪标记）、`worker/src/resources/injector.ts`（`applySystemHandoffPlugin()`，manifest 键 `systemHandoffPlugin`）
- **交付物**：交接协议 = 每次派发前把 blob **原样**写进 `<workDir>/.vteam-system-handoff/<sessionID>.txt`（UTF-8、无尾随换行、**不重新序列化**）；插件 = `<workDir>/.opencode/plugins/vteam-system-handoff.ts`（`Plugin.define({id:'vteam-system-handoff', setup})`、**动态** `import("@opencode/plugin")` + identity 兜底、`setup` 护栏 `if (!ctx?.session?.hook) return`、双形态 `server()` 在 v1 上是 no-op）→ `ctx.session.hook("context", cb)` 读文件 → `event.system.push({type:"text", text: blob})`；**没有交接文件 ⇒ no-op**（**绝不**推空段）；**无状态**（每次 context 组装都重读、逐字节推出去）。⚠️ **刻意不写 `options:{codemode:false}`**——那是**工具**的选项（决定模型能否直接 `tool_calls`），session hook **不是**模型侧工具、hook API 也没有这个参数（它的第三个参数是 **provider** 作用域 `ModelHookOptions`）。
- **验收标准**
  1. **真二进制断言**：blob 出现在**模型请求的 system 段**、**不在 user 段**；同一会话**两次派发的 blob 逐字节相同**（opt-in 契约测试）。
  2. **互斥断言**：同一段 blob **绝不**同时出现在 system 段与 user 段（走插件路 ⇒ 不拼前缀；走前缀兜底 ⇒ **清掉**交接文件）。
  3. **字节稳定性断言**：交接文件内容**逐字节等于 blob**（无尾随换行、无再加工）；同内容**不重写**（inode/mtime 不变）；内容变更 ⇒ 原子写（tmp + `rename`）+ 显式告警。
  4. **就绪协商断言**：判据 = ①插件产物在位 **且** ②**该 location** 的就绪标记在位（按 location 分桶）；serve（重）启后全部标记被清空；**首次派发落到未就绪 location ⇒ 退回文本前缀**（安全降级，**不丢**）。
  5. **插件形状断言**：动态 import + identity 兜底；`setup` 护栏存在（v1 也会调 `setup`）；`server()` 在 v1 上是 no-op；id 稳定；**无** `codemode` 选项。
  6. **安全断言**：会话 id 在拼进路径之前经 `/^[A-Za-z0-9_-]{1,128}$/` 校验（路径穿越的唯一防线）；交接目录**不在** `.opencode/` 内（不在 opencode 的配置发现作用域）。
- **依赖**：T9、T12、T19
- **风险**：① **交接文件被写入了可变内容** ⇒ 前缀缓存静默塌掉（load-bearing，见 §8.2）；② **就绪判据不分 location** ⇒ blob 静默丢失（见 §8.2）；③ **`context` hook 只覆盖 primary 请求**（标题 / 压缩 / generate 各有独立 hook）⇒ 标题请求不带 blob（与 v1 一致，上游行为未变）。

### P4 配置与凭据

#### T15 `opencode.json` 重写（agents / mcp.servers / plugins / providers）

- **涉及面**：`worker/src/resources/injector.ts:468-491`（mcp 节）、`:512-525`（plugin 节）、`:333-412`（agent 节）、`worker/src/resources/opencode-config-builder.ts:48-64`（agent 构造 + 未知字段白名单 `:95-105`）
- **交付物**：`mcp` → `mcp.servers`（**`mcp.<n>.enabled` → `mcp.servers.<n>.disabled`**——实测**归一化器把反转做对了**（v1 形 `enabled:true` → `disabled:false` = 仍启用），**vteam 现键不构成"全被禁用"的风险**）；`mcp.<n>.timeout` → `timeout:{startup,catalog,execution}`（**三段都要显式写**：归一化 v1 单值时只得到 `catalog`+`execution`，**`startup` 段会丢失**）；`plugin` → `plugins`（⚠️ **v2 的 `plugins` 数组在多份配置文件之间是"合并"不是"替换"**——写空数组清不掉全局插件；**顺序即优先级**，`-` 前缀禁用；T6 结论 → 项目侧只写自己需要的条目，OmO 条目与 vteam 插件条目的**相对顺序要显式设计**）；**`agent` → `agents` 与 `prompt` → `system` 必须作为同一次原子改写**（只改节名 ⇒ `prompt` 键在 v2 原生 `agents:` 节下是未知键 → 静默丢弃，所有角色提示全丢）；agent 权限从对象 `permission` 改为数组 `permissions:[{action,resource,effect}]`（`bash`→`shell`、`task`→`subagent`、`write`/`patch`→`edit`）；**agent 增 `system` 字段（角色提示落点，v2 原生键）**；显式补 `external_directory` 的 `ask` 规则以保持 v1 安全语义；provider 段改 v2 形态（承接 T7）
- **验收标准**
  1. 注入后的 `opencode.json` 被 v2 加载时，`GET /api/config` 回显**无** `configuration normalization diagnostic`（D12 铁律）。
  2. `GET /api/agent` 返回的 agent 集合包含 vteam 注册的角色 agent，且 `permissions` 为数组形态（vteam 侧能正确读取）。
  3. `mcp` 节位于 `mcp.servers.<name>` 下；`McpLocalConfig.command` 为**数组**（当前 `injector.ts:672-676` 已是数组 → 保持；**需以代码为准复核简报所述"当前是 string"**）。
  4. `opencode-config-builder.ts` 的"未知字段即抛错"闸门扩白名单到 v2 `AgentConfig` 的合法键（含 `system`）；扩白名单时**同时**在 spec 里加断言防止无边界放宽。
  5. **角色提示键断言（节名+键名原子改写的硬闸门）**：最终生成的 `opencode.json` 里该 agent 位于 **`agents.<n>`** 下、键名是 **`system`**，且**不存在 `agents.<n>.prompt`**；`GET /api/config` 的 v2 归一化回显里该 agent 的 **`system` 存在且内容完整**、**无 `prompt` 键**——即"节名 `agent`→`agents` 与键名 `prompt`→`system` 已同时改"的证据，防回归到"角色提示静默丢失"的老坑。
  6. **MCP 启用/超时断言**：`GET /api/config` 归一化回显里 `mcp.servers.<name>.disabled` 的**极性正确**（vteam 注入的服务器对应 `disabled: false` = 启用；实测 v1 形 `enabled:true` 归一化后正是 `disabled:false`），且 `timeout` 是**显式三段** `{startup, catalog, execution}`（**`startup` 段不得缺失**——v1 单值 timeout 归一化时它会丢）；`GET /api/mcp` 回显中 vteam 注入的服务器处于 **connected**（不是全部 disabled）。
  7. 权限矩阵断言：注入的 `permissions[]` 含 `{action:"external_directory",resource:"*",effect:"ask"}`（保持 v1 语义），且无 `bash` / `write` / `patch` 残留 action。
  8. **角色提示运行时断言（承接 T4 ✅）**：用注入后的配置起一次真实 serve，driver 发 prompt 前先 `POST /api/session/{id}/agent`（或建会话时带 `agent`）→ **最终模型请求的 system 首行是角色提示原文**（用 mock provider 抓请求体断言）；同时断言 **driver 没有使用 prompt body 的 `agents:[{name}]`**（T4 实测是 no-op）。
- **依赖**：T7（+ T4 / T6 的结论已并入本文，不构成阻塞）
- **风险**：配置键名写错 → v2 归一化后**静默**丢节。**对策**：验收标准 1 用"`GET /api/config` 无归一化诊断"作硬闸门。**另：`plugins` 是合并语义**（不是覆盖）→ 项目配置里写 `plugins` **不会**清掉全局插件，"清空插件列表"这件事只能靠 T16b 的隔离 env。

#### T16 凭据注入 + 存储路径

- **涉及面**：`worker/src/credentials/model-credential-injector.ts:92-97`、`:197-292`、`:301-311`；docker volume 挂载；`worker/src/index.ts:264-271`
- **交付物**：provider 段 v2 形态（承接 T7）；`auth.json` 路径确认（v2 是否仍读 `~/.local/share/opencode/auth.json` → **需实测**，`opencode debug paths` 只给 `data` 目录）；数据卷持久化 `opencode.db` + `auth.json`；`cleanupAuthJson` 不动 `opencode.db`；**落点随 T16b 迁移**（隔离 env 下 `$HOME` 不再是宿主机 HOME，凭据与全局配置必须写到**隔离目录**）
- **验收标准**
  1. 注入 provider 后，v2 serve 能用该 provider 出模型（一次真实 `listModels` 命中注入的 model id）。
  2. 重启 worker 后 `~/.local/share/opencode/opencode.db` 存在且会话历史可读。
  3. `cleanupAuthJson` 执行后 `opencode.db` 仍在（单测断言）。
  4. 记录 v2 的 `auth.json` 实际读取路径结论（实测），若与 v1 不同则同步改常量与文档。
  5. **隔离落点断言**：注入的 provider 配置与 `auth.json` 落在 **T16b 定义的隔离目录**下（不是宿主机 `$HOME`）；隔离后仍能被 serve 读到（`GET /api/model` 命中注入的 model id）。
- **依赖**：T7、T15、T16b
- **风险**：v2 若改了 auth.json 位置 → vteam 注入的凭据全部失效。**对策**：验收标准 4 强制实测落点。**另：隔离 HOME 之后凭据路径若不改 → 凭据写到 worker 进程读不到的地方（静默 401/无模型）**——这条由 T16b 收口。

#### T16b 隔离 HOME/XDG 启动 serve，并把 vteam 自身的配置全部收进项目侧（T6 结论的落地）

> **来源**：T6 已关闭（Q3）——**v2 没有 `--pure` 的等价物**；`plugins: []` / `instructions: []` / `experimental` / `OPENCODE_CONFIG*` **全部无效**（`plugins` 是**跨配置合并**语义），`plugins:["-*"]` **不可用**（会连内置 agent/provider 一起关掉 → `Agent not found: "build"`），`OPENCODE_DISABLE_PROJECT_CONFIG=1` 会把项目 `opencode.json` 一起杀掉。**唯一可靠手段 = 隔离配置发现路径**。证据：`docs/agent-platform/opencode-v2-spike-results.md` §4 + `evidence/t6-matrix-round*.txt`。

- **涉及面**：`worker/src/runtime/opencode-server.ts:355-388`（spawn argv 与 env 注入）、`:380`（`OPENCODE_SERVER_PASSWORD` 注入）、`worker/src/credentials/model-credential-injector.ts:92-97`（全局 `opencode.json` 写入路径）、`:301-311`（`auth.json` 写入与清理）、`worker/src/resources/injector.ts:512-525`（`plugin` 节）、`worker/src/index.ts:264-271`（`DEFAULT_AUTH_JSON_PATH`）
- **交付物**
  1. **spawn env 隔离**：`opencode-server.ts` 启动 serve 时**不再继承宿主机 `HOME`**，改为注入 workDir 下的隔离目录：`HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`（可再加 `XDG_STATE_HOME` / `XDG_CACHE_HOME`）全部指向 `<workDir>/.opencode-iso/*`（或一个 worker 级的持久化隔离根目录，取决于 D11 的卷设计）。
  2. **凭据与全局配置落点迁移**（**最容易漏的一处**）：`model-credential-injector.ts` 当前写的是**宿主机** `$HOME/.config/opencode/opencode.json` 与 `$HOME/.local/share/opencode/auth.json`（两个常量都按 `$HOME` 拼）→ **必须一并指向隔离目录**，否则凭据写到 serve 根本读不到的地方（表现为"凭据已注入但模型 401 / 无模型"，极难排查）。
  3. **vteam 自身配置全部收进项目侧**：providers / credentials / `agents`（含 `system`）/ `mcp.servers` / `plugins`（OmO 条目 + vteam 自己的插件条目）写在**项目** `<workDir>/opencode.json` 与 `<workDir>/.opencode/plugins/*.ts`；隔离的全局目录只放**必须**全局的项（provider 凭据 / `auth.json`）。
  4. **workDir 根上不放 `AGENTS.md`**：v2 只发现 `AGENTS.md`（**读文档结论；`CLAUDE.md` 回退是否仍有 → §10 U6**），且**项目目录里的 `AGENTS.md` 仍会被发现**（隔离方案只禁全局那份）→ 注入器必须确保 workDir 根上没有 `AGENTS.md`（vteam 自己不生成，还要防用户仓库带进来）。
  5. **OmO 条目搬迁**：从全局 `~/.config/opencode/opencode.json` 搬进**项目** `plugins` 数组；并记录"OmO 需要 v2 形态入口（`{id, setup}`）"这一未决（→ §10 U8）。⚠️ `plugins` 数组是**合并**语义、**顺序即优先级**（`-` 前缀禁用）→ 项目侧与 OmO 条目的相对顺序要显式设计。
  6. **补强手段（可选）**：在项目 `opencode.json` 里用 `"plugins": ["-<已知插件ID>"]` **精确**禁用已知的全局插件（**禁用 `["-*"]`**——会连内置 agent/provider 一起关掉）。
  7. **启动日志显式声明**：serve 启动日志打印当前隔离根目录（`HOME` / `XDG_CONFIG_HOME` 的实际值）+ 一行"当前处于隔离配置域"，便于线上排查"为什么我的全局插件没被加载"。
- **验收标准**
  1. **隔离生效断言**：以隔离 `HOME` 启动后，`GET /api/config` 的回显里**不含宿主机全局配置的任何痕迹**（无宿主机 `opencode.json` 的 `plugins` / `agents` / `providers` 条目，无全局 `AGENTS.md` 内容），且 vteam 自己注入的条目**都在**。
  2. **凭据可用断言**：凭据注入到隔离目录后，模型可用（一次真实 `listModels` 命中注入的 model id），且**宿主机 `$HOME/.config/opencode/opencode.json` 与 `$HOME/.local/share/opencode/auth.json` 不被写入**（断言这两个路径在注入后**不存在或未被修改**）。
  3. **项目插件可发现断言**：项目 `<workDir>/.opencode/plugins/*.ts` 里的 vteam 插件在隔离 env 下被加载（判据：**serve 日志的 `msg="loading plugin"` 行** + 工具出现在模型请求的 `tools[]`；⚠️ **不要用 `GET /api/plugin` 当唯一判据**——它不可靠）。
  4. **workDir 无 `AGENTS.md` 断言**：注入后 `<workDir>/AGENTS.md` 不存在（单测锁定）。
  5. **D11 关系**：`opencode.db` 与 `auth.json` 随隔离目录一起落在**同一个持久化卷**上（否则重启后会话历史与凭据分离）；`cleanupAuthJson` **只删**隔离目录下的 `auth.json`，**绝不动**同目录的 `opencode.db`。
  6. **D10 关系**：`OPENCODE_SERVER_PASSWORD` 的注入不受隔离影响（密码走 env，不走配置目录）；`OPENCODE_SERVER_USERNAME` 同理。
  7. **回滚关系**：隔离根**不得指向** v1 的数据目录——`XDG_DATA_HOME` 必须落在 `<iso>/data`，与 v1 的 `<realHOME>/.local/share/opencode` **不是同一个目录**。这正是"v2 **不会**就地迁移 v1 数据"的**前提**，也是回滚安全性的来源（见 D11 与 §9.3）。**实测**：worker 上用 `opencode debug paths` 在**带 / 不带隔离**两种形态下各测一次，比对 `data`/`db` 落点必须不同。
- **依赖**：T2（spawn 形态与 env 注入已定）、T3（密码 env）、T7（provider 段形态）、T15（项目 `opencode.json` 形态）
- **风险**：① **凭据路径漏改** → 凭据写到 serve 读不到的地方（静默失败）——验收标准 2 是硬闸门；② 受管目录（`/etc/opencode`、`/Library/Application Support/opencode`）**不受 XDG 控制**、只有 `policies` 能压制 → 隔离方案**不是 100% 等价于 `--pure`**（→ §10 U9）；③ 项目 `AGENTS.md` 仍会被发现 → 验收标准 4；④ OmO 缺 v2 入口 → §10 U8，本任务先把条目搬到位，入口缺失时按"未装 OmO"降级并记录。

#### T17 四个 CLI 探针重做

- **涉及面**：`worker/src/index.ts:87`、`:591-602`；`worker/src/runtime/opencode-server.ts:289-302`；`worker/src/mcp-status/mcp-status-probe.ts:91-121`、`:144-148`
- **交付物**：版本解析器（承接 T1）；`models` 解析（格式不变，仅加 v2 输出样本回归用例）；`mcp list` 去掉 `--pure`、按 v2 实测输出重写 glyph 正则；`serve` banner 双正则（listening + password）
- **验收标准**
  1. `mcp list` 探针在 v2 下：服务器已连接 → 报 `connected`；**命令失败（exit≠0）→ 明确报错**（不再是"无服务器"）。**这是主路径**：2.0.28 实测 `opencode mcp list --pure` 打印帮助文本 + `Unrecognized flag: --pure` 并 **exit 1**（早前"exit 0"的观测是经 shell 管道取到了 `head` 的退出码，**不成立**）——因此"命令无效"表现为**非零退出**，探针必须以退出码为准。
  2. glyph 正则单测喂入 v2 实测输出 `✓ myserver   connected` → `connected`；喂入 v1 样本 `● ✓ myserver connected` → 仍 `connected`（回归兼容）。
  3. `models` 解析单测喂入 v2 样本 → 解析出的 id 与 v1 样本一致（格式未变）。
  4. 版本解析：v2 样本 `opencode v2.0.28` → `2.0.28`。
- **依赖**：T1、T2
- **风险**（**次要**）：v2 下**真正的空 MCP 列表仍 exit 0**——但"命令无效"已经是 exit 1 的**显式失败**，两者不再难区分。**对策**：以**非零退出码**为主判据；再叠加"输出**不是**帮助文本"的兜底校验（v2 打印 help 时会含已知帮助关键字），命中同样判为"探针失败"。
- **补充验收标准（§2.9 修正后 —— 真栈实测，已落地）**
  1. **模型探针不得 shell out 到 opencode CLI**：改为读 **serve 的 `GET /api/model`**（Basic 鉴权，
     端点与口令从 serve 对象读——serve 换端口重启会自动跟上，不从 env 重读）；两种响应形态
     （2.0.28 `{location,data}` / 2.0.32 裸数组）都要容错；`enabled:false` 的模型不算"可执行"；
     空/非法响应 ⇒ `undefined`（**不断言"零可用"**）。**不留 CLI 兜底。**
  2. **MCP 探针不得 shell out 到 opencode CLI**：改为读 **serve 的 `GET /api/mcp`**；加**形态闸门**
     （不是 v2 `/api/mcp` 的形状 ⇒ `probe_failed`，**绝不报"没有 MCP"**）+ 5s 超时。
  3. **五态 1:1、不折叠**：`connected` / `pending` / `disabled` / `failed` / `needs_auth`；
     `pending` 与 `disabled` **都不是 `failed`**。未知/缺失 `status` ⇒ 落 `failed` **并响亮告警**
     （带原始状态串）。
  4. **回归守卫**：两个探针都不得再出现 `spawn('opencode', …)`（防止有人把 CLI 兜底加回来）。
  5. **真栈验收**：worker 日志无 `可执行模型探测失败` / `Location plugins did not finish activating`；
     注册载荷带 `executableModels`（实测 **10** 个 id，与 serve 的 `GET /api/model` 一致）；
     MCP 探针报 `connected`（与 serve 一致）。

### P5 控制面收敛

#### T18 `worker.client.ts` 5 处直连改造

- **涉及面**：`server/src/workers/worker.client.ts:299-320`、`:336-355`、`:589-606`、`:990-1000`、`:1007+`；`server/src/tasks/tasks.service.ts:2049-2118`；`server/src/agents/agents.service.ts:551-610`
- **交付物**：`worker.client.ts` 里的 5 个方法改为调 worker 的新 exec 端点（T10）；**删除**控制面侧的 opencode Basic 鉴权逻辑与 `capabilities.baseUrl`/`port` 解析（:1101-1112）；`opencodeAgentName` 的语义改为"agent 注册键"，传给 worker 由 worker 决定如何切换；**本任务同时删除 `worker/src/driver/v1-driver.ts` 与 `worker/src/driver/v1-driver.spec.ts`**（D1「删除时机」：单轨收口至此一步完成，此前 P0–P7 期间保留 v1 退路）
- **验收标准**
  1. `server/` 全仓 grep `opencode` 相关端点字面量（`/prompt_async`、`/api/model`、`/abort`、`/session`）→ **0 命中**（`/api/model` 若在注释里出现需删）。
  2. `worker.client.spec.ts` 全部改为 mock **worker** HTTP（不再 mock opencode serve）。
  3. `tasks.service.ts` 的 prompt 下发链路：控制面 → worker → driver → v2 `POST /api/session/{id}/prompt`，**全程只有一处 prompt body 构造**（消除 server/worker 双分叉）。
  4. `agents.service.ts` 的 `GET /agents/opencode` 在 worker 不可用时仍走 `degraded` 分支（不抛错）。
  5. `v1-driver.ts` / `v1-driver.spec.ts` 已删除；全仓不再存在 v1 driver 的 import；`worker` 全量 jest 仍绿。
- **依赖**：T10
- **风险**：控制面不再能直连 opencode ⇒ opencode 侧故障的诊断信息少一层。**对策**：worker 的 exec 端点在错误响应里透传 opencode 的 status 与 stderr 摘要。

### P6 工具与插件

#### T19 三个生成器重写（产物形态：工具文件 → 插件注册代码）

> **前提已就绪**（T5 已关闭 ✅）：`.opencode/tools/*.ts` 的**文件自动发现在 v2 已移除**（该目录的文件**连 import 都不发生**）→ 三个生成器的产物**必须**改成 **`.opencode/plugins/*.ts` 里的插件注册代码**；`options:{codemode:false}` **必写**（否则模型只能经 Code Mode 调）；`ToolContext` **没有 `directory`**（取 `ctx.location.directory`）；双形态模块可行，但 **v1 也会调 `setup`** → v2 分支要防呆。

- **涉及面**：`worker/src/resources/custom-tool.ts:143-164`、`worker/src/git/git-tools.ts:723-746`、`worker/src/browser/browser-tools.ts:147-180`、`.opencode/package.json`、**产物落盘路径**（`.opencode/tools/` → `.opencode/plugins/`）
- **交付物**：三处模板整段重写为**双形态插件模块**——同一文件同时导出 v2 形态 `export default { ...Plugin.define({ id, async setup(ctx) { if (!ctx?.tool?.transform) return; ctx.tool.transform(editor => editor.add({...})); return () => {/* cleanup */} } }), async server() { /* v1 回退 */ } }` 与 v1 形态 `async server()`；**产物路径从 `.opencode/tools/<file>.ts` 改为 `.opencode/plugins/<file>.ts`**；**工具入参从 Zod 改 JSON Schema**；**返回值从 string 改 `{content}`**；**必须显式写 `options: { codemode: false }`**；**`context.directory` 改取 `ctx.location.directory`**；import 改 `@opencode/plugin`；`.opencode/package.json` 依赖改 `@opencode/plugin@2.0.32`（目的为**编译期检查**，运行时由宿主内置模块解析）；生成代码的**编译期检查**机制
- **验收标准**
  1. 三处生成的**插件模块**在 v2 serve 下被真实加载（不报 import 错），至少一个工具被模型**直接 `tool_calls`** 一次（不是经 Code Mode 的 `execute`）。
  2. **`options:{codemode:false}` 断言**：生成的每个工具注册都带该选项；断言该工具出现在最终模型请求的 `tools[]` 数组里（**不进** system 的 Code Mode 目录）。
  3. **`directory` 来源断言**：`browser-tools.ts` **不再读 `context.directory`**（v2 的 ToolContext 无此键），改读 `ctx.location.directory`；单测断言生成的模板里不含 `context.directory`（或 `ctx.directory`）。
  4. **v2 分支防呆断言**：生成的模块在 v1 serve 下被加载时**不抛错**（`setup` 分支必须先判 `ctx?.tool?.transform`）——v1 也会调 `setup`，没有这层护栏会炸。
  5. `git-tools.ts` 的命名导出仍映射为 `git_<name>` 工具名（权限 action 名不变）。
  6. 编译期检查：CI 里对生成产物跑 `tsc --noEmit`（或等价），生成代码类型错 → 构建失败（**不能只在运行时才发现**）。
  7. `.opencode/package.json` 锁定 `@opencode/plugin` 精确版本（与 CLI 版本对齐）。
  8. **双形态验证**：生成的同一份模块在 **v1 serve 与 v2 serve 下都能被加载**（v1 走 `server()`、v2 走 `setup()`），两侧都能让工具被调用——这让 §9.3 的"退回 v1"退路在**产物层**也成立。
  9. **产物路径断言**：注入后 workDir 下**不存在** `.opencode/tools/` 里的旧式工具文件；工具插件落在 `<workDir>/.opencode/plugins/` 且在 **T16b 的隔离 env** 下被正确发现（判据：serve 日志 `msg="loading plugin"` 行 + 工具出现在 `tools[]`；⚠️ **不用 `GET /api/plugin` 当唯一判据**——它不可靠）。
- **依赖**：T5（已关闭）、T16b（隔离 env 下的插件发现）
- **风险**：**产物形态改变已由 T5 证实 ✅（不再是假设）**——三个模板要整段重写，工作量显著上升。**对策**：双形态模块方案**已经覆盖**这个形态（T5 在 1.18.32 与 2.0.28 双侧实测可行），按"插件注册代码"直接排期即可，不再保留"文件发现是否还在"的分支。**残留**：① `options.codemode` 未进官方文档 → 用验收标准 2 固化成断言 + 锁 `@opencode/plugin` 精确版本；② 插件发现按 location **惰性触发**且 `setup` 异步 → 契约测试里"先建会话/发 prompt、等 ≥6s 再断言"，否则假阴性。

### P7 存量兼容

#### T20 存储形态边界（`normalizeParts`）——**web 侧零改动**

> **前提已就绪（P2b 已验证 ✅）**："v1 落库形态 == v2 落库形态"这个假设**已被证实**（不是假设）：对照**实测的 v1 会话 dump**与 v2 driver 的输出，web 实际读取的每一个字段（`type` / `id` / `text`/`summary`/`thoughts`/`detail` / `synthetic` / `tool` / `state.status` / `state.input` / `state.output` / `state.error`）**两边都存在且相等**。⇒ **零数据迁移、零 web 改动**。本任务的真正交付物是**服务端的存储形态边界**（`server/src/chat/message-parts.ts` 的 `normalizeParts`）。

- **涉及面**：`server/src/chat/message-parts.ts`（`normalizeParts()` 边界 + `message-parts.spec.ts`）、`server/src/workers/worker-event.ingress.ts:710-712`、`:817-820`（落库形态）、`server/src/chat/worker-dispatcher.ts`（终态化落库）；**`web/src/components/chat/msg-parts.tsx` / `msg-tool.tsx` 不动**
- **交付物**：server 侧 `normalizeParts(raw)` —— 一个**总函数**（**任何输入都不抛错**），接受三种输入并产出**同一个内部渲染模型**（字段沿用 web 现有的 `text` / `summary` / `thoughts` / `detail` 四元组 + `state.status` + `tool` + `id` + `synthetic`）：① **裸数组**（v1 内部形态 / v2 driver 已归一后的形态）→ **原样透传**（仅剔除 null 与非对象条目，**不改动任何字段**）；② **v1 形 `{parts:[…]}`** → 取 `parts` 按 ① 处理；③ **v2 形 `{content:[…]}`** → 逐项翻译（工具名 `name`→`tool`、输出 `state.content[]`→`state.output`、`state.error` 对象→字符串+`errorDetail`、`state.status` 小写化、`time.{created,completed}`→`time.{start,end}`、part id = `消息id:序号`）。**不可识别**的输入 → 降级为**空 part 集** + 记**一条** WARN（**只报形状、不报内容**）；`null`/`undefined` → 静默降级为空集（正常缺省，不告警）。
- **验收标准**
  1. 单测：v1 样本（`parts:[{type:'text'},{type:'tool',state:{status:'completed',output:'x'}}]`）与 v2 样本（`content:[{type:'text'},{type:'tool',state:{status:'completed',content:[…]}}]`）归一后**产出等价的内部模型**。
  2. 单测：混合消息（老消息 v1 + 新消息 v2）合并渲染不崩、不重复、不回退。
  3. ⚠️ **`step-start` / `step-finish` 的处置不同**：`step-start` **可丢弃**（v2 无对应、**也没有任何消费方**）；**`step-finish` 必须保留**——它是控制面的**「本轮完成」幂等键**（`worker-dispatcher.ts` 的 `findStepFinishPartKey` 读 `part.type === 'step-finish'`），v2 上游没有这个 part，所以 **v2 driver 合成它**，归一化**不得**把它当"v2 无对应"丢掉（**丢弃即"控制面永远看不到本轮完成"**）。单测要断言：v1 形的 `step-finish` part 归一后**逐字段原样保留**。另：v1 的 `state.output`（string）映射到内部模型的工具输出；v1 `pending` 映射到内部"运行中"。
  4. **形状等价测试（替代原"web 侧四态映射"）**：断言"由 v1 形 part 派生"与"由等价 v2 形 content 项派生"的内部模型，在 **web 真正读取的字段集合**上完全相等（`type`/`id`/文本四元组/`synthetic`/`tool`/`state.status`/`state.input`/`state.output`/`state.error`）⇒ **web 无需任何改动**，由这条测试充当守门人。
  5. **零 DDL**：`schema.prisma` 无变更。
  6. **零 web 改动**：`web/src/components/chat/msg-parts.tsx` 与 `msg-tool.tsx` **保持原样**（其 `toToolStatus` 本就 `toLowerCase()` 后按 v1 同族取值映射）。
- **依赖**：T12、T14
- **风险**：边界函数与 driver 侧映射**两处各写一遍会漂移**（同一份内容经不同路径渲染出两张不同的卡）→ **对策**：两侧**同规则**（`tool`→`name`、`state.content[]`→`state.output`、`state.status` 小写、part id = `消息id:序号`），并用**同一组 fixture** 做一致性断言；边界函数**永不抛错**（不可识别输入降级为空集 + 一条 WARN），避免一个畸形 part 打断整条消息的落库。

### P8 验证与灰度

#### T21 契约测试 + 端到端验证

- **涉及面**：`worker/src/protocol/contract.spec.ts`、`worker/src/driver/*.spec.ts`、`worker/src/runtime/opencode-server.spec.ts`、`worker/src/runtime/opencode-server.integration.spec.ts`、`server/src/chat/message-parts.spec.ts`、`server/src/workers/worker.client.spec.ts`
- **交付物**：真 v2 serve 的集成测试夹具（起 `opencode serve` → 拿 baseUrl 与密码 → 跑 driver 用例 → 收尾 kill 进程组）；端到端用例（建会话 → prompt → 首字 → 终态 → 产出物归档）
- **验收标准**
  1. 集成测试在 CI 里可跑（需要 v2 二进制；无二进制时**跳过而非失败**，并单独标记）。
  2. 端到端：真实模型一次（或用 mock provider）走完 vteam 全链路，产出物落库。
  3. 契约测试：worker 与 server 两侧对新增端点的请求/响应类型双向断言（扩展 `worker/src/protocol/contract.spec.ts`）。
  4. `server` 全量 jest、`worker` 全量 jest、`lint:check` 0 error、`tsc --noEmit` 全绿。
- **依赖**：T9…T20
- **风险**：CI 无 v2 二支 → 集成测试形同虚设。**对策**：把 v2 二进制安装进 CI 镜像（与 Dockerfile 同一 `ARG`）。

#### T22 灰度与回滚

- **涉及面**：helm values、`server/src/workers/workers.service.ts:919-920`（版本闸门）、镜像 tag
- **交付物**：灰度顺序（见 §9）、回滚步骤、版本闸门在混跑期的行为定义
- **验收标准**
  1. 混跑期：v1 worker 与 v2 worker 同时注册时，调度器**只把任务派给版本匹配的 worker**（精确串过滤已具备，改为规范化 semver 串后仍成立）。
  2. 灰度首轮：1 个 v2 worker → 观察项清单（会话成功率 / 首字延迟 / 完成判定准确率 / MCP 探针输出 / 归一化 WARN 计数）。
  3. 回滚演练：镜像回退到 v1 CLI 后，v2 worker 注册的 `opencodeVersion` 与 v1 不匹配 → **不会被选中**（不得出现"v2 任务派给 v1 worker"）。
- **依赖**：T21
- **风险（已按实测订正）**：~~回滚到 v1 CLI 但数据卷已被 v2 就地迁移（`opencode.db`）→ v1 读不了~~ ⇒ **在 vteam 的隔离部署下这个前提不成立**：隔离域让 v1 时代的存储目录落在 v2 worker 的作用域之外 ⇒ v2 **不会**迁移它 ⇒ **只回滚代码 / 镜像（不恢复卷）时，v1 期历史仍在原处、v1 二进制仍读得到**；**读不了的只是 v2 窗口期内新建的会话**（在隔离域的 v2 形态 SQLite 里）。**对策不变、但理由变了**：**仍建议回滚前做卷快照并按快照恢复**——它是"回到 v1"的保守且正确的做法（恢复卷还能把 v2 窗口期的会话一并带回来），**不是**因为"不恢复卷就会丢掉全部历史"。**可执行步骤见 `docs/deployment.md` §八.6。**

#### T23 文档订正（D13）

- **涉及面**：`docs/agent-platform/07-opencode-v2-调研与架构决策.md`
- **交付物**：按 D13 表逐条订正；新增"实测基线（2026-10，v2.0.28 / 2.0.32）"小节，指向本计划；把 §7 的"跟踪 beta 每日发布"改为"跟踪正式版 release notes + config.json schema"
- **验收标准**
  1. D13 表中每一条订正都在文档中有对应修改，且**不残留**"beta"、"`@opencode-ai/sdk-next`"、"已移除"等过期表述。
  2. 文档中的路由示例全部带 `/api` 前缀。
  3. 文档明确写出"v2 prompt body 无 `system` 字段"这一关键事实。
- **依赖**：无（可并行）
- **风险**：无

---

## 6. 数据与存量兼容

### 6.1 v1 `parts[]` → v2 `content[]` 字段映射

| v1（`Message.parts[]`） | v2（`Message.content[]` / 消息顶层） | 兼容策略 |
|------------------------|------------------------------------|----------|
| `{type:'text', text}` | `{type:'text', text, state}` | 直接映射 |
| `{type:'reasoning', text}` | `{type:'reasoning', text, state, time}` | 直接映射 |
| `{type:'tool', tool, state}` | `{type:'tool', id, name, executed, state, providerState?, providerResultState?, time}` | 映射：`tool`→`name`；`state` 保留 |
| `state.status:'pending'` | （无对应） | 归一为"运行中" |
| `state.status:'running'` | `state.status:'running'` | 直接映射（但 `state.input` 是 object 而非 string）；⚠️ v2 的取值是**小写**（`Running` 只是类型名） |
| `state.status:'streaming'` | `state.status:'streaming'`（独立变体） | 直接映射 |
| `state.status:'completed'` | `state.status:'completed'` | 直接映射 |
| `state.status:'error'` | `state.status:'error'` | 直接映射 |
| `state.output`（string） | `state.content`（**array**） | 归一为字符串（数组元素拼接） |
| `{type:'step-start'}` | （无） | **可丢弃**（v2 无对应、**也没有任何消费方**） |
| `{type:'step-finish', reason:'stop', cost, tokens}` | **assistant 消息顶层**的 `finish` / `cost` / `tokens{input,output,reasoning,cache{read,write}}` **+ `session.step.ended` 事件**（两者都带这些值） | ⚠️ **合成并保留**（不是丢弃！）：v2 上游没有这个 part ⇒ **v2 driver 从消息的 `finish`/`cost`/`tokens` 合成一个 `step-finish` part** 再上送；归一化**逐字段原样保留**它——它是控制面的**「本轮完成」幂等键**（`findStepFinishPartKey` 读 `part.type === 'step-finish'`），**丢弃即"控制面永远看不到本轮完成"** |
| `{type:'file', mime, filename, url:'file://…'}` | `Prompt.FileAttachment {data, mime, source, name?, description?, mention?}` | 附件渲染沿用旧形（web 现有逻辑），新附件走新形 |
| `message.info.error = {name, data:{message, statusCode}}` | `message.error`（形状待 T9 实测确认） | 归一为 vteam 统一错误结构 |
| `message.info.role` | `message.type`（`'user'` / `'assistant'` / `'idle'` / …） | 归一：`type==='assistant'` ⇔ 旧 `role==='assistant'` |
| `{type:'agent'}` / `{type:'snapshot'}` / `{type:'patch'}` | （无直接对应；部分已被 `content.updated` 事件替代） | 旧数据保留渲染；新数据不再产生 |
| `part.synthetic`（合成文本标记） | （无对应字段） | ✅ **Q9 已关闭（实测）**：v2 的 `content[]` 项**没有** `synthetic` 字段，**驱动也从不设置它**（v1 同样不设置——实测 v1 会话 dump 里没有一项带 `synthetic`）。更关键的是：**v2 里工具调用是独立的 `content` 项（`type:'tool'`），与模型写的 `type:'text'` 项互斥**（实测：调工具的那条 assistant 消息**只有** tool 项、**没有**文本占位；最终那条 assistant 消息**只有**一个 `type:'text'` 项）⇒ **v1「工具占位文本污染回复」这条路在 v2 结构上封死**。`synthetic` 实为 **vteam 侧**标记（用于**注入**的上下文块，如 `[群聊历史消息]` / `<doclib>`），不是上游概念 ⇒ **`!synthetic` 过滤保留**：对两代 driver 产出的 part 都是空操作，但对 vteam 自己注入的合成块仍然正确 |
| `part.id`（v1 原生 `prt_…`） | v2 上游**没有** part id（由 worker 在**上送边界**合成） | 统一为 **P2a 方案**：文本 `${messageID}:text` / 思考 `${messageID}:reasoning` / 工具 `${messageID}:tool:${callID}` / `step-finish` `${messageID}:step-finish`（后者**原样不动**，控制面幂等键依赖它）；同类内容多条时以序号消歧。⚠️ **driver 与事件路必须共用同一个 helper（单点来源）**，且 id **跨重复轮询稳定**——server 按 `part.id` 合并，不稳定就会把同一段正文存成多份 |

### 6.2 双形态渲染策略

| 层 | 职责 | 策略 |
|----|------|------|
| worker | 采集 | 产出 v2 上游形态（`content[]`）→ **在边界归一成内部模型**再上送；并**合成 `step-finish` part**（控制面的完成幂等键，v2 上游没有） |
| server（写） | 落库 | `Message.content = {text, parts[]}` —— **写入时即归一为内部渲染模型**（内部模型沿用现有四元组 `text` / `summary` / `thoughts` / `detail` + `state.status` + `tool` + `id`），使 web 无需再区分 v1/v2。**P2b 已验证：v1 与 v2 的落库形态逐字段相同 ⇒ 零迁移、零 web 改动** |
| server（读） | 兼容 | 历史行是 v1 `parts[]` → 读时经 `normalizeParts()` 转成内部模型（**总函数**：不可识别输入降级为空集 + 一条只报形状的 WARN） |
| web | 渲染 | 消费内部模型（**v1/v2 落库形态相同 ⇒ web 零改动**） |

**为什么不做全量回填**：① 存量体量大，回填是一次高风险批量写；② 上游形态映射有损（v1 `step-finish` part 带 tokens/cost，v2 落到消息顶层与 `session.step.ended` 事件上，回填会丢信息或造信息）——但 ③ **归一发生在 driver 侧，落库形态本身没变** ⇒ 根本不需要回填；④ 双形态兼容的复杂度被限制在**一个函数**里（`normalizeParts`），可测可控。

**内部模型 id 规则**（避免 v1 `part.id` 与 v2 `content[].id` 冲突）：v1 用 `part.id`；v2 侧由 **worker 在上送边界统一**为 **P2a 的落地方案**——文本 `${messageID}:text`、思考 `${messageID}:reasoning`、工具 `${messageID}:tool:${callID}`、`step-finish` `${messageID}:step-finish}`（原样不动，控制面幂等键依赖它）；同类内容多条时以序号消歧（`${messageID}:text:${index}`）。⚠️ **driver 的合成 id 与事件路的 id 必须是同一套**（事件路拿不到 index）⇒ 否则 server 按 id 合并会把同一段正文存成两份；且 id 必须在**重复轮询之间稳定**。详见 D5。

### 6.3 明确不迁移的内容

| 不迁移项 | 理由 |
|----------|------|
| 历史 `step-start` part | v2 无对应、无消费方；新数据由事件承载；历史仅用于渲染，不需要回填 |
| 历史 `step-finish` part | **不是"丢弃项"**——它必须**逐字段保留**（控制面「本轮完成」幂等键）；只是**新数据由 v2 driver 合成**（v2 上游没有），历史行原样保留、不回填 |
| 历史 tool `state.output` 的原始数组形态 | v1 本就是字符串；无更高保真版本可迁 |
| 历史 `Message.content` 中 v1 独有的 `native` / `builtIn` 语义 | v2 agent 模型不同；仅在 UI 层按"缺失即非内置"处理 |
| opencode v1 的会话 JSON 文件 | v2 的一次性 legacy 导入（`/api/experimental/migration/v1`）**只在 legacy 路径上确实存在 v1 数据时才发生**；**vteam 的隔离部署下它不触发**（v1 数据不在作用域内）⇒ **v1 时代的历史原样留在盘上**，vteam 侧**既不复述、也不依赖**这份导入 |
| vteam 侧 `Session.instanceRef`（`ses_` id） | v2 前缀不变，**零 DDL** |

---

## 7. 测试与验证策略

### 7.1 分层

| 层 | 范围 | 落点 | 是否打真 v2 |
|----|------|------|-------------|
| 单元 | 解析器 / 映射表 / 归一函数 / 探针 | `worker/src/driver/*.spec.ts`、`worker/src/runtime/serve-log.spec.ts`、`server/src/chat/message-parts.spec.ts` | 否（用真实采集的 v2 样本作 fixture） |
| 契约 | worker ↔ server 的新增端点形状 | `worker/src/protocol/contract.spec.ts`、`server/src/workers/worker.client.spec.ts` | 否 |
| 集成 | driver 打真 v2 serve | `worker/src/runtime/opencode-server.integration.spec.ts`、新增 `worker/src/driver/v2-driver.integration.spec.ts` | **是** |
| 端到端 | vteam 全链路（@ 触发 → 首字 → 终态 → 产出物归档） | 现有 e2e 套件 + 手工冒烟 | 是 |

### 7.2 在测试里跑真 v2 server

1. 用与 `worker/Dockerfile` 同一 `ARG OPENCODE_CLI_SPEC`（`@opencode/cli@2.0.32`）安装二进制到 CI 镜像。
2. 测试夹具起 `opencode serve --port 0 --hostname 127.0.0.1`（**不带 `--pure`**，v2 无此 flag），设 `OPENCODE_SERVER_PASSWORD`（**必填**，v2 恒开鉴权）。
3. 从 stdout 解析 `server listening on http://…:PORT` 与 `server password <pw>`（若未设密码）。
4. 收尾：`process.kill(-pid)`（沿用现有进程组清理做法，`opencode-server.ts` 已有）。
5. **无二进制时跳过而非失败**，并单独打一条"集成测试未执行"的显式标记（不允许静默跳过）。

### 7.3 验收矩阵（决策 → 验证）

| 决策 | 验证任务 | 验收用例 |
|------|----------|----------|
| D1 单轨 + 接口缝 | T8、T18 | `server/`、`worker/` 中除 `v2-driver.ts` 外无 opencode 契约类型字面量；`v1-driver.ts` 已删（T18） |
| D2 版本闸门 | T1 | v1 版本串 → 启动 fail-fast；v2 版本串 → 放行；`unknown` → 告警不判死 |
| D3 控制面不直连 | T10、T18 | `server/` grep `prompt_async`/`/abort`/`/api/model` → 0 命中；prompt body 构造点全仓唯一 |
| D4 事件映射 + 上游身份幂等 | T12、T13 | 同 `(aggregateID,seq)` 重放 3 次只落 1 次；**worker 重启后**重放仍只落 1 次（上游身份稳定）；**server 重启仍丢去重状态**（内存表，已知限制）；**`ordinal` 不作逐帧判别**（逐帧去重靠帧 id）；ephemeral 事件不写状态；**终态只发一次**（终态闸门 `settle()` 一次性，陈旧 durable `seq` 不覆盖新证据）；**断线期间的 durable 事件经 `GET /api/experimental/session/{id}/log?after=<lastSeq>` 补齐且不重复落库**；**重连时清空累积器 + `onReconnect` 完成前不派发新帧** |
| D5 双形态兼容 | T20 | v1 样本与 v2 样本归一后产出等价内部模型；混合消息渲染不崩；零 DDL；**`step-finish` 归一后保留**（完成幂等键）；**web 零改动**（形状等价测试守门） |
| D6 角色注入 | T4（✅ 已完成）、T15、**D6(f)（✅ 已实现 + 实机证明）** | **T4 实测 PASS**：`agents.<n>.system` **确实进入最终模型请求**（被前置到 opencode 内置 system 段之前）；`POST /api/session/{id}/agent`（204）**确实**把该 agent 的 system 应用到后续 turn；`POST /api/session` 带 `"agent"` 同样生效。**节名 `agent`→`agents` 与键名 `prompt`→`system` 同时落地**（最终配置里有 `agents.<n>.system`、**无** `agents.<n>.prompt`）；`GET /api/config` 回显里 `system` 原样保留（且**无** `prompt` 键）；**禁止**用 prompt body 的 `agents:[{name}]`（实测 no-op）；**D6(f) 逐消息 blob 走插件交接**（真二进制断言：blob 在 **system 段**、**不在 user 段**、同一会话两次派发**逐字节相同**）；**文本前缀兜底恒可用** |
| D7 `delivery` 原生在飞注入 | T9、T14 | `delivery:"steer"` 注入到在飞会话被消化；**T4 实测：steer 在无活跃 run 时立即执行**（`inbox.enqueued` → `execution.started` 相隔 2~33 ms，**Q11 已关闭**）；`delivery:"queue"` 产生 `inbox.enqueued → inbox.delivered` 序列；`interrupt` 后 `interrupted:true`；**终态只由闸门的一次性收口发出**（不认 prompt 的 200 响应——那是入队项）；**轮询路与事件路经 `EventSignal` 合流**（P3 已落地：先问后记 + 宽限期 + `terminalEvidence` 留痕） |
| D8 工具/插件重写 | T5（✅ 已完成）、T19、T16b | **T5 实测：`.opencode/tools/*.ts` 文件自动发现已移除** → 产物必须是 `.opencode/plugins/*.ts` 的插件注册代码；生成的工具在 v2 serve 下被模型**直接 `tool_calls`** 一次；**`options:{codemode:false}` 必写**（否则只进 Code Mode 目录）；**`ctx.location.directory` 取代 `context.directory`**（v2 的 ToolContext 无 `directory`）；v2 分支带 `setup` 护栏、同一模块在 v1 serve 下也不炸；`git_<name>` 命名不变；生成产物过 `tsc --noEmit`；**双形态模块在 v1 与 v2 serve 下都能被加载** |
| D9 四个探针 | T2、T17 | `mcp list` 失败必报错（不再报"无服务器"）；版本解析 `2.0.28`；models 解析与 v1 一致 |
| D10 恒开鉴权 | T3 | 空密码 → fail-fast；密码错 → 401 且归类为配置错误；`.env.example` 文案已改 |
| D11 存储路径 | T16、T16b | `opencode.db` 重启后仍在；`cleanupAuthJson` 不删 db；auth.json 实际路径已实测记录；**隔离目录与 db/auth.json 同卷**；**落点在隔离域**（`<HOME>/.opencode-iso/data/opencode/`，**不是** v1 线的 `~/.local/share/opencode/`）——`opencode debug paths` 带 / 不带隔离各测一次可复核 |
| D12 静默降级可见化 | T7、T15、T16b | 归一化 WARN 被识别并点名键路径；注入后的配置**无**归一化诊断；**`plugins` 合并语义**与 `instructions` 只追加**不能靠配置键解决 → 由 T16b 的隔离 env 兜底**，启动日志显式声明隔离域 |
| D13 文档订正 | T23 | 过期表述全部消除；路由示例全带 `/api`；写明"无 `system` 字段" |
| **T14 五条语义**（完成判定 / 首字 / 工具态 / 文本聚合 / 错误抽取） | T14（✅ P3 已落地） | **完成判定规则未被重写**（v2 driver 合成 v1 兼容的 `step-finish`）；在飞豁免 `∈ {running, streaming}`（v2 无 `pending`、保留 `pending` 供 v1 回退）；工具态取值**小写**（与 v1 同族）；文本聚合**保留 `!synthetic` 过滤**（**Q9 已关闭**：v2 工具调用是独立 content 项 ⇒ 占位污染路径结构上封死）；**`state.output` 保持主形态**（只增对 `state.content[]` 数组的容错）；错误抽取**两代通吃**（v2 形 `{type,message,status,response{body}}` → ` (HTTP 401)`）；**合流缝**：先问后记 + 宽限期（500 ms）+ `terminalEvidence` 留痕；**激活**：exec-server 交闸门 ⇒ 一次 run 只发一个终态事件 |

### 7.4 不变的既有验收基线

- `server` 全量 jest（当前基线见 CI，≥4312 用例量级）、`lint:check` 0 error、`tsc --noEmit -p tsconfig.build.json`。
- `worker` 包 jest 全量、lint、tsc。
- 既有 e2e（Playwright）不得回归。
- **零 DDL**：`server/prisma/schema.prisma` 本次不得变更。

---

## 8. 风险与边界

### 8.1 静默降级类风险（最高优先级——它们不报错，只是悄悄变坏）

| 风险 | 触发条件 | 后果 | 缓解 |
|------|----------|------|------|
| 配置归一化丢弃 legacy 键 | 注入的 provider 段仍写 `reasoning`/`tool_call`/`attachment`/`modalities` | 模型能力声明消失；`executableModels` 仍按错数据工作 → "模型可用但工具调用失败" | T7 识别 WARN + T15 改写 provider 段；以"`GET /api/config` 无归一化诊断"作硬闸门 |
| **agent 角色提示键的"节名 + 键名"耦合改动** | T15 把节名 `agent` 改成 `agents`，却**沿用 v1 键名 `prompt`** | **所有角色提示静默丢失，无任何报错**（实测：v2 在 v2 原生 `agents:` 节下把 `prompt` 当未知键丢弃；同一份配置放在 v1 形 `agent:` 节下则会被**迁移**为 `system` —— 两节行为相反） | T15 把**节名 `agent`→`agents` 与键名 `prompt`→`system` 作为一次原子改动**落地；验收断言最终配置里 `agents.<n>.system` 存在、`agents.<n>.prompt` 不存在，且 v2 归一化回显（`GET /api/config`）里角色提示仍在 |
| **MCP `timeout` 拆分丢 `startup` 段** | vteam 写 v1 形单值 `mcp.<n>.timeout: <ms>` | 归一化只得到 `{catalog, execution}`，**`startup` 段丢失**（不是被默认值补齐）→ 启动阶段超时行为与 v1 不同 | T15 显式写 `timeout:{startup, catalog, execution}` 三段；验收断言归一化回显里 `timeout.startup` **存在**。（**`enabled`→`disabled` 的反转已实测由 v2 归一化器正确处理**：`enabled:true` → `disabled:false` = 仍启用，vteam 现键不构成风险） |
| **`external_directory` 默认允许** | v2 放宽了"项目外路径需询问"的默认值，而 vteam 未显式配置 | 权限矩阵**比 v1 宽松**（agent 可读写项目外路径而不询问） | T15 显式加 `{action:"external_directory",resource:"*",effect:"ask"}`；验收断言该规则在 `permissions[]` 中 |
| serve 日志格式变化 | v2 日志格式与 v1 logfmt 不同 | 模型错误的快速 abort 死掉 → 用户看到 300s "无输出"超时而非真实错误 | T2/T7 实测确认 v2 日志落点（**2.0.28 实测：logfmt 诊断落 stderr、banner 落 stdout** ✅ → `serve-log.ts` 仍可用；v2 文档已改用 `OPENCODE_LOG_LEVEL`，`--print-logs` 属未文档化行为，**不可依赖**）；落点变了则改 `serve-log.ts` 的路径与正则 |
| `--pure` 移除 | v2 无此 flag | worker 启动 exit 1（**显式失败，可接受**） | T2 移除分支；启动错误信息可操作；**T6 已关闭：没有等价物** → 唯一可靠手段是**隔离 `HOME`/`XDG_CONFIG_HOME`**（T16b） |
| **插件数组跨配置合并 ⇒ 以为 `plugins: []` 能清空，实际清不掉** | 项目 `opencode.json` 里写 `"plugins": []`（或干脆不写 `plugins` 键）想"只加载 vteam 自己的插件" | v2 的 `plugins` 数组在多份配置文件之间是**合并**不是替换（**T6 实测**）→ 用户的**全局插件照样被加载**：token 开销暴涨（v1 实测 `--pure` ≈1900 input tokens vs 非 pure ≈7601）+ 行为漂移 + 第三方插件可触达 workDir —— **正是 v1 `--pure` 当初要解决的问题**，且**没有任何 WARN** | **不能靠配置键**（`plugins: []` / `instructions: []` / `experimental` 全部无效）→ **T16b 以隔离 `HOME`/`XDG_CONFIG_HOME` 启动 serve**；必要时用 `plugins:["-<具体ID>"]` 精确禁用（**禁用 `["-*"]`**：会连内置 agent/provider 一起关掉 → `Agent not found: "build"`） |
| `mcp list` 探针失败被误报为"无 MCP 服务器" | v2 下 `mcp list --pure` 打印帮助 + `Unrecognized flag` 并 **exit 1**（**显式失败，非静默**） | 探针若忽略退出码 → MCP 状态上报"全无"→ 误判 opencode 未接 MCP | T17 以**非零退出码为主判据**（必须报错）；再叠加"输出不是帮助文本"的兜底校验 |
| `step-finish` 消失 | v2 上游没有该 part | 若**既不改完成判定、也不合成该 part** → 执行永不判终态 → 任务挂死；更隐蔽的是：**归一化时把它当"v2 无对应"丢掉** ⇒ 控制面的「本轮完成」幂等键（`findStepFinishPartKey` 读 `part.type === 'step-finish'`）永远取不到 → 每一轮都不落"完成" | T14 完成判定以事件为主；**v2 driver 从 assistant 消息的 `finish`/`tokens`/`cost` 合成并上送 `step-finish` part**；T20 验收标准 3 断言归一化**保留**它；集成测试断言"有文本无终态"不判完成 |
| `synthetic` 消失 | v2 assistant content 无该字段 | 工具占位文本混入最终回复 | ✅ **Q9 已关闭（实测）**：v2 里工具调用是**独立的 content 项**（`type:'tool'`），与 `type:'text'` 互斥——调工具的那条 assistant 消息**只有** tool 项、**没有**文本占位 ⇒ 这条路径在 v2 **结构上封死**。`!synthetic` 过滤**保留**（对 driver 产出的 part 是空操作，对 vteam 注入的合成块仍正确） |
| 鉴权恒开后密码为空 | 运维未配 `OPENCODE_SERVER_PASSWORD` | v2 自动生成随机密码 → worker 全部 401 | T3 fail-fast + 兜底解析；helm 显式下发密码 |
| **交接文件被写入了可变内容 ⇒ 前缀缓存静默塌掉**（D6(f)） | 交接文件里多了一个时间戳/计数器/随机 id（"顺手加个方便排查"） | 插件在**每次**模型请求都推这段内容 ⇒ provider 的 token 前缀**每次都变** ⇒ **整个会话的前缀缓存全量重缓存**——**不报错**，只是缓存命中率悄悄归零、账单与延迟跟着上去 | **compare-then-write**（同内容不重写）+ 插件**只读不写** + 文件内容**逐字节等于 blob**；真二进制契约测试断言**同一会话两次派发逐字节相同**（见 §8.2） |
| **"插件已加载"判据不分 location ⇒ blob 静默丢失**（D6(f)） | 用**全局**就绪标记判断插件是否生效 | v2 的插件**按 location 加载**（同一份插件文件在 serve 日志里出现**两次** `loading plugin`）⇒ 新 location 的第一次派发误判"就绪"⇒ blob 写进交接文件却**没有 hook 读它** ⇒ **blob 无声丢失** | 就绪标记**按 location 分桶**（`.ready/<location 哈希>.txt`）⇒ 判据与 hook 注册范围严格一致；**serve 每次（重）启清空全部标记**（宁可退回前缀，也不丢 blob）；首次派发落到未就绪 location ⇒ **退回文本前缀**（安全降级，**不丢**） |

### 8.2 契约类风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `/api/event` **volatile 契约**（慢消费者 overflow 断流、断线期间事件丢失） | 执行状态丢失 → 任务挂死 | T13 三通道：durable log 补齐（`?after=<lastSeq>`，**一等缓解**）+ 消息轮询兜底 + 重连后重同步；终态判定收口到一个函数 |
| **OpenAPI schema 与运行时不一致**（SSE 的 `event` 字段：schema 声明必填，2.0.28 运行时不发该行） | 按 schema 实现解析器 → 期望 `event` 字段恒为空 → 事件类型全丢 | **以实机抓帧为准，不要以 schema 为准**；T11 解析器不要求 `event:`，且优先取 `event:`、缺失回退 `data.type`；CI 用真实抓帧 fixture |
| **锁定版本与实测基线不一致**（本文档基线取自 2.0.28，锁版目标 2.0.32；已知差异：`GET /api/model` 响应包装、spec op 数 143 vs 144） | 按 2.0.28 的响应包装写解包 → 跑在 2.0.32 上静默解包失败 | **锁版即锁契约基线**：T1 用锁定版本重跑实测并出快照入库；差异项逐条登记 §10；解包集中在**一个** `unwrapData()`（容忍两种形态） |
| `durable.seq` 只在 durable 事件上有 | ephemeral 事件（`session.idle`/`permission.asked`/`form.created`）不可靠 | 映射表逐条标注；状态判定只用 durable；ephemeral 只触发"拉一次列表"动作 |
| v2 的 `GET` 类端点 **location 选择机制未验证** | `GET /api/agent`、`GET /api/session` 可能拿不到目标目录的 agent 集合 | Q7；未验证前，worker 侧改用"创建会话时绑定 `location` + 按会话读"的路径取 agent |
| v2 路由清单中**无 todo 端点** | "计划 Tab 步骤区"数据源断裂 | Q8；若确无，端点以 404 优雅降级（UI 隐藏步骤区），不阻塞主链路 |
| 插件 API 仍在演进 | v2 工具注册签名可能再变；⚠️ **`options.codemode` 未进官方文档**（活二进制 vs 文档冲突） | 锁 `@opencode/plugin` 精确版本；生成产物走编译期检查；v2 工具调用集中在**一个**适配层；**`options:{codemode:false}` 固化成 T19 的验收断言**（不依赖文档） |
| v2 assistant 消息的"终态字段名"未在契约基线给出 | 完成判定的落点可能猜错 | T9 实测确定后再写 T14；**禁止臆造字段名** |
| **去重表在内存 ⇒ server 重启后去重状态全丢**（**已知限制**，非缺陷） | server 重启后，同一条上游事件若被重投（worker 重连、SSE 与 log 两条路重复）会**再落一次库** | 已落地的缓解：幂等键改用**上游身份**（`upstream:<aggregateId>:<seq>` 等四层口径，见 D4）⇒ **跨 worker 重启的重复落库已修掉**；**跨 server 重启仍未覆盖**——本计划**零 DDL**，不引入持久化去重表 ⇒ 明确记录为已知限制，需要时再单独立项（§9.3 的回滚路径里"server 重启"与"数据回滚"一并考虑） |
| **`ordinal` 不是逐帧计数器**（**实机抓帧已确认**：同一条 assistant 消息的多帧 delta 全是同一个 `ordinal`，如 `ordinal:0`） | 若把它当逐帧单调量/逐帧去重判别 ⇒ 同一消息的多个 delta 被**折叠成一条**（正文只留最后一片） | **不用 `ordinal` 做单调闸门、不用它做逐帧判别**：worker 侧去重键只取 `durable:<aggregateId>:<seq>` / `event:<eventId>`；server 侧的键虽仍带 `ordinal`（`upstream:<eventId>:<ordinal>`），但**唯一性完全由 `eventId` 贡献**。**逐帧去重靠帧 id**（`evt_…` 唯一）。`ordinal` 只作参考 |
| **同 `ordinal` + 不同 `eventId` ⇒ 判为不同事件**（刻意的保守口径） | 同一帧被重投但 `eventId` 变了时，会**多应用一次** | 有意为之（宁可多处理一次，也不吞掉一条真实增量）。重复应用无害：`mergePartsById` 是 last-write-wins、单调文本守卫阻止文本回退 ⇒ 不会出现内容错乱 |
| ⚠️ **（待确认，未证实也未证伪）** v2 的 reasoning content 项可能带**自由形态的 `state` 对象**（契约里的 `Session.Message.ProviderState`，可选） | v1 的 reasoning part **没有** `state`（实测）⇒ web 靠"位置 + 消息是否流式中"推断「思考中」是有效的。若 v2 服务端真的填了这个 `state`，`p.state` 会是**对象**，而 web 的 `MsgThinking` 判的是 `state === "pending"` ⇒ **思考卡会直接显示"已完成"，"思考中"状态永不出现** | 抓到的帧里**没有 reasoning 消息** ⇒ **无法证实也无法证伪**。**归 T14 / web 侧**：用**一条真实的 v2 reasoning part** 确认 `state` 的实际形态；若确为对象，web 的 `MsgThinking` 需改成"对象 ⇒ 按流式/终态消息推导"，而不是读 `state === "pending"` |
| ⚠️ **交接文件的逐字节稳定性是 load-bearing 的**（D6(f) 插件交接；**改动前必读**） | 插件在 agent 循环的**每一次**模型请求都会触发（**每个工具往返都是一次新的模型请求**），而 provider 侧的 prompt 缓存**按 token 前缀**命中 ⇒ 交接文件里只要多一个**可变字段**（时间戳、计数器……），**整个会话的前缀缓存就被击穿**（每次请求都是新前缀 ⇒ 全量重缓存）——而且**不报错**，只是缓存命中率悄悄塌掉 | **三条硬约束**（已落地）：① 插件**只读不写**，读到啥推啥，**绝不**重新序列化/重排/加时间戳；② worker **compare-then-write**：内容相同 ⇒ **不重写**（inode/mtime 不变，也避免撕裂读），内容真变了 ⇒ 原子写（tmp + `rename`）+ 显式告警；③ 真二进制契约测试断言**同一会话两次派发的 blob 逐字节相同**。**交接文件内容必须逐字节等于 blob**（不做任何再加工） |
| ⚠️ **"插件已加载"的判据必须按 location 分桶**（D6(f) 实测） | v2 的插件是**按 location 加载**的（同一份插件文件在 serve 日志里出现**两次** `loading plugin`，对应两个 location）⇒ 用一个**全局**就绪标记会让**新 location 的第一次派发**误判"插件已就绪"⇒ blob 写进交接文件却**没有任何 hook 读它** ⇒ **blob 静默丢失**（最坏结果，且无任何报错） | 判据用**两个文件系统事实**：① 插件**产物**在位（`<workDir>/.opencode/plugins/vteam-system-handoff.ts`）；② **该 location 的**就绪标记在位（`.ready/<location 哈希>.txt`，由插件 `setup` 写）⇒ 判据与 hook 的注册范围**严格一致**。**serve 每次（重）启都清掉全部就绪标记**（宁可退回前缀，也不丢 blob） |
| ⚠️ **首次派发落到未就绪 location ⇒ 退回文本前缀** | 插件尚未为该 location 加载时，交接文件写了也没人读 ⇒ 退到**文本前缀**（blob 落在 user 段，优先级低于 system 段，但**绝不丢**） | **安全降级、不是丢数据**：生产流里会话 `move` 会**先启动该 location**，再决定载体 ⇒ 从第一次派发起就是插件路（**已实机证明**）。仍保留前缀作为永远可用的地板 |
| ⚠️ **（已确认的差异）** v2 的 `step-finish.tokens` **没有 `total`**（v1 有） | `parseUsageTokens` 读到 `totalTokens: 0` ⇒ **token 统计的总量展示受影响**（分项 input/output/reasoning/cache 仍在） | 这是**用量指标**的差异，**不是形态差异**（web 从不读 `tokens`）⇒ 不影响渲染；统计展示侧需按 v2 的实际 `tokens` 形状补 `total`（或改用 `input+output` 求和） |
| ⚠️ **（P3 实测已确认）** v2 的模型调用失败**仍然只体现在消息的 `error` 上**（消息**没有** `content` 数组 ⇒ vteam 内部 `parts=[]`） | v1 的「凭据错误 ⇒ parts 空、错误只在 `info.error` 里」这个坑**在 v2 原样复现** ⇒ 若只按"有没有内容"判成功，失败会被当成"空回复" | 错误抽取**两代通吃**（`data.message` → 顶层 `message` → 类型名；`data.statusCode` → 顶层 `status` → ` (HTTP 401)`；aborted 跳过）；**`session.execution.failed` 的 `data.error` 是更好的来源**（自带 HTTP 码与响应体）⇒ 该测试用例**保留**（对 v1/v2 都跑） |
| ⚠️ **闸门的"先问后记"不变量**（P3 实现时发现的真实 bug） | `peek()` 返回「事件证据 ?? 轮询证据」⇒ 若**先 `notePolling()` 再问 `peek()`**，闸门分不清「事件路还没说话」与「事件路说了 succeeded」⇒ **迟到的失败被静默丢弃**（失败被判成成功） | **契约要求"先问闸门、再记自己的证据"**（T14 验收标准 7）；宽限期内尤其不能提前 `notePolling`。改动闸门/合流相关代码时**必须连带复核这条顺序**（D4 已登记） |
| in-process SDK 路线未验证 | 若未来走 `@opencode/sdk` 进程内托管，多租户 + DB 持久化的可行性未知 | Q4/Q5；本计划**不采用**该路线 |

> **P2a 落地后新增的两条已知限制**
>
> 1. **v1 回退路径失去 SSE 快路径**（`OPENCODE_V2_ENABLED=false` 时）：SSE 订阅客户端是 **v2 专用**的（固定订阅 v2 的 `GET /api/event`），v1 serve 没有这个端点 ⇒ 退回 v1 模式时**拿不到实时流**，只能靠 **500 ms 轮询兜底**（`pollMs` 默认 500）。⇒ **回退路径可用、但实时性变差**（首字与流式正文的延迟从"事件驱动"退化为"轮询周期"）。§9.3 的"退回 v1"保险**只保证功能不挂，不保证体验一致**——灰度期要知情。
> 2. **`server.usage.recorded` 仍未映射**（在 72 条「已知未支持」清单里）：它与 `session.usage.updated` **并存**（v2 两个都发），后者的载荷已承载用量（`cost` + `tokens`）⇒ **用量不会被投递两次**；但也**不要假设"还有第二条用量通道"**——本版只映射 `session.usage.updated`（且它是 **ephemeral**，只能作参考、不能驱动状态）。

### 8.3 vteam 侧结构风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| **vteam 把 opencode part 原样存进 DB** | `Message.content.parts[]` 是 opencode 结构的**逐字拷贝** → 上游一变，历史数据语义漂移 | D5 归一为内部渲染模型后再落库；内部模型与 opencode 解耦。**P2b 已验证**：v1 与 v2 的**落库形态逐字段相同** ⇒ 本次的 v2 形态变更**实际为 nil**（零迁移、零 web 改动）；**残余风险只剩"未来的上游形态漂移"**，而它现在**只落在 `normalizeParts` 这一个边界**上 ⇒ 漂移的冲击面被收敛到一个函数 |
| 控制面直连导致双 prompt 构造分叉 | **已经发生**（server 漏 `system`，worker 有） | D3 + T18：全仓唯一 prompt 构造点；用单测锁死 |
| 版本闸门是精确串相等 | v2 打印 `opencode v2.0.28`、worker 上报 `2.0.28`、调度侧比对 `req.opencodeVersion` —— 三处格式必须一致 | T1 统一规范化 semver 串；T22 验收"混跑期不误派" |
| 存量 worker 与新 worker 混跑 | 老 worker 收到 v2 语义的 payload 会走老逻辑 | 精确版本过滤已隔离；过渡窗口内老 worker 只会收到老格式 |
| "v2 会就地迁移 v1 磁盘数据"（**原判断；实测已订正**） | **在隔离部署下不成立**：v2 的 `data` 目录 = `<HOME>/.opencode-iso/data/opencode`，与 v1 的 `<HOME>/.local/share/opencode` **不是同一个目录** ⇒ v1 数据不在作用域内、**不会被迁移**（实测：`opencode debug paths` 带 / 不带隔离各测一次） | **残余风险 = 隔离域被关掉**（`XDG_DATA_HOME` 指回 v1 目录）——那时迁移才是就地的、v1 连卷都读不了。**对策**：隔离域是**硬要求**，worker 上用 `opencode debug paths` 核对 `data`/`db` 落点（见 D11）。回滚口径见 **§9.3** |

### 8.4 边界（本次明确不做）

- 不改 `schema.prisma`（零 DDL）。
- 不改 `platform-mcp`（暴露给 opencode 的 MCP server）。
- 不做 v1/v2 双驱动、不做批量历史回填、不做 v2 插件生态适配。
- 不升级到 2.0.32 之外的任何版本。

---

## 9. 交付链与回滚

### 9.1 交付链

```
feat/opencode-v2-adaptation（基于 origin/main）
  → P0（T1-T7：版本闸门 + 契约基线快照 + **T4/T5/T6 三个 spike 已全部关闭**，结论已并入 D6/D8/D12 与 T16b）合入主干（验证结论单独成文）
  → P1-P3（T8-T14b：driver + 事件层 + 语义层〔含 D6(f) 逐消息 blob 的插件交接〕）一个 PR
  → P4-P5（T15-T18：配置/凭据 + 隔离 env + 控制面收敛）一个 PR
  → P6-P7（T19-T20：工具插件 + 存储形态边界〔web 零改动〕）各一个 PR
  → P8（T21-T23：契约/e2e + 文档订正）一个 PR
  → CI 绿（server jest + worker jest + lint + tsc + 集成测试打真 v2）
  → 合并 → tag v1.1.0 → Release Images
  → helm 灰度（1 worker → 10% → 50% → 100%）
  → 集群验证（真实 @ 触发 → 首字 → 终态 → 产出物归档）
```

**CI 必须包含**：v2 二进制安装（与 Dockerfile 同 `ARG`）→ 集成测试真跑（无二进制时显式跳过标记）。

**硬约束：server 与 worker 必须一起切换（不是"先切一个、观察另一个"）**：

| 组合 | 能否互通 | 原因 |
|------|---------|------|
| v1 server + v1 worker | ✅ | v1 线自洽 |
| **v2 server + v2 worker** | ✅ | v2 线自洽（本次目标） |
| **v1 server + v2 worker** | ❌ | v1 server 直连 opencode 的 **v1 路由**（`/session`、`/session/:id/prompt_async` …），这些路由 **v2 已移除**（v2 只剩 `/api/*`） |
| **v2 server + v1 worker** | ❌ | v2 server 改调 worker 的**执行端点**（`POST /sessions`、`POST /sessions/:id/prompt`、`GET /sessions/:id/messages`、`POST /sessions/:id/abort`、`GET /models`，鉴权 `X-Worker-Token`）——**v1 worker 没有这些端点**（v1 的执行端点只有 `/execute`、`/file`、`/agents`、`/todos` …） |

⇒ **两种混搭都不是"能跑但降级"，而是会话链路直接断**。⇒ 灰度期的正确形态是**硬切**：**先把 v1 worker 全部下线**，server + worker **一起**换到 v2 线，worker 先只起 1 个，再逐档扩副本数（1 → 10% → 50% → 100%）。
⚠️ **不要用 `worker.updateStrategy.partition` 做这次切换**——它会让 ordinal 0 保留 v1 镜像、其余升 v2 ⇒ **v2 server 会把任务派给 v1 worker**（调度器的版本过滤今天没有生产调用方，是**失效**的）。**可执行步骤见 `docs/deployment.md` §八.2。**

### 9.2 灰度观察项

| 观察项 | 判据 |
|--------|------|
| 会话成功率 | 与灰度前基线持平（不下降） |
| 首字延迟 | ≤15s 通过线、5s 目标线（沿用 phase4-worker-opencode D8） |
| 完成判定准确率 | "有文本无终态"不再被误判完成（用 `session.execution.*` 事件计数交叉验证） |
| MCP 状态上报 | 不再出现"全部未连接"（探针失败即报错） |
| 归一化 WARN 计数 | **必须为 0**；>0 即视为配置未改干净 |
| 401 计数 | **必须为 0**；>0 即查密码下发 |
| `durable.seq` 幂等 | 重放测试下重复落库为 0 |
| **v1 期会话历史仍在盘上**（回滚安全性的现场证据） | 隔离域**不碰** v1 的存储目录 ⇒ v1 期会话应**仍完整存在于** `<HOME>/.local/share/opencode/`（核对该目录存在、体积/文件数未变）；v2 窗口期新建的会话落在 `<HOME>/.opencode-iso/data/opencode/opencode.db`。⇒ 这是"只回滚镜像时 v1 期历史仍可读"的现场依据（见 §9.3 / D11） |

### 9.3 回滚

> ⚠️ **本节"数据层"的口径已按实测订正（2026-10）**：原表写的是"v2 启动时已就地迁移 v1 磁盘数据（`opencode.db`），v1 读不了该卷"——**这在 vteam 的隔离部署下不成立**。实测（`opencode v2.0.28` 的 `opencode debug paths`，**带 / 不带隔离各测一次**）：
>
> | 部署形态 | opencode `data` 目录 | `db` |
> |---|---|---|
> | v2 worker **带隔离域**（T16b：`XDG_DATA_HOME` → `<iso>/data`） | `<iso>/data/opencode` | `<iso>/data/opencode/opencode.db` |
> | v1 worker（真实 `HOME`） | `<realHOME>/.local/share/opencode` | `<realHOME>/.local/share/opencode/opencode.db` |
>
> ⇒ **两个目录不是同一个** ⇒ **v1 时代的存储落在隔离后的 v2 worker 根本看不到的地方** ⇒ v2 **不会**迁移它（一次性 legacy 导入在 legacy 路径上找不到东西、**不触发**）⇒ **v1 时代的历史原样留在盘上**。

| 层次 | 手段 | 限制 |
|------|------|------|
| 镜像层 | 把 `ARG OPENCODE_CLI_SPEC` 回退到 `opencode-ai@1.19.3` 并重建 | **代码层已删除 v1 driver**（D1）→ 镜像回退后 worker 跑不起来。**结论：镜像回滚不是有效回滚手段** |
| 代码层 | 保留 tag `v1.0.x`（v1 线最后一个绿 tag），helm 回滚到该 tag | 有效，但回滚后**新数据卷**需与旧 worker 匹配；且 v2 写过的 `Message.content` 是 v2 形态，v1 worker 渲染不了 → 回滚前需确认没有存量 v2 形态消息 |
| 数据层（**订正后**） | **仍然建议"连数据卷一起回滚"**（灰度前快照 → 回滚时恢复）——但理由**不再是**"v1 读不了那个卷" | **订正**：隔离域下 v2 **没有**就地迁移 v1 数据 ⇒ **只回滚代码 / 镜像（不恢复卷）时，v1 期历史仍在原处、v1 二进制仍读得到**；**读不了的是 v2 窗口期内新建的会话**（在 `<iso>/data/opencode/opencode.db`，v2 形态 SQLite）。⇒ **没有快照时的损失是"有界的"：只有 v2 窗口期的会话，不是全部历史**。**仍推荐快照 + 恢复**，因为它（a）是"回到 v1 形态"的**保守且正确**的做法，（b）能把 v2 窗口期的会话一并带回来。⚠️ 唯一会退化成"灾难级损失"的情形是**隔离域被关掉**（`XDG_DATA_HOME` 指回 v1 目录）——那时迁移是就地的、v1 连卷都读不了 |
| 结论 | **安全回滚路径 = 代码回滚到 v1.0.x tag + （建议）数据卷快照恢复 + helm 回滚** | 因为 D1 删除了 v1 driver，**没有"关个开关就退回 v1"的代码级开关**——这是 D1 决策的已知代价（已评估：v1 已冻结，维护双驱动不划算）。**订正**：原表写"**唯一**安全回滚路径"，容易被读成"不恢复卷 = 灾难"；**实测下不恢复卷的损失是有界的（仅 v2 窗口期会话）**，恢复卷是**保守推荐**而非"不恢复就全完"。**可执行步骤见 `docs/deployment.md` §八.6** |

**回滚时的数据影响（订正后的口径，运维必须知道）**：

| 数据 | 回滚（代码 / 镜像 + 卷）后 | 只回滚镜像（不恢复卷） |
|------|--------------------------|------------------------|
| 平台侧数据（任务 / 消息 / 产出物 / 成员 / 角色 / 模型凭据，MySQL） | ✅ **完好**（零 DDL，回滚不碰库） | ✅ 完好 |
| **v1 期**的 opencode 会话历史（`<HOME>/.local/share/opencode/`） | ✅ 完整恢复 | ✅ **仍在**、v1 二进制**仍读得到**（隔离域不碰它——这正是订正的核心） |
| **v2 窗口期**的 opencode 会话（`<HOME>/.opencode-iso/data/opencode/opencode.db`，v2 形态 SQLite） | ✅ 随快照恢复一并带回 | ❌ **v1 读不到**（数据还在卷上；切回 v2 仍可见） |
| 注入配置（`<WORK_DIR>/opencode.json`） | ✅ 回到 v1 形态 | ⚠️ v1 注入器重写自己管的段，但 v2 形态残留键仍在文件里 |

⇒ **"回滚会丢掉全部历史"是错的说法**：**丢的只是 v2 窗口期内新建的会话**（模型上下文与产出物文本；产出物**文件**本身在 `uploads` 卷 / MySQL 里，**不丢**）。
⇒ **因此仍然建议灰度前做卷快照**（命令见 `docs/deployment.md` §八.2 阶段 0 与 §八.6.3）：快照的价值是**把 v2 窗口期的会话也捞回来** + 兜住"隔离域被关掉"那种退化情形，**不是**"否则全丢"。

**已采纳的保险（对应上一行的建议）**：本计划把 **v1 driver 的删除动作从 T8 延后到 T18**（P5 之后）一次性完成，并保留 vteam 侧环境开关 `OPENCODE_V2_ENABLED`（非 opencode CLI flag）。这样在 P0–P7 期间仍有"退回 v1"的代码级退路，而 T18 交付后即彻底单轨、不留双驱动维护成本——**这是本计划里唯一值得付的保险成本**。

### 9.4 混跑期（v1 worker 与 v2 worker 共存）的调度行为

> ⚠️ **前提澄清**：混跑指的是"**server 已是 v2 线**，池子里同时有 v1 镜像与 v2 镜像的 worker"——**不是**"v1 server 配 v2 worker"那种混搭（**那种组合不互通**，见 §9.1 的硬约束）。
> ⚠️ **且今天的版本过滤是失效的**：调度器虽有 `opencodeVersion` 精确串过滤，但**当前没有任何生产调用方设置** `AssignmentRequirement.opencodeVersion` ⇒ 过滤**实际不生效**。⇒ **切换前必须先把 v1 worker 全部下线**（`docs/deployment.md` §八.0 事实 4 / §八.2 阶段 1）。本表描述的是"**若**过滤被真正启用"时的期望行为。

| 场景 | 期望行为 | 实现位置 |
|------|----------|----------|
| v2 任务（`req.opencodeVersion='2.0.28'`） | 只派给 `opencodeVersion==='2.0.28'` 的 worker | `workers.service.ts:919-920` 精确串过滤（**已具备**，但**当前无生产调用方设置** ⇒ 实际失效） |
| v1 任务（`req.opencodeVersion='1.19.3'`） | 只派给 v1 worker | 同上 |
| 无版本要求的任务 | 派给任意在线 worker → **可能跨版本** | 混跑期应**禁止无版本要求的派发**（或在 T22 里让 `req.opencodeVersion` 必填） |
| v2 worker 注册但版本串格式不统一 | 精确串相等 → 匹配不上 → 派发不到 | T1 统一规范化 semver 串（T22 验收项） |

---

## 10. 未决问题

> **状态**：**Q1 / Q2 / Q3 / Q11 已关闭**（T4 / T5 / T6 的实测结论，见 `docs/agent-platform/opencode-v2-spike-results.md`，可一键复现）；**Q9 已关闭**（P3 实测：v2 的工具调用是独立 content 项 ⇒ 工具占位污染这条路结构上封死）；**Q16 已关闭**（真栈实测：v2 的 MCP 是**五态**且 CLI 不是 serve 的探针，见 §2.9）；**Q17 / Q18 / Q19 已关闭**（D6(f) 插件交接落地时实测：逐消息 blob 有了 v2 原生载体、插件**按 location 加载**、推送的 system 段**落在内置段之后**）；**Q13（= U5）** 有单次样本但**未正式关闭**；**新增 U6 ~ U9** 四个未知；**Q20 为刻意未做的未来优化**（稳定/易变段拆分）。当前共 **24 项**：**已关闭 9 项**、**仍开放 15 项**。

| # | 问题 | 为何重要 | 谁来验 | 验证方法 | 阻塞哪个任务 |
|---|------|----------|--------|----------|-------------|
| Q1 | ✅ **已关闭**：`agents.<name>.system` 的内容**确实进入最终模型请求**（T4 实测 PASS；被**前置**到 opencode 内置 system 段之前）。`POST /api/session/{id}/agent`（204）**确实**把该 agent 的 system 应用到后续 turn；`POST /api/session` 带 `"agent":"<name>"` 同样生效。**prompt body 的 `agents:[{name}]` attachment 是 no-op**（实测：无 system 提示、assistant 消息 `agent` 仍是 `build`、无 `agent-switched` 消息、无 `session.agent.selected` 事件）→ **D6 候选 (c) 剔除**。证据：`docs/agent-platform/opencode-v2-spike-results.md` §2 + `evidence/t4-role-prompt.txt`；复现：`bash docs/agent-platform/opencode-v2-spike-results/repro.sh` | （已关闭，无残余） | worker 侧 | 已完成：`repro.sh` → `T4_RESULTS {"switch_agent_puts_system_in_request": true, "agents_attachment_is_noop": true}` | **无**（不再是 T15 的阻塞项） |
| Q2 | ✅ **已关闭**：`.opencode/tools/*.ts` 的**文件自动发现在 v2 已移除**（T5 实测：该目录下的文件**连 import 都不发生**）→ 工具**只能**经 `ctx.tool.transform` 注册，产物改为 `.opencode/plugins/*.ts` 插件注册代码。**`ToolContext` 键集合已实测** = `{sessionID, agent, messageID, id, signal, progress}` → **没有 `directory`**（取 `ctx.location.directory`）。**插件工具默认只能经 Code Mode 调用** → 必须显式 `options:{codemode:false}` | （已关闭，结论已并入 D8 / T19） | worker 侧 | 已完成：`repro.sh` → `T5_RESULTS {"session.tool.called": true, "session.tool.success": true}`；证据 `evidence/t5-tool-registration.txt` | **无**（不再是 T19 的阻塞项） |
| Q3 | ✅ **已关闭**：v2 **没有** `--pure` 的等价物（T6 实测 13 例候选矩阵）。`plugins: []` / 不写 `plugins` / `instructions: []` / `experimental`（只有 `portable_shell_scanner` / `subagent_depth` / `policies`）**全部 no-op**（`plugins` 是**跨配置合并**语义、`instructions` 只**追加**）；`plugins:["-*"]` **不可用**（连内置 `opencode.agent` / `opencode.provider.*` 一起关掉 → `Agent not found: "build"`，且无法把自家插件加回来）；`plugins:["-<id>"]` ✅ 可用且精确；`OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 是**追加**不是替换；`OPENCODE_DISABLE_PROJECT_CONFIG=1` 会连项目 `opencode.json` 一起杀掉。**唯一可靠手段 = 以隔离 `HOME` / `XDG_CONFIG_HOME` 启动 serve**（落地任务 **T16b**） | （已关闭，结论已并入 D8 / D12 / T16b） | worker 侧 | 已完成：`evidence/t6-matrix-round2/3/4-final-recipe.txt` | **无**（不再是 T2/T15 的阻塞项） |
| Q4 | `@opencode/sdk` 进程内托管的方法名 ↔ HTTP 端点映射（`opencode.sessions.prompt` 是否返回 inbox item？事件流如何以 `AsyncIterable` 暴露？） | 决定未来是否可省掉一次网络跳（当前 v2 HTTP serve 已够用，故**本计划不采用**该路线） | worker 侧（后续） | 读 `@opencode/sdk@2.0.32` 类型定义 + 最小样例 | 无（仅记录） |
| Q5 | 进程内托管在**多租户 worker** 下的 DB 持久化是否可行（每租户独立 location + 共享 `opencode.db`） | 同上；若可行可省掉 spawn 进程的开销与端口管理 | worker 侧（后续） | T21 之后单独立项 spike | 无（仅记录） |
| Q6 | `DELETE /api/session/{id}/form/{formID}` 是否等价于 v1 的 `POST /question/{id}/reject`（"用户点了拒绝"）？v2 的 `form.cancelled` 事件由谁触发？ | 影响"模型提问 → 用户拒绝"的交互闭环；映射错会导致拒绝后 agent 仍在等答案 | worker 侧 | T9 集成测试里构造一个 form 并分别试 reply / DELETE，观察事件与 agent 是否收口 | T9 → T12 |
| Q7 | v2 的 **GET 类端点**如何指定 location（`GET /api/agent`、`GET /api/session`）？`GET /api/session` 有 `directory` query 参数，但 `GET /api/agent` 未见；doc 07 提到的 `x-opencode-workspace` 头**未经实测** | 决定"按任务工作目录列出可用 agent"能否实现（v1 是 `GET /agent?directory=`） | worker 侧 | T9 实测：分别用 query / header / 依赖会话绑定三种方式试 `GET /api/agent`，比对返回的 `location` 字段 | T9 → T17/T20 |
| Q8 | v2 是否提供 todo 读取端点？实测的 117 条 `/api` 路由清单中**无 todo 端点** | vteam 的"计划 Tab 步骤区"数据源（`GET /session/{id}/todo`）可能断裂 | worker 侧 | T9：翻 v2 的 `GET /openapi.json` 全量 paths（118 条）确认；若确无 → 端点 404 优雅降级，UI 隐藏该区 | T9 → T8（`listTodos` 先留空实现） |
| Q9 | ✅ **已关闭（实测）**：v2 里**没有**"合成文本 / 工具调用占位"这回事——① v2 的 `content[]` 项**没有** `synthetic` 字段，**驱动也从不设置它**（v1 同样不设置：实测 v1 会话 dump 里没有一项带 `synthetic`）；② **v2 里工具调用是独立的 `content` 项（`type:'tool'`）**，与模型写的 `type:'text'` 项**互斥**——实测调工具的那条 assistant 消息**只有**一个 tool 项、**没有**任何文本占位；最终那条 assistant 消息**只有**一个 `type:'text'` 项 ⇒ **v1「工具占位文本污染回复」这条路在 v2 结构上封死**。③ `synthetic` 实为 **vteam 侧**标记（用于**注入**的上下文块，如 `[群聊历史消息]` / `<doclib>`），不是上游概念 ⇒ **`!synthetic` 过滤保留**（对两代 driver 产出的 part 是空操作，对 vteam 注入的合成块仍然正确） | （已关闭，结论已并入 §2.4 / §6.1 / T14） | worker 侧 | 已完成：真实 v2.0.28 run（无凭据 mock provider + 一个插件工具），逐字 dump assistant 消息的 `content[]` 构成 | **无**（不再是 T14 的开放项） |
| Q10 | v2 的 `assistant` 消息用哪个字段判定"这条消息已终态"？（契约基线给出 `finish?`/`rawFinish?`/`outcome?`/`error?`，但未指明哪一个是完成判定的权威位） | 直接决定"有文本无终态"的误判率——v1 的铁律就是不能判成完成 | worker 侧 | T9/T14：跑一次真实 run，比对 `finish`/`rawFinish`/`outcome` 与 `session.execution.succeeded` 事件的出现时机，取一致的那个 | T9 → T14 |
| Q11 | ✅ **已关闭**：`delivery:"steer"` 在**当前无 run**时**立即执行**（T4 实测：`session.inbox.enqueued` → `session.execution.started` 相隔 **2~33 ms**，不排队等待下一轮）。追加事实：v2 的 prompt **默认 delivery 就是 `steer`**；`POST /api/session/{id}/prompt` 返回的是**入队项**不是最终答复 → 完成判定只能看 `session.execution.*` 终态事件 | （已关闭，无残余） | worker 侧 | 已完成：`repro.sh` → `T4_STEER_EVENTS`（含毫秒时间戳差） | **无** |
| Q12 | `POST /api/session/{id}/interrupt?resume=true` 的精确语义（"恢复待投递的 steering 输入与下一项控制指令，排队中的 prompt 仍停放"）在 vteam 的在飞注入场景下是否需要 | 决定"中断并继续"（vteam 是否有此诉求）与"纯中断"的区分 | worker 侧 + 产品 | D7 已给映射（`resume=false`=纯中断）；`resume=true` 是否被 vteam 使用由产品决定 | 无（可先只用 `resume=false`） |
| Q13 | **（= U5）** v2 是否**实际发出** v1 legacy 事件（`message.updated` / `message.part.updated` / `message.part.delta`）？v2 源码含 `schema/src/v1/legacy-event.ts`，定义了这些 v1 事件名。**T4 spike 抓到的 3 个会话的完整 SSE 帧里命中数均为 0**（`server.connected` 命中 1，v2 事件 24 种）——但**只是单次样本**，未正式关闭 | 决定 vteam 事件层是否需要兼容分支；若 v2 真会发，vteam 可能收到"半 v1 半 v2"的混合流 | worker 侧 | `grep -c 'message.part.delta' docs/agent-platform/opencode-v2-spike-results/evidence/t4-sse-frames.log` → 实测 0；**建议在 T11/T12 的契约测试里固化这条断言**（跑满一轮含工具调用的会话再断言） | T11 / T12（不阻塞） |
| Q14 | `GET /api/experimental/session/{sessionID}/log` 的**返回形态与参数**是否如预期（`after=<seq>`、`follow=`；`AsyncIterable<SessionLogItemEncoded>`）？该端点在 `experimental` 命名空间，稳定性未知 | 这是 D4 对抗 SSE volatile 契约的**一等缓解手段**（按 seq 精确补齐断线期间的 durable 事件）；形态不符则 T13 的补齐逻辑要改 | worker 侧 | T1 契约基线快照里确认该端点存在与参数；T13 实现时用真 serve 验证 `?after=<seq>` 能补齐断线期间的事件 | T13 |
| Q15 | **（已解答：极性）** v2 归一化器把 `enabled`→`disabled` 的反转处理**正确**：v1 形 `"enabled": true` → 归一化为 `"disabled": false`（= 仍启用）——**vteam 现写的 `enabled` 键不危险**，不构成"全被禁用"。**（仍开放）** `timeout` 三段拆分后 `startup` 段丢失的语义：v1 单值 timeout 在 v2 的 `startup` / `catalog` / `execution` 三段之间应如何分配 | 决定 T15 的 MCP 节改写：极性已定，但**三段 timeout 怎么写**决定启动阶段超时行为（归一化 v1 单值时 `startup` 段会**丢失**，不是补默认值） | worker 侧 | T15 实测：同一份配置分别写 `enabled:true` / `disabled:false` / `disabled:true`，看 `GET /api/mcp` 的实际回显（**极性已验**）；再对 `timeout` 三段各取不同值（如 `{startup:5000,catalog:30000,execution:120000}`）看各段实际生效位置 | T15 |
| Q16 | ✅ **已关闭（真栈实测）**：v2 的 MCP 状态是**五态**（`connected` / `pending` / `disabled` / `failed` / `needs_auth`），**1:1、不折叠**——`pending`（还在连）与 `disabled`（配了但关着）**都不是 `failed`**（折叠即谎报）。**两端契约同步扩到五态**：worker `McpServerStatus`（`worker/src/protocol/worker-protocol.ts`）↔ server `MCP_STATUS` + `@IsIn`（`server/src/mcp-servers/dto/mcp-status.dto.ts`）。同时确认 **v2 的 CLI 不是 serve 的探针**（§2.9：CLI 绑共享托管后台服务 49374，读的是另一个作用域）⇒ 探针改为直读 serve 的 `GET /api/model` / `GET /api/mcp`。⚠️ **升级顺序是硬约束：先 server 后 worker**——server 的 `@IsIn` 必须**先**接受五值，否则 worker 一上报新值 ⇒ **整条心跳 400**（`mcpStatus` 是 `@ValidateNested({each:true})`，一个非法值 ⇒ 整包校验失败）⇒ **worker 被判离线**；**滚动更新 worker 只有在 server 已是新版之后才安全** | （已关闭，结论已并入 §2.9 / D9 / T17 补充验收标准） | worker 侧 + server 侧 | 真栈实测：worker 探针读 serve 的 `GET /api/mcp` 报 `connected`、注册载荷带 `executableModels`（**10** 个 id，与 serve 的 `GET /api/model` 一致）；server `MCP_STATUS` + `@IsIn` 已扩到五值；web 侧 `MCP_STATUS_THEME` 已按五态渲染（`pending`=连接中 / `disabled`=已停用），并有 `app-unit` 纯单元门守住"主题表对五态完备" | **无**（顺序约束已进 `docs/deployment.md` §八.0 事实 5 / §八.1 / §八.2 阶段 1 与 `chart/vteam/templates/NOTES.txt` 第 9 条） |
| U6 | v2 是否仍有 **`CLAUDE.md` 回退**？v2 文档称只发现 `AGENTS.md`，但 **T6 spike 未实测**（附录 C 现记的是"读文档"结论） | 决定 workDir 里若出现 `CLAUDE.md` 会不会被注入 system——这会破坏"角色提示唯一来源"的假设，也影响 T16b 的"workDir 不放 `AGENTS.md`"这条约束要不要扩到 `CLAUDE.md` | worker 侧 | 在项目目录放 `CLAUDE.md`（含 `CLAUDE_MARKER`）与 `AGENTS.md`（含 `AGENTS_MARKER`），跑一次 prompt，`grep -o 'CLAUDE_MARKER\|AGENTS_MARKER' docs/agent-platform/opencode-v2-spike-results/evidence/t5-recorded-model-requests.jsonl` → 期望只出现 `AGENTS_MARKER` | T16b（不阻塞主线） |
| U7 | `provider.package = "aisdk:@ai-sdk/openai-compatible"` 这种**显式**写法，是否与归一化器"迁移 `npm` 时自动加 `aisdk:` 前缀"的行为冲突（会不会变成 `aisdk:aisdk:…`）？—— 直接影响 T7/T16 写的 provider 段 | 写错 → provider 包名解析不到 → **模型全部不可用**且只在运行时暴露 | worker 侧 | 把 mock 配置里的 `package` 改成 `"aisdk:@ai-sdk/openai-compatible"`，重启 serve，`curl -s -u opencode:<pw> http://127.0.0.1:<port>/api/model \| grep -q spike-model` → 期望命中；再 `GET /api/config` 看归一化后的 `package` 值 | T7 / T16 |
| U8 | worker 镜像里 OmO 的 **v2 形态入口**从哪来？`bunx oh-my-openagent@latest install --platform=opencode` 装的是 **v1 形态**（`{server}`），而 **v1 插件实现在 v2 不会运行**（官方迁移指南明写） | 决定 OmO 集成在 v2 下是"可用"还是"必须禁用"；也决定 T16b 里"OmO 条目搬进项目 `plugins`"这一步是否真的生效 | worker 侧 | 在 worker 镜像里 `node -e 'const p=require("oh-my-openagent");console.log(Object.keys(p.default\|\|p))'` → 期望看到 `id` 与 `setup`；再在 v2 serve 下看 `oh-my-openagent` 是否 `state.status==="active"`。**上游已有同思路的参考实现**（本机 `/Users/mac/.local/share/omo-v2/plugin/index.ts`，**仅作参考，不得写入仓库或镜像**） | T16b / T19（不阻塞主线） |
| U9 | **受管 / 系统配置目录**（`/etc/opencode`、`/Library/Application Support/opencode`）里的插件如何压制？v2 serve **会 watch 它**，且它**不受 `XDG_CONFIG_HOME` 控制**；只有 `policies` 能压，而 policies 属托管配置、项目配置覆盖不了 | 决定 T16b 的隔离方案在**被 MDM 托管的机器**上是否还有漏洞（用户级插件进不了作用域，机器级插件仍可能进） | 运维 + worker 侧 | `sudo mkdir -p /etc/opencode/plugins && sudo cp probe.ts /etc/opencode/plugins/` → 起 serve → 看插件是否进入作用域；能进则只能用 `policies`（`{action:"plugin.use",…}`）压 | T16b（**已知残留，不阻塞主线**） |
| Q17 | ✅ **已关闭（实现 + 实机证明）**：vteam 的**逐消息 blob**（平台协议 / 岗位职责 / 派发规则 / 记忆规则 / 团队上下文…）在 v2 **有了原生载体**——**插件交接**（D6 候选 (f)）：worker 把 blob **原样**写进 `<workDir>/.vteam-system-handoff/<sessionID>.txt`，插件 `<workDir>/.opencode/plugins/vteam-system-handoff.ts` 在 `ctx.session.hook("context")` 里读它 → `event.system.push({type:"text",text})` ⇒ **落在模型请求的 system 段**。**实机证明**（重建 worker + 真实平台派发 + 真 blob + 录制的模型请求）：**system 段 20 688 字符**——前 13 323 是 opencode 内置段，其后是 blob（"你是 AI 协作平台的 Agent…" → "…- 测试-1（实例 id: tmm_0000000005，角色: tester）"），blob 是 system 段的**最后一项**；**user 段的消息**（"The working directory has been changed to …" / "【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）…"）**不含 blob** | （已关闭，结论已并入 D6 / §2.6 / §2.5） | worker 侧 | 已完成：`worker/src/driver/v2-system-handoff.ts` + `.spec.ts`（19 个单测）+ `.real.spec.ts`（opt-in 真二进制契约测试：blob 在 system 段、不在 user 段、同一会话两次派发**逐字节相同**） | **无** |
| Q18 | ✅ **已关闭（实测）**：**v2 的插件是「按 location 加载」的**——同一份插件文件在 serve 日志里出现**两次** `loading plugin`（对应两个 location，每个 location 一次 `setup`）。⇒ "插件在别处加载过"**推不出**"本会话的 location 也加载了" | 决定"插件路径是否真的生效"的判据怎么写：用**全局**就绪标记会让**新 location 的第一次派发**误判就绪 ⇒ blob 写进交接文件却**没有 hook 读它** ⇒ **blob 静默丢失**（最坏结果） | worker 侧 | 已完成：就绪标记**按 location 分桶**（`.ready/<location 哈希>.txt`，由插件 `setup` 写），判据与 hook 的注册范围**严格一致**；serve 每次（重）启清空全部标记 | **无** |
| Q19 | ✅ **已关闭（实测）**：插件 `event.system.push(...)` 落在 **opencode 内置 system 段之后** ⇒ **可缓存的前缀是 `[内置][blob][消息…]`**——常量部分（内置段）仍在 blob **之前** ⇒ **前缀缓存受益**（若落在内置段之前，常量部分会被推到可变 blob 后面，内置前缀的缓存就会受损）。⚠️ **与 v1 的次序不同**：v1 把 blob 放在 body 级 `system` 里（**前置**在最前），v2 的插件**只能追加** ⇒ 这个差异**只在跨版本升级那一次**有影响（一次重新缓存），**v2 内部次序稳定** | 决定"把 blob 推进 system 段"会不会**损害** provider 的 prompt 缓存命中 | worker 侧 | 已完成：真二进制录制模型请求，实测 system 段的构成与次序（见 Q17） | **无** |
| Q20 | **（刻意未做的未来优化）** blob 的**稳定段 / 易变段拆分**：真实 blob 里有几段**易变**内容（【任务状态】/【团队上下文】/【群聊回复要求】）在两次派发之间会变 ⇒ 缓存前缀**从那一点断掉**，其后的内容重新缓存。**这与 v1 完全相同**（v1 同样把整段 blob 放在 body 级 `system` 里、每次 prompt 都变）⇒ **不是回归，是遗留成本**。**稳定的/易变的拆分**（把易变段挪到 blob 之后、或分两次推送）可以进一步稳住前缀，**本次刻意未做** | 直接影响 provider 的 **prompt 缓存命中率**（用户关心的口径）：拆分后前缀可覆盖到易变段之前的那一整段 | worker 侧（后续） | 拆出稳定/易变两段后，用真二进制录两次派发的模型请求，断言**易变段之前的前缀逐字节相同**（当前只能断言"同一会话两次派发的 blob 逐字节相同"，因为 blob 整体在变） | 无（**未来优化**，不阻塞主线） |

---

## 附录 A. v2 端点速查（v1 → v2 对照）

| v1（vteam 在用） | v2（实测） | 请求体 / 参数 | 响应形状 |
|------|------|------------|----------|
| `POST /session` | `POST /api/session` | `{id?, parentID?, title?, agent?, model?, location?:{directory}, metadata?, permissions?}` | `200 {data: Session.Info}` |
| `POST /session/{id}/prompt_async?directory=` | `POST /api/session/{id}/prompt` | `{id?, text(必填), files?, agents?, skills?, metadata?, delivery?:"steer"\|"queue", resume?}`（**无 system / 无 parts / 无 directory query**） | `200 {data: Session.Inbox.User}` |
| `GET /session/{id}/message` | `GET /api/session/{id}/message` | query：`limit, order, cursor, type`（`type` 枚举：`agent-switched, model-switched, location-switched, user, synthetic, system, skill, shell, assistant, compaction`） | `{data: Session.Message.Info[], cursor:{previous,next}}` |
| `GET /session/{id}/todo?directory=` | **未在 v2 路由清单中出现** | — | → Q8 |
| `GET /question`（全局） | `GET/POST /api/session/{id}/form` | POST body（建 form） | `{data: [...]}` |
| `POST /question/{id}/reply` | `POST /api/session/{id}/form/{formID}/reply` | body **`{answer*}`**（v1 是 `{answers: string[][]}`，**形状变了**） | — |
| `POST /question/{id}/reject` | `DELETE /api/session/{id}/form/{formID}`（唯一候选） | query：`message?` | `204`（取消/拒绝路径；语义 → Q6） |
| `GET /permission`（全局） | `GET/POST /api/session/{id}/permission` | POST body：`{id?, action*, resources*[], save?[], metadata?, source?{type:"tool",messageID,id}, agent?}` | GET → `{data: [...]}`；POST → `{data:{id, effect:"allow"\|"deny"\|"ask"}}`（vteam **主动发起权限询问**用） |
| `POST /permission/{id}/reply` | `POST /api/session/{id}/permission/{requestID}/reply` | body **`{decision:"once"\|"always"\|"reject", message?}`**（v1 是 `{reply:…}`，**键名变了**） | — |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` | query：`resume=true\|false` | `{interrupted: true\|false}` |
| `GET /agent?directory=` | `GET /api/agent` | location 选择机制 → Q7 | `{location, data: Agent.Info[]}` |
| `GET /provider` | `GET /api/provider` | — | `{location, data: Provider.Info[]}` |
| `GET /api/model` | `GET /api/model` | — | 2.0.28 实测 `{location, data: Model.Info[]}`；⚠️ **2.0.32 spec 已改为裸数组** `Model.Info[]`（基线漂移，见 T1） |
| `GET /` | `GET /api/info` | — | `{version, pid, urls[], paths{tmp}, capabilities{persistentPty}}` |
| `GET /event`（SSE） | `GET /api/event` | — | `text/event-stream`；**运行时不发 `event:` 行**（OpenAPI schema 声明 `event` 必填但 2.0.28 不发），类型在 `data.type` |
| — | `GET /api/experimental/session/{id}/log` | query：`after?`（seq）、`follow?` | `AsyncIterable<SessionLogItemEncoded>`——**按聚合的 durable 事件日志，可重放**（D4 的一等缓解手段） |
| — | `POST /api/session/{id}/agent` | `{agent: Agent.ID}` | `204` |
| — | `POST /api/session/{id}/model` | `{model: Model.Ref}` | `204` |
| — | `GET /api/config` | — | **数组**：`[{type:"document",path,info},{type:"directory",path,info}]`（低→高优先级） |
| — | `GET /api/plugin` | — | 插件清单（含 builtin 与 local）；⚠️ **不可靠**：location 作用域 + **惰性发现**（location 没起来时返回空数组）+ `setup` 异步（实测还有"同一次运行里返回 89 条 / 返回 `total=0` 而插件明明已加载"）→ **不要用它当"插件是否加载"的判据**，改用 serve 日志的 `msg="loading plugin"` 行 + 工具是否出现在模型请求的 `tools[]` |
| — | `GET /api/session/active` | — | `Record<sessionID, SessionActive>` |
| — | `PATCH /api/session/{id}/inbox/{inboxID}` | body `{delivery*:"steer"\|"queue"}` | `204`（**运行期改投递策略**） |
| — | `GET /api/session/{id}/context` | — | 末次压缩后的消息 |
| — | `GET /api/session/{id}/diff` | query：`from?`, `to?`, `context?` | 按轮次按文件的结构化 diff |
| — | `POST /api/session/{id}/compact` | body `{id?, delivery?}` | `{data: Session.Inbox.Compaction}` |
| — | `POST /api/session/{id}/synthetic` | body `{text*, description?}` | `{data: Session.Inbox.Synthetic}` |
| — | `PUT /api/session/{id}/environment` | body `{variables*}` | — |
| — | `POST /api/session/{id}/move` | body `{directory, delivery?}` | — |
| — | `POST /api/session/{id}/fork` | body `{before?}` | — |
| — | `POST /api/experimental/session/{id}/generate` | body `{prompt*}` | `{data:{text}}` |
| — | `GET /api/experimental/session/{id}/export` / `POST /api/experimental/session/import` | query：`sanitize?` | — |
| — | `GET /api/experimental/session/stats` | query：`from`, `to`, `project`, `timezone`, `tools` | — |
| — | `GET /api/experimental/migration/v1` | — | `{"status":"completed"}`（v1→v2 **一次性 legacy 导入**状态；**仅当 legacy 路径上确有 v1 数据时才发生**，隔离部署下**不触发** → D11 / §9.3） |
| — | `GET /openapi.json` | Basic 鉴权 | OpenAPI 3.1 spec（276KB / 118 paths / 285 schemas） |
| — | `GET /doc` | — | API 文档页 |
| — | `GET /api/session/{id}/inbox` | — | `{data: Session.Inbox.Info[]}`（未投递的持久化工作项，按入队序） |

## 附录 B. v2 事件目录（type / durability / data 字段 / vteam 映射）

> `[D]` = durable（带 `durable:{aggregateID,seq,version}`，可作幂等键）；`[E]` = ephemeral（**不可重放，不得用于状态判定**）。
>
> 本目录由**已发布的 `@opencode/core` 2.0.32 类型定义**导出，并与 **live 2.0.28 实机抓帧**交叉核对（§2.5 的真实帧样本 + `session.created` 的 `durable` 结构一致）。**以实机抓帧为准**——OpenAPI schema 与运行时已发现不一致（见 §2.5）。
>
> **T4 spike 的追加核对**（`docs/agent-platform/opencode-v2-spike-results.md` §2）：`session.agent.selected` **只在 `POST /api/session/{id}/agent`（或建会话时带 `"agent"`）之后**发出，对应会话里一条 `type=agent-switched` 消息；**prompt body 的 `agents:[{name}]` attachment 是 no-op → 不产生 `session.agent.selected`、也不产生 `agent-switched` 消息**（assistant 消息的 `agent` 字段仍是 `build`）→ vteam 的 agent 切换**必须走 `POST /api/session/{id}/agent`**。
>
> ⚠️ **`session.tool.*` 事件里的工具状态取值是小写** `running` / `streaming` / `completed` / `error`——`Running`/`Streaming`/`Completed`/`Error` 只是 OpenAPI 的**类型名**（`Session.Message.ToolState.*`），**不是取值**。这与 v1 的取值**同族** ⇒ 现有 web/server 的四态映射继续有效（web 的 `toToolStatus` 本就 `toLowerCase()` 后再映射）。

| v2 事件 type | 耐久 | 关键 data 字段 | vteam 映射 |
|--------------|------|----------------|-------------|
| `session.created` | D | `projectID, global` | `session.updated`（新建） |
| `session.agent.selected` | D | `agent, previous` | `session.updated`（agent 切换） |
| `session.model.selected` | D | `model, previous` | `session.updated`（模型切换） |
| `session.moved` | D | `location` | `session.updated` |
| `session.renamed` | D | `title` | `session.updated` |
| `session.metadata.updated` | D | `metadata` | 忽略 |
| `session.permissions` | D | `permissions[]` | `session.updated` |
| `session.viewed` | D | `idle` | 忽略 |
| `session.deleted` | D | — | 会话失效 → 触发重建路径 |
| `session.forked` | D | `parentID` | 忽略 |
| `session.usage.updated` | **E** | `sessionID, cost, tokens{input,output,reasoning,cache{read,write}}` | token/cost 指标。⚠️ **实机抓帧：该事件没有 `durable` 块 ⇒ 它是 ephemeral**（本表早前标成 `[D]` 是错的）→ **不得用于状态判定**；映射为 `session.updated{usage}` 且**刻意不带 `status`**（带一个 `status:'running'` 会把已 idle 的会话改回运行中） |
| `session.usage.recorded` | E | — | token/cost 记录（与 `session.usage.updated` 并存） |
| `session.inbox.enqueued` | D | `inboxID, sessionID, item{type,payload,delivery}` | 在飞注入记账（`delivery` 判定 steer/queue） |
| `session.inbox.delivered` | D | `inboxID` | prompt 已投递 |
| `session.inbox.cancelled` | D | `inboxID` | 注入被取消 |
| `session.inbox.delivery.changed` | D | `delivery, inboxID` | 投递策略变更 |
| `session.execution.started` | D | `sessionID` | `session.updated`（running） |
| `session.execution.succeeded` | D | `sessionID` | **`task.completed`（主终态）** |
| `session.execution.failed` | D | `sessionID, error{type,message,status,response{body}}` | **`agent.status`（error）** |
| `session.execution.interrupted` | D | `reason, sessionID` | `agent.status`（interrupted） |
| `session.step.started` | D | `assistantMessageID, agent, model, started` | step 维度的 running |
| `session.step.streamed` | D | `assistantMessageID` | 忽略 |
| `session.step.ended` | D | `assistantMessageID` | step 完成 |
| `session.step.failed` | D | `assistantMessageID, error{…}` | step 失败 |
| `session.text.started` | D | `sessionID, assistantMessageID` | 文本 part 起 |
| `session.text.delta` | **E** | `sessionID, assistantMessageID, ordinal, delta` | **文本流式 delta**（增量字段是 **`delta`**，不是 `text`）。⚠️ **`ordinal` 不是逐帧计数器**——它是「同类内容流」的序号（**实机抓帧：同一条 assistant 消息的多帧 delta 全是同一个 `ordinal`**（如 `ordinal:0`））⇒ **不可当逐帧单调闸门、也不可当逐帧去重判别**；**逐帧去重只能靠帧 id**（`evt_…` 本身唯一） |
| `session.text.ended` | D | `sessionID, assistantMessageID, ordinal, text` | 文本 part 止。⚠️ **`data.text` 带「权威全文」**（实机抓帧确认）——**映射优先用它、累积器只作兜底**（连接中途建立时累积器只有后缀片段，直接用会得到残缺的正文） |
| `session.reasoning.started` | D | `sessionID, assistantMessageID` | reasoning part 起 |
| `session.reasoning.delta` | **E** | `sessionID, assistantMessageID, ordinal, delta` | **reasoning delta**（增量字段同样是 **`delta`**）；`ordinal` 语义同 `session.text.delta`（非逐帧计数器） |
| `session.reasoning.ended` | D | `sessionID, assistantMessageID, ordinal, text` | reasoning part 止。⚠️ **与 `session.text.ended` 同口径**：`data.text` 带**权威全文**，优先于累积器 |
| `session.tool.input.started` | D | `name, assistantMessageID` | 工具入参起 |
| `session.tool.input.delta` | **E** | `delta, assistantMessageID` | 工具入参流 |
| `session.tool.input.ended` | D | `text, assistantMessageID` | 工具入参止 |
| `session.tool.called` | D | `input, executed, state, assistantMessageID, name` | **工具态：运行中** |
| `session.tool.progress` | **E** | `metadata, assistantMessageID` | 工具进度（**不作状态判定**） |
| `session.tool.success` | D | `content[], type, text` | **工具态：成功 + 输出内容** |
| `session.tool.failed` | D | `error, assistantMessageID` | **工具态：失败** |
| `session.message.content.updated` | D | — | 整条消息内容更新（对应 v1 `message.part.updated` 的角色） |
| `session.compaction.started` | D | `reason, recent, inputID` | 压缩中（可忽略） |
| `session.compaction.delta` | **E** | `text` | 忽略 |
| `session.compaction.ended` | D | `reason, model` | 忽略 |
| `session.compaction.failed` | D | `reason, error` | 忽略 |
| `session.compacted` | E | — | 压缩完成（与 `session.compaction.ended` 并存） |
| `session.retry.scheduled` | D | `assistantMessageID` | 重试提示 |
| `session.shell.started` / `.ended` | D | `shell, id, status, command, cwd, exit, …` | shell 工具态 |
| `session.skill.activated` | D | `id, name, text` | 技能激活（可忽略） |
| `session.synthetic` | D | `text, description, metadata` | 合成文本（**Q9 已关闭**：v2 的工具调用是独立 content 项，工具占位污染路径结构上封死；`synthetic` 是 vteam 侧注入标记，不是上游概念） |
| `session.instructions.updated` | D | `delta, text` | 指令注入（可忽略） |
| `session.revert.staged` / `.cleared` / `.committed` | D | — | 忽略 |
| `server.connected` | **E** | — | 连接成活（沿用 v1 语义 ✅） |
| `session.idle` | **E** | `sessionID` | 空闲信号（**不作状态判定**，仅提示） |
| `session.status` | **E** | `sessionID, status:"idle"\|"busy"\|"retry"` | 状态提示（仅提示） |
| `permission.asked` | **E** | `sessionID` | **触发**拉取 `GET /api/session/{id}/permission` → `session.permission` |
| `permission.replied` | **E** | `sessionID` | 权限已回复 → 关闭 `session.permission` 卡片 |
| `form.created` | **E** | `form, fields[]` | **触发**拉取 `GET /api/session/{id}/form` → `session.question` |
| `form.replied` | **E** | — | 问题已回复 → 关闭 `session.question` 卡片 |
| `form.cancelled` | **E** | — | 问题被取消（对应"拒绝"路径，Q6） |
| `mcp.status.changed` | E | `server` | MCP 状态刷新（可接 `mcp-status-probe`） |
| `mcp.prompts.changed` / `.resources.changed` | E | `server` | 忽略 |
| `mcp.tools.changed` | E | `server` | MCP 工具列表变化 |
| `config.updated` | E | — | 配置变更（配合 T7 归一化诊断） |
| `command.updated` / `agent.updated` / `model.updated` / `provider.updated` | E | — | 忽略 |
| `credential.updated` / `.switched` | E | — | 忽略 |
| `integration.updated` / `project.updated` | E | — | 忽略 |
| `worktree.updated` | E | — | 忽略 |
| `worktree.resolved` | D | — | 忽略 |
| `filesystem.changed` | E | `file` | 忽略 |
| `reference.updated` / `plugin.updated` / `skill.updated` / `websearch.updated` | E | — | 忽略 |
| `installation.updated` / `.update-available` | E | — | 忽略 |
| `pty.created` / `.updated` / `.exited` / `.deleted` | E | — | 忽略 |
| `shell.created` / `.exited` / `.deleted` | E | — | 忽略 |
| `location.shutdown` | E | — | serve 关闭（影响重连） |
| `global.disposed` | E | — | 全局释放（服务重启/关闭） |
| `workspace.ready` / `workspace.failed` / `workspace.status` | E | — | 工作区生命周期（vteam 未用） |
| `lsp.updated` | E | — | LSP（v2 不再运行语言服务器，实际不会触发） |
| `vcs.branch.updated` | E | `branch` | 分支变化 |
| `models-dev.refreshed` | E | — | 忽略 |
| `tui.*` | E | — | TUI 专用，忽略 |

### 附录 B.1 已落地的映射表与「已知未支持」清单（P2a 实证）

> 上面的总目录是**全集**；**已落地**的映射表（`worker/src/driver/v2-event-map.ts`）只覆盖其中 **26 条（16 durable / 10 ephemeral）**，其余 **72 条被显式列进「已知未支持」清单**（每条带**理由**），并有**单测断言「目录里的每一条 v2 事件，要么有映射、要么显式列进未支持清单」**——不允许「没想过」的静默空洞。

**已映射的 26 条**（→ vteam 事件 / 触发动作）：

| v2 事件 | 耐久 | → vteam 侧 | 备注 |
|---|---|---|---|
| `session.execution.succeeded` | D | `task.completed` | **终态**：不直接发送，交终态闸门收口 |
| `session.execution.failed` | D | `agent.status{status:error}` | **终态**（交闸门） |
| `session.execution.interrupted` | D | `agent.status{status:error}` | **终态**（交闸门） |
| `session.execution.started` | D | `session.updated{status:running}` | |
| `session.step.started` | D | `session.updated{status:running, agent?, model?}` | |
| `session.step.ended` | D | `message.part.delta`（**合成 `step-finish` part**） | 合成理由见 T14 / T20 |
| `session.text.started` | D | `message.part.delta`（空 text part） | |
| `session.text.delta` | E | `message.part.delta`（累积快照） | 累积器键 `${messageID}:text` |
| `session.text.ended` | D | `message.part.delta`（**权威全文**） | 优先 `data.text`，累积器兜底 |
| `session.reasoning.started` | D | `message.part.delta`（空 reasoning part） | |
| `session.reasoning.delta` | E | `message.part.delta`（累积快照） | 累积器键 `${messageID}:reasoning` |
| `session.reasoning.ended` | D | `message.part.delta`（**权威全文**） | 同上口径 |
| `session.tool.input.started` | D | `message.part.delta`（tool part running） | |
| `session.tool.input.delta` | E | `message.part.delta`（累积入参） | 累积器键 `${messageID}:tool:${callID}:input` |
| `session.tool.input.ended` | D | `message.part.delta`（tool part running + 入参） | |
| `session.tool.called` | D | `message.part.delta`（tool part running） | |
| `session.tool.progress` | E | `message.part.delta`（tool part running） | |
| `session.tool.success` | D | `message.part.delta`（tool part **completed**） | `content` 进 `state.content` |
| `session.tool.failed` | D | `message.part.delta`（tool part **error**） | |
| `session.usage.updated` | **E** | `session.updated{usage}`（**无 `status`**） | 见上行的 ephemeral 更正 |
| `session.created` | D | `session.updated{status:running}` | |
| `permission.asked` / `permission.replied` | E | **只触发一次拉取**（permission 列表） | 拉到的请求由探测器上送 |
| `form.created` / `form.replied` / `form.cancelled` | E | **只触发一次拉取**（form 列表） | 同上 |

**状态判定铁律（已落地并有单测）**：**只有 durable 事件可以驱动状态**；ephemeral 事件**只允许触发一次拉取**（`permission.asked` → 拉权限列表、`form.created` → 拉表单列表），**绝不允许直接写状态**。映射层另有一道防御：ephemeral 映射**不得**产出终态。

**去重键（按类）**：
- **durable 上游**（有 `aggregateId` + `seq`）→ `upstream:<aggregateId>:<seq>`（server 侧）/ `durable:<aggregateId>:<seq>`（worker 侧闸门）——**跨 worker 重启稳定**。
- **非 durable 上游帧** → `upstream:<eventId>`（server 侧）/ `event:<eventId>`（worker 侧）——**逐帧去重靠帧 id**（`ordinal` **不是**逐帧计数器，见附录 B 的更正）。
- **拉取派生的事件**（permission / question）→ 用**上游对象 id**（`per_…` / form id）作 `upstream.eventId`——⚠️ **一次触发可能拉出多个请求**，用触发事件自身的 id 会把它们**折叠成一条**。

**72 条「已知未支持」里的高价值理由**（都是**设计决策**，不是遗漏）：

| v2 事件 | 不支持的理由（要点） |
|---|---|
| `session.inbox.enqueued` | 载荷里**带用户 prompt 原文**（`item.payload.text`）→ 转发会**把 prompt 泄漏进流式输出** |
| `session.renamed` | **晚于执行结束**到达 → 映射成 `session.updated(running)` 会把**已 idle 的会话改回运行中** |
| `session.step.failed` | **不产 `step-finish`**——那会误触控制面的「本轮完成」幂等键；run 级失败由 `session.execution.failed` 承载 |
| `server.connected` | 由 SSE 客户端直接消费为**连接成活信号**（`onOpen`），**不走事件映射** |
| `session.idle` / `session.status` | ephemeral → **不作状态判定**（终态只认 durable 的 `session.execution.*`） |
| `session.agent.selected` | vteam 的 agent 在下发提示时选定；事件侧无消费方（且晚到会改写会话状态） |
| `session.model.selected` | 用量口径的模型取自 assistant 消息 info（轮询路已有），事件侧重复会与之一致性打架 |
| `session.deleted` | 会话失效走 HTTP 404 的自动重建路径，不走事件 |
| `session.usage.recorded` | 与 `session.usage.updated` **并存**的落账事件——后者已承载用量载荷 ⇒ **用量不会被投递两次** |
| `session.message.content.updated` | `data` 形状**未在契约基线中确认**（实机未见）→ 不做臆造映射 |
| `session.synthetic` | v2 无 `synthetic` 标记字段；**Q9 已关闭（P3 实测）**——v2 里工具调用是**独立的 content 项**（`type:'tool'`），与模型写的 `type:'text'` 互斥 ⇒ 工具占位污染路径**结构上封死**，不需要臆造标记；`!synthetic` 过滤保留（对 driver 产出的 part 是空操作，对 vteam 注入的合成块仍正确） |
| `session.compaction.*` / `session.revert.*` / `mcp.*` / `pty.*` / `tui.*` / `filesystem.changed` 等 | **今天没有 vteam 消费方**（压缩过程 / 回滚 / MCP 目录 / PTY / TUI 专用事件 / 文件变更各走自己的通道） |

## 附录 C. v2 配置键差异表

| v1 形（vteam 在写） | v2 形 | v2 行为 | vteam 改动 |
|-------------------|-------|---------|-----------|
| `mcp: {<name>: {type:'local', command, cwd, environment, timeout, enabled}}` | `mcp: {servers: {<name>: {...}}}` | 扁平 legacy 形仍被解析（deprecated） | T15 显式写 `mcp.servers` |
| **`mcp.<n>.enabled`** | **`mcp.servers.<n>.disabled`** | ✅ **反转由归一化器正确处理**：v1 形 `"enabled": true` → `"disabled": false`（仍启用）；`enabled: false` → `"disabled": true` | T15 显式写 `mcp.servers.<n>.disabled`（与 vteam 语义等价，**不构成"全被禁用"的风险**）；**极性已实测** → Q15（已解答） |
| `mcp.<n>.timeout: <ms>` | `timeout: {startup, catalog, execution}` | 拆成三个阶段超时；实测 `"timeout": 30000` → `{"catalog":30000,"execution":30000}`——**`startup` 段丢失**（**不是**被默认值补齐） | T15 显式写三段（`startup` 不得缺）；三段语义 → Q15（仍开放） |
| `mcp.<n>.oauth.clientId/clientSecret/callbackPort/redirectUri` | `client_id` / `client_secret` / `callback_port` / `redirect_uri` | snake_case；v1 的 camelCase 被忽略 | T15 改写 |
| `McpLocalConfig.command` | `command: string[]` | v2 要求数组 | **当前 `injector.ts:672-676` 已是数组** → 保持；实施时以代码为准复核（简报所述"当前是 string"与代码不符） |
| `plugin: [...]` | `plugins: [...]` | 自动归一化；⚠️ **数组在多份配置文件之间是「合并」不是「替换」**（T6 实测：写 `plugins: []` 是 no-op）→ **清不掉全局插件**，只能靠 T16b 的隔离 env | T15 显式写 `plugins`（**顺序即优先级**；`-` 前缀禁用；⚠️ 禁用 `["-*"]` 会连内置 agent/provider 一起关掉 → `Agent not found: "build"`，只能用 `["-<具体ID>"]`） |
| `plugin: ["pkg", ["./p.ts", {opts}]]` | `plugins: ["pkg", {package:"./p.ts", options:{…}}]` | 元组 → 对象 | T15 显式写对象形态 |
| 插件目录 `.opencode/plugins/` | `.opencode/plugins/` **和** `.opencode/plugin/` | **双目录都被发现** | T15/T19 确认产物落在哪个目录（**默认 `.opencode/plugins/`**） |
| **自定义工具目录 `.opencode/tools/`** | **v2 已移除该发现路径** | ❌ **v2 连 import 都不发生**（T5 实测：探针文件没留下 marker）→ 工具**只能**经插件 `ctx.tool.transform` 注册 | **T19 产物形态改变**：`.opencode/tools/*.ts` → **`.opencode/plugins/*.ts` 插件注册代码** |
| `agent: {<name>: {description, mode, permission}}` | `agents: {<name>: {...}}` | 自动归一化 | T15 显式写 `agents` |
| 顶层 `mode: {…}` 映射 | 合并进 `agents`，条目变 `primary` | 迁移 | T15 合并进 `agents` 节 |
| `agent.<n>.permission: {edit:"allow", bash:"ask"}` | `agent.<n>.permissions: [{action,resource,effect}]` | 自动归一化；**`bash` → `shell`** | T15 改写为数组；权限 action 名要跟着从 `bash` 迁到 `shell` |
| `permission` 里的 `task` | `subagent` | 重命名 | T15 改写 |
| `permission` 里的 `write` / `patch` | `edit`（`edit` 覆盖 write+patch） | 重命名/合并 | T15 改写；**`opencode-config-builder.ts` 当前显式拒绝 `write` 键**（:87-91）的闸门需按 v2 语义重写 |
| v1 默认"项目外路径需询问" | v2 **默认允许** `external_directory` | 行为放宽（**安全语义变化**） | T15 显式加 `{action:"external_directory", resource:"*", effect:"ask"}`，否则权限矩阵比 v1 宽松 |
| `tools: {websearch: false}` | 权限规则 `{action:"websearch",resource:"*",effect:"deny"}` | 改写 | vteam 不用，仅记录 |
| **`agent.<n>.prompt`（v1 键）** | **取决于所在的节**（2.0.28 实测，同一份配置里两节并存）：在 v1 形 **`agent:`** 节内 → **被迁移为 `system`**（值不丢；同节 `prompt` 与 `system` 并存时 `prompt` 胜出、原 `system` 被挪到 `request.body.system`）；在 v2 原生 **`agents:`** 节内 → **是未知键，静默丢弃、无任何告警** | ⚠️ **角色提示静默丢失**——只改节名不改键名就会踩 | **禁止使用**；**节名 `agent`→`agents` 与键名 `prompt`→`system` 必须同一次原子改写**（T15）；v2 原生载体是 `agents.<n>.system` |
| — | **`agents.<n>.system`**（string） | **v2 原生键**（在 v2 原生 `agents:` 节内实测归一化后原样保留；⚠️ 放在 v1 形 `agent:` 节内则被挪到 `request.body.system`，**inert 不生效**） | **T15 写入角色提示**（D6 的 (a′)）；**T4 已实测运行时生效 ✅**（`POST /api/session/{id}/agent` 激活） |
| `agent.<n>.maxSteps` | `steps` | 重命名 | T15 |
| `agent.<n>.disable` | `disabled` | 重命名 | T15 |
| `agent.<n>.temperature` / `top_p` | `request.body` / `request.headers` | 实测 v1 形 `agent.<n>.temperature` → **`agent.<n>.request.body.temperature`**（v1 形态被保留），但 ⚠️ **v2 目前不随模型请求下发 `request.body`** → 该值**实际不生效**（inert） | 改用 provider/model settings；vteam 不用 per-agent 温度，仅记录 |
| `provider`（节名） | `providers` | 重命名 | T7/T16 |
| `provider.<p>.npm` | `provider.<p>.package` | 子键改名；⚠️ **归一化器在 `npm`→`package` 迁移时自动加 `aisdk:` 前缀**（实测 `"npm":"@ai-sdk/openai-compatible"` → `"package":"aisdk:@ai-sdk/openai-compatible"`） | T7/T16 改写（**显式写 `package` 时不要手动加前缀**） |
| `provider.<p>.options` | `provider.<p>.settings` | 子键改名 | T7/T16 改写 |
| `provider.<p>.api` | `settings.baseURL` | 迁移 | T7/T16 改写 |
| `provider.<p>.models.<m>.id` | `modelID` | 重命名 | T7/T16 |
| `provider.<p>.models.<m>.variants: {v:{…}}` | `variants: [{id, settings, headers, body}]` | 对象 → 数组 | T7/T16 |
| provider id `azure-cognitive-services` / `google-vertex-anthropic` | `azure` / `google-vertex` | 重命名 | vteam 若硬编码这些 id 要改 |
| `provider.<p>.models.<m>.reasoning` | （v2 用 `capabilities`） | **被丢弃 + WARN**；且 **v2.0.28 没有 per-model `reasoning` / `temperature` 的落点**（归一化后被剥除，`GET /api/model` 里也不存在） | T7 删除该键，改写 `capabilities:{tools,input[],output[]}`（**刻意不写**——基于实测的取舍，不是遗漏） |
| `provider.<p>.models.<m>.tool_call` | 同上 | **被丢弃 + WARN** | T7 删除 |
| `provider.<p>.models.<m>.attachment` | 同上 | **被丢弃 + WARN** | T7 删除 |
| `provider.<p>.models.<m>.modalities` | 同上 | **被丢弃 + WARN** | T7 删除 |
| `provider.<p>.models.<m>.limit:{context,output}` | 保留 | 仍要求 context+output 同时存在 | T16 保持 |
| `command.<n>` | `commands.<n>`（`subtask` → `subagent`） | 重命名 | T15 |
| `snapshot` | `snapshots` | 重命名 | T15 |
| `attachment` | `media`（新增 `max_width/max_height/max_base64_bytes`） | 重命名 + 扩容 | T15 |
| `compaction: {preserve_recent_tokens, reserved, tail_turns, prune}` | `{auto, keep:{tokens}, buffer}` | `tail_turns` / `prune` 被忽略并告警 | T15 |
| `skills: {paths:[], urls:[]}` | `skills: ["./dir","https://…"]` | 扁平化为数组 | T15 |
| `reference` | `references` | 重命名 | T15 |
| 指令文件 `AGENTS.md` + `CLAUDE.md` 回退 | **只发现 `AGENTS.md`** | 移除回退（**读文档结论，spike 未实测 → §10 U6**） | vteam 不生成 AGENTS.md；**T16b 还要保证 workDir 根上不出现 `AGENTS.md`**（隔离方案只禁**全局**那份，项目那份仍会被发现） |
| `server` / `logLevel` 顶层键 | 被接受但**忽略**（日志改用 `OPENCODE_LOG_LEVEL`） | 静默忽略 | T15 不写这两键 |
| 会话分享（`POST /session/:id/share`、`autoshare`） | **v2 移除** | 移除 | vteam 不用，仅记录 |
| 语言服务器（v1 内置 LSP 工具） | **v2 不再运行 LSP、不暴露 LSP 工具** | 移除 | vteam 不用，仅记录 |
| — | `Config.Plugin.EntryEncoded = {package, options?}` | v2 插件条目的规范形态 | T15/T19 对齐 |
| — | `permissions` / `permission`（deprecated）/ `policies` | 顶层 48 键之一 | T15 确认是否改用顶层 `permissions` |
| — | `default_agent` | 顶层键 | 可用于设置默认 agent（备选） |
| — | `experimental` | 顶层键 | **只有 `portable_shell_scanner` / `subagent_depth` / `policies` 三个字段**（`@opencode/schema@2.0.32` 类型原文）→ **没有任何插件/AGENTS.md 开关**；`--pure` 等价物候选**已排除**（Q3 已关闭） |
| — | `instructions: [...]` | 顶层键 | ⚠️ **只能「追加」额外指令文件**（T6 实测：写 `instructions: []` **关不掉** `AGENTS.md` 发现）→ 不能用它抑制 AGENTS.md；vteam 不用，**抑制 AGENTS.md 只能靠 T16b 保证 workDir 根上没有 `AGENTS.md`** |
| — | `compaction` / `snapshot` / `worktree` / `skills` / `instructions` | 顶层键 | 本次不动 |

## 附录 D. 变更清单汇总（按文件）

| 文件 | 改什么 | 属于哪个任务 |
|------|--------|-------------|
| `worker/Dockerfile:30-38` | `ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`（锁版） | T1 |
| `worker/src/runtime/opencode-server.ts` | 版本解析 + 闸门（:289-302）；去 `--pure`（:334-388）；banner 双正则（:99）；密码必填 + stdout 兜底（:380）；spawn argv；**spawn env 隔离 `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`**（不再继承宿主机 HOME） | T1 / T2 / T3 / **T16b** |
| `worker/src/runtime/serve-log.ts` | 归一化诊断识别（:32、:49-55）；v2 日志落点复核；**启动日志声明"当前处于隔离配置域"+ 隔离根目录路径** | T7 / **T16b** |
| `worker/src/driver/opencode-driver.ts` | **新增**：driver 接口 | T8 |
| `worker/src/driver/index.ts` | **新增**：驱动工厂（按 `OPENCODE_V2_ENABLED` 选 v1/v2 实现）；**工厂选项上新增可选的 `systemHandoff`**（D6(f) 的交接端口 `SystemHandoffPort`）——⚠️ **`OpenCodeDriver` 接口本身不变**（交接是驱动的**可选**依赖，不进接口） | T8 / **D6(f)** |
| `worker/src/driver/v2-driver.ts` | **新增**：v2 实现；**part id 按 P2a 方案产出**（文本 `${messageID}:text` / 思考 `${messageID}:reasoning` / 工具 `${messageID}:tool:${callID}` / `step-finish` `${messageID}:step-finish`）——**与事件路共用同一个 helper（单点来源）**、**跨重复轮询稳定**；**已合成 v1 兼容的 `step-finish` part**、**已把 `state.content[]` 归一成 `state.output`** ⇒ **T14 不需要改它**；**载体路由 `routeSystemBlob` → `'none' \| 'prefix' \| 'plugin'`**（D6(f)：agent 有配置化 `system` ⇒ 整段 blob **不注入** + 清交接文件；否则插件就绪 ⇒ 写交接文件、**不**拼前缀；否则**文本前缀**兜底 + 清交接文件 ⇒ 同一段 blob **绝不**同时出现在 system 段与 user 段） | T9 / T12 / **D6(f)** |
| `worker/src/driver/v2-system-handoff.ts` | **新增**：D6(f) 的**逐消息 blob 交接通道**——交接存储（`compare-then-write`，同内容不重写；变更时 tmp + `rename` 原子写）+ **插件生成器**（`Plugin.define({id, setup})`、**动态** `import("@opencode/plugin")` + identity 兜底、`setup` 护栏 `if (!ctx?.session?.hook) return`、双形态 `server()` 在 v1 上是 no-op、id 稳定 `vteam-system-handoff`、**刻意不写 `options:{codemode:false}`**——那是**工具**的选项、session hook 没有这个参数）+ **按 location 分桶的就绪协商**（`.ready/<location 哈希>.txt`）。交接目录 `<workDir>/.vteam-system-handoff/` **刻意在 `.opencode/` 的同级兄弟**（不在 opencode 的配置发现作用域内）；插件里**写死绝对路径**，读之前用 `/^[A-Za-z0-9_-]{1,128}$/` 校验会话 id（路径穿越的唯一防线） | **D6(f)** |
| `worker/src/driver/v2-system-handoff.spec.ts` | **新增**：交接通道的**单测**（19 个）：compare-then-write 的字节稳定性、原子写、目录有界、会话 id 校验、插件生成物的形状（动态 import / `setup` 护栏 / 双形态 / 无 `codemode`） | **D6(f)** |
| `worker/src/driver/v2-system-handoff.real.spec.ts` | **新增**：**opt-in 真二进制契约测试**（需环境变量才跑，否则跳过）：blob 在 **system 段**、**不在 user 段**、同一会话**两次派发逐字节相同** | **D6(f)** |
| `worker/src/driver/v1-driver.ts` | **删除**（633 行）——删除动作延后到 T18，作为回滚保险的最后一步 | T18 |
| `worker/src/driver/v1-driver.spec.ts` | 随 v1 driver 一并删除 | T18 |
| `worker/src/driver/serve-event-stream.ts` | SSE 帧解析重写（全文，不要求 `event:` 字段）；退避重连（1s→2s→4s…封顶 10s）；**`onReconnect` 被 await 完成前不派发新帧**；durable log 补齐（`?after=<lastSeq>`） | T11 / T13 |
| `worker/src/driver/v2-event-map.ts` | **新增**：v2 事件 → vteam 事件映射表（**26 条：16 durable / 10 ephemeral**，见附录 B.1）+ **72 条「已知未支持」清单**（每条带理由）+ **终态闸门 `RunTerminalGate`**（事件证据优先 / `settle()` 一次性 / 陈旧 durable `seq` 不覆盖新证据 / **`peek()` 语义 ⇒ 必须"先问后记"**）+ **part id 归一 helper**（与 driver 单点来源）+ 上游身份与去重键派生（**`ordinal` 不作逐帧判别**） | T12（**已落地 ✅**） |
| `worker/src/driver/prompt-await.ts` | **五条语义按 v1/v2 两代通吃落地**（T14 的语义表）；**终态与事件路的合流缝 `EventSignal`**（`peek` / `notePolling` / 可选 `firstToken`；**先问后记**、**不自己发终态**、有界宽限期 `eventGraceMs` 默认 500 ms）；`CompletionResult.terminalEvidence` 留痕 + 两路证据不一致时打日志；**错误抽取两代通吃**（v1 `{name,data:{message,statusCode}}` / v2 `{type,message,status,response{body}}`）；**`state.output` 保持主形态**（只增对原始 `state.content[]` 数组的容错） | T14（**已落地 ✅**） |
| `worker/src/driver/prompt-await.spec.ts` | 五条语义的单测对齐 + **合流缝用例**（先问后记 / 宽限期 / 两种到达顺序同结论 / `terminalEvidence` 留痕） | T14（**已落地 ✅**） |
| `worker/src/exec/exec-server.ts` | 新增 worker 端点（:550-590 路由）；附件 part 改新形（:1706）；delta 桥改新事件（:1803-1873）；question/permission 通道改新端点 + **v2 body 键名**（`decision` / `answer`）（:1953-1989）；**v2 事件桥接**（按会话过滤 → 查映射表 → 上送并附上游身份；终态交闸门）；**重连重同步**（清空累积器 → `driver.getMessages()` 拉权威快照 → 归一 part id → 只重发新/推进的 part → 三条可观测日志）；**轮询路与事件路的 part id 归一共用同一 helper**；**⚠️ 激活合流缝：每次 run 新建一个终态闸门并交给 `sendAndAwait`（`eventSignal`），终态事件由调用方执行唯一一次 `settle()` 后发出 ⇒ 一次 run 只发一个终态事件** | T10 / T12 / T13 / T14 |
| `worker/src/resources/injector.ts` | `mcp`→`mcp.servers`（:468-491、:670-701）；`plugin`→`plugins`（:512-525）；**`agent`→`agents` 与 `prompt`→`system` 同一次原子改写**（:333-412；只改节名 ⇒ `prompt` 在 `agents:` 节下被静默丢弃 → 角色提示全丢）；**插件产物落盘路径 `.opencode/tools/` → `.opencode/plugins/`**；**确保 workDir 根上不出现 `AGENTS.md`**；**`applySystemHandoffPlugin()`**（D6(f)：把交接插件产物装进 `<workDir>/.opencode/plugins/vteam-system-handoff.ts`，**与工具插件分开记账**——manifest 键 **`systemHandoffPlugin`**，它是**常驻**产物、不参与工具插件的清理） | T15 / **T16b** / T19 / **D6(f)** |
| `worker/src/resources/opencode-config-builder.ts` | agent 构造改 v2 形 + 权限数组（`bash`→`shell`、`task`→`subagent`、`write`/`patch`→`edit`）+ **`system`**（角色提示落点，:48-64）；白名单扩到 v2 `AgentConfig`（:95-105）；"拒 `write` 键"闸门按 v2 语义重写（:87-91） | T15 |
| `worker/src/resources/custom-tool.ts` | import 与模板改 v2 **双形态模块**（`Plugin.define` + v1 `server()` 回退，**v2 分支带 `if (!ctx?.tool?.transform) return` 护栏**）；入参 Zod→JSON Schema；返回值 string→`{content}`；**必写 `options:{codemode:false}`**；**产物落盘路径 `.opencode/tools/` → `.opencode/plugins/`**（:143-164） | T19 |
| `worker/src/git/git-tools.ts` | import 与模板改 v2 双形态；入参/返回值/`options`/`产物路径` 同上（:723-746） | T19 |
| `worker/src/browser/browser-tools.ts` | import 与 `execute(input, ctx)` 改 v2 双形态；**`context.directory` → `ctx.location.directory`**（v2 的 ToolContext 无 `directory`）；`options`/`产物路径` 同上（:147、:166-180） | T19 |
| `worker/src/credentials/model-credential-injector.ts` | provider 段改 v2 形态（:139-232、:197-292）；清理不动 `opencode.db`（:301-311）；**全局 `opencode.json` 与 `auth.json` 的写入路径从宿主机 `$HOME` 改到隔离目录**（:92-97、:301-311） | T7 / T16 / **T16b** |
| `worker/src/mcp-status/mcp-status-probe.ts` | 去 `--pure` + glyph 正则重写（:91-121、:144-148） | T17 |
| `worker/src/index.ts` | 版本解析（:87）；`models` 解析回归（:591-602）；driver 构造换实现（:737-739）；`opencodeVersion` 上报规范化（:688）；auth.json 路径（:264-271）；**创建交接存储 `new SystemHandoffStore(workDir, …)` 并交给驱动工厂**（D6(f)）；**安装交接插件产物**；**每次 serve（重）启都清掉全部就绪标记**（宁可退回文本前缀，也不丢 blob） | T1 / T8 / T16 / T17 / **D6(f)** |
| `worker/src/protocol/worker-protocol.ts` | 事件常量**保持原名**（`message.part.delta` **不改名**）；**补上 server 侧同款"刻意保留"注释**（:13-25、:18）；新增端点契约类型 | T10 / T12 |
| `worker/src/protocol/worker-protocol.ts:226-227` | **过期注释**：仍描述 v1 形态的模型键翻译（`toolCall → tool_call`）——provider 段现在按 **v2 形态**写（`package` / `settings` / `capabilities`），而 `tool_call` 这类 legacy 键**会被 v2 丢弃** | T15 / T16 |
| `worker/src/protocol/contract.spec.ts` | 新增端点双向断言 | T21 |
| `worker/src/runtime/opencode-server.spec.ts` / `.integration.spec.ts` | v2 启动/认证/banner/版本用例 | T21 |
| `.opencode/package.json` | 依赖改 `@opencode/plugin@2.0.32` | T19 |
| `server/src/workers/worker.client.ts` | 5 处直连改调 worker（:299-320、:336-355、:589-606、:990-1000、:1007+）；删 opencode 鉴权与 baseUrl 解析（:283、:1101-1112） | T18 |
| `server/src/workers/worker.client.spec.ts` | mock 目标从 opencode serve 改为 worker HTTP | T18 |
| `server/src/workers/worker-event.ingress.ts` | **幂等键改"上游身份优先"的四层口径**（`upstream:<aggregateId>:<seq>` / `upstream:<eventId>:<ordinal>` / `upstream:<eventId>` / `worker:<workerId>:<eventId>`，见 D4）；落库形态改内部渲染模型（:596-829、:710-712、:817-820） | T12 / T20 |
| `server/src/workers/workers.service.ts` | 版本过滤用规范化 semver（:919-920）；混跑期禁无版本派发 | T1 / T22 |
| `server/src/chat/message-parts.ts` | **存储形态边界** `normalizeParts()`（总函数：裸数组 / v1 形 `{parts:[…]}` / v2 形 `{content:[…]}` → 同一个内部渲染模型；不可识别输入降级为空集 + 一条只报形状的 WARN）；内部模型 id 规则（:60-65、:133-147、:184-212、:215-220） | T20（**已落地 ✅**） |
| `server/src/chat/message-parts.spec.ts` | v1/v2 双形态归一用例 + **`step-finish` 归一后保留**的断言 + **形状等价**断言（web 读到的字段完全一致） | T20（**已落地 ✅**） |
| `server/src/tasks/tasks.service.ts` | `opencodeAgentName` 语义改为 agent 注册键（:2049-2118） | T15 / T18 |
| `server/src/agents/agents.service.ts` | `GET /agents/opencode` 链路适配新端点 + `degraded` 保留（:551-610） | T18 |
| `server/src/common/constants/event.constants.ts` | **事件名保持不变**（`message.part.delta` **不改名**）+ 补"刻意保留"的注释（:29） | T12（**已落地 ✅**） |
| `server/src/realtime/realtime.service.ts` | 不保留集合**保持原样**（无需跟随改名）（:126-128） | T12（**已落地 ✅**） |
| `server/prisma/schema.prisma` | **零变更** | — |
| `web/src/components/chat/msg-parts.tsx` | **已验证无需改动**（v1/v2 落库形态在 web 读取的字段上完全相同；`toToolStatus` 本就小写化）——由 T20 的形状等价测试充当守门人 | T20（**零改动 ✅**） |
| `web/src/components/chat/msg-tool.tsx` | **已验证无需改动**（`MsgToolStatus` 四态映射对 v1/v2 同族的取值继续有效） | T20（**零改动 ✅**） |
| `docs/agent-platform/07-opencode-v2-调研与架构决策.md` | D13 表逐条订正 + 实测基线小节 | T23 |
| `docs/agent-platform/opencode-v2-spike-results.md` | **T4/T5/T6 的实测结论文档**（已产出，54KB）——D6 / D8 / D12 / T16b 的事实来源 | —（已产出） |
| `docs/agent-platform/opencode-v2-spike-results/**` | spike 的可复现物料（`repro.sh` / `mock-provider.mjs` / `mock-opencode.json` / `v2-tool-plugin.ts` / `dual-shape-plugin.ts` / `evidence/*` 11 份原始捕获） | —（已产出） |
| `docs/agent-platform/opencode-v2-contract-baseline/**` | T1 的契约基线快照（`openapi.json` / `sse-sample.txt` / `config-sample.json` + README） | T1 |
| `.env.example` / helm values | 密码必填文案 | T3 |
| `.omo/plans/opencode-v2-adaptation.md` | 本计划 | — |

## 附录 E. 参考资料（v2 官方文档与源码）

| URL | 内容 |
|-----|------|
| `https://opencode.ai/v2/docs/migrate-v1/` | **v1→v2 迁移指南**：破坏性变更清单与逐项对照（配置键重命名、权限语义反转、`enabled`→`disabled`、插件 API 迁移等）——本文档 §2.7 与附录 C 的主要依据。⚠️ 指南的"语义反转"是**键名层面**的措辞；实测 v2 归一化器能**正确处理** `enabled`→`disabled` 的反转（`enabled:true` → `disabled:false`），真正残留的是 `timeout` 三段拆分丢 `startup`（见 §2.7 与 Q15） |
| `https://opencode.ai/v2/docs/build/plugins/migrate-v1` | 插件 API 的 v1→v2 迁移对照表（hooks → `ctx.*.hook`，`(input, output)` → 单个 event 对象，双包迁移杠杆） |
| `https://opencode.ai/v2/docs/build/plugins` | v2 插件 API 权威说明：`Plugin.define({id, setup})`、`ctx.tool.transform` / `ctx.agent.transform` / `ctx.skill.transform`、`ctx.session.hook` 的事件体 |
| `https://opencode.ai/v2/docs/api` | 生成的 API 参考（与本地 `GET /openapi.json` 互为印证） |
| `https://opencode.ai/v2/docs/config` | 配置参考（键名、层级、归一化行为） |
| `https://opencode.ai/v2/docs/cli/commands` | CLI 命令与全局 flag 参考（注意：`--print-logs` / `--log-level` 已**不在文档中**，但 2.0.28 实测仍可用） |
| `https://opencode.ai/v2/docs/permissions` | 权限模型（开放 action 命名空间、effect 三态、默认允许 `external_directory` 的放宽） |
| `https://opencode.ai/v2/docs/mcp-servers` | MCP 服务器配置（`mcp.servers.<n>.disabled`、三段式 timeout、oauth snake_case 字段） |
| `https://opencode.ai/openapi.json` | live 根 OpenAPI spec（**与 `/v2/openapi.json` 快照存在差异**，实测 144 ops vs 143 ops） |
| `https://opencode.ai/config.json` | 配置 JSON Schema（48 顶层键，实时变更） |
| `https://opencode.ai/v2/docs/` | v2 文档总入口 |
| `docs/agent-platform/opencode-v2-spike-results.md` | **T4 / T5 / T6 的实测结论文档**（本计划的 D6 / D8 / D12 / T16b 的事实来源；含 8 条"文档 vs 实机"冲突清单） |
| `docs/agent-platform/opencode-v2-spike-results/repro.sh` | **一键复现 T4 + T5 的全部断言**（无凭据、无额度、不连外网；起本地 mock provider 记录最终模型请求体）→ `bash docs/agent-platform/opencode-v2-spike-results/repro.sh`（`OPENCODE_BIN=...` 可换二进制） |
| `docs/agent-platform/opencode-v2-spike-results/evidence/**` | 11 份原始证据捕获（SSE 原始帧、落盘的模型请求体、发布版类型原文、双形态入口对照、T6 各轮候选矩阵） |

**跟踪策略（对应 D13 的 §7 订正）**：定期跟踪 `https://opencode.ai/v2/docs/migrate-v1/` 的破坏性变更清单与 `https://opencode.ai/config.json` 的 schema 变更；两者任一变化即触发一次契约基线重跑（T1 的快照流程）与本计划 §10 的未决问题更新。
