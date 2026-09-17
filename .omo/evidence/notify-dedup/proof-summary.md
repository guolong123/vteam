# Live proof summary — notify-dedup (2026-09-17)

Script: `live-proof.sh` (run from repo root). Full transcript:
`live-proof-transcript.txt`. Server was rebuilt from fixed code
(`docker compose up -d --build server`, `/health` 200,
`tools/list` proves `DESC_NORETRY=True`).

Marker `ddprobe-20260917`. Pairs chosen to stay within throttle budget
(PAIR_MAX=3/60s per pair, all ≤3): P1 main(02)→dev(04),
P2 main(02)→librarian(07), P3 main(08)→tester(10).

## (a) rejected notify creates zero rows
- A (task t_0000000001, kind=review, no triplet):
  `{triggered:false, reason:review-triplet, messageId:null}` + hint.
- `c_0000000001` 62 → 62, marker-A rows 0.

## (b) identical resend inside window reuses messageId, +0 rows
- B1 (kind=wake P2): `{triggered:true, reason:ok,
  messageId:m_0000002209}`, 1 row:
  `{"text": "@知识管理员-1 ddprobe-20260917-B 请确认收到"}`.
- B2 identical resend: `{triggered:false, reason:dedup,
  messageId:m_0000002209}` (SAME id), marker-B sender rows still 1,
  `message.create`/`broadcast`/`dispatch` all uncalled server-side.
- Side note: B2 caused NO second agent execution (the only librarian
  replies quote B1 and C) — dedup also prevents re-trigger.
- Window boundary: after `sleep 70`, B3 resend → NEW row
  `m_0000002215` (`triggered:true`). Expiry proven, no over-collapse.

## (c) no double-@ when content already opens with the mention
- C content `@知识管理员-1 ddprobe-20260917-C 请确认收到` stored
  byte-identically (single leading @), `mentions` JSON single entry
  (instanceId `tmm_0000000007`).
- stale_state: B vs C (different contents) → 2 separate sender rows,
  never collapsed.

## (d) terminal task does not break the flow
- D on completed `t_0000000002` (kind=review, no triplet): clean
  `{triggered:false, reason:review-triplet, messageId:null}`,
  `c_0000000007` 690 → 690, marker-D rows 0.

## Receipts / cleanup
- `message_receipts` for probe messages: 0 (wake never records).
- Probe execution side effects (B1/C dispatched real librarian turns
  before any dedup could apply — session-less target does NOT throw,
  it auto-creates session + executes): replies `m_0000002213/2214`,
  session `s_0000000021`, tgi `ti_0000000034/35`, 5 marker
  `realtime_events` — ALL deleted.
- Final: marker messages 0, marker events 0, sessions/tgi 0,
  `c_0000000001`=62, `c_0000000007`=690 (both back to baseline).
- Left in place (append-only observability, no marker content):
  generic `agent.loading`/`session.updated` lifecycle events from the
  probe window. Sibling live traffic on `c_0000000010`/`c_0000000007`
  untouched (all rows predate probe window).
