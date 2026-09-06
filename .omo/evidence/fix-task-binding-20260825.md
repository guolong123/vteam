# Evidence: fix task binding — required + cascading selects (2026-08-25)

## Backend
- create-channel.dto.ts: taskId required IsNotEmpty message 'taskId is required'
- integrations.controller.ts: POST/PATCH validate task exists throws TASK_NOT_FOUND
- update-channel.dto.ts: remains optional

## Frontend
- page.tsx: cascading selects data-testid integration-project-select / integration-task-select, required validation, edit prefill via GET /tasks/:id

## Verifications

=== server build ===

> server@0.0.1 build
> nest build


=== server integrations tests ===
Test Suites: 7 passed, 7 total
Tests:       116 passed, 116 total

=== web build integrations route ===
├ ○ /integrations                        10.4 kB         175 kB
