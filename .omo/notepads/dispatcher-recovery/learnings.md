## [2026-09-16T09:30Z] Task: abort-before-restart

- What: `markSessionIdleDead` now stop-first — best-effort `workerClient.abort(ref, sesId)` after failed-marking, before all verdict branches (quota early-return, transient, plain idle) and both `tryAutoRestart` calls.
- How: hoisted one shared `prisma.worker.findUnique` fetch — forensics `getMessages` and abort reuse the same `{ id, capabilities }` ref; guard `workerId && instanceRef && !== PENDING_INSTANCE_REF`; helper `abortStuckWorkerSession` swallows errors with `logger.warn`, never throws.
- Id mapping: `instanceRef` is the opencode `ses_` id, passed unchanged; platform `s_` id never sent to workerClient. `workers.service.abortSession` confirmed dead stub (no live callers) — left untouched, called `workerClient.abort` directly.
- Tests: 4 new specs in `worker-dispatcher.spec.ts` (`abort-before-restart` describe) — ordering via `invocationCallOrder`, abort-reject still recovers, missing ref skips abort, quota branch aborts without restart. Suite: 217 passed. `tsc --noEmit` clean (LSP server not installed — used tsc instead).
- Gotcha: `tryAutoRestart` is fire-and-forget (`void ...`), so restart observation in tests needs `jest.spyOn(d, 'tryAutoRestart')`, not channel/dispatch mocks.
