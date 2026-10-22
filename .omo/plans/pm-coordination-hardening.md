# pm-coordination-hardening — 项目经理「只协调不执行」的机制化改造

> 状态：**执行中**（分批提交，每批一个 PR）
> 起因：用户报告「项目经理总是去直接干活」；线上 `tm_0000000001` 的主 Agent 就是 PM（`tmm_0000000002`），协调通道未被封，但 PM 的能力矩阵 31 项**零个 false**，且平台主动教它执行。
> 硬约束（用户决定）：**本轮不做任何权限收窄**（PM 能力矩阵 / bash / 能力点 false 化一律不碰），避免引入新问题。

## Scope

### Must have

1. **派发通道语义可观测**：`notify_agent` 的返回值必须能区分「消息落库」与「目标真的开工」，并带目标会话状态。
2. **派发更正通道**：同目标在途时的**补充/更正**不得被 dedup 吞掉（新增一等 `supersede` 语义，而非复用 `force`）。
3. **通道死锁可解**：`no-active-task` 时给出可执行的下一跳（自动改走 taskId 通道 / hint 带真实 taskId），不得把用户指向不可达状态。
4. **回执销账与催办分级**：群聊/产出物**显式引用原派发 messageId** 即销账（= agent 现在自发在做的事，平台化）；`question` 被主 Agent 应答后自动结账；催办文案区分「未开工 / 已交付未销账 / 回执未送达」。
5. **工具契约自描述**：409 状态机错误体带合法迁移表；`notify_agent` 的 `force`/`forceReason`/`type`/`stage` 形状写进工具描述。
6. **纪律落点**：PM 的「主动委派 / 串行派活 / 做完即停」写进**岗位权威源**（`agent_roles.role_prompt`）+ 平台级【职责边界】段，**并用 migration 回填存量**。
7. **零收窄安全修**：中性化路径**保留**上次受管块而非删除（权限既不收窄也不放大）；新增能力点必须同 PR 全表回填 + 往返断言。
8. **协调度指标**：PM 产出物数 / PM 消息占比 / 派发 vs 亲做 / 群聊私聊双报率。
9. **仓库卫生**：`.omo/evidence/**/*.json` 进 `.gitignore`（跑测试不再弄脏工作区）。

### Must NOT have

- **不得收窄任何岗位的能力矩阵**（含 PM）、不得改 `bash` 效果、不得把任何能力点置 `false`。
- 不得删除/放宽 `notify_agent` 的既有门禁（self-notify 403、非主→非主 403、去重、配额、计划哈希门、工单锁）——本轮只**加**语义与**加**出口。
- 不得改 `assignWorker` 四道过滤、不得改 prisma schema 的既有表结构（只允许新增 migration 回填 `agent_roles.role_prompt` / `execution_policies.config`）。
- 不得动 `web/` 的既有交互（本轮 UI 只读指标除外）。
- 不得 `git commit`（由编排者统一提交）；不得 `git stash` / `checkout` / `reset`。
- 不得把「平台行为修复」塞进「提示词调整」批次（两类改动必须分属不同 PR）。

## Execution strategy — 三波，批内并行

| 波 | 批次 | 文件归属（互斥） | 依赖 |
|---|---|---|---|
| 1 | **A** 派发通道 | `platform-mcp.service.ts` / `platform-mcp.tools.ts` + spec | — |
| 1 | **C** 纪律落点 | `agent-role-prompts.constants.ts` / `agent.constants.ts` / `seed.ts` / 新 migration + spec | — |
| 1 | **F** 仓库卫生 | `.gitignore` + index | — |
| 2 | **A4** 回执销账 + 催办分级 | `message-receipts.service.ts` / `receipt-nudge.handler.ts` / `platform-mcp.service.ts`(回执段) + spec | A |
| 2 | **D** 零收窄安全修 | `worker/src/resources/injector.ts` / `platform-capability.constants.ts` / `web/src/api/role-capabilities.ts` + parity spec | C（seed 镜像已同步） |
| 2 | **E** 协调度指标 | 新增只读 controller/service + spec | — |
| 3 | **B** 工具契约自描述 | `platform-mcp.service.ts`(错误体) / `platform-mcp.tools.ts`(描述) / `worker-dispatcher.ts`(prompt) + spec | A + A4 |

**并行约束**：同一波内各批次**文件集必须互斥**；跨波按依赖顺序。`platform-mcp.service.ts` 是热点 ⇒ A → A4 → B 严格串行。

## 批次明细

### 批次 A · 派发通道语义（wave 1）

- **A1 返回值可观测**：`notify_agent` 返回值新增 `claimed: boolean` 与 `sessionStatus: string | null`。
  - `claimed` = 平台已受理派发 **且** 目标成员存在**非 failed / 非 archived** 的会话（`me_0000000080`：会话 failed 时该派发不会被消费，却仍返回 `triggered:true`）。
  - `sessionStatus` = 目标当前会话状态（`created` / `running` / `failed` / …），无会话则 `null`。
  - 工具描述里明确 `triggered` 只代表**消息落库**，`claimed` 才代表**已开工**。
- **A2 一等更正语义**：新增可选参数 `supersede: boolean`（默认 `false`）。为 `true` 时，对**同一 (发送方, 目标)** 的在途派发**替换**原内容并引用原 `messageId`，**不再被 dedup 吞**。`force`/`forceReason` 保持原语义不变。
- **A3 通道死锁可解**：`no-active-task` 时——① 若团队存在 `currentTaskId`，**自动改走 taskId 通道重派**并在返回值带 `channelSwitched: 'task'` 与被拦原因；② 否则 hint 给出真实可执行的下一步（当前 hint 指向「请先创建任务」，而任务可能已存在且 `pending_review` 不可回退 ⇒ 死路）。

### 批次 C · 纪律落点（wave 1）

- **C1 岗位权威源**：`agent-role-prompts.constants.ts` 的 PM `rolePrompt` 增补**主动委派祈使句**（不是条件式禁令）：产出是派发与核验而非交付物 / 派发优先于动手 / 串行派活一次只激活一个执行者 / 做完即停不产出平行材料。`seed.ts` 镜像**逐字节同步**。
- **C2 平台级边界段**：`ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary` 增补主动委派语义（保持单句、denyTemplate 复用不膨胀）；`handoffTo` 保持 role→agent 名映射。
- **C3 存量回填 migration**：`agent_roles.role_prompt`（`project_manager` 行）与 `execution_policies.config.correction`（`ep_project_manager` 行）回填 C1/C2 的新值。**seed 的 upsert 是 `update: {}`，不改 migration 则存量部署不生效。**

### 批次 F · 仓库卫生（wave 1）

- `.gitignore` 增加 `.omo/evidence/**/*.json`；把已跟踪的该类文件 `git rm --cached`（**保留磁盘文件**），使「跑一次测试」不再弄脏工作区。
- 单独成 PR（index 变更量大，内容零变更）。

### 批次 A4 · 回执销账 + 催办分级（wave 2）

- **A4-1 引用即销账**：群聊消息 / 产出物提交**显式引用原派发 `messageId`** ⇒ 自动销账（= `me_0000000237` agent 自发协议的平台化）。**必须精确匹配引用**，避免误销。
- **A4-2 question 应答后结账**：`type=question/help` 的回执在被主 Agent 应答后自动结账（当前不结 ⇒ `me_0000000061` 的误报催办）。
- **A4-3 催办文案分级**：区分「未开工」/「已交付未销账」/「回执未送达」，并给出销账动作。
- **A4-4 禁止反向清账**：`me_0000000030` 指出「用 notify 清账会越清越多」——本批**不得**加剧账本膨胀（引用销账是减法，正好缓解）。

### 批次 D · 零收窄安全修（wave 2）

- **D-1 中性化保留而非删除**：`injector.ts` 的中性化路径当前 `cleanupByManifest` **删除**受管块 ⇒ agent 退回引擎默认（**权限放大**）。改为**保留上次受管块**（不清理 manifest、不改内容）⇒ 权限**既不收窄也不放大**。首次注入（无历史内容）保持现状。
- **D-2 能力点新增防漂移**：能力点目录的**三份副本**（服务端常量 / `web/src/api/role-capabilities.ts` / `seed.ts` 镜像）收敛为**单一来源**（服务端出目录接口，前端改读接口），并加**往返断言**锁死 key 集合与 `label`/`tools` 逐字段相等。已知漂移：`secret.command` 服务端一直存在、界面从未显示。
- **D-3 新增能力点必须全表回填**：`default-allow` 下新增键会让**所有存量行自动获得**该能力 ⇒ 增量加**同 PR 全表回填 + 往返断言**（在 parity spec 里锁）。

### 批次 E · 协调度指标（wave 2）

- 只读端点：PM 产出物数（目标恒 0）/ PM 消息占比 / 派发数 vs 亲做数 / 群聊+私聊双报率。
- 本地基线：PM 消息占比 **68%**（106/155 agent 消息）。

### 批次 B · 工具契约自描述（wave 3）

- **B-1 409 带合法迁移表**：状态机 409 错误体附 `allowedTransitions`（与枚举错误回显全量合法值同规格）。记忆原文：「**409 状态机错误不返回合法迁移表——最不友好**」。
- **B-2 工具描述补齐**：`notify_agent` 的 `force` 是**对象**、`forceReason` 是**独立顶层参数**；`type`/`stage`/`kind` 枚举；`issueId` 语义。
- **B-3 指向既有自省通道**：提示词里引导用**已存在的** `vteam_tool_schema` 查参数，而不是让 agent 靠「最小调用 + 错误回显」反推（`me_0000000231`）。

## Verification strategy

- server：`npx jest src/<batch>` 全绿；`npx tsc --noEmit -p tsconfig.json` clean；`npm run lint:check` **不得新增** error（基线 68 problems / 0 errors）。
- 变更既有行为的批次，**必须**给出「临时改坏 ⇒ 恰好 N 个新用例转红」的变异证据。
- 证据：`.omo/evidence/batch-<id>-<topic>.txt`。
- 每批一个 PR，标题 `fix(<scope>): <主题>`，正文按仓库惯例（现象 / 根因 / 修法 / 验证 / 已知残留）。
- **不得**引入权限收窄：每批 PR 自查 `git diff` 中不含 `capabilities` 置 false / `bashEffect` 变更 / `permission.*` 收紧。
