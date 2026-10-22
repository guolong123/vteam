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

---

# 执行结果（2026-10-22 追记；上文批次定义为历史记录，**不重写**）

> 本节按仓库惯例**追加**记录实际落地情况。已合并的批次定义与硬约束原文保留在上文，不回改。

## 1 · 已合并批次

| 批次 | PR | 落地内容（一句话） |
|---|---|---|
| **A** 派发通道 | #59 | `notify_agent` 返回值新增 `claimed` / `sessionStatus`（区分「已投递」与「已开工」），并补 `supersede` 一等更正语义与 `no-active-task` 时自动改走 taskId 通道（`channelSwitched='task'`）。 |
| **C** 纪律落点 | #60 | PM「只协调不执行」四条纪律写进岗位权威源 `agent_roles.role_prompt` + 平台级【职责边界】`scopeSummary`，含**存量回填迁移**（seed 是 `update:{}`，不改迁移则存量部署不生效）。 |
| **A4** 回执销账 + 催办分级 | #61 | 回执账本补「减法」：引用原派发 `messageId` 即销账（`settled_reason='quoted'`）、`question/help` 被应答后结账、催办文案分「未开工 / 已交付未销账 / 回执未送达」三档。 |
| **D** 零收窄安全修 | #62 | 中性化路径**保留**上次受管块而非删除（不再退回引擎默认 ⇒ 权限不放大）；能力点目录收敛为单一来源 + 往返断言闸门，新增能力点必须同 PR 全表回填。 |
| **E** 协调度指标 | #63 | 新增只读端点 `GET /api/v1/teams/:teamId/coordination-metrics`（PM 产出物数 / PM 消息占比 / 派发 vs 亲做 / 群聊私聊双报率）。 |
| **D2**（新增批次，见下） | #64 | 陈旧 worker 仍点名岗位 agent —— 岗位权限集不再被绕过。 |
| **F** 仓库卫生 | #58 | `.omo/evidence/**/*.json` 进 `.gitignore`（保留 3 个冻结基线入库），跑测试不再弄脏工作区。 |

## 2 · 批次 B 结论：**基本已过时，取消**

原批次 B 的三项在开工前就已被上游覆盖：

- **B-1（409 带合法迁移表）——已存在**。409 状态机错误体**早已**带 `allowedActions` / `allowedTo`
  （`server/src/platform-mcp/platform-mcp.controller.ts:534-570` 的 `detailsSuffix()`，
  `TRANSITION_TABLES` + `legalActionsFor`），随 **PR #55** 在本计划启动**之前**落地 ⇒ 无需再做。
- **B-2（工具描述补齐 `force` / `forceReason` / `type` / `stage` / `kind`）——已由批次 A 补掉**；
  其中 `type` / `stage` / `kind` 的枚举全集自 PR #55 起就由 schema **派生**进描述首行
  （`describeToolEnums()` ⇒ 描述与 schema 同源、不会漂移），本就足够详尽。
- **B-3（指向既有自省通道）——唯一真实残留**，已于 2026-10-22 落地（见 §5）。

## 3 · 新增批次 D2（不在原计划内）

**为什么需要它**：批次 D 只修了**配置侧**（worker 注入的 opencode 配置不再被清空）；但**派发侧**
仍会丢掉 agent 名字 ⇒ 落到**引擎默认 agent** ⇒ 岗位权限集被绕过（D 想保的「不收窄也不放大」
在派发这一环上根本没生效）。

**改了什么**（PR #64）：server → worker → opencode 全链路补齐「本次派发用哪个岗位 agent」的
显式传递（`worker-protocol.ts` / `workers.service.ts` / `worker-dispatcher.ts` /
`worker/src/index.ts` / `worker/src/resources/injector.ts`），陈旧 worker 也按登记的
agent 名点名 ⇒ 岗位权限集在陈旧 worker 上同样生效（新增回归用例锁死）。

## 4 · e2e 脚本与当前状态

`scripts/e2e-pm-coordination.sh`（**7 段**：A 迁移生效 / B 派发返回值 / C 引用即销账 /
D 催办分级 / E 纪律落库 / F 权限未被收窄 / G 协调度指标），对着本地 compose 栈
（MySQL8 + server + web + worker）跑**真实迁移 + 真实 MCP 端点 + 真实 worker**。

当前状态（证据：`.omo/evidence/pm-coordination/e2e.txt`）：

- **A–G 全 PASS（2026-10-22 复跑，exit 0）** —— A 迁移生效 / B 派发返回值 / C 引用即销账 /
  D 催办分级 / E 纪律落库 / F 权限未被收窄 / G 协调度指标，七段全绿。
- **D 段最终形态**：不再「派发给 live 成员然后盼它不回」（成员答得很快 ⇒ 回执合法结账
  `settled_reason=answered` ⇒ 催办本就不该发生，旧设计必然失败）。改为**直接种 pending
  回执 + `receipt_nudge` 触发器、不派发**（没人被唤醒 ⇒ 回执必然留 pending），并把
  `expires_at` 设成 `== due_at`（**完全贴平台真实形态**，靠 PR #68 的宽限窗保证催办先赢）。
  实测抓到分级文案原文：`【平台自动催办·第1次】项目经理-1 → 产品经理-1：平台没有看到你的
  任何回复或产出物…（原派发消息 m_…，receiptId=mr_…）` ⇒ `not-started` 档被正确分类下发。
- 该段最初只能靠「把 `expires_at` 往后挪 90s」从外面绕过去才稳定观测到催办 —— **那个绕行
  本身就是平台有病的 tell**（催办与到期清扫同一瞬间赛车，清扫赢则催办被静默吞掉，即批次
  A4 的催办在生产上被削弱）。PR #68 修好后绕行已移除。

## 5 · B-3 的载体选择（2026-10-22 实测）

**先量爆炸半径再动手**（结论：**加一行到全局提示词，炸 0 条断言**）：

- 全局提示词（`GLOBAL_BASE_LINES`）的既有断言**全是哨兵式** `toContain` / `not.toContain`，
  **无一条整串相等**：`worker-dispatcher.spec.ts` 里 **43** 条 `expect()` 直接引用
  `GLOBAL_SYSTEM_INSTRUCTIONS`，全文件 **116** 条 `not.toContain(...)` 字面量，
  与新增行**无一条相交**（0 命中）。
- 实测：加一行后跑 server **全量** 196 suites / 4622 tests ⇒ **全绿，与改前逐条一致**。
- 顺带澄清两处**误传**：`worker-dispatcher.spec.ts` 的「7 内置出厂 correction → boundary 与
  变更前冻结基线逐字节一致」、`worker-dispatcher.snapshot.spec.ts`、
  `.omo/evidence/vteam-role-behavior-abstraction/before-boundary.json` —— 这三处冻结的是
  **【职责边界】/ correction 正文**与**分派快照**，**都不含全局提示词** ⇒ 不构成全局提示词的闸门。
- **载体选择**：落在 `GLOBAL_BASE_LINES` 末行（新增【工具自省】一行），而不是
  「扩 `vteam_tool_schema` 工具自身描述」—— 后者的描述**本来就已经**写着
  「调用前先用它确认必填字段与合法取值」，缺的从来不是描述而是**「这个工具存在」的提示**；
  工具描述只有 agent 去翻 `tools/list` 才看得到，提示词点名才是有效手段。
- 落点唯一性：`buildSystemInstructions` 的**唯一**调用点在 `worker-dispatcher.ts:2995`
  ⇒ 每次 dispatch 必注入；`suppressMemory` 分支（计划员岗位）走的正是 `GLOBAL_BASE_LINES`
  ⇒ 7 个岗位无一遗漏（`vteam_tool_schema` 在 7 个岗位的 toolAllows 里均为 `allow`，
  且属 `PLATFORM_MCP_READONLY_TOOLS` ⇒ 能力门恒放行）。

## 6 · 待办发现（Open findings）

- **P0（并行修中）**：`submit_artifact` **不传 `meta`** 给 `artifactsService.append`
  ⇒ `authorAgentId` **恒为 NULL** ⇒ 批次 E 的头号指标 `pm_artifact_count` 是一台
  **假阴性机器**（PM 真交了产出物也数不出来）。修好 `meta` 之前，该指标**不可用于验收**。
- **已知不计划修**（记录在案，避免反复讨论）：
  - 会话 `failed` ≠ 已停止：并行会话下 `failed` 不代表目标真的停了，要正确表达需要
    `run_id` 归属 + claim/stop 语义（新一轮工作，非本计划范围）。
  - 唤醒预算 ≈ 5 次/任务：受 `MAX_SILENT_WAKE_ATTEMPTS` 一类上限约束，本轮不动。
  - 只读凭据上**静默伪成功**（命令其实没跑但报成功）：已知缺陷，需单独一轮修。
  - librarian **没有 `chat.notify`**：补它等于**收窄/改写**其他岗位的授权面，
    与本轮「不做任何权限收窄」的硬约束冲突 ⇒ **阻塞，不在本轮做**。
  - 指标窗口缺 `(channel_id, created_at)` 索引：只影响查询性能，不影响正确性；
    补索引属 migration，另案。

