#!/bin/bash
# F3 follow-up: worker register + delta ingress + MCP memory (correct token).
[[ "$DATABASE_URL" == *":13306/"* ]] || { echo "GUARD FAIL"; exit 1; }
BASE=http://localhost:13100/api/v1
WTOKEN=$(grep '^WORKER_TOKEN=' /Users/mac/01work/git-project/vteam/server/.env | cut -d= -f2- | sed 's/^"//;s/"$//')
TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
TEAM=tm_0000000003; TASK=t_0000000002; DM=c_0000000004; SES=s_0000000004; M_DEV=tmm_0000000009
A() { curl -s -w '\nHTTP:%{http_code}\n' "$@" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'; }
echo "=== follow-up $(date -u +%FT%TZ) ==="
echo "--- worker register (retry of 401 step) ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/workers/register -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d '{"workerId":"w_su_f3","opencodeVersion":"0.0.0-f3","capabilities":{"maxInstances":5,"skills":[],"tools":[]},"load":{"instances":0}}'
echo "--- delta x2 streaming accumulation ---"
curl -s -o /dev/null -w 'delta1:%{http_code}\n' $BASE/worker/events -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"workerId\":\"w_su_f3\",\"eventId\":\"evw_f3b_1\",\"type\":\"message.part.delta\",\"seq\":101,\"payload\":{\"taskId\":\"$TASK\",\"agentId\":\"a_developer\",\"sessionId\":\"$SES\",\"channelId\":\"$DM\",\"parts\":[{\"type\":\"reasoning\",\"text\":\"思考中\"},{\"type\":\"text\",\"text\":\"收到，\",\"synthetic\":false}],\"status\":\"streaming\"}}"
curl -s -o /dev/null -w 'delta2:%{http_code}\n' $BASE/worker/events -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"workerId\":\"w_su_f3\",\"eventId\":\"evw_f3b_2\",\"type\":\"message.part.delta\",\"seq\":102,\"payload\":{\"taskId\":\"$TASK\",\"agentId\":\"a_developer\",\"sessionId\":\"$SES\",\"channelId\":\"$DM\",\"parts\":[{\"type\":\"text\",\"text\":\"我是开发者-1，已认领 SU-F3 任务。\",\"synthetic\":false},{\"type\":\"tool\",\"tool\":\"read_file\"}],\"status\":\"streaming\"}}"
sleep 2
echo "--- verify DM messages (expect user + agent processing w/ accumulated parts) ---"
A "$BASE/channels/$DM/messages?limit=10"
echo "--- MCP memory_save team ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/platform-mcp -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_save\",\"arguments\":{\"teamId\":\"$TEAM\",\"selfInstanceId\":\"$M_DEV\",\"level\":\"team\",\"content\":\"SU-F3 团队记忆：开发者-1 负责后端接口实现\",\"description\":\"f3 team memory\"}}}"
echo "--- memory read team ---"
A "$BASE/memories?level=team&teamId=$TEAM"
echo "--- negative level=task (expect JSON-RPC -32602) ---"
curl -s -w '\nHTTP:%{http_code}\n' $BASE/platform-mcp -X POST -H "X-Worker-Token: $WTOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"memory_save","arguments":{"level":"task","content":"x"}}}'
echo "=== FOLLOW-UP DONE ==="
