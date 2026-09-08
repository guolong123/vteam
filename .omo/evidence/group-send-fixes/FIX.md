# group-send-fixes — fix note (UTC 2026-09-08)

## Root causes
- F-A cold-start silent drop: `buildTrigger` returns `no_session` when no team
  session exists yet. `createMessage` only ensured sessions via
  `dispatcher.buildTeamMemberTrigger` when `!effectiveTaskId` (zero-task path).
  With a current task inherited, `effectiveTaskId` non-null → ensure skipped →
  201 + `no_session` + empty dispatch targets, no error, no session created.
- F-B archived brick: `resolveChannelAccess` fallback `findFirst latest task`
  ignores status → archived task becomes context → `createMessage` archived
  guard throws 409 even though team direct chat is queue-independent.

## Fix (server/src/chat/chat.service.ts only)
1. F-A: ensure block now runs for ANY `channel.teamId` with triggers
   (removed `!effectiveTaskId` gate). `tmm_`-targeted `no_session` triggers are
   flipped via `dispatcher.buildTeamMemberTrigger` (ensureTeamSession),
   including the main-agent fallback's `no_session`. Single-member failure
   keeps `no_session` + logs (FR-21 shape); queued intercept downstream
   unaffected.
2. F-B: archived `task` on a team channel degrades to team-mode direct chat
   (synthetic `{status:'pending', teamId}`, `effectiveTaskId=null`,
   message without `taskId`, dispatch `taskId:''` + `teamId`) instead of 409.
   Legacy non-team channels keep 409. 403/404 guards untouched.
3. Fallback `findFirst` now excludes `archived` (`status: {not: archived}`);
   no active task → existing synthetic team-context path (team-mode).

## Red-first
- New `group-send-fixes` specs (F-A cold start, F-B degrade, F-B fallback
  filter) run against pre-fix service: 2 failed (proving both bugs),
  then green with fix.
- Existing archived-409 spec retargeted to legacy `task_group` (team_group
  now degrades by design).

## Live (compose, server container rebuilt only: `docker compose build server && up -d server`)
- BEFORE: `c_0000000002 @dev` → 201 `no_session` (m_0000000019/21);
  fresh `c_0000000004 @pm` → 201 `no_session` (m_0000000020);
  `c_0000000004` post-archive → 409 TASK_ARCHIVED. See `repro-before.md`.
- AFTER: same `@dev` → 201 `dispatched` session `s_0000000002` + agent replies
  (m_0000000029+); `c_0000000004` → 201 team-mode + agent reply m_0000000028;
  non-member still 403. See `verify-after.md`.
- Suites: chat.service 110 pass; chat+teams 360 pass; `tsc --noEmit` clean.
  Outputs in `suites-*.log`.

## Leftovers (recorded, existing rows untouched)
- New test rows: team `tm_0000000003` (smoke-gsf-fb) + member `tmm_0000000008`,
  task `t_0000000003` (archived), channels `c_0000000004`,
  sessions `s_0000000002` (tm_0000000002/tmm_0000000007),
  `s_0000000003` (tm_0000000003/tmm_0000000008),
  messages m_0000000019–m_0000000038 range in c_0000000002/c_0000000004.
- Pre-existing dirty worktree (docs/web/other server files) untouched; product
  diff is chat.service.ts + chat.service.spec.ts only.
- Adversarial notes: responses verified via response bodies AND DB SELECTs
  (not log text alone); fresh team/task used for F-B to avoid stale
  `currentTaskId`; F-A verified on both existing and fresh teams.
