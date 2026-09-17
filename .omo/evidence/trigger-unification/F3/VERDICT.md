# F3 真实手工 QA — VERDICT: PASS（带一条诚实注记）

- 评审人：F3（unspecified-high，真机实跑，非代码评审）
- 时间：2026-09-17 03:56–04:19Z；栈：docker compose 全活（db/server/web/worker，server 为 baked 镜像，未改一行产品代码）
- 调用路径：全部经真实 `POST /api/v1/platform-mcp`（`X-Worker-Token: compose-worker-token` + `x-worker-id: w_compose_worker`）调 `hook_register`；何处走了直写 DB 均已如实标注
- 证据目录：`.omo/evidence/trigger-unification/F3/`（本文件 + A1–A7、B1–B11、B2B3、B4 共 30 个 artifact）

## 总 verdict：PASS

两条旗舰链路均为**真 agent wake**（真模型 turn，非仅行终态）；四个边界全部按设计行为实锤；DB 回到基线。

## 分项结果表

| 流/边界 | 方法 | artifact | 结论 |
|---|---|---|---|
| Flow A：time hook 重启存活 | MCP 注册（delayMs=150s，due 03:59:14Z）→ 双行 SELECT → `restart server`（03:56:48Z，~20s healthy）→ 到点 | A1-register.json / A2-rows-before-restart.txt / A3-after-due.txt / A4-events.txt / A5-messages.txt / A6-sidecars.txt / A7-cleanup.txt | **PASS**：hook fired(1) + trigger fired(1/1/NULL) + `trigger.fired` 事件 + session running→idle + 真 wake 回复（含 `[hook:time hks_0000000001]` 前缀，wakeText 进 prompt 实锤） |
| Flow B：all_idle 静默唤醒 | MCP 注册 team 域 hook（grace=240000ms=4min 缺省）→ 确认全局 `hook_poll:global:all_idle`（tmr_0000000129，fire_count 55→59 ticking）→ 伪 running 删后次轮唤醒 | B1-register.json / B2-rows.txt / B9-flowB-wake.txt / B10-sidecars.txt / B11-cleanup.txt | **PASS**：hook fired(1) + `trigger.fired` + 真 wake turn（activity 04:09:09，消息点名 hks_0000000002） |
| B1 忙时不误醒 | 伪 running 会话 `s_probe_f3b1`（直写 DB，已标注）分两层验证 | B3/B4/B5-veto2/3.txt / B6-b1-register.json / B7-b1-veto.txt / B8-b1-skipped-event.txt | **PASS**：(1) 队内 running → team 域 poll 静默跳过（pending/NULL/零分派，符合 hook.service.ts:603-604“非否决不写 skipReason”）；(2) task 域 hook + busy target → `skipReason=veto: 会话 s_probe_f3b1 仍 running（mid-turn，不唤醒）` + busyRetries=1 + 零分派 + `trigger.skipped` 事件 |
| B2 overdue 重启只补一次 | 3×MCP time hook（1 有效目标 + 2 无会话目标）→ 双表 due 回拨 NOW-2min（直写，已标注）→ restart → 43s 内结算 | B2-register.json / B2B3-before-restart.txt / B2B3-after.txt / B2B3-events.txt | **PASS**：恰好 1×`trigger.fired` + 2×`trigger.expired`（skipReason=会话已重置/缺失），各 trigger attempts=1/fire_count=1，无重复 |
| B3 interval 不追赶 | 探针 `tmr_probe_f3b3`（直写，已标注：hook_poll/interval 60s/next 10min 前/fire_count=5，空载 poll 无副作用）随 B2 同次重启 | B2B3-before-restart.txt / B2B3-after.txt | **PASS**：未 5→15；attempts=2（仅 2 次认领），next_fire_at=04:18:55≈now+ 重算（非旧值 04:05:36 累加），fire_count 5→7 = 1 次补发 + 正常周期触发 |
| B4 环路防护 | (a) 同 task 交替目标连注 7 次（MCP）；(b) SQL 克隆第 6 血缘行（直写，已标注）测 fire 侧 backstop | B4-budget-register.json / B4-budget-fire.txt / B4-budget-firecut.txt / B4-survey.txt | **PASS**：(a) 第 6/7 次注册被拒 `[400] 任务 t_0000000001 wake 预算耗尽（fired+pending=5 >= 预算 5，防无界唤醒环）`；(b) lineage=6>5 的 overdue 行被改判 `expired` + skipReason（预算耗尽…放弃唤醒）+ 零分派 |

## 清理收据（before → after）

- 开工基线：hooks 0 / triggers 28（00-baseline.txt）
- 收工：hooks **0** / triggers **28**；F3 探针会话 0 行；探针消息/事件（含 sidecar `session_idle_scan` 行）逐项物理删除并复查 0 残留（A7/B11/B4/B2B3-cleanup.txt + 靶向 `my_left=0` 查询）
- 未启动任何自有容器/进程/端口；仅对既有 server 做两次 `restart`（03:56:48Z、04:15:36Z），收工时全栈 healthy
- 副作用诚实记录：真 wake turn 落的群/私聊消息与 sidecar 行已删；`trigger.fired/skipped/expired` 探针事件已删（内容留存于 artifact 文件）；realtime_events 历史大表未动（仅删探针行）

## 注记（非 bug，行为符合设计，F1 可对照）

1. DB 层 busy（scope 内有 running）走**静默跳过、不写 skipReason**（hook.service.ts:603-604 明示）；`skipReason` 只在内存/target 否决、超时、目标失效三类路径写。F3 任务书中“veto 写 skipReason”对应的是第二层，B7/B8 已实锤该层。
2. MCP `hook_register` 不收 `parentHookId`，故**无血缘 fresh ping-pong 在 hook 层不可见**（todo-19 已自承此残余风险，由 scope cap 20 + TTL 封顶）。B4 实锤的是真正兜底它的 per-task 预算（注册拒 + fire 熔断双重），pair 语义的 `detectHookCycle` 对穿拒绝仅被单测覆盖、本次未在生产路径复现（需 wake 轮内续注册的 agent 配合，超出 F3 可控范围）。
3. B4 fire 侧观察到 claim-then-cut：探针 trigger 行先 `fired(1)`、hook 行 `expired`。终态语义正确（hook 不唤醒），但 trigger/hook 终态不对称，排查时以 hook 行为准。
