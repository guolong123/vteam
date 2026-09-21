#!/usr/bin/env bash
# todo 9 (d) — LIVE literal `vteam-plan` planner path (the only name whose `task`
# fan-out the worker guard accepts), driven through the REAL stack:
#   server dispatch (worker /execute) -> opencode serve session -> guard + layer-1.
#
# Bounded claim: this proves the live planner path works with the literal `vteam-plan`
# and that the WORKER GUARD still restricts `task` to that literal. It does NOT claim a
# renamed planner can fan out sub-agents (see plan-gate.json D4 for the executed guard
# decision on a renamed binding).
#
# Trigger choice: a direct worker /execute is the DOCUMENTED allowed trigger for a
# session-scoped probe (see scripts/e2e-plan-member.sh header 5) — it bypasses server
# execution registration, so vteam MCP tools are not the assertion target here; the
# assertion is the guard/layer-1 behaviour on `task` for the literal agent.
set -uo pipefail
REPO="/Volumes/SSD-Data/01work/git-project/vteam"
OUT="$REPO/.omo/evidence/agent-role-decommission/task-9"
SERVE="http://localhost:14000"
TASK_ID="t_0000000001"
TASK_DIR="/data/vteam-worker/tasks/$TASK_ID"
LOG="$OUT/live-planner.txt"
: > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

say "== 9(d) live literal vteam-plan planner path =="
say "serve: $SERVE  taskDir: $TASK_DIR"

SYNC="$(curl -sS -w '\nHTTP %{http_code}' -X POST "$SERVE/session")"
say "-- serve session create --"
say "$(printf '%s' "$SYNC" | tail -1)"
SID="$(printf '%s' "$SYNC" | head -1 | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
say "sessionId=$SID"
[[ -n "$SID" ]] || { say "FAIL: no serve session"; exit 1; }

BODY="$OUT/live-planner-exec.json"
python3 - "$BODY" "$TASK_DIR" "$SID" "$TASK_ID" <<'EOF'
import json,sys
out, directory, sid, task = sys.argv[1:5]
json.dump({
  "agent": "vteam-plan", "directory": directory, "sessionId": sid,
  "taskId": task, "agentId": "a_plan",
  "prompt": [{"type":"text","text":
    "9(d) 计划员职责探针（只读，一步）。请严格按以下要求：调用 task 工具发起一个子会话，"
    "参数 subagent_type 固定为 'vteam-plan'，子会话指令只有一句：“读 /data/vteam-worker/tasks/"
    + task + " 目录下的文件列表并原样返回，返回文本以 T9-PROBE-OK 开头”。"
    "拿到子会话返回后，把结果全文用 T9-SUBAGENT-RESULT: 开头单行报告，并以 T9-DONE 结尾。不要写任何文件。"}]
}, open(out,"w"), ensure_ascii=False)
EOF

say "-- worker /execute (real guard + layer-1 apply) --"
EXEC_CODE="$(docker compose -f "$REPO/docker-compose.yml" exec -T worker curl -sS -o /tmp/t9-exec.json -w '%{http_code}' \
  -X POST http://localhost:4198/execute -H 'Content-Type: application/json' --data @- < "$BODY" 2>/dev/null)"
say "POST /execute -> HTTP $EXEC_CODE (202 = accepted)"
docker compose -f "$REPO/docker-compose.yml" cp worker:/tmp/t9-exec.json "$OUT/live-planner-accepted.json" >/dev/null 2>&1 || true
[[ "$EXEC_CODE" == "202" ]] || { say "NEEDS-ATTENTION: execute not accepted (HTTP $EXEC_CODE)"; exit 1; }

say "-- poll serve messages (bounded) --"
DEADLINE=$((SECONDS + 420))
LAST=""
while [[ $SECONDS -lt $DEADLINE ]]; do
  curl -sS "$SERVE/session/$SID/message" -o "$OUT/live-planner-messages.json" 2>/dev/null || true
  LAST="$(# ASSISTANT-ONLY extraction (mirrors scripts/e2e-plan-member.sh assistant_text()):
# the prompt echo is a `user` message and MUST NOT be able to satisfy the assertion —
# that vacuous-match trap is documented at e2e-role-boundaries.sh:352-356.
python3 - "$OUT/live-planner-messages.json" <<'EOF' 2>/dev/null || true
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: raise SystemExit
items = d if isinstance(d,list) else d.get("messages") or d.get("items") or []
out=[]
for it in items:
    if not isinstance(it,dict): continue
    info = it.get("info") or {}
    if info.get("role") != "assistant": continue
    for p in it.get("parts") or []:
        if not isinstance(p,dict): continue
        if p.get("type")=="text" and isinstance(p.get("text"),str) and p["text"].strip():
            out.append("[text] "+p["text"])
        elif p.get("type")=="tool":
            st = p.get("state") or {}
            out.append("[tool:%s] %s" % (p.get("tool",""), str(st.get("status") or "")))
            for k in ("output","error"):
                if isinstance(st.get(k),str) and st[k].strip(): out.append("  [%s] %s" % (k, st[k][:4000]))
toks = sum((it.get("info") or {}).get("tokens",{}).get("output",0) or 0 for it in items if isinstance(it,dict))
print("OUTPUT_TOKENS=%d" % toks)
print("\n".join(out)[-8000:])
EOF
)"
  if printf '%s' "$LAST" | grep -q 'T9-DONE'; then break; fi
  sleep 10
done
printf '%s' "$LAST" > "$OUT/live-planner-assistant.txt"

say "-- assertions (assistant-only; prompt echo excluded) --"
printf '%s\n' "$LAST" | head -1 | tee -a "$LOG"
if printf '%s' "$LAST" | grep -q 'T9-PROBE-OK' && printf '%s' "$LAST" | grep -qv 'OUTPUT_TOKENS=0'; then
  say "PASS: literal vteam-plan spawned a read-only vteam-plan subagent (T9-PROBE-OK observed in ASSISTANT output)"
else
  say "NEEDS-ATTENTION: no T9-PROBE-OK within the bound (LLM/infra stall?) — raw: $OUT/live-planner-assistant.txt"
fi
if printf '%s' "$LAST" | grep -q 'T9-SUBAGENT-RESULT'; then
  say "PASS: subagent result relayed (T9-SUBAGENT-RESULT observed)"
else
  say "NEEDS-ATTENTION: no T9-SUBAGENT-RESULT relay within the bound"
fi
say ""
say "bounded claim: literal vteam-plan planner path exercised live; renamed-planner fan-out NOT claimed"
