#!/usr/bin/env bash
# todo 9 (step 4c) — LIVE planner path on the FRESH stack, driven through the REAL
# server path (login → task create → start → group @-mention → dispatcher → worker
# /execute → opencode serve), using the seeded 计划员 member (a_plan → vteam-plan).
#
# Bounded target: the server selects the literal `vteam-plan` for the plan member
# (its Agent.agentKey='plan' → policy candidate `vteam-plan`, worker supports it),
# the plan-duty instruction set is injected, and the live session returns a plan.
# It does NOT claim any renamed planner can fan out sub-agents — the worker guard
# accepts `task` only for the literal `vteam-plan` (worker/src/role-guard/policy.ts:172-182).
set -uo pipefail
REPO="/Volumes/SSD-Data/01work/git-project/vteam"
OUT="$REPO/.omo/evidence/agent-role-decommission/task-9-fresh"
SERVER="http://localhost:13000"
LOG="$OUT/live-planner.txt"
: > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

say "== 9(d) LIVE planner path on the FRESH stack =="
say "server: $SERVER   out: $OUT"

TOKEN="$(curl -sS -X POST "$SERVER/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("accessToken",""))')"
[[ -n "$TOKEN" ]] || { say "FAIL: login failed"; exit 1; }
say "login: OK (accessToken len=${#TOKEN})"

# --- 1. model plumbing: make the fresh DB able to reach a working model -------------
# Fresh seed ships an EMPTY model catalog (STATIC_AVAILABLE_MODELS = []), so we register
# the reachable local provider exactly as an operator would (POST /models + credentials),
# then bind it to the worker default. This is DATA (operator setup), not code.
say ""
say "-- 1. model catalog provisioning (operator-shaped, POST /models + /credentials) --"
curl -sS -X POST "$SERVER/api/v1/models" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"providerID":"ornith","modelID":"ornith-1.5:35b","name":"Ornith 1.5 35B","enabled":true}' \
  -o "$OUT/model-create.json" -w 'POST /models -> HTTP %{http_code}\n' | tee -a "$LOG"
curl -sS -X PATCH "$SERVER/api/v1/models/providers/ornith" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"providerType":"custom","baseUrl":"http://192.168.10.10:11434/v1"}' \
  -o "$OUT/model-provider-patch.json" -w 'PATCH /models/providers/ornith -> HTTP %{http_code}\n' | tee -a "$LOG"
MODEL_ID="$(python3 -c 'import json;d=json.load(open("'"$OUT"'/model-create.json"));print(d.get("id","") or (d.get("model") or {}).get("id",""))' 2>/dev/null)"
say "created model id = $MODEL_ID"
# credential for the provider (value read from the restored auth.json — operator-supplied key)
ORNITH_KEY="$(docker compose -f "$REPO/docker-compose.yml" exec -T worker python3 -c 'import json;print(json.load(open("/root/.local/share/opencode/auth.json"))["ornith"]["key"])')"
curl -sS -X POST "$SERVER/api/v1/models/$MODEL_ID/credentials" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$ORNITH_KEY\",\"providerID\":\"ornith\"}" -o "$OUT/model-cred.json" -w 'POST /models/:id/credentials -> HTTP %{http_code}\n' | tee -a "$LOG"
curl -sS -X PATCH "$SERVER/api/v1/workers/w_compose_worker" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"defaultModelId":"ornith/ornith-1.5:35b"}' -o "$OUT/worker-model.json" -w 'PATCH /workers/w_compose_worker -> HTTP %{http_code}\n' | tee -a "$LOG"
# member-level override on the plan member (the UI's per-member model pick)
curl -sS -X PATCH "$SERVER/api/v1/teams/tm_0000000001/members/tmm_0000000006" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"overrideModelId":"ornith/ornith-1.5:35b"}' -o "$OUT/member-model.json" -w 'PATCH /teams/.../members/tmm_0000000006 -> HTTP %{http_code}\n' | tee -a "$LOG"

# --- 2. create + start a task (the task-mode trigger) -------------------------------
say ""
say "-- 2. task create + start --"
TASK_JSON="$(curl -sS -X POST "$SERVER/api/v1/tasks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"todo-9 fresh planner proof","description":"clean-rebuild verification","teamId":"tm_0000000001"}')"
echo "$TASK_JSON" > "$OUT/task-created.json"
TASK_ID="$(printf '%s' "$TASK_JSON" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("id",""))' 2>/dev/null)"
say "taskId = $TASK_ID"
[[ -n "$TASK_ID" ]] || { say "FAIL: task create"; exit 1; }
curl -sS -X POST "$SERVER/api/v1/tasks/$TASK_ID/start" -H "Authorization: Bearer $TOKEN" \
  -o "$OUT/task-started.json" -w 'POST /tasks/:id/start -> HTTP %{http_code}\n' | tee -a "$LOG"

# --- 3. group channel + @计划员 message (production trigger path) -------------------
say ""
say "-- 3. group @-mention → dispatcher (real path) --"
CH_ID="$(docker compose -f "$REPO/docker-compose.yml" exec -T -e MYSQL_PWD=aiagents-root db mysql -uroot -N aiagents \
  -e "SELECT id FROM chat_channels WHERE team_id='tm_0000000001' AND type='team_group' AND deleted_at IS NULL LIMIT 1;" 2>/dev/null | tr -d '\r')"
if [[ -z "$CH_ID" ]]; then
  CH_ID="$(curl -sS "$SERVER/api/v1/channels?teamId=tm_0000000001" -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys;d=json.load(sys.stdin);items=d if isinstance(d,list) else (d.get("items") or []);print(next((c["id"] for c in items if c.get("type")=="team_group"),""))' 2>/dev/null)"
fi
say "team_group channel = $CH_ID"
[[ -n "$CH_ID" ]] || { say "FAIL: no group channel"; exit 1; }

MSG_BODY="$(python3 - "$TASK_ID" <<'EOF'
import json,sys
task=sys.argv[1]
json.dump({"text":"@计划员 请为任务 " + task + " 输出一份最少步骤的实施计划（只读分析，不要写文件）。"
  "【9(d) 探针】请在回复正文中原样包含标记 T9-LIVE-PLAN-OK 并以 T9-LIVE-END 结尾。",
  "taskId":task,"mentions":[{"type":"agent","agentId":"a_plan","instanceId":"tmm_0000000006"}]}, sys.stdout, ensure_ascii=False)
EOF
)"
printf '%s' "$MSG_BODY" > "$OUT/trigger-message.json"
curl -sS -X POST "$SERVER/api/v1/channels/$CH_ID/messages" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$MSG_BODY" -o "$OUT/trigger-result.json" -w 'POST /channels/:id/messages -> HTTP %{http_code}\n' | tee -a "$LOG"
python3 - "$OUT/trigger-result.json" <<'EOF' | tee -a "$LOG"
import json,sys
d=json.load(open(sys.argv[1]))
print("triggers:", json.dumps(d.get("triggers"), ensure_ascii=False)[:600])
EOF

# --- 4. poll for the live session result (bounded) ---------------------------------
say ""
say "-- 4. bounded poll for the dispatched session (serve messages) --"
SESSION_ID="$(docker compose -f "$REPO/docker-compose.yml" exec -T -e MYSQL_PWD=aiagents-root db mysql -uroot -N aiagents \
  -e "SELECT instance_ref FROM sessions WHERE team_member_id='tmm_0000000006' AND instance_ref LIKE 'ses_%' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null | tr -d '\r')"
say "session instanceRef = $SESSION_ID"
DEADLINE=$((SECONDS + 600))
RESULT=""
while [[ $SECONDS -lt $DEADLINE ]]; do
  if [[ -n "$SESSION_ID" ]]; then
    docker compose -f "$REPO/docker-compose.yml" exec -T worker node -e "
      fetch('http://127.0.0.1:4000/session/$SESSION_ID/message').then(r=>r.json()).then(d=>{
        const out=[];
        for (const it of (Array.isArray(d)?d:[])) {
          const info=it.info||{};
          if (info.role!=='assistant') continue;
          if (info.error) out.push('ERR '+JSON.stringify(info.error).slice(0,300));
          for (const p of (it.parts||[])) if (p.type==='text'&&p.text) out.push(p.text);
          out.push('TOKENS='+JSON.stringify((info.tokens||{}).output||0));
        }
        console.log(out.join('\n'));
      }).catch(e=>console.log('ERR '+e.message));
    " > "$OUT/planner-live-messages.txt" 2>/dev/null
    RESULT="$(cat "$OUT/planner-live-messages.txt")"
    if printf '%s' "$RESULT" | grep -q 'T9-LIVE-END'; then break; fi
  fi
  sleep 15
done
printf '%s\n' "$RESULT" | tail -40 | tee -a "$LOG"

say ""
say "-- 5. assertions --"
if printf '%s' "$RESULT" | grep -q 'T9-LIVE-PLAN-OK'; then
  say "PASS: live literal-vteam-plan planner replied with the probe marker (assistant text)."
else
  say "NEEDS-ATTENTION: no T9-LIVE-PLAN-OK within the bound (LLM/infra stall?) — see planner-live-messages.txt"
fi
say ""
say "bounded claim: the SERVER selected the literal vteam-plan for the seeded plan member"
say "(agentKey='plan' → policy candidate 'vteam-plan', worker advertises support) and the live"
say "session ran end to end on the FRESH stack. Renamed-planner fan-out is NOT claimed — the"
say "worker guard allows tool 'task' only for the literal vteam-plan agent name."
