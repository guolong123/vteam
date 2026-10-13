---
slug: sensitive-command-tool
status: approved-plan-written
intent: clear
review_required: true
pending-action: none; plan written at .omo/plans/sensitive-command-tool.md
approach: Add one platform MCP tool `secret_command` plus a new `secret_input` question kind and a token-guarded synchronous worker route `POST /secret-command`; the model submits a command template plus variable metadata, the user fills secrets in a web modal, the worker substitutes and executes, and the model receives only the original template plus redacted/truncated output and status. Secrets never enter MCP results, SSE payloads, question answers, or logs. MVP deliberately has no sandbox, no network policy, and no command allowlist.
---

# Draft: sensitive-command-tool

## Components (topology ledger)

| id | outcome (one line) | status | evidence path |
|---|---|---|---|
| C1 | `secret_command` platform MCP tool contract, capability registration, and permission mapping | active | server/src/platform-mcp/platform-mcp.tools.ts:47-52,832; server/src/common/constants/platform-capability.constants.ts:30-36; server/src/common/constants/agent.constants.ts:117-147 |
| C2 | Server-side `secret_input` question lifecycle that never persists or echoes secret values | active | server/src/questions/questions.service.ts:52-55,151-206,233-247,608-710,732-791; server/src/questions/dto/reply-question.dto.ts:6-23 |
| C3 | Token-guarded synchronous worker command route with exact-value output redaction | active | worker/src/exec/exec-server.ts:71-115,431-474,810-835; worker/src/resources/custom-tool.ts:69-90; worker/src/git/git-tools.ts:365-389 |
| C4 | Web secret-input modal, awaiting-input tool-card state, and realtime/question wiring | active | web/src/components/chat/question-modal.tsx:37-62,82-99,135-356; web/app/(main)/teams/[id]/session/page.tsx:380-397,902-947,1553-1559; web/hooks/use-realtime.ts:236-255 |
| C5 | Cross-package protocol parity, permission-matrix coverage, tests, and final QA | active | worker/src/protocol/contract.spec.ts:1-12; server/src/common/constants/platform-capability.coverage.spec.ts:31-42; web/e2e/session-unification.spec.ts:188-226 |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Tool name | `secret_command`; capability key `secret.command`; model-facing `vteam_secret_command` | Matches existing bare-name dispatch and `vteam_` capability naming | yes |
| Permission default | **all roles allowed, including external/guest roles** | explicit user decision; recorded as a deliberate safety exception | yes, via role capability override |
| Awaiting model | blocking call, input budget 540s (not 600s), total budget = 540s + command timeout + 15s | explicit user decision; 540s keeps a margin below the 600s silent-session watchdog | yes |
| MCP client timeout | inject an explicit `timeout >= 675000` on the vteam remote MCP entry in `worker/src/resources/injector.ts`, env-overridable via `VTEAM_MCP_TIMEOUT_MS`; no DB migration | required because `mcp_servers` has no timeout column and the unpinned OpenCode default is not a contract | yes, one-line edit |
| Worker execution | async `spawn` with `detached:true` and process-group SIGKILL; never `spawnSync` in exec-server | prevents blocking the worker event loop and guarantees timeout/cancel cleanup | no, load-bearing |
| Server→worker timeout | explicit `timeoutMs = commandTimeout + 5000` on the new client method | the default 60s client timeout would abort long commands while the worker keeps running | yes |
| Concurrent prompts | one in-flight secret execution per session; second call → `409 SECRET_COMMAND_BUSY` | existing `pendingQuestion` is a single slot and a second prompt would overwrite it | yes |
| Managed mode | fail-closed: if team managedMode is true, reject the tool call immediately | secret input must not be routed to a main Agent confirmation path | yes |
| Redaction surface | stdout, stderr, spawn/exit/timeout error messages and the response envelope are all redacted in the worker; response has no rendered-command or argv field | the model sees output and error text, so both must be scrubbed before crossing the boundary | no, load-bearing |
| Audit | one structured redacted server log line only; no DB audit table | the repo's `audit_logs` table is explicitly deferred and out of scope | yes |
| Default cwd | task worktree if it exists, otherwise worker root; optional relative `cwd` per call | explicit user decision; avoids forcing `cd` in every command | yes |
| Secret variable default | `secret: true` unless the caller marks `secret:false`; all declared values are redacted from output | simple and fail-safe for credentials | yes |
| Output cap | 32KB per stdout/stderr stream after redaction/truncation | bounds model context and log surface | yes |
| Redaction point | worker side, before the HTTP response leaves the worker | prevents plaintext crossing the worker-to-server hop | no, load-bearing |
| Persistence | no new table/column; question row stores template + variable metadata and shape-only answer summary; values are memory-only | avoids secret-at-rest entirely | yes, but a future secret table would be a new owner decision |
| UI path | additive `secret_input` kind in the existing question modal; no new SSE event type | reuses existing realtime contract | yes |
| Execution result | model sees original template, redacted stdout/stderr, status, exitCode, durationMs, truncation flags | required user-visible behavior | yes |
| Security boundary | exact-value redaction only; no sandbox, no egress policy, no allowlist | explicit user decision; limitation must be documented | yes, but expanding it is future work |

## Findings (cited - path:lines)

- MCP tool registration contract: `server/src/platform-mcp/platform-mcp.tools.ts:47-52,832`; JSON-RPC dispatch and permission gate: `server/src/platform-mcp/platform-mcp.controller.ts:178-251`; permission map is fail-closed for unknown tools: `server/src/platform-mcp/platform-tool-permission.service.ts:40-86`.
- Capability catalogue and role matrix must move in lockstep: `server/src/common/constants/platform-capability.constants.ts:30-36`, `server/src/common/constants/agent.constants.ts:117-147`, `server/prisma/seed.ts:90-127`.
- Existing platform question creation and resolution: `server/src/questions/questions.service.ts:652-710,732-791`; current reply path persists and echoes `answers` (`:454,747,825-826`), so it must not be reused for secrets.
- Existing worker exec route is unauthenticated and async: `worker/src/exec/exec-server.ts:431-474,810-835`; token-guarded routes use `X-Worker-Token` (`:497,854,1170`).
- Existing worker command spawning precedent: `worker/src/resources/custom-tool.ts:69-90` (`spawnSync`, no shell); git secret env indirection: `worker/src/git/git-tools.ts:365-389`.
- Worker/server protocol is double-written and contract-tested: `worker/src/protocol/contract.spec.ts:1-12`.
- Web question modal and realtime seam: `web/src/components/chat/question-modal.tsx:37-62,82-99,135-356`; `web/hooks/use-realtime.ts:236-255`; `web/app/(main)/teams/[id]/session/page.tsx:902-947`.
- Existing secret input conventions: `web/app/(main)/models/providers-tab.tsx:576-588` (`type=password`, `autoComplete=new-password`, fingerprint-only response); `web/app/(main)/git-repos/page.tsx:284-285`.
- Existing test seams: `web/e2e/session-unification.spec.ts:188-226` SSE injection and question mocks; `server/src/questions/questions.service.spec.ts`; `worker/src/exec/exec-server.spec.ts`.
- No existing general output scrubber; no existing free-text secret input in the question modal; no existing synchronous worker command endpoint.

## Decisions (with rationale)

1. Tool is model-requested but never model-executed: the user confirms and fills values.
2. Secrets travel only browser -> server -> worker over authenticated/token-guarded channels; the model sees only the template, redacted output, and status.
3. New worker route `POST /secret-command` is mandatory; reusing unauthenticated async `/execute` is forbidden.
4. A new `secret_input` question kind is mandatory; reusing the existing `answers: string[][]` persistence/echo path is forbidden.
5. Redaction happens in the worker before the response leaves; exact-value replacement plus residual-placeholder masking, then truncation.
6. Permission is open to all roles including external, per explicit user decision; this is recorded as the plan's main accepted risk.
7. Blocking wait is chosen; the plan must ensure the MCP client timeout accommodates it, or the result is lost while execution still completes.
8. Default execution directory is task worktree when present, else worker root.
9. All roles are explicitly authorized in source constants, seed mirrors, factory matrix, external allowlist, and upgrade migration, so fresh and upgraded installs agree.
10. MCP timeout is injected in the worker MCP entry, not the database; no schema migration is added.
11. Input budget is 540s to stay below the 600s silent-session watchdog.
12. Server-to-worker calls pass an explicit timeout and use process-group kill for cancellation.
13. Managed-mode secret requests fail closed immediately.
14. Error messages are redacted on the worker before they can be serialized into the model envelope.

## Scope IN

- New MCP tool `secret_command` with command template + variable declarations + optional cwd/timeout/title/reason.
- Capability key `secret.command`, registered so the new tool is mapped and callable by every role by default.
- New `secret_input` question kind with additive DTO fields, value-free persistence, and value-free SSE frames.
- New worker `POST /secret-command` route with `X-Worker-Token`, synchronous execution, timeout, cwd containment, stdout/stderr capture, exact-value redaction, and truncation.
- Web secret-input modal variant with password inputs, command preview, reason, cancel/confirm, and an `awaiting-input` tool-card state.
- Worker/server protocol type double-write and contract tests.
- Server/worker/web unit and e2e coverage for happy, cancel, failure, timeout, unknown-key, no-leak, and redaction cases.
- Final verification wave covering full gate, real UI flow, and no-leak proof.

## Scope OUT (Must NOT have)

- No sandbox, container/namespace isolation, seccomp, ulimit, or read-only filesystem.
- No network egress policy, DNS restriction, or proxy requirement.
- No command allowlist/denylist; the model may write arbitrary commands.
- No secret vault, no per-task credential storage, no rotation, no reuse of git/model credential channels.
- No new SSE event type; reuse `agent.question`.
- No new database table/column/migration for secret storage.
- No two-phase `requestId` poller unless the blocking decision is later reversed.
- No changes to existing `POST /execute` contract, group-chat routing, or message storage model.
- No raw secret or rendered command in logs, audit records, tool results, or SSE payloads.
- No automatic secret filling by an agent or managed-mode confirmation.

## Open questions

- None. All owner-decisions are resolved:
  - permission: all roles including external/guest and `ar_general`;
  - awaiting: blocking, 540s input budget;
  - cwd: task worktree then worker root;
  - managed mode: fail-closed reject (safe reversible default).
- Metis P0 findings are folded into the plan: explicit MCP timeout injection, explicit all-role plumbing, 540s budget below the 600s watchdog, async spawn with process-group kill, explicit server-to-worker timeout, redaction of error paths, no rendered command in the response.

## Review round

- phase: review_round_initialized
- plan_path: .omo/plans/sensitive-command-tool.md
- plan_sha256: eead9869f18f3663e78222e3a8b9164ff28c48ee736e4959d614648fd8ee405f
- review_round_id: round-20260926T131314Z
- launch_id: launch-20260926T131314Z
- workspace_root: /Volumes/SSD-Data/01work/git-project/vteam
- runtime_home: null
- round_status: approved
- momus: approved session=ses_f222692c9ffeIzNQ9hYPByX1nQ round=round-20260926T131314Z confidence=0.90
- independent_oracle: approved session=ses_f222692afffeSrQH4ApiJU7zOI round=round-20260926T131314Z confidence=0.92
- convergence:
  - max_rounds: 5
  - approval_with_notes_counts_as_approval: true
  - ledger_freeze_after_round: 1
  - blocker_eligibility: explicit_requirement_or_accepted_decision; existing_failing_regression; reproducible_broken_flow; concrete_security_data_loss_or_compatibility_risk; external_api_provider_or_release_contract_conflict
  - ineligible_finding_disposition: non_blocking_note
  - fix_edit_policy: smallest_edit_no_scope_expansion

final_live_plan_sha256: eead9869f18f3663e78222e3a8b9164ff28c48ee736e4959d614648fd8ee405f

## Approval gate

status: approved-plan-written

Approach: implement the five components above as one plan, with worker-side redaction and the token-guarded worker route as the load-bearing controls. The plan documents the best-effort redaction limitation and the accepted all-roles permission risk.

Next workflow action: deliver the handoff summary and ask the user to choose start work or high-accuracy review.
