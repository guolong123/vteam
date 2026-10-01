# 上线 runbook：长期值班任务（`tasks.long_running`）

本文档是 `tasks.long_running` 列（迁移 `20261001000000_task_long_running`）的上线操作手册。

- **谁需要读**：负责本次上线的运维。
- **作用域**：只讲「怎么把一个既有任务标记为长期值班任务」以及「出问题时怎么退」。功能语义见 `docs/agent-platform/13-任务状态机与全生命周期.md` §2.1 与 `28-团队模型与排队设计.md` §3.1。
- **占位符约定**：本文中 `<值班任务 id>` / `<teamId>` / `<RELEASE>` 均为**运维输入**。这些值不在仓库里可核实——形如 `t_` 前缀的 id 在代码中只作为单测夹具出现（`server/src/tasks/tasks.service.spec.ts`），`server/prisma/seed.ts` 里并没有对应行。上线前请从实际业务侧确认目标任务。

---

## 一、这个标记改变了什么

`long_running = true` 的任务**常驻 `in_progress`、按定义没有终态**（典型：值班群 / On-call）。对它的行为变更：

| 方面 | 变更 |
|---|---|
| 进度巡检 | 不再排期。不被唤醒、不因「无进展」自动置阻塞、群里不再发 `【任务停滞】` 公告 |
| Agent 提交验收 | `task_transition mark-pending-review` 返 **403** `TASK_AGENT_COMPLETION_FORBIDDEN`（防止一句「今天值班结束」让任务自己交差消失） |
| 人工操作 | **完全不受影响**：`mark-pending-review` / `accept` / `archive` / `block` / `resume` 照旧可用 |
| 删除 | 额外允许硬删 `in_progress` 状态的任务 |

> 门禁只作用于 **agent 的终态动作**。agent 仍可调 `task_transition block` / `resume`，
> 即它**能把值班任务推到 `blocked`**，而 `blocked` 任务不受巡检管辖、也没有停滞公告——
> 需人工 `resume` 才恢复。这是有意保留的（`block` 非终态、且人工可逆），但值班群不会
> 自己说「我卡住了」，请留意。
>
> 由此还有一条：硬删值班任务会连带删掉它的 `sessions` 行，但**不**停 worker、不关 SSE/
> realtime。若删除时该任务正有活跃会话，worker 后续的状态写入会报 P2025 使该轮出错，
> 且它仍会往团队群频道（频道保留、只解绑 taskId）继续输出。删前请确认任务处于静默状态。

> ⚠️ **这是一刀切豁免，不是「更温和的看门狗」**。该任务真卡死时看门狗也不会自动阻塞，需人工巡看。选 `true` 前请确认这一点可接受。

---

## 二、上线顺序（不可颠倒）

```bash
# 1) 迁移先行
cd server && npx prisma migrate deploy

# 2) 确认迁移真的落库（见 §3 的人工校验，部署脚本不保证这一点）
#    _prisma_migrations 无 failed 行；且 tasks.long_running 列已存在

# 3) 应用代码上线（含 prisma generate 产物）
bash scripts/deploy-k8s.sh <RELEASE>

# 4) 标记值班任务
UPDATE tasks SET long_running = 1 WHERE id = '<值班任务 id>';

# 5) 恢复任务（若它此前被看门狗置为 blocked）
POST /api/v1/tasks/<值班任务 id>/resume
```

**第 4 步与第 5 步的顺序不可颠倒。** 若先 `resume`：该任务此刻仍是普通任务，看门狗会在 30 分钟内（3 轮 × 10min）再次判定停滞并重新置阻塞——你会被同一个告警再打一次。

---

## 三、⚠️ 部署脚本不保证「迁移先于应用」

`scripts/deploy-k8s.sh:417-422` 等待 init job：

```bash
if kubectl wait --for=condition=complete "job/${RELEASE}-init" ... ; then
  ok "init job 完成"
else
  warn "init job 未在 300s 内 complete（可能在跑或失败）"   # ← 只 warn
fi
```

**`else` 分支只 warn 不退出**；随后 `:426` 的 `kubectl rollout status deploy/${RELEASE}-server … || warn` 照常执行。`set -euo pipefail`（`:58`）在条件语境里无效。

⇒ **「迁移先于应用启动」靠人工纪律，不是脚本结构性强制。** 迁移失败时会带着 `Unknown column 'long_running'` 把应用 rollout 完。

### rollout 前的人工校验（必做）

```sql
-- ① 没有 failed 的迁移行
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
-- 期望：空集

-- ② 列已存在
SHOW COLUMNS FROM tasks LIKE 'long_running';
-- 期望：long_running | tinyint(1) | NO | PRI | | default false
```

任一不满足：**停止 rollout**，先修迁移。**本 PR 不修改 `deploy-k8s.sh`**（改部署脚本不在本次范围）。

### `prisma migrate deploy` 的失败恢复

`prisma migrate deploy` **不**把 MySQL DDL 包进事务。失败会在 `_prisma_migrations` 留一条 `finished_at IS NULL` 的行，导致后续每次 deploy 都重试该迁移并失败。

```bash
npx prisma migrate resolve --applied 20261001000000_task_long_running   # 确认已落库后
npx prisma migrate resolve --rolled-back 20261001000000_task_long_running # 确认未落库后
```

本迁移只含一条 `ALTER TABLE ... ADD COLUMN`，在 MySQL 8 中本身原子，风险低。

---

## 四、回滚

| 范围 | 操作 | 可逆性 |
|---|---|---|
| 只回滚标记（推荐） | `UPDATE tasks SET long_running = 0 WHERE id = '<值班任务 id>';` | 值可逆，**但看门狗不会自动恢复**——见下方警告 |
| 回滚代码 | 部署上一版 server 镜像 | 可逆；旧代码不读该列，多余列无害 |
| 回滚列 | **不可逆** | 仓库无 down-migration 约定（`docs/tech-debt-rollback.md`），删列只能 dump-restore |

> ⚠️ **清标记 ≠ 恢复看门狗管辖。** `TasksService.update()` 写 `longRunning` 时**不会**调用
> `progression.register()`（`tasks.service.ts:701-736`），所以 `1 → 0` 这个方向没有重排钩子。
> 清掉标记后，巡检行要等到下列任一条件才会重建：
>
> 1. **重启 server**（`restoreInProgressTasks` 在 `onModuleInit` 重建），或
> 2. 该任务**重新进入 `in_progress`**（例如先 `block` 再 `resume`）。
>
> 在此之前该任务**不受停滞保护**，且界面上没有任何提示。做回滚时必须显式执行其中一步，
> 否则等于用一个静默失效换掉一个显式告警。

若因回滚标记导致任务被重新置阻塞：`POST /api/v1/tasks/<id>/resume`。

---

## 五、已知局限（有意接受）

### L1 — 硬删值班任务会让同团队的 `queued` 行成为孤儿

`remove()` 会删掉该任务的 `teamQueue` 行并把 `teams.current_task_id` 置空，但**从不调用 `promoteNextInTx`**。删掉值班任务后：团队 `current_task_id = null` + 若干永无人提升的 `queued` 行；而 `createTaskInternal`（`tasks.service.ts:359`，`isIdle = !team.currentTaskId`）会把该团队读成**空闲**，让新任务插队。

**今天影响面小，只因值班团队恰好只有这一个任务**——这是本设计的使用前提。一旦有人往该团队加第二个任务即成活 bug。

#### ⚠️ 修复手段：无自助入口，需人工 SQL

`TasksService.promoteNext(teamId)`（`tasks.service.ts:651`）虽是 `public`，但**既无 HTTP 路由、也无生产调用方**：

- `grep -rn promote server/src --include='*.controller.ts'` → 零命中。`teams.controller.ts` 只暴露 `@Post(':id/queue')`（把 pending 任务追加进队）与 `@Delete(':id/queue/:taskId')`（取消排队），**没有 promote-next**。按 `POST /api/v1/teams/<teamId>/promote-next` 调用只会得到 404。
- 生产路径上它只被 `accept`/`reject`/`archive` 三个迁移内部经 `promoteNextInTx` 间接调用（`tasks.service.ts:1126/1144/1189`）——而这正是本改动**没有**加到 `remove()` 的那一步。

所以**没有「无需改代码」的 HTTP 修复路径**。确认孤儿后，在停机窗口内直接改库把队首拉起：

```sql
-- ① 看清现场
SELECT id, current_task_id FROM teams WHERE id = '<teamId>';
SELECT task_id, position FROM team_queues WHERE team_id = '<teamId>' ORDER BY position;

-- ② 队首行提为 pending（current_task_id 为 NULL，故不会被顶掉）
START TRANSACTION;
UPDATE tasks SET status = 'pending'
 WHERE id = (SELECT task_id FROM team_queues
              WHERE team_id = '<teamId>' ORDER BY position LIMIT 1);
UPDATE team_queues SET position = position - 1
 WHERE team_id = '<teamId>' AND position > 1;
DELETE FROM team_queues
 WHERE team_id = '<teamId>'
   AND task_id = (SELECT id FROM tasks WHERE status = 'pending' LIMIT 1);
UPDATE teams SET current_task_id = (
  SELECT id FROM tasks WHERE team_id = '<teamId>' AND status = 'pending' LIMIT 1
) WHERE id = '<teamId>';
COMMIT;
```

改完调 `POST /api/v1/tasks/<队首 id>/start` 拉起。**操作前先 `SELECT` 核对，`team_queues` 的 position 重排是本仓既有语义**（见 `promoteNextInTx` 的实现，`tasks.service.ts:560`），照抄其规则即可。

**根治**需要改 `remove()`（删完调一次 `promoteNext`）**并**为它加 HTTP 路由——前者会给「不改队列逻辑」的红线开口子，后者超出本 PR 范围。故本 PR 不做，改以本文档 + 数据库操作兜底。

另有一处影响有界的同类孤儿：`remove()` 也不删那条 `payload.taskId` 指向被删任务的 `progression_patrol` 触发器行。该行会经 `handleProgressionFire` 的 `!task → {expire:true}` 自毁，收窄后的启动清扫也会取消它（已删任务不是 `in_progress`），无需处理。

### L2 — 零回填，需逐个显式设置

迁移**不做任何数据回填**（`DEFAULT false`，存量行一律非长期任务）。除被显式指定的那一个值班任务外，任何已存在的常驻任务都不会自动被豁免，需逐个执行 §2 第 4 步。

这是刻意的：`status` / `title` / `priority` 都推不出「常驻值班」，而错标 `true` 会永久关掉真任务的停滞保护、且不可逆。

### L3 — 改标记不主动注销遗留巡检行

`longRunning` 翻 true 时**不会**立刻取消已存在的 `progression_patrol` 触发器行。该行会在下次到期时被 `handleProgressionFire` 的 `{expire:true}` 自毁——**最长一个巡检间隔（10min）**。

急需立即生效时手工取消：

```sql
UPDATE triggers SET status = 'cancelled'
WHERE kind = 'progression_patrol' AND status = 'pending'
  AND JSON_EXTRACT(payload, '$.taskId') = '<值班任务 id>';
```

（注意 `GET /api/v1/triggers` **不返回** `payload` 字段——`TriggersService.toItem`（`server/src/timers/triggers.service.ts:315-333`）的返回体里没有它，所以只能走 SQL。）

### L4 — 长驻会话判死不在本次范围

值班会话闲置数日后，`worker-dispatcher.ts:4025` 的**空闲扫描**可能判定会话死亡（只写 `Session.status`，不改 Task）。它与本次改动无关，也未因本改动获得豁免。若上线后出现值班会话被判死，**另开 issue**，不要在本次范围内扩。

---

## 六、验证清单

上线后按序确认（全部可在管理界面或 SQL 观察）：

| # | 检查 | 期望 |
|---|---|---|
| 1 | `SHOW COLUMNS FROM tasks LIKE 'long_running'` | 存在，`default false` |
| 2 | `SELECT id, status, long_running FROM tasks WHERE id = '<值班任务 id>'` | `in_progress` / `1` |
| 3 | 跨 **≥3 个巡检周期**（≥30min）观察该任务 | 状态恒为 `in_progress`；群里无 `【任务停滞】` |
| 4 | `SELECT kind, status FROM triggers WHERE kind='progression_patrol' AND status='pending'` | 无该任务的 pending 行 |
| 5 | 让 agent 调 `task_transition mark-pending-review` | 403，消息含「长期值班任务…不要重复调用」 |
| 6 | 人工走 `mark-pending-review → accept → archive` | 三步均成功，状态依次 `pending_review` → `completed` → `archived` |

第 4 项的**反向验证**（确认巡检确实在跑、不是本就没跑）：把标记置 0、恢复任务，跨 3 个周期应重新看到 `【任务停滞】`。**做这一步前先确认该任务无 `in_progress` issue 且任务分区连续 10min 无新消息**——`hasInflightWork`（`task-progression.scheduler.ts:641`）在这两个条件任一成立时会**递延**（`quietStreak` 清零并 return，永不置阻塞），那是正常行为不是缺陷。递延发生时看日志行：

```
[progression] taskId=<id> 连续 3 轮无进展，触发停滞处理
```

该行（`task-progression.scheduler.ts:585-588`）紧接 `fireStallDetected` 之前打出，同时含 quietStreak 值与回调已触发的证据。群里的 `【任务停滞】` 只是它的表象。
