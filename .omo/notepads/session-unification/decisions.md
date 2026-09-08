# Decisions — session-unification

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 11 — 决策记录 (2026-09-07)

- instances[].id 采用 tmm_（团队成员 id），main 标记取 team.mainAgentMemberId（与 Todo 8/9 主门一致）；task.mainAgentInstanceId 标量保留到 Todo 6 删列。
- TeamMember 无 enabled/overrideModelId 列：DTO 暂填 enabled=true、overrideModelId=null 保形状兼容，Todo 12 前端适配时再定。
- teamAgentIds 字段名保留（值改取团队成员 agentId），避免跨 Todo 重命名 churn。
- updateExecutionMode 初查 include 一并删除（仅读 executionMode/status + DTO 早返，无业务 ta_ 依赖）。
- 未提交：改动留工作区供终验/串行 Todo 12 衔接；foreign dirty（DTOs/module/scheduler）不纳入本 Todo。
