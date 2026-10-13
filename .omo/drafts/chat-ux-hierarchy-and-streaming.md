---
slug: chat-ux-hierarchy-and-streaming
status: approved
intent: clear
review_required: false
pending-action: plan complete; present handoff and stop without implementation
approach: Preserve the existing message/SSE/group-routing contracts; first make the private-chat hierarchy and density legible with a shared identity rail, grouping, date/system separation, and a three-level type scale; then repair concrete status/identity/part defects; finally gate worker/server part-delta changes on a live serve observation, and make the page consume deltas safely with a polling fallback. Preserve the deliberate group-chat contract: group process deltas remain private/internal and group final replies remain direct MCP messages.
---

# Draft: chat-ux-hierarchy-and-streaming

## Components (topology ledger)
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
- C0 | Establish whether opencode serve exposes a growing text part during a real generation; this gates worker delta-semantics work. | active | `worker/src/driver/v1-driver.ts:7-18,313-317`; `.omo/evidence/dm-stream-debug/frames-private-channel.txt`
- A | Increase useful visible content and establish a coherent three-level type scale without adding a second vertical clamp. | active | `web/src/components/ui/chat-bubble.tsx:117-120,238-277`; `web/src/components/chat/msg-parts.tsx:51-69`; `web/src/components/chat/msg-thinking.tsx:40-42`
- B1 | Render one identity rail per agent message instead of repeating identity for every process part. | active | `web/src/components/chat/msg-parts.tsx:114-170`; `msg-thinking.tsx:57`; `msg-tool.tsx:69`; `msg-error.tsx:63`
- B2 | Make chronological reading easier through consecutive-sender grouping, date separators, and quieter system rows. | active | `web/app/(main)/teams/[id]/session/page.tsx:90-96,1278-1356`
- B3 | Close concrete message-quality defects: user delivery state, human initials, role/name fallback, theme-aware role colors, unknown-part visibility, and status-row containment. | active | `chat-bubble.tsx:39-51,138-188`; `agent-avatar.tsx`; `tokens.ts:19-26,93-100`; `msg-parts.tsx:169`; `page.tsx:1350-1356`
- C1 | If and only if C0 passes, transmit in-place text growth rather than treating a part as terminal on first sighting. | active | `worker/src/driver/prompt-await.ts:599-631`; `worker/src/exec/exec-server.ts:1526-1550`
- C2 | Consume the selected channel's deltas without cross-channel scrolling, and provide a DM polling fallback. | active | `web/hooks/use-realtime.ts:359-364`; `web/app/(main)/teams/[id]/session/page.tsx:260-275,687-693`
- F | Run structural, type/build, server/worker unit, Playwright, and real manual acceptance gates. | active | `scripts/gate.sh:7-21,84-105`; `web/e2e/pages.spec.ts`; `web/e2e/session-unification.spec.ts`

## Open assumptions (announced defaults)
<!-- assumption | adopted default | rationale | reversible? -->
- Group-chat delta behavior | Do not add group-channel `message.part.delta`; keep the existing contract where group process output is private/internal and final group replies are direct MCP messages. | `server/src/workers/worker-event.ingress.ts:570-579` explicitly documents that routing and the user request is the private-chat page. Adding group deltas would risk duplicate/interleaved group messages. | yes; revisit only with an explicit group-stream product decision.
- Low-priority collapse policy | Collapse long process cards, tool I/O, thinking, unknown diagnostic parts, and attachment detail; keep errors and abort notices visible by default. | Errors/aborts are high-priority state, while the user asked to hide unimportant detail. | yes.
- Density defaults | Body threshold 800 characters / 10 lines; tool I/O excerpt 2000 characters; thinking excerpt 200 characters. | These directly address the verified 360/6-line, 500-character, and 60-character limits while retaining a bounded default. | yes.
- Typography defaults | Body 14px, identity 12px semibold, metadata 11px; hierarchy comes from weight, color, spacing, and containment rather than making the identity label larger than body copy. | Avoids the contradictory “identity must be >= body” rule in the earlier draft while still making identity readable. | yes.
- Test strategy | Tests-after for the UI contract, plus agent-executed happy/failure QA and existing server/worker unit suites; no `web` Jest suite is assumed because `web/package.json` has no Jest script. | The repository has Playwright web tests and server/worker Jest suites, not a web unit-test runner. | yes.
- C0 capture method | Trigger one real private generation, obtain the opencode session id/base URL from the worker's live capability/runtime path, poll `GET /session/{id}/message` at 500ms, and record the same assistant `text` part id plus text length at every sample until `step-finish`. | This is the exact endpoint used by `V1Driver.getMessages` (`worker/src/driver/v1-driver.ts:313-317`) and the same cadence used by `prompt-await.ts`; it avoids inferring streaming from historical SSE evidence. | yes.
- Incremental merge contract | If C0=PASS, worker emits the latest full snapshot for a changed stable text `part.id`; server replaces that part by id instead of appending a duplicate. Parts without ids keep the existing append-only fallback. | The current server path is `oldParts + kept` (`worker-event.ingress.ts:600-605`), so changing only the worker tracker would duplicate text parts; full snapshots make replacement unambiguous. | yes; C0=FAIL skips C1.
- Grouping window | Consecutive agent messages group only within 5 minutes, with the same `senderType + senderId`, and never across a date boundary. | 5 minutes is a reversible readability default; no repository contract dictates another value. | yes.
- Message token source | Add a message-scoped 14px body token; do not change global `fontSize.md=13`. | The existing scale has no 14px step and changing it would restyle unrelated consumers. | yes.
- Tool I/O cap semantics | 2000 is a hard display excerpt cap; expanded output is guaranteed to show at least the first 2000 characters, not the entire original string. | The user approved a density threshold, not unlimited rendering. | yes.
- C1 dependency surface | C1 includes both `worker/src/driver/prompt-await.ts` and `server/src/workers/worker-event.ingress.ts`/`message-parts.ts` merge tests; event names and payload shape remain unchanged. | The worker-only change would be unsafe with the current append merge. | yes.
- Error/abort detail | Error and abort headers/summaries are always visible; an optional long-detail toggle defaults expanded. | This preserves high-priority state while allowing long diagnostics to be folded only when needed. | yes.

## Findings (cited - path:lines)

1. The private message body is the only chat clamp: `CHAT_COLLAPSE_THRESHOLD = 360` and `WebkitLineClamp: 6` in `web/src/components/ui/chat-bubble.tsx:117-120,238-248`; the toggle already exists at `:256-277`.
2. Tool I/O is hard-truncated at 500 characters in `web/src/components/chat/msg-parts.tsx:51-69`; thinking uses a 60-character excerpt in `msg-thinking.tsx:40-42,96-112`.
3. `MsgParts` filters non-text parts and renders each process part independently at `web/src/components/chat/msg-parts.tsx:114-170`; process components render their own avatars/identity (`msg-thinking.tsx:57`, `msg-tool.tsx:69`, `msg-error.tsx:63`). The top-level container has no shared identity rail (`:119-120`).
4. The message list uses `messages.map((msg) =>` at `web/app/(main)/teams/[id]/session/page.tsx:1289`; there is no previous-message comparison, date separator, or distinct system grouping. `formatTime` at `:90-96` returns only `HH:MM`.
5. `ChatBubbleProps` has no message status at `web/src/components/ui/chat-bubble.tsx:39-51`; user messages skip header/avatar at `:117-120,138-140`; the role label is an either/or fallback at `:165`; unknown part types return `null` in `msg-parts.tsx:169`.
6. `web/hooks/use-sse.ts:139-171` uses a singleton EventSource and dispatches each frame immediately; `use-realtime.ts:359-364` already upserts `message.part.delta`; the page subscribes without an `onMessagePartDelta` handler at `web/app/(main)/teams/[id]/session/page.tsx:687-693`.
7. DM history has no polling interval at `web/app/(main)/teams/[id]/session/page.tsx:260-275`, while the group query has 30 seconds at `:254-259`.
8. `MessageDeltaTracker.extractNewParts` marks a part key sent on first observation and skips later observations at `worker/src/driver/prompt-await.ts:599-631,622-626`. Historical live frames in `.omo/evidence/dm-stream-debug/frames-private-channel.txt` show a text part arriving complete in the second delta frame, so static code and historical evidence do not prove token-level streaming.
9. `server/src/workers/worker-event.ingress.ts:570-579` explicitly treats group-process deltas as private/internal and skips them when no private target exists; this is a contract to preserve, not an omission to fix.
10. The working tree already contains unrelated modifications in `.omo/boulder.json`, `.omo/ulw-execute/ledger.jsonl`, `.omo/evidence/**`, and `.opencode/opencode.json`; execution must not overwrite or include them.

## Decisions (with rationale)

- Keep the SSE event names, message storage shape, and status enum unchanged; the verified SSE transport is not the primary defect.
- Use one shared identity rail per agent message and make consecutive same-sender rows reuse that rail; do not introduce a second parallel identity attribute.
- Keep critical state visible: failed/error and aborted rows are not default-collapsed.
- Make the C1 worker/server change conditional on C0. If C0 fails, the plan still completes the private-page delta consumption, scoped scrolling, first-frame refetch, and polling fallback, but must not claim token-level streaming or modify the tracker/merge path.
- Split implementation and tests into the same todo, one commit per todo; the worker and server packages remain independent.
- The final plan must include a nested `Recommended task executor category:` line for every implementation row and a real `Final verification wave` with F1-Fn rows.

## Scope IN

1. Density/type-scale changes in `web/src/components/ui/chat-bubble.tsx`, `web/src/components/chat/msg-parts.tsx`, and `web/src/components/chat/msg-thinking.tsx`.
2. Shared identity rail and consecutive-sender grouping in the chat render tree.
3. Date separators, system-message visual separation, and status-row containment in `web/app/(main)/teams/[id]/session/page.tsx`.
4. User status marker, human initials, safe author fallback, theme-aware role colors, and visible-but-collapsed unknown-part diagnostics.
5. C0 live serve verification and, only if it passes, worker `MessageDeltaTracker` plus server part-id merge delta semantics.
6. Page-level `onMessagePartDelta` handling with selected-channel scroll gating, first-frame refetch, and DM polling fallback.
7. Existing server/worker unit tests, targeted Playwright coverage, `bash scripts/gate.sh`, and real private-chat manual acceptance.
8. Before web product-code edits, the executor must read the relevant Next.js guide under `web/node_modules/next/dist/docs/` as required by `web/AGENTS.md`; this is a process constraint, not a new feature.

## Scope OUT (Must NOT have)

- No SSE protocol/event-name changes and no middleware buffering change.
- No message schema columns, migrations, status-enum changes, or history-model rewrite.
- No new runtime dependency, streaming animation library, virtual list, or mobile/responsive redesign.
- No change to the deliberate group-chat delta contract or group final-message routing.
- No `web` Jest suite assumption; use the repository's actual Playwright/server/worker test surfaces.
- No mutating `npm run lint` / `--fix`; use check-only lint.
- No edits to unrelated dirty-worktree files or to `.omo/evidence/`/`.omo/plans/` content in product commits.

## Metis review and repair

- Mandatory Metis review completed read-only before plan repair. It identified ten blockers: stale group-delta C2, invalid web Jest command, contradictory typography acceptance, error/abort over-collapse, missing executor categories/evidence fields, non-executable C0, contradictory C0 dependencies, destructive dirty-worktree cleanup, unverifiable tool-I/O success wording, and missing Next.js AGENTS constraint.
- All ten blockers were folded into `.omo/plans/chat-ux-hierarchy-and-streaming.md`; the plan now has 14 implementation rows, 5 final-verifier rows, per-row category/evidence/QA fields, a concrete C0 capture procedure, group-routing Scope OUT, and worker+server merge coverage for C1.
- A second Metis pass found one remaining hard-cap wording blocker (tool I/O “展开全文”); it was corrected to require exactly the first 2000 characters in both collapsed and expanded DOM, with character 2001 absent. The structural self-check then passed with zero missing fields.
- Additional repository verification found that the current server merge is `oldParts + kept` at `worker-event.ingress.ts:600-605`; C1 therefore explicitly includes part-id merge tests rather than a worker-only change.
- No owner question remains: tests-after, group routing preservation, 5-minute grouping, message-scoped 14px token, 2000-character hard display cap, and error/abort default visibility are recorded as approved reversible defaults.

## Open questions

- None blocking. Any future request to expand group-chat streaming or make 2000-character tool output unlimited would reopen the corresponding Scope OUT/default and require a new approval.

## Approval gate
status: approved
brief: The user approved preserving the group-chat delta contract, tests-after with agent-executed happy/failure QA, and the complete A/B/C scope. The plan artifact has been repaired after mandatory Metis review and is ready for handoff. Approval authorized plan writing only; no product implementation was performed.
next: present the plan handoff, explain the executor command and verification gates, and stop. Do not start `$ulw-execute` from this planning session.
