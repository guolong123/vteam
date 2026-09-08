# loading-stuck-fix — brief log (2026-09-07)

## Root cause
`loadingByAgent` writes use canonical key `instanceId ?? agentId`, but ALL deletes
(onMessage agent arrival, onAgentStatus completed/failed, onSessionUpdated idle/…)
deleted exactly ONE key form. When start and terminal events used different forms
(e.g. `running` with bare `a_architect`, reply with `senderInstanceId ta_*`),
the entry survived forever → permanent "X 操作中…". No timeout existed.

## Fix (session page only, key handling + staleness)
- `agentKeysFor({instanceId, agentId})` — expands any key form to every known form
  for that agent (instanceId ta_ / agentId a_ / tmm_ via agentMembers + team.members).
- Writes unchanged shape: canonical `instanceId ?? agentId` (+ timestamp stamp).
- Deletes (onMessage arrival incl. error/session, onAgentStatus completed/failed,
  onSessionUpdated idle/frozen/archived) remove EVERY matching key via
  `removeLoadingKeys` (also scrubs timestamps, no-op render when key absent).
- Staleness net: single 60s interval drops entries with no update for 10 min
  (`LOADING_STALE_MS`; document choice: interval over lazy-render check so a stuck
  entry clears even with zero subsequent events/renders).
- Dot/spinner/label behavior unchanged: tab render, `clearUnreadForStateKey`,
  `handlePrivateTab`, unread-marking block, `loadingLabel/errorLabel` untouched.

## Verification
- `npx tsc --noEmit` → EXIT 0; `npx eslint <page>` → EXIT 0.
- Sim `/tmp/sim-loading-fix.mjs` (deleted after run): 8/8 — old logic reproduces
  stuck in BOTH directions (bare→instance, instance→bare); new logic clears both,
  tmm_-only terminal key clears, 11-min entry swept / fresh kept, sibling untouched.
- Live (dev :3001 + API_PROXY_TARGET=:13000, compose server/worker, team
  tm_0000000001): sent group message → `架构师-1 思考中…` (ev2-loading.png) →
  4s later auto-cleared, reply `收到，54321 ✅` (ev3-cleared.png, loading absent).
- Sibling hunks in same file (dm-tab spinner/unread-dot tab render @832/844/851/973)
  are foreign uncommitted work — not touched, not verified beyond regression reasoning
  above (dot set/clear paths byte-identical).
