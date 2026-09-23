# Learnings — session-right-panel-plan-overhaul

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## L1 · 门禁脚本会改写源码：`npm run lint --prefix server` = `eslint --fix`
`server/package.json:15` 的 lint 脚本带 `--fix`。当作"验证门禁"跑它会**自动改写 76 个无关文件**（本会话发生过一次，已 `git checkout -- server/src` 回滚）。
**正确做法**：验证用 `npx eslint "{src,apps,libs,test}/**/*.ts"`（无 `--fix`）；要格式化只对**自己改的文件**跑 `--fix`。

## L2 · 该仓库整体不满足自己的 prettier 配置（预存债）
基线 `b418103` 下 `platform-mcp.tools.ts` 就有 202 个 `prettier/prettier` error，全仓约 817 个。
**正确做法**：用 `git show <base>:<path> | npx eslint --stdin --stdin-filename <path>` 做**基线对比**，只对"我们新增的 error"负责（本次新增 30，已清零）。

## L3 · 容器跑的不是当前代码
`:13000` 的 server 容器是构建期快照（本次旧镜像 10:02，而代码提交在 20:00+）。**任何"真实链路"验证前必须先确认容器镜像是否包含本次改动**：
`docker exec <c> sh -c 'find dist -name "*<新文件>*"'`。
重建：`docker compose build <svc> && docker compose up -d <svc>`（Dockerfile 首行指向私有 registry `docker.ketaops.cc`，偶发 EOF 需重试）。

## L4 · `reject`/`accept` 会出队队首（promoteNextInTx）
在 tm_0000000001 上调 `reject` 会把 `current_task_id` 推到下一个 queued 任务并**删掉其队列行**，且**无法经公开 API 恢复**（enqueue 仅 pending、cancel 仅 queued）。
**真实链路 QA 若需触发 pending_review，务必选一个队列为空/独立的团队**，或事后用 DB 事务精确恢复。

## L5 · playwright 环境
`web/playwright.config.ts` baseURL 硬编码 `:3001`（本地 dev，不自启 webServer）、`channel: chrome`。`pages`/`docs` 项目依赖 `setup`（seed-admin 真实登录 → `.auth/user.json`）。默认 `npm run test:e2e` 只跑 6/22 个 spec，16 个是**孤儿**（不在任何 project 内）。

## L6 · 「保持共享组件不被修改」的约束会把问题挤到外层
计划 T18 写了「只改外层容器布局，保持 `TaskStatusActions` 组件本身不被修改」。执行者照做，在外层套 `grid 1fr1fr`；
但该组件根容器是 `flexDirection:column`（子按钮被 stretch 成全宽），整个竖排块只占第 1 列 → 按钮变成上下堆叠、各占半宽。
**教训**：当视觉目标需要改变子组件内部排布时，"不许动子组件"的约束是错的；正确做法是给共享组件加**可选 prop**（默认值保持既有调用方行为），而不是在外层硬套布局。

## L7 · `stream error` 是 AI-SDK 的**外层包装**，不是原因
opencode/AI-SDK 的日志形态是 `message="stream error" error.error="AI_APICallError: <真实原因>"`。
`message` 只是包装（瞬时流中断被内核重试后会话照常继续），**真实致命性在 `error.error` 里**。
把包装文案列为致命关键词 → 每有一条瞬时 stream error 就 abort 一个健康会话
（现象：`等待首字超时：模型调用报错：stream error`，而会话仍在跑）。
**判据**：致命关键词只收具体原因（AI_APICallError / Rate limit / quota / Invalid API key / 429…）。

## L8 · 错误类型复用时要检查文案前缀
`CompletionTimeoutError` 被「真首字超时」与「serve 错误提前失败」两条路径共用，但文案恒带「等待首字超时」→
把"会话仍在跑"误报成超时，误导排查方向。**多来源共用错误类型时，文案必须按来源分支**。

## L9 · 关键词表要按用途拆分：「收集证据」与「判定致命」口径不同
误杀复查时发现 `subscribe` 不能从关键词表删——`opencode-server.spec.ts:479` 断言 share-subscriber 行
**仍须被 `recentErrors()` 收集**（全局尸检证据）。宽表既管收集又管 abort 是设计缺陷。
**正确做法**：拆两张表——`SERVE_ERROR_KEYWORDS`（宽，收集/证据）与 `SERVE_FATAL_KEYWORDS`（严，abort 判据），
判据只认具体原因（`AI_APICallError`/`Rate limit`/…），包装与泛化词（`stream error`/`subscribe`）只进证据。
**改判据前先查 spec 是否依赖旧口径**，否则会破坏既有证据契约。

## L10 · 活性判定不能只数「数量」，要数「内容变化」
只数 parts 会漏掉工具执行中：tool part 的 `state`（pending→running→completed）/`output`/`time` 会变
但 part 数不变 → 长工具（> 首字超时）被误判「无输出」而 abort。
**做法**：用 O(1) 标量投影做「内容指纹」（长度/状态/时间累加），**不要 JSON.stringify**（大 tool 输出会拖垮每轮 poll）。

## L11 · 同一策略在两处实现时会漂移——改判据要 grep 全部同义判据
`tryAutoRestart` 的「任务非 in_progress 跳过」与 `dispatchAgentMention` 的「终态门禁」是**同一策略的两份实现**：
后者只挡 `completed/archived` 且**只对 kind=execution 生效**（注释明确 wake 豁免），
前者却卡 `in_progress` —— 结果 `pending_review` 的卡死会话拿不到自动恢复。
更微妙的是：dispatcher 的注释把前者引为「先例」，却自行采用了更宽口径，**老闸门没同步放宽**。
**做法**：改任何"准入判据"前，先 grep 出所有同义判据，确认口径一致；否则会留下行为裂缝。

## L12 · 一次性触发器的 nextFireAt 恒为 NULL——回落 dueAt 会显示"过去的时间"
`receipt_nudge` 等一次性触发器（`interval_ms = NULL`）`next_fire_at` 恒为 NULL，而 `due_at` 是
「本该触发的时间」。前端 `nextFireAt ?? dueAt` 回落后，待触发行会显示一个**已过去的绝对时间戳**，
既不是"下次触发时间"，也看不出"逾期未触发"。
**做法**：回落 dueAt 时必须按 status 判语义——pending 且时刻已过 → 显式标注（如「应于 …」），
否则用户会把过去时间误读成"已触发"。

## L13 · e2e 断言里绝不写死会被业务改动的数据
两条长期失败的用例都是同一反模式：把**业务数据当常量**写进断言——
① 断言面板含某个任务名（任务会被改名）② 断言某个写死的任务 id 的标题出现在面板（面板展示的是团队**当前任务**，队首会随验收/推进变化）。
**做法**：断言前先经 API **运行时解析**目标值（`GET /tasks/:id` / `GET /teams/:id` 的 currentTaskId），
并对解析结果做 fail-fast 非空断言（避免解析失败时 `toContainText("")` 恒真而静默通过）。

## L14 · 同一策略的 `tools` 与 `permission` 两个字段约定相反，改一个不够
`execution_policies.config` 里同时有：
- `tools` —— **只列放行**的工具（值为 `'allow'`）；未列 = 不放行；
- `permission` —— **只列拒绝**的工具（值为 `'deny'`）；未列 = 放行。
worker guard 的 `guard.roles[*].permission` 直接取 `config.permission`，而提示词抑制与能力点派生看 `config.tools`。
**改一个角色的工具授权必须两个字段同时改**（本例：tools 增 `allow` + permission **删** `deny` 键，注意不是置 allow）。
另外 seed 的 `upsert({ update: {} })` 有意不回滚存量行（保护运行时编辑）→ **存量库必须靠迁移补**。

## L15 · 迁移链是「当前态快照」，能力点变更必须同步改历史迁移 + 活基线
能力点矩阵的契约 spec 断言「**历史迁移的冻结字面量 ≡ 当前代码派生**」→ 改能力点必须同步：
① 边界单一源（src + seed 双写）②派生矩阵常量 ③迁移链里该角色的字面量 ④活基线 JSON（有官方再生成脚本，勿手改）
⑤快照（`jest -u`）⑥若干意向断言（旧的「plan 无该工具」断言改成「已具」，并把机制类断言改用仍缺该工具的角色继续锁）。
漏任何一环都会留下自相矛盾的红灯。历史证据目录（`vteam-role-behavior-abstraction`）是**只读**的，不要改。
