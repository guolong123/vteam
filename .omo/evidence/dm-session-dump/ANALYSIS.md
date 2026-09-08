# DM worker-session raw dump — analysis

## Provenance (read-only)

- Live compose stack, team `tm_0000000001`.
- DM channel: `c_0000000003` (`type=private`, `team_member_id=tmm_0000000004`, developer instance).
- Bound platform session: `s_0000000020` (`agentId=a_developer`, `workerId=w_compose_worker`,
  `instanceRef=ses_f8555a2eaffeK5b1fW9dAGooVx`, `status=idle`, `updatedAt=2026-09-07 07:01:29`).
- Session chosen as backing the most recent DM exchange on that channel:
  platform DB rows `m_0000000051` (user, `evidence dm ping 1788764483399`, 07:01:23) +
  `m_0000000053` (agent reply, 07:01:28) line up with worker user entry `created=1788764483590`
  (= 07:01:23.590) and assistant reply right after it.
- Dump method: `GET http://localhost:14000/session/<instanceRef>/message`
  (host-mapped worker serve port; no auth — `SERVER_PASSWORD` unset; zero DB writes, zero restarts).
- Raw file: `raw-session.json` (5 entries, 32810 bytes, saved verbatim; only secret-keyword hits
  are benign `tokens` usage counters and `cwd` paths — no tokens/credentials present, no redaction needed).

## Raw entry skeletons

### U1 — `msg_07aaa5d46001I9wzc7WhUwJb2f` / role=user / created=1788764380486

- parts: 1 part.
  - `type=text`, `synthetic` key **absent** (no `synthetic` field at all),
    `text-head="【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）。需要群聊历史时调用 chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。\n\ndebug2 dm ping 1788764380083"`.
  - part keys: `id, messageID, sessionID, text, type`.

### A1 — `msg_07aaa5d4b001q5ytTqre0oyg1l` / role=assistant / created=1788764380491

- parts: `step-start`, `reasoning` (non-synthetic, discusses the ping), `tool`, `step-finish(reason=tool-calls)`.
- No `text` part → `text=""`, `kept=[tool]` (tool parts are kept for assistant).

### A2 — `msg_07aaa806e001D603K4EPgujPpF` / role=assistant / created=1788764389487

- parts: `step-start`, `reasoning`, `text="你好！我看到你发送了调试 ping 消息。请问具体需要我做什么？验收标准是什么？"`,
  `step-finish(reason=stop)`.

### U2 — `msg_07aabf006001JwEQFkZusf9FyH` / role=user / created=1788764483590

- parts: 1 part.
  - `type=text`, `synthetic` key **absent**,
    `text-head="【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）。需要群聊历史时调用 chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。\n\nevidence dm ping 1788764483399"`.

### A3 — `msg_07aabf00c001qFTh0uM5kzC7kq` / role=assistant / created=1788764483599

- parts: `step-start`, `reasoning`, `text="你好！我看到又一条调试 ping 消息。请告诉我具体需要做什么，以及验收标准是什么？"`,
  `step-finish(reason=stop)`.

## Q1 — Do `role=user` entries exist with non-synthetic, non-empty text parts containing the user's actual message verbatim?

Yes, they exist as first-class `role=user` entries with non-empty, non-synthetic (`synthetic` absent, not `true`)
`type=text` parts — BUT the user's actual message text is **not** in its own part. It is the **tail** of a
single text part whose head is the injected context block. Quote:

- U1 full text =
  `【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）。需要群聊历史时调用 chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。\n\ndebug2 dm ping 1788764380083`
- U2 full text =
  `【团队上下文】你当前在团队 tm_0000000001 直聊（无任务）。需要群聊历史时调用 chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。\n\nevidence dm ping 1788764483399`

The verbatim user strings (`debug2 dm ping 1788764380083`, `evidence dm ping 1788764483399`) match the
platform DB mirror rows (`m_0000000047`, `m_0000000051`) exactly, but they are inseparable from the prefix
at the serve-data level (one part, joined with `\n\n`).

## Q2 — Or are user texts only embedded inside injected context prompts?

Both statements are true at once — that is the crux. The entries ARE first-class `role=user` turns
(refuting "no user turns exist"), yet their text payload IS the injected prompt artifact
(confirming the "injected-context" claim). Mechanism (worker-dispatcher.ts:1829-1851): the dispatcher builds
`prompt = 【团队上下文】… + "\n\n" + request.text` as ONE string and sends it as a single user prompt, so
serve persists context + user text as one `text` part with no `synthetic` marker distinguishing them.

## Q3 — What would `convertSessionMessages` (chat.service.ts:490-579) do with each user entry?

- U1: **KEEP but MANGLE.** `p.type==='text' && !p.synthetic` passes (`synthetic` absent → falsy).
  `text` = full string including the `【团队上下文】…\n\n` prefix; `kept=[text part]`. Non-empty → pushed as
  `senderType=user` DTO whose `content.text` exposes the internal prompt prefix to the frontend.
- U2: **KEEP but MANGLE** — identical reasoning.
- Neither is dropped (the synthetic filter cannot fire: the flag is absent, and even if present on the part
  level it could not split one part into prefix vs user text).

Note: `mergeSessionWithPlatform` (chat.service.ts:591-622) currently excludes ALL non-agent session items,
so these mangled user DTOs never reach the frontend today — the exclusion is load-bearing, not redundant.

## VERDICT: architecture A (keep mirror)

Display-directly (B) does not suffice: the only first-class user turns in the worker session are
prompt-injection composites — a single non-synthetic text part fusing the `【团队上下文】` dispatcher prefix
with the verbatim user message, with no flag or part boundary separating them. Serving them directly would
leak internal prompt scaffolding into the DM transcript (and duplicate every already-mirrored user row, since
the verbatim tail equals the platform DB text). B would require either (a) the dispatcher to send context as
`synthetic` parts or a system prompt so serve marks them excludable — a product-code + worker-protocol change,
not a filter tweak — or (b) frontend string-stripping of the `【团队上下文】…\n\n` prefix, which is brittle
(prefix wording can drift; `\n\n` also occurs in genuine user text; already-mirrored rows would then render
twice — once from DB, once from session — unless merge keeps excluding session users, which defeats B).
Keep (A): platform DB remains the user-message source of truth; worker session stays an agent-only supplement.
