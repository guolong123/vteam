#!/bin/sh
# task-13 distinguishing probe — BASELINE (current build, NO heartbeat)
# Real blocking secret_command tools/call through the opencode 1.18.32 MCP client
# (injected config timeout=900000), held without ever answering the secret question.
# Captures client JSON events, client stderr, server/worker docker logs, question rows.
set -u
EV="$(cd "$(dirname "$0")" && pwd)"
RUN="$EV/task-13-baseline"
DOCKER=/usr/local/bin/docker
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
T0=$(date -u +%s)
{
  echo "STAMP=$STAMP"
  echo "T0_EPOCH=$T0"
  date -u +"T0=%Y-%m-%dT%H:%M:%S.%3NZ"
} > "$RUN.meta.txt"

PROMPT='请立刻以 JSON 形式调用 MCP 工具 vteam_secret_command，arguments 必须严格等于：{"taskId":"t_0000000002","selfInstanceId":"tmm_0000000002","command":"echo probe-{{P}}","variables":[{"name":"P"}],"timeoutSec":60,"reason":"task13 baseline probe"} 。注意：不要先调用 task_context 或任何其他工具做验证，不要提问、不要解释，直接发起 vteam_secret_command 调用并原地等待其返回结果；variables[0] 不要带 secret 字段，所有值必须是 JSON 原生类型（不要把布尔/数字写成字符串）。'

nohup "$DOCKER" exec -w /data/vteam-worker -e TASK13_PROMPT="$PROMPT" \
  aiagents-compose-worker sh -lc \
  'exec timeout 900 /usr/local/bin/opencode run -m opencode/big-pickle --auto --format json "$TASK13_PROMPT"' \
  > "$RUN.client.jsonl" 2> "$RUN.client-err.log" &
CPID=$!
echo "CLIENT_PID=$CPID" >> "$RUN.meta.txt"

# poll question rows every 15s while the client runs
while kill -0 "$CPID" 2>/dev/null; do
  date -u +"poll=%Y-%m-%dT%H:%M:%S.%3NZ" >> "$RUN.questions.txt"
  "$DOCKER" exec aiagents-compose-db sh -lc \
    'mysql -uroot -paiagents-root aiagents -e "select id,status,request_id,created_at,updated_at from agent_questions where kind=\"secret_input\" order by id desc limit 3"' \
    2>/dev/null >> "$RUN.questions.txt" || true
  sleep 15
done
wait "$CPID"; EXIT=$?
date -u +"CLIENT_EXIT=$EXIT" >> "$RUN.meta.txt"
T1=$(date -u +%s)
date -u +"T1=%Y-%m-%dT%H:%M:%S.%3NZ" >> "$RUN.meta.txt"

"$DOCKER" logs --since "${T0}" --until "$((T1 + 3))" aiagents-compose-server > "$RUN.server.log" 2>&1
"$DOCKER" logs --since "${T0}" --until "$((T1 + 3))" aiagents-compose-worker > "$RUN.worker.log" 2>&1
echo "DONE" >> "$RUN.meta.txt"
