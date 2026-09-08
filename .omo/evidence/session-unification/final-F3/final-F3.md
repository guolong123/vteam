# F3 — 真实 QA 通关（隔离栈实测）

- 日期: 2026-09-07/08（walkthrough `2026-09-07T18:46Z` 起，follow-up `18:47Z`，confirm `18:48Z`）
- 隔离串: `DATABASE_URL=mysql://root:***@127.0.0.1:13306/su_e2e`（每脚本前置 `[[ $DATABASE_URL == *":13306/"* ]] || exit 1`，见 `walkthrough.log` 首行 `GUARD PASS`）
- 后端: 当前树 `npm run build`（EXIT 0）→ `node dist/src/main.js` PORT=13100（`MODEL_CREDENTIAL_KEY` 为 scratch 随机 32 字节；`WORKER_TOKEN` 取自 `server/.env`，未改动该文件）
- 前端: 当前树 `next dev -p 13101`，`API_PROXY_TARGET=http://localhost:13100`
- 备份路径（Todo 6 留存）: `.omo/evidence/session-unification/su6-backup-20260907-213137.sql`
- 证据目录: `.omo/evidence/session-unification/final-F3/`（`walkthrough.log` 含全部 HTTP 码 + 响应体；`walkthrough.sh`/`walkthrough2.sh` 为可重放脚本）

## VERDICT: APPROVE（复验证通过）

初验 REJECT 依据的 `resetMemberSession` 缺 `teamId` 缺陷已修复（`teams.service.ts` replacement
`create` 现写 `teamId`；`teamMemberKey` 为 STORED 生成列，随 `team_id` 自动派生，无需应用层另写）。
本轮在全新 scratch 栈（`su-f3r-db` :13306，已清理）重跑 CONFIRM-2/CONFIRM-4，全部转绿（`reverify.log` +
`reverify.sh`）。原 headline 链路结论维持（不受本次修复影响，未重跑）。

## 复验证（2026-09-07T18:55Z，新 scratch 栈 `su_e2e` @ :13306）

| 确认项 | 结果 | 证据 |
|---|---|---|
| RESET 新行团队维度 | 201；行 `team_id=tm_0000000002`，`team_member_key=tm_0000000002\|tmm_0000000007` 自动派生 ✓ | `reverify.log` RESET + DB 行 |
| CONFIRM-2：reset 行 pickup 后 `memory_save(level=team)` | **200 result** `me_0000000001`（原 403）；`GET /memories?level=team` **200 total=1**，`sessionId=s_0000000002`（即 reset 行）✓ | `reverify.log` CONFIRM-2 |
| CONFIRM-4：同成员再次 DM 分派 | **201**，trigger `sessionId=s_0000000002` **与 reset 行相同（REUSE_OK）**；该成员会话行数 **1**，无孤儿 ✓ | `reverify.log` CONFIRM-4 |
| 共享栈 | compose 仅 uptime 推进、无重启；dev 库 `1/3/20` 不变、`f3r_leak=0` | `compose-pre-r/post-r.txt` |
| 清理 | server :13100 DOWN；`docker rm -f su-f3r-db`；无 `su-*` 残留 | 本节 + shell 收据 |

观察（非阻断，未立缺陷）：CONFIRM-4 重分派后该行 `status=created/worker_id=NULL`
（此前模拟 pickup 置过 `running/w_su_f3r`）。复用判定与落库键均正确，状态列语义属分派侧已有行为，
超出本次确认范围，仅记录。

## VERDICT 历史：初验 REJECT（条件性 — 已满足）

 headline 链路全绿，但深度路径（reset route + managedMode/MCP 交叉）发现一个 plan-scope 内真实缺陷：
 `POST /teams/:id/members/:memberId/reset-session` 建出的新会话行缺 `teamId`/`teamMemberKey`，
 导致该成员后续 MCP 团队工具恒 403 且下一次分派产生孤儿行（D3 单成员单会话被破坏）。
 复修指针：`server/src/teams/teams.service.ts` `resetMemberSession` 的 `tx.session.create`
 补 `teamId` + `teamMemberKey: ${teamId}|${memberId}`（对齐 `ensureTeamSession` 的 teamId-必填规则），
 然后重跑本目录 `CONFIRM-2`/`CONFIRM-4` 断言。修完可转 APPROVE。

## 步骤表（HTTP 码 / 证据）

| # | 步骤 | 结果 | 证据 |
|---|------|------|------|
| 0 | migrate deploy + seed（当前树，scratch） | 均 EXIT 0 | `migrate.log` / `seed.log` |
| 1 | 建团队（含产品经理-1 + 开发者-1） | **首试 201** `tm_0000000003`（T15 种子修复验证通过，无需 retry） | `walkthrough.log` STEP1, `f3-01-teams-list.png` |
| 1b | GET 团队 + `channels?teamId=` | 200；`team_group` 行 `taskId:null` ✓ | log |
| 2 | 建任务（teamId 必填） | 201；`mainAgentInstanceId:null`；fresh-DB `sessions WHERE task_id IS NOT NULL` → **0** ✓ | log |
| 3 | 群 @ 消息 `@开发者-1` + taskId 分区 | 201，trigger `tmm_0000000009/no_session` | log, `f3-02-team-session-group.png`（群聊 @ 可见 + “会话运行中…”） |
| 4 | DM 建频道 + 私聊消息 | 201 `c_0000000004`（taskId null ✓）；201 `dispatched` + 建团队会话 `s_0000000003` | log, `f3-03-dm-agent-reply.png`（用户问 + agent 答同屏） |
| 3b | worker 注册 + `message.part.delta` ×2 | 注册 201；delta **202/202**；DM 落 agent `processing` 消息，parts 累积 `[reasoning, text×2, tool]` 全保留 ✓（DM streaming 深度） | log follow-up |
| 4b | `session-history` + SSE | 200 `source:db`；SSE `GET /events?token=<jwt>` 200 流式（首探 Authorization-header 401 系探针写法错，`?token=` 为约定实现，见 realtime.controller 注释） | log |
| R | 新重置路由 | **201** 新行 `s_0000000004`（`taskId/taskAgentId:null` ✓，旧行已删） | log STEP-R |
| R-neg | 旧任务路由 + 未知成员 | **404** `Cannot POST /api/v1/tasks/.../reset-session`；**404** `MEMBER_NOT_FOUND` ✓ | log |
| M | managedMode 团队开关 | PATCH → `true`；GET → `true` ✓（开关落团队行） | log STEP-M |
| 5 | MCP `memory_save(level=team)` | **403** `PLATFORM_MCP_FORBIDDEN`（见 §缺陷；`x-worker-id` 缺失首探 403 属探针问题，已纠正） | log |
| 5-neg | `level=task` | JSON-RPC **-32602**（HTTP 信封 200，MCP 传输约定；T14 一致） | log |
| 6 | `start` 未设主 Agent | **400** `MAIN_AGENT_NOT_SET` ✓（负向） | log |
| 6 | 设主 Agent → start→pending_review→accept→archive | 201 ×4：`in_progress → pending_review → completed → archived` ✓ | log + DB 终态 |
| 终 | fresh-DB 断言 | `task_sessions=0`；`t_0000000002=archived`；`task_agents` 表不存在（migrate 输出含 drop-task-agent-domain） | log |

## 缺陷（REJECT 依据，隔离栈实证）

**`resetMemberSession` 新建行缺团队维度**（`server/src/teams/teams.service.ts:911-920`：create 仅含
`id/taskId:null/agentId/teamMemberId/status`，无 `teamId`/`teamMemberKey`；而
`ensureTeamSession` 要求 teamId 必填、`bind` 缺 teamId/teamMemberId 即 404）：

1. `CONFIRM-2`：reset 行模拟 worker pickup（`worker_id=w_su_f3, status=running`，scratch-only，T14 同款声明仿真）
   后重试 `memory_save(level=team)` → 仍 **403** `selfInstanceId（tmm_0000000009）不是该团队的会话成员`
   （`assertWorkerTeam` 按 `teamId+workerId+teamMemberId` 匹配，行 `team_id=NULL` 永不命中）。
   影响面：该成员 reset 后全部 MCP 团队工具不可用；同理 `questions.managedModeOf/scopeOf` 经
   `session.teamId` 读团队行路径对 reset 会话失效（代码级影响，未另起 question 行验证）。
2. `CONFIRM-4`：同成员下一次 DM 分派 → 新建 `s_0000000005`（`team_id` 正常），而孤儿
   `s_0000000004`（`team_id NULL`）残留 — 同一成员两会话行，D3 单成员单会话被破坏。

## 测试套件

- `npm run test`（scratch DATABASE_URL）：1827 中 **1802 通过 / 25 失败**（`tests.log`, TESTS_EXIT:1）。
  失败 6 套件：`workers.service`（git 凭证 mock）、`models.service`/`models.controller`、
  `docs-mirror.service`、`git-repos.controller`、`agent.constants` — 全部非 session-unification 域。
- stash 证伪：`git stash push -- server web worker` 后重跑该 6 套件 → **同样 25 失败**（`stash-proof.log`），
   pristine HEAD 预存失败；`git stash pop` 已恢复（134 文件）。符合 plan “预存失败逐项 stash 证伪”。
- `npm run test:e2e`：**11/11 通过**（`tests-e2e.log`, E2E_EXIT:0）。
- `tsc`：本次 F3 未重跑（以 F2 证据为准；本任务零产品文件修改）。

## 控制台错误分诊（截图走查）

1. `GET /api/v1/plans?taskId=<无计划任务>` → **404** `PLAN_NOT_FOUND("该任务尚无执行计划")`：
   当前树行为（零产品修改 = 预存），团队会话页每次加载触发一次 console error。
   非 session-unification 回归（Todo 8 保持该契约），但前端应按空态容忍而非打 error 日志 — 列为预存噪音，不挡 verdict。
2. 其余页面：团队详情页 0 errors。

## Flaky / 对抗项说明

- `stale_state`：scratch 库两次重建（`DROP+CREATE` 后 migrate+seed），fresh-DB 断言（task_sessions=0）首尾各一次。
- `dirty_worktree`：执行前产品树已脏（134 文件，plan 实现未提交）；本任务**零产品文件修改**
  （仅新增 `final-F3/` 证据 + notepad 一行），`git status` 可验。
- `misleading_success_output`：所有 PASS 均附响应体 + HTTP 码 + DB 行（log 全文）；403/404/400 负向逐项贴 body。
- `flaky_tests`：首轮 worker/MCP 401 系探针 token 取值错（`.env` 引号未剥），修正后一次通过；
  建团队首试 201（T15 生效），无 retry；无未解释的偶发失败。

## 共享栈未动验证（pre/post）

- `compose-pre.txt` vs `compose-post.txt`：`diff` 无差异（db/server/web/worker 全程 Up 未重启）。
- 共享 dev 库（只读 SELECT）：pre `teams=1 tasks=3 sessions=20` → post 相同 + `f3_leak=0`。

## 清理收据

- server :13100 已 kill（`port13100:DOWN`）；web :13101 已 kill（`port13101:DOWN`）。
- `docker rm -f su-f3-db` 已执行；`docker ps` 无 `su-*` 残留；compose 四件套 healthy。
- 测试数据仅存在过 scratch 库（随容器删除消失）。

## 截图清单

`f3-01-teams-list.png`（团队列表含新团队）· `f3-02-team-session-group.png`（群 @ + 运行态）·
`f3-03-dm-agent-reply.png`（私聊问答同屏）· `f3-04-memories.png`（记忆页空态 — 写路径被 §缺陷 403 阻断，诚实留空）·
`f3-05-team-detail-task.png`（团队详情任务卡）。
