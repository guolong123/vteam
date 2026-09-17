# todo-8 restart-proof (live, 2026-09-17 ~02:47–03:10Z)

Probe tasks: `t_0000000010` (tm_0000000001, queued, never started — FIFO head blocked),
`t_0000000011` (tm_0000000006, empty queue → head → startable). Both created via
`POST /api/v1/tasks` as admin.

## 1. register → schedule (real code path)

`POST /api/v1/tasks/t_0000000011/start` → `status=in_progress` →
`TasksService.transition` → `progression.register` → `TriggerService.schedule`.
Row (see `db-before-restart.txt`):

```
tmr_0000000024  progression_patrol  pending  interval_ms=1200000
next_fire_at=2026-09-17 03:07:32  fire_count=0  max_fires=6
guard_key=progression_cooldown  dedup_key=progression_patrol:task:t_0000000011
```

## 2. forced fire (due_at=NOW, ticker ≤30s)

`db-after-fire.txt`:

```
tmr_0000000024  pending  next_fire_at=2026-09-17 03:08:44 (=now+20min+jitter)
fire_count=1  last_error=NULL skip_reason=NULL
```

Handler ran the real dispatch (agent wake on probe task; main member
tmm_0000000019 got session s_0000000016 + agent reply m_0000002115).

## 3. restart — the core claim

`docker compose restart server` (same baked image incl. this todo) → health 200 →
`db-after-restart.txt`:

```
tmr_0000000024  pending  next_fire_at=2026-09-17 03:08:44 (unchanged)
fire_count=1 (PRESERVED, not reset)  max_fires=6
```

Old code kept `rounds` in a `Map` → restart wiped it → `maxRounds` never fired.
New code keeps it in `triggers.fire_count` → survives. Exactly 1 patrol row after
restart (restore path kept the pending row, no duplicate).

## 4. cancel/resume

`POST /api/v1/tasks/t_0000000011/mark-pending-review` → `unregister` → `cancel`.
`db-after-unregister.txt`: `tmr_0000000024  cancelled  fire_count=1`.

## 5. cleanup (see `db-cleanup.txt` — all zeros)

Deleted in FK order: memories me_0000000046/47 → message m_0000002115 →
session s_0000000016 → plans pl_0000000009/10 → task_events ×4 →
tasks t_0000000010/11 → trigger tmr_0000000024;
`teams.tm_0000000006.current_task_id` NULL (baseline);
tm_0000000001 queue back to t_0000000004–09 positions 1–5.
Gotcha hit during cleanup: `teams.current_task_id` FK must be nulled BEFORE
deleting the task row (two-pass delete).

## 6. static verification

- `tsc-after.txt`: exit 0.
- `jest-after.log`: 120 suites / 2729 tests green (baseline 120/2708;
  +14 new todo-8 tests, +7 from concurrent sibling workstreams, zero regressions).
