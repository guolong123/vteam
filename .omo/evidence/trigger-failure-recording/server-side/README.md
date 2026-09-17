# Trigger Failure Recording — SERVER half (2026-09-17)

Scope: server only (`server/src/**` + specs). Worker half is the sibling task.
Note: `.omo/evidence/trigger-failure-recording/` is shared with the sibling task;
all server-side artifacts live under `server-side/` to avoid filename collisions.

## Seam implemented (least invasive)

1. `WorkerDispatcher.dispatchAgentMention` now returns the resolved session id
   (`return ensured.id`); every other caller ignores it — backward compatible
   (verified structurally: `ConvergenceNotifier` widened to
   `Promise<string | void>`; all spec mocks `async () => undefined` still assign).
2. `HookService.dispatchWake` returns that session id; `markFired(hookId,
   wakeSessionId)` writes `target.wakeSessionId` into the EXISTING `Hook.target`
   Json column via a narrow `hook.update` (no migration, no new column, no new
   status). `parseHookTarget` tolerates the extra key and now surfaces it.
3. `HookFailureListener` (new, wired in `ChatModule`) subscribes the existing
   realtime bus events `agent.error` / `session.updated(failed)`, finds the hook
   by `status='fired' AND target.wakeSessionId == sessionId`, and records:
   hook `lastError`+`skipReason`, matching `hook_fire` trigger row
   (`dedupKey = buildHookFireDedupKey(hookId)`) `last_error`+`skip_reason`, plus
   one `trigger.wake.failed` realtime event (best-effort, same pattern as
   `trigger.reconcile`; not added to EVENT_TYPES to avoid churn).
4. All `last_error` writes `.slice(0, 191)`.

`fired` semantics unchanged (still "dispatch accepted"). No auto-retry, no
reschedule, no pending conversion. Record only.

## Live-proven bug → fix (real traffic, no synthetic injection)

First live probe (real hook wake on `s_0000000017`, real model failure) exposed a
concurrency race: `agent.error` (authoritative reason, ev_..21530) and
`session.updated(failed)` (generic fallback, ev_..21531) arrive ~68ms apart;
both handlers ran concurrently and the GENERIC reason won the claim.

Fix: per-session serialization chain in `HookFailureListener` — same-session
events process in arrival order, so `agent.error` claims first and the fallback
no-ops. Regression test: "并发竞态: agent.error 先到 → session.updated(failed) 后到不覆盖".

### Before fix (verbatim, `server-side/race-before-fix.txt`)
hook `hks_probe_tfr1` last_error = `会话执行失败（session.updated status=failed）`
(the generic string, NOT the real model error)

### After fix (verbatim, `server-side/live-failure-recorded.txt`)
hook `hks_probe_tfr2` last_error =
`执行失败：[prompt-await] 会话 ses_f51fa013affebIYtaSoMJyXhio 等待首字超时：模型无任何输出（可能模型凭据缺失/模型不可用/serve 异常）`
trigger `tmr_probe_tfr2` last_error = same real reason; event ev_..21540 `trigger.wake.failed`.

## Adversarial (all four)

- `malformed_input`: `agent.status(status=error)` with missing / garbage sessionId →
  HTTP 202, zero hook writes, no 500. (`server-side/adversarial-probes.txt`)
- `misleading_success_output`: failure recorded against the RIGHT hook + RIGHT trigger
  row (SQL join by wakeSessionId), with the real downstream reason.
- `stale_state`: a failure for a `cancelled` hook's session → no write
  (`hks_probe_fr_stale` stays cancelled/NULL).
- `dirty_worktree`: only `server/src/**` files newly changed; `worker/**`, `web/**` untouched.
- Idempotent: two failure events for one session → exactly one
  `trigger.wake.failed` event and one write (`success-green-and-idempotency.txt`).
- Success stays green: `session.updated(running)` only → `hks_probe_fr_green`
  last_error NULL, zero events.

## Verification numbers

- baseline: `npx tsc --noEmit` exit 0; jest 124 suites / 2886 tests, 0 failed.
- final:    `npx tsc --noEmit` exit 0; jest 125 suites / 2905 tests, 0 failed.
  (known transient `skill_create` flake did not appear; no assertion weakened.)

## Cleanup

Probe hooks/triggers/events physically deleted; hooks back to 1, sessions 9,
triggers 93 (92 baseline + 1 organic `session_idle_scan` sidecar from real
worker traffic on `s_0000000016`, not a probe), realtime_events 21392 (my 6
probe rows deleted after capture). See `server-side/cleanup-receipt.txt`.

## Known limitation (honest)

Sessions are team-member-scoped and reused across tasks. If a hook woke session S
(successfully) and a LATER, unrelated dispatch in the same reused session S fails,
that failure is attributed to the (write-once) fired hook. This is inherent to the
`target.wakeSessionId == event.sessionId` correlation the task prescribes; the
claim predicate makes it write-once, so it cannot corrupt beyond the first event.
Not tightened further to keep the change minimal (success-side clearing would add a
third event path).
