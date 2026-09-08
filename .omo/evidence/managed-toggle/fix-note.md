# Fix note — dead managed-mode toggle → team endpoint

Backend contract (already live, verified in `server/src/teams/`):
- `UpdateTeamDto.managedMode?: boolean`, `TeamsService.update` writes `data.managedMode`,
  `toTeamDto` outputs `managedMode` (default false). `PATCH /teams/:id` returns full DTO.
- Tasks endpoints ignore `managedMode` → frontend writes to `/tasks/*` were dead.

Frontend changes (4 files, web only):
1. `web/src/api/teams.ts` — `TeamDto += managedMode: boolean`,
   `UpdateTeamPayload += managedMode?: boolean` (page's team query now carries it).
2. `web/app/(main)/teams/[id]/session/page.tsx` — `managedModeMutation` now
   `teamsApi.update(teamId, { managedMode })`; cache write/invalidate moved from
   `["task", currentTaskId]` to `["team", teamId]`. Section banner amended to note
   team-level routing (pre-existing banner style, kept consistent).
3. `web/src/components/teams/TeamRightPanel.tsx` — config-tab switch reads
   `team?.managedMode ?? false` (was `task.managedMode`); props/callback shape unchanged.
4. `web/app/(main)/tasks/new/page.tsx` — dead 托管模式 toggle removed (TaskForm is
   local-only, single caller in same file — verified by grep); state, POST field,
   props, and header comment updated.

Untouched: `question.managedMode` readers (use-realtime, question-modal, session
pending filter), `task-detail-types.managedMode`, `web/e2e/*`, `server/`.

Verification:
- `tsc --noEmit` exit 0 (`tsc.log` empty); eslint 0 errors, 1 pre-existing
  `react-hooks/exhaustive-deps` warning on untouched `teams` useMemo (`eslint.log`).
- Rebuild `docker compose up -d --build web` 01:49:54Z→01:53:38Z (`rebuild.log`);
  `aiagents-compose-web` Created 2026-09-08T01:53:19Z; server/db/worker untouched
  (up 22min/2h).
- Live :13001 Playwright (seed-admin, team tm_0000000001): switch false→true via
  PATCH /teams/:id, `aria-checked=true` after reload, flipped back to false
  (`playwright.log` 1 passed; `toggle-before/after/reload-*.png`).
- API double-check both directions persisted on re-GET (`api-persist-*.log`).
- Final `GET /teams/tm_0000000001` → `managedMode: false` (original value, no residue).
- `git status`: scoped diff = 4 web files only; `web/hooks/use-sse.ts`,
  `.omo` ledger/learnings modifications are pre-existing foreign state, untouched.
