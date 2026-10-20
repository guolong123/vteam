# opencode v2 适配 — 执行进度日志

> 计划：`.omo/plans/opencode-v2-adaptation.md`（1168 行，23 任务 / 9 阶段）
> 分支：`feat/opencode-v2-adaptation`（worktree `../vteam-v2`，基于 `origin/main` @ `8d67067`）
> 起始：2026-10-20

## 阶段进度

| 阶段 | 任务 | 状态 | 备注 |
|------|------|------|------|
| P0 探针与阻塞项 | T1 版本闸门 + 锁版 | ✅ 完成 | Agent A |
| P0 | T2 serve 启动参数（去 `--pure`） | ✅ 完成 | Agent A |
| P0 | T3 认证强制化 | ✅ 完成 | Agent A |
| P0 | T4 spike 角色提示落地 | ✅ 完成 | Agent C |
| P0 | T5 spike v2 工具注册 API | ✅ 完成 | Agent C |
| P0 | T6 spike `--pure` 等价物 | ✅ 完成 | Agent C |
| P0 | T7 配置归一化可见化 + provider 段 | ✅ 完成 | Agent B |
| — | 计划事实订正（3 处错误断言） | ✅ 完成 | Agent D（1168→1173 行） |
| — | chart Secret 注入 + protocol 过期注释 | ✅ 完成 | Agent E |
| — | compose 密码 + chart README | ✅ 完成 | Agent F（`docker compose config` exit 0，两侧同值） |
| — | 计划并入 spike 结论 + 新增 T16b | ✅ 完成 | Agent D（1173→**1259 行**） |
| P1 | T9 v2 driver 实现 | ✅ 完成 | Agent H（1029 tests） |
| P1 | T10 worker exec 端点 | ✅ 完成 | Agent I（1029 tests） |
| P2 | T11–T13 worker 事件层 | ✅ 完成 | Agent J（1082 tests） |
| P2 | T12+T20 server 入库/幂等/形态边界 | ✅ 完成 | Agent K（server 4349 全绿） |
| — | part-id 单一真源下沉 | ✅ 完成 | Agent L（**1097 tests**） |
| P3 语义层 | T14 prompt-await 重写 | ✅ 完成 | Agent M（**1129 tests**） |
| P3 | 闸门合流激活（exec-server 接线） | ✅ 完成 | Agent N（**1134 tests**） |
| P4 | T16b 隔离 HOME/XDG | ✅ 完成 | Agent O（**1186 tests**） |
| P4 | T15 配置 v2 形态 | ✅ 完成 | Agent P（1180 tests） |
| P4 | T17 探针 + 权限契约记录 | ✅ 完成 | Agent Q（**1202 tests**） |
| P6 | e2e 证明脚本适配 v2 配置形态 | ✅ 完成 | Agent S |
| P6 | T19 三个生成器改插件形态 | ✅ 完成 | Agent R（**1220 tests**） |
| P8 | T23 文档订正 | ✅ 完成 | Agent V（19 篇文档） |
| P5 | T18 控制面收敛 + 删 v1 driver | ✅ 完成 | Agent U（server **4359** / worker 1156） |
| P8 | T21 验证 | ✅ 完成 | Agent W（worker 1170 / server 4365） |
| P8 | 修复 v2 CLI 探针（改为 serve 作用域） | ✅ 完成 | Agent（worker 1180 / server 4368） |
| P8 | 五态契约爆炸半径（web + 部署序 + 记录） | ✅ 完成 | Agent（web tsc clean / 3 单测过） |
| P8 | 最后一处过期 DTO 描述 | ✅ 完成 | 我（register-worker.dto.ts + 1 处 spec 注释/用例名） |
| P8 | T22 灰度与回滚 | ✅ 完成 | Agent X |
| P8 | 回滚安全性事实订正（末轮） | ✅ 完成 | Agent Y（计划 12 处 + doc 07 8 处 + 行号引用改章节引用） |
| P2 事件层 | T11–T13 | 未开始 | |
| P3 语义层 | T14 | 未开始 | |
| P4 配置与凭据 | T15–T17 + **T16b** | 未开始 | T16b = T6 结论落地 |
| P5 控制面收敛 | T18 | 未开始 | |
| P6 工具与插件 | T19 | 未开始 | |
| P7 存量兼容 | T20 | 未开始 | |
| P8 验证与灰度 | T21–T23 | 未开始 | |

## 基线（改动前，origin/main @ 8d67067）

- `server` tsc `--noEmit -p tsconfig.build.json`：**exit 0**
- `server` jest：**4331 用例，4330 通过，1 失败**
  - 失败用例：`src/platform-mcp/platform-mcp.tool-permission.spec.ts`
    › ③ HTTP 集成 › tools/list 全量不受权限影响（34 个工具…）
  - 失败原因：`expected 200 "OK", got 407 "Proxy Authentication Required"`
  - 判定：**环境相关的存量失败**（该用例把请求代理到真实上游 MCP server，本机网络路径返回 407）。`server/src` 内无 407 逻辑，且 platform-mcp 不在 v2 迁移范围内（计划 §8.4 明确不改）。
  - ⚠️ 后续每次跑 server jest 都以此为对照基线，**不得把这条算作本次引入**。
- `web` tsc `--noEmit`：**exit 0**
- 三端依赖已装齐：`worker` npm ci exit 0 / `server` npm ci exit 0 / `web` npm ci exit 0
- `worker/` 无 lint 脚本（只有 `typecheck` / `test`）

## P0 已交付（T1/T2/T3 + T7）—— 验收要点

- `worker/src/runtime/opencode-version.ts`（新）：**唯一**版本解析器 + 启动期闸门。
  - `parseOpencodeVersion` 兼容 v1 形 `opencode 1.19.0` / v2 形 `opencode v2.0.28` / 裸 semver，**永不抛错**。
  - `assertOpencodeVersionSupported`：major<2 → fail-fast（可操作错误）；major=null → 只告警不判死。
  - 闸门位置：`index.ts:738`，**早于** `new OpencodeServer`（`:767`）✅ 顺序正确。
  - 上报值规范化为 semver（`2.0.28`），与控制面 `workers.service.ts:919-920` 的精确串过滤对齐。
- `worker/Dockerfile`：`ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`（锁版）。
- 去 `--pure`：`OPENCODE_PURE` / OmO 开关在 v2 失效 → 只告警不拼 flag。
- 认证：v2 恒开鉴权 → 空密码 fail-fast；`OPENCODE_ALLOW_GENERATED_PASSWORD=1` 逃生口从 stdout 解析自动生成密码（**明文不入日志**）。健康探针由 `GET /` 改为 `GET /api/info`。
- T7：`serve-log.ts` 增加归一化诊断识别（分类为**配置错误**，与模型 API 错误隔离）；provider 段改 v2 形态并加**写后回读断言**；`cleanupAuthJson` 拒删非 `auth.json`（护 `opencode.db`）。
- 测试：worker 30 suites / **874 passed**；本人复验 4 个受影响 suite = 118/118 ✅

## ⭐ P0 spike 结论（T4/T5/T6）—— 已关闭，我已独立复现

结论文档：`docs/agent-platform/opencode-v2-spike-results.md`（54KB）；可复现资产：`docs/agent-platform/opencode-v2-spike-results/`（`repro.sh` 一条命令、**无需任何凭据/额度**、自清理；含 11 份原始证据）。
**我亲自跑了 `repro.sh`，逐条复现成功。**

### T4 ✅ PASS —— 角色提示落到模型请求
- `agents.<name>.system` **确实**进入最终模型请求（prepend 到 opencode 内置 system 块）。
- `POST /api/session/{id}/agent`（204）**确实**让该 agent 的 system 对下一轮生效；`POST /api/session` 带 `"agent"` 亦可。
- prompt body 的 `agents:[{"name":…}]` attachment 是 **no-op**（assistant 消息仍 `agent:"build"`，无 `agent-switched` 消息，无 `session.agent.selected` 事件）→ **D6 候选 (c) 删除**。
- `delivery:"steer"` 在**空闲**会话上**立即执行**（enqueued→started ≈ 4ms）；默认 delivery 即 `steer`。
- 插件 `ctx.session.hook("context")` 可把文本**直接推入模型请求的 system**；`hook("prompt")` 可改写 `prompt.text`。→ **最贴近 v1 逐消息 `system` 语义**的载体（`agents.<n>.system` 是逐 agent 的）。

### T5 ✅ PASS —— 工具产物形态**必须变**
- **`.opencode/tools/*.ts` 的文件自动发现在 v2 已移除**（文件**连 import 都不发生**）→ 三个生成器必须改为 **`.opencode/plugins/*.ts` 插件注册代码**（`Plugin.define` + `ctx.tool.transform`）。
- `ToolContext` 键集合实测 = `{sessionID, agent, messageID, id, signal, progress}` → **`directory` 不存在**（`browser-tools.ts` 依赖它）→ 改取 `ctx.location.directory`。
- **插件工具默认 Code-Mode-only** → 必须显式写 **`options:{codemode:false}`** 才进模型 `tools[]`（**官方文档从未提及 `codemode`** —— 活二进制 vs 文档冲突）。
- 双形态模块（v2 `Plugin.define` + v1 `server()`）可行，但 **v1 也会调 `setup`** → v2 分支须加护栏 `if (!ctx?.tool?.transform) return`。
- `GET /api/plugin` **不可靠**（曾返回 total=0 而插件确实已加载）→ 判据改用 serve 日志 `msg="loading plugin"` + 模型请求的 `tools[]`。

### T6 —— 没有 `--pure` 等价物（→ 新任务 T16b）
- `plugins: []` / 省略 / `instructions: []` / `experimental` / `OPENCODE_CONFIG*` **全部无效**（`plugins` 是**跨配置合并**、`instructions` 只**追加**）。
- `plugins:["-*"]` **不可用**（连内置 agent/provider 一起关 → `Agent not found: "build"`）；`plugins:["-<id>"]` ✅ 精确可用。
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` 会把项目 `opencode.json` 一起杀掉 → vteam 不能用。
- ✅ **唯一可靠手段 = 隔离 `HOME` / `XDG_CONFIG_HOME` 启动 serve**。
- 残留：受管目录（`/etc/opencode`、`/Library/Application Support/opencode`）不受 XDG 控制，只有 `policies` 能压制。
- **OmO 影响**：v1 插件实现在 v2 跑不起来；vteam 现在把 OmO 注册在**全局**配置 → 隔离后失效；必须迁到**项目 `plugins`** 并需要 v2 形态入口（U8，本机有参考但**不得入仓/入镜像**）。

### 计划已并入
D6 / D7 / D8 / D12 / T4 / T5 / T6 / T15 / T16 / T19 / §7.3 / §8.1 / §8.2 / §10 / 附录 A·B·C·D·E 全部更新；新增 **T16b**（隔离 HOME 落地，含"凭据写入路径必须一起改"这条最易漏的耦合）。计划 1173 → **1259 行**。

## ⭐ `prompt` 键的精确规则（T4 已在 v2 上直接证明 `agents.<n>.system` 生效，故此规则成立）

实测（隔离 HOME/XDG，同一份 config 同时含 v1 与 v2 两种节）：

| config 节 | 键 | v2 归一化结果 |
|---|---|---|
| `agent:`（v1 形） | `prompt` | **迁移为 `system`** ✅ |
| `agent:`（v1 形） | `prompt` + `system` | `prompt` 胜出 → 成为 `system`；原 `system` 落到 `request.body.system` |
| `agents:`（v2 形） | `prompt` | **静默丢弃**（未知键，无告警）❌ |
| `agents:`（v2 形） | `system` | 保留 ✅ |

⇒ **T15 必须把「节名 `agent`→`agents`」与「键名 `prompt`→`system`」原子地一起改**。
只改节名会让所有角色提示静默丢失（代码评审看不出、线上无任何告警）。这是全计划最危险的静默降级陷阱。

（我早期与两个 agent 各自观察到一半：它们测的是 v1 形 `agent:` 节，我测的是 v2 形 `agents:` 节。合并后规则完整。）

## 其他新事实

- `opencode mcp list --pure` → **exit 1**（响亮失败，**不是** exit 0 静默失败）。我先前的测量经管道，拿到的是 `head` 的退出码 —— 计划 §2.2/T17 的表述有误，已派 Agent D 订正。
- v2 归一化把 v1 `mcp.<n>.enabled:true` → `disabled:false`，**反转处理是正确的**（不是"全被禁用"）；真实残留问题：`timeout:30000` → `{catalog,execution}`，**startup 段丢失**（非回落默认值）。
- v2 归一化自动给 `npm` 补 `aisdk:` 前缀；v1 `agent.<n>.temperature` → `request.body.temperature`（v2 暂不下发，inert）。
- v2.0.28 **无处安放** per-model `reasoning` / `temperature`（归一化结果与 `/api/model` 均被剥掉）→ T7 刻意不写这两个键（有据，不是遗漏）。
- v2 的 `GET /` 返回 **200 且是 web SPA**（未鉴权）；`GET /session|/event|/config` 同样返回 200 + SPA HTML —— **只看状态码会误判"健康"**。
- `--print-logs` 在 v2 仍可用，logfmt 诊断仍落 **stderr**（banner 在 stdout）→ `serve-log.ts` 通道不受影响。
- v2 自动生成密码长 43 字符。
- 契约基线快照：`docs/agent-platform/opencode-v2-contract-baseline/`（openapi.json 118 paths/142 ops/285 schemas、sse-sample.txt 原始字节、config-sample.json 归一化回显、README）。

## 部署侧（已闭环）

- **compose（Agent F）**：worker 注入 `OPENCODE_SERVER_PASSWORD`、server 注入 `SERVER_PASSWORD`，**两者读同一个 compose 变量** `${OPENCODE_SERVER_PASSWORD:-compose-dev-serve-password}` → 结构上不可能不同步（沿用仓库 `WORKER_TOKEN` / `X_WORKER_TOKEN` 先例）。`docker compose config` exit 0、stderr 为空、无 YAML/anchor 错误；服务拓扑未变（db/init/server/web/worker）。
- **chart README（Agent F）**：Secret 表 + `existingSecret` 说明 + 关键 values 表 + 与 compose 对齐清单均已补齐。

## T9 v2 driver 已落地（Agent H）—— 914 → **1028 tests**

- 新增 `worker/src/driver/v2-driver.ts` + `v2-driver.conformance.spec.ts`（接入**共享**契约套件，**断言一行未改**）+ `v2-driver.spec.ts`（51 单测 + 8 条**真 v2 server** 契约测试，二进制缺失时整组 skip）。
- 工厂：v2 模式默认构造**真 V2Driver**；拿不到 v2 驱动 → **fail-fast**（危险静默回退已删）。v1 驱动加**内容类型守卫**（拿到非 JSON → 明确报错点破"v2 已移除 legacy 路由"）。
- 关键实现细节：`unwrapV2List/Object` 容忍 `{location,data}` 与裸数组两种形态；游标翻页**不得再带 `order`**（否则 400 `InvalidCursorError`）；`move` 仅在首次下发前；`GET /api/agent` 用 `location[directory]=` **deepObject**（扁平写法 400）。
- 形状翻译的**有损点**（已逐一记录在代码注释与报告里）：消息联合体只映射 user/assistant（`idle`/`synthetic`/… 丢弃，`outcome` 留给 T14 从事件流取）；form→question **一字段=一问题**（integer/number/boolean 类型语义、`required`/`hidden`/`when` 条件丢失）；tool `state.content[]`→`state.output`(string) 需拼接；v2 无 `native` 字段 → 按内置 id 集合启发式判定。

### ⭐ 本轮最重要的发现：v2 的 `system` 无处安放（**语义降级，需 T15 决策**）

- v2 的 prompt body **无 `system` 字段**，且**带上去不报错但被完全忽略**（实测 200 + 丢弃）。
- `POST /api/session/{id}/agent` 激活的是**配置里 `agents.<name>.system` 的内容**（T15 写、T4 实测进模型 system 段）——**装不下 vteam 运行时那串 system 文本**。
- 当前处置（v2 驱动内）：system 文本**作为文本前缀并入正文** + 每次 `logger.warn` 显式告警（计划 D6 兜底 (d)）。
- ⚠️ **后果**：vteam 的顶层 system（**产出物协议 / @ 机制**）在 v2 下**不再进模型 system 段**，而是落在 **user 段**（优先级更低，模型可能当成用户话而非指令）。
- 正解 = 计划 D6 候选 **(f)**：插件 `ctx.session.hook("context", cb)` 可把文本**直接推入模型请求的 system**（T4 已实测生效，且是**逐消息**语义，最贴近 v1）。**需在 T15 决策**：接受前缀兜底（记录为已知降级）还是实现 (f)（vteam 需出一个 v2 插件，按 sessionID 取 system 文本注入）。

### 契约勘误（实测打脸 librarian）

`Form.Reply` = **`{answer: {<fieldKey>: Form.Value}}`（对象映射）** —— 不是 librarian 说的 `{answer*}`（标量）。
`Form.Info` = `{id, sessionID, title, metadata, fields[]}`，fields 是**带类型的联合**（String/Number/Integer/Boolean/Multiselect/External）。
⇒ 答复键名错会得到 `FormInvalidAnswerError`；v2 要 **value** 而 vteam 存 **label** → v2 驱动缓存 form 字段做转换（未命中则回落 `GET .../form/{formID}`，再不行按序号兜底并告警，**宁可让上游报答案非法也不静默丢答复**）。

### 另一个跨任务项

v2 的 `location` 是**会话属性**：`createSession` 可带 `location.directory`，而 vteam 的 `exec-server` 调 `createSession(model)` **不带目录** → 会话先建在 serve 的 cwd(=workDir)，首次下发前再 `move` 到任务目录。`exec/` 归 T10，需在 T10 或 T18 收口。

## ⭐ v2 真实帧格式（实测；**计划 附录 B 有两处字段错误**）

从 spike 的原始抓帧（`evidence/t5-sse-frames.log`）逐帧读出：

```
data: {"id":"evt_…","created":…,"type":"session.text.delta","location":{…},
       "data":{"sessionID":"ses_…","assistantMessageID":"msg_…","ordinal":0,"delta":"MOCK_OK"}}
```

| 事实 | 计划 附录 B 写的 | **实测真相** |
|---|---|---|
| 文本增量的载荷字段 | `text` | **`delta`** ❌ |
| `durable` 块 | 似乎每个事件都有 | **delta 事件上没有 `durable`**（`session.text.delta` / `session.usage.updated` 都没有） ❌ |
| `data` 结构 | — | **扁平**（v1 全部塞在 `properties` 下） |
| `location` | — | 有的帧有、有的没有 |
| `session.step.ended` | — | 带 `finish`（值与 v1 同名：`stop`/`tool-calls`…）、`rawFinish`、`cost`、`tokens` —— **这就是 v2 的 `step-finish` 等价物** |

### 由此确定的两级幂等键（durable / ephemeral 的保证不同）

| 事件类 | 幂等键 | 能扛住 |
|---|---|---|
| **durable**（带 `durable` 块） | `${aggregateId}:${seq}` | **worker 重启**（上游 id 不变，worker 自己的 `evw_<bootId>_<seq>` 会变） |
| **ephemeral delta**（无 `durable`，有 `ordinal`） | `${eventId}:${ordinal}` | 重放/重复投递 |
| 无上游身份（心跳、`instance.created`、`git.op` 等） | 沿用 `(workerId, eventId)` | 现状不变 |
| **server 重启** | ❌ 内存去重表仍会丢 | **本任务不修**（零 DDL 铁律；不假装修好了） |

## P2b server 侧已落地（Agent K）—— server 4349 tests **全绿**（基线 4331，+18）

- `server/src/chat/message-parts.ts`：`normalizeParts` 从"列表过滤器"升级为**存储形态边界** —— 接受三种输入（裸数组 / v1 `{parts:[]}` / v2 `{content:[]}`）→ 统一成一个内部渲染模型；**总函数**（永不抛错），不可识别输入 → 空 part 集 + 一条 WARN（只记形态不记内容）；`null/undefined` → 静默空集。
- `server/src/workers/worker-event.ingress.ts`：`dedupKeyOf` 作为**唯一**键构造点，四级键（见上表）；durable 事件键**刻意不含 workerId**（上游 id 全局唯一 → 两个 worker 重放同一上游事件时第二个会被去重，failover 语义正确）。
- `server/src/common/constants/event.constants.ts`：`MESSAGE_PART_DELTA` 加"刻意保留原名"的注释，**字符串值未变**。

### ⭐ 形态假设 —— **已验证成立**（不是假定）

用**实测的 v1 会话 dump**（`.omo/evidence/dm-session-dump/raw-session.json`）对 v2 驱动产出逐字段比对：web 实际读的每个字段（`type`/`id`/`text`/`summary`/`thoughts`/`detail`/`synthetic`/`tool`/`state.status`/`state.input`/`state.output`/`state.error`）在 v1 与 v2 **都存在且相等**。
⇒ **零数据迁移、零 web 改动**（`web/src/components/chat/msg-parts.tsx`、`msg-tool.tsx` 经验证**无需改**）。
非 web 读取的差异（无害）：v2 tool part 顶层多一个 `time`；v2 tool state 保留原始 `content[]` 旁边另有派生的 `output`；v2 无 `step-start`（两者都不可渲染）。

## ⚠️ Agent K 揪出的 6 处计划错误（已订正，计划 1259 → **1285 行**）

1. **最危险**：计划说归一化时**丢弃** `step-finish` part —— **错**。`step-finish` 是控制面"本轮完成"的**幂等键**（`findStepFinishPartKey`），v2 没有该 part 所以驱动**合成**它；归一化若丢弃它 → 完成幂等直接失效。→ 改为"**必须保留**"，并加测试钉住。
2. **v2 工具态取值是小写** `running`/`streaming`/`completed`/`error`，**与 v1 同族**（`Running`/`Completed` 只是 OpenAPI 的**类型名**，不是取值）。→ 计划里写大写会让实现者写出永不匹配的大小写敏感映射。
3. 计划说"修掉内存 TTL Map 的重启丢失缺陷" → **夸大**。server 重启**仍会丢**去重状态（零 DDL 铁律 ⇒ 未加持久化）。已改为诚实表述。
4. T20 的 web 侧四态映射**不必要**（web 自己已 lowercase 并映射同族状态）→ T20 收窄为 server 侧 `normalizeParts` 边界 + 形态等价性测试。
5. 两条**条件性风险**（未证实）：v2 reasoning 项可能带自由形态 `state` 对象 → web `MsgThinking` 判 `state === "pending"` 会直接显示"已完成"，**"思考中"永不出现**（抓帧里没有 reasoning 消息，无法证实也无法证伪）；v2 `step-finish.tokens` 无 `total` → `totalTokens: 0`（**用量指标**差异，非形态差异）。
6. `step-finish` 的来源要写全：assistant 消息的 `finish`/`cost`/`tokens` **和** `session.step.ended` 事件两者都带。

## P2a worker 侧事件层已落地（Agent J）—— worker 1029 → **1082 tests**

- `serve-event-stream.ts` 重写为 v2 帧（扁平信封 `{id,created,type,location?,data,durable?}`；类型取 `data.type`，`event:` 行仅防御性优先；坏帧计数+告警不抛；心跳算存活；退避重连保留）。
- **新增 `v2-event-map.ts`**：映射表是**数据**不是 if 链；**26 条已映射**（16 durable / 10 ephemeral）+ **72 条显式 known-unsupported**；**目录覆盖测试**断言"每个 v2 事件要么被映射、要么在 known-unsupported 列表里"（未来新事件无法漏网）。
- `exec-server.ts` 的 SSE 桥改走 v2 事件路：会话过滤 → 表查 → 带 upstream 身份上送；重连后重同步；终态门接到 `runExecution`。
- 终态判定收口到 **`RunTerminalGate`**：durable `session.execution.*` **不直接上送**、喂给门；**事件证据优先于轮询证据**；`settle()` 一次性；**过期的 durable seq 不能覆盖更新的证据**。
- 重连重同步：`onReconnect` **在任何新帧派发前 await**（补齐先于实时帧）→ 清空累积器（`/api/event` 从不重放，复用旧缓冲会拼出从未存在过的文本）→ 拉 `driver.getMessages()` 权威快照 → 只重发"新/前进"的 part → 三条可观测日志。

### Agent J 实测纠正的 3 处（计划原本是错的）

1. **`ordinal` 不是逐帧计数器** —— 同一条 assistant 消息的多帧 delta **全是同一个 `ordinal`**（内容流序号）。⇒ 不能当逐帧单调门/逐帧去重判据；逐帧去重靠帧 id `evt_…`。（我原来把它当逐帧计数器写进了 D4 和 附录 B。）
2. **`session.text.ended` / `session.reasoning.ended` 带权威全文**（`data.text`）→ 映射**优先用它**而非累积流（中途连上的流只有后缀）。
3. **`session.usage.updated` 无 `durable` 块 ⇒ ephemeral** ⇒ 不能驱动状态；映射为 `session.updated{usage}` 且**不带 `status`**（带 `status:'running'` 会把空闲会话翻回 running）。

### 两条已知限制（已记入计划）

- **v1 回退路径失去 SSE 快路径**（SSE 流已是 v2-only）→ 回退时只剩 500ms 轮询，功能在、实时性降级。
- `session.usage.recorded` 仍在 known-unsupported 里 → 用量**不会被投递两次**。

## ⚠️ 跨 agent 契约漂移（已抓到，正在修）

`v2-driver.ts`（轮询路）产 `${messageID}:${index}`，`v2-event-map.ts`（事件路）产 `${messageID}:text` / `:reasoning` / `:tool:${callID}` —— **两套 id 方案并存**。目前 exec-server 在**线上边界**用 `normalizeV2ContentIdList` 对齐，所以**没有活着的分歧**；但 `prompt-await.ts` 是 driver 的另一个消费者，它若按 `part.id` 记账就会与事件路错位（server 按 `part.id` 合并 ⇒ 同内容出两份 part）。
⇒ 已派 Agent L 把 id 派生**下沉进 driver**，事件表 import 同一 helper（单一真源），并要求证明**跨轮询稳定**（server 合并键不稳定就会产生重复 part）。P3（prompt-await 重写）之前必须先落地。

## 闸门合流已激活（Agent N）—— 1134 tests

- `exec-server.ts` 把每轮的 `RunTerminalGate` 作为 `eventSignal` 交给 `sendAndAwait`（＋ `eventGraceMs: 500`、`logger`），且**整块按 `eventPathAvailable` 条件展开** ⇒ **v1 路径连 `eventSignal` 键都不传**。
  - `eventPathAvailable = sseEnabled && Boolean(driver.baseUrl) && !isV1Driver()` —— 那个 `!isV1Driver()` 是刻意的**否定式**判断：注入自定义 v2 驱动时事件路仍然生效，而 v1 驱动（没有 `/api/event`）不付宽限期成本。
- `RunTerminalGate` **结构上就满足** `EventSignal`（`peek`/`notePolling` 兼容，`firstToken` 可选缺省）→ **不需要适配器**，`prompt-await.ts` 零改动。
- ⚠️ **既有的 `notePolling`（~L2207）顺序确实错了**（先记后问）→ 已修为**先问后记**。
- 共享闸门带来的两个副作用都处理了：① 成功路已发 `session.updated(idle)` 后，失败兜底分支可能**补发**终态 → 加 `terminalEmitted` 闸门；② 语义层现在**更早**抛 `RunTerminalError` → `agent.status(error)` 载荷改为**优先取终态证据自带的 error**，保持线上文案不变。
- **做了变异测试**：断开接线 → 用例 1-3 失败；去掉 `!isV1Driver()` → v1 用例失败（583ms ≥ 500ms 宽限期）；去掉 `terminalEmitted` → 用例 5 失败。⇒ 每条新用例都真的在测它声称的东西。

## ⭐ 重新认识 system 承载（读代码后才发现的关键事实）

vteam 的 system **不是**"每个 agent 一段静态提示"，而是**控制面在每次派发时按成员现拼**的一大段：
身份段 + `【岗位职责】${rolePrompt}`（`TeamMember.roleId → AgentRole.rolePrompt`）+ `【职责】` agent 段 …… 然后放进 prompt body 的 `system` 字段。
⇒ 它**装不进**静态的 `agents.<n>.system`（配置是按 agent 名的静态量，blob 是按成员按消息的动态量）。

所以 D6 的三条路重新分工：
- **`agents.<n>.system`**：只能承载**可选的静态 per-agent 提示**（契约加可选字段；控制面填充属后续任务）。
- **每消息的 system blob**（产出物协议 / @ 机制）：v2 **无原生承载** ⇒ 当前仍是**文本前缀兜底**（进 user 段而非 system 段）。
- **正解 = 插件 `ctx.session.hook("context")`**（T4 实测逐消息生效，最贴近 v1）⇒ 已要求写成**具体设计**（`<workDir>/.opencode/plugins/` 下的 v2 插件 + 每会话文件交接 + worker 派发前写入），标注成本与对 T19（插件形态）的依赖，**本轮不实现**。

⚠️ 同时定了**不重复注入**不变式：若被激活的 agent **已配置了非空 `system`**，驱动就**不再**把 blob 前缀进正文（否则角色提示在 system 段和 user 段各出现一次）。实现走 `GET /api/agent` → `Agent.Info.system` 并**缓存**（不加每消息网络往返）。

## F1 已修（Agent Z）—— worker 1180（+10）/ server 4366（+1）/ 真栈 5/5

- **根因（对真二进制复核确认）**：`GET /api/agent` **不带 location** 解析到的是 serve 的**默认 location**（serve 的 cwd），**不跟随会话目录**，且**冷启动时返回空数组** ⇒ 闸门永远判"该 agent 没有配置 system"。
- **修法**：新增导出助手 `buildV2AgentListPath(location)`，闸门改走 **`GET /api/agent?location[directory]=<dir>`**（deepObject，与已在用的 `listAgents(directory)` 同款编码）。driver 本来就在 `sessionDirectories` 里记着会话目录（`createSession` 写入、`move` 之后更新）⇒ `resolveSessionDirectory(sessionID)` 读它，缺失时回落 driver 的 `defaultDirectory`；两者都未知时保留**不带 location** 的查询作为（语义正确的）兜底。
- **缓存**：键改为 **`<location>\0<agentId>`**（结论**依赖 location** —— 同一个 agent key 在不同项目可能是不同的 agent、不同的 system）；一次取回的**整张列表**都入缓存（空串 = "该 agent 没有配置 system"）；失效规则不变（`baseUrl` 变更时清空）；**已知 agent 每 (目录, agent) 只查一次**（3 次 prompt = 1 次查询，有测试）。
- **降级不变**：取列表失败（HTTP 错 / 非 JSON / 超时）⇒ 打既有告警、**不缓存失败**（下次重试）、返回 `''` ⇒ 保留文本前缀兜底。空列表 / agent 无 `system` / 取列表失败三种情形的**前缀行为逐字不变**，只有"查法"变了。
- ⚠️ **它诚实记录了一个上游怪癖**：**冷启动**时第一次 agent 查询返回 `data: []`（上游异步加载项目配置）⇒ 闸门在**第一轮不生效**；因为列表里没有该 agent 就**不缓存结论**，下一轮会重查、闸门从那时起生效。这也解释了为什么 opt-in 真栈用例的第三条（断言 blob 在 user 段）仍然通过 —— 它是**新鲜 serve 的首个 prompt**。
- **`GET /models` 信封已进双写类型**：`WorkerModelsResponsePayload { models: WorkerModelInfo[] }` 两端各一份，进了 `PROTOCOL_SHAPE_NAMES` / `PROTOCOL_MANIFEST` + 编译期 `SameKeys`（worker）/ `Equals<>`（server）断言；既有的运行时断言 `Object.keys(res.body) === ['models']` 保留。

## T21 验证已落地（Agent W）—— 真 v2 全链路冒烟 **5/5**

- **新增**：`worker/src/exec/v2-realstack-smoke.spec.ts`（opt-in，`VTEAM_REALSTACK_SMOKE=1`，否则跳过）、`scripts/e2e-v2-shape-fixture.ts`（用**真 worker injector + 真控制面常量**造 v2 形态 fixture + 13 个漂移 fixture）、`scripts/e2e-v2-shape-logic-check.sh`、`docs/agent-platform/opencode-v2-verification-report.md`。
- **契约对称性**：`contract.spec.ts` 用 **TS 编译器 API** 做**源码级跨副本字段比对**（成员名 + 可选性 + 类型文本）；`worker.client.spec.ts` 用编译期 `Equals<>` 断言 8 组类型恒等，并各带一条**否定断言**（拼错的键**不得**被读）。
- **真二进制实测**（真 `opencode v2.0.28` + 无凭据 mock provider + 隔离 HOME/XDG + 真 `V2Driver` + 真 `ExecServer`）：
  - 五个端点全通；`POST /sessions` → `ses_…`；`abort` → 200/`interrupted:false`；`GET /models` → `vteam-mock/vteam-model`。
  - **完整任务周期只产生 1 个 `task.completed`**，载荷含 `text="MOCK_OK"`、`parts[]`（**含合成的 `step-finish`**）、`model`、`tokens`、`cost`。
  - **模型请求实录**：`system[0]` 以 `ROLE_PROMPT_MARKER_VTEAM_T21` 开头 ⇒ **`agents.<name>.system` 真的进了 system 段**；`user[0]` = `PER_MESSAGE_BLOB_MARKER_VTEAM_T21` + prompt ⇒ **每消息 blob 仍在 user 段**（已知降级）；`tools[]`（13 个）含平台插件工具 ⇒ `codemode:false` 生效，是**直接**工具。
  - **在飞 `delivery:"steer"`**：200 / `admitted:true` / `delivery:"steer"`；注入文本出现在该会话**下一轮**模型请求的 user 段（说明被在飞轮消费，不是饿死）；该轮**只发 1 个**终态事件。
- **事件序列**（实测）：`session.updated(running)` → `agent.status(loading/thinking)` → `session.updated(running)`×N → `message.part.delta`×N → `session.updated(idle)` → `task.completed`。
- **验证结果**：worker tsc 0 / **1170 tests（1165 通过 + 5 跳过；opt-in 打开则 1170 全通）**；server tsc 0、lint **0 errors**、**4365 tests / 0 失败**；web tsc 0；e2e 形态逻辑 **24/24**（6 正 + **18 漂移负**）。
- **三层结论**（它自己分的桶）：
  - **真二进制已证**：隔离启动、五端点、完整周期、事件顺序与单一终态、角色提示进 system、工具在 `tools[]`、delta 带 upstream 身份、合成 `step-finish`、在飞 steer 被消费且不产生第二终态。
  - **仅 mock**：模型本身（延迟/计费/真实 provider 行为）、server 侧去重/`normalizeParts`/入库持久化、控制面 MCP 权威性、引擎侧 `findLast` 求值。
  - **完全未证**：四个 **live-stack** e2e（需 server + 已部署 worker + 容器 + DB；只验了形态逻辑 24/24，18 个漂移负例证明检查器**不空转**）、helm 灰度回滚与**数据卷**回滚、OmO 的 v2 入口、受管配置目录残留。

### ⭐ 它找到一个**真 bug**（F1）：driver 的「不重复注入」闸门是**失效**的

- driver 判断「该 agent 是否已配置 `system`」时查的是 **`GET /api/agent`（不带 location）**；而**真 v2.0.28 下不带 location 返回空数组**（带 `location[directory]=` 才返回该 location 的 agent）⇒ 闸门**永远**判"未配置 system" ⇒ **即使 agent 已带 `agents.<n>.system`，每消息 blob 仍会被前缀进 user 段**。
- 实录佐证：**角色标记在 `system` 段、blob 在 `user` 段** ⇒ 两种载体同时生效。
- 今天的危害有限（控制面尚未填充 `agents.<n>.system`），但**一旦开始填充就是真的重复注入**。
- 修法：复用 driver 已有的**带 location** 的 agent 查询（`listAgents(directory)` 那条路）。它因 `worker/src/driver/**` 在禁改区**没有修** ⇒ 已派 Agent Z 收口（并补一条真二进制属性测试，钉住"不带 location 返回空、带 location 返回该 location 的 agent"这个上游行为，防止前提悄悄腐烂）。
- 另有一处小契约缺口：`GET /models` 的 `{models:[…]}` 信封**不在双写类型里**、只在运行时断言 ⇒ 一并补进两端。

## T22 灰度与回滚已落地（Agent X）—— `docs/deployment.md` §八「OpenCode v2 灰度与回滚」

- **交付顺序**：数据卷快照（home + work PVC）→ server 镜像 → worker 镜像（带 pin 死的 `@opencode/cli@2.0.32`）→ 注入配置改形 → OmO 条目。
  - ⭐ **server 与 worker 必须同时切换**（v1 worker 没有 `/sessions` 端点；v1 server 打的是已移除的 v1 路由）⇒ **两种混搭都不可互操作**。
- **灰度**：G0 前置（快照 + **恢复演练**、v1 镜像仍在、values 基线导出、基线指标）→ G1 硬切（**先把 v1 worker 缩到 0**，`replicaCount.worker=1`）→ 10% → 50% → 100%，每级同一张 G1 检查表：**401=0、归一化诊断=0、重复终态=0**、成功率 ≥ 基线、首字 P95 ≤ 15s、MCP `connected`、一次真实 @ 触发端到端。观察项表给出每个指标的**来源**（grep / SQL / 端点）与越界动作。
- **回滚**（可执行）：冻结（worker 0 + server 0）→ 回滚代码/镜像 → **恢复迁移前卷**（删 PVC → 从快照以同名同 spec 重建让 STS 接管；compose 恢复命名卷）→ 起回 → 验证（`opencode --version` = 1.19.3、worker 在线、一条真实消息、会话历史可见）。
- **数据风险**：MySQL（任务/消息/产出物/成员/角色/模型凭据）**全安全**（零 DDL，回滚不碰库）；**有风险**的只有 v2 期间新建的 opencode 侧会话历史（v2 形态 SQLite，在隔离域里）+ 注入配置的 v2 形态残留。

### ⭐ OmO 结论：**不是 vteam 核心的依赖** ⇒ v2 灰度 = 「OmO 关闭」

- 核心能力（skills/tools/MCP 注入、角色 agent + 权限、会话/流式管线、平台 MCP、产出物归档）**全由平台自身产出**；OmO 只提供**额外**的 agent（Sisyphus/Prometheus/Atlas…）及其 agent→model 映射页。
- 且它**在 v2 上也加载不了**（插件 API 是 v2 三个有意破坏之一：v1 导出 `{server}`，v2 导出 `{id, setup}`），镜像里带的是 v1 形态。
- **决策：把 OmO 注册做成有条件的** —— 只有「用户开关开 **且** 镜像声明了 v2 形态入口（`/opt/omo-bundled.json` → `"v2": true`；当前镜像写 `"v2": false`）」才注册；否则**把 `plugins` 里的陈旧 OmO 条目删掉**（配置在持久卷上，升级路径必须清理）并打日志说明原因。
  - ⚠️ 原来的行为是**每次启动都注册一个 v1 形态插件** —— 那是"无归一化诊断闸门"**抓不到**的静默失败（`plugins` 是 v2 合法键）。现在连"注册了但加载不了"都不再发生。

### 它清理的死变量

`SERVER_PASSWORD`（server 侧给 opencode 的 Basic 鉴权口令）已从 `docker-compose.yml`、`chart/vteam/templates/deployment-server.yaml` 删除；`grep -rn "SERVER_PASSWORD" server/src/` 只剩一条**说明它已被移除**的注释。**`OPENCODE_SERVER_PASSWORD` 保留**（那是 worker 给 `opencode serve` 的口令，仍必需）。

### ⭐ 它报告的 5 处「计划 §9 与代码不符」（没有粉饰）

1. **§9.3「v2 启动时已就地迁移 v1 磁盘数据，v1 读不了该卷」—— 与代码不符**。因为 T16b 的隔离把 v2 的 `XDG_DATA_HOME` 指向 `<iso>/data`，而 v1 的库在 `<realHOME>/.local/share/opencode` —— **两个目录** ⇒ v2 worker **看不到也迁移不了** v1 库 ⇒ **只回滚镜像（不动卷）时，v1 仍能读到 v1 期的会话**；真正读不了的是 **v2 期间**新建的会话。⇒ **回滚比计划说的安全**（我已独立用 `opencode debug paths` 复核，确认）。已派 Agent Y 做末轮订正（计划 + doc 07 + `docs/tech-debt-rollback.md` 的行号引用）。
2. §9.4「让 `req.opencodeVersion` 必填」**未做** —— 该字段仍可选且无生产调用方设置 ⇒ 版本过滤器**是惰性的**。Agent X 把"必须先排空 v1 worker"记成**运维前置**，而不是改 `server/src/**`（超出它范围，且在此时改派发语义风险高）。
3. §9.1 的灰度「1 worker → 10% → 50% → 100%」**按原文不可执行**：过滤器惰性时，按副本滚动（`worker.updateStrategy.partition`）会把 v1 worker 留在池里被 v2 server 派到。§8.2 给了硬切顺序并**明确警告本次切换不要用 `partition`**。
4. §9.2 观察项**漏了"重复终态计数"**（已补，并给了可 grep 的来源）；首字延迟平台无此指标（文档给了 DB 近似并说明）。
5. `docs/tech-debt-rollback.md` 用**行号**引用 `docs/deployment.md`（两处本就过期、这次又漂移）⇒ 改为**章节引用**（已派 Agent Y）。

## 末轮订正（Agent Y）：回滚安全性事实

- **计划 12 处 + doc 07 8 处**订正：凡是说"v2 就地迁移 v1 磁盘数据 / v1 读不了该卷"的地方，改为**带隔离限定**的口径 —— 一次性 legacy 导入**仅当 legacy 路径上确实有 v1 数据时**才发生；**隔离部署下不触发** ⇒ v1 历史原样留盘。
- 计划 **§9.3** 新增「**回滚时的数据影响**」表：平台数据（MySQL）**完好** / v1 期历史**仍在盘上且可读** / **只有 v2 窗口期会话丢失**；"唯一安全回滚路径"→"安全回滚路径（建议快照恢复）"，并注明**不恢复卷的损失是有界的**。
- **D11** 的原风险标为**已作废**并写明"仅当隔离域被关掉时才成立"；新增实测依据表（带/不带隔离各测一次 `opencode debug paths`）。
- 计划 **§9.1** 新增**硬约束表**：v1 server + v2 worker 与 v2 server + v1 worker **都 ❌ 不互通**（v1 server 打的 v1 路由已被 v2 移除；v1 worker 没有 `/sessions` 等执行端点）⇒ **必须硬切；勿用 `partition` 按副本滚动**。
- 计划 **§9.4** 补：版本过滤**今天实际失效**（无生产调用方设 `opencodeVersion`）⇒ 混跑前提是"server 已是 v2 线"。
- `docs/tech-debt-rollback.md` 的**行号引用全部改章节引用**（`docs/deployment.md:224-241` → §4.1/§5.1/§6.1；`learnings.md:149-150` → 按条目标题），并加了「引用口径」说明（只按章节号、不按行号）。所有引用**逐一核对真实存在**。
- 它自己先用真二进制独立复现了该事实。

## T18 控制面收敛已落地（Agent U）—— server **4359**（+10）/ worker 1156

- `server/src/workers/worker.client.ts` 的 5 处直连全部改走 worker 端点：`POST /sessions`、`POST /sessions/:id/prompt`、`POST /sessions/:id/abort`、`GET /sessions/:id/messages`、`GET /models`。
  - **OpenCode Basic 鉴权 + serve 端口解析已删除**（`serverPassword` 字段、`SERVER_PASSWORD` 读取、`buildAuthHeader()`、`resolveBaseUrl()`、`capabilities.port` 分支）；现在只带 `X-Worker-Token`。
  - `capabilities.baseUrl` 只作为**主机来源**保留（拿执行端点的主机名），**serve 端口不再被使用**。
  - `isHealthy` 不再打 OpenCode 的 `GET /`（v2 那里返回 200 + SPA HTML → 假阳性健康检查）⇒ 改打 worker 的 `/models`。
  - **grep 复核：`server/` 里 `prompt_async` / `/api/model` / `/api/agent` / `/api/session` / `'/session'` 命中数 = 0。**
- `sessionId`/`sessionID` 归一落在 **`worker.client` 边界**（唯一知道线上形态的地方）：worker 说 `sessionId`，client 就只对外说 `sessionId`；opencode 时代的 `{id}`/`{sessionID}` 形态**不再容忍** ⇒ 两种拼写不可能并存误读。（server 里剩下的 `sessionID` 只是 part 级渲染字段，属另一套模型。）
- `delivery` **始终显式**：`inFlight:true` ⇒ 强制 `steer`；否则 `opts.delivery ?? 'steer'`（不依赖默认值，默认变了会静默漂移）。worker 侧两条路也都显式传 `delivery:'steer'`。
- ⭐ **版本过滤的错配是真的**：需求侧可能写成原始串 `opencode v2.0.28`，而 worker 上报规范化 `2.0.28` ⇒ 精确串相等**匹配不到任何 worker** ⇒ **全部 worker 不可调度，且无任何报错**。现两端都比对**归一后**的值，且注册/落库边界也归一 ⇒ DB 永远存 semver 串。**注意：需求侧 `AssignmentRequirement.opencodeVersion` 目前没有任何生产调用方设置**（过滤器今天是**惰性**的，为混跑窗口而存在）⇒ 这条过滤一旦被人设上就会立刻生效。
- 404/429 端到端保住：worker 回 `SESSION_NOT_FOUND` / `RATE_LIMITED`；server 读 body 的 `code` ⇒ 404+`SESSION_NOT_FOUND` → `httpStatus:404` + 同码；429 同理。**裸 404（老 worker 没这个端点）刻意不判为会话失效**（否则控制面会无限重建会话）。dispatcher 轮询路径遇 `isWorkerSessionInvalid` ⇒ **解绑**会话（清 `instanceRef`）让下次派发重建，而不是空转到超时。
- **v1 开关现在响亮失败**（3 处，同一条可操作文案）：`config.ts` 的 `loadConfig()` 直接抛；`driver/index.ts` 的三个入口都抛；`runtime/opencode-version.ts` 的闸门**去掉 mode 参数**、无条件要求 major ≥ 2（"认不出版本 ⇒ 只告警不判死"保留）。**代码与计划 §9.3 一致：不再有代码级 v1 开关，回滚 = 代码/镜像 + 数据卷。**
- **standalone 模式遮蔽已修**：`ensureStandaloneProjectConfig()` 在 standalone 模式下也写项目 `plugins` 里的 `-opencode.browser`（写失败只告警、不挡启动），有回归测试。
- ⚠️ 它**不得不突破我的禁改清单**并如实说明：删掉 `v1-driver.ts` 会让 `driver/index.ts` **编译不过**，而闸门住在 `runtime/opencode-version.ts` ⇒ 这两个文件必须改。它把改动做到最小且对 v2 行为保持不变（v2 驱动、part-id 方案、事件层、协议类型均未动）。
- 两条遗留已并入 T22：`docker-compose.yml` 仍给 server 导出 `SERVER_PASSWORD`（现在是死变量）；计划 §9.3 的回滚措辞还没反映到部署文档。

## ⭐ 真跑 compose 栈后才发现的新 v2 事实：CLI 子命令**不连 worker 自己 spawn 的 serve**

本地 compose 栈（db/init/server/web/worker，worker 跑 opencode v2.0.32）实测：

| 调用 | 结果 |
|---|---|
| `opencode mcp list`（裸） | `No MCP servers configured` —— 答的是**它自己**的作用域；而 worker 的 serve 实际 `GET :4000/api/mcp` → `vteam` **connected** |
| `opencode mcp list --standalone` / `opencode --standalone mcp list` | 都**打印帮助文本**（`mcp` 命令组不接受 `--standalone`） |
| `opencode models --standalone` | 能跑（起私有 server），但读的是 **CLI 自己的**配置作用域 |
| `opencode models`（worker 启动时） | **退出码 1**：`ServiceUnavailableError: Location plugins did not finish activating` ⇒ worker 注册**降级不带 `executableModels`** |

⇒ **v2 的 CLI 子命令绑的是"共享后台服务"（默认端口 49374），不是 worker spawn 的那个 serve。** v1 下每次 CLI 调用都起自己的临时 serve（cwd 作用域），v2 不是了。
⇒ **凡是用 CLI 探针去"观测 serve"的设计，在 v2 + 隔离下原理上就是错的** —— 它观测的是另一个作用域：可能报出**不含 vteam 自配模型**的模型清单，可能报出"没有 MCP"而 serve 的 MCP 明明 connected。**两个都是静默错误答案。**
⇒ 修法：两个探针改为**直接查 serve 的 HTTP API**（`GET /api/model` / `GET /api/mcp`），v2 driver 的 `listModels()` 本来就是这么做的（现栈里已能拿到 10 个模型）。
⇒ 附带拿到 **v2 `/api/mcp` 的五状态**（比 CLI 文本的 3 个多）：`connected` / `pending` / `disabled` / `failed` / `needs_auth`（`Mcp.Server.status` 是 `{status, error?}` 对象）。
⇒ 已派 Agent 修（**唯一只有真跑栈才能发现的缺陷** —— 离线验证全绿时它藏着）。

## ⭐ 最终验收（真栈，控制面 API 视角）

`GET /api/v1/workers`（admin 登录）→
```json
{ "id": "w_compose_worker", "status": "online",
  "opencodeVersion": "2.0.32",
  "mcpStatus": [{ "serverName": "vteam", "status": "connected" }] }
```
DB `workers` 行：`status=online`、`opencode_version=2.0.32`、`JSON_LENGTH(capabilities->"$.executableModels")=10`。
`web /` 200、`web /workers` 200、`server /api/v1/health` 200；serve `GET /api/mcp` → `vteam` connected；server 日志**零 400/校验错误**（部署顺序隐患未发生）。
栈：db/server/web healthy、worker online，**保持运行**。

### 五态契约的爆炸半径已闭合

- **web**（此前会渲染错）：`workers/shared.tsx` 的 status 联合扩到五值、`MCP_STATUS_THEME` 补 `pending`（◐ 连接中，teal）与 `disabled`（○ 已停用，neutral）；`skills/page.tsx` 的 `toFrontendStatus` 同样映射（`pending→connecting`、`disabled→disabled`，**不折叠成 disconnected** —— "人为关掉" ≠ "没连上"）。
  - **两道证明旧 bug 消失**：① 运行时用 tsx 载真实 theme map，五态全部有定义（旧三键 map 对 `pending`/`disabled` 返回 `undefined`）；② **编译期** —— map 是 `Record<McpStatusEntry["status"], …>`，把联合缩回三值会让 `tsc` 直接报 `TS2353` ⇒ **形状本身禁止这个 bug 再犯**。另加纯单测门 `shared.spec.ts`（3 例，已验证删掉 `pending` 键会红 2 例）。
  - 顺带加了 `web/playwright.config.ts` 的 `app-unit` project（照既有 `lib-unit` 先例，否则新 spec 根本不会被执行）。
- **部署顺序硬约束**（写进 `docs/deployment.md` §8.0/§8.1/§8.2/§8.4 + `NOTES.txt` 第 9 条）：**server 必须先接受五值**，否则 `mcpStatus` 是 `@ValidateNested({each:true})` —— **一个不认识的值就让整个心跳 400** ⇒ 心跳断 ⇒ **30s（3 周期）内 worker 被判 offline**。灰度 1.2 拆成 **1.2a（先 server，等 ready）→ 1.2b（再 worker）**，并明写"**滚动更新 worker 只有在 server 已是新版之后才安全**"。
- **两处过期注释**已改（`server/src/models/models.service.ts`、`worker/src/driver/opencode-driver.ts`），另加 `register-worker.dto.ts` 的描述 + 1 处 spec 注释/用例名（我收尾）。
- **新事实已记录**：计划新增 **§2.9「v2 的 CLI 不是 serve 的探针」**（D9 修订、T17 补 5 条验收含"不得留 CLI 兜底"的守卫）；doc 07 新增 **§12.10**（12.10.1 CLI 作用域错配 + 12.10.2 五态契约）；§10 新增 **Q16（五态）已关闭** ⇒ **20 项：已关闭 6 / 仍开放 14**。

## v2 CLI 探针已修为 serve 作用域（真栈验过）

- **模型探针**：`spawnSync('opencode', ['models'])` **删除**（连超时常量一起删，**不留 CLI 兜底** —— 兜底会让作用域错配重新变成"正常路径"）。改为走 **driver 的 `listModels()`**（= serve 的 `GET /api/model`，与 agent 实际执行同一作用域）。两种响应形态（2.0.28 `{location,data}` / 2.0.32 裸数组）用既有的容错助手 `unwrapV2List`；`enabled:false` 的模型不算"可执行"；空/非法响应 ⇒ `undefined`（**不断言"零可用"**）。
- **MCP 探针**：改为查 serve 的 `GET /api/mcp`（Basic 鉴权），**端点与口令从 serve 对象读**（serve 换端口重启会自动跟上，不从 env 重读）。加了**形态闸门**（不是 v2 `/api/mcp` 形状 ⇒ `probe_failed`，绝不报"没有 MCP"）+ 5s 超时 + "不 shell out 到 opencode CLI"的**回归守卫**。
- ⭐ **五态 1:1，不折叠**：`connected/failed/needs_auth` 之外新增 **`pending`**（还在连接）与 **`disabled`**（配了但关着）—— 它们**都不是 `failed`**（把"即将连上"报成"连接失败"、把"故意关掉"报成"故障"都是撒谎）⇒ **两端契约同步扩到五态**（worker `McpServerStatus` ↔ server `MCP_STATUS` + `@IsIn`）。未知/缺失 `status` ⇒ 保守落 `failed` **并响亮告警**（带原始状态串），**不静默丢服务器**、不静默报健康。
- **真栈验证**：worker 日志**不再有** `可执行模型探测失败` / `Location plugins did not finish activating`；注册载荷**带上了 `executableModels` = 10 个 id**（与 serve 的 `GET /api/model` **完全一致**）；MCP 探针报 `vteam` **connected**（与 serve 一致）；server jest **4368 通过 0 失败**。
- ⚠️ 它标出**五态契约的爆炸半径**（已派修）：
  1. **web 会渲染错** —— `web/app/(main)/workers/shared.tsx` 的 status 联合是三值 + `MCP_STATUS_THEME` 是该联合的 `Record` ⇒ `pending`/`disabled` 让徽章查表得 `undefined` ⇒ **worker 详情页渲染报错**。
  2. **部署顺序是硬约束** —— server 的 `@IsIn` 必须**先**接受五值，否则 worker 一上报就被 400、**整个心跳挂掉、worker 被判离线**。runbook 原本就是 server→worker 顺序，但没写原因，容易被"滚动更新 worker"意外反转。
  3. 两处过期注释仍称"CLI 是模型清单真值源"（`server/src/models/models.service.ts`、`worker/src/driver/opencode-driver.ts`）。
  4. 新事实需要记进计划与 doc 07。

## ⭐ 用户实测暴露：D6 兜底 (d) 的语义代价已实际发生

用户在跑着的栈上发消息，观察到**整个平台协议提示词被塞进用户消息**（平台协议、岗位职责、派发铁律、回执铁律、团队上下文…）。根因**确诊**（三条证据对齐）：

1. worker 日志里 driver 每次都打：`v2 的 prompt body 无 system 字段（带上去会被忽略），顶层 system 提示已作为文本前缀并入正文（计划 D6 兜底 (d)）`。
2. v2 prompt body 契约实测：属性 `id, text, files, agents, skills, metadata, delivery, resume`，**`additionalProperties: false`，无 `system` 字段**。
3. driver 代码注释本就写明：「残余语义缺口（逐消息 blob 没有 v2 原生落点）：文本前缀落在模型的 **user 段**」。

⇒ **不是新 bug，是 D6 定义的已知降级。** 但**有实质影响**：那串 blob 里是**行为铁律**（先查后派 / 回执必@派发人 / 只发增量 / 催办引原文），落在 user 段 ⇒ 模型当成"用户说的话"而非系统指令 ⇒ 约束强度下降，且会把协议文本当成要回应的内容。
⇒ **正解 = D6 候选 (f)**：v2 插件用 `ctx.session.hook("context", cb)` 把文本**直接推进模型请求的 system 段**（T4 spike 已实测逐消息生效，最贴近 v1 语义）。driver 注释里早就写好了这条演进路径：「插件方案上线后两条路并存，靠『配置化 system 非空 ⇒ 不重复拼前缀』的闸门避免重复注入」。
⇒ 已派 agent 实现（**在跑着的栈上直接验**）。

## ✅ D6(f) 已实现并实机证明 —— 逐消息 blob 进 system 段（Agent）

- 新增 `worker/src/driver/v2-system-handoff.ts`（交接存储 + 插件生成 + **按 location 分桶**的就绪协商）、`v2-system-handoff.spec.ts`（19 例）、`v2-system-handoff.real.spec.ts`（opt-in 真二进制）。
- 改动：`v2-driver.ts`（载体路由 `routeSystemBlob` → `none`/`prefix`/`plugin`）、`driver/index.ts`（工厂可选 `systemHandoff`；**`OpenCodeDriver` 接口未变**）、`index.ts`（建存储 + 装插件 + 每次 serve 重启清就绪标记）、`injector.ts`（`applySystemHandoffPlugin()`，manifest 键 `systemHandoffPlugin`）。
- 交接：`<workDir>/.vteam-system-handoff/<sessionID>.txt`，内容 = 原样 blob（UTF-8、无尾换行、不重序列化）。**故意放在 `.opencode/` 之外** ⇒ 不进 opencode 配置发现域。插件里烤入绝对路径 + 校验 session id 正则 `/^[A-Za-z0-9_-]{1,128}$/`。
- 插件：`Plugin.define({id, setup})` + **动态** `import("@opencode/plugin")` + identity 兜底（静态 import 会让 v1 下整个模块加载失败）+ `setup` 护栏 `if (!ctx?.session?.hook) return`（v1 也会调 `setup`）+ v1 侧 no-op 的 `server()`；id 固定 `vteam-system-handoff`。hook = `ctx.session.hook("context", cb)` → 读该 session 的交接文件 → `event.system.push({type:"text", text:blob})`；**无文件则不 push**（绝不推空部件）。插件**只读、绝不重生成/重排/重序列化**。
- **不写 `options:{codemode:false}`** —— 那选项是给**工具**的（决定模型能否直接 `tool_calls`）；session hook 不是模型可见工具，hook API 的第三参是 **provider 作用域**（`ModelHookOptions`），加它无意义。
- 载体路由（互斥是**结构性**的，不是巧合）：
  | agent 配了 `system`? | 插件路径生效? | 动作 | blob 落点 |
  |---|---|---|---|
  | 是 | – | **完全不注入**（既有 T15 闸门）+ 清交接文件 | – |
  | 否 | 是 | 写交接文件、**不拼前缀** | 模型请求 **system 段** |
  | 否 | 否 | **文本前缀**（逐字同旧）+ 既有告警 | user 段 |
  ⇒ 前缀路**总是** `clear()` 交接文件 ⇒ 插件不可能再推同一 blob；agent 配 `system` 的闸门在两者**上游** ⇒ 角色提示也不可能两段重复。
- ⭐ **实机证明**（重建 worker、真实平台派发、真实 vteam blob、mock provider 记录模型请求）：**system 段 20688 字符** —— 前 13323 是 opencode 内置件，**其后**才是 blob（"你是 AI 协作平台的 Agent，请遵守以下平台协议…" 到 "…测试-1（实例 id: tmm_0000000005，角色: tester）"）⇒ **blob 是 system 段最后一项**；**user 段两条消息都不含 blob**。
- ⭐ **两个新实测事实**：
  1. **v2 按 location 加载插件**（同一插件文件打两次 `loading plugin`）⇒ 就绪标记**必须按 location 分桶**，否则新 location 的首次派发会以为插件已就绪、写入 blob 却无人读 ⇒ **blob 静默丢失**。
  2. **push 的 system 部件落在内置件之后** ⇒ 可缓存前缀 = **`[内置][blob][消息…]`**（**好顺序**：恒定的内置件仍在 blob 之前；若是"落在前面"，恒定部分会被推到变化 blob 后面，内置段缓存会受拖累）。与 v1 顺序不同（v1 是 body `system` **前置**），但**只在跨版本升级时**影响一次重缓存。
- **缓存稳定性是承重不变量**：存储用 **compare-then-write**（字节相同 ⇒ **不重写**，inode/mtime 稳定、无撕裂读窗口）；真二进制用例断言**同一会话两次派发 blob 逐字节相同**。插件**每次模型请求**都触发（agent loop 每次工具往返都是一次请求）⇒ 稳定**仅**因字节稳定；代码注释已写死这条（谁加个时间戳就静默毁掉整会话缓存）。
- **与 v1 / 旧兜底 (d) 的持平性**：v1 走 body `system`（每 prompt 一次），插件是每模型请求一次 —— blob 固定时**token 前缀内容与位置都相同**；旧前缀兜底也是稳定前缀（拼好的 user 消息被存下来原样重发）⇒ **插件不损害缓存**，且在语义（铁律当系统指令）、UX（blob 不再出现在聊天气泡/消息历史）、token 归属（不再计入对话轮）三方面都更好。
- **残留成本（非回退）**：blob 里【任务状态】/【团队上下文】/【群聊回复要求】是**易变段**，变了前缀从该处断、该会话后续重缓存 —— **与 v1 完全相同**（v1 同一串 blob 也在 body `system` 里每次重发）。稳定/易变拆分**刻意没做**，记为未来优化（计划 Q20）。
- **另一残留**：location 尚未启动插件时的**首次**派发回落前缀（安全，不丢）；生产流里 session `move` 会先启动 location，故首次即走插件路（已实机验证）。
- 测试：worker **1211**（1205 + 6 opt-in 跳过），server 4368 不变；`npm run typecheck` clean。
- 计划 **1392 → 1543 行**；D6 关闭，新增 **Q17/Q18/Q19（已关闭）**、**Q20（开放·未来优化）**；§10 共 **24 项：9 关闭 / 15 开放**；spike 文档 **844 行**。

## T23 文档订正已落地（Agent V）—— 19 篇文档，零源码改动

- **doc 07**（平台基线）：D13 表 **11 行全部订正**（我简报里说 8 行，实际表里有 11 行 —— 它按实际改了）+ 新增 **§12「v2 适配落地的实测结论」**（12.1 无 `--pure` 等价物 / 12.2 `prompt` vs `system` 键规则（含"0 诊断闸门不充分"）/ 12.3 运行时与契约形态 / 12.4 `agents.<n>.system` 进模型请求 + 激活 / 12.5 v2 不读 `auth.json` → 双写 / 12.6 权限默认变宽（**指向 §3.2 不重复**）/ 12.7 工具注册形态 / 12.8 v1 driver 退役 + 回滚是代码+镜像+数据卷 / 12.9 交付链与灰度观察项）。
- **最要紧的一篇**：`docs/test-cases/08-…md` 的 **TC-POL-007** 原本写 `agents[].permission` 键集 = `edit/read/bash/task` ⇒ 现按 v2 形态重写（`agents` 节 / `permissions[]` 有序数组 / `shell`+`subagent` / `external_directory` / 无 `permission`·`prompt` 键 / 提示在 `system` / 零 `vteam_*` / **并写明"未声明动作被引擎放行，平台已接受"**）。
- 另修：`34-Worker交互接口协议`、`11-资源与注册机制`、`14-Agent配置`、`15-数据模型`、`16-内置Agent角色`、`17-仓库权限`、`18-推进计划`、`20-E2E验证问题清单`、`21-平台MCP-Server`、`A1-`、`05-非功能与验收边界`、`docs/deployment.md`、`docs/secret-command-tool.md`、`docs/test-cases/06-`、`sdks/python/{WORKER_API,DEPLOYMENT}.md`、`worker/README.md`（含新增「已知限制（仅开发模式）」）。
- **dev 模式限制是实测的**（不是猜的）：tsx 下渲染出的 git-tools 插件含 `__name(...)`（esbuild `keepNames`）→ 加载即 `ReferenceError`；`tsc` 产物干净。
- **它刻意没改的**（判断正确）：`worker/.env.example`（并行 agent 正在改，且 `OPENCODE_V2_ENABLED` 现在是**抛错开关**，写进用户可见的 env 样例会误导）；三份**有日期的实测记录/报告**（改了就等于伪造历史）；`server/src/…/CONTRACT-tool-naming-and-identity.md:13`（在 `server/src/` 内，本轮禁改区）。

### ⭐ 它诚实报告的 5 处"代码与文档仍不一致"（**没有粉饰**）

1. **控制面仍有 5 处 v1 opencode 直连**（`server/src/workers/worker.client.ts`）—— 在 v2 serve 上这些路径返回 **200 + web SPA HTML**（不是 404）。⇒ 它把它记成 07 §11.5 与 34 §7 的**显式"已知缺口"**，**没有**写成已完成（当时 T18 还在跑）。
2. doc 34 §7（通道⑤）在 D3 落地后需要**删除**而不只是更新。
3. 每消息 system blob 仍是文本前缀（进 user 段，已知语义降级）；正解 `ctx.session.hook("context")` 已实测但未实现。
4. **OmO 没有 v2 形态插件入口**（U8）—— v1 插件实现在 v2 跑不起来，已记进 `docs/deployment.md` §4.5 生效前提。
5. **受管配置目录不受 XDG 控制**（U9）⇒ 隔离方案**不是 100% 等价于 `--pure`**。

## T19 三个生成器改插件形态已落地（Agent R）—— worker → **1220 tests**（+34）

- 三个生成器现在产出**双形态模块**（同一份文件同时服务 v1/v2）：v2 走 `setup()` → `ctx.tool.transform` → `editor.add`；v1 走 `server()` → `{ tool: { <name>: tool({...}) } }`。**工具实现函数是共用的**（v1/v2 调同一个 impl）⇒ 行为不可能漂移。
- ⭐ **它推翻了我简报里的一个写法**：我建议 `import { Plugin } from "@opencode/plugin"` 静态导入 —— **v1 1.18.32 二进制里根本没有 `@opencode/plugin`**（`strings` 实测 0 命中，只有 `@opencode-ai/plugin`）。静态导入会让模块在 v1 下**求值失败** → v1 **静默跳过该插件**（日志里无任何错误）→ **v1 的全部工具消失**。⇒ 改为**动态 `import()` + identity 兜底**；`Plugin.define` 上游本身就是 identity 函数，v2 行为不受影响。
- 工具名**完全不变**：custom `<action>`、git 家族 `git_clone/pull/fetch/status/diff/log/push`、browser。实测 v2 `tools[]` = **21** 个、v1 `tools[]` = **20** 个（平台工具集合相同）。
- `context.directory` → **`ctx.location.directory`**（+ `ctx.session.get({sessionID}).location.directory` 兜底）；v1 分支传空目录（v1 无 plugin location，v1 作用域主键是 `sessionID`，实践等价）。
- **落点迁移**：工具产物改落 **`.opencode/plugins/`**；injector 的 manifest 拆成 `toolPlugins`（新落点）+ `legacyTools`（**一次性清理**升级前的 `.opencode/tools/` 文件，用户自己的文件保留）。
- `.opencode/package.json` **在这个分支上原本不存在**（计划说它钉着 `@opencode-ai/plugin@1.18.29` —— 那是**用户脏工作区**里的文件，不在 main；计划该处陈述过期）→ 新建，精确钉 `@opencode/plugin@2.0.32`。
- 新增 `worker/src/resources/v2-plugin-contract.spec.ts`：真 serve 契约测试 + `tsc --noEmit` **编译期**检查（生成物类型错 → 构建期就红，而不是运行时才发现）。

### ⭐ 又一个静默遮蔽（与 T15 的半改名同类）

**工具名 `browser` 被 v2 内置的 `opencode.browser` 插件占用**。平台自己的 `browser` 工具**被静默遮蔽** —— 它在全局注册表里，但**不在模型的 `tools[]` 里**（12 vs 13 个工具），**任何地方都没有报错**；`editor.remove("browser")` 再 `add` 也无效（内置插件注册更晚）。
⇒ 修法：injector 往项目 `plugins` 节写 **`"-opencode.browser"`**（T6 唯一验证过的精确 id 排除形；`["-*"]` 会连内置 agent 一起关掉）。修后 `browser` 重新出现在 `tools[]`，并有契约测试钉住。

### 真 serve 实测（v2.0.28，隔离 HOME/XDG，无凭据 mock provider）

- 插件加载 ×3（`msg="loading plugin" id=…/.opencode/plugins/{git,browser,jira-query}.ts`）。
- 工具被投放给模型：`tools(21)`，且**不在** system 的 Code Mode 目录里 ⇒ 是**直接**工具。
- 被真实调用：`session.tool.called {id:"call_mock_2", input:{"jobName":"probe-final"}}` + `session.tool.success {content:[{type:"text",text:"VTEAM_T19_OK:…"}]}`；`level=ERROR` 计数 **0**。
- **`codemode:false` 的差异实测**（同一 serve，控制插件去掉该选项）：**带** → 进 `tools[]`、不进目录；**不带** → 只进目录（`jira-query-in-tools=False`，系统提示 "They cannot be called directly"）。
- **v1 回退路径实测**（真 v1.18.32 二进制、同一批产物）：3 个插件文件全部加载；`tools(20)` 同名；工具被调用并完成（`output=VTEAM_T19_OK:{...}`）；`level=ERROR` **0**。

### 3 条遗留（已记录）

(a) `WORKER_STANDALONE=true` 时 injector 被跳过 ⇒ `-opencode.browser` 不会写 ⇒ 该模式下 `browser` 工具被遮蔽 → **已并入 T18**（它拥有 `worker/src/index.ts`）。
(b) git 助手经 `toString()` 注入 ⇒ **dev 模式（tsx）** 下 esbuild 的 `__name(...)` 助手会漏进产物、运行时出错；生产（`tsc`）不受影响 → 已进 T23 的文档。
(c) 注入的助手丢失 TS 注解 ⇒ git 产物的编译期检查需 `--noImplicitAny false`（custom-tool 与 browser 产物严格干净；两个真实的 bigint/number 错误已用 `BigInt()` 包装修掉）。

## e2e 证明脚本已适配 v2 形态（Agent S）

- **新增 `scripts/opencode_v2_shape.py`** —— **唯一**的 v2 形态读取器（节名 / 改名表 / `findLast` 求值 / v1↔v2 三元组互译），四个脚本共用。
- 修了 **4 个**脚本（不只我点名的 2 个）：`e2e-permission-matrix.sh`、`e2e-third-party-no-policy-leak.sh`、`e2e-role-boundaries.sh`、`e2e-native-edit-enforcement.sh`。
- ⭐ **它纠正了我简报里的一个错误前提**：我写"期望集 = 控制面声明的原生键 + `vteam_*` MCP 工具条目"，但**控制面的 `projectNativePermission` 投影会把 `vteam_*` 条目剥掉**（冻结基线 `before-agent-policies.json` 里 `agents[].permission` 恰为 `{edit,read,bash,task}`，doc 07 §3.2 也这么写）⇒ 断言 `vteam_*` **存在**会让证明对着**正确**系统失败。
  ⇒ 它实现的是忠实的等价物：**期望集 = 原生键（改名后）+ `external_directory`**；而 `vteam_*` 工具名（从 server dist 读）必须**缺席**（出现 = 漂移）。**这比 v1 脚本更强**（键集从运行中的 server 推导，不是硬编码）。
- **失败方向已被证明**（用**真实 worker builder** 产出的 fixture，不是手搓的）：
  - 10 个漂移 fixture **全部响亮失败**（只有 v1 `agent` 节 / 完全没有 `agents` 节 / 出现 `vteam_*` / 缺 `subagent` 规则 / 保留 v1 的 `bash` / `edit` `*` 被翻成 `allow` / edit 规则不是 deny-then-allow / 缺 `external_directory` / 出现 `write` / 少一个内置角色）。
  - leak 检查器退出码：干净 0 / 外部名字在 `agents` 1 / 在 legacy `agent` 1 / **节缺失 2**。
  - ⭐ **拿同一 fixture 跑 git HEAD 的旧代码**，复现了旧 bug：旧 leak 检查器**退出 0** 并打印"no `agent` section present (agent-slot assertion is vacuously clean)" —— **静默假阴性**；旧 step2 退出 1 —— 证明是坏的。
  - 19/19 harness 检查符合预期 + 另两个脚本 7/7。
- **节缺失现在会响亮失败**：检查器退出 **2** 并打印 `[MISSING-SECTION] … result: NOT-CHECKED`，调用方映射为 `fail "B-oc" "…refusing to pass vacuously"`。HOME 的模型凭据配置里 `agents` 节**保持可选**（那不是策略注入产物，要求它会造成假失败）。
- server 侧过期理由**已改注释**（仅注释，零行为/零键集变化）：`vteam_*` allow 条目在 v2 下**理由变了**（从"兜底"变成"显式声明"），并警告不要加 catch-all ask。

### 顺带发现的过期文档（docs/ 在其禁改区，已记录待 T23 一并订正）

`docs/test-cases/08-Agent角色实体化与role拆除.md:215`（TC-POL-007 仍写 `agents[].permission` 键集 = `edit/read/bash/task`）、`34-Worker交互接口协议.md:253,257,334`、`11-资源与注册机制….md:36,166,168`、`15-数据模型细化….md:335`、`16-内置Agent角色与提示词库.md:506`。

## T17 探针 + 权限契约记录已落地（Agent Q）—— worker → **1202 tests**（+17）

- **MCP 探针**现在有两级结果：每服务器三态（`connected`/`failed`/`needs_auth`）+ **探针级结果**（`ok`/`probe_failed`）。
  - 判定规则：先剥 ANSI；行形 = 可选 v1 bullet（`● • *`）+ 状态字形（`✓ ✗ ⚠ ○` 或 ASCII `v V x X !`）+ 空白 + 单 token 名字 + 空白 + 状态文本；**文本优先**分类（`needs auth`/`unauthorized` → needs_auth；`failed`/`error`/`timeout` → failed；`connected` → connected）；**帮助文本按结构识别**（`DESCRIPTION`/`USAGE`/`GLOBAL FLAGS`/… 独立成行）且其行**永远匹配不上**列表行形 ⇒ 不可能把帮助文本解析成服务器列表。
  - `No MCP servers configured` → `ok` + 空列表（**真的**没有 MCP），与 `probe_failed` 区分开。
  - 非零退出 / 解析不了 / spawn 失败 → `probe_failed`，**保留上次好结果**并打一条响亮日志。
  - 节流（30s）与缓存身份不变；`getStatus()` 与既有 DTO **逐字兼容** ⇒ server 心跳不受影响。
  - ⚠️ 它顺手指出一个**契约约束**：server 侧 DTO 用 `@IsIn` 把 `status` 钉死为三值 ⇒ 加第四个线上状态会让整个心跳校验失败（400）⇒ 它**没有**改线上形状，只在 worker API/日志里暴露失败态。这个判断是对的（不改契约是保守正确的选择）。
- 其余三个探针**逐个对真 v2 二进制复核**，均**无需改动**：版本（`opencode v2.0.28` → major 2）；模型目录（131 行 `provider/model`，与 v1 过滤结果**逐个相同**）；serve banner（端口 + 43 字符密码都对）。
- **权限契约记录**（你的决策）：`doc 07` 新增 §3.2「v2 权限的默认取值口径与平台已采纳决策」（实测事实 → 后果 → 已采纳决策 → 给实现者的红线）；`14-Agent配置与虚拟团队模型.md` §3.3 与 `16-内置Agent角色与提示词库.md` §2.1.2 各加 v2 提示；三个 e2e 脚本各加头部说明；worker 侧翻译层加注释（提醒**不要**"顺手"加 catch-all ask）。
  - 三个脚本**都不需要行为变更**（它们断言的是"注入配置 == 源常量"，从不断言引擎对未声明动作的默认）；唯一 pin 住声明键集的测试 `agent-policies.native-only-payload.spec.ts` 也不受影响。

### ⚠️ 但它同时揪出 **T15 的两处连带伤害**（已派 Agent S 修）

1. **`scripts/e2e-permission-matrix.sh` 会直接失败** —— 它的 step 0b/step 2 读的是 **v1 的 `agent` 节和 `permission` 对象**，而 T15 现在注入的是 `agents` + `permissions[]` 数组。
2. **`scripts/e2e-third-party-no-policy-leak.sh` 会变成"静默假阴性"** —— 它读 `oc["agent"]` 做 agent 槽位检查，v2 形下该键不存在 → 读到空值 → **"没有泄漏"** ⇒ **一个报成功却什么都没检查的脚本，比没有脚本更糟**。
3. 另有一处**过期理由**（非行为）：`server/src/execution-policies/execution-policy.service.ts:423-426` 用"否则未出现在 permission 中的工具会按引擎默认 ask/deny"来解释 `vteam_*` allow 条目 —— v2 下该理由已失效（未声明动作命中 catch-all **allow**），但**结论不变**。需改注释并指向 doc 07 §3.2。

## T16b 隔离 HOME/XDG 已落地（Agent O）—— worker → **1186 tests**（+52）

- 隔离根 = **`<worker HOME>/.opencode-iso`**，下挂 `home/ config/ data/ state/ cache/`。
  - **为什么放 HOME 而不是 work dir**：work dir 是 opencode 的**项目域**（serve cwd = WORK_DIR，vteam 的项目 `opencode.json` 与 `.opencode/` 都在那），把全局域塞进去会混淆两层。而 **worker 的 HOME 本来就是部署为 opencode 数据预留的卷**（compose `worker_home:/root` 注释写着"opencode.db 会话库、auth.json 模型凭据、log"；chart 设 `HOME=/root` + 挂 `worker-home` PVC）⇒ **零部署改动**，且与 v1 旧数据（`<HOME>/.local/share/opencode/`）天然不重合（利于回滚关系）。
  - DB 与 `auth.json` 同目录 ⇒ 同卷（D11）。
- 子进程 env：`HOME/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME` 全部指向隔离域；并**删除** `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG`（宿主机残留 = 额外的配置发现入口；最后一个还会把项目配置一起杀掉）。
  - 实测（`opencode debug paths`）：v2 **五个全认**。**承重**的是 `XDG_CONFIG_HOME`（全局配置/插件/AGENTS.md）与 `XDG_DATA_HOME`（auth.json + DB + log）；另两个被认但无功能依赖 —— 仍钉死，防止泄漏到宿主。
- 隔离根在启动时打日志（不含任何密钥）。

### ⭐⭐ 它抓到的**致命级**发现：v2.0.28 **根本不从 `auth.json` 取 provider 的 API key**

- 路径事实：`auth.json` **跟随 `XDG_DATA_HOME`**，**没有**钉死在真实 `$HOME`。
- **但**：用 mock OpenAI 兼容端点实测 —— 把 `auth.json` 放进 XDG 位置后，模型请求**没有 `Authorization` 头**、SQLite 的 `credential` 表**为空**；放 HOME 位置同样如此；已知集成（`openai`/`anthropic`）同样如此。**v2.0.28 的"一次性导入 legacy auth.json"迁移实测是 no-op。**
- 真正生效的载体只有两个：① 配置里的 **`providers.<id>.settings.apiKey`**（实测请求带 `Authorization: Bearer <key>`）② v2 原生 `POST /api/credential` → SQLite `credential` 表。
- ⇒ **若沿用 v1 的 auth.json 注入路径，切到 v2 后 worker 会"静默地没有可用模型"**（不报错、只是没模型）—— 这是整个迁移里最容易踩且最难查的一类坑。
- 落地：**凭据双写** —— `auth.json` 照写（v2 的 legacy 路径 + 形态兼容）+ **同时**写进 provider 段的 `settings.apiKey`（v2 真正会读的那一处），且以 `auth.json` 为**真源**：`writeOpencodeConfig` 会为缺 key 的 provider **回填**，所以任何写入方（例如不可改的本地管理口 `POST /config/model-credentials`）都**无法悄悄抹掉**凭据。代价如实记录：明文 key 也落在 `opencode.json`（0600，隔离域内）—— v2 自己的 credential store 本来也是同卷明文，暴露面没有实质增加。

### 实测验收 20/20

(a) 宿主机全局配置**零痕迹**（`GET /api/config` 只有隔离域 + 项目配置；`GET /api/plugin` 非内置插件 **0** 个；宿主的 `omo-v2` / `opencode-cmd-provider` 都不在）；(b) **项目配置被正确拾取**（`PROJECT_CONFIG_MARKER_VTEAM`）；(c) **凭据真的被读**（mock LLM 收到 `Authorization: Bearer PROBE_KEY_E2E`）；(d) DB 落在隔离域、且与 `auth.json` 同目录；(e) 宿主的 `opencode.json(c)` / `auth.json` / 全局 `AGENTS.md` **前后逐字节相同**；(f) work dir **无 `AGENTS.md`**（且 grep 确认 `worker/src` 里**没有任何写入方**）。

### 刻意不做

`plugins:["-<id>"]` 排除（OmO 的 v2 入口仍是 U8；若需要，位置是**项目** `opencode.json` 的 `plugins` 数组，语义是**合并且顺序即优先级**；`["-*"]` 不可用）。受管目录（`/etc/opencode`、`/Library/Application Support/opencode`）**不受 XDG 控制**、v2 仍会看，只有 `policies` 能压制 ⇒ **残留不可修**（U9）。

## T15 配置 v2 形态已落地（Agent P）—— worker → **1180 tests**

| v1 形（原来写的） | v2 形（现在写的） | 结构性变化 |
|---|---|---|
| `agent: {<n>: {description, mode, permission:{…}}}` | `agents: {<n>: {description, mode, permissions:[…], system?}}` | 改名 + 对象→数组 + 新增 `system` |
| `permission: {edit:{"*":"deny"}}` | `permissions: [{action:"edit",resource:"*",effect:"deny"}]` | 对象→**有序数组** |
| `permission.bash` | `{action:"shell",…}` | action 改名 |
| `permission.task` | `{action:"subagent",…}` | action 改名 |
| `permission.write` | **拒绝（抛错）** | 闸门保留并加固到 `patch` |
| — | `{action:"external_directory",resource:"*",effect:"ask"}` | 新增（v1 默认语义对齐） |
| `mcp: {<n>:{…}}` | `mcp: {servers: {<n>:{…}}}` | 嵌套 |
| `mcp.<n>.enabled: true` | `mcp.servers.<n>.disabled: false` | **极性反转** |
| `mcp.<n>.timeout: 30000` | `timeout: {startup,catalog,execution}` | 1 值→3 段 |
| MCP OAuth `clientId/callbackPort` | `client_id/callback_port` | snake_case |
| `plugin: [...]` | `plugins: [...]` | 仅改名 |

- 权限**规则顺序保留**：实测 v2 用 `findLast`（最后匹配胜出）⇒ v1 的 `.at(-1)` 语义要求 deny-then-allow 的顺序被完整保留。
- **`prompt` 键三道防线**：builder 输出白名单把它变成**构造期报错**、injector 迁移时把 `agents.<n>.prompt` 挪进 `system`、三条回归测试（builder 级 / 文件级 / 真 server 级）。

### ⭐ 它实测出的最重要一件事：**"无归一化诊断"这个硬闸门是必要但不充分的**

- **完全 v1 形的配置 → 0 条归一化诊断**。
- **半改名配置（v2 `agents:` + v1 `prompt` 键）→ 也 0 条诊断**，而角色提示被**静默丢弃**。
⇒ ⇒ **"没有诊断"这个闸门检测不出半改名**；只有**结构性回归测试**能检出来。⇒ 这正是把 `prompt` 守卫做成**测试 + 构造期报错**（而不是注释）的原因。
- 顺带纠正：v2 原生 `Config.AgentEncoded` 是 `additionalProperties:false`，**只列 `system`、不列 `prompt`**（`prompt` 只在 legacy `AgentConfig` 里）⇒ 结论比原判断更强。

### ⭐ 权限矩阵在 v2 下会**变宽**（已由平台 owner 拍板）

v2 规则集用 `findLast` 求值，且**每个 agent 的内置兜底以 `{action:"*",resource:"*",effect:"allow"}` 开头**，配置规则**追加在其后**。控制面只声明 `edit/read/bash/task`（`NATIVE_PERMISSION_KEYS`）+ vteam MCP 工具名 ⇒ **未声明动作（webfetch/glob/grep/todowrite/skill/websearch/全部 MCP 工具）一律放行**；v1 下它们落到引擎各自的 ask/deny 默认。

**决策（用户拍板）：接受 v2 的更宽松默认。** ⇒ 不加 catch-all ask、不加逐动作默认表；**但必须显式记录**，且仓库里不得继续断言旧的更严期望。已派 Agent Q 落实：MCP 探针修正 + 找齐所有编码权限期望的地方（`scripts/e2e-permission-matrix.sh`、`prove-authority-matrix.sh`、`e2e-third-party-no-policy-leak.sh`、server 测试、docs）逐处处理 + 在 doc 07 与 worker 翻译层留注释。

## P3 语义层已落地（Agent M）—— worker 1097 → **1129 tests**（+32）

**好消息：完成判定规则本身没被重写** —— 因为 v2 driver **合成**了 v1 兼容的 `step-finish` part（`finish` 取值实测 `stop`/`tool-calls`/`error`，与 v1 同名）。实际改动只有四处：在飞豁免集合、错误形状、合流缝、`state.output` 保持主形态。

| 语义 | v1 | v2（已落地） |
|---|---|---|
| 完成判定 | assistant 含 `step-finish(reason=stop)` | **同** ＋ 事件路 `session.execution.succeeded` 同等权威；**事件证据优先**；有界宽限期 |
| 首字 | 非空 text 或**任意** reasoning | **同**（轮询）＋ 事件路等价物 |
| 在飞工具豁免 | `{pending, running}` | `{running, streaming}`（**v2 无 `pending`**；`pending` 保留以免 v1 回退退化） |
| 文本聚合 | `text && !synthetic` 按 `time.start` 升序 | **同**（v2 `content[]` 本身有序 ⇒ 排序退化为"按消息时间 + 消息内原序"） |
| 错误抽取 | `{name,data:{message,statusCode}}` | **两代都认**：v2 形 `{type,message,status,response{body}}`；事件载荷优先；日志兜底 |

### ⭐ Q9 关闭（实测）：v2 里"占位文本污染回复"**结构性消失**

真 v2.0.28 实跑（无凭据 mock provider + 插件工具）逐字 dump assistant 消息：
- 调工具那条 assistant 消息的 `content[]` **只有 1 个 `type:'tool'` 项**，**没有任何文本占位**；最终消息只有 1 个 `type:'text'` 项。
- ⇒ v2 里工具调用**就是独立的 content 项**，与模型正文**结构上互斥** ⇒ v1 的污染路径**结构性死掉**。
- 且 **v1/v2 驱动都不设 `synthetic`**（实测 v1 dump 无此字段）—— 它是 vteam 侧给**注入块**（`[群聊历史消息]`/`<doclib>`）用的标记 ⇒ `!synthetic` 过滤**保留**（对驱动产出的 part 是空操作，对注入块仍然正确）。

### v2 错误形状（实测）：v1 的经典坑**在 v2 原样复现**

`{"type":"provider.auth","message":"Invalid API key.","status":401,"response":{"body":"…"}}`，且该消息**根本没有 `content` 数组**（= vteam 的 `parts=[]`）⇒ "凭据错 ⇒ parts 空、错误只在 `info.error`" 那个坑两代都有 ⇒ 该测试用例必须两代都保留。

### ⚠️ 它在实现中揪出并修掉的一个真 bug（"先问后记"不变式）

`RunTerminalGate.peek()` 返回的是 **"事件证据 ?? 轮询证据"** ⇒ 若**先** `notePolling` **再**问 `peek()`，门就无法区分"事件路还没说话"与"事件路说了成功" ⇒ **迟到的失败会被静默吞掉（失败被当成成功）**。
⇒ 不变式：**先问后记**；宽限期内也不许提前 `notePolling`。已写进代码注释 + 计划 D4/§8.2/T14 验收 7。

### 合流缝（`EventSignal`）与激活

`prompt-await.ts` **结构上不会发终态事件**，只做三件事：**先问门**（`peek`）→ **只记自己的证据**（`notePolling`，**不消费** 一次性 `settle()`）→ **有界宽限窗**（`eventGraceMs` 默认 500ms，仅在有事件信号时等待），让"轮询先到"与"事件先到"得到**同一结论**。另记 `terminalEvidence: 'event'|'polling'` + 分歧时打一条日志。
⚠️ **合流缝尚未激活**：T14 任务把 `worker/src/exec/**` 列为禁改区，所以 `exec-server.ts` 还没把每轮的 `RunTerminalGate` 交给 `sendAndAwait` → **"事件证据优先"与宽限期目前是休眠的**（生产行为未破：exec-server 侧既有的 `settle()` 已保证一次 run 一个终态事件）。已派 Agent N 接线 + 补 exec-server 级用例。

## part-id 单一真源已下沉（Agent L）—— 1097 tests

- **新增 `worker/src/driver/v2-part-id.ts`**：唯一真源。text `${M}:text` / reasoning `${M}:reasoning` / tool `${M}:tool:${callID}` / step-finish `${M}:step-finish`；同类第 k 个 → `${M}:${kind}:${k}`。
- `v2-driver.ts` 改用 `V2PartIdDeriver`；`v2-event-map.ts` **import 同一批 helper**（本地副本已删）→ 两路必然一致。
- **计数器按 kind 而非全局下标** —— 旧的全局下标会因"前面多了一个 tool 项"而漂移；按 kind 计数则 text 项的 id 不受其他 kind 影响。v2 的 `content[]` 只追加 ⇒ 同类第 k 个稳定。
- exec-server 的 `normalizeV2ContentIdList` **保留**为幂等兼容层（已统一的 id 原样返回；legacy `M:<数字>` 仍归一；v1 的 `prt_…` 原样透传）—— 若不幂等，`M:text:1` 会被误读成 legacy 下标而变成 `M:text:text`。
- 契约变更（可审计）：2 条既有断言更新（`msg_u1:0`→`msg_u1:text`；`['msg_a1:0','msg_a1:1','msg_a1:2',…]`→`['msg_a1:text','msg_a1:reasoning','msg_a1:tool:call_1','msg_a1:step-finish']`）。**无断言被削弱或删除**。
- 线上的细微变化：多同类项时后缀从"全局下标"变为"同类序号"；单 text/单 reasoning/单 tool（绝大多数）**id 逐字不变** ⇒ server 的 `mergePartsById` 契约不受影响。

## P3 设计定案（Agent J = worker 侧 / Agent K = server 侧）

- **vteam 事件名一个都不新增**（`message.part.delta` / `task.completed` / `agent.status` / `session.question` / `session.permission` / `session.updated` 已覆盖全部 v2 事件）。
- **不重命名 `message.part.delta`** —— 计划里提的重命名**取消**：v1 线已冻结待删、web 不消费这些事件（轮询 messages 表）、server 侧本就把它排除在 SSE 保留集外；改名的收益为零、churn 四个文件。
- **存储形态假设**：v1 存进 DB 的 `parts[]` 与 v2 驱动产出的 part **同形** ⇒ **零数据迁移、零 web 改动**（由 Agent K **验证**，不是假定）。
- 新增 `upstream?: {eventId, aggregateId?, seq?, ordinal?}` 随事件下发（worker 归一、server 消费）。

- 新增 `worker/src/driver/opencode-driver.ts`（接口 + 全部 vteam 自有类型 + `DriverRequestError` + `classifyDriverErrorStatus`）、`driver/index.ts`（工厂）、`driver/opencode-driver.conformance.ts`（**共享契约套件** + 双代假服务端）、三个 spec。
- `v1-driver.ts` 改为 `implements OpenCodeDriver`；**HTTP 路径/body/鉴权/超时逐字未动**；旧类型名保留为别名 → v1 spec 零改动仍绿。
- `exec-server.ts` **仅类型改动**（3 处 `V1Driver → OpenCodeDriver`）；`index.ts` 改用工厂。
- 模式感知闸门（`assertOpencodeVersionSupported(info, {mode})`）：
  | 模式 | major | 结论 |
  |---|---|---|
  | v2（默认） | ≥2 | 放行 |
  | v2 | 1 | fail-fast（文案沿用原有，测试不改仍绿） |
  | v1（`OPENCODE_V2_ENABLED=false`） | 1 | 放行（**回退路径真正可达**） |
  | v1 | ≠1 | fail-fast（提示回退镜像或切回 v2） |
  | 任意 | 认不出 | **只告警不判死** |
- 测试：874 → **914**（契约套件 15 + 边界守卫 5 + 工厂 10 + 模式闸门 6 + env 开关 4）。
- Agent G 诚实列出接口尚未表达的 7 点，其中**两点已处置**：
  1. **消息游标分页** —— v2 `GET /api/session/{id}/message` 是 `{data,cursor}` 分页，而接口只表达单页 → **T9 已在接口上加可选 `getMessages(sessionID, options?)`**（limit/order/cursor），v1 忽略（它无分页）。
  2. **v2 模式未注入 v2 driver 时静默回退 v1** —— ⚠️ **这是危险回退**：v1 的 legacy 路径在 v2 上**返回 200 + web SPA HTML**（不是 404），v1 驱动会把 HTML 当 JSON 解析 → 产出 undefined session id 且**毫无错误信号**。⇒ T9 已改为：v2 模式缺 v2 驱动 → **fail-fast**；并给 v1 驱动加**内容类型守卫**（拿到非 JSON 就抛明确错误，点破"v2 已移除 legacy 路由"这个坑）。
- 其余 5 点（todo 无 v2 端点 → 优雅降级返回 `[]`；agent/model 激活由 v2 驱动内部完成；`resolveRole` 不单列方法；vteam 主动发起的权限询问未建模；v2 权限 `source` 形状不同 → 透传）不阻塞，交由 T9/T14/T15 处置。

`exec-server.ts` + `index.ts` 对 driver 的**全部**依赖（16 处）：
`createSession` `sendMessage` `getMessages` `listQuestions` `replyQuestion` `rejectQuestion` `listPermissions` `replyPermission` `abort` `listAgents` `listTodos` `listModels` `isHealthy` + `baseUrl` + `authPassword`。

⇒ T8 的接口**沿用这些方法名**（`exec-server.ts` 只需换类型，不改调用点）——
"question" 是 **vteam 自己的领域词**（vteam 已有 `session.question` 事件与 `question_confirm` MCP 工具），不是 v1 的术语，**不改叫 v2 的 "form"**。

## ⚠️ P0 引入的一处内部矛盾（Agent G 处理中）

T1 的版本闸门是"major < 2 → fail-fast"，这让计划 §9.3 的 **v1 回退路径不可达**（worker 在切换生效前就死了）。
⇒ 闸门改为**模式感知**：v2 模式要求 major≥2；v1 模式（`OPENCODE_V2_ENABLED=false`）要求 major==1；版本认不出 → 只告警不判死（D2 既有对策）。

- **chart（Agent E）**：`OPENCODE_SERVER_PASSWORD` 进 chart Secret（`secret.yaml`），worker 容器 `secretKeyRef` 注入 `OPENCODE_SERVER_PASSWORD`，**server 容器从同一 key 注入 `SERVER_PASSWORD`**（否则 server→worker 会 401）。
  - **刻意不做** `secret.opencodeServerPassword` 明文旋钮 → 明文会进 values.yaml / helm 命令行；控制点是 `secret.existingSecret`。
  - 两个新 secretKeyRef 均 `optional: true` → 外部 Secret 缺该 key 时只影响 worker（以 worker 自己的可操作错误暴露），不会把 worker 侧配置问题升级成**全平台 Pod 起不来**。
  - `helm lint` 0 failed；`helm template` 3 变体（默认 / values-dev / existingSecret）+ ingress 开启变体均渲染通过、15 docs、无重复 env 名；`helm install --dry-run=client` NOTES 渲染正常。
- **compose（Agent F，处理中）**：worker 缺 `OPENCODE_SERVER_PASSWORD`、server 缺 `SERVER_PASSWORD` → v2 下 worker fail-fast + server 401。补齐中。
- **chart README（Agent F，处理中）**：Secret 表与 env 对齐清单遗漏新键。

## worker-protocol.ts 结论（Agent E）

`worker-protocol.ts` **只含类型契约，不含翻译代码** → `ModelCapabilities` 仍是 server→worker 的 camelCase **输入**形态，**未变、仍正确**；真正的翻译在 `model-credential-injector.ts` 的 `buildModelEntry` / `buildV2Capabilities`（已由 Agent B 改成 v2 输出形态）。故这是**过期注释，非运行时 bug** —— 只改了注释，类型零变更。

## 已确认的 v2 事实（实测，勿再重复验证）

- `opencode --version` → `opencode v2.0.28`
- `opencode serve --pure` → **exit 1**（v2 无此 flag）
- v2 banner：`server listening on http://HOST:PORT` + 新增 `server password <PASSWORD>`
- `OPENCODE_SERVER_PASSWORD` 在 v2 仍生效（Basic，username=`opencode`）；不设则自动生成随机密码打到 stdout
- **SSE 帧无 `event:` 行**（`grep -c "^event:"` = 0），事件类型只在 `data.type`；OpenAPI schema 声明的 `event` 必填与运行时不符
- v2 事件信封：`{id, created, type, location?, data, durable?:{aggregateID, seq, version}}`
- **agent 系统提示键 = `agents.<name>.system`**；`prompt` 的行为**取决于所在节**（v1 `agent:` 节 → 迁移为 `system`；v2 `agents:` 节 → 静默丢弃）—— 详见上方「⭐ 本轮最重要的新事实」
- `opencode mcp list --pure` → **exit 1**（响亮失败，不是静默）
- v2 配置归一化会丢弃 legacy 键，只发 `level=WARN ... message="configuration normalization diagnostic" path=$.… kind=unsupported action="omitted unsupported legacy setting"`
- v1 线已冻结：`opencode-ai@latest` = `@opencode-ai/sdk` = 1.19.3；v2 = `@opencode/cli` / `@opencode/sdk` = 2.0.32

## 待办提醒

- Agent A/B 正在改 `worker/` → 不要并行跑 worker 测试（竞态）
- T18（删 v1 driver）延后到 P5 之后，保留 v1 退路（计划 §9.3 已采纳）
- 锁版目标 `@opencode/cli@2.0.32`，但实测基线是 2.0.28 → T1 需产出**锁版版本的契约基线快照**并登记差异
