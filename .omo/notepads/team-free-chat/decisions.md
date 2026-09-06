# Decisions — team-free-chat

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-09-06T01:10Z] Task: todo-1 — uk_sessions_team_member scoping
uk_sessions_team_member enforces (team_id, team_member_id) idempotency ONLY for rows with empty task_id (STORED generated column team_member_key + unique on it), not a bare UNIQUE(team_id, team_member_id). Rationale: task-bound rows are governed by uk_sessions_task_agent and legitimately repeat (team, member) across tasks; a bare unique rejects the mandated 100% backfill (observed P3018/1062). schema.prisma keeps @@unique([teamId, teamMemberId], map uk_sessions_team_member) as declared intent; DB-level scoping is the documented implementation. Downstream guard/dispatcher must treat team-mode identity as (team_id, team_member_id) WHERE task_id IS NULL.
