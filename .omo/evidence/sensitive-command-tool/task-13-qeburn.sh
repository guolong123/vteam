#!/bin/sh
# task-13 helper: server restart resets the in-memory `que` sequence (known
# defect, plan todo 11 not yet fixed) → every secret_input insert P2002s until
# the counter passes the existing max. Each failed call consumes exactly one
# sequence value; the first successful call creates a question and is cut by
# --max-time, which the server finalises as cancelled on disconnect.
set -u
EV="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:13000/api/v1/platform-mcp"
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"secret_command","arguments":{"taskId":"t_0000000002","selfInstanceId":"tmm_0000000002","command":"echo burn-{{B}}","variables":[{"name":"B"}],"timeoutSec":30,"reason":"task13 que burn"}}}'
OUT="$EV/task-13-qeburn.txt"
: > "$OUT"
i=0
while [ "$i" -lt 40 ]; do
  i=$((i + 1))
  RESP=$(curl -sS --max-time 6 -H 'content-type: application/json' \
    -H 'x-worker-token: compose-worker-token' \
    -H 'x-worker-id: w_compose_worker' \
    -d "$BODY" "$URL" 2>&1) || true
  echo "burn#$i => $(echo "$RESP" | head -c 240)" >> "$OUT"
  case "$RESP" in
    *agent_questions_request_id_key*|*"Unique constraint"*)
      continue ;;
    *)
      echo "COUNTER_ALIGNED after $i calls" >> "$OUT"
      break ;;
  esac
done
echo "burn done i=$i" >> "$OUT"
tail -3 "$OUT"
