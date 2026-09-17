# Learnings — notify-dedup

Conventions, patterns, and successful approaches discovered during work on this plan.

## notify-dedup fix (2026-09-17)
- Gate order in `notifyAgent` (`server/src/platform-mcp/platform-mcp.service.ts`):
  resolveExecContext → channel → target validation → routing gate (403,
  untouched) → kind+forceReason → throttle → issue-lock → plan+hash →
  review-triplet → dedup probe → persist+broadcast → (force audit /
  review openRound sidecars) → dispatch → receipt nudge → success.
  Sender resolution moved to just before persist (gates don't need it).
- Reject = nothing published: all `triggered:false` paths return
  `messageId:null` (type now `string | null`); only `dedup` returns a
  non-null id (the reused row). `force` bypass sets a flag; the audit
  receipt is written after persist (needs the new messageId).
- Dedup rule: same channel + same `senderInstanceId` + normalized text
  (`trim` + collapse whitespace runs, case-sensitive) within 60s
  (`NOTIFY_DEDUP_WINDOW_MS`, scan cap 20, `reason='dedup'`). Predicate
  pushes channel/sender/time to the DB, exact compare in JS (avoids
  MySQL JSON-path dialect). Read-error → fail-open warn + persist.
- Double-@ rule (`startsWithTargetMention`): trimStart + prefix match +
  next-char boundary (end/whitespace/CJK-ASCII punct set). Exact-token
  comparison REJECTED after a failing test: CJK agents glue punct
  (`@测试，请看`, no space) — token-strip missed it. Documented
  conservative bias: `@测试-2` vs target `测试` (and `@测试你好`)
  still gets prefixed (attribution over display).
- Prompt guidance in 3 places: `notify_agent` tool description (+ `kind`
  describe: 被拦不落库不广播), new `【通知重发】` paragraph appended to
  `GLOBAL_BASE_LINES` (append-only: all dispatcher specs use
  `toContain`, zero breakage), per-reject `hint` (shared
  `NOTIFY_NOT_PUBLISHED_HINT`; plan/review hints extended, not replaced).
- Spec churn (all equivalent-or-stronger, never weakened):
  service.spec (3 throttle rejects → null+zero-row; +10 new: 5 dedup +
  5 mention-prefix) / gate (4 rejects → null+zero-row+broadcast +
  `findMany` not-called ordering) / review-dispatch (3) / plan-hash (2)
  / receipt-nudge (1) / review-round-open (1). Five gate specs needed
  `message.findMany` mock + `[]` default. Controller spec untouched
  (generic passthrough).
- Live surprises: (1) dispatch to a session-less member does NOT throw —
  it auto-creates session + runs a real turn (replies quote the marker;
  cleanup must cover messages+events+sessions+tgi). (2) Dedup-hit
  provably prevents re-trigger (only first-send + distinct-content sends
  got replies). (3) `c_0000000010` traffic during probe window was
  sibling live work (all rows predate window) — verify by timestamp
  before touching.
- Suite: baseline 123/2848 → final **123/2858 green** (+10 new, 0 reg);
  `tsc --noEmit` 0 both ends. Tree dirty-but-intact, no commit/stash;
  sibling WIP (seed/agent.constants/role-guard/worker-dispatcher.spec)
  untouched.
- Evidence: `.omo/evidence/notify-dedup/` (`live-proof.sh`,
  `live-proof-transcript.txt`, `proof-summary.md`, `jest-after.txt`,
  `tsc-after.txt`).
