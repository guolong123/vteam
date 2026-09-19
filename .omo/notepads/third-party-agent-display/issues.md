# Issues — third-party-agent-display

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo 1 — notes/observations

- `GET /agents/omo-agent-prompt` for `vteam-product` returns `empty:true` (built-in vteam
  agents have no engine-side prompt text); `prometheus` returns ~1.1KB. Todo 2's UI should
  not treat `empty:true` as an error.
- Calling `omo-agent-prompt` immediately after `docker start worker` yields 503
  (worker not yet heartbeating) — transient; retry after ~15s.
- The existing agents service spec's strict `toEqual` on the happy-path result had to become
  `agents.map(a => ({...a, governed:false}))` because the default `buildAgentPolicies` mock
  returns only vteam built-ins.
