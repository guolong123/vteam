# `secret_command` 敏感命令工具：使用方式与安全边界

> 面向运维与接入方的操作说明。本文描述**已实现的行为**与**明确接受的残余风险**，
> 不是安全承诺：文中所有"脱敏""拦截"均为 best-effort 防顺手泄露，不构成安全边界。
> 涉及代码位置见文末「参考」，以仓库实际实现为准。
> 另见 §7.2：`secret_command` 与托管模式**解耦**，任何 agent 都能发起（密钥值仍只由用户输入）。

## 一、这个工具做什么

`secret_command` 是平台 MCP 的内置工具（对外暴露名 `vteam_secret_command`，服务端裸名
`secret_command`）：模型**不接触 secret 值**，只提交一条带占位符的命令模板与变量声明；
用户在聊天弹窗里填写值并确认；命令在 worker 上执行；模型最终只拿到

- 原始命令模板（**不是**渲染后的命令）、变量元数据（名称/标签/是否敏感/是否已填写）
- `status`、`exitCode`、`durationMs`、`timedOut`、`stdout`/`stderr`（已精确值脱敏 + 每流 32KB 截断）

设计目标：让需要密码 / Token 的操作（部署、镜像仓库、私有 API 调用等）可以由模型发起、
由人授权执行，同时让输入值不进入模型上下文、不落库、不回显、不广播。

## 二、三方职责

| 角色       | 职责                                                                                                | 不做什么                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 模型       | 提交命令模板 + `{{变量}}` 声明 + `reason`；解释返回的状态与脱敏输出                                 | 不提供值、看不到值、拿不到渲染后命令 / argv / cwd 明细               |
| 用户（人） | 在 Web 弹窗中核对只读模板与 reason，填写变量（敏感项为 password 输入框），确认或取消                | 不在聊天消息里粘贴 secret；取消即 `{secrets:null}`，命令不会执行     |
| worker     | token 保护的同步 `POST /secret-command`：变量替换、cwd 约束、进程组超时、精确值脱敏、截断后同步返回 | 不回传渲染命令 / argv / cwd / 未脱敏错误；不把 secret 写入日志或响应 |
| server     | 校验入参与归属、创建不回显的 `secret_input` 问题、阻塞等待、下发执行、二次脱敏、组装 envelope       | 不持久化 secret、不写 DB 审计表、不在 SSE / 日志里携带值             |

## 三、阻塞式人机交互流程（blocking human-in-the-loop）

```
模型 tools/call secret_command
   → server 校验（占位符↔变量双向一致 / 变量名唯一 / cwd 相对无 .. / timeoutSec 1..300 默认 60）
   → 归属解析（403/400）：teamId 为主，taskId 为可选归属标注，二者至少传一
   → （**无托管门**）：本工具与托管模式无关，任何 agent 都能发起
   → 创建 secret_input 平台问题（只落模板与变量元数据）
   → 用户填写 → server 阻塞等待（输入预算 540s）
   → 提供值 ⇒ 下发 worker POST /secret-command（X-Worker-Token）
   → worker 执行 + 进程组超时 + 脱敏 + 每流 32KB 截断
   → server 二次脱敏 → 返回 envelope（含 disposition / timeoutLayer）→ 模型继续
```

## 三之二、超时层次与处置规则（`is_0000000001` 问题 3 / 4）

一次阻塞调用串行穿过 6 层超时，**每层各有生效值，且「超时后服务端是否仍在跑」的语义
完全不同**。

层表的**真实来源是「两处自动 + 一处手抄」**，别再当「三处同源」：

| 位置                                   | 生成方式                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| 工具 description（模型可见）           | **自动**——`platform-mcp.tools.ts` 调 `layerBudgetTable()` 渲染 |
| `x-vteam-secret-command-budget` 响应头 | **自动**——`secretCommandBudgetHeaderValue()` 读同一批常量      |
| **本节下面这张 markdown 表**           | **手抄**——markdown 不会被 TS 渲染                              |

唯一口径是 `server/src/platform-mcp/platform-mcp.constants.ts` 的 `layerBudgetTable()`
与 `SECRET_COMMAND_TOTAL_BUDGET_MS` 等常量（改任一超时只改常量）。手抄这一处由
`platform-mcp.constants.spec.ts` 的「doc 层表与 `layerBudgetTable()` 逐行一致」断言钉住
（数值漂移即红）；**若两条不一致，以工具 description 与响应头为准**（那两个是自动的）。

| #   | 层               | 实际生效值                                        | 控制方                       | 超时后服务端可能仍在执行           |
| --- | ---------------- | ------------------------------------------------- | ---------------------------- | ---------------------------------- |
| 1   | `gateway`        | 由部署侧决定（平台不可控），须 ≥ 855s             | 网关/代理                    | **是**                             |
| 2   | `client_wait`    | opencode `mcp.vteam.timeout`（注入下限 900000ms） | 调用方客户端                 | **是**                             |
| 3   | `server_hold`    | 无硬超时；≤30s SSE 注释心跳保活                   | vteam-server                 | **是**                             |
| 4   | `input_budget`   | 540000ms（540s）                                  | vteam-server（questions 域） | 否（**唯一**服务端自己判定的超时） |
| 5   | `command_exec`   | `timeoutSec`，缺省 60s、上限 300s                 | 调用方入参 → worker          | 是                                 |
| 6   | `worker_request` | 命令超时 + 5000ms                                 | vteam-server → worker        | 是                                 |

优先级：**外层先于内层生效**。客户端/网关超时一旦小于服务端可控最坏预算
（`SECRET_COMMAND_SERVER_MAX_BUDGET_MS` = 540000 + 300000 + 5000 = 845000ms），就会先于
服务端终态掐断连接。

### 「-32001 Request timed out」是**假失败信号**（务必按下面的规则处理）

- 成因：`-32001` 是 **MCP SDK 客户端侧** `RequestTimeout`（层 2）。SDK 超时只**放弃等待**，
  **不关闭底层 HTTP 连接**，因此 server 的 `res.on('close')` 收不到断开信号 → 请求继续存活、
  用户填完值后命令照常执行，而调用方已拿到一个与事实相反的「失败」。
- 因此**超时 ≠ 失败**。判定口径：
  - 拿到 envelope → 看 `disposition`：`executed` = 已下发并跑完；`not_executed` = 服务端确定没跑。
  - 只拿到 -32001 / 409 → 属「可能仍在执行」态，**服务端无法主动告知**（结果无处可送）。
- **处置规则（禁止立即重发）**：
  1. 收到 -32001 或 409 后，**先复核目标状态**（命令副作用、落盘文件、远端凭据是否已生效）；
  2. 确认未执行再重试，否则会**重复执行**；
  3. 409 报文已带上一次在飞请求的实时状态（`requestId` / 阶段 / 已持续秒数 / 层次标识），
     按它判断是「仍在等待输入」还是「已在 worker 执行」；
  4. 调 `status` 层面的权威依据是**目标系统本身**（如 `gh auth status` 的退出码），
     不是本次工具调用的返回。
- 各层预算的自述入口：`POST /api/v1/platform-mcp` 的响应头
  `x-vteam-secret-command-budget`（`total` / `server_max` / `client_floor` / `input_budget` /
  `command_default` / `command_max` / `worker_slack` / `keepalive`）；503 错误 message 带
  `layer=i/n:<层名>` 标签。

关键时序与预算（服务端常量，单位 ms）：

| 项                 | 值                                   | 说明                                                                     |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| 输入预算           | 540000（540s）                       | 等待用户填写上限；超时 → `input_timeout`，pending 问题被取消，**不执行** |
| 命令超时           | `timeoutSec`，默认 60、上限 300      | worker 到点对**进程组** `SIGKILL`                                        |
| worker 执行超时    | `timeoutSec + 5000`                  | 计划强制要求，**不回落**到客户端默认 60s                                 |
| HTTP 请求超时      | 执行超时 + 5000                      | 请求恒晚于命令结束，避免调用被中途掐断                                   |
| 服务端可控最坏预算 | 540000 + 300000 + 5000 = 845000      | 客户端/网关超时必须 ≥ 本值                                               |
| 传输/编排裕量      | 10000                                | worker 调度、DB 往返、心跳首帧前空窗                                     |
| 总预算             | 845000 + 10000 = 855000（最坏 855s） | 注入的 MCP 客户端超时必须覆盖它（下限 900000）                           |
| keepalive          | 每 60000 重臂一次                    | 覆盖「等待 + 执行」两段，settle 即 `clearInterval`                       |
| 输出截断           | 每流 32768（32KB）                   | 采集额度 1MB；截断置 `stdoutTruncated` / `stderrTruncated`               |

其他确定语义：

- 用户取消（关闭弹窗 / Esc / `{secrets:null}`）→ `cancelled`，worker **零调用**。
- MCP 客户端**断开连接**（socket 真关）→ pending 问题被置为取消，**不产生幽灵执行**；
  但客户端**仅等待超时**不关连接，属上面的「假失败」态，不适用本条。
- 单会话单 in-flight：同一平台 Session 已有一次 `secret_command` 在等待或执行 → 409
  （`PLATFORM_MCP_SECRET_COMMAND_CONFLICT`，报文带上一次在飞请求的实时状态）。
- worker 端 `requestId` 幂等：同 `requestId` 且同归属返回既有结果，同 `requestId` 不同归属 409。

## 四、权限默认与关闭方式

**默认全角色可用**：能力点 `secret.command`（标签「执行敏感命令」，`defaultDeny:false`）在
fresh install（seed）与 upgrade（迁移）两条路径上对以下岗位都显式为 `true`：

- 7 个内置岗位（product / architect / developer / tester / project_manager / plan / librarian）
- 3 个外部引擎岗位（sisyphus / prometheus / atlas，即外部绑定的"访客式"执行者）
- 兜底岗位 `ar_general`（`general`）

授权链路有两道，**只有这两道**决定能否调用：

1. **`secret.command` 能力点**（server 侧调用时授权）：`AgentRole.capabilities` 中显式
   `false` ⇒ 403 `PLATFORM_MCP_TOOL_NOT_PERMITTED`；**缺失键 ⇒ 放行**（default-allow）。
2. **`toolAllows`**（worker guard 层② 工具白名单，`ROLE_BOUNDARIES` + 外部岗位 allowlist，
   源码常量）：7 个内置岗位显式 `allow`，外部岗位 allowlist 共 9 项含 `vteam_secret_command`。

运维如何关闭：

- **推荐**：管理台 → Agent 页 → 「角色」Tab → 能力编辑器（`role-capability-editor`）→
  找到「执行敏感命令 / `secret.command`」→ 切到「拒绝」→ 保存。因为是 default-allow，
  **必须显式写入 `false`**，留空/缺失等同放行。
- **代码级**：同时移除 `ROLE_BOUNDARIES[*].toolAllows` 与外部 allowlist 中的
  `vteam_secret_command`，并同步 seed 与迁移镜像，否则会出现 fresh / upgrade 行为分裂。

> `bash` permission **不会**拦截 `secret_command`。`permission.bash`（角色的 `bashEffect`）
> 只作用于 opencode 会话内的 `bash` 工具；`secret_command` 是平台 MCP 工具，走上面两道
> 自己的门。把 `permission.bash` 设为 `deny` **不会**让敏感命令工具失效，反之亦然。
> 能力门本身按设计只防"误调用"，`vteam-api` / `swagger-mcp` 两个同层 MCP 不受它约束。

## 五、安全边界（明确接受的限制）

以下是**已知且接受**的边界，任何一条都**不是**硬性安全保证：

1. **脱敏是 best-effort 精确值替换。** worker 在返回前、server 在出口前，各做一次对提交值的
   精确字符串替换（外加残留 `{{占位符}}` 掩码）。它只防输出里"顺手"打印了原值。
2. **无沙箱（no sandbox）。** 命令以 worker 进程身份执行，没有容器 / namespace / seccomp /
   ulimit / 只读文件系统隔离；命令能读到该用户可读的一切。
3. **无网络出口策略（no network egress policy）。** 不限制 DNS、不限制目标地址、不强制走
   代理；命令可以把数据发到任意可达地址。
4. **无命令白名单（no command allowlist / denylist）。** 模型可以提交任意命令，这是 MVP
   明确接受的风险；没有任何命令级过滤。
5. **变形 / 编码外传无法阻止。** 值若被命令输出以 base64、hex、URL 编码、分片拼接、
   大小写/异或等任何形式**变形**，精确值替换不会命中，模型会看到变形后的数据。
   平台**不声称**能阻止这类外传。

综合定位：本工具是**防顺手泄露**（防止 secret 被无意打印进模型上下文），**不是**访问控制
或数据外泄防护边界；把它当作"人机协作时少看一眼值"的卫生措施，不要当作保密机制。

## 六、示例调用（占位符，不含任何真实值）

```json
{
  "teamId": "<TEAM_ID>",
  "taskId": "<TASK_ID>",
  "selfInstanceId": "<INSTANCE_ID>",
  "command": "curl -fsS -H \"Authorization: Bearer {{REGISTRY_TOKEN}}\" https://registry.example.com/v2/<REPO>/tags/list",
  "variables": [
    {
      "name": "REGISTRY_TOKEN",
      "label": "镜像仓库访问 Token",
      "secret": true,
      "required": true
    }
  ],
  "cwd": "services/api",
  "timeoutSec": 60,
  "title": "查询私有镜像仓库标签",
  "reason": "需要拉取私有仓库 tag 列表以确认发布版本"
}
```

**归属维度（`teamId` 为主，`taskId` 可选）**：`secret_command` 挂在**团队**上，凭据类运维
（配 gh CLI、装依赖、登录 registry）**不必**为此挂一个业务任务。

- 团队直聊（无任务）：只传 `teamId` 即可。
- 任务内：可只传 `taskId`，或 `taskId` + `teamId` 同传（`taskId` 优先）。
- 两者都不传 → 400 / `-32602`。
- 两者互传错（`taskId` 填 `tm_` 前缀 / `teamId` 填 `t_` 前缀）→ 400，对称报错：
  - `taskId` 填团队 id → 400「团队会话请传 teamId，不要传 taskId（taskId 是任务 ID，t_ 前缀）」
  - `teamId` 填任务 id → 400「任务上下文请传 taskId，不要传 teamId（teamId 是团队 ID，tm_ 前缀）」

前缀与错误码分层：`t_` / `tm_` 填错是**入参错 → 400**；`teamId` 与该 worker 实际会话所属团队
不匹配是**归属错 → 403**（`PLATFORM_MCP_FORBIDDEN`）。两者不可混。

> **归属如何落地：无 schema 变更。** 改的是**工具入参**（zod schema 里 `teamId` 新增、
> `taskId` 降可选），不是数据库。`agent_questions` 表没有 `teamId` 列，`taskId` 仍是
> `NOT NULL` —— 团队归属一律经 `taskId` / `sessionId` **反查**得出（与本仓 questions 域既有
> 口径一致，见 `findAll` 的「teamId 经任务归属 + 会话归属双路实现，无 schema 变更」）。
> 团队直聊时 `taskId` 落空串，团队归属全靠 `sessionId` 承载。
>
> 由此带来一条前置条件：**团队必须已存在主 Agent 会话**。否则
> `createSecretForPlatform` 解析不到会话，直接 503 快速失败（不落占位行）——
> 早失败远好过创建一个永远送不到用户面前、让调用方空等满 540s 输入预算的行。

占位符语法：`{{NAME}}`（`NAME` 为 `[A-Za-z_][A-Za-z0-9_]*`，允许 `{{ name }}` 带空格）。
`secret:true` 的变量在弹窗中渲染为 password 输入框；模板与 reason 只读展示。
示例中的值一律写成占位符或 `<占位符>`，**不要**在文档、issue、日志中粘贴任何真实 secret。

## 七、返回给模型的 envelope

| 字段                                              | 内容                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `command`                                         | 原始模板（未渲染）                                                                    |
| `variables[]`                                     | 变量元数据 + `provided`（是否已填写），无值                                           |
| `status`                                          | `succeeded` / `failed` / `timeout`（worker）· `cancelled` / `input_timeout`（server） |
| `disposition`                                     | `executed`（已下发并跑完）/ `not_executed`（服务端确定没跑）——「跑没跑」的权威判定    |
| `timeoutLayer`                                    | 非成功终态的断点层（`input_budget` / `command_exec`），`succeeded` 恒 `null`          |
| `exitCode` / `signal` / `timedOut` / `durationMs` | 执行结果元数据                                                                        |
| `stdout` / `stderr` + `*Truncated`                | 脱敏 + 截断后的输出                                                                   |

不含：渲染后命令、argv、cwd、secret、未脱敏错误 message。错误码：入参非法
`PLATFORM_MCP_SECRET_COMMAND_INVALID`(400)、并发 409、归属不符 403、worker 不可用
`PLATFORM_MCP_SECRET_COMMAND_UNAVAILABLE`(503)。**无「托管模式」错误码**——本工具
不受托管拦截（见 §7.2）。

## 七之二、与托管模式的关系：**解耦，不受拦截**

> ⚠️ **本节描述 2026-09-29 用户决策后的行为。** 原先链路上有两道按「发起人是否为团队主
> Agent」放行的托管门，已**整块移除**。

**用户给出的理由**：

> 这类工具本身就需要用户强制输入密钥；托管模式开了之后，主 Agent 也决定不了用户会输什么。
> 托管的「交主 Agent 确认」语义对它不适用。

**因此 `secret_command` 的行为**：

| 事项                     | 行为                                            |
| ------------------------ | ----------------------------------------------- |
| 托管模式开/关            | **无差别**：两种状态下都可发起、都会弹窗        |
| 发起人是不是团队主 Agent | **无差别**：任何 agent 都能发起                 |
| 密钥值由谁提供           | **始终由用户**在弹窗输入（任何 agent 都拿不到） |

**恒弹窗的实现保证**：`secret_input` 的 DTO 恒 `managedMode=false`
（`questions.service.ts` 的 `toDto`），前端按 `!q.managedMode` 过滤后**必定弹窗**，
与团队托管状态无关。这条不变量由 `questions.service.spec.ts` 显式断言钉死。

### 托管语义**并未**整体失效

**请勿误读**：`managedMode=on` 对 `question` / `permission` 的
「**非主 Agent 的请求交主 Agent 确认**」语义**仍然有效**，其它工具不受影响。
**`secret_input` 是唯一的例外**——因为它的确认方是**用户**，不是主 Agent，
托管语义在这个环节本就无处施加。

### 这不是安全边界

移除托管门**不表示**本工具受身份保护。任何同团队 agent 都能让平台弹出一个
由它自撰命令模板的密钥输入框；**密钥值仍只能由用户本人输入，agent 拿不到。**
本文开头的「非安全承诺 / best-effort / 不构成安全边界」总声明同样适用于本节。

## 八、运维注意事项与残余风险

### 8.0 运维前置条件（不满足会静默降级，必须在部署侧保证）

本工具有三处**进程内状态**（无分布式锁），`server` 副本数一旦 > 1 就会失效：

| 前置条件                                 | 不满足时的后果                                                                                                                                                                                                                        | 为什么必须同副本                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **`server` 副本必须为 1**                | ①`secret_command` 单会话 in-flight 门（进程内 `Map`）失效 ⇒ 并发第二次不再被拦成 409，可重复执行<br>②`secret_command` 保持的 token 生命周期计数（`SECRET_COMMAND_TIMEOUT_LAYER` 各层计时）按各副本分别计，跨副本的等待/取消判定不一致 | 门与计时器都是**进程内**结构，跨副本不可见                      |
| **扩容须按 `sessionId` 粘性路由**        | 同一会话的请求被路由到不同副本 ⇒ 上面的门与计时器在不同副本各判一次                                                                                                                                                                   | 粘性路由让「同一会话 ⇒ 同一副本」成立，是多副本下唯一可行的近似 |
| **SSE 长连接与 ≤30s 心跳同样依赖同副本** | 连接 A 在副本 1、后续帧/心跳由副本 2 判定 ⇒ 丢心跳、连接被回收。**扩容会同时丢心跳与 in-flight，不只是丢 409**                                                                                                                        | SSE 连接与心跳定时器都在**单副本**内维护                        |

> 换言之：把 `server` 扩到多副本需要三件事一起做——粘性路由 + 把 in-flight 门外置（Redis 等）
>
> - 心跳/长连接跨副本可共享。当前实现**只支持单副本**；扩容前请按上述三件一并规划。

### 8.1 残余风险

- **worker 镜像的 opencode CLI 未 pin。** `worker/Dockerfile` 默认 `ARG OPENCODE_CLI_SPEC=opencode-ai`，
  每次构建取 npm 最新版；需要可复现构建时显式传
  `--build-arg OPENCODE_CLI_SPEC=opencode-ai@<version>`，否则 CLI 行为随上游漂移。
- **MCP timeout 是注入时显式保证的。** worker 注入 vteam 远端 MCP 条目时硬编码
  `timeout >= 900000`（覆盖 855s 最坏总预算），不依赖 OpenCode 客户端默认值，也不需要 DB
  迁移（`mcp_servers` 无 timeout 列）。环境变量 `VTEAM_MCP_TIMEOUT_MS` 可覆盖，但一律
  **clamp 到 ≥900000**：缺失、空串、非十进制整数、非正数都直接取下限，较小值被抬到下限。
  该下限与 server 侧 `SECRET_COMMAND_CLIENT_TIMEOUT_FLOOR_MS` 必须同值（跨包各持一份，
  由 `platform-mcp.service.spec.ts` 的跨包契约测试锁死漂移）。
- **客户端等待超时不取消服务端请求。** 见「三之二」：这是 `-32001` 假失败的根因，
  平台侧**无法**消除（SDK 不关连接），只能靠契约约束调用方「先复核、禁重发」。
- **in-flight 门是进程内的。** 单会话单 in-flight 用的是 server 进程内的 `Map`，不是分布式
  锁；server 多副本部署时，跨副本的并发第二调用不保证被拦成 409。
- **执行已下发后取消不追回。** abort 信号只在「拿到值」与「下发执行」之间检查；命令一旦
  发往 worker，客户端断开 / abort **不会**取消正在执行的命令，它会跑完或到超时被 worker
  的进程组超时杀掉，结果随后被丢弃。
- **强制杀死 worker 可能遗留孤儿子进程。** 敏感命令子进程 `detached` 自成进程组，正常路径
  由 worker 对进程组 `SIGKILL`；若 worker 进程本身被强杀（`kill -9`、容器 OOM/重启），
  正在运行的子进程不会收到信号，可能成为孤儿进程，需要外部清理（`pkill -g` / 重启容器）。
- **无 secret 持久化。** 值只存在于 handler 栈帧与 worker 请求体的内存中；question 只持久化
  模板 + 变量元数据 + `{provided, filled, actorType, actorId}`；不进 `answers`、SSE、日志、
  工具结果或 opencode session store；无 secret vault、无轮换、无跨调用复用。
- **无 DB 审计表。** 为 secret 不新增任何表 / 列 / 迁移，执行记录只体现在模型可见的工具卡
  与服务端结构化日志（日志只含 taskId / session / status / exitCode / durationMs）。
- **仓库卫生。** `.omo/evidence/**`、`.omo/plans/**`、`.omo/ulw-execute/**` 等执行态与证据
  文件一律不入库；文档与提交中只允许出现占位符，不允许出现任何真实或 sentinel 值。

## 九、参考

- 能力点目录：`server/src/common/constants/platform-capability.constants.ts`（`secret.command`）
- 全角色开放与 `toolAllows`：`server/src/common/constants/agent.constants.ts`、
  `server/src/common/constants/agent-role.constants.ts`、`server/prisma/seed.ts`
- 调用时授权门：`server/src/platform-mcp/platform-tool-permission.service.ts`
- 阻塞处理器与预算：`server/src/platform-mcp/platform-mcp.service.ts`、
  `server/src/platform-mcp/platform-mcp.constants.ts`
- 不回显问题生命周期：`server/src/questions/questions.service.ts`（`createSecretForPlatform`）
- worker 执行与脱敏：`worker/src/exec/sensitive-command.ts`、`worker/src/exec/exec-server.ts`
- MCP timeout 注入：`worker/src/resources/injector.ts`（`VTEAM_MCP_TIMEOUT_FLOOR_MS`）
- 关闭入口 UI：`web/src/components/agents/RoleCapabilityEditor.tsx`
- 计划与范围：`.omo/plans/sensitive-command-tool.md`（Scope / Must NOT have）
