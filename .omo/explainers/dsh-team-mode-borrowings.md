# DSH 团队模式 → vteam 可借鉴清单

> 分析日期：2026-10-22
> 对照对象：DeepSeek Harness（DSH）Agent Teams 运行时机制 vs vteam 现有实现
> 依据：仓库代码（server / worker）+ `docs/agent-platform/` 28/30/31/32/33 篇 + `.omo/plans/` 既有设计记录
> 口径：只列**真正缺失且现在有代价**的；不为了对齐 DSH 而退化 vteam 已经更强的部分

---

## 0. TL;DR

**vteam 在「送达 → 回执 → 收敛 → 审计」这条链上比 DSH 成熟得多**（回执账本、引用即销账、去重锁、N/N 收敛门、计划哈希双锚、force+reason 审计，DSH 一样都没有）。DSH 值得借鉴的是另一类东西：**它把"委派"当成一等公民，而 vteam 把"委派"只当成"在群里 @ 一个人"**。

| 编号 | 可借鉴机制 | 优先 | 一句话理由 |
|---|---|---|---|
| B1 | 任务级 / 实例级写作用域 | **P0** | 机制**已预留**（`executionConfig.writePaths`），server 从不填；两个开发者共享整棵任务目录 |
| B2 | 文件级乐观并发守卫 | **P0** | 全仓无 mutex / lock / worktree / 文件 CAS，并发改同一文件是**静默覆盖** |
| B3 | 一次性委派通道（ephemeral subagent） | **P1** | 现在所有协作都进群聊；且非主↔非主 notify 被 403 锁死，只能靠主 Agent 转达或广播 |
| B4 | `fresh` / `fork` 双模上下文 | **P1** | 子会话恒 fresh 只能重述简报；`task_id` 续会话能力已存在但没用 |
| B5 | 结构化结果契约（schema 校验） | **P1** | VERDICT 靠文本 + 三元组门，仍有"正文手写对版本"的串味 |
| B6 | 收口前置断言 | **P1** | 自动催办只 1 次，30min 后直接 `expire`——不查账就等于缺席被静默吞掉 |
| B7 | 子项依赖图（`blocked_by`） | P2 | issue 之间零依赖关系，先后只能靠人记 |
| B8 | 上下文预算与执行期失败隔离 | P2 | 公共频道承载全部中间过程 → 132KB 截断事故的根因 |
| B9 | 委派层级判据写进 persona | P2 | "耦合度决定用一次性还是持久"这条判据缺位 |
| B10 | 投递 / 中断拆成两档显式语义 | P2 | `delivery` 有 steer/queue 两值但恒传 steer，且两处注释对 steer 承诺相反 |
| B11 | 开工即派发（别等 10 分钟巡检） | P2 | `start` 不派发任何执行请求，Agent 实际开工靠 @ 或巡检兜底 |
| B12 | 幂等与口径统一 | P2 | `/execute` 无幂等、ingress 去重纯内存、三套去重窗口各说各话 |

**反向结论（不要照搬 DSH 的）**见 §3。

---

## 1. 两套模型的结构差异

| 维度 | DSH Agent Teams | vteam（当前） |
|---|---|---|
| 协作单元 | Lead + 具名持久队友 | 主 Agent + 6 类角色模板的多实例 |
| 派活载体 | **共享任务板**（claim + revision CAS） | 群聊 @ / 私聊 / `notify_agent` / issue |
| 写入冲突控制 | 任务级 `write_scopes`（建议性）+ 文件级版本守卫（强制） | 角色级 `writeGlobs`（强制但粒度粗），**运行期无收窄** |
| 工作区隔离 | 共享同一目录（不隔离） | 任务级共享目录，**无 worktree / 无 branch 隔离** |
| 上下文来源 | `fresh`（全新）/ `fork`（继承父已完成轮次） | `reuseSession`（续用）/ `resetAfterComplete`（重开），**无 fork** |
| 结果回收 | 子 agent 只回最终结果，不污染主上下文 | 全部落群聊（公共频道），靠 `chat_history` 全量读回 |
| 收敛判定 | Lead 必须等齐所需队友（**运行时义务**） | 回执账本 + N/N 收敛门（**很强**）+ PM 铁律（自觉） |
| 消息投递 | 队列 / 步边界 / interrupt 三档 | 恒 steer 注入 + 无 Agent 侧中止入口 |
| 审计 | 弱 | **强**（version CAS、planHash、forceReason、回执账本、task_events） |

一句话：**vteam 强在"账"，DSH 强在"委派"**。

---

## 2. 逐条可借鉴

### B1. 任务级 / 实例级写作用域（P0，成本最低——字段已预留）

**vteam 现状**
- 写权限是**角色级静态**：`RoleBoundary.writeGlobs` 派生层① edit permission `{"*":"deny", ...glob:"allow"}`（[agent.constants.ts:195-261](/Volumes/SSD-Data/01work/git-project/vteam/server/src/common/constants/agent.constants.ts#L195)）。
- 开发者 = **整棵任务目录** `taskAllGlob()` → `**tasks/*/**`（[:390](/Volumes/SSD-Data/01work/git-project/vteam/server/src/common/constants/agent.constants.ts#L390)）。
- 任务目录**任务级共享、不按成员隔离**：`<WORK_DIR>/tasks/<taskId>`，同任务所有成员用同一 `directory` 下发（[worker-dispatcher.ts:2738](/Volumes/SSD-Data/01work/git-project/vteam/server/src/chat/worker-dispatcher.ts#L2738)、[:5604-5613](/Volumes/SSD-Data/01work/git-project/vteam/server/src/chat/worker-dispatcher.ts#L5604)、[work-dir.util.ts:34](/Volumes/SSD-Data/01work/git-project/vteam/server/src/tasks/work-dir.util.ts#L34)）。
- 团队已支持**并行任务**（[schema.prisma:98](/Volumes/SSD-Data/01work/git-project/vteam/server/prisma/schema.prisma#L98) `maxConcurrentTasks`），FIFO 队列已退役。

**关键发现（让这条变便宜）**：派发载荷里**已经预留了** `executionConfig.writePaths`（[worker.client.ts:296](/Volumes/SSD-Data/01work/git-project/vteam/server/src/workers/worker.client.ts#L296)），但 server 侧**从不填充/发送**，worker 只把它打一条日志（[exec-server.ts:2225](/Volumes/SSD-Data/01work/git-project/vteam/worker/src/exec/exec-server.ts#L2225)）。**也就是说"按次收窄写路径"的管道已经铺好，只是没接水。**

**风险**：同任务下 `开发者-1` 与 `开发者-2` 的写范围完全相同；并行任务再多开几路。范围重叠全靠"人在派活时口头说清楚"。

**DSH 做法**：任务创建时声明 `write_scopes`；建议性、重叠只告警不拦截。

**落地建议**
1. `TeamMember` / `TaskGroupInstance` 增 `writeScopes String[]`，缺省继承角色 `writeGlobs`（只能更窄、不能更宽）。
2. dispatcher 组 payload 时把成员 scope 填进 `executionConfig.writePaths`；worker 侧把当前仅打日志的地方接成**实际生效**（层① edit permission 收窄）。
3. 派发/增员时校验同任务成员 scope 前缀重叠 → 群聊系统消息告警 + `team_view` 暴露冲突清单（先观测，不拦截）。
4. 计划 Tab 显示"本任务谁管哪块目录"。

**验收**：两开发者 scope 分别 `**tasks/*/server/**` 与 `**tasks/*/web/**`；A 写 web 路径被拒；重叠时群聊出现系统告警；未声明 scope 时行为与现状逐字节一致。

---

### B2. 文件级乐观并发守卫（P0）

**vteam 现状**：全仓检索 —— **无 mutex、无 file lock、无 lockfile、无 advisory lock、无 worktree/branch 隔离、无文件级 CAS**（`v2-system-handoff.ts` 的 `compare-then-write` 只用于系统提示词交接文件，不覆盖业务代码编辑）。opencode 的 edit 是 read-modify-write，无版本回传。

**后果**：两个实例并发改同一文件，后写者**静默覆盖**，无报错、无提示、无审计。这比 B1 更危险——B1 至少能观测，B2 是静默丢改动。

**DSH 做法**：read 带版本，edit/write 带旧版本提交，不匹配返回 `FS_STALE_VERSION`，要求重读 → 重基于新内容 → 重试。

**落地建议**（由轻到重）
1. **低成本（建议先做）**：worker 侧 edit 前记 `(path, mtimeMs, size, sha1)`，写后比对；变化则**告警**（群聊系统消息 + 审计），不改行为。先观测两周拿真实数据。
2. **中成本**：把指纹塞进工具契约（read 返 `etag`，edit 带 `etag`），不匹配拒绝。需 opencode 钩子或 guard 插件支持——**先确认可行性再立项**。
3. **兜底（无论 1/2 是否做）**：并发槽 > 1 时，`accept` 前做一次"同名文件被多个成员先后写"的扫描，命中即告警。

> ⚠️ 前提：若生产部署是多 worker 且 `WORK_DIR` 不是共享卷，同一任务的目录**根本不共享**，则 B1/B2 的冲突面集中在同一 worker 上的多成员。**这条前提必须先确认**（见 §5-1）。

---

### B3. 一次性委派通道（ephemeral subagent）（P1）

**vteam 现状**
- 起子会话的 `task` 工具**只有 `vteam-plan` 能用**：层① `permission.task: allow` 仅按名分支给 plan，`mode: 'all'` 也仅 plan；注释明确 `execute/task` 永不列入 `toolAllows`（[vteam-plan-member-subagents.md:15,26-31](/Volumes/SSD-Data/01work/git-project/vteam/.omo/plans/vteam-plan-member-subagents.md#L15)，[agent.constants.ts:203](/Volumes/SSD-Data/01work/git-project/vteam/server/src/common/constants/agent.constants.ts#L203)）。
- 所以开发者/测试要做任何子任务，只能 `@` 另一个持久成员 → **一切进群聊**。

**代价（已实测）**：1 个 `@all` 引 6 人群答（[30 篇:16-18](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/30-团队协作规约.md#L16)）；`chat_history` 增量查询 132KB 被截断致 PM 无法确证（[31 篇:13](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/31-派发回执配对机制.md#L13)）。

**更硬的理由——路由被锁死了**：`notify_agent` 有硬门：主 Agent 可通知任何人、任何人可通知主 Agent，但**非主 ↔ 非主一律 403**（含自通知），不落库不广播（`platform-mcp.service.ts:1887-1919`）。跨角色协作只剩两条路：**经主 Agent 转达**，或**群聊广播**。这与 30 篇"默认点对点"的规约意图存在张力，也解释了群聊为何承担了过多中间过程。另有 `@` 风暴熔断：同对 3 次/60s、单任务 20 次/120s（`mention-throttle.ts:1-20`）。

**DSH 做法**：`subagent`（一次性、只回结果、不进公共上下文）vs teammate（持久、可反复派活）。判据：*任务之间没有"必须互相看见"的耦合 → 一次性；有 → 才上持久成员*。DSH 里任意成员可 `send_message` 任意成员，无枢纽瓶颈。

**落地建议**
1. `task` 工具开口从 plan 泛化到 developer / tester，**沿用 plan 已验证的 guard 范式**（`subagent_type` 白名单 + 深度 1 + 子会话禁套娃 + 父权限派生越严越严）。
2. **子会话结果只回父会话，不进 `group_post`** —— "6 人群答"退化为"1 个父 agent 汇总"。
3. 扇出上限 2~4（子会话同样占 worker 容量，见 B8）。
4. 保留纪律：子会话禁止 `group_post`，汇总必须由父 agent 显式发出。

**验收**：开发者派一次"跑 3 个子测试场景"→ 群聊只出现 1 条汇总；子会话零群消息；子会话内 `task` 被 deny。

---

### B4. `fresh` / `fork` 双模上下文（P1）

**vteam 现状**：子会话恒 fresh——"不传 `task_id` 即新会话"（[vteam-plan-member-subagents.md:15](/Volumes/SSD-Data/01work/git-project/vteam/.omo/plans/vteam-plan-member-subagents.md#L15)）。持久成员侧只有 `reuseSession` / `resetAfterComplete` 两态（[28 篇:122-131](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/28-团队模型与排队设计.md#L122)）。

**缺口**：fresh 子会话必须由父 agent **重述全部背景**（成本 + 失真）；而 opencode `task` 本身支持传 `task_id` 续会话，只是纪律上没用。DSH 的 `fork` 正是"继承父已完成轮次"——既省钱又保真。

**落地建议**：在 `task` 参数里显式区分两种模式，并在 skill/persona 写死用法——
- `fresh`：子任务自包含（"按这份清单跑测试"）。**要求** briefing 含 背景/交付物/验收 三要素，禁止"按上面说的做"。
- `fork`：子任务需要父的分析上下文（复审、续写、深化同一次探索）→ 传 `task_id` 续会话。

**验收**：同一父会话两种模式各跑一次；fork 模式子会话首轮无需重读全量历史；token 用量对比留 evidence。

---

### B5. 结构化结果契约（schema 校验）（P1）

**vteam 现状**：评审回执靠**文本 VERDICT + 三元组门**（member / verdict / msgId）+ 版本 hash 钉定（[33 篇:51-56](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/33-评审轮次机制.md#L51)）。"过期回执作废"已解决串味，但仍依赖 agent 在正文里**手写版本号**——这是最后一个人为解析点。

**DSH 做法**：`agent(prompt, {schema})` 返回**校验过的对象**，不合格直接判失败，且失败隔离到单项。

**落地建议**
1. 评审回执改机器可读段（JSON）：`{verdict, planVersion, hash, blocking[], nonBlocking[], evidence[]}`；parse 失败即**打回**（等价现有"缺版本打回"，但更硬）。
2. `submit_artifact` 的交接产物（如"可验证清单"）同样带 schema，省掉下游自然语言解析。
3. PM 汇总（各视角 VERDICT + 共识阻塞 + 分歧 + 待拍板）直接由结构化字段聚合生成。

**风险**：schema 过严会逼 agent 编造字段。**先只强 3 个字段**（verdict / planVersion / hash），其余可选。

**验收**：缺字段回执被打回并指出缺失字段名；正常回执可被脚本直接聚合成 `N/N` 汇总。

---

### B6. 收口前置断言（P1）

**vteam 现状**：已有 `pendingReceipts` 看板 + `message_receipts` 账本（[31 篇 §3.4](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/31-派发回执配对机制.md#L51)），但"判定缺席前必须先查看板"是**提示词铁律**（[32 篇 §3.3](/Volumes/SSD-Data/01work/git-project/vteam/docs/agent-platform/32-派发幂等与先查后派机制.md#L37)），不是机制。

**更关键**：自动催办**只发 1 次**（`MAX_AUTO_NUDGES=1`），缺省 30 分钟后直接 `expire` 并升级提示（`receipt-nudge.handler.ts:20-31`）。一条没被回应的派发，**30 分钟后在账上就"没了"**——若不查账，缺席会被静默吞掉。

**DSH 做法**：Lead **必须**等齐所需队友才能出最终答复——运行时义务，不是自觉。

**落地建议**：把等待义务下沉到状态机。
- `mark-pending-review`（提交验收）与 `accept`（验收通过）前，服务端断言本任务 `message_receipts.status='pending'` 计数为 0。
- 不为 0 → 拒绝并回 `{code:'PENDING_RECEIPTS', count, items[]}`（含目标成员 + 事项摘要）。
- 显式豁免：`force=true` + 非空 `forceReason`（**复用既有 force 口径**，不新增语义——`tasks.service.ts:1483-1496` 的完工预检已是这个形状）。

**验收**：有 1 条 pending 时 `accept` 被拒并列出该回执；force + reason 可过且审计留痕。

---

### B7. 子项依赖图（`blocked_by`）（P2）

**vteam 现状**：全仓 `blockedBy / dependsOn / dependency / DAG` 零命中；`Task` 无前置字段；迁移表只有 7 条边且不含依赖。issue 有流转但**issue 之间无先后关系**——"B 等 A"只能靠 PM 记 + 群聊说。

**DSH 做法**：任务可声明 `blocked_by`；就绪只表示"可以开始了"，**不自动启动**执行者。

**落地建议**
1. `issues` 增 `blockedBy String[]`（同任务内 issue id）。
2. `issue_transition('start')` 前置校验：blocker 必须全部 `resolved/closed`，否则 409 并列出未完成 blocker。
3. 刻意**不做自动派发**：blocker 全清只通知 PM，由 PM 决定何时派（避免"一解冻就全员开跑"）。

**已对齐、无需改**：vteam 现在"创建 → `pending`，需显式 `start`"符合"就绪≠启动"（[task.constants.ts:74-85](/Volumes/SSD-Data/01work/git-project/vteam/server/src/common/constants/task.constants.ts#L74)）。

---

### B8. 上下文预算与执行期失败隔离（P2）

**vteam 现状**
- 全部中间过程进群聊，PM 靠 `chat_history` 读回 → 已发生 132KB 截断；修复是分页 + truncated 标记（**治标**）。
- 子会话/成员都占 worker 容量（`WORKER_MAX_INSTANCES` 默认 5，[config.ts:377](/Volumes/SSD-Data/01work/git-project/vteam/worker/src/config.ts#L377)），剩余容量 = `maxInstances - load.instances`（[workers.service.ts:1533-1541](/Volumes/SSD-Data/01work/git-project/vteam/server/src/workers/workers.service.ts#L1533)）。**无队列**：`assignWorker` 返回 null 直接抛"无可用 worker"（`worker-dispatcher.ts:2427-2435`）。
- 评审轮次是**刻意的 N/N 收敛**（33 篇 §3.4）——这是优点，不要改成 DSH 的"单项独立成败"。

**DSH 做法**：子 agent 只回最终结果；`pipeline` 单项失败只让该项 `null`，不拖累其他项。

**落地建议**
1. 上下文纪律入 persona：**进度播报走摘要**（"3/5 完成，2 处阻塞"），细节走产出物，不进群聊正文。
2. **执行期扇出**（issue 并行子项）用"单项独立收敛"：每项自己 owner + 终态，一项失败不阻塞其他项；**评审类收敛仍走 N/N**。两种收敛语义分开写死，不要混用。
3. 扇出前校验 worker 剩余容量，不足则降级串行。

---

### B9. 委派层级判据写进 persona（P2）

> 任务之间没有"必须互相看见"的耦合 → 用一次性子会话（快、便宜、不污染群）；有耦合、需要反复对齐 → 才 @ 持久成员。

配套边界：子会话禁 `group_post`；深度 1、禁套娃；扇出 2~4 路。

---

### B10. 投递 / 中断拆成两档显式语义（P2）

**vteam 现状**
- 协议层 `delivery` 有两个值：`steer`（插队/打断当前轮）与 `queue`（排队），但**平台在注入和常规下发都恒传 `steer`**（`worker.client.ts:443-462`、`server/src/workers/worker-session-protocol.ts:57-65`）——`queue` 是摆设。
- **注释互相打架**：dispatcher 侧写"在下一个 step 边界被消化"（`worker-dispatcher.ts:903-908`），协议侧写"打断当前轮"（`server/src/workers/worker-session-protocol.ts:60`）。同一字段两种承诺。
- worker 有 `POST /sessions/:id/abort`（`worker.client.ts:1166-1184`），但**只服务端"卡死自愈"时内部调用**（`worker-dispatcher.ts:5331-5334`），从未暴露给 Agent 或用户。**也未找到"取消任务 → abort"链路**。

**DSH 做法**：`send_message` 在步边界交付（不打断）与 `interrupt_agent`（打断当前轮但**保留收件箱**）语义分明，且各有名字。

**落地建议**
1. 先把语义定死并统一注释：`steer` 究竟是"下个 step 消化"还是"立即打断"，二选一写进协议文档。
2. 若确为"打断"：考虑启用 `queue`（用户"等它做完再说"时不该打断）。
3. 把 abort 开放为 Agent 工具（如 `agent_abort`），带权限门 + 审计（谁打断了谁/原因），**保留被中断方收件箱**——与 DSH `interrupt_agent` 同构。
4. UI 上"插话"与"中止"做成两个动作，而不是一个输入框。

**验收**：投递语义在协议文档 / 代码注释 / UI 文案三处一致；`agent_abort` 后原收件箱消息不丢。

---

### B11. 开工即派发，别等 10 分钟巡检（P2）

**vteam 现状**：`start` 只做状态迁移 + 会话 `created→active` + 系统消息 + 注册巡检，**不向 Worker 派发任何执行请求**（`tasks.service.ts:1048-1053,1855-1868`）。Agent 实际收到指令，只能靠：人工 `@`、MCP `notify_agent`、或**巡检兜底**——巡检默认 10 分钟一轮、最多 6 轮才叫醒主 Agent（`task-progression.scheduler.ts:130-133`）。

也就是：任务点了"开始"，可能**最长 10 分钟没人干活**，而这期间状态已经是 `in_progress`，看板上看着像在跑。

**DSH 做法**：spawn 时就把任务写进 prompt——"就绪"与"派发"是同一个动作，不存在空窗。

**落地建议**
- `start` 成功后同步向主 Agent 派发一条 kickoff（复用 `notify_agent` 的派发通道，正文含任务目标 + 当前计划/issue 状态），把巡检从"主路径"降级为"兜底"。
- 或（更保守）：UI 上明确"任务已开始，等待派活"，避免"看着在跑其实没人动"。

> ⚠️ 代码里读不出前端是否在 `start` 后自动发一条 `@主Agent`（若有，则本条只是"把隐含动作显式化"）。见 §5-8。另注意 `longRunning` 值班任务**同时豁免巡检**（`tasks.service.ts:1607-1616`），它更依赖人工/事件驱动开工。

**验收**：`start` 后主 Agent 在秒级收到 kickoff 并给出首个动作；巡检在正常路径下不再触发。

---

### B12. 幂等与口径统一（P2）

**vteam 现状（三处硬缺口）**
1. **`/execute` 无幂等**：只有 `/secret-command` 带 requestId；重复下发会**执行两次**，server 的 completedSessions/failedSessions 只挡迟到回流、不挡执行（`exec-server.ts:645`）。
2. **ingress 去重纯内存**：server 重启即失效（`worker-event.ingress.ts:342-357`）。
3. **三套去重口径各自为政**：

| 口径 | 位置 | 窗口 |
|---|---|---|
| notify 内容去重 `NOTIFY_DEDUP_WINDOW_MS` | `platform-mcp.service.ts:157` | 60s |
| group_post 相同内容去重 `findRecentIdenticalGroupPost` | `platform-mcp.service.ts:1538-1552` | 另算 |
| 回执 dedupKey | `message-receipt.constants.ts:76-89` | **永久唯一** |

DSH 侧只有一套"任务板 + revision"，口径天然统一。建议：给 `/execute` 加幂等键（复用既有 `taskId+sessionId+派发消息id` 三元组即可）；三套去重窗口收敛到同一常量文件，并在 31/32 篇写成一张表——否则调一个必漏另外两个。

---

## 3. 反向：vteam 已经更强、不要为对齐 DSH 而退化

| 机制 | vteam | DSH | 结论 |
|---|---|---|---|
| 送达-回执收敛 | `message_receipts` 账本 + 引用即销账 + 四种结账依据 + 幂等催办 | 无（靠 Lead 自己 list/wait） | **保留 vteam** |
| 重复派发防护 | issue 状态锁 + 10min 去重键 + force 审计 | 无 | **保留 vteam** |
| 多路收敛 | 轮次账本 + N/N 收敛门 + 过期回执 `superseded` | 无 | **保留 vteam** |
| 审计与可回放 | version CAS、planHash 双锚、forceReason、task_events | 弱 | **保留 vteam** |
| 权限粒度 | 角色 × 工具 allowlist × 写 glob × 双层（层①/层②） | 较粗 | **保留 vteam** |
| 显式启动 | `pending → start` | 就绪不自动启动 | 已对齐 |
| 产出物基线 | accept 时锁定 acceptedFlag，锁定后 409 | 无 | **保留 vteam** |

**唯一值得补的语义**：DSH 区分"消息送达 ≠ 已处理"。vteam 的 `triggered: true` 只表示送信成功。建议 UI 上把「已送达 / 已处理 / 已回执」三态显式化——不加机制，只改呈现。

---

## 4. 落地路线

**第一波（P0，1~2 周）——先止血**
- **B2 方案 1**：edit 前后 `(mtime, size, sha1)` 比对，冲突写系统消息 + 审计（不改行为，先可观测）。
- **B1**：`writeScopes` 字段 + 填进 `executionConfig.writePaths` + worker 侧接成实际生效。
- 观测两周，用真实并行数据判断冲突频率，再决定 B2 是否上方案 2。

**第二波（P1，2~4 周）——把委派做成一等公民**
- **B3** `task` 工具泛化到 developer/tester + 子会话结果只回父。
- **B4** `fresh`/`fork` 双模 + skill 写死用法。
- **B6** 收口前置断言（复用 force 口径）。
- **B5** 评审回执三字段 schema 强制。

**第三波（P2）——结构与一致性**
- **B7** issue `blockedBy`；**B8** 上下文预算 + 容量校验；**B9** 判据入 persona
- **B10** 投递/中断语义定死 + `agent_abort` 开放
- **B11** 开工即派发；**B12** 幂等与口径统一

**排序理由**：B1/B2 是"并行化之后才开始流血"的问题且有现成管道；B3/B4 是结构性成本（广播炸 + 上下文截断的根因）；B5/B6 是"把已有账本用起来"，投入小、收益直接。

---

## 5. 待确认项（实现前必须先答）

1. **部署前提**：生产是否多 worker 且 `WORK_DIR` 为共享卷？（若不是，B1/B2 的冲突面只在同 worker 多成员，优先级需下调）
2. **两套 workDir 约定哪个是准**：`TeamMember.workDir`（`/data/vteam-worker/<agent>`）存在，但 dispatcher 解析目录时**不读它**，实际只用任务/团队目录。
3. `executionConfig.writePaths` 当初预留的语义是否就是"按成员收窄"（还是别的意图）——决定 B1 直接复用还是重新设计。
4. opencode 是否提供可拦截 edit 的钩子——决定 B2 走方案 1 还是 2。
5. `task_id` 续会话在 opencode v2 下是否等价 DSH 的 fork（历史完整继承？权限派生？）。
6. `pendingReceipts` 计数能否覆盖 team-free 场景（无 taskId 的派发）——否则 B6 断言会漏。
7. 子会话占 worker 容量的真实开销——决定扇出上限 2 还是 4。
8. 前端 `start` 之后是否自动发一条 `@主Agent`（决定 B11 是"新增 kickoff"还是"把隐含动作显式化"）。

---

## 6. 附：调研中撞见的不一致（与 DSH 无关，建议单独立项）

**文档 ↔ 实现漂移**
- `worker/README.md:9` 称"空闲判死（instance-tracker）"，但 `instance-tracker.ts:82-90` 只做计数与泄漏清理，**判死实现全在 server**。
- 首字超时默认值三处不一致：README/compose = 300000ms，`worker/src/config.ts:372-376` 代码缺省 **0（禁用）**。
- 工具数四个数字：`PLATFORM_MCP_TOOLS` 12 / CONTRACT 文档 28 / `VTEAM_MCP_TOOL_NAMES` 34 / 实际注册 35。
- `28 篇` 仍描述 FIFO 串行排队，但队列已退役、并行任务已实现（`parallel-tasks-and-task-tab.md` 标注已实现）。

**幂等与去重**：见 B12。

**迁移表缺口**
- `completed → in_progress`（产出物新增/回滚）**绕过 `transition()`**，不写 `task_events`、不重排巡检（`artifacts.service.ts:270-274`）。建议要么补进迁移表，要么显式注释为合法旁路。

**死结构 / 半死结构**（清理可减少理解成本）
- `TeamQueue` 表与 `task_id` 唯一约束仍在，但无任何写入路径（FK 是 RESTRICT）。
- `queued` 字面值仍在 `TASK_STATUS` / `NON_TERMINAL_TASK_STATUSES` 中，无写入路径。
- `executionConfig.writePaths` 预留未用（见 B1）。
- `TeamMember.workDir` 存在但派发不读（见 §5-2）。

**一致性与失败面**
- 主 Agent 身份：`mainAgentMemberId` 是权威，但 chat.service 与 dispatcher 都回退"首位成员"，`notify_agent` 路由门在主成员缺失时 **fail-open**（`platform-mcp.service.ts:1907-1910`）——同一事实在不同路径宽严不一。
- `questions` 30 分钟超时**只在 GET 时惰性触发**，无定时器；无人拉列表可能长期 pending。
- 失败后除静默路径 `tryAutoRestart` 外**无自动重派策略**。
- 任务取消链路缺失（无法判断是未实现还是产品层别处处理）。
