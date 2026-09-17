#!/bin/bash
# todo-22 live contract proof (+ curl recipe for todo-16/18).
# Assumes: server baked image rebuilt (`docker compose up -d --build server`),
# reachable at localhost:13000. Cleans up its own probe rows.
set -u
BASE=http://localhost:13000/api/v1
EVID=.omo/evidence/trigger-unification/todo-22
TRANSCRIPT=$EVID/curl-transcript.txt
: > "$TRANSCRIPT"
exec > >(tee -a "$TRANSCRIPT") 2>&1

say() { echo "### $*"; }
show() { echo "$1" | python3 -m json.tool 2>/dev/null || echo "$1"; }

say "1. login admin + member"
ADMIN_JWT=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
MEMBER_JWT=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"seed-member","password":"Admin@123456"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
echo "admin_jwt_len=${#ADMIN_JWT} member_jwt_len=${#MEMBER_JWT}"

say "2. GET /triggers as admin (expect 200, non-empty, envelope)"
curl -s -w '\nHTTP:%{http_code}\n' "$BASE/triggers" -H "Authorization: Bearer $ADMIN_JWT" | head -c 1500; echo

say "3. GET ?status=fired&page=1&pageSize=5 (envelope + item shape + source=system)"
curl -s "$BASE/triggers?status=fired&page=1&pageSize=5" -H "Authorization: Bearer $ADMIN_JWT" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert set(d)=={'items','total','page','pageSize'}, d.keys()
assert d['page']==1 and d['pageSize']==5 and d['total']>=1 and len(d['items'])<=5
need={'id','kind','status','dueAt','nextFireAt','scopeType','scopeId','ownerInstanceId','fireCount','skipReason','lastError','attempts','createdAt','source'}
for it in d['items']:
    assert need<=set(it), set(it)
    assert it['kind']=='receipt_nudge' and it['source']=='system', it
print('ENVELOPE_OK total=%s items=%d all receipt_nudge/system'%(d['total'],len(d['items'])))
"

say "4. insert probe agent trigger (pending hook_poll, owner tmm_0000000001 = tm_0000000001)"
docker compose exec -T db mysql -uroot -paiagents-root aiagents -e \
"INSERT INTO triggers (id,kind,status,fire_at,due_at,owner_instance_id,payload,dedup_key,attempts,fire_count) VALUES ('tmr_probe_todo22','hook_poll','pending',NOW(),NOW(),'tmm_0000000001','{\"teamId\":\"tm_0000000001\"}','hook_poll:todo22:probe1',0,0);" 2>&1 | grep -v "password on the command" || true

say "5. member DELETE probe (other-team agent) -> expect 403 TRIGGER_FORBIDDEN"
curl -s -w '\nHTTP:%{http_code}\n' -X DELETE "$BASE/triggers/tmr_probe_todo22" -H "Authorization: Bearer $MEMBER_JWT"

say "6. member DELETE existing system row (receipt_nudge) -> expect 403 TRIGGER_SYSTEM_READONLY"
SYS_ID=$(curl -s "$BASE/triggers?status=fired&page=1&pageSize=1" -H "Authorization: Bearer $ADMIN_JWT" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["id"])')
echo "system_row=$SYS_ID"
curl -s -w '\nHTTP:%{http_code}\n' -X DELETE "$BASE/triggers/$SYS_ID" -H "Authorization: Bearer $MEMBER_JWT"

say "7. member GET without teamId -> expect 403 TRIGGER_TEAM_SCOPE_REQUIRED"
curl -s -w '\nHTTP:%{http_code}\n' "$BASE/triggers" -H "Authorization: Bearer $MEMBER_JWT"

say "8. member GET teamId=tm_0000000001 (non-member) -> expect 200 empty set"
curl -s -w '\nHTTP:%{http_code}\n' "$BASE/triggers?teamId=tm_0000000001" -H "Authorization: Bearer $MEMBER_JWT"

say "9. admin DELETE probe -> expect 200 cancelled"
curl -s -w '\nHTTP:%{http_code}\n' -X DELETE "$BASE/triggers/tmr_probe_todo22" -H "Authorization: Bearer $ADMIN_JWT" | head -c 800; echo
docker compose exec -T db mysql -uroot -paiagents-root aiagents -e \
"SELECT id,status FROM triggers WHERE id='tmr_probe_todo22';" 2>&1 | grep -v "password on the command"

say "10. admin DELETE probe again (stale_state) -> expect 200, no 500"
curl -s -w '\nHTTP:%{http_code}\n' -X DELETE "$BASE/triggers/tmr_probe_todo22" -H "Authorization: Bearer $ADMIN_JWT" | head -c 400; echo

say "11. DELETE does_not_exist -> expect 404 TRIGGER_NOT_FOUND"
curl -s -w '\nHTTP:%{http_code}\n' -X DELETE "$BASE/triggers/does_not_exist" -H "Authorization: Bearer $ADMIN_JWT"

say "12. malformed_input probes (none may 500)"
echo "-- page=abc (expect 400)"; curl -s -o /dev/null -w 'HTTP:%{http_code}\n' "$BASE/triggers?page=abc" -H "Authorization: Bearer $ADMIN_JWT"
echo "-- status=bogus (expect 400)"; curl -s -o /dev/null -w 'HTTP:%{http_code}\n' "$BASE/triggers?status=bogus" -H "Authorization: Bearer $ADMIN_JWT"
echo "-- kind=bogus (expect 400)"; curl -s -o /dev/null -w 'HTTP:%{http_code}\n' "$BASE/triggers?kind=bogus" -H "Authorization: Bearer $ADMIN_JWT"
echo "-- pageSize=9999 (expect 200 clamped pageSize=100)"
curl -s "$BASE/triggers?pageSize=9999" -H "Authorization: Bearer $ADMIN_JWT" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("pageSize=%s"%d["pageSize"]);assert d["pageSize"]==100'
echo "-- scopeId SQL-ish (expect 200 empty, no 500)"
curl -s "$BASE/triggers?scopeId=%27%20OR%20%271%27%3D%271" -H "Authorization: Bearer $ADMIN_JWT" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("total=%s"%d["total"]);assert d["total"]==0'
echo "-- status=fired&kind=hook_poll combo (expect 200)"
curl -s -o /dev/null -w 'HTTP:%{http_code}\n' "$BASE/triggers?status=fired&kind=hook_poll" -H "Authorization: Bearer $ADMIN_JWT"
echo "-- unauthenticated (expect 401)"
curl -s -o /dev/null -w 'HTTP:%{http_code}\n' "$BASE/triggers"

say "13. CLEANUP: delete probe row + prove 0 remain"
docker compose exec -T db mysql -uroot -paiagents-root aiagents -e \
"DELETE FROM triggers WHERE id='tmr_probe_todo22'; SELECT COUNT(*) AS probe_left FROM triggers WHERE id='tmr_probe_todo22';" 2>&1 | grep -v "password on the command"

say "DONE"
