# Todo 14 — 隔离栈端到端实测结果 (W4)

- 日期: 2026-09-07/08 UTC+8 walkthrough `2026-09-07T18:04Z` 起
- 隔离串: `DATABASE_URL=mysql://root:***@127.0.0.1:13306/su_e2e`（前置守卫 `[[ $DATABASE_URL == *":13306/"* ]]`，全程日志可查）
- 后端: 当前树 `npm run build`（EXIT 0，见 `build-server.log`）→ `node dist/src/main.js` PORT=13100
- 前端: 当前树 `next dev -p 13101`，`API_PROXY_TARGET=http://localhost:13100`
- 详细命令+退出码: `walkthrough.log`；迁移/种子: `migrate.log` / `seed.log`（均 EXIT 0）

## 步骤表（HTTP 码 / 可见证据）

| # | 步骤 | HTTP | 证据 |
|---|------|------|------|
| 1 | 建团队 `su-e2e-team-*`（2 成员） | 初次 500（种子 `tum_admin_seed` 非数字后缀致 idGen 续号碰撞，见下）→ retry 201 `tm_0000000003` | `01-teams-list.png`, `04-teams-with-new-team.png`, `05-team-detail-task.png`, walkthrough.log |
| 2 | 建任务 `t_0000000001`（teamId 必填） | 201；建后 `sessions` 表 0 行（任务零会话写 ✓） | walkthrough.log（`mainAgentInstanceId:null`，与 Todo 2 一致） |
| 3 | 群 @ 执行 `@开发者-1` | 201，trigger `tmm_0000000009/no_session`；DM 触发后真实分派 `dispatched` + 建团队会话 `s_0000000001`（`team_id=tm_…3, team_member_id=tmm_…9, task_id=NULL` ✓） | `02-team-session-group.png`（群聊 @ 可见） |
| 3b | 回复到达（worker ingress 真实回流） | worker 注册 201；`message.part.delta` 202 → DM 落 agent 消息 `m_0000000003`（senderType=agent, status=processing） | `03-dm-agent-reply.png`（用户问 + agent 答同屏） |
| 4 | DM 私聊（teamMember 维度） | `dm-channels` 201 `c_0000000002`（taskId null ✓）；私聊消息 201 | 同上截图 |
| 5 | 记忆 team 写/读 | MCP `memory_save(level=team)` 200 → `me_0000000001`；`GET /memories?level=team` 200（taskId null, teamId 归属 ✓）；`level=task` 被 schema 层拒绝（JSON-RPC -32602 + 指引改用 team/global） | `06-memories-team.png`（团队记忆卡可见） |
| 6 | 验收归档 start→pending_review→completed→archived | 逐段 200（start 前需先设团队 mainAgent，首试 400 `MAIN_AGENT_NOT_SET` 后补设通过） | walkthrough.log（`status:archived`） |

## FAIL / 降级表

| 项 | 现象 | 判定 | 说明 |
|----|------|------|------|
| 建团队首试 500 | `tx.teamUserMember.create()` PRIMARY 冲突 | 非阻塞（retry-once 通过） | 根因：种子行 `tum_admin_seed` 非数字后缀，`seedPrefix` 取 `id desc` 首行解析失败→计数器从 0 起，与既有 `tum_0000000001` 碰撞。**产品侧 bug（种子/idGen 续号），不在本 Todo 修复范围（禁产品编辑），记录供后续 Todo/修复**。共享栈不受影响（其计数器进程内已续号）。 |
| 真实 LLM 执行 | 隔离栈无 worker/模型凭证 | 降级为仿真（已声明） | 用注册 worker `w_su_e2e` + 真实 `message.part.delta` ingress 路径回流 agent 回复；分派→团队会话→ingress→落库→广播全链路均为真实代码路径，仅 LLM 生成内容为仿真文本。 |
| `level=task` 负向 | 返回 JSON-RPC error（HTTP 信封 200）而非 HTTP 400 | 通过（语义等价） | MCP 传输约定：zod 校验在 JSON-RPC 层拒绝，`expected one of "team"\|"global"`；REST 语义的 400 `MEMORY_LEVEL_INVALID` 由 service 层对非-zod 路径保留。 |

## 共享栈未动验证

- `containers-pre.txt` vs `containers-post.txt`：compose 四件套（db/server/web/worker）全程 Up，未重启；仅多出 `su-e2e-db`（已清理，见下）。
- 共享 dev 库断言：`SELECT COUNT(*) FROM teams WHERE id='tm_0000000003' OR name LIKE 'su-e2e%'` → **0**。

## 测试数据残留（供后续清理）

- 全部测试数据仅存在于 scratch 库 `su_e2e`（随容器删除而消失）：团队 `tm_0000000003`、任务 `t_0000000001`(archived)、会话 `s_0000000001`、频道 `c_0000000001/02`、消息 `m_0000000001~03`、记忆 `me_0000000001`、worker `w_su_e2e`。
- 共享 dev 库 / compose 数据：零写入（上已证）。当前树产品文件：零修改（本 Todo 仅新增 `final/` 证据）。

## 清理收据（执行后填）

- server :13100 PID 已 kill；web :13101 已 kill；`docker rm -f su-e2e-db` 已执行；`docker ps` 复核无 su-* 残留。
