# ROOTCAUSE — DM 私聊自己发的消息不显示

Date: 2026-09-07 · Live stack: compose (:13000/:13001) · team tm_0000000001 · DM channel c_0000000004 (team + tmm_0000000005 测试-1)

## Repro (evidence files in this dir)

1. `dm-create.json` — POST /dm-channels {teamId, teamMemberId: tmm_0000000005} → c_0000000004（幂等返回既有频道，内已有 3 条 DB 行 + 8 条 worker 会话项，见下）。
2. `session-before.txt` — GET session-history BEFORE: `source=session`, 8 items, 全部是 worker 侧 opencode 会话消息（msg_ id）：user 项文本均为 `【任务上下文】…` 注入提示，agent 项为旧回复。**平台 m_ 消息一条不在其中**。
3. `db-before.txt` — GET /messages BEFORE: 3 items: m_17/m_18 (user) + m_19 (agent)。即：DB 有用户消息，session 视图没有。
4. `probe-text.txt` + `post-resp.json` — POST /channels/c_0000000004/messages {text: "own-msg-probe-…"} → 201, `m_0000000025` (user), triggers=[{a_tester/tmm_0000000005/s_0000000018, dispatched}]。
5. `session-after.txt` — POST 后 ~3s 再 GET session-history: `source=session`, **items=1**，仅剩新会话的注入提示 user 项；m_25 不在其中。
6. `db-after.txt` — 同时刻 /messages: 4 items，含 m_25。DB 落库正常，广播 chat.message.new 正常（SSE upsert 能短暂补上，但紧随的 invalidateQueries refetch 用 session 列表整体替换 → 自己消息消失）。
7. `session-late.txt` / `db-late.txt` — +75s 后：session=2 items（user 上下文+probe 文本拼接、agent 回复 `msg_07a82f465…`），DB=5 items（含 m_25 + 最终 agent 回复 m_26，其 parts 携带 reasoning/tool 且 `messageID=msg_07a82f465…` 与 session agent 项同 id）。

## Verdict — H3 CONFIRMED (primary) + H1 CONFIRMED (aggravating) · H2 REFUTED

- **H3（worker 历史结构性缺用户消息）— 主因，CONFIRMED**。`getSessionHistory` (chat.service.ts:386-470) 在会话已绑定时**只返回** `convertSessionMessages(worker getMessages…)` 的结果。worker 侧用户消息是 prompt 注入路径产物：用户文本被拼进 `【团队上下文】…` 上下文消息里，不存在与平台 `m_` 行一一对应的独立 user 条目（`session-after.txt` 1 item / `session-late.txt` user 项文本为上下文+probe 拼接可证）。因此 session 源**永远**不会出现自己的消息；且旧会话切换后（8→1 items）连历史 agent 回复都从视图消失，而 DB 全量保留。
- **H1（POST 后立即 refetch 遇到 worker 未 ingest）— 次因，CONFIRMED**。POST 后 3s 时新会话只有 1 条注入提示（prompt 尚未 ingest），此时前端 `sendMutation.onSuccess → invalidateQueries(["channel", id, "messages"])` (page.tsx:606) 触发 session-history refetch，用缺用户消息的列表覆盖掉 SSE upsert 刚补上的 `m_` 行。窗口期内自己消息必消失；即使 ingest 后，独立 user 条目依然永不出现（回落到 H3）。
- **H2（选错 session）— REFUTED**。`sessions.find(s => instanceRef && workerId)` 本次选中了最新会话 s_0000000018（dispatch 刚 ensure 的），正是产生本次回复的会话；问题在内容结构而非选错。选择逻辑保持不动。

## 关键连接键（fix 依据）

- 平台 DB agent 终态行 content.parts[].messageID == worker 会话消息 info.id（如 m_26 ↔ msg_07a82f465…）。DB agent 行**已含** reasoning/tool parts（`db-late` 全行可证），去重可用精确 join，无需文本启发式。
- 用户/system 消息：DB 全量、worker 侧无对应 → DB 为唯一真源。
- session agent 消息：仅当其 id 未被任何 DB agent parts.messageID 引用时才是增补（流式中/未落库）；session user 项为注入提示伪影，应排除（DB user 行为准）。

## Fix 方向（已采纳）

`getSessionHistory` 改为 **DB 全量为真源 + worker 会话仅作 agent 增补**：DB 该频道全量消息（user/system/agent，最新 500，按 id 升序）∪ 未被 DB 引用的 session agent 项，按 createdAt 升序；worker 不可达时保持纯 DB 回退（source=db），worker 可达时 source=session（现为合并后）。
不碰项：SSE delta 按 channelId 的 upsert（use-realtime.ts，同 queryKey，m_ 行天然在合并列表中）、reasoning/tool 渲染（DB agent 行自带 parts + session 增补保留 parts）、session 选择逻辑、schema/seed/e2e。
