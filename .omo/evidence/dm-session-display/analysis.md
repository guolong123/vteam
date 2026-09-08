# dm-session-display — composite vs DB row pair (dedup rule evidence)

## Source pair (live compose, team tm_0000000001, DM c_0000000003)

- Worker session entry (raw-session.json): `msg_07aabf006001JwEQFkZusf9FyH`,
  role=user, created=1788764483590, 1 part, `type=text`, `synthetic` key ABSENT.
- Platform DB row: `m_0000000051` (user, `evidence dm ping 1788764483399`, 07:01:23).

## Containment check (python3 over raw-session.json, pre-code)

- Session composite text (len 133):
  `【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）。需要群聊历史时调用
  chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。\n\n
  evidence dm ping 1788764483399`
- DB user text: `evidence dm ping 1788764483399`
- Result: `sessionText.contains(dbText) == true`, and specifically the DB text is
  the SUFFIX after the `\n\n` separator (TAIL 40 chars =
  `teamId）。\n\nevidence dm ping 1788764483399`).
- Second pair holds identically: U1 (`msg_07aaa5d46001I9wzc7WhUwJb2f`)
  ends with `\n\ndebug2 dm ping 1788764380083` == DB `m_0000000047` text.

## Dedup rule (coded in mergeSessionWithPlatform from this evidence)

A session user entry is SKIPPED iff its `content.text` CONTAINS (substring) the
exact `content.text` of any DB user row in the same channel (empty DB texts
excluded from matching). Substring covers both the observed suffix-after-`\n\n`
shape and any future embedding; exact-equality would also hold today but is
brittler if the dispatcher ever appends trailing tokens.

- DM-sent message (DB row exists, worker ingested the prompt) → session
  composite contains the DB text → skipped → shows exactly once (DB row).
- Group @ text (no DB row in THIS DM channel) → no containment → shown as-is
  WITH the 【团队上下文】 prefix chunk (user-accepted, single source of truth).

## Known limitation (documented, not chased)

Task-mode group @ dispatches against task snapshot sessions (`ta_*`), NOT the
team-member session the DM binds (`tmm_*` via teamMemberId). So task-mode @ text
may NOT appear in the DM session display. Verify live in this task; if absent,
keep the code comment + this note and do NOT chase it.
