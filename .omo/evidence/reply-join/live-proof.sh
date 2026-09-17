#!/bin/bash
# reply-join live proof (.omo/evidence/reply-join/live-proof.sh)
# Fan-out JOIN: sub-agent `answer` reports NEVER open an execution turn on main.
# Flow: main -> 2 sub-agents (answer/process), then subs report stage=end one-by-one.
# Assert: main NOT woken by any report (delta 0); woken EXACTLY ONCE by drain
# (kind:'wake', delta +3) when the LAST report converges the join.
# Also prove question wakes immediately (+6), progression_patrol does NOT fire,
# dedup collapses a 60s repeat, and a pre-mentioned target is not double-@'d.
#
# Direction contract (platform-mcp.service.ts ackAndDrain/handleNotifyMatrix):
#   pending receipts are MAIN->SUB (fromInstanceId=<main>); a sub-agent report
#   MUST be self=<sub> target=<main> so the matrix can ack MAIN->reporter.
#   MAIN->SUB with stage=end skips the matrix entirely (self==main) — no ack, no drain.
#
# New dispatch contract (drain-suppress fix):
#   sub->main `answer` (ANY stage, ANY kind) = persist + broadcast + ledger/ack
#   bookkeeping ONLY. NO dispatchAgentMention execution turn on main.
#   Response: triggered:false reason:'join-pending'.
#   question/help = execution dispatch + immediate interrupt wake (triggered:true).
#   drain = single kind:'wake' dispatch, busy main = vetoed/skipped (explicit).
#
# Dimension note: task-dimension notify is plan-gated (plan must be executing);
# the seed team tasks are draft/queued, so this proof uses team-dimension
# (teamId only), which exercises the IDENTICAL reply-join matrix code path
# (notifyTeamId/mainMemberId/ackAndDrain all team-derived).
#
# "main woken" counting (NOT log lines): every dispatchAgentMention to a member
# writes exactly 3 agent.loading rows to realtime_events (team/thinking +
# team/operating + global/thinking, payload.instanceId=<target>, same sessionId)
# BEFORE worker execute. Deltas per step are the dispatch evidence:
#   P1+P2 fan-out -> subs: main delta 0 (main untouched)
#   P3 first answer/end report: main delta 0 (NO execution turn; ack only)
#   P4 last answer/end report: main delta +3 (EXACTLY ONE kind:wake drain)
#   P5 question: main delta +6 (question execution + immediate kind:wake)
# Row-level receipt snapshots (id/to/status) prove exactly which rows each step acked.

set -uo pipefail
HOST=http://localhost:13000/api/v1
WORKER=w_compose_worker
TOKEN=compose-worker-token
TEAM=tm_0000000001
MAIN=tmm_0000000002
SUB1=tmm_0000000003
SUB2=tmm_0000000004
RUN="${RUN:-RJ$(date +%Y%m%d%H%M%S)}"
RUN_START=$(date -u +"%Y-%m-%d %H:%M:%S")
FAILS=0

echo "RUN=$RUN (run_start_utc=$RUN_START)"
echo "TEAM=$TEAM MAIN=$MAIN SUB1=$SUB1 SUB2=$SUB2"

DB() {
  docker compose exec -T db mysql --default-character-set=utf8mb4 -uroot -paiagents-root -N aiagents -e "$1" 2>/dev/null | tr -d '[:space:]'
}
DB_ROWS() {
  docker compose exec -T db mysql --default-character-set=utf8mb4 -uroot -paiagents-root aiagents -e "$1" 2>/dev/null
}
DB_TEXT() {
  docker compose exec -T db mysql --default-character-set=utf8mb4 -uroot -paiagents-root -N aiagents -e "$1" 2>/dev/null
}

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$label (got=$got)"; else fail "$label (got=$got want=$want)"; fi
}
assert_contains() {
  local label="$1" hay="$2" needle="$3"
  case "$hay" in *"$needle"*) pass "$label (contains '$needle')";; *) fail "$label (missing '$needle' in: $(echo "$hay" | head -c 300))";; esac
}
jget() { echo "$1" | jq -r '(.result.content[0].text | fromjson | '"$2"')' 2>/dev/null; }

pending_main() { DB "SELECT COUNT(*) FROM message_receipts WHERE from_instance_id='$MAIN' AND team_id='$TEAM' AND status='pending'"; }
loadings_of() { DB "SELECT COUNT(*) FROM realtime_events WHERE type='agent.loading' AND payload->>'\$.instanceId'='$1'"; }
session_status() { DB "SELECT status FROM sessions WHERE team_member_id='$1'"; }
patrol_fires() { DB "SELECT fire_count FROM triggers WHERE id='tmr_0000000140'"; }
sess_count() { DB "SELECT COUNT(*) FROM sessions"; }
inst_count() { DB "SELECT COUNT(*) FROM team_members WHERE team_id='$TEAM'"; }
msg_count_tag() { DB "SELECT COUNT(*) FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) LIKE '%$1%'"; }

notify() {
  local self="$1" target="$2" content="$3" type="${4:-answer}" stage="${5:-process}"
  local dim="$6"
  if [ "$dim" = "team" ]; then
    dimjson="\"teamId\":\"$TEAM\""
  else
    dimjson="\"taskId\":\"$TASK\""
  fi
  curl -s -X POST "$HOST/platform-mcp" \
    -H "Content-Type: application/json" \
    -H "x-worker-id: $WORKER" \
    -H "X-Worker-Token: $TOKEN" \
    -d "$(jq -n --arg sid "$self" --arg tid "$target" --arg c "$content" --arg type "$type" --arg stage "$stage" --argjson dim "{$dimjson}" \
      '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"notify_agent",arguments:({selfInstanceId:$sid,targetInstanceId:$tid,content:$c,type:$type,stage:$stage} + $dim)}}')"
}

wait_idle() {
  local inst="$1" timeout="${2:-300}" waited=0 st
  while [ "$waited" -lt "$timeout" ]; do
    st=$(session_status "$inst")
    echo "  [wait_idle $inst] status=$st waited=${waited}s"
    if [ "$st" != "running" ]; then return 0; fi
    sleep 10
    waited=$((waited + 10))
  done
  echo "  [wait_idle $inst] TIMEOUT after ${timeout}s (status=$st)"
  return 1
}

# Adversarial-call wrapper: a throttled attempt creates NO row and consumes no
# dedup window; retry once after 45s so a throttle hit is recorded explicitly
# instead of failing the dedup/mention assertion. Final reason still asserted.
notify_retry_on_throttle() {
  local r
  r=$(notify "$1" "$2" "$3" "$4" "$5" "$6")
  if [ "$(jget "$r" '.reason')" = "throttled" ]; then
    echo "  [throttled on $1->$2 — no row created; waiting 45s and retrying once]" >&2
    sleep 45
    r=$(notify "$1" "$2" "$3" "$4" "$5" "$6")
  fi
  echo "$r"
}

# 0) pre-cleanup: remove my own earlier connectivity probe rows (recorded, then deleted)
echo "--- PRE-CLEANUP (earlier connectivity probe) ---"
DB_ROWS "SELECT id FROM messages WHERE id='m_0000002240';"
DB_ROWS "SELECT id,status FROM message_receipts WHERE id='mr_0000000035';"
DB "DELETE FROM triggers WHERE kind='receipt_nudge' AND payload->>'\$.messageId'='m_0000002240'"
DB "DELETE FROM message_receipts WHERE id='mr_0000000035'"
DB "DELETE FROM messages WHERE id='m_0000002240'"
echo "after pre-cleanup: m_0000002240=$(DB "SELECT COUNT(*) FROM messages WHERE id='m_0000002240'") mr_0000000035=$(DB "SELECT COUNT(*) FROM message_receipts WHERE id='mr_0000000035'")"

# baseline snapshots
echo "--- BASELINE ---"
B_PEND=$(pending_main)
B_LM=$(loadings_of "$MAIN"); B_LS1=$(loadings_of "$SUB1"); B_LS2=$(loadings_of "$SUB2")
B_PATROL=$(patrol_fires)
B_SESS=$(sess_count); B_INST=$(inst_count)
echo "pending(main->subs)=$B_PEND main_loadings=$B_LM sub1_loadings=$B_LS1 sub2_loadings=$B_LS2 patrol_fires=$B_PATROL sessions=$B_SESS instances(team)=$B_INST"
echo "sessions: main=$(session_status "$MAIN") sub1=$(session_status "$SUB1") sub2=$(session_status "$SUB2")"
assert_eq "B0 baseline pending clean (drain needs pending==0 to converge)" "$B_PEND" "0"
if [ "$B_PEND" != "0" ]; then
  echo "STOP: baseline dirty — refusing to run probes on a non-converged join state."
  DB_ROWS "SELECT id, to_instance_id, status FROM message_receipts WHERE team_id='$TEAM' AND from_instance_id='$MAIN' AND status='pending' ORDER BY id"
  exit 1
fi

echo "--- wait all three sessions non-running before P1 ---"
wait_idle "$MAIN" 300 || { fail "baseline main not idle (drain determinism broken)"; exit 1; }
wait_idle "$SUB1" 300 || true
wait_idle "$SUB2" 300 || true

echo "--- P1: main -> SUB1 (answer/process, team-dim) ---"
L0=$(loadings_of "$MAIN")
resp1=$(notify "$MAIN" "$SUB1" "$RUN-P1 派发：请评审架构方案V1。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】" "answer" "process" "team")
echo "$resp1" | head -c 300; echo
assert_eq "P1 main->sub dispatches (triggered)" "$(jget "$resp1" '.triggered')" "true"
assert_eq "P1 reason ok" "$(jget "$resp1" '.reason')" "ok"
echo "P1 receipts pending(main)=$(pending_main) (expect 1)"

echo "--- P2: main -> SUB2 (answer/process, team-dim) ---"
resp2=$(notify "$MAIN" "$SUB2" "$RUN-P2 派发：请实现模块M1。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】" "answer" "process" "team")
echo "$resp2" | head -c 300; echo
assert_eq "P2 main->sub dispatches (triggered)" "$(jget "$resp2" '.triggered')" "true"
assert_eq "P2 reason ok" "$(jget "$resp2" '.reason')" "ok"
echo "P2 receipts pending(main)=$(pending_main) (expect 2)"
L_AFTER_P2=$(loadings_of "$MAIN")
assert_eq "P1+P2 main_loadings delta (fan-out targets subs, main NOT woken)" "$((L_AFTER_P2 - L0))" "0"

# P3 must observe main idle: P1/P2 target subs only, main untouched, no wait needed.
echo "--- P3: SUB1 -> main report answer/end (first; 1 still outstanding; must NOT wake, NO execution turn) ---"
L3_PRE_M=$(loadings_of "$MAIN"); P3_PRE=$(pending_main)
resp3=$(notify "$SUB1" "$MAIN" "$RUN-P3 子汇报完工：架构评审通过，stage=end。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】" "answer" "end" "team")
echo "$resp3" | head -c 300; echo
assert_eq "P3 report suppressed (triggered=false, NO execution dispatch)" "$(jget "$resp3" '.triggered')" "false"
assert_eq "P3 report reason join-pending" "$(jget "$resp3" '.reason')" "join-pending"
assert_contains "P3 report persisted (messageId non-null = persist+broadcast kept)" "$(jget "$resp3" '.messageId')" "m_"
sleep 3
P3_POST=$(pending_main); L3_POST_M=$(loadings_of "$MAIN")
assert_eq "P3 pending (SUB1 receipt acked, SUB2 outstanding)" "$P3_PRE->$P3_POST" "2->1"
assert_eq "P3 main_loadings delta (NO execution turn, ledger/ack only)" "$((L3_POST_M - L3_PRE_M))" "0"
DB_ROWS "SELECT id, to_instance_id, status FROM message_receipts WHERE team_id='$TEAM' AND from_instance_id='$MAIN' ORDER BY id"

echo "--- wait main idle before P4 (busy-veto determinism: drain needs idle main) ---"
wait_idle "$MAIN" 300 || echo "WARN: main still running; P4 drain may be vetoed (will be recorded honestly)"

echo "--- P4: SUB2 -> main report answer/end (last; must wake main EXACTLY ONCE via drain kind:wake) ---"
L4_PRE_M=$(loadings_of "$MAIN"); P4_PRE=$(pending_main)
resp4=$(notify "$SUB2" "$MAIN" "$RUN-P4 子汇报完工：模块M1已完成，stage=end。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】" "answer" "end" "team")
echo "$resp4" | head -c 300; echo
assert_eq "P4 report suppressed (triggered=false, NO execution dispatch)" "$(jget "$resp4" '.triggered')" "false"
assert_eq "P4 report reason join-pending" "$(jget "$resp4" '.reason')" "join-pending"
sleep 5
P4_POST=$(pending_main); L4_POST_M=$(loadings_of "$MAIN"); P4_DELTA=$((L4_POST_M - L4_PRE_M))
P4_MSTAT=$(session_status "$MAIN")
echo "P4 main session status after drain window: $P4_MSTAT"
assert_eq "P4 pending (join-all converged)" "$P4_PRE->$P4_POST" "1->0"
if [ "$P4_DELTA" = "3" ]; then
  pass "P4 main_loadings delta +3 = EXACTLY ONE kind:wake drain (got=$P4_DELTA)"
else
  if [ "$P4_MSTAT" = "running" ]; then
    fail "P4 main_loadings delta=$P4_DELTA (want +3) — drain VETOED: main busy (status=running), wake skipped by busy-veto, NOT a pass"
  else
    fail "P4 main_loadings delta=$P4_DELTA (want +3 = exactly one drain wake; main status=$P4_MSTAT — non-running yet no wake: skipped outside the documented busy-veto, recorded explicitly)"
  fi
fi
DB_ROWS "SELECT id, to_instance_id, status FROM message_receipts WHERE team_id='$TEAM' AND from_instance_id='$MAIN' ORDER BY id"

echo "--- wait main idle before P5 ---"
wait_idle "$MAIN" 300 || echo "WARN: main still running before P5 (recorded)"

echo "--- P5: SUB2 -> main question (must wake main IMMEDIATELY, not counted as done) ---"
L5_PRE_M=$(loadings_of "$MAIN"); P5_PRE=$(pending_main)
resp5=$(notify "$SUB2" "$MAIN" "$RUN-P5 提问：该接口是否需要鉴权？【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】" "question" "process" "team")
echo "$resp5" | head -c 300; echo
assert_eq "P5 question dispatches (triggered)" "$(jget "$resp5" '.triggered')" "true"
sleep 3
P5_POST=$(pending_main); L5_POST_M=$(loadings_of "$MAIN")
assert_eq "P5 pending (question never acked/counted)" "$P5_PRE->$P5_POST" "0->0"
assert_eq "P5 main_loadings delta (question execution + immediate kind:wake)" "$((L5_POST_M - L5_PRE_M))" "6"

echo "--- PATROL CHECK ---"
PATROL_AFTER=$(patrol_fires)
assert_eq "patrol fire_count unchanged (trigger is cancelled)" "$B_PATROL->$PATROL_AFTER" "$B_PATROL->$B_PATROL"
echo "patrol-kind triggers created this run: $(DB "SELECT COUNT(*) FROM triggers WHERE kind='progression_patrol' AND created_at > NOW() - INTERVAL 1 HOUR")"

echo "--- ADV-D: dedup — identical answer/process report inside 60s collapses to same row ---"
sleep 15
ADV_D_CONTENT="$RUN-ADV-D 幂等探针：子进度同步v1。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】"
D_PRE_PEND=$(pending_main); D_PRE_MSG=$(msg_count_tag "$RUN-ADV-D")
resp_d1=$(notify_retry_on_throttle "$SUB1" "$MAIN" "$ADV_D_CONTENT" "answer" "process" "team")
echo "$resp_d1" | head -c 300; echo
D1_REASON=$(jget "$resp_d1" '.reason'); D1_MID=$(jget "$resp_d1" '.messageId')
assert_eq "ADV-D first send join-pending (answer/process, no dispatch)" "$D1_REASON" "join-pending"
sleep 5
D_MID_MSG=$(msg_count_tag "$RUN-ADV-D")
assert_eq "ADV-D first send created exactly one row" "$D_PRE_MSG->$D_MID_MSG" "$D_PRE_MSG->$((D_PRE_MSG + 1))"
resp_d2=$(notify_retry_on_throttle "$SUB1" "$MAIN" "$ADV_D_CONTENT" "answer" "process" "team")
echo "$resp_d2" | head -c 300; echo
D2_REASON=$(jget "$resp_d2" '.reason'); D2_MID=$(jget "$resp_d2" '.messageId')
assert_eq "ADV-D repeat collapses (reason=dedup)" "$D2_REASON" "dedup"
assert_eq "ADV-D repeat reuses same messageId" "$D2_MID" "$D1_MID"
D_POST_MSG=$(msg_count_tag "$RUN-ADV-D"); D_POST_PEND=$(pending_main)
assert_eq "ADV-D repeat created zero new rows" "$D_MID_MSG->$D_POST_MSG" "$D_MID_MSG->$D_MID_MSG"
assert_eq "ADV-D pending untouched (process never acks)" "$D_PRE_PEND->$D_POST_PEND" "$D_PRE_PEND->$D_PRE_PEND"

echo "--- ADV-M: mention — content already opening with target mention must not double-@ ---"
MALIAS=$(DB "SELECT alias FROM team_members WHERE id='$MAIN'")
if [ -z "$MALIAS" ] || [ "$MALIAS" = "NULL" ]; then
  MAGENT=$(DB "SELECT agent_id FROM team_members WHERE id='$MAIN'")
  MALIAS=$(DB "SELECT name FROM agents WHERE id='$MAGENT'")
fi
echo "main display name for mention check: $MALIAS"
ADV_M_CONTENT="@$MALIAS $RUN-ADV-M mention探针：正文已带目标mention。【探针指令：这是路由测试探针，收到后直接结束本轮，不要回复、不要调用任何MCP工具。】"
sleep 10
resp_m=$(notify_retry_on_throttle "$SUB1" "$MAIN" "$ADV_M_CONTENT" "answer" "process" "team")
echo "$resp_m" | head -c 300; echo
M_MID=$(jget "$resp_m" '.messageId')
if [ "$M_MID" = "null" ] || [ -z "$M_MID" ] || [ "$M_MID" = "None" ]; then
  fail "ADV-M message not persisted (messageId=$M_MID)"
else
  STORED=$(DB_TEXT "SELECT JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) FROM messages WHERE id='$M_MID'")
  echo "ADV-M stored text head: $(echo "$STORED" | head -c 120)"
  case "$STORED" in
    "@$MALIAS @$MALIAS "*) fail "ADV-M stored text double-@ prefixed ('@$MALIAS @$MALIAS ...')" ;;
    "@$MALIAS "*) pass "ADV-M stored text keeps single leading mention (no double-@)" ;;
    *) fail "ADV-M stored text lost the leading mention (head: $(echo "$STORED" | head -c 80))" ;;
  esac
fi

echo "--- RESULT LINES (DB + dispatch evidence) ---"
echo "R1 fan-out: P1+P2 main_loadings delta=$((L_AFTER_P2 - L0)) (expect 0)"
echo "R2 first report: pending $P3_PRE->$P3_POST, main_loadings delta=$((L3_POST_M - L3_PRE_M)) (expect 2->1, 0 = NO execution turn)"
echo "R3 last report: pending $P4_PRE->$P4_POST, main_loadings delta=$P4_DELTA (expect 1->0, +3 = EXACTLY ONE drain wake; main status=$P4_MSTAT)"
echo "R4 question: pending $P5_PRE->$P5_POST, main_loadings delta=$((L5_POST_M - L5_PRE_M)) (expect 0->0, +6 = immediate wake)"
echo "R5 patrol: fire_count $B_PATROL->$PATROL_AFTER (expect unchanged)"
echo "R6 dedup: repeat reason=$D2_REASON same_row=$([ "$D2_MID" = "$D1_MID" ] && echo yes || echo no) (expect dedup/yes)"
echo "R7 mention: single leading @$MALIAS, no double-@ (see ADV-M above)"

# ---- mandatory cleanup: every probe message/receipt/nudge-trigger created by this run ----
echo "--- CLEANUP (RUN=$RUN) ---"
BEFORE_MSG=$(DB "SELECT COUNT(*) FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) LIKE '%$RUN%'")
BEFORE_RCPT=$(DB "SELECT COUNT(*) FROM message_receipts WHERE summary LIKE '%$RUN%'")
BEFORE_TRG=$(DB "SELECT COUNT(*) FROM triggers t WHERE t.kind='receipt_nudge' AND EXISTS (SELECT 1 FROM messages m WHERE m.id = JSON_UNQUOTE(JSON_EXTRACT(t.payload,'\$.messageId')) AND JSON_UNQUOTE(JSON_EXTRACT(m.content,'\$.text')) LIKE '%$RUN%')")
BEFORE_SESS=$(sess_count); BEFORE_INST=$(inst_count)
echo "before: probe_messages=$BEFORE_MSG probe_receipts=$BEFORE_RCPT probe_nudge_triggers=$BEFORE_TRG sessions=$BEFORE_SESS(baseline $B_SESS) instances=$BEFORE_INST(baseline $B_INST)"
PROBE_MSG_IDS=$(DB "SELECT GROUP_CONCAT(id) FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) LIKE '%$RUN%'")
echo "probe message ids: $PROBE_MSG_IDS"
DB "DELETE t FROM triggers t INNER JOIN messages m ON m.id = JSON_UNQUOTE(JSON_EXTRACT(t.payload,'\$.messageId')) WHERE t.kind='receipt_nudge' AND JSON_UNQUOTE(JSON_EXTRACT(m.content,'\$.text')) LIKE '%$RUN%'"
DB "DELETE FROM message_receipts WHERE summary LIKE '%$RUN%'"
DB "DELETE FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) LIKE '%$RUN%'"
AFTER_MSG=$(DB "SELECT COUNT(*) FROM messages WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'\$.text')) LIKE '%$RUN%'")
AFTER_RCPT=$(DB "SELECT COUNT(*) FROM message_receipts WHERE summary LIKE '%$RUN%'")
AFTER_TRG=$(DB "SELECT COUNT(*) FROM triggers WHERE kind='receipt_nudge' AND FIND_IN_SET(JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.messageId')), '$PROBE_MSG_IDS')")
AFTER_PRE=$(DB "SELECT COUNT(*) FROM messages WHERE id='m_0000002240'")
AFTER_SESS=$(sess_count); AFTER_INST=$(inst_count)
echo "CLEANUP RECEIPT: messages $BEFORE_MSG->$AFTER_MSG, receipts $BEFORE_RCPT->$AFTER_RCPT, nudge_triggers $BEFORE_TRG->$AFTER_TRG, preprobe_msg=$AFTER_PRE (all expect 0)"
echo "sessions: baseline $B_SESS -> after-run $AFTER_SESS; instances(team): baseline $B_INST -> after-run $AFTER_INST (dispatches reuse s_*/tmm_* sessions/instances; expect unchanged)"
if [ "$AFTER_SESS" != "$B_SESS" ]; then
  echo "new sessions in run window (created_at >= $RUN_START UTC):"
  DB_ROWS "SELECT id, team_member_id, status, created_at FROM sessions WHERE created_at >= '$RUN_START' ORDER BY created_at"
  fail "sessions created during run ($B_SESS->$AFTER_SESS) — left in place (FK-safe), recorded honestly"
fi
if [ "$AFTER_INST" != "$B_INST" ]; then
  fail "team instances created during run ($B_INST->$AFTER_INST) — left in place (FK-safe), recorded honestly"
fi
assert_eq "cleanup messages all deleted" "$AFTER_MSG" "0"
assert_eq "cleanup receipts all deleted" "$AFTER_RCPT" "0"
echo "NOTE: realtime_events rows (agent.loading etc.) are the append-only event bus log and are intentionally preserved."

echo "DONE RUN=$RUN FAILS=$FAILS"
exit $([ "$FAILS" -gt 0 ] && echo 1 || echo 0)
