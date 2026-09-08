#!/bin/bash
# F3 re-verify after resetMemberSession teamId fix. Scratch DB only.
[[ "$DATABASE_URL" == *":13306/"* ]] || { echo "GUARD FAIL"; exit 1; }
echo "GUARD PASS (scratch :13306/)"
BASE=http://localhost:13100/api/v1
WTOKEN=$(grep '^WORKER_TOKEN=' /Users/mac/01work/git-project/vteam/server/.env | cut -d= -f2- | sed 's/^"//;s/"$//')
[ -n "$WTOKEN" ] || { echo "no WORKER_TOKEN"; exit 1; }
TS=$(date +%s)
j() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
body() { head -1; }
echo "=== re-verify $(date -u +%FT%TZ) ==="
TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | j "['accessToken']")
echo "login OK token_len=${#TOKEN}"
A() { curl -s -w '\nHTTP:%{http_code}\n' "$@" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'; }

TEAM_JSON=$(A $BASE/teams -X POST -d "{\"name\":\"su-f3r-team-$TS\",\"members\":[{\"agentId\":\"a_product\"},{\"agentId\":\"a_developer\"}]}")
echo "$TEAM_JSON"
TEAM=$(echo "$TEAM_JSON" | body | j "['id']")
M_DEV=$(echo "$TEAM_JSON" | body | python3 -c "import sys,json;d=json.load(sys.stdin);print([m['id'] for m in d['members'] if m['agentId']=='a_developer'][0])")
echo "TEAM=$TEAM M_DEV=$M_DEV"
DM=$(A $BASE/dm-channels -X POST -d "{\"teamId\":\"$TEAM\",\"teamMemberId\":\"$M_DEV\"}" | body | j "['id']")
echo "DM=$DM"
DMMSG=$(A $BASE/channels/$DM/messages -X POST -d '{"text":"复验证面私聊"}')
echo "$DMMSG"
SES1=$(echo "$DMMSG" | body | python3 -c "import sys,json;d=json.load(sys.stdin);t=d.get('triggers') or [];print(t[0].get('sessionId') if t else '')")
echo "SES1=$SES1"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/workers/register -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d '{"workerId":"w_su_f3r","opencodeVersion":"0.0.0-f3r","capabilities":{"maxInstances":5,"skills":[],"tools":[]},"load":{"instances":0}}'

echo "--- RESET ---"
RESET_JSON=$(A $BASE/teams/$TEAM/members/$M_DEV/reset-session -X POST -d '{}')
echo "$RESET_JSON"
SES2=$(echo "$RESET_JSON" | body | j "['session']['id']")
echo "SES1=$SES1 SES2=$SES2"
echo "--- reset row team dimension (expect team_id set, key derived) ---"
docker exec su-f3r-db mysql -uroot -psu-f3r-pw -e "SELECT id,team_id,team_member_id,team_member_key,task_id,status FROM su_e2e.sessions;" 2>/dev/null

echo "--- CONFIRM-2: simulate pickup on reset row + memory_save team (expect 200 result) ---"
docker exec su-f3r-db mysql -uroot -psu-f3r-pw -e "UPDATE su_e2e.sessions SET worker_id='w_su_f3r', status='running' WHERE id='$SES2';" 2>/dev/null
curl -s -w '\nHTTP:%{http_code}\n' $BASE/platform-mcp -X POST -H "X-Worker-Token: $WTOKEN" -H "x-worker-id: w_su_f3r" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":41,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_save\",\"arguments\":{\"teamId\":\"$TEAM\",\"selfInstanceId\":\"$M_DEV\",\"level\":\"team\",\"content\":\"SU-F3R 团队记忆：reset 后写入\",\"description\":\"f3r probe\"}}}"
echo "--- memory read team (expect total=1) ---"
A "$BASE/memories?level=team&teamId=$TEAM"

echo "--- CONFIRM-4: re-dispatch DM (expect reuse SES2, single row, no orphan) ---"
DMMSG2=$(A $BASE/channels/$DM/messages -X POST -d '{"text":"reset 后再次私聊"}')
echo "$DMMSG2"
SES3=$(echo "$DMMSG2" | body | python3 -c "import sys,json;d=json.load(sys.stdin);t=d.get('triggers') or [];print(t[0].get('sessionId') if t else '')")
echo "SES2=$SES2 SES3=$SES3"
if [ "$SES2" = "$SES3" ]; then echo "REUSE_OK: same session row reused"; else echo "REUSE_FAIL: different row"; fi
docker exec su-f3r-db mysql -uroot -psu-f3r-pw -e "SELECT id,team_id,team_member_id,team_member_key,task_id,status,worker_id FROM su_e2e.sessions;" 2>/dev/null
N=$(docker exec su-f3r-db mysql -uroot -psu-f3r-pw -N -e "SELECT COUNT(*) FROM su_e2e.sessions WHERE team_member_id='$M_DEV';" 2>/dev/null)
echo "ROWS_FOR_MEMBER=$N (expect 1)"
echo "=== RE-VERIFY DONE ==="
