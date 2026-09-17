# method-note: independent re-derivation (misleading_success_output guard)

The driver's cached numbers are NOT trusted on their own. `/tmp/todo10_verify.py` (deleted after run;
logic summarized here) re-paired every sample from DB ground truth:

1. Enumerated all 101 probe user messages (`messages WHERE channel_id='c_0000000018' AND sender_type='user'`).
2. For each message, took the earliest UNUSED `realtime_events session.updated{running}` for a probe-team
   session within (msg, msg+120s). Unused-event tracking guarantees no double-counting.
3. For each pair, fetched the earliest first-token trigger row for that session after (msg−5s) and read
   `payload.dispatchedAt` (exact watchdog-start ms).
4. Asserted: exactly ≥1 running event per message (101/101, zero missing), no second running event for the
   same session within the window (zero double-fires), trigger `dispatchedAt` within a sane window.
5. Recomputed both lags purely from DB values. Result matched the driver: upper P50/P90/P99/max =
   75/163/2214/2407ms; exact = 13/26/119/121ms. `samples.json` is this re-derived set.

Result: problems = [] (see run output). The 101 events pair 1:1 with the 101 messages, and
`session.updated` rows for probe sessions total exactly 202 = 101 running + 101 idle turn-ends,
confirming one clean turn per dispatch with no hidden extra executions.
