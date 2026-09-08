# team-loading-filter — fix note

## Root cause (unit-reproduced pre-fix, `repro-pre.log`)
`matchesScope` in `web/hooks/use-sse.ts`, `team:` branch fallthrough (old L98):
`payload.taskId === id` only matched the bare team id. But the dispatcher
broadcasts team loading via `toExecutionScope(null, teamId)` =
`` `team:<teamId>` `` (server `worker-dispatcher.ts:742-750`), so every
`agent.loading / agent.error / agent.status / agent.question` with
`payload.taskId = "team:<teamId>"` evaluated false and was dropped client-side.
Red dots were unaffected (they ride `chat.message.new` through the `channel:` branch).
Pre-fix run: 4 fail / 5 pass — exactly the four prefixed loading types.

## Fix (`web/hooks/use-sse.ts` only, backend untouched)
`team:` branch now accepts both shapes:
`taskId === id || taskId === \`team:${id}\``.
Envelope choice (per task instruction): `SSEEvent` has NO `scopeType/scopeId`
fields (only `id/type/payload/timestamp`), so envelope matching is not relied upon;
`payload.taskId` dual-match is the robust match. Documented in code comment.

## Branch audit
- `task:` — no change needed. `toExecutionScope(taskId, …)` returns the BARE
  taskId (legacy task-mode shape), so bare `payload.taskId === id` is correct;
  team scope strings never legitimately match a `task:` subscription, and the
  session page no longer subscribes `task:` at all.
- `channel:` — no change needed. Matches `message.channelId`, orthogonal to the
  `taskId` prefix.
- `global` — no change needed (`task.status.changed` broadcast).

## Regression test (`web/hooks/use-sse.scope.test.mjs`, new)
web/ has no jest/vitest (only playwright e2e + tsc/eslint), and no new deps
allowed → Node built-in `node:test` + `node:assert`, tests the shipped
`use-sse.ts` source itself (extract + transpile via web's own typescript devDep).
Run: `node --test hooks/use-sse.scope.test.mjs` from `web/`.
Post-fix: 9/9 green (`unit-post.log`).

## Verification
- `tsc --noEmit`: EXIT 0, empty (`tsc.log`).
- `eslint` on both touched files: 0 errors; 1 pre-existing
  `react-hooks/exhaustive-deps` warning at `use-sse.ts:253` (untouched code,
  matches known F2 warning profile).
- Live `:13001` (see below): DM probe → spinner on working tab + bottom hint.

## Live proof (image `8129c8f0b523`, Created `2026-09-08T09:29:30+08:00`)
- Pre image: `73dd8b727bdc` (Created 08:57). `docker compose up -d --build web`
  ONLY — but compose also rebuilt+recreated the init/server IMAGES+containers
  from UNCHANGED source (see `web-rebuild.log`: `aiagents-compose-init/server Recreate`).
  db/worker containers untouched (uptime continuous). Post-rebuild: server
  `/health` 200, login OK, 4 teams intact — data verified, no `down -v` ever ran.
- Source mtime (fix 09:24) < image Created (09:29) → fix is inside served bundle.
- Cold-start: reset `tmm_0000000004` session → `s_0000000012`, sent DM probe
  "spinner 验证5…" as seed-admin on `/teams/tm_0000000001/session`.
- `live-spinner.png`: full page — probe bubble + bottom `项目经理-1 操作中…` hint.
- `live-tab-spinner.png`: close-up — active `私聊: 开发者-1` tab with spinner;
  DOM: `<span data-testid="dm-tab-loading-tmm_0000000004" role="status"
  aria-label="开发者-1 回复中">` (evaluated live, old code could never render this).
- Console: only the known pre-existing `/plans?taskId=` 404 noise (9×), zero
  filter-related errors.
- Residue: one DM probe message in developer-1 private channel (by design,
  mirrors prior `spinner 验证4` pattern); P0 storm traffic ongoing, untouched.
