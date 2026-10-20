# OpenCode v2 迁移验证报告（T21）

> 计划：`.omo/plans/opencode-v2-adaptation.md`（T21 契约测试 + 端到端验证）
> 分支：`feat/opencode-v2-adaptation`；被驱动端：**真实 `opencode v2.0.28` 二进制**
> 日期：2026-10-20
>
> 本报告只回答三件事：**什么被证明了** / **什么只对着 mock 证明了** / **什么根本没证明**。
> 每条断言都给出复现命令。

---

## 0. 结论速览

| 层 | 结论 |
|---|---|
| 双写协议副本（worker ↔ server） | **已钉死**：源码级逐字段对照 + 编译期类型恒等 + 运行时 wire 键集断言（两侧都做） |
| 真栈任务闭环 | **已证明**（真 v2.0.28 + 真 V2Driver + 真 worker 执行端点 + 零凭据 mock provider） |
| vteam 事件序列 / 终态唯一性 | **已证明**（字面顺序见 §2.3；一轮恰好 1 条 `task.completed`） |
| 角色提示进模型请求 | **已证明**（mock provider 记录了最终模型请求，system 段首行即角色提示） |
| 在飞 `delivery:"steer"` | **已证明**（被受理 + 注入内容真的进了下一轮模型请求 + 不产生第二个终态事件） |
| 四个 e2e 证明脚本 | **形状逻辑已验证**（24/24，含 18 条漂移反例 ⇒ 检查器不空过）；**活栈断言未跑**（本环境无活栈） |
| 灰度 / 回滚 / 数据卷回退 | **未验证**（T22 并行推进，不在本任务范围） |
| 发现的缺陷 | **1 条**（F1，见 §6.1）：在禁改区，**未修**，已记录 |

---

## 1. 三桶：证明 / 只对 mock / 没证明

### 1.1 被**真实 opencode v2 二进制**证明的

以下每条都在真 `opencode v2.0.28`（`/Users/mac/.opencode/bin/opencode`）上跑过，
模型由仓库内的**无凭据** mock provider 应答（无凭据、无额度、无外网）：

1. **worker 能用隔离配置域拉起真 serve**：`resolveIsolationScope`/`ensureIsolationScope`
   产出的 `HOME`/`XDG_*` 生效，宿主机全局配置/凭据不在作用域内；
   `OpencodeServer` 的 banner 解析、Basic 鉴权、`/api/info` 健康探针、进程组回收全部走通。
2. **五个新端点在真 serve 上可用**（控制面 → worker 执行端点 → v2）：
   `POST /sessions` → 200 `{sessionId:"ses_…"}`；`POST /sessions/:id/prompt` → 200
   `{sessionId, admitted:true, messageId, delivery}`；`POST /sessions/:id/abort` → 200
   `{sessionId, interrupted:false}`（幂等）；`GET /sessions/:id/messages?limit&order` → 200
   `{sessionId, messages[]}`；`GET /models` → 200 `{models:[{id:"vteam-mock/vteam-model",…}]}`。
3. **完整任务闭环**：建会话 → 下发提示 → 首字（流式增量）→ 终态 → 控制面形状的结果
   （`task.completed` 带 `text`/`parts`/`model`/`tokens`/`cost`）。
4. **vteam 事件序列**（字面顺序）与**终态唯一性**：`session.updated(running)` →
   `agent.status(loading)` → `message.part.delta`×N → `session.updated(idle)` →
   `task.completed`，**一轮恰好 1 条** `task.completed`。
5. **角色提示真的进了最终模型请求**：`agents.<name>.system` 的内容出现在模型请求的
   **system 段首行**（mock provider 记录，见 §2.5）。
6. **平台工具产物真的被投放给模型**：模型请求的 `tools[]` 里含由**真实 worker builder**
   （`renderCustomToolPlugin`）渲染出的插件工具 `vteam-slow-probe`
   ⇒ `options:{codemode:false}` 生效（工具是**直接**工具，不在 Code Mode 目录里）。
7. **事件带上上游身份**：`message.part.delta` 的 payload 含
   `upstream:{eventId, aggregateId, seq, ordinal}` ⇒ D4 的幂等键在真帧上成立。
8. **v2 driver 合成的 `step-finish` 落在终态事件里**：`task.completed.parts` 含
   `{type:'step-finish', reason:'stop', cost, tokens}` ⇒ 控制面的「本轮完成」幂等键
   在 v2 路径上**存在**（不丢）。
9. **在飞注入**：`delivery:"steer"` 的提示被受理（`admitted:true`），注入文本**真的**
   出现在该会话**下一轮**模型请求的 user 段（证明它被在飞 run 消化，而不是排队饿死），
   且**没有**第二个终态事件。
10. **逐消息 system blob 的当前口径**：落在 **user 段**（v2 的 prompt body 无 `system`
    字段 ⇒ 文本前缀兜底）。这是**已知语义降级**（计划 D6 兜底 (d)），本次顺带查出
    「不重复注入闸门」失效（§6.1 F1）。

### 1.2 只对着 **mock** 证明的（真实二进制**没有**覆盖）

1. **模型本身是 mock**：`mock-provider.mjs` 只会回 `MOCK_OK` 或一次工具调用 ⇒
   **没有**证明任何真实模型的行为（质量、延迟、长上下文、真实 token 计费、
   真实 provider 的鉴权/限流行为）。
2. **服务端去重/落库链**：`durable.seq` 的幂等、`normalizeParts` 的存储形态边界、
   `task.completed` 落库 ⇒ 只有**单测**覆盖（server jest），本环境**没有**真 DB。
3. **控制面 ingress**：`message.part.delta` → part 合并 → `Message.content` 落库
   ⇒ 本环境**未**跑（需要活栈）。
4. **MCP 工具 / 平台 MCP 权限门**：`vteam_*` 工具的授权裁决 ⇒ 只有单测覆盖。
5. **权限矩阵**：`permissions[]` 的**引擎侧**求值（`findLast`）在本环境**没有**被真
   引擎逐条验证（本次只验证了「注入形状」与「脚本的形状断言逻辑」）。

### 1.3 根本没证明的（必须在 rollout 环境补）

1. **四个 e2e 证明脚本的活栈断言**（`e2e-permission-matrix.sh`、
   `e2e-third-party-no-policy-leak.sh`、`e2e-role-boundaries.sh`、
   `e2e-native-edit-enforcement.sh`）：它们要真 server + 部署好的 worker + 容器 + DB
   （`docker compose exec` 读 server 的编译产物、MySQL 查库、真 MCP 调用）。
   本环境**没有**活栈 ⇒ **一条都没跑**。本次只验证了它们的**形状逻辑**（§4）。
2. **helm 灰度与回滚**（T22 并行推进）：版本闸门在混跑期的行为、镜像回退、
   **数据卷回退**（v2 启动时已就地迁移 `opencode.db`，v1 CLI 读不了 ⇒ 回滚必须连
   数据卷一起回）。
3. **OmO 的 v2 插件入口**：仍是缺口（v1 插件实现在 v2 跑不起来），本次未触碰。
4. **受管配置目录残留**（`/etc/opencode`、`/Library/Application Support/opencode`）：
   不受 XDG 控制 ⇒ 隔离方案**不是** 100% 等价于 `--pure`。
5. **权限默认放宽**（doc 07 §3.2）：v2 的 `findLast` + 内置 catch-all allow ⇒ 未声明
   动作一律放行。平台**已接受**该放宽（不加 catch-all ask），本次未改。

---

## 2. 真栈冒烟：怎么跑的、看到了什么

### 2.1 怎么跑的

新增用例：`worker/src/exec/v2-realstack-smoke.spec.ts`（**默认跳过**，需显式开关）：

- 开关：`VTEAM_REALSTACK_SMOKE=1`（不设置则整组 `describe.skip` ⇒ CI 没装二进制也
  不会把构建打红；跳过时会有一条显式标记，不静默跳过）。
- 证据留存（可选）：`VTEAM_REALSTACK_EVIDENCE_DIR=<dir>` ⇒ 落
  `requests.jsonl`（模型请求记录）与 `events.json`（worker 上送事件）。
- 组成：
  1. **mock provider**：`docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs`
     （仓库既有资产，复用；它把**每一次**模型请求记成 JSONL）。
  2. **真 serve**：`OpencodeServer`（worker 自己的 spawn 路径）用
     `resolveIsolationScope`/`ensureIsolationScope` 给的隔离域起 `opencode serve`，
     端口 0（随机）、密码 `OPENCODE_SERVER_PASSWORD`。
  3. **真驱动 + 真端点**：`V2Driver`（baseUrl 指向上面的 serve）+ `ExecServer`
     （worker 的执行端点，X-Worker-Token 鉴权）+ 真 `EventSender`（注入 fetchImpl
     收集事件，事件体就是控制面会收到的 `WorkerEventPayload`）。
  4. **项目配置**：mock provider 段 + 一个带 `agents.vteam-role.system` 的角色 agent；
     平台工具产物由**真实 builder** 渲染（慢探针：执行体睡 5s ⇒ 制造稳定的在飞窗口）。

### 2.2 断言清单（全部通过）

- 建会话返回 `ses_` 前缀 id；提示被受理；消息可读；abort 幂等 200；模型目录含
  `vteam-mock/vteam-model`。
- 事件序列：`session.updated(running)` → `message.part.delta`（≥1）→
  `task.completed`，且 `task.completed` **恰好 1 条**。
- `task.completed` 的载荷含 `text='MOCK_OK'`、`parts[]`（含合成的 `step-finish`）、
  `model='vteam-mock/vteam-model'`、`sessionId`/`taskId` 回传。
- 模型请求的 `system` 段含角色提示标记；`tools[]` 含平台工具产物。
- 在飞注入：`admitted:true` + 注入文本进下一轮 user 段 + 终态事件恰好 1 条。

### 2.3 观察到的 vteam 事件序列（字面顺序）

第一轮（主闭环，worker 上送顺序）：

    session.updated(status=running)
    agent.status(status=loading, phase=thinking)
    session.updated(running)        ← SSE 事件路的状态回灌
    session.updated(running)
    session.updated(status=absent)  ← 上游事件映射出的无 status 形态
    session.updated(status=absent)
    message.part.delta ×3           ← 首字/流式增量（带 upstream 身份）
    session.updated(status=idle)
    task.completed(text="MOCK_OK", parts=2, model="vteam-mock/vteam-model")

第二轮（在飞注入那一轮）：

    session.updated(running) → agent.status(loading) → session.updated×N
    → message.part.delta ×8 → session.updated(idle) → task.completed

**终态事件计数**：全程 `task.completed` 共 **2** 条（每轮 1 条）；在飞注入那一轮
**没有**多出第二条 ⇒ 「一次 run 只发一个终态事件」在真栈上成立。

### 2.4 在飞 `delivery:"steer"` 的观察

1. `/execute` 起一轮（提示要求调用慢探针 ⇒ 工具执行 5s ⇒ 稳定的在飞窗口）；
2. 确认模型请求已发出（mock provider 记录到该轮请求）⇒ 此刻这一轮**确定在飞**；
3. `POST /sessions/:id/prompt` 带 `delivery:"steer"` → **200**，`admitted:true`，
   `delivery:"steer"`；
4. 该会话**下一轮**模型请求的 user 段 = 原提示 + 注入文本（`T21 在飞注入：补充指令`）
   ⇒ 注入**被在飞 run 消化**；
5. 该轮终态事件 **1** 条 ⇒ 注入**不产生第二个终态事件**。

### 2.5 模型请求证据（角色提示 + tools[]）

mock provider 记录的最终模型请求（主闭环那一轮，节选）：

- `system` 段首行：`ROLE_PROMPT_MARKER_VTEAM_T21`（= 配置里的 `agents.vteam-role.system`）
  ⇒ **角色提示进了模型请求的 system 段**（前置在 opencode 内置 system 段之前）。
- `user` 段：`PER_MESSAGE_BLOB_MARKER_VTEAM_T21` + 正文 ⇒ 逐消息 blob 落在
  **user 段**（已知降级；顺带暴露 §6.1 的 F1）。
- `tools[]`（13 个）：`edit, glob, grep, question, read, shell, skill, subagent,
  **vteam-slow-probe**, webfetch, websearch, write, execute`
  ⇒ 平台生成的插件工具**直接**出现在 `tools[]`（`options:{codemode:false}` 生效）。

---

## 3. 契约缺口：worker ↔ server 的双写副本

**缺口**：五个新端点的协议类型在仓库里是**双写**的
（worker 侧 `worker/src/protocol/worker-protocol.ts`、
server 侧 `server/src/workers/worker-session-protocol.ts`），迁移前**没有任何断言**
说这两份必须一致。

**补上的三层断言**：

| 层 | 位置 | 断言 |
|---|---|---|
| 源码级（逐字段） | `worker/src/protocol/contract.spec.ts` | 用 TS 编译器 API 抽出两侧同名 interface 的成员（**成员名 + 是否可选 + 类型文本**）并逐项相等；两侧成员数相等；manifest 与两侧的键集/可选性一致 |
| 编译期（类型恒等） | `server/src/workers/worker.client.spec.ts` | 两侧 8 个类型逐对 `Equals<>`（任一字段漂移 ⇒ **编译失败**） |
| 运行时（wire 键集） | 两侧各一组 | worker 侧：起**真实** `ExecServer`，断言「server 发的 body 键 == worker 解析后交给驱动的键」「worker 回的 body 键 == server 读的键」；server 侧：断言客户端实际发出的 body/query 键集与实际读取的响应键集，并加**反向**断言（拼错的键名不被读取 ⇒ 漂移会立刻暴露） |

**为什么源码级对照是必须的**：server 包的 tsconfig 是 `strictNullChecks: false`
⇒ 「可选 vs 必填」的差异在类型层**看不出来**（`undefined` 到处可赋）⇒ 只有源码级
抽取能看见 `?`。

**变异测试（证明断言不是摆设）**：
- 把 server 侧副本的 `delivery?` 改成 `delivery` ⇒ worker 侧「逐字段一致」「manifest
  一致」两条**立刻失败**；
- 把 worker 侧副本的 `SessionAbortResponsePayload` 加一个字段 ⇒ server 侧**编译失败**
  （`TS2344: Type 'false' does not satisfy the constraint 'true'`）。
两次变异都已回滚（工作树已复原）。

**顺带发现的契约小口**：`GET /models` 的**信封** `{models: [...]}` 不在双写类型里
（双写的 `WorkerModelInfo` 是**条目**类型）⇒ 该信封只能在运行时断言（两侧都加了），
已记在本报告 §6.2。

---

## 4. 四个 e2e 证明脚本：形状逻辑已验证 / 活栈未跑

新增：`scripts/e2e-v2-shape-logic-check.sh` + `scripts/e2e-v2-shape-fixture.ts`。

- **夹具不是手搓的**：用**真实 worker 注入器**（`ResourceInjector.applyMcpAndAgents`）
  写出一份 v2 形注入配置（`agents` 节 + `permissions[]` 有序数组 + `mcp.servers` +
  `plugins`），策略来自**真实控制面常量**（`resolveBuiltinPolicy` +
  `projectNativePermission`，与 `buildAgentPolicies()` 无 DB 行时同形）。
- **python 是从脚本里抽出来的**（不是重新实现）⇒ 脚本改了这里跟着改。
- **正例 6 条**（正确形状 ⇒ 全通过）+ **反例 18 条**（13 种漂移夹具 ⇒ 检查器必须
  **响亮失败**，证明它们不是空过）：v1 `agent` 段 / 无 `agents` 段 / `vteam_` 动作 /
  残留 v1 `bash` / `edit` 的 `*` 翻成 allow / edit 规则不是 deny-then-allow / 缺
  `external_directory` / 出现 v2 不存在的 `write` / 少一个内置角色 / 缺 `subagent` /
  外部名字进 agent 名槽位 / 段缺失（拒绝空过，退出码 2）/ 探针不在 edit 规则里。
- 结果：**24/24 通过**（6 正例 + 18 反例）。

> ⚠️ **明确边界**：这只证明四个脚本的**形状读取 + 形状断言**这一层。
> 它们的**活栈断言**（真 server / 真 worker 容器 / 真 DB / 真 MCP 调用 / DB 策略编辑
> 与回滚 / 权限矩阵真门裁决）**在本环境一条都没跑**，必须在 rollout 环境跑原脚本。

---

## 5. 复现命令（逐层）

| 层 | 命令 | 期望 |
|---|---|---|
| worker 类型 | `cd worker && npm run typecheck` | exit 0 |
| worker 全量 | `cd worker && npm test` | 39 suites；1170 tests（默认 1165 通过 + 5 跳过） |
| worker 真栈冒烟 | `cd worker && VTEAM_REALSTACK_SMOKE=1 npx jest src/exec/v2-realstack-smoke.spec.ts --runInBand` | 5/5 通过（需真二进制） |
| worker 真栈证据留存 | `cd worker && VTEAM_REALSTACK_SMOKE=1 VTEAM_REALSTACK_EVIDENCE_DIR=/tmp/t21-evidence npx jest src/exec/v2-realstack-smoke.spec.ts --runInBand` | 落 `requests.jsonl` + `events.json` |
| server 类型 | `cd server && npx tsc --noEmit -p tsconfig.build.json` | exit 0 |
| server lint | `cd server && npm run lint:check` | 0 error（67 条存量 warning） |
| server 全量 | `cd server && npx jest --runInBand` | 180 suites / 4365 tests 全通过 |
| web 类型 | `cd web && npx tsc --noEmit` | exit 0 |
| e2e 形状逻辑 | `bash scripts/e2e-v2-shape-logic-check.sh` | 24/24（6 正例 + 18 反例） |
| 四个活栈 e2e（rollout 环境） | `bash scripts/e2e-permission-matrix.sh` 等四个 | **本环境未跑** |

---

## 6. 发现的问题与「已接受不修」的限制

### 6.1 F1（发现，**未修**，在禁改区）：「不重复注入闸门」恒不触发

- **现象**：worker 驱动在激活 agent 后，仍把**逐消息 system blob** 拼进正文
  （user 段），即使该 agent 已配置 `agents.<name>.system`（那段已经在 system 段里）。
- **根因（实测）**：`worker/src/driver/v2-driver.ts` 的 `resolveAgentSystem()` 用
  `GET /api/agent`（**不带** location）查 agent 的配置化 `system`；而真 v2.0.28 上
  **不带 location 的 `GET /api/agent` 返回空数组**（带
  `location[directory]=<deepObject>` 才返回该 location 的 agent 列表）。
  ⇒ 闸门恒判「无配置化 system」⇒ blob 永远被拼进正文。
- **实测证据**：独立探针（真二进制、隔离域）——
  `GET /api/agent` → `{"location":{…},"data":[]}`；
  `GET /api/agent?location[directory]=<proj>` → 7 个 agent（含项目角色）。
  真栈冒烟记录的模型请求：system 段首行是角色提示、user 段首行是 blob ⇒ 两者同时在场。
- **影响面**：控制面目前**还没**填 `agents.<n>.system`（T15 把它列为可选、属后续任务）
  ⇒ 闸门的**前提**目前很少成立 ⇒ 线上影响有限；一旦开始填静态角色提示，
  同一段提示就会在 system 段与 user 段各出现一次（正是该不变式要避免的）。
- **最小修复（本次未做，文件在禁改区）**：让 `resolveAgentSystem()` 复用
  `listAgents()` 已有的 location 作用域查询（`location[directory]=` + 驱动实例的
  `directory`），并把「查不到 ⇒ 视为无配置化 system」的兜底保留。
- **为什么本次没修**：`worker/src/driver/**` 在本任务的禁改区内；且本任务是**验证**
  任务，不改生产行为。已把该缺陷写进真栈冒烟用例的注释与本节。

### 6.2 已接受、**不修**的限制（迁移计划已记录）

1. **权限放宽**（doc 07 §3.2）：v2 的 `findLast` + 每个 agent 内置 catch-all allow
   ⇒ 未声明动作（webfetch/glob/grep/todowrite/skill/websearch/全部 MCP 工具）一律
   放行。平台**已拍板接受**（不加 catch-all ask、不加逐动作默认表）。
   ⇒ 仓库里不得继续断言旧的更严期望。
2. **逐消息 `system` blob 仍落在 user 段**：v2 的 prompt body 无 `system` 字段
   ⇒ 当前是文本前缀兜底（进 user 段、优先级低于 system 段）。
   正解是插件 `ctx.session.hook("context")`（T4 已实测逐消息生效），本轮**不实现**。
   （另见 §6.1 F1：连「已配置静态 system 时不重复拼」的闸门都没生效。）
3. **OmO 的 v2 插件入口缺口**：v1 插件实现在 v2 跑不起来；隔离后失效；本轮未触碰。
4. **受管配置目录残留**：`/etc/opencode`、`/Library/Application Support/opencode`
   不受 XDG 控制 ⇒ 隔离方案不是 100% 等价于 `--pure`（只有 `policies` 能压制）。
5. **`GET /models` 的信封不在双写类型里**：双写类型描述的是**条目**
   （`WorkerModelInfo`），信封 `{models:[…]}` 只在运行时断言（§3 末段）。

---

## 7. 计数与基线对照

| 套件 | 迁移基线（本次之前） | 本次之后 | 失败 |
|---|---|---|---|
| worker jest | 1156 | **1170**（1165 通过 + 5 跳过；带 `VTEAM_REALSTACK_SMOKE=1` 时 1170 全通过） | 0 |
| worker typecheck | exit 0 | exit 0 | — |
| server jest | 4359 | **4365** | 0 |
| server tsc（build 配置） | exit 0 | exit 0 | — |
| server lint:check | 0 error | 0 error（67 条存量 warning） | — |
| web tsc | exit 0 | exit 0 | — |
| e2e 形状逻辑（新增） | — | 24/24 | 0 |

增量来源：worker +9（契约一致性：逐字段 / 成员数 / manifest / 6 条运行时对称）、
worker +5（真栈冒烟，默认跳过）、server +6（类型恒等 + 5 条 wire 键集断言）。

> 基线里那条**存量失败**（`server/src/platform-mcp/platform-mcp.tool-permission.spec.ts`
> 的 407 Proxy Authentication Required）**本次未复现**（180/180 suites 全通过）——
> 它是环境相关的（真上游 MCP 代理路径），不是本次引入的。
