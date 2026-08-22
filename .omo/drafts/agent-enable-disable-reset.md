# Draft: Agent Enable/Disable + Reset Session (Right Panel)

## Meta
- slug: agent-enable-disable-reset
- intent: clear
- review_required: false
- created: 2026-08-21
- status: awaiting-approval

## Context
- Current right side TaskPanel shows mainAgent + team avatars, not full instance list. Left MembersPanel shows instance list with add-instance, private chat, but no enable/disable or reset.
- User wants: in the agent list (right side, supports add) add enable/disable toggle and reset session (bind new opencode session). Disable → cannot send message to that agent; reset → new session.

## Decisions
- Data model: TaskAgent has removedAt (soft delete) but no enabled flag. Need to add enabled or use removedAt vs frozen? Decide to add `enabled` boolean or `status` field. Default: add `enabled` boolean (true default) to TaskAgent, keep removedAt for hard remove. Simpler than repurposing removedAt.
- Reset session: Create new Session for that instance, status=active, new instanceRef (opencode session id), old session frozen/archived. Use existing SessionLifecycleService.

## Open Forks
1. **Enable/disable granularity**: Per-instance (ta_*) or per-agent (a_*)? Default: per-instance (same as add).
2. **Reset scope**: Reset only that instance's session, or also clear its chat history? Default: new session, old history kept but not visible (archived).

## Research Grounding
- `server/src/tasks/tasks.service.ts: createInstances` creates TaskAgent with workDir, alias, seq.
- `server/src/workers/session-lifecycle.service.ts` handles Session binding.
- `web/app/(main)/tasks/[id]/page.tsx: MembersPanel` handles private chat, `TaskPanel` shows team.

## Plan Outline
- Add `enabled` to TaskAgent model + migration, update DTOs, service, and frontend toggle.
- Add `POST /tasks/:id/instances/:instanceId/reset-session` endpoint.
- Frontend: in right panel agent list, add Switch for enable/disable and Button for reset, disable send when disabled.

## Approval Gate
- Awaiting your OK to generate full plan.
