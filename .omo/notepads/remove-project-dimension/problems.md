# Problems — remove-project-dimension

Unresolved blockers and technical debt discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-09-07 — T2: TeamMembershipGuard 缺无参直通 + :id 任务路由误判（owner: Todo1/7，T2 log 不修）
- 现状（`server/src/common/guards/team-membership.guard.ts:53-59,78-104`）：
  无 `id`/`taskId` 路由参数 → 400 `TEAM_ID_REQUIRED`（`POST /tasks` body.teamId、
  `GET /tasks?teamId=` query.teamId 均命中此分支）；`tasks/:id` 详情类路由把 task id
  误作 teamId → 非成员式 403。计划要求“无团队参数仅要求登录、过滤下沉 service”，
  守卫需扩展：无参直通 + `:id` 任务反查 teamId（或文档声明 tasks 控制器豁免类守卫）。
- T2 已按 acceptance 完成类级 swap + 控制器侧成员校验/聚合；端到端在守卫补齐前
  param-less 路由会被 400 拦截。证据：`t2-failure.log` F2。
- [RESOLVED 2026-09-07 guard-fix] 守卫已补齐无参直通（auth-only）+ `:id`
  团队优先/任务回退；证据 `t2-guardfix.log`。残留：无 teamId 聚合仍为控制器侧
  per-team fan-out（每团队 cap 100），根治需 service 层 `teamId IN (...)`
  （service owner 后续）。
- 附带：无 teamId 聚合为控制器侧 per-team fan-out（每团队 cap 100），大数据尾行丢失；
  根治需 service 层 `teamId IN (...)`（service owner 后续）。

## 2026-09-07 F3 问题记录
- P1（已解决）：fresh 栈首次 `POST /tasks` 500——`@prisma/client` 为旧 schema 生成物（仍强制 `project` 字段），与已应用的 T9 migration 不一致。解决：`server/` 下 `npx prisma generate` + 重启。教训：凡涉及 schema 变更的 QA，"当前树构建"必须包含 client 重新生成。
- P2（按设计，非缺陷）：非团队成员（admin）建任务 403 `PERMISSION_TEAM_NOT_MEMBER`；未设主 Agent 时 start 400 `MAIN_AGENT_NOT_SET`——均为团队门正常工作，已记入 final-F3.md 失败路径证据。
