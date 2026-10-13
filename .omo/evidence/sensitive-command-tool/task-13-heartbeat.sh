#!/bin/sh
# task-13 distinguishing probe — HEARTBEAT build (image with 30s SSE heartbeat)
# Real blocking secret_command via the opencode 1.18.32 MCP client, held past
# the ~240s abort window: at question+450s the secret is answered so the command
# (sleep 150, timeoutSec 300) runs, pushing the total hold beyond 600s.
set -u
EV="$(cd "$(dirname "$0")" && pwd)"
RUN="$EV/task-13-heartbeat"
DOCKER=/usr/local/bin/docker
T0=$(date -u +%s)
{
  echo "STAMP=$(date -u +%Y%m%dT%H%M%SZ)"
  echo "T0_EPOCH=$T0"
} > "$RUN.meta.txt"

PROMPT='请立刻以 JSON 形式调用 MCP 工具 vteam_secret_command，arguments 必须严格等于：{"taskId":"t_0000000002","selfInstanceId":"tmm_0000000002","command":"sleep 150 # {{P}}","variables":[{"name":"P"}],"timeoutSec":300,"reason":"task13 heartbeat probe"} 。注意：不要先调用 task_context 或任何其他工具做验证，不要提问、不要解释，直接发起 vteam_secret_command 调用并原地等待其返回结果；variables[0] 不要带 secret 字段，所有值必须是 JSON 原生类型。'

nohup "$DOCKER" exec -w /data/vteam-worker -e TASK13_PROMPT="$PROMPT" \
  aiagents-compose-worker sh -lc \
  'exec timeout 1200 /usr/local/bin/opencode run -m opencode/big-pickle --auto --format json "$TASK13_PROMPT"' \
  > "$RUN.client.jsonl" 2> "$RUN.client-err.log" &
CPID=$!
echo "CLIENT_PID=$CPID" >> "$RUN.meta.txt"

# 1) wait for this run's pending secret question
QID=""
SEEN=""
while [ -z "$QID" ] && kill -0 "$CPID" 2>/dev/null; do
  QID=$("$DOCKER" exec aiagents-compose-db sh -lc \
    "mysql -uroot -paiagents-root -N -B aiagents -e \"select id from agent_questions where kind='secret_input' and status='pending' and created_at >= from_unixtime($T0) limit 1\"" \
    2>/dev/null | grep '^aq_' | head -1 || true)
  [ -n "$QID" ] && SEEN=$(date -u +%s)
  [ -n "$QID" ] || sleep 5
done
{
  echo "QID=$QID"
  echo "Q_SEEN_EPOCH=$SEEN"
  date -u +"Q_SEEN=%Y-%m-%dT%H:%M:%SZ"
} >> "$RUN.meta.txt"

# 2) hold 450s from question sighting, then answer so execution pushes >600s total
if [ -n "$QID" ]; then
  WAIT=$((SEEN + 450 - $(date -u +%s)))
  [ "$WAIT" -gt 0 ] && sleep "$WAIT"
  TOKEN=$(curl -sS --max-time 20 -H 'content-type: application/json' \
    -d '{"username":"seed-admin","password":"Admin@123456"}' \
    http://localhost:13000/api/v1/auth/login \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
  date -u +"REPLY_AT=%Y-%m-%dT%H:%M:%SZ" >> "$RUN.meta.txt"
  curl -sS --max-time 30 -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d '{"secrets":{"P":"probe-fake-secret-1"}}' \
    "http://localhost:13000/api/v1/questions/$QID/reply" > "$RUN.reply.json" 2>&1
  date -u +"REPLY_DONE=%Y-%m-%dT%H:%M:%SZ" >> "$RUN.meta.txt"
else
  echo "NO_QUESTION" >> "$RUN.meta.txt"
fi

# 3) wait for client exit
while kill -0 "$CPID" 2>/dev/null; do sleep 5; done
wait "$CPID"; EXIT=$?
T1=$(date -u +%s)
{
  echo "CLIENT_EXIT=$EXIT"
  echo "T1_EPOCH=$T1"
  echo "TOTAL_SECONDS=$((T1 - T0))"
  date -u +"T1=%Y-%m-%dT%H:%M:%SZ"
} >> "$RUN.meta.txt"

"$DOCKER" logs --since "${T0}" --until "$((T1 + 3))" aiagents-compose-server > "$RUN.server.log" 2>&1
"$DOCKER" logs --since "${T0}" --until "$((T1 + 3))" aiagents-compose-worker > "$RUN.worker.log" 2>&1
echo "DONE" >> "$RUN.meta.txt"
