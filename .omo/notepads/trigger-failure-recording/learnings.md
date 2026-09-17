# trigger-failure-recording — learnings

## [2026-09-17] T17 capture transport was wrong: serve writes a FILE, not stderr

### FALSIFIED ASSUMPTION (delta from phase4-worker-opencode T17 section ~240-250)
The T17 note in `.omo/notepads/phase4-worker-opencode/learnings.md` says serve writes
model errors "**只写 stderr**". **That is wrong.** `opencode serve` (1.18.31) writes its
diagnostics to the FILE `$HOME/.local/share/opencode/log/opencode.log`; stdout/stderr only
carry the startup banner (`opencode server listening on …` on **stdout**). Worker collected
serve only via `proc.stdout/stderr` pipes, so `this.logs` never got the error line →
`recentErrors()` was **always empty** → T17 early-abort never fired → 120s wait → generic
"模型无任何输出". The original T17 code (keyword regex, extractServeError, dedup, ladder) was
correct; the **transport/capture** was the defect. Do not "fix" this by editing keywords.

Proof: `docker compose logs worker | grep -cE "timestamp=|level=ERROR"` → 0, while the file had
the line: `level=ERROR message="stream error" … error.error="AI_APICallError: Rate limit exceeded…"`.

### FIX
- `opencode serve --print-logs` (documented: "print logs to stderr") added to spawn args
  (`opencode-server.ts` spawnServe). Diagnostics now reach `this.logs` via the existing pipe.
  The `listening on` banner stays on stdout → `LISTENING_RE` port validation unaffected
  (verified stdout=1 / stderr=0 matching lines).
- Secondary source: `recentErrors()`/`recentLogTail()` fall back to reading the tail of
  `serveLogFilePath` (default derived `$XDG_DATA_HOME/opencode/log/opencode.log`, configurable,
  env override possible). Missing file → silent `[]` (degrade, never throw).
- Session scoping: readers take the opencode session id and drop lines whose `session.id=`
  belongs to another session → serve-restart/stale errors cannot leak into a new session's
  reason. `OpencodeServer.start()` also clears the ring buffer + spawnError on every start.
- Failure reason now always carries evidence: `describeTimeoutReason(messages, serveErrorText,
  serveLogTail)` — extracted error (depth-first: `error.error` → `cause` → `message`) wins;
  otherwise the RAW serve log tail is appended. Generic string only when NO evidence exists.
- `extractServeError` now also unwraps the `cause="Cause([Fail(<Err>: …)])"` shape (found live),
  stripping the wrapper so the reason is the deepest detail, not the whole structured log line.

### BUFFER MEASUREMENT (do not rely on luck)
Analyzed 34,139 lines of the real container log: max **31 lines in any 500ms window**
(1s=32, 5s=59, 10s=101). Poll interval is 500ms. Old `DEFAULT_LOG_BUFFER_SIZE=200` = 6.4x
headroom; raised to **500** (~16x), kept as a named constant. Tests inject the measured density.

### FALSE-POSITIVE GATE (newly relevant once the buffer is populated)
`--print-logs` floods the buffer, so keyword-only matching became dangerous: measured
**161 INFO lines matched bare `429`** (from `messageID=msg_0a429eb…`). `isServeErrorLine`
requires `level=ERROR` OR an explicit `error.*=` field in addition to the keyword. This also
required updating `exec-server`'s injected `onServeError` with the same structural gate.

### VERIFICATION
Live in-container against a real serve: real `level=ERROR` line matched in **500ms**;
`awaitCompletion` failed in **575ms** (baseline 120000) recording
`模型调用报错：Model not found: opencode/no-such-model-xyz. …`. Ring buffer capture proven
(`RING_BUFFER_SIZE=30`, verbatim `message=stream … session.id=ses_…` line).
typecheck 0, build 0, jest 651 passed (+17, all new tests pass); the 2 failures are the
pre-existing unrelated `v1-driver` listModels drift.

### GOTCHAS FOR NEXT TIME
- `docker compose exec` inside the worker is the fastest way to prove serve behavior; the
  host `opencode` uses different credentials than the container.
- `docker compose build worker` is very slow here (apt + npm layers) — use in-container
  `docker cp` of `worker/dist` for empirical proofs instead of waiting for a full rebuild.
- A `.spec.ts` helper that defaults `serveLogFilePath` must point at a NON-existent path, else
  the file fallback reads the developer's real 100MB+ `~/.local/share/opencode/log/opencode.log`.

## [2026-09-17] Refactor note (250-LOC ceiling)
My first edit pushed `worker/src/runtime/opencode-server.ts` from 405 → 538 pure LOC (baseline
was ALREADY over the 250 ceiling — pre-existing debt). Rather than add to it, I extracted two
cohesive single-responsibility modules (behavior-preserving, all tests green):
- `worker/src/runtime/serve-log.ts` (90 LOC): pure log parsing — `isServeErrorLine`,
  `lineBelongsToSession`, `readFileTailLines`, `defaultServeLogFilePath`, keyword regexes.
- `worker/src/runtime/port-probe.ts` (42 LOC): `isPortFree`, `getRandomFreePort`, `httpGetStatus`.
Result: `opencode-server.ts` 538 → 428 pure LOC, net +23 over baseline instead of +133.
Re-exports kept (`export { defaultServeLogFilePath, readFileTailLines }`) so existing importers
(specs) are unaffected.

## [2026-09-17] SERVER half: record wake failures on the origin hook (trigger-unification seam)

### The seam (least invasive; no migration, no new column/status)
- `WorkerDispatcher.dispatchAgentMention` → `Promise<string>` (`return ensured.id` at :1441).
  All other callers ignore it. **Compile trap**: `ConvergenceNotifier`
  (`review-round-gate.service.ts:57`) is a structural interface — returning `Promise<string>`
  where `Promise<void>` is declared IS a TS error (unlike `() => void` assignability rules).
  Widened it to `Promise<string | void>`; spec mocks `async () => undefined` still assign.
- `HookService.dispatchWake` returns the session id; `markFired(hookId, wakeSessionId)` writes
  `target.wakeSessionId` into the EXISTING `Hook.target` Json (a second narrow `hook.update`,
  before/around the fireCount increment). `parseHookTarget` now surfaces `wakeSessionId`
  (exported for round-trip test); unknown keys already ignored, so old rows stay valid.
- New `HookFailureListener` (`src/triggers/hook-failure.listener.ts`, wired in `ChatModule`)
  subscribes the realtime bus (`agent.error` / `session.updated(failed)`), finds hook by
  `status='fired' AND target:{path:'$.wakeSessionId',equals:sessionId}`, then records:
  hook `lastError`+`skipReason` (claim via `updateMany where lastError:null`), matching
  `hook_fire` trigger row `last_error`+`skip_reason`, + one `trigger.wake.failed` event
  (in `hook.constants.ts`, deliberately NOT in EVENT_TYPES — avoids churning the 31-count
  assertion + `event.constants.spec.ts`).

### LIVE-CAUGHT RACE (the real lesson)
A real model failure emits `agent.error` (real reason) then `session.updated(failed)`
(generic fallback) **~68ms apart**. Both bus callbacks fired concurrently → the GENERIC
fallback won the claim → hook recorded `会话执行失败（session.updated status=failed）`
instead of the real rate-limit/timeout text. Fix = per-session serialization chain
(`Map<sessionId, Promise>` in the listener) so arrival order decides; `agent.error` claims,
fallback no-ops. Don't "fix" this by prioritising in SQL — ordering is the only correct lever.
Unit regression: "并发竞态：agent.error 先到 → session.updated(failed) 后到不覆盖".

### Gotchas
- `agent.error` is NOT a worker-protocol type — the worker sends `agent.status` with
  `status:'error'`; ingress emits `agent.error`. Posting `agent.error` to `/worker/events`
  → 400 (correct). Live probes must POST `agent.status`.
- MySQL JSON path (todo-22 recurrence): `target: { path: '$.wakeSessionId', equals }`.
  Prisma sqlite test DB is never exercised for this (all specs mock prisma), so the path
  string is only validated live.
- `.omo/evidence/trigger-failure-recording/` is SHARED with the sibling worker task and
  generic filenames (tsc-*/jest-*/git-status-*) collide/clobber. Namespaced mine under
  `server-side/`.
- Sessions are team-member-scoped and reused across tasks: a failure in a reused
  session can be attributed to a write-once fired hook. Inherent to the prescribed
  `wakeSessionId == sessionId` correlation; claim predicate caps damage at one write.
