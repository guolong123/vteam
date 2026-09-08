#!/bin/bash
# F3 isolated-stack walkthrough. Scratch DB only.
# Guard: DATABASE_URL must contain :13306/ or abort.
[[ "$DATABASE_URL" == *":13306/"* ]] || { echo "GUARD FAIL: DATABASE_URL lacks :13306/ — abort"; exit 1; }
echo "GUARD PASS (scratch :13306/)"
BASE=http://localhost:13100/api/v1
WTOKEN=$(grep '^WORKER_TOKEN=' /Users/mac/01work/git-project/vteam/server/.env | cut -d= -f2)
[ -n "$WTOKEN" ] || { echo "no WORKER_TOKEN in server/.env"; exit 1; }
TS=$(date +%s)
j() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
body() { head -1; }

echo "=== walkthrough $(date -u +%FT%TZ) BASE=$BASE ==="
TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | j "['accessToken']")
echo "login OK token_len=${#TOKEN}"
A() { curl -s -w '\nHTTP:%{http_code}\n' "$@" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'; }

echo "--- STEP1 create-team (first try; T15 regression: expect 201, no 500) ---"
TEAM_JSON=$(A $BASE/teams -X POST -d "{\"name\":\"su-f3-team-$TS\",\"description\":\"F3 isolated walkthrough\",\"members\":[{\"agentId\":\"a_product\",\"alias\":\"产品经理-1\"},{\"agentId\":\"a_developer\",\"alias\":\"开发者-1\"}]}")
echo "$TEAM_JSON"
TEAM=$(echo "$TEAM_JSON" | body | j "['id']" 2>/dev/null)
if [ -z "$TEAM" ]; then echo "STEP1 RETRY-ONCE"; sleep 2; TEAM_JSON=$(A $BASE/teams -X POST -d "{\"name\":\"su-f3-team-${TS}b\",\"description\":\"F3 retry\",\"members\":[{\"agentId\":\"a_product\"},{\"agentId\":\"a_developer\"}]}"); echo "$TEAM_JSON"; TEAM=$(echo "$TEAM_JSON" | body | j "['id']"); fi
echo "TEAM=$TEAM"
M_DEV=$(echo "$TEAM_JSON" | body | python3 -c "import sys,json;d=json.load(sys.stdin);print([m['id'] for m in d['members'] if m['agentId']=='a_developer'][0])")
M_PROD=$(echo "$TEAM_JSON" | body | python3 -c "import sys,json;d=json.load(sys.stdin);print([m['id'] for m in d['members'] if m['agentId']=='a_product'][0])")
echo "M_DEV=$M_DEV M_PROD=$M_PROD"
echo "--- STEP1b GET team ---"
A $BASE/teams/$TEAM | head -c 400; echo
echo "--- channels (team_group, taskId null expected) ---"
A "$BASE/channels?teamId=$TEAM"

echo "--- STEP2 create-task ---"
TASK_JSON=$(A $BASE/tasks -X POST -d "{\"title\":\"SU-F3 walkthrough task\",\"description\":\"isolated verification\",\"teamId\":\"$TEAM\",\"teamAgentIds\":[\"a_developer\",\"a_product\"]}")
echo "$TASK_JSON"
TASK=$(echo "$TASK_JSON" | body | j "['id']")
echo "TASK=$TASK"
echo "--- fresh-DB assert: 0 task-bound session rows ---"
docker exec su-f3-db mysql -uroot -psu-f3-pw -e "SELECT COUNT(*) AS task_sessions FROM su_e2e.sessions WHERE task_id IS NOT NULL; SHOW TABLES LIKE 'task_agents';" 2>/dev/null

GROUP=$(curl -s "$BASE/channels?teamId=$TEAM" -H "Authorization: Bearer $TOKEN" | j "['items'][0]['id']")
echo "GROUP=$GROUP"
echo "--- STEP3 group @ message ---"
MSG_JSON=$(A $BASE/channels/$GROUP/messages -X POST -d "{\"text\":\"@开发者-1 请认领 SU-F3 任务并回复收到\",\"mentions\":[{\"type\":\"agent\",\"agentId\":\"a_developer\"}],\"taskId\":\"$TASK\"}")
echo "$MSG_JSON"
MID=$(echo "$MSG_JSON" | body | j "['message']['id']")

echo "--- STEP4 dm-channel create ---"
DM_JSON=$(A $BASE/dm-channels -X POST -d "{\"teamId\":\"$TEAM\",\"teamMemberId\":\"$M_DEV\"}")
echo "$DM_JSON"
DM=$(echo "$DM_JSON" | body | j "['id']")
echo "DM=$DM"
echo "--- STEP4 dm user message ---"
DMMSG=$(A $BASE/channels/$DM/messages -X POST -d '{"text":"你好，请简述你的角色职责"}')
echo "$DMMSG"
SES=$(echo "$DMMSG" | body | python3 -c "import sys,json;d=json.load(sys.stdin);t=d.get('triggers') or [];print(t[0].get('sessionId') if t else '')")
echo "SES=$SES"

echo "--- STEP3b worker register ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/workers/register -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d '{"workerId":"w_su_f3","opencodeVersion":"0.0.0-f3","capabilities":{"maxInstances":5,"skills":[],"tools":[]},"load":{"instances":0}}'
echo "--- STEP3b delta x2 (DM streaming accumulation: reasoning+text+tool) ---"
curl -s -o /dev/null -w 'delta1:%{http_code}\n' $BASE/worker/events -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"workerId\":\"w_su_f3\",\"eventId\":\"evw_f3_1\",\"type\":\"message.part.delta\",\"seq\":1,\"payload\":{\"taskId\":\"$TASK\",\"agentId\":\"a_developer\",\"sessionId\":\"$SES\",\"channelId\":\"$DM\",\"parts\":[{\"type\":\"reasoning\",\"text\":\"思考中\"},{\"type\":\"text\",\"text\":\"收到，\",\"synthetic\":false}],\"status\":\"streaming\"}}"
curl -s -o /dev/null -w 'delta2:%{http_code}\n' $BASE/worker/events -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"workerId\":\"w_su_f3\",\"eventId\":\"evw_f3_2\",\"type\":\"message.part.delta\",\"seq\":2,\"payload\":{\"taskId\":\"$TASK\",\"agentId\":\"a_developer\",\"sessionId\":\"$SES\",\"channelId\":\"$DM\",\"parts\":[{\"type\":\"text\",\"text\":\"我是开发者-1，已认领 SU-F3 任务。\",\"synthetic\":false},{\"type\":\"tool\",\"tool\":\"read_file\"}],\"status\":\"streaming\"}}"
sleep 2
echo "--- verify DM messages (agent processing + accumulated parts) ---"
A "$BASE/channels/$DM/messages?limit=10"
echo "--- session-history path ---"
A "$BASE/channels/$DM/session-history?limit=10" | head -c 600; echo
echo "--- SSE probe (GET /events?token=<jwt>, 5s window) ---"
curl -s -N --max-time 5 "$BASE/events?token=$TOKEN" -H 'Accept: text/event-stream' | head -c 600; echo; echo "SSE_PROBE_DONE"

echo "--- STEP-R reset route (Todo11 new route) ---"
OLD_SES="$SES"
RESET_JSON=$(A $BASE/teams/$TEAM/members/$M_DEV/reset-session -X POST -d '{}')
echo "$RESET_JSON"
NEW_SES=$(echo "$RESET_JSON" | body | j "['session']['id']")
echo "OLD_SES=$OLD_SES NEW_SES=$NEW_SES"
echo "--- STEP-R negative: old task route must 404 ---"
A $BASE/tasks/$TASK/instances/$M_DEV/reset-session -X POST -d '{}'
echo "--- STEP-R negative: unknown member must 404 ---"
A $BASE/teams/$TEAM/members/tmm_9999999999/reset-session -X POST -d '{}'

echo "--- STEP-M managedMode team switch ---"
A $BASE/teams/$TEAM -X PATCH -d '{"managedMode":true}' | body | j "['managedMode']"
echo "--- STEP-M verify GET team managedMode ---"
A $BASE/teams/$TEAM | body | j "['managedMode']"

echo "--- STEP5 memory_save team via MCP ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/platform-mcp -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_save\",\"arguments\":{\"teamId\":\"$TEAM\",\"selfInstanceId\":\"$M_DEV\",\"level\":\"team\",\"content\":\"SU-F3 团队记忆：开发者-1 负责后端接口实现\",\"description\":\"f3 team memory\"}}}"
echo "--- STEP5 memory read team ---"
A "$BASE/memories?level=team&teamId=$TEAM" | head -c 800; echo
echo "--- STEP5 negative: level=task ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/platform-mcp -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_save","arguments":{"level":"task","content":"x"}}}'

echo "--- STEP6 start (negative first: MAIN_AGENT_NOT_SET) ---"
A $BASE/tasks/$TASK/start -X POST -d '{}'
echo "--- STEP6 set team mainAgent ---"
A $BASE/teams/$TEAM -X PATCH -d "{\"mainAgentMemberId\":\"$M_PROD\"}" | body | j "['mainAgentMemberId']"
echo "--- STEP6 start/mark-pending-review/accept/archive ---"
A $BASE/tasks/$TASK/start -X POST -d '{}' | body | j "['status']"
A $BASE/tasks/$TASK/mark-pending-review -X POST -d '{}' | body | j "['status']"
A $BASE/tasks/$TASK/accept -X POST -d '{}' | body | j "['status']"
A $BASE/tasks/$TASK/archive -X POST -d '{}' | body | j "['status']"
echo "--- final fresh-DB asserts ---"
docker exec su-f3-db mysql -uroot -psu-f3-pw -e "SELECT COUNT(*) AS task_sessions FROM su_e2e.sessions WHERE task_id IS NOT NULL; SELECT id,status FROM su_e2e.tasks WHERE id='$TASK';" 2>/dev/null
echo "=== DONE TEAM=$TEAM TASK=$TASK ==="
