# Phase 5 T11：审计基线汇总

> 时间：2026-08-08 ｜ 环境：docker compose 四容器实跑
> 验证目标：`task_events` 事件审计落库（08 篇 §6.1 / 17 篇 §8.2）+ server 侧 pino JSON 结构化日志（D6）

## 一、task_events 六类事件落库

### 实跑链路（seed-admin 操作 p_seed_1 项目）

| 任务 | 操作序列 | 落库事件 |
|------|---------|---------|
| t_0000000001 | create → start → mark-pending-review → accept → archive | status_change×3（null→pending / pending→in_progress / in_progress→pending_review）+ accept + archive |
| t_0000000002 | create → start → mark-pending-review → reject | status_change×3 + reject |
| w_compose_worker 上送 | `POST /api/v1/worker/events` type=git.op | git.op ×1（actor_type=agent） |

### 查库结果（`mysql -e "SELECT event_type, COUNT(*) ... GROUP BY event_type"`）

```
event_type     cnt
accept         1
archive        1
git.op         1
reject         1
status_change  6
```

计划列示的枚举（status_change / accept / reject / archive / git.op）**全部实测落库**。
（注：计划文字「6 类」实为上述 5 个 eventType 枚举值，即 08 篇 §6.1 的 4 类迁移事件 +
T6 新增 git.op 审计事件，无其他隐藏枚举。）

### 事件明细抽样（含 git.op metadata Json）

```
task_id         event_type      from_status    to_status      actor_type  actor_id      act       repo_url                                exit_code
t_0000000001    status_change   NULL           pending        user        u_seed_admin  NULL      NULL                                    NULL
t_0000000001    status_change   pending        in_progress    user        u_seed_admin  NULL      NULL                                    NULL
t_0000000001    status_change   in_progress    pending_review user        u_seed_admin  NULL      NULL                                    NULL
t_0000000001    accept          pending_review completed      user        u_seed_admin  NULL      NULL                                    NULL
t_0000000001    archive         completed      archived       user        u_seed_admin  NULL      NULL                                    NULL
t_0000000002    status_change   NULL           pending        user        u_seed_admin  NULL      NULL                                    NULL
t_0000000002    status_change   pending        in_progress    user        u_seed_admin  NULL      NULL                                    NULL
t_0000000002    status_change   in_progress    pending_review user        u_seed_admin  NULL      NULL                                    NULL
t_0000000002    reject          pending_review in_progress    user        u_seed_admin  NULL      NULL                                    NULL
t_0000000001    git.op          NULL           NULL           agent       a_developer   git_clone https://github.com/xishuhq/aiagents.git  0
```

### 代码依据
- `server/src/tasks/tasks.service.ts`：
  - 创建即落 `status_change`（from=null → pending，199-209 行）；
  - `transition()` 迁移表驱动 + CAS 乐观锁（version 自增），按 action 落
    `status_change / accept / reject / archive`（723-734 行）；
  - **archive 仅允许 `completed → archived`**（620-624 行，13 篇 §4.5 终态）——
    实测 `in_progress → archived` 被拒 `TASK_INVALID_TRANSITION`（状态机防护正确）。
- `server/src/workers/worker-event.ingress.ts` `handleGitOp`（283-327 行）：
  `git.op` payload（taskId/agentId/action/repo_url/exit/error）→ task_events 落库，
  metadata Json 承载 agent/repo_url/action/exit；`actor_type=agent`；taskId/action 缺失跳过。
- `server/src/workers/dto/worker-event.dto.ts:16`：`WORKER_EVENT_TYPES.GIT_OP = 'git.op'`。

## 二、pino JSON 结构化日志

### 实测（`docker logs aiagents-compose-server`）

- 抽样 159 行：**159 行全部为合法 pino JSON，0 行非 JSON**（python json.loads 全量通过）。
- 行格式：`{"level":30,"time":1786153771474,"pid":1,"hostname":"...","req":{...},"res":{...}}`，
  业务日志含 `"context"`（如 `"context":"NestFactory"` / `"context":"WorkerEventIngress"`）。
- HTTP 访问日志（nestjs-pino pinoHttp 中间件）与业务日志统一 JSON 化；
  `Authorization`/`Cookie` 已 redact（`app.module.ts:30` redact 配置）。
- git.op 审计处理日志实测存在（`req.url":"/api/v1/worker/events"` 记录 + ingress 落库日志）。

### 代码依据
- `server/src/main.ts:25`：`app.useLogger(app.get(PinoLogger))` 接管全局 Nest Logger；
- `server/src/app.module.ts:22-32`：`LoggerModule.forRoot({ pinoHttp: {...} })`，
  `NODE_ENV=production` 无 LOG_PRETTY → 纯 JSON（compose 中 NODE_ENV=production 实测生效）。

## 三、审计走查结论

任务事件六类枚举 + metadata 结构 + JSON 日志管线全部实测通过，**无阻断项**，满足
18 篇 §9.5 M5 审计走查要求。
