# Plan: Agent Enable/Disable + Reset Session (Right Panel)

## Context
- Right panel TaskPanel currently shows mainAgent + team avatar stack, not full instance list with management. Left MembersPanel has instance list with add-private-chat but no enable/disable or reset.
- Need per-instance enable/disable (disable → cannot send) and reset session (new opencode session).

## Todos
- [ ] 1. Add TaskAgent.enabled field (migration, DTO, service)
- [ ] 2. Add POST /tasks/:id/instances/:iid/reset-session endpoint and service logic
- [ ] 3. Update chat message sending to block disabled agents
- [ ] 4. Frontend: add enable/disable toggle and reset button to agent list (right panel)
- [ ] 5. Frontend: disable send and @ candidate filtering for disabled agents

## Final verification wave
- [ ] F1. Toggle disable → @ and private send blocked with 400, enable → recovers
- [ ] F2. Reset session creates new Session with new instanceRef, old archived, history isolated
- [ ] F3. UI shows toggle state correctly and persists after reload
- [ ] F4. No regression on existing add-instance and private chat tabs

## Implementation Details
### 1. Backend enabled field
- File: `server/prisma/schema.prisma` add `enabled Boolean @default(true)` to TaskAgent
- Migration: `npx prisma migrate dev --name add_task_agent_enabled`
- DTO: `server/src/tasks/dto/update-team.dto.ts` handle enabled, `CreateTaskDto` default true
- Service: `server/src/tasks/tasks.service.ts` createInstances sets enabled=true, updateTeam handles toggle, toTaskDto includes enabled

### 2. Reset session endpoint
- File: `server/src/tasks/tasks.controller.ts` add `POST /tasks/:id/instances/:instanceId/reset-session`
- Service: `server/src/tasks/tasks.service.ts` add `resetInstanceSession(taskId, instanceId, userId)` → find TaskAgent, check enabled, create new Session via `SessionLifecycleService`, archive old
- File: `server/src/workers/session-lifecycle.service.ts` add method `resetSessionForInstance`

### 3. Block disabled agents
- File: `server/src/chat/chat.service.ts` in `resolveMentions` and `createMessage` check `TaskAgent.enabled` false → throw 400 AGENT_DISABLED
- Also check `WorkerDispatcher` dispatch target enabled

### 4. Frontend toggle + reset
- File: `web/app/(main)/tasks/[id]/page.tsx` TaskPanel/MembersPanel: add Switch (enabled) and Button (reset) per instance row, `data-testid="agent-enable-toggle"` and `data-testid="agent-reset-session"`
- Call `PATCH /tasks/:id/team` or new dedicated endpoint for toggle, and `POST /tasks/:id/instances/:iid/reset-session` for reset
- Show loading and error states

### 5. Send blocking
- File: `web/app/(main)/tasks/[id]/page.tsx` mentionable filter: `agentMembers.filter(a => a.enabled !== false)`, MessageInput disable if target disabled
- Also handle private tab: if active private agent is disabled, show banner and disable input

## Must-NOT-Have
- No new global route, no backend auth change, no design token change.

## References
- `server/src/tasks/tasks.service.ts:1306 createInstances`
- `server/src/workers/session-lifecycle.service.ts`
- `web/app/(main)/tasks/[id]/page.tsx: MembersPanel, TaskPanel`

## QA
- Manual: create task with 2 instances, disable one, try @ it → 400, enable → success, reset session → new sessionId, old history not mixed
- Automated: `npm run test -- tasks.service.spec` with new enabled field, `npx tsc --noEmit`

## Commit
- `feat(tasks): agent enable/disable and reset session per instance`
