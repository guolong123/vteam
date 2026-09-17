# Learnings — reply-join prompt guidance (2026-09-17)

Agent-facing prompt text update for the notify_agent type/stage contract.
Sibling added `type` (question|help|answer) and `stage` (process|end) params
to `vteam_notify_agent`. This task ONLY updated the prompt text; no behavior.

## Edits (append-only, no restructuring)

1. `GLOBAL_BASE_LINES` (worker-dispatcher.ts): appended one line
   【@ 定向机制｜回执】 explaining the three combinations:
   - answer+process = progress report, no wake
   - answer+end = dispatch done, clear receipt, main wakes on join-all
   - question/help = immediate interrupt, not counted as done
   Key message: "进度汇报不再按条唤醒，完工必须传 stage=end。"

2. `NON_MAIN_AGENT_NOTE` (worker-dispatcher.ts): appended one sentence
   "回执节奏：..." after the existing routing rule. Keeps the routing rule
   intact (「定向通知仅可直达主Agent...」).

3. `MAIN_AGENT_INSTRUCTION` (worker-dispatcher.ts): appended one sentence
   "唤醒节奏：..." after FR-11. Tells the main it's woken on join-all or
   question/help, not per-report.

4. `seed.ts`: appended one bullet to `## 回执铁律` in 4 roles
   (product, architect, developer, tester) — the line instructs agents
   to use the right type/stage combo. 知识管理员 NOT touched (still
   forbidden from calling notify_agent). 计划员 NOT touched (read-only).

## Constraints honored
- Routing rule text preserved verbatim
- 知识管理员 "永不调用 vteam_notify_agent（防环）" untouched
- 计划员 read-only untouched
- Existing `toContain` dispatcher specs still pass (append-only = safe)
- No behavior change — prompt text only

## Verification
- tsc --noEmit: exit 0
- Full suite: 123 suites / 2858 green (unchanged from baseline)
- Adversarial QA: rendered-prompt proof for both sub-agent and main
  confirms all new strings land in assembled output
- Evidence: `.omo/evidence/reply-join/prompts/prompt-proof.md`

## Anti-patterns avoided
- No prompt paragraphs rewritten — only appended
- No new sections — only extended existing ones
- No spec weakening — no specs edited at all (all `toContain`)
- No sibling file touched (platform-mcp.service.ts, tools.ts, etc.)
2026-09-17: OnModuleInit import already present in platform-mcp.service.ts (line 10); tsc --noEmit exit 0, no edit needed.
2026-09-17: reply-join spec fixture fixed to REAL SUB->MAIN flow (selfInstanceId=tmm_sub1, mainAgentMemberId=tmm_main); ack direction corrected to MAIN->reporter; 4 regression tests added; 12/12 green, tsc exit 0. Touched: server/src/platform-mcp/platform-mcp.service.reply-join.spec.ts only.
2026-09-17: live proof RERUN ok-4/5 — transcript `.omo/evidence/reply-join/live-proof-transcript.txt` (RUN=RJ20260917LIVE2, team-dim; script direction fixed SUB->MAIN). R1 delta 0; R2 pending 2->1 delta +3 (no wake); R3 pending 1->0 BUT delta +3 (drain wake missing — busy-veto vs report's own execution dispatch, needs code change, STOPPED per brief); R4 pending 0->0 delta +6 (question wake immediate); R5 patrol fire_count 6->6. Cleanup 5->0 msgs/rcpts/nudges. Note: first run exposed STALE baked image (acked reporter->main); rebuilt via `docker compose up -d --build server` (no code edits), tsc exit 0. Counting unit: 1 dispatch = 3 agent.loading rows (NOT log lines).
2026-09-17: task-progression.scheduler.spec retired-patrol rewrite (2 tests → retirement assertions: register 不再 schedule interval 行 + unregister 仍 cancel; 终态行不删除不重建); 30/30 green, tsc exit 0. Touched: server/src/tasks/task-progression.scheduler.spec.ts only.
2026-09-17: join-suppress fix — sub→main `answer` reports no longer dispatch an
execution turn on the main (each report armed the drain busy-veto against itself).
Suppression keys off caller!=main && target==main && type==answer (any stage,
any kind — a stray kind:'execution' default is still suppressed; receipt ledger
unchanged). Returns triggered:false + reason 'join-pending' (NEW DispatchReason
token; message persisted/broadcast, ack/drain unchanged). question/help unchanged
(exec + interrupt, live P5 +6 intact); main→sub unchanged; no-main fail-open to
old dispatch + warn (routing-gate mainId hoisted to routingMainId, second
team.findUnique removed). Drain veto / atomic claim / debounce / wakeMainAgent /
ack direction untouched. Tool description + type/stage describes updated with the
suppression statement. Specs: reply-join 12→14 (updated answer assertions to
join-pending; new: kind=execution adversarial suppression, no-main fail-open;
extended: question/help exec+interrupt, main→sub dispatch kept, concurrent ends
one wake). Sibling service.spec.ts ONE assertion updated to new contract
(普通成员→主成员 answer → join-pending, no dispatch; route pass + persist kept).
Verify: tsc exit 0; reply-join 14/14; platform-mcp 10 suites/377; full 124/2872
green on rerun (first run 1 transient swagger-mcp ECONNRESET, isolated 34/34 pass).
Evidence: .omo/evidence/reply-join/drain-suppress-proof.txt. Touched:
platform-mcp.service.ts, platform-mcp.tools.ts,
platform-mcp.service.reply-join.spec.ts, platform-mcp.service.spec.ts (1 test).
2026-09-17: live proof REGENERATED under join-suppress contract — transcript `.omo/evidence/reply-join/live-proof-transcript.txt` (RUN=RJ20260917LIVE5, team-dim, EXIT=0, 28 PASS / 0 FAIL). R1 fan-out delta 0; R2 first answer/end pending 2->1 delta 0 (triggered:false join-pending, NO execution turn); R3 last answer/end pending 1->0 delta +3 (EXACTLY ONE kind:wake drain); R4 question pending 0->0 delta +6 (exec+interrupt immediate); R5 patrol fire_count 6->6; R6 dedup repeat reason=dedup same messageId zero new rows; R7 pre-mentioned `@项目经理-1` stored single-prefix no double-@. Cleanup receipt: RUN-tagged messages 7->0, receipts 7->0, nudge_triggers 7->0; sessions 9->9, team instances 7->7 (reuse, none created). Script fixes: P3 expect delta 0, P4 expect delta +3, FAIL-counter (cleanup always runs, exit 1 on FAIL), sessions/instances before/after, ADV-D/ADV-M sections, notify_retry_on_throttle (throttled attempt creates no row; one 45s retry keeps 60s dedup window valid). Gotchas hit: (1) MCP responses nest tool JSON in result.content[0].text — jq must fromjson first (two void runs before catching; inner object takes `.reason` not `.result.reason`). (2) LIVE4 P4 drain missed (delta 0, main failed): stale dispatcher busy-tracking (isSessionPending/isAgentExecuting) from prior run's still-running P5 execution survived in server memory and vetoed the drain while the question path (no veto check) still +6'd — `docker compose restart server` before the clean run fixed it; drain veto returns SILENTLY (no log line), DB deltas are the only evidence. (3) Restart resets in-memory idGen counter → id reuse: concurrent human user message took m_0000002240 (channel c_0000000007, 2s after run start) so transcript preprobe_msg=1 is ANOTHER USER's live row, NOT probe residue — left untouched; all RUN rows 0. Lesson: fixed-id pre-cleanup is racy on a live platform; RUN-tag cleanup is exact. Rebuilt baked image before run (worktree 17:38 > image 17:26) via `docker compose up -d --build server`, tsc untouched.
