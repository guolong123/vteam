#!/bin/bash
# notify-routing live proof (server baked image, already rebuilt).
# Proves: (A) member->member 403 + zero message rows; (B) main->member triggered:true;
# (C) null-main team fail-open (message IS created, no 403); (D) self-notify 403.
# Cleans up all probe rows. Run from repo root.
set -u
MCP=http://localhost:13000/api/v1/platform-mcp
WID=w_compose_worker
WTOK=compose-worker-token
EVID=.omo/evidence/notify-routing
TRANSCRIPT=$EVID/live-proof-transcript.txt
: > "$TRANSCRIPT"
exec > >(tee -a "$TRANSCRIPT") 2>&1

say() { echo "### $*"; }
db() { docker compose exec -T db mysql -uroot -paiagents-root aiagents -e "$1" 2>&1 | grep -v "password on the command"; }
mcp() { curl -s -X POST $MCP -H 'Content-Type: application/json' -H "x-worker-id: $WID" -H "X-Worker-Token: $WTOK" -d "$1"; }

MARK=nrprobe-20260917
say "0. baseline: group-channel count + marker rows (expect 0 markers)"
db "SELECT COUNT(*) AS baseline_c1 FROM messages WHERE channel_id='c_0000000001'; SELECT COUNT(*) AS markers FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%';"

say "A. member->member (tmm_0000000004 -> tmm_0000000005) expect -32003 + ROUTING_VIOLATION"
mcp '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000004","targetInstanceId":"tmm_0000000005","kind":"wake","content":"'$MARK'-A developer->tester direct"}}}'; echo
say "A2. count unchanged + zero A-marker rows"
db "SELECT COUNT(*) AS afterA_c1 FROM messages WHERE channel_id='c_0000000001'; SELECT COUNT(*) AS markerA FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-A%';"

say "B. main->member (tmm_0000000002 -> tmm_0000000005) expect triggered:true"
mcp '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000005","kind":"wake","content":"'$MARK'-B main->tester wake (probe: no reply needed)"}}}'; echo
say "B2. one B-marker row present"
db "SELECT id, sender_instance_id, CAST(content AS CHAR) AS text FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-B%' LIMIT 3;"

say "C. setup: probe member + session on null-main team tm_0000000007"
db "INSERT INTO team_members (id,team_id,agent_id,alias,seq) VALUES ('tmm_probe_nr2','tm_0000000007','a_developer','probe-2',2); INSERT INTO sessions (id,agent_id,worker_id,team_member_id,team_id,status) VALUES ('s_probe_nr1','a_architect','$WID','tmm_0000000022','tm_0000000007','idle'); SELECT id,team_id,team_member_id,status FROM sessions WHERE id='s_probe_nr1';"
say "C2. null-main team member->member (expect NO 403; dispatch-no-session error ok, message IS created)"
mcp '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"notify_agent","arguments":{"teamId":"tm_0000000007","selfInstanceId":"tmm_0000000022","targetInstanceId":"tmm_probe_nr2","kind":"wake","content":"'$MARK'-C null-main fail-open"}}}'; echo
say "C3. C-marker row exists (fail-open proof)"
db "SELECT id, sender_instance_id, CAST(content AS CHAR) AS text FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-C%' LIMIT 3;"

say "D. self-notify (tmm_0000000004 -> self) expect -32003"
mcp '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000004","targetInstanceId":"tmm_0000000004","kind":"wake","content":"'$MARK'-D self"}}}'; echo

say "E. new rows since probe start (audit for stray agent replies)"
db "SELECT id, sender_instance_id, LEFT(CAST(content AS CHAR),90) AS text FROM messages WHERE channel_id='c_0000000001' ORDER BY created_at DESC LIMIT 6;"
db "SELECT id, LEFT(CAST(content AS CHAR),90) AS text FROM messages WHERE channel_id='c_0000000015' ORDER BY created_at DESC LIMIT 4;"

say "F. CLEANUP: delete probe messages + probe member/session, prove 0 remain"
db "DELETE FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%'; DELETE FROM sessions WHERE id='s_probe_nr1'; DELETE FROM team_members WHERE id='tmm_probe_nr2'; SELECT COUNT(*) AS markers_left FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%'; SELECT COUNT(*) AS probe_rows_left FROM sessions WHERE id='s_probe_nr1'; SELECT COUNT(*) AS probe_member_left FROM team_members WHERE id='tmm_probe_nr2'; SELECT COUNT(*) AS final_c1 FROM messages WHERE channel_id='c_0000000001';"
say "DONE"
