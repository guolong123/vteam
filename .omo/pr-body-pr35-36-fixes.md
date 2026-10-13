> ⚠️ **本 PR 取代 #35 与 #36**（cherry-pick 两者全部提交 + 评审修复）。请在 #35 / #36 上打「superseded by」标记，**不要**单独合并其中任何一个。

## 为什么合并成一个 PR

对 #35 与 #36 做了完整评审，发现 **1 个会导致部署失败的阻断项**和若干文档/边界问题。修复都落在原有改动上，拆开反而更难说清「哪个版本是可部署的」，故合成一个可独立评审、独立合并的 PR。

| 来源 | 提交 |
|---|---|
| #35 | `6ec2a1e` `cd3a29e` `fa44103` `8eaaa22` |
| #36 | `0f1e473` `cf6229d` `aaf1891` `7efed68` `29d94f5` `c44d46c` `22c65c6` |
| 本 PR 修复 | `7c45cad` `1f32364` |

cherry-pick **零冲突**，落地结果与两个原分支逐文件一致（27 files / +2614 −235）。

---

## 🔴 阻断项：#36 的迁移从未创建它自己要写入的列

`schema.prisma` 新增了 `AgentRole.capabilitiesConfiguredAt`，但：

- `agent_roles` 建表于 `20260925000000_squashed_baseline`，列清单里**没有**这一列；
- 新迁移 `20260929000000_capability_git_web_tier/migration.sql` 有 **11 条 UPDATE、零条 DDL**；
- 其最后一条打戳语句 `SET capabilities_configured_at = CURRENT_TIMESTAMP(3) WHERE ... capabilities_configured_at IS NULL` 直接引用该列。

`prisma migrate deploy` 会在此报 `ERROR 1054 Unknown column 'capabilities_configured_at'`。**Prisma 默认不给 MySQL 迁移包事务**，故前 10 条回填 UPDATE 不会回滚 —— 半迁移 DB + `_prisma_migrations` failed 行，需人工 `migrate resolve`；此后所有 Prisma 查询该列也一并失败。

**修法**：`7c45cad` 补 `ALTER TABLE agent_roles ADD COLUMN capabilities_configured_at datetime(3) DEFAULT NULL;`（必须排在全部 UPDATE 之前）。

### 为什么原 PR 的 11 条测试全绿却没抓到

那 11 条是**文本解析**测试：`readFileSync` → 剥 `--` 注释行 → 正则取出每键赋值 → 与 TS 常量比对。它校验 SQL **文本**与常量是否一致，**从不执行 SQL**，结构上不可能发现缺失的 DDL。「156 suites / 3605 tests 全绿」为真，且与本缺陷不矛盾。

故同提交补一条**真能抓**的 DDL 守卫：拿 `squashed_baseline` 的真实列清单对账 —— `SET` 到的每一列，要么建表时已存在，要么由本迁移 `ADD COLUMN` 补上。

> **变异验证**：删掉该 `ALTER TABLE` → 恰好 DDL 守卫转红，其余 11 条仍全绿。精确复现了原缺陷的盲区。

---

## 🟠 重要：#35 有一处注释描述了已被删除的安全门

`questions.service.ts` 的 `createSecretForPlatform` JSDoc 仍在写：

> 托管模式门：团队 managedMode=true **且发起人不是团队主 Agent** 时，在 agentQuestion.create **之前**拒绝……

而方法体内**没有任何 `managedModeOf` 调用、没有任何拒绝逻辑** —— `8eaaa22` 删了代码却留下了 `6ec2a1e` 的注释。`requesterInstanceId` 现在只写进 `content` JSON，不参与任何门禁。读这段注释的人会以为存在一道不存在的安全门。

`1f32364` 改为写明真实行为，并附一条信任链告警：`requesterInstanceId` 的来源是**客户端可控**的 `selfInstanceId` 回声，不是服务端推导的身份。当前无身份门依赖它（故无害），但将来若据它做授权判断须先消除该回声 —— 团队内可冒名他人 instance id。

---

## 🟡 次要：团队直聊可能造出永远送不到的孤儿行

团队维度下 `taskId` 落空串、`sessionId` 落 `mainAgentSessionOfTeam(...) ?? 's_placeholder'`。若团队尚无主 Agent 会话，两者皆为哨兵值，而 `teamId` 只能由二者反查 ⇒ `teamIdOf` 恒返回 `null`：

- 该行**永远送不到用户面前**，`resolve` / `expire` / `findAll` 也定位不到团队；
- 调用方**阻塞等待**，只能空等满 540s 输入预算再返回 `input_timeout`。

`1f32364` 改为解析不到会话即 **503 快速失败、不落占位行**。

与 `createForPlatform` 的不对称（那边占位符无害：question 行只等 worker 转发，无人应答走 TTL/expire 收敛）已写进代码注释，避免后来者「统一口径」时把 secret 路径改回去。

连带修一处**既有 mock 漏洞**：`questions.service.spec.ts` 有用例漏了 `mainAgentMemberId`，此前正是靠这个占位符兜底掩盖了。

## 🟡 次要：#35 的「归属改团队」表述有误导

PR 描述写「`teamId` 进 schema / `taskId` 降可选」，易被读成数据库变更。实际**本 PR 零 Prisma 改动**：

- 改的是**工具入参**（zod schema 新增 `teamId`、`taskId` 降可选）；
- `agent_questions.taskId` 仍 `NOT NULL`，表无 `teamId` 列；
- 团队归属一律经 `taskId` / `sessionId` **反查**（与本仓 questions 域既有口径一致）。

沿用「派生而非存储」是本仓既有约定，本身没问题；`1f32364` 在 `docs/secret-command-tool.md` 补了「归属如何落地：无 schema 变更」一节，并把「团队须已存在主 Agent 会话」写成明示前置条件。

---

## 评审中核实为无误的部分

- **default-allow 语义属实**：`isCapabilityGranted` = `matrix?.[key] !== false`，#36 全部设计（外部助手不写 `false`、存量行靠缺失即允许）都压在这条上，成立。
- **#36 迁移按键拆语句是必要的**：`JSON_CONTAINS_PATH(doc,'one',a,b,c)=0` 仅在三个键**全缺**时为真，一键存在就会跳过整行、另两键永久放行。注释解释到位，SQL 也照做了。
- **#35 超时层表是真派生的**：`layerBudgetTable()` 插值常量而非手抄。算术对得上：`server_max` = 540+300+5 = 845s；`total` 855s = 845 + 10s 传输裕量。
- **跨包契约测试是真的**：读 `worker/src/resources/injector.ts` 正则比对 `VTEAM_MCP_TIMEOUT_FLOOR_MS`（900000）与 `SECRET_COMMAND_CLIENT_TIMEOUT_FLOOR_MS`（900000）。缺文件时 `it.skip` 且 `console.warn`，不静默通过。
- **`disposition` 语义正确**：`executed = result !== undefined`，取消 / input_timeout / 下发前断开都正确落到 `not_executed`。
- **在飞门无泄漏**：`set` 在 `try` 前，`delete` + `clearInterval` 在 `finally`。
- **复用 `resolveExecContext` 是对的**：与其余工具共用同一套身份解析与 `t_`/`tm_` 前缀守卫，未另开第二条链路。

## B1 风险决策（沿用 #35，未改动）

`resolveExecContext` 仍要求存在匹配 `(teamId, workerId, callerId)` 的真实 `session` 行，故残余是**团队内任意 Agent**，而非任何人。与 #35 描述一致。代码与文档均未将其表述为安全保证。

---

## 验证

| 项 | 结果 |
|---|---|
| 全量测试 | **158 suites / 3652 tests 全绿**（原 2 PR 基线 156/3605） |
| `tsc --noEmit` | **exit 0**，零错误 |
| eslint | **0 errors / 66 warnings**，与 `main` @ `a73aaa3` 基线逐条一致，未新增 |
| prettier | 本次改动文件全绿 |
| DDL 变异验证 | 删 `ALTER TABLE` → 恰好 1 条红 |

> 注：`tsc` 需先 `npx prisma generate`（新列在生成类型中才有）。原 2 PR 的验证记录未提及此步。

## Reviewer 注意事项

- 本 PR **取代** #35 / #36，两者的评审意见请直接提在此处。
- `resolveExecContext` / `assertWorkerTeam` / `ExecContext` / `callerTrusted` **未被本 PR 改动**（红线）。涉及行号请以**符号名**为准。
- #35 实施计划 v2.6 中 T2/T3 已整块作废（M81/M87），其行号引用不再有效。
