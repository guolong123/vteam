# todo-10 HARD GATE (PoC): dispatch → `session.updated{running}` lag — REPORT

Date: 2026-09-17 ~03:00Z. Worker: `w_compose_worker` (status `online`, verified at probe start).
Pass criteria (fixed): `P99 <= 30s` AND `graceMs >= P99 + 60s` → PASS, else DEGRADE.

## Verdict: PASS — recommended `graceMs = 90s`

- `L_upper` (message insert → running persisted, skew-free upper bound): **n=101, P50=75ms, P90=163ms, P99=2214ms, max=2407ms**
- `L_exact` (post-execute watchdog timestamp → running persisted): **n=101, P50=13ms, P90=26ms, P99=119ms, max=121ms**
- P99 (2.2s) <= 30s ✓. 90s >= P99 + 60s (= 62.2s) ✓ → **PASS**. `all_idle` may auto-wake with `graceMs = 90s`.

## Method (chosen after 3 hypotheses; zero instrumentation, zero rebuild)

- H1 (temp log lines in dispatcher + ingress): rejected — requires 2 baked-image rebuilds,
  touches production files, higher collision/cleanup risk, no better precision than H2.
- H2 (historical mining of the 720 existing `running` events): rejected as primary — only 2
  historical first-token trigger rows exist, so dispatch-side timestamps would be unattributed
  message guesses; kept only as sanity context.
- H3 (drive fresh controlled dispatches; pair DB-persisted timestamps) — CHOSEN. Grounds:
  1. `startPendingWatchdog` (worker-dispatcher.ts:3629) records `dispatchedAt = Date.now()` and
     todo-9's sidecar persists it into the trigger payload; `workerClient.execute()` (worker.client.ts:299)
     is fire-and-forget (202 accepted), so `dispatchedAt` ≈ worker-accept time.
  2. `handleSessionUpdated` (worker-event.ingress.ts:351) emits `session.updated` → persisted in
     `realtime_events.created_at` (DATETIME(3)).
  3. Both endpoints are server-side persisted timestamps — no code changes, no rebuild, no clock-sync
     protocol needed. Pairing is unambiguous because the driver holds each session idle and allows only
     one in-flight dispatch per session; re-verified from DB ground truth (101/101 exact single-pair,
     zero double-fires, zero censored).

Two metrics bracket the true `dispatchAgentMention() → running` lag:
- `L_upper = realtime_events.created_at − messages.created_at` — same DB clock (zero skew), covers
  inbound routing + dispatch + worker accept + return + ingress emit. Strict UPPER bound.
- `L_exact = realtime_events.created_at − trigger.payload.dispatchedAt` — excludes the ~ms compose-network
  server→worker transit (dispatchedAt is taken after `execute()` resolves) and may carry ~10ms
  server-vs-DB clock skew. Slight UNDER-estimate, negligible at this scale.
- True lag ∈ [L_exact, L_upper]. Verdict is taken on L_upper (conservative side).

## How N dispatches were driven

- Isolated probe team `tm_0000000010` (name `probe-todo10-lag`, admin-created, 5 members — one per
  template agent a_product/a_developer/a_tester/a_architect/a_project_manager), team_group channel.
- 101 × `POST /api/v1/channels/:id/messages` with single-member mention
  `{type:'agent', agentId, instanceId}`, text `PING <n>: reply with exactly the word pong…`.
  Every POST returned `triggers:[{status:'dispatched'}]`; all 101 turns were REAL model turns on the
  LIVE worker (agent replied `pong`; sessions cycled running→idle normally).
- Driver (`/tmp/todo10_driver.py`, deleted after run): round-robin over 5 sessions, dispatch only to
  idle sessions, one in-flight dispatch per session, 2s DB poll, 75s per-sample deadline (first-token
  watchdog is 60s — beyond that the platform itself declares the turn dead). 100 driver samples in 164s
  + 1 pilot = **n=101**. Zero censored samples. Running fires at turn START (worker sends
  SESSION_UPDATED before the model call), so completion was never waited on for the sample itself —
  idle-wait only gates the NEXT dispatch to the same session.

## Distribution

`L_upper` histogram (ms): 50–100: 81 | 100–150: 8 | 150–200: 5 | 200–300: 1 | 300–500: 1 |
500–1000: 0 | 1000–2000: 1 | 2000–5000: 4 | >5000: 0.

Slow-5 (all real, kept in P99): 4 samples from the initial 4-way parallel burst
(msg→watchdog gap ≈1.8–2.2s — worker-accept serialization under burst) and 1 sample under background
load (gap ≈2.4s). I.e. the tail is worker-accept contention, which L_upper correctly includes and
L_exact correctly excludes — the bracket behaves as designed.

## Biases & limits (stated explicitly)

1. L_upper overestimates by inbound chat routing (~10–60ms typical) + ingress→emit (~ms). Conservative.
2. L_exact underestimates by server→worker HTTP transit (~1–5ms, compose network) + ≤~20ms clock skew.
   Negligible vs the 60s buffer.
3. Load regime: ≤4-way dispatch burst + ambient live traffic (incl. one sibling session active).
   Heavier contention (10+ concurrent dispatches) untested; the +60s buffer absorbs ~25× the observed P99.
4. Sessions were warm (created on first dispatch; pilot includes one cold session-creation sample).
   Cold-start (worker spawn) effects, if any, are inside the measured numbers.
5. Numbers are real paired timestamps (DB rows), not estimates. Re-derivation script re-paired all 101
   from ground truth independently of the driver's cached values (see `method-note.md`).

## Cleanup receipt (probe is TEMPORARY — nothing remains)

Deleted, all probe-scoped by ID (team `tm_0000000010`):
realtime_events 505 (session/agent.loading) + 1021 (chat.message.new + message.part.delta) + 2
(team.created rows for the probe team id) + 1 (re-verified create row) = 1529; messages 404 (101 user +
101 agent in team_group + 202 mirrored in 5 auto private channels); triggers 101 (cancelled
first-token rows); sessions 5; chat_channels 6; task_group_instances 10; team_user_members 1;
team_members 5; teams 1.
Post-cleanup: teams 6 / members 19 / sessions 9 / channels 16 = baseline exactly; memories 46,
artifacts 40, issues 28, agent_questions 2 unchanged; zero rows referencing probe ids remain
(re-swept realtime_events/triggers/messages). No code files touched (no instrumentation ever written —
no rebuild needed); driver/verify scripts lived in /tmp and are deleted; `git status` shows only this
report dir + notepad append. Worker-container runtime residue (opencode `ses_*` serve state, workdirs
under /data/vteam-worker) is out of repo/DB scope and disclosed here.
