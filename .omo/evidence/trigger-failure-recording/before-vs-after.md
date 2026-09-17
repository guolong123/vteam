# Trigger Failure Recording — BEFORE vs AFTER (live 2026-09-17)

## Root cause (proven, not re-derived)
`opencode serve` writes diagnostics to the FILE `$HOME/.local/share/opencode/log/opencode.log`,
NOT to stderr. Worker captured serve only via `proc.stdout/stderr` pipes
(`opencode-server.ts:357-358` → `pushLog`), so `this.logs` never received the model error →
`recentErrors()` was always empty → T17 early-abort never fired → full 120s elapsed → generic
level-4 string recorded.

Evidence that worker never saw the error:
```
$ docker compose logs worker | grep -cE "timestamp=|level=ERROR"
0
```

## RAW serve error line (verbatim, from the file — the real rate-limit failure)
```
timestamp=2026-09-17T12:05:08.870Z level=ERROR run=4ef4852a message="stream error" providerID=opencode modelID=big-pickle session.id=ses_f51d18a48ffeXvmS5DYhwQz1m6 small=false agent=vteam-tester mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."
```
(second occurrence at `timestamp=2026-09-17T13:03:29.664Z` for the same session)

## BEFORE (recorded reason, verbatim)
```
[exec] 执行失败 session=ses_f51d18a48ffeXvmS5DYhwQz1m6: [prompt-await] 会话 ses_f51d18a48ffeXvmS5DYhwQz1m6 等待首字超时：模型无任何输出（可能模型凭据缺失/模型不可用/serve 异常）
```
- elapsed: 120s (12:05:06 send → 12:07:06 abort)
- the real error text was discarded.

## AFTER (recorded reason, verbatim — live in-container proof, real serve)
```
[prompt-await] 会话 ses_f505c92e9ffeOK2nOJ3FMbswG9 等待首字超时：模型调用报错：Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?
```
- `FAILED_FAST_AFTER_MS=575` (baseline 120000)
- `recentErrors()` non-empty after 500ms (one poll interval)

## Capture proof (`recentErrors()` non-empty from the REAL ring buffer)
With `--print-logs`, the ring buffer now receives serve diagnostics verbatim:
```
RING_BUFFER_SIZE= 23
STREAM_PROCESS_LINES_CAPTURED= 1
timestamp=2026-09-17T13:48:30.648Z level=INFO run=adfb729a message=stream providerID=opencode modelID=big-pickle session.id=ses_f505fbf03ffexWJKW6PkL7g10W small=true agent=title mode=primary
```
And a genuine ERROR line is captured + error-matched in 500ms:
```
RECENT_ERRORS_NON_EMPTY_AFTER_MS=500
timestamp=2026-09-17T13:50:35.005Z level=ERROR run=dfcc85e8 message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?)])"
```

## Buffer measurement (decided NOT to rely on luck)
Analyzed 34,139 lines of the container's real `opencode.log`:
```
max_lines_in_any_500ms = 31
max_lines_in_any_1s    = 32
max_lines_in_any_5s    = 59
max_lines_in_any_10s   = 101
```
Poll interval is 500ms, so an ERROR line must survive ~31 lines. Old constant 200 = 6.4x headroom;
raised to `DEFAULT_LOG_BUFFER_SIZE = 500` (~16x) — still a named constant, pure in-memory strings.
New tests inject the measured 31-lines/500ms density across 16 poll cycles and assert the error line
is not evicted.

## False-positive gate (newly relevant because the buffer is now populated)
With `--print-logs`, keyword matching alone would misfire: bare `429` matched 161 **INFO** lines
(`messageID=msg_0a429eb…`). `isServeErrorLine` adds a structural gate (`level=ERROR` OR `error.*`
field). New test locks this: an INFO line containing `429` is NOT returned by `recentErrors()`.

## Transport contract preserved
`--print-logs` sends diagnostics to stderr; the `opencode server listening on http://…` banner stays
on **stdout** (verified: stdout=1, stderr=0 matching lines) → `LISTENING_RE` port validation intact.

## Secondary source
`recentErrors`/`recentLogTail` fall back to reading the tail of `serveLogFilePath`
(default `$XDG_DATA_HOME/opencode/log/opencode.log`, configurable). Missing file → silent `[]`.
