# browser-isolation — per-agent isolation (option A) design note

## Pinned CLI (empirical, this version only)
- `agent-browser 0.27.0` (`agent-browser --version` in aiagents-compose-worker).
- Full `--help` in `agent-browser-help.txt`. Isolation primitives present:
  - `--session <name>` (global; `AGENT_BROWSER_SESSION`): isolated browser —
    own daemon socket (`~/.agent-browser/<name>.sock`), tabs, refs, cookies,
    storage. Core skill doc: "Each `--session <name>` is an isolated browser
    with its own cookies, tabs, and refs."
  - `--profile <name|path>` (`AGENT_BROWSER_PROFILE`): Chrome user-data-dir;
    a directory path materializes a real profile (`Default/`, `Local State`,
    `DevToolsActivePort` lock lives INSIDE the dir → separate paths = no lock
    contention, no shared cookie jar). Verified: populated dir listing.
  - `close --session <name>` closes one session; `close --all` kills all.
- NO `--context` flag in 0.27.0. Do not assume it in future edits without
  re-running `--help` (upstream #1068/#1114 version-sensitivity).

## Flags injected by the shim (worker/src/browser/browser-tools.ts)
Per tool call, identity from opencode `ToolContext` (2nd `execute` arg — this
is the thread-through; no global mutable current-session):
`--session <scope> --profile <workDir>/browser-profiles/<scope>/` prepended
as GLOBAL options (before the agent's subcommand), unless the agent already
passed `--session`/`--profile` (explicit respected, no double-inject).
- scope = sanitized `ToolContext.sessionID` (== `ExecuteRequestPayload.sessionId`,
  the ses_* id; `[A-Za-z0-9_-]`, ≤64) → else stable `member-<fnv1a8hex>`
  from `directory|agent` (task/member-scoped fallback; same agent re-attaches
  to ITS scope) → else `default`.
- `close --all` is rejected in-shim (would kill other agents' daemons); bare
  `close` is scope-injected → closes only the caller's session.

## Daemon lifecycle (chosen strategy + why)
Per-scope daemons owned by the CLI (created on first `open`, one Chrome per
scope). Upstream notice "`--profile` ignored: daemon already running" on
repeat commands is BENIGN (first launch honored the flag — dirs populated;
the flag cannot retarget a live daemon, which is already correctly scoped).
No per-profile mutex/queue: two concurrent `--session` opens were proven
parallel-safe (both exit 0, separate `.sock` daemons) — a global lock would
defeat option A. Retention: profile dirs under the persisted
`vteam_worker_data` volume are KEPT (login persistence is the point);
same-scope reuse attaches to its own daemon/profile automatically.
Ops prune: `rm -rf` idle scope dirs + scoped `close` as needed.
`exec-server.runExecution` pre-creates the scope dir best-effort
(`browserProfileRoot` = worker workDir, wired in index.ts; absent = skip, so
unit tests never touch the real fs; shim re-ensures at runtime regardless).

## Concurrency
No guard added (empirically unnecessary). Evidence: `live-2agent.log` —
concurrent opens exit 0/0 with separate daemons; A `get url` ==
https://example.com/ while B == https://example.org/ (no tab hijack);
A cookie shows only its marker, B only its own (values redacted, names
asserted); localStorage likewise (`<own>|null` cross-reads); separate
profile dirs on disk with Chrome profile contents.

## Files changed (scoped; no commit)
- worker/src/browser/browser-tools.ts (helpers + isolated shim template)
- worker/src/browser/browser-tools.spec.ts (new: 11 tests)
- worker/src/exec/exec-server.ts (browserProfileRoot option + pre-create)
- worker/src/exec/exec-server.spec.ts (+1 thread-through test)
- worker/src/index.ts (wire config.workDir → browserProfileRoot)
Server/web/db/models untouched. No new dependencies.
