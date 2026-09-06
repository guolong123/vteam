# Decisions — vteam-team-refactor

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-09-01 — Hotfix pending group_post 频道策略（Sisyphus-Junior）
- 热修复选择“首任务 pending 即建 team_group + group_post 幂等自建”，而非要求 start，才满足“pending 也能发群聊”；queued 排队仍隔离（FIFO+currentTaskId），不破坏 queued 逻辑，pending/queued 均经 team 维频道分区隔离消息。
