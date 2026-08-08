# Phase 2 M2 联调验收总结（§6.4 里程碑）

> 日期：2026-08-07 ｜ 环境：server 3000（nest dist）+ web 3001（next dev）+ dev.db（seed 后归零）
> 验收范围：任务创建 → 启动 → 群聊消息实时流转（mock Agent 回复）→ 看板状态流转 → 断线补拉不丢

## 1. 主流程数据流说明

### 1.1 链路总览

```
登录(admin/admin123)
  → POST /api/v1/projects/p_seed_1/tasks
     同事务：tasks + chat_channels(task_group) + task_agents×2 + sessions×2 + task_events
     → 广播 task.status.changed(global, from=null→pending)
  → 看板 GET /projects/:pid/tasks → 卡片「待开始」
  → POST /tasks/:id/start → in_progress（CAS 乐观锁，version+1）
     → 广播 task.status.changed(global, pending→in_progress) → 看板联动
  → 群聊 POST /channels/:id/messages（@产品经理）
     51ms 内 201 {message, triggers:[dispatched]}（≤1s 要求）
     → 广播 chat.message.new(channel scope) → 前端即时追加
     → MockDispatcher（fire-and-forget）1~3s 后：
       agent.loading(thinking) → agent.loading(operating) → 回复落库 → chat.message.new
     → 前端 loading 两阶段指示器 → 回复追加 → loading 收敛
```

### 1.2 SSE 事件时序（realtime_events 实测，DB 持久化）

| 序号 | 事件 | scope | 相对时间 | 说明 |
|------|------|-------|---------|------|
| ev_...230 | chat.message.new | channel:c_0000000001 | +0ms | 用户消息落库广播 |
| ev_...231 | agent.loading (thinking) | task:t_0000000001 | +2137ms | 产品经理「思考中…」 |
| ev_...232 | agent.loading (operating) | task:t_0000000001 | +394ms | 「操作中…」 |
| ev_...233 | chat.message.new | channel:c_0000000001 | +796ms | 产品经理 mock 回复回流 |

- 回复文案：`收到需求说明，正在梳理功能优先级与验收标准，稍后输出完整需求文档。`（product 角色模板，确定性）
- 用户消息 201 响应 51ms（fire-and-forget 分派不阻塞受理）

### 1.3 落库校验（sqlite 断言）

| 表 | 行数 | 说明 |
|----|------|------|
| tasks | 1 | t_0000000001，pending → in_progress |
| chat_channels | 1 | type=task_group，agent_id=null |
| task_agents | 2 | a_product + a_architect，removed_at=null |
| sessions | 2 | s_0000000001/s_0000000002，status=created（**本任务新增修复**） |
| task_events | 2 | status_change（null→pending / pending→in_progress） |
| realtime_events | 4 | 上表时序，scope 正确 |

## 2. 断线补拉记录

| 场景 | 操作 | 结果 |
|------|------|------|
| since 语义 | `?since=ev_...233` 重连 | 仅返回 234/237 两条新事件，无重复 ✓ |
| 重启补拉 | 记 max_id=ev_...237 → kill server → 期间发消息失败（预期）→ 重启 → 新消息产生 ev_238/241 | `?since=ev_...237` 精确补拉 2 条，无重复不丢 ✓ |

事件持久化（realtime_events 表）+ since 游标补拉满足 A10「重启后 since 补拉不丢」。

## 3. 前端 Playwright 走查（C1 全流程，9/9 PASS）

| # | 步骤 | 断言 | 结果 |
|---|------|------|------|
| 1 | 登录 admin/admin123 | 跳转 /projects | PASS |
| 2 | /tasks/new 勾选 2 Agent + 主 Agent=产品经理 | POST 201 → 跳 /tasks/t_0000000003 | PASS |
| 3 | 看板见新任务 | 徽章「待开始」+ 开始按钮（截图 m2_03） | PASS |
| 4 | 点「开始」 | 徽章→「进行中」（截图 m2_04） | PASS |
| 5 | 群聊发消息 @产品经理 | 800ms 内用户消息显示 | PASS |
| 6 | Loading 指示器 | 「产品经理 思考中…」→「操作中…」两阶段（100ms 高频采样） | PASS |
| 7 | mock 回复回流 | 「收到需求说明…」追加 | PASS |
| 8 | loading 收敛 | 回复后残留 loading=0 | PASS |
| 9 | 看板 SSE 联动 | 外部 mark-pending-review → 未刷新卡片变「待验收」（截图 m2_07） | PASS |

截图清单（.omo/evidence/m2_*.png）：02 创建成功跳转 / 03 看板待开始 / 04 看板进行中 / 05 loading / 06 群聊回复（用户右蓝 + 产品经理左白 + 三栏布局）/ 07 看板联动。

## 4. 修复项清单（联调发现）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | **M2 阻断**：@ 产品经理 → triggers=no_session → mock 回复永不回流 | 任务创建/team add 均未建 sessions 行（plan T12 要求「新会话创建」未实现；T6 三件套不含 session） | `server/src/tasks/tasks.service.ts`：create 事务为每 teamAgent 补 `session.create(status=created)`；updateTeam add 同步补建、rejoin 恢复 status=created；ID_PREFIX 增 `session:'s'` + onModuleInit seed。单测适配（mockCreateTx/mockTeamTx 补 session，断言 2 行 session 落库） |
| 2 | 消息 id 时间戳格式（m_1786...）污染 idGen 序列 | 历史测试残留手写时间戳 id 消息未清干净，onModuleInit seed 按最大 id 续号 | 清残留数据 + 重启（恢复零填充 m_0000000001） |
| 3 | 前端登录失效（点击无反应） | web .next 被 production build 污染（main-app.js 404 → 不 hydrate → form 原生提交） | kill + rm -rf .next + npm run dev 重启（known issue 再踩） |

## 5. 门禁（C4）

- server：`npm run test` → 17 suites / **171 tests 全过**；`npm run build` exit 0
- web：`npm run build` exit 0（tsc 类型检查通过）
- 无 Phase 3+ 功能泄漏（仅补齐会话生命周期，属 M2 团队模型必备）

## 6. 环境状态（验收后）

- dev.db 全表归零（tasks/channels/messages/sessions/task_agents/task_events/realtime_events = 0），seed 项目/Agent 保留
- server 3000 / web 3001 运行中（web 已 kill+rm .next 重启，无污染）
