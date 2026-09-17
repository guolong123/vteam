#!/bin/bash
# notify-dedup live proof (server baked image rebuilt with fix).
# (a) rejected notify (review-triplet) leaves group count unchanged;
# (b) identical resend within window -> same messageId, +0 rows;
#     after window expiry -> new row (window boundary);
# (c) content already starting with @target is not double-@'d;
# (d) terminal (completed) task flow does not break (clean reject, no rows).
# Cleans up all probe rows. Run from repo root.
set -u
MCP=http://localhost:13000/api/v1/platform-mcp
WID=w_compose_worker
WTOK=compose-worker-token
EVID=.omo/evidence/notify-dedup
TRANSCRIPT=$EVID/live-proof-transcript.txt
mkdir -p "$EVID"
: > "$TRANSCRIPT"
exec > >(tee -a "$TRANSCRIPT") 2>&1

say() { echo "### $*"; }
db() { docker compose exec -T db mysql --default-character-set=utf8mb4 -uroot -paiagents-root aiagents -e "$1" 2>&1 | grep -v "password on the command"; }
mcp() { curl -s -X POST $MCP -H 'Content-Type: application/json' -H "x-worker-id: $WID" -H "X-Worker-Token: $WTOK" -d "$1"; }

MARK=ddprobe-20260917
# P1 main(02)->dev(04) task t_0000000001 | P2 main(02)->librarian(07, no session) | P3 main(08)->tester(10) completed t_0000000002

say "0. baseline (expect c_0000000001=62, c_0000000007=<n>, markers=0)"
db "SELECT COUNT(*) AS base_c1 FROM messages WHERE channel_id='c_0000000001'; SELECT COUNT(*) AS base_c7 FROM messages WHERE channel_id='c_0000000007'; SELECT COUNT(*) AS markers FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%';"

say "A. review-triplet reject P1 (expect triggered:false reason=review-triplet messageId=null, hint)"
mcp '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000004","kind":"review","content":"'$MARK'-A 请评审新版计划"}}}'; echo
say "A2. counts unchanged + zero A-marker rows"
db "SELECT COUNT(*) AS afterA_c1 FROM messages WHERE channel_id='c_0000000001'; SELECT COUNT(*) AS markerA FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-A%';"

say "B1. wake P2 first send (expect dispatch-no-session ERROR, but 1 row persisted)"
mcp '{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000007","kind":"wake","content":"'$MARK'-B 请确认收到"}}}'; echo
say "B1b. marker-B rows (expect 1)"
db "SELECT id, sender_instance_id, CAST(content AS CHAR) AS text FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-B%';"

say "B2. identical resend within window (expect triggered:false reason=dedup, SAME messageId)"
mcp '{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000007","kind":"wake","content":"'$MARK'-B 请确认收到"}}}'; echo
say "B2b. marker-B rows still 1 (no new row)"
db "SELECT COUNT(*) AS markerB_rows FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-B%'; SELECT COUNT(*) AS afterB_c1 FROM messages WHERE channel_id='c_0000000001';"

say "C. content already @-prefixed (expect single @ stored, then dispatch-no-session error)"
mcp '{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000007","kind":"wake","content":"@知识管理员-1 '$MARK'-C 请确认收到"}}}'; echo
say "C2. stored text has exactly one leading @ (expect 1 row, text == content)"
db "SELECT CAST(content AS CHAR) AS text, CAST(mentions AS CHAR) AS mentions FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-C%'; SELECT COUNT(*) AS markerBC_rows FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-B%' OR CAST(content AS CHAR) LIKE '%$MARK-C%';"

say "W. waiting 70s for dedup window expiry..."
sleep 70

say "B3. resend B after window (expect NEW row: triggered path, dispatch-no-session error again)"
mcp '{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000001","selfInstanceId":"tmm_0000000002","targetInstanceId":"tmm_0000000007","kind":"wake","content":"'$MARK'-B 请确认收到"}}}'; echo
say "B3b. marker-B rows now 2 (window expired, not collapsed)"
db "SELECT id, CAST(content AS CHAR) AS text FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-B%';"

say "D. terminal task t_0000000002 (completed) review-no-triplet (expect clean review-triplet reject, no rows)"
db "SELECT COUNT(*) AS preD_c7 FROM messages WHERE channel_id='c_0000000007';"
mcp '{"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"notify_agent","arguments":{"taskId":"t_0000000002","selfInstanceId":"tmm_0000000008","targetInstanceId":"tmm_0000000010","kind":"review","content":"'$MARK'-D 请评审新版计划"}}}'; echo
say "D2. c_0000000007 unchanged + zero D-marker rows"
db "SELECT COUNT(*) AS afterD_c7 FROM messages WHERE channel_id='c_0000000007'; SELECT COUNT(*) AS markerD FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK-D%';"

say "E. audit: all marker rows + receipts (expect 0, wake never records) + realtime events with marker payload"
db "SELECT id, channel_id, sender_instance_id, LEFT(CAST(content AS CHAR),80) AS text FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%' ORDER BY created_at;"
db "SELECT COUNT(*) AS probe_receipts FROM message_receipts WHERE message_id IN (SELECT id FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%');"
db "SELECT COUNT(*) AS marker_events FROM realtime_events WHERE CAST(payload AS CHAR) LIKE '%$MARK%';"

say "F. CLEANUP: delete probe messages (+ their realtime events), prove 0 remain + c_0000000001 back to baseline"
db "DELETE FROM realtime_events WHERE CAST(payload AS CHAR) LIKE '%$MARK%'; DELETE FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%'; SELECT COUNT(*) AS markers_left FROM messages WHERE CAST(content AS CHAR) LIKE '%$MARK%'; SELECT COUNT(*) AS marker_events_left FROM realtime_events WHERE CAST(payload AS CHAR) LIKE '%$MARK%'; SELECT COUNT(*) AS final_c1 FROM messages WHERE channel_id='c_0000000001'; SELECT COUNT(*) AS final_c7 FROM messages WHERE channel_id='c_0000000007';"
say "DONE"
