## Worker typecheck / build / test — AFTER (2026-09-17)

### typecheck
```
cd worker && npm run typecheck  => EXIT 0
```

### build
```
cd worker && npm run build      => EXIT 0
```

### jest (full suite)
```
Test Suites: 1 failed, 25 passed, 26 total
Tests:       2 failed, 651 passed, 653 total
Time:        19.722 s
```

### Baseline (BEFORE edits)
```
Test Suites: 1 failed, 25 passed, 26 total
Tests:       2 failed, 634 passed, 636 total
```

Delta: **+17 tests added, ALL passing** (636 -> 653).
The 2 failures are PRE-EXISTING and unrelated (v1-driver.spec.ts listModels model-catalog
drift in the dirty worktree — byte-identical failures before and after; see
`TODO: baseline log` — both are `V1Driver.abort / listModels / isHealthy` expectations
against a stale model list).

### New tests (17)
worker/src/runtime/opencode-server.spec.ts (+7):
- spawn args include --print-logs (locked in the D2 spawn-args assertion)
- recentErrors: bare-keyword INFO line excluded (structural error gate / 429 false-positive)
- recentErrors: session filtering (stale isolation)
- recentLogTail: raw tail lines returned
- start clears previous process log (restart stale isolation)
- buffer does not evict the error line (measured 31-lines/500ms density)
- buffer capacity: 500-line cap survives 16 poll cycles of noise
- log-file secondary source: fallback read + missing-file silent degrade

worker/src/driver/prompt-await.spec.ts (+9):
- serveLogTail appended to reason when no other evidence
- blank serveLogTail ignored
- serveErrorText wins over serveLogTail
- info.error wins over serveLogTail
- serveErrorReader/serveLogReader receive the session id
- cause= shape extracted to deepest detail (Cause([Fail( unwrapped)
- raw log tail propagated into the thrown error
- serveLogTailLines truncation
- extracted error suppresses raw evidence (not redundant)

worker/src/exec/exec-server.spec.ts (+1):
- no extractable error -> raw serve log tail reaches agent.status error AND logger.error (durable)
