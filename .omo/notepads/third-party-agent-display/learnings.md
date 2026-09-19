# Learnings — third-party-agent-display

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — governed flag on /agents/opencode (2026-09-19)

- Single-source derivation is one line of wiring: `AgentsService` already injects
  `ExecutionPolicyService` (constructor arg 6), so `listOpencodeAgents` just calls
  `buildAgentPolicies()` and does set membership. No new endpoint, no worker/client change,
  no `startsWith('vteam-')` anywhere.
- Wire shape stays additive by extending the element type only:
  `export type OpencodeAgentEntry = WorkerAgentInfo & { governed: boolean }` defined in
  `agents.service.ts` — deliberately NOT touching `worker.client.ts`.
- Live compose proof (the whole point of this plan): with the real worker,
  `/agents/opencode` returned 24 engine agents, exactly the 8 `vteam-*` names governed,
  and the governed set was set-equal to `/agent-policies` agents (8). External names like
  `Prometheus - Plan Builder`, `build`, `plan`, `oracle` all `governed:false`.
- Degraded path verified for real: `docker stop aiagents-compose-worker` →
  `{"agents":[],"workerId":"w_compose_worker","degraded":true}` HTTP 200 (no throw).
  Note: with an explicit `workerId` the degrade path preserves that workerId (first return
  branch); the catch branch returns `workerId:null`.
- `docker compose up -d --build server` recreates the `init` container as a dependency but
  it is idempotent (`Exited 0`) and did NOT reseed — data (8 agents incl. `myagent`) intact.
  Safe; never use `--force-recreate`.
- Server jest baseline moved 3186 → 3190 (4 new tests), 139 suites, whole suite ~17s.
