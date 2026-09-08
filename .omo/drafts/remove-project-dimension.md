# remove-project-dimension — Draft

intent: clear
review_required: true（用户 2026-09-07 显式要求高精度双评审）
classification: Architecture（跨 5+ 模块：tasks/projects/issues/plans/chat/memories/realtime/platform-mcp/web/e2e/prisma）
status: review_round_active
plan_path: .omo/plans/remove-project-dimension.md
plan_sha256: unavailable-no-shell（本环境无 shell/哈希工具，评审员以“文件路径直读全文”为准，不做摘要绑定）
review_round_id: rr-20260907-03（第三轮双路 APPROVED，见下方 receipts）
round_status: approved-both-lanes
pending-action: done — handoff to worker via $start-work remove-project-dimension
review:
  momus: { status: approved, target: .omo/plans/remove-project-dimension.md, round_id: rr-20260907-03, session: ses_f867bc7dcffez4UNwgrUzqyb9r, result: APPROVED }
  independent: { status: approved, target: .omo/plans/remove-project-dimension.md, round_id: rr-20260907-03, session: ses_f867bc7cfffenGF8bFuDBmsSdQ, result: APPROVED }

## Fix log round 2（oracle 残留 4 项 → 修复，均已 grep 核实）
R2-1. tasks DTO 注释含 pid 路由 → Todo 1/2 acceptance 增加注释重写（create-task.dto.ts:14、query-tasks.dto.ts:9）。
R2-2. chat 三处注释含 :pid/ProjectMembershipGuard → Todo 8 acceptance 增加注释重写。
R2-3. query-memories.dto 字段改名未显式 → Todo 5 acceptance 增加字段+描述改名明细。
R2-4. docs/deployment.md:81、test-cases/04、prototypes role-permission tsx 在 Todo 12 glob 外 → Todo 12 逐项点名加入。

## Fix log（首轮评审问题 → 修复）
1. current-user.decorator 9 导入方无人安置 → Todo 3 拆 A/B 相，先搬迁 `common/decorators/` 再删目录（已核实 10 处 import）。
2. team-membership.guard 复用 PROJECT 常量 → Todo 1 改为自有 `PERMISSION_TEAM_NOT_MEMBER`（已核实前端零匹配，可安全改名），issues/plans/chat/realtime 引用随 Todo 4/6/8 联动。
3. swagger-mcp pid 分支无人认领 → Todo 7 明确删除分支+spec（已核实 handlers.ts:163-165）。
4. task-progression.scheduler 提示词 + memories controller 描述遗漏 → Todo 5 补入（已核实 scheduler.ts:273）。
5. memories 页 level 过滤 + layout 注释遗漏 → Todo 10 补入（已核实 page.tsx:32-65）。
6. notifications spec 等测试遗漏 → Todo 11 扩大清单。
7. Todo 12 文档清单过窄/F1 不可满足 → Todo 12 扩大到全量 agent-platform + test-cases + 三处 README，F1 grep 模式同步加严。
8. migration 原子性/UUID/realtime 损失 → Todo 9 先加后删顺序 + `CONCAT('me_mig_',UUID_SHORT())` + realtime 损失接受声明。
9. GET /tasks 无 teamId 语义 → Todo 2 明确 teamId IN 过滤 + pageSize 上限 + guard 无参数模式。

## Decisions（用户拍板）
1. 删除策略 = 一次性硬删除：删 `projects/project_members` 表、`Task.projectId`、`Memory.projectId`、`RealtimeEvent.projectId` 列，删 `/projects/*` 与 `/projects/:pid/tasks` 路由，无兼容期。
2. 权限替代 = 团队成员门：`team_user_members` 为唯一成员门，非成员 403；admin 仍走全局矩阵。
3. 测试策略 = tests-after：每波改完补/改单测+e2e，最终全量跑通；agent 实跑 QA 始终包含。
4. 记忆去向 = project 级转 team 级：`level` 变 `task/team/global`，新增 `Memory.teamId` 列+索引；存量 project 记忆按“项目下任务涉及团队”迁移（1 团队→直转；多团队→复制；0 团队→降 global）；task 级冗余 `projectId` 直接清空。

## Approach（6 波，见 plan）
守卫切换 → 任务路由去 pid → MCP/记忆/realtime → chat/docs-site/questions → 前端去 pid+e2e → migration+seed+文档。

## Scope OUT
- 不碰团队排队/会话/群聊核心逻辑、任务状态机、Issue 流转、产出物、计划模式。
- 不改 `Task.createdBy` 指向 users 的建模（Agent 建任务仍回填团队 owner）。
- `docs/<project>` 多项目形态已裁剪，无需处理。

## Pending action
write .omo/plans/remove-project-dimension.md（注：本环境无 shell 执行能力，scaffold-plan.mjs 脚本无法运行，plan 文件手工按模板创建，头结构与脚本输出保持一致）
