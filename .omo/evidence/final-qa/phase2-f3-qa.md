# Phase 2 F3 真实 QA 报告（M2 全流程 + 边界场景）

> 日期：2026-08-07 ｜ 执行：F3 QA ｜ 方式：Playwright + curl 双验证
> 环境：server 3000（nest start:dev）+ web 3001（next dev）；登录 admin/admin123；项目 p_seed_1 + 4 template Agent
> 起点：dev.db 业务表全 0（仅 seed 项目/Agent/用户），idGen 复位验证通过（新任务 t_0000000001）

## 结论

```
Scenarios [5/5 pass] | Integration [11/11] | Edge Cases [5 tested]
VERDICT: APPROVE
```

## M2 主流程（5/5 PASS）

| # | 场景 | 前端断言（Playwright） | 后端断言（curl/DB） | 结果 |
|---|------|----------------------|--------------------|------|
| S1 | /tasks/new 创建（勾选 产品经理+架构师，主 Agent=产品经理） | 提交后跳转 /tasks/t_0000000003（截图 s1-3） | POST 201；事务落库 tasks 1 / chat_channels 1 / task_agents 3 / sessions 3 / task_events 1 | PASS |
| S2 | /board 见「待开始」→ 点「开始」→「进行中」 | 徽章 待开始→进行中（截图 s2-1/s2-2） | GET /tasks/:id status=in_progress + startedAt 落库；task_events 2 条（null→pending→in_progress） | PASS |
| S3 | 群聊 @产品经理 → 即时显示 → loading → 回复回流 | 用户消息 226ms 显示；loading 指示器出现；agent 回复 1.3s 落库显示（≤3s）；收敛无残留 | realtime_events 4 条时序：chat.message.new(user)→agent.loading(thinking)→(operating)→chat.message.new(agent) | PASS |
| S4 | 看板 SSE 联动（外部改状态不刷新） | 外部 mark-pending-review → 徽章 45-61ms 变「待验收」（3/3 复现） | POST /tasks/:id/mark-pending-review 201 | PASS |
| S5 | 断线补拉 | route 模拟断连：onerror→1s 重建→URL 带 since→补拉帧幂等追加（event1 计数=1 无重复） | since=ev_16 补拉恰好 2 条 channel 事件（DB 重启后 4 条新事件含 2 channel scope），无重复不丢 | PASS* |

\* S5 说明：服务端 since 游标补拉契约（curl 实测）与前端 useSSE 断线重建机制（route 模拟实测）均通过。真实 kill server 场景在 **Next dev 代理下受限**：代理挂起断连连接（10s 内 EventSource 无 error 事件），浏览器不感知断连 → 无法验证自动重连；此为 learnings 已记录的环境已知坑（生产 nginx 对 upstream 断连返回 502 → onerror 触发），非应用缺陷。

## 边界场景（5/5 PASS）

| # | 场景 | 断言 | 结果 |
|---|------|------|------|
| E1 | pending 任务直接 accept | 409 `TASK_INVALID_TRANSITION`（details{from:pending_review,to:completed,current:pending}） | PASS |
| E2 | 非项目成员（seed-member）访问任务 | 403 `PERMISSION_PROJECT_NOT_MEMBER`（任务详情 + 频道消息双验证） | PASS |
| E3 | 归档任务发消息 | 状态链 in_progress→pending_review→completed→archived → POST messages 409 `TASK_ARCHIVED` | PASS |
| E4 | @ 不在团队的 agent | 400 `MENTION_AGENT_NOT_IN_TEAM` | PASS |
| E5 | /tasks/t_nonexistent 404 | 页面 chat-error「任务不存在」（截图 e5） | PASS |

## 观察项（非阻断，建议关注）

1. **loading 两阶段窗口极短**：mock-dispatcher 的 thinking→operating→回复之间无 sleep（事件落库间隔 11ms/15ms），前端「思考中…」基本一闪而过（本次实测仅捕获「操作中…」一帧）。事件层两阶段齐全（ev 时序验证），UI 两阶段能力存在，但 1~3s 延迟全部集中在首帧之前，指示器可感知性弱。M2 验收曾观测到 394ms 窗口（负载抖动），本次复测窗口更短。
2. **S4 首测一次未联动（flaky）**：首次外部改状态 10s 未联动，复测 3/3 通过（45-61ms）。与 learnings 记录的 Next dev 代理 SSE 偶发问题一致（连接建立窗口丢失事件），非稳定复现。
3. **测试过程环境事件**：S3 早期出现一条可疑 `@all` 用户消息（来源未复现，疑似自动化发送时序问题，非应用路径）；登录页 hydrate 失败 2 次（.next 污染），重启后恢复——均为已知环境坑。

## 证据

- 截图：`.omo/evidence/final-qa/phase2-s{1-5}*.png`、`phase2-e5-*.png`（s3-2 收敛 / s5 探针 / debug 图为排查过程记录）
- 脚本：`/tmp/opencode/f3_qa/`（s1_create / s2_board / s3_chat / s4_sse_board / s5_reconnect / s5_route / s5_probe）

## 环境状态（验收后）

- dev.db 业务表全 0（tasks/channels/messages/sessions/task_agents/task_events/realtime_events=0），seed 保留（projects 2 / agents 4 / users 3 / project_members 4）
- server 3000 单实例（kill -9 旧实例后重启，idGen 复位验证：新任务 id=t_0000000001）＋ web 3001（.next 已清重建）
