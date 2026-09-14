#!/usr/bin/env bash
#
# e2e: default permission matrix split — guard pass-through vs server main-instance gate.
#
# Proves end-to-end against a LIVE stack (server + worker + db):
#   1) guard pass-through (layer ②): the worker's OWN guard code
#      (dist/role-guard/policy.js evaluateToolCall, same code the injected
#      vteam-role-guard.ts plugin snapshots) returns allow for EACH of the
#      5 server-gated tools for every guard-mapped built-in role, against the
#      LIVE .vteam-role-guard/roles.json; negative control (unlisted non-gated
#      MCP vteam_member_remove) stays deny.
#   2) layer ① does not deny gated: the injected opencode.json
#      agent[*].permission has NO key for any gated tool, for all 6 built-ins.
#   3) newly allowed tools: vteam-project_manager -> chat_history = allow,
#      vteam-developer -> doclib = allow, all 6 roles -> wecom_reply = allow.
#   4) server gate still enforces (real HTTP, not re-implemented logic):
#      POST /api/v1/platform-mcp tools/call plan_mode + task_transition with a
#      non-main instance -> JSON-RPC error -32003 whose message carries the
#      403 main-instance gate (仅主 Agent); the main instance is NOT rejected
#      at that gate (plan_mode same-value write succeeds; task_transition with
#      a state-invalid action fails only on business validation, never the
#      403). Main vs non-main instance ids come from the DB
#      (teams.main_agent_member_id + sessions bound to this worker).
#   5) cross-side constant consistency: server ROLE_SERVER_GATED_TOOLS
#      (dist require) == worker SERVER_GATED_TOOLS (dist extract), same 5 values.
#   6) no regression on ordinary boundaries: genuinely-denied pairs
#      (vteam-plan -> vteam_group_post, vteam-developer -> vteam_issue_create)
#      remain deny.
#
# Required env: none (all discovered with documented defaults).
# Optional env:
#   SERVER_URL    server base WITHOUT /api/v1, e.g. http://localhost:13000.
#                 Default: http://localhost:13000
#   X_WORKER_TOKEN worker token (must match server WORKER_TOKEN; sent as
#                 x-worker-token header). Default chain: $X_WORKER_TOKEN, then
#                 $WORKER_TOKEN, then WORKER_TOKEN= line in repo-root .env,
#                 then compose default compose-worker-token.
#   WORKER_ID     x-worker-id header value. Default: w_compose_worker
#   TEAM_ID       default tm_0000000001
#   EVIDENCE_DIR  default .omo/evidence/permission-matrix (repo-root relative
#                 or absolute; created if missing)
#   RESTART_TIMEOUT_SEC  wait budget when roles.json is stale and the worker
#                 must be restarted to re-inject. Default: 180
#   RESTART_INTERVAL_SEC poll interval. Default: 5
#
# Run (from repo root):
#   bash scripts/e2e-permission-matrix.sh
#
# Rule: any failed assertion prints FAIL and exits non-zero. Temp files are
# removed on EXIT. The script is read-only against business data: the only
# writes are plan_mode set to its CURRENT value (no-op) and worker restarts
# when roles.json is stale. Idempotent: re-running twice in a row passes.
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
WORKER_ID="${WORKER_ID:-w_compose_worker}"
TEAM_ID="${TEAM_ID:-tm_0000000001}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/permission-matrix}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-180}"
RESTART_INTERVAL_SEC="${RESTART_INTERVAL_SEC:-5}"

case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

if [[ -z "${X_WORKER_TOKEN:-}" ]]; then
  if [[ -n "${WORKER_TOKEN:-}" ]]; then
    X_WORKER_TOKEN="$WORKER_TOKEN"
  elif [[ -f "$REPO_ROOT/.env" ]]; then
    X_WORKER_TOKEN="$(grep -E '^WORKER_TOKEN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
  fi
fi
X_WORKER_TOKEN="${X_WORKER_TOKEN:-compose-worker-token}"

# ---------------------------------------------------------------- helpers
E2E_LOG="$EVIDENCE_DIR/e2e.txt"
: >"$E2E_LOG"

log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] \033[32mPASS\033[0m %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { # $1 = step, $2 = reason
  printf '[e2e] \033[31mFAIL\033[0m step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd docker

TMP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $TMP_FILES 2>/dev/null || true
}
trap cleanup EXIT
mktmp() {
  local f
  f="$(mktemp)"
  TMP_FILES="$TMP_FILES $f"
  printf '%s' "$f"
}

# jget <json-file> <python-expr on `d`> : print extracted value or empty.
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v='"$2"'; print("" if v is None else (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))' "$1"; }

# db_query <sql> : single-value DB lookup against the compose db (stdout, no header).
db_query() {
  docker exec aiagents-compose-db mysql -uroot -paiagents-root -D aiagents -N -e "$1" 2>/dev/null \
    || (cd "$REPO_ROOT" && docker compose exec -T db mysql -uroot -paiagents-root -D aiagents -N -e "$1" 2>/dev/null)
}

# mcp_call <out-file> <id> <tool> <arguments-json> : POST tools/call, saves raw body.
mcp_call() {
  local out="$1" id="$2" tool="$3" args="$4"
  local body
  body="$(mktmp)"
  python3 - "$body" "$id" "$tool" "$args" <<'EOF'
import json,sys
out, rid, tool, args = sys.argv[1:5]
json.dump({"jsonrpc": "2.0", "id": int(rid), "method": "tools/call",
           "params": {"name": tool, "arguments": json.loads(args)}},
          open(out, "w"), ensure_ascii=False)
EOF
  curl -sS -o "$out" -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H 'Content-Type: application/json' \
    -H "x-worker-id: $WORKER_ID" \
    -H "x-worker-token: $X_WORKER_TOKEN" \
    --data @"$body"
}

# ---------------------------------------------------------------- preconditions
log "SERVER_URL=$SERVER_URL WORKER_ID=$WORKER_ID TEAM_ID=$TEAM_ID"
HEALTH_OUT="$(mktmp)"
if ! curl -sS -o "$HEALTH_OUT" -w '%{http_code}' "$SERVER_URL/api/v1/health" | grep -q '^200$'; then
  # /health may live at another prefix; fall back to tools/list as liveness.
  LIST_PROBE="$(mktmp)"
  body="$(mktmp)"
  printf '{"jsonrpc":"2.0","id":0,"method":"tools/list","params":{}}' >"$body"
  code="$(curl -sS -o "$LIST_PROBE" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H 'Content-Type: application/json' \
    -H "x-worker-id: $WORKER_ID" \
    -H "x-worker-token: $X_WORKER_TOKEN" \
    --data @"$body")"
  [[ "$code" == "200" ]] || fail "pre" "server not reachable at $SERVER_URL (health + platform-mcp probe failed)"
  log "server live (via platform-mcp tools/list)"
else
  log "server live (via /api/v1/health)"
fi

# ---------------------------------------------------------------- freshness: restart worker if roles.json is stale
log "--- step 0: ensure live roles.json already passes the gated sentinel ---"
SENTINEL="$(cd "$REPO_ROOT" && docker compose exec -T worker node -e "
const fs = require('fs');
const {evaluateToolCall} = require('/app/dist/role-guard/policy.js');
const rolesDoc = JSON.parse(fs.readFileSync('/data/vteam-worker/.vteam-role-guard/roles.json', 'utf8'));
const d = evaluateToolCall({rolesDoc, session:{agent:'vteam-project_manager', dir:'/data/vteam-worker'}, tool:'vteam_task_transition', args:{}});
console.log(d.action);
" 2>/dev/null | tr -d '\r\n ' || true)"
if [[ "$SENTINEL" != "allow" ]]; then
  log "roles.json stale (sentinel=$SENTINEL); restarting worker to re-inject ..."
  (cd "$REPO_ROOT" && docker compose up -d --force-recreate worker >/dev/null 2>&1) \
    || fail "0-refresh" "docker compose up -d --force-recreate worker failed"
  deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
  found=""
  while [[ $SECONDS -lt $deadline ]]; do
    SENTINEL="$(cd "$REPO_ROOT" && docker compose exec -T worker node -e "
const fs = require('fs');
const {evaluateToolCall} = require('/app/dist/role-guard/policy.js');
const rolesDoc = JSON.parse(fs.readFileSync('/data/vteam-worker/.vteam-role-guard/roles.json', 'utf8'));
const d = evaluateToolCall({rolesDoc, session:{agent:'vteam-project_manager', dir:'/data/vteam-worker'}, tool:'vteam_task_transition', args:{}});
console.log(d.action);
" 2>/dev/null | tr -d '\r\n ' || true)"
    if [[ "$SENTINEL" == "allow" ]]; then found="yes"; break; fi
    sleep "$RESTART_INTERVAL_SEC"
  done
  [[ -n "$found" ]] || fail "0-refresh" "roles.json still stale after ${RESTART_TIMEOUT_SEC}s (sentinel=$SENTINEL)"
  log "worker re-injected; sentinel=allow"
else
  log "live roles.json fresh (sentinel=allow), no restart needed"
fi
pass "0 (live guard state fresh)"

# ---------------------------------------------------------------- step 1+3+6: guard matrix via the worker's OWN guard code
log "--- step 1/3/6: guard decisions via worker dist role-guard/policy.js ---"
GUARD_JS="$(mktmp)"
cat >"$GUARD_JS" <<'EOF'
const fs = require('fs');
const {evaluateToolCall} = require('/app/dist/role-guard/policy.js');
const rolesDoc = JSON.parse(fs.readFileSync('/data/vteam-worker/.vteam-role-guard/roles.json', 'utf8'));
const GATED = ['vteam_task_transition','vteam_question_confirm','vteam_task_create','vteam_plan_mode','vteam_team_add_member'];
const ROLES = ['vteam-plan','vteam-product','vteam-architect','vteam-developer','vteam-tester','vteam-project_manager'];
const out = [];
for (const agent of ROLES) {
  for (const tool of GATED) {
    const d = evaluateToolCall({rolesDoc, session:{agent, dir:'/data/vteam-worker'}, tool, args:{}});
    out.push({agent, tool, action: d.action, message: d.message || null});
  }
}
const EXTRA = [
  ['vteam-project_manager','vteam_chat_history'],
  ['vteam-project_manager','vteam_wecom_reply'],
  ['vteam-developer','vteam_doclib'],
  ['vteam-developer','vteam_wecom_reply'],
  ['vteam-plan','vteam_wecom_reply'],
  ['vteam-product','vteam_wecom_reply'],
  ['vteam-architect','vteam_wecom_reply'],
  ['vteam-tester','vteam_wecom_reply'],
  ['vteam-project_manager','vteam_member_remove'],
  ['vteam-plan','vteam_group_post'],
  ['vteam-developer','vteam_issue_create'],
];
for (const [agent, tool] of EXTRA) {
  const d = evaluateToolCall({rolesDoc, session:{agent, dir:'/data/vteam-worker'}, tool, args:{}});
  out.push({agent, tool, action: d.action, message: d.message || null});
}
console.log(JSON.stringify(out, null, 2));
EOF
GUARD_REMOTE="/tmp/e2e-permission-matrix-guard.js"
GUARD_OUT="$EVIDENCE_DIR/guard-decision.json"
(cd "$REPO_ROOT" && docker compose cp "$GUARD_JS" worker:"$GUARD_REMOTE" >/dev/null) \
  || fail "1-guard" "docker compose cp guard matrix script into worker failed"
(cd "$REPO_ROOT" && docker compose exec -T worker node "$GUARD_REMOTE" >"$GUARD_OUT") \
  || fail "1-guard" "worker guard matrix eval failed (raw: $GUARD_OUT)"
log "guard matrix raw: $GUARD_OUT"

# Step 1: all 6 roles x 5 gated == allow; PM unlisted non-gated == deny.
if ! python3 - "$GUARD_OUT" <<'EOF'
import json,sys
rows = json.load(open(sys.argv[1]))
GATED = {'vteam_task_transition','vteam_question_confirm','vteam_task_create','vteam_plan_mode','vteam_team_add_member'}
ROLES = {'vteam-plan','vteam-product','vteam-architect','vteam-developer','vteam-tester','vteam-project_manager'}
by = {(r['agent'], r['tool']): r for r in rows}
for agent in sorted(ROLES):
    for tool in sorted(GATED):
        a = by[(agent, tool)]['action']
        assert a == 'allow', "%s -> %s = %r (want allow)" % (agent, tool, a)
neg = by[('vteam-project_manager','vteam_member_remove')]
assert neg['action'] == 'deny', "negative control vteam_member_remove = %r (want deny)" % neg['action']
assert neg['message'] and '越界拦截' in neg['message'], "deny lacks correction literal: %r" % neg
print("guard: 6 roles x 5 gated = allow; vteam_member_remove = deny (+correction literal)")
EOF
then
  fail "1-guard" "pass-through assertion failed (raw: $GUARD_OUT)"
fi
pass "1 (guard pass-through: 6 roles x 5 gated = allow; unlisted non-gated = deny)"

# Step 3: newly allowed tools.
if ! python3 - "$GUARD_OUT" <<'EOF'
import json,sys
rows = json.load(open(sys.argv[1]))
by = {(r['agent'], r['tool']): r for r in rows}
for agent, tool in [('vteam-project_manager','vteam_chat_history'),
                    ('vteam-developer','vteam_doclib'),
                    ('vteam-plan','vteam_wecom_reply'),
                    ('vteam-product','vteam_wecom_reply'),
                    ('vteam-architect','vteam_wecom_reply'),
                    ('vteam-developer','vteam_wecom_reply'),
                    ('vteam-tester','vteam_wecom_reply'),
                    ('vteam-project_manager','vteam_wecom_reply')]:
    a = by[(agent, tool)]['action']
    assert a == 'allow', "%s -> %s = %r (want allow)" % (agent, tool, a)
print("guard: chat_history(PM) + doclib(dev) + wecom_reply(all 6) = allow")
EOF
then
  fail "3-new-tools" "newly-allowed assertion failed (raw: $GUARD_OUT)"
fi
pass "3 (newly allowed: PM chat_history, dev doclib, all-6 wecom_reply = allow)"

# Step 6: ordinary boundaries did not regress.
if ! python3 - "$GUARD_OUT" <<'EOF'
import json,sys
rows = json.load(open(sys.argv[1]))
by = {(r['agent'], r['tool']): r for r in rows}
for agent, tool in [('vteam-plan','vteam_group_post'),
                    ('vteam-developer','vteam_issue_create')]:
    r = by[(agent, tool)]
    assert r['action'] == 'deny', "%s -> %s = %r (want deny)" % (agent, tool, r['action'])
    assert r['message'] and '越界拦截' in r['message'], "%s -> %s deny lacks correction literal" % (agent, tool)
print("guard: plan/group_post + developer/issue_create still deny")
EOF
then
  fail "6-regression" "boundary-regression assertion failed (raw: $GUARD_OUT)"
fi
pass "6 (no regression: plan group_post + developer issue_create = deny)"

# ---------------------------------------------------------------- step 2: layer-① has no gated key
log "--- step 2: injected opencode.json permission has no gated key ---"
INJECTED_OUT="$EVIDENCE_DIR/injected-opencode.json"
(cd "$REPO_ROOT" && docker compose cp worker:/data/vteam-worker/opencode.json "$INJECTED_OUT" >/dev/null) \
  || fail "2-layer1" "docker compose cp worker opencode.json failed"
(cd "$REPO_ROOT" && docker compose exec -T worker cat /data/vteam-worker/.vteam-role-guard/roles.json >"$EVIDENCE_DIR/roles.json") \
  || fail "2-layer1" "could not snapshot live roles.json"
if ! python3 - "$INJECTED_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
GATED = ['vteam_task_transition','vteam_question_confirm','vteam_task_create','vteam_plan_mode','vteam_team_add_member']
BUILTINS = ['vteam-plan','vteam-product','vteam-architect','vteam-developer','vteam-tester','vteam-project_manager']
agents = d.get('agent') or {}
missing = [b for b in BUILTINS if b not in agents]
assert not missing, "injected opencode.json lacks built-ins: %r" % missing
for name in BUILTINS:
    perm = (agents[name] or {}).get('permission') or {}
    hit = [g for g in GATED if g in perm]
    assert not hit, "agent %s permission carries gated keys: %r" % (name, hit)
print("layer-1: 6 built-in agents, permission has no gated key")
EOF
then
  fail "2-layer1" "layer-1 assertion failed (raw: $INJECTED_OUT)"
fi
pass "2 (layer-1: no gated key in permission for all 6 built-ins)"

# ---------------------------------------------------------------- step 4: server gate over real HTTP
log "--- step 4: server main-instance gate via POST /api/v1/platform-mcp ---"
MAIN_MEMBER="$(db_query "SELECT main_agent_member_id FROM teams WHERE id='${TEAM_ID}';" | tr -d '\r\n ')"
[[ -n "$MAIN_MEMBER" ]] || fail "4-server-gate" "no main_agent_member_id for team $TEAM_ID"
TASK_ROW="$(db_query "SELECT CONCAT(id, ' ', status, ' ', plan_mode) FROM tasks WHERE team_id='${TEAM_ID}' ORDER BY id LIMIT 1;" | tr -d '\r')"
TASK_ID="$(printf '%s' "$TASK_ROW" | awk '{print $1}')"
TASK_STATUS="$(printf '%s' "$TASK_ROW" | awk '{print $2}')"
TASK_PLANMODE="$(printf '%s' "$TASK_ROW" | awk '{print $3}')"
[[ -n "$TASK_ID" && -n "$TASK_STATUS" && -n "$TASK_PLANMODE" ]] \
  || fail "4-server-gate" "no task row for team $TEAM_ID (got: $TASK_ROW)"
NONMAIN_MEMBER="$(db_query "SELECT team_member_id FROM sessions WHERE team_id='${TEAM_ID}' AND worker_id='${WORKER_ID}' AND team_member_id <> '${MAIN_MEMBER}' ORDER BY team_member_id LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$NONMAIN_MEMBER" ]] || fail "4-server-gate" "no non-main session for worker $WORKER_ID in team $TEAM_ID"
log "main=$MAIN_MEMBER nonmain=$NONMAIN_MEMBER task=$TASK_ID status=$TASK_STATUS planMode=$TASK_PLANMODE"

# 4a: non-main plan_mode -> 403 main gate (raw body is the evidence).
NONMAIN_PM_OUT="$EVIDENCE_DIR/server-gate-nonmain-plan_mode.json"
if [[ "$TASK_PLANMODE" == "1" ]]; then PM_ENABLED='true'; else PM_ENABLED='false'; fi
mcp_call "$NONMAIN_PM_OUT" 11 plan_mode \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "enabled": sys.argv[3] == "true"}))' "$TASK_ID" "$NONMAIN_MEMBER" "$PM_ENABLED")"
log "non-main plan_mode raw: $(cat "$NONMAIN_PM_OUT")"
if ! python3 - "$NONMAIN_PM_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
err = d.get('error') or {}
assert err.get('code') == -32003, "want JSON-RPC -32003 (403), got: %r" % (d,)
msg = err.get('message') or ''
assert '403' in msg and ('仅主 Agent' in msg or 'main' in msg.lower()), \
  "403 body lacks main-instance gate message: %r" % msg
print("server gate: non-main plan_mode -> -32003 + main-instance 403 message")
EOF
then
  fail "4a-plan-mode-deny" "non-main plan_mode was not rejected by the main gate (raw: $NONMAIN_PM_OUT)"
fi
pass "4a (server gate: non-main plan_mode rejected with 403 main-instance message)"

# 4b: main plan_mode with the CURRENT value -> succeeds (identity gate passes, no-op write).
MAIN_PM_OUT="$EVIDENCE_DIR/server-gate-main-plan_mode.json"
mcp_call "$MAIN_PM_OUT" 12 plan_mode \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "enabled": sys.argv[3] == "true"}))' "$TASK_ID" "$MAIN_MEMBER" "$PM_ENABLED")"
log "main plan_mode raw: $(cat "$MAIN_PM_OUT")"
if ! python3 - "$MAIN_PM_OUT" "$PM_ENABLED" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); want = sys.argv[2] == 'true'
assert 'error' not in d, "main plan_mode rejected: %r" % (d.get('error'),)
text = (d.get('result') or {}).get('content', [{}])[0].get('text', '{}')
body = json.loads(text)
assert body.get('planMode') is want, "planMode=%r (want unchanged %r)" % (body.get('planMode'), want)
print("server gate: main plan_mode passes identity gate (same-value no-op ok)")
EOF
then
  fail "4b-plan-mode-allow" "main plan_mode did not pass the identity gate (raw: $MAIN_PM_OUT)"
fi
pass "4b (server gate: main plan_mode passes identity gate)"

# 4c: non-main task_transition -> 403 main gate (TASK_STATUS_MAIN_AGENT_ONLY).
NONMAIN_TT_OUT="$EVIDENCE_DIR/server-gate-nonmain-task_transition.json"
mcp_call "$NONMAIN_TT_OUT" 13 task_transition \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "action": "accept"}))' "$TASK_ID" "$NONMAIN_MEMBER")"
log "non-main task_transition raw: $(cat "$NONMAIN_TT_OUT")"
if ! python3 - "$NONMAIN_TT_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
err = d.get('error') or {}
assert err.get('code') == -32003, "want JSON-RPC -32003 (403), got: %r" % (d,)
msg = err.get('message') or ''
assert '403' in msg and ('仅主 Agent' in msg or 'main' in msg.lower()), \
  "403 body lacks main-instance gate message: %r" % msg
assert 'TASK_STATUS_MAIN_AGENT_ONLY' in msg, "want TASK_STATUS_MAIN_AGENT_ONLY code, got: %r" % msg
print("server gate: non-main task_transition -> -32003 TASK_STATUS_MAIN_AGENT_ONLY")
EOF
then
  fail "4c-task-transition-deny" "non-main task_transition was not rejected by the main gate (raw: $NONMAIN_TT_OUT)"
fi
pass "4c (server gate: non-main task_transition rejected with 403)"

# 4d: main task_transition with a state-INVALID action -> must NOT hit the 403
# gate (only business validation, e.g. 409 TASK_INVALID_TRANSITION). The action
# is chosen so it can never mutate: archive is valid only from completed, and
# start is invalid from completed.
if [[ "$TASK_STATUS" == "completed" ]]; then INVALID_ACTION='start'; else INVALID_ACTION='archive'; fi
log "task status=$TASK_STATUS -> probing main with state-invalid action=$INVALID_ACTION"
MAIN_TT_OUT="$EVIDENCE_DIR/server-gate-main-task_transition.json"
mcp_call "$MAIN_TT_OUT" 14 task_transition \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "action": sys.argv[3]}))' "$TASK_ID" "$MAIN_MEMBER" "$INVALID_ACTION")"
log "main task_transition raw: $(cat "$MAIN_TT_OUT")"
if ! python3 - "$MAIN_TT_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
err = d.get('error') or {}
msg = err.get('message') or ''
assert err.get('code') != -32003, "main instance hit the 403 gate: %r" % (d,)
assert '仅主 Agent' not in msg, "main instance hit the main-instance gate message: %r" % msg
print("server gate: main task_transition passes identity gate (business outcome: %r)" % (d.get('result') is not None and 'ok' or msg))
EOF
then
  fail "4d-task-transition-allow" "main task_transition hit the main-instance gate (raw: $MAIN_TT_OUT)"
fi
AFTER_STATUS="$(db_query "SELECT status FROM tasks WHERE id='${TASK_ID}';" | tr -d '\r\n ')"
[[ "$AFTER_STATUS" == "$TASK_STATUS" ]] \
  || fail "4d-task-transition-allow" "probe mutated task $TASK_ID status ($TASK_STATUS -> $AFTER_STATUS)"
pass "4d (server gate: main task_transition passes identity gate; task unmutated)"

# ---------------------------------------------------------------- step 5: constant consistency server vs worker
log "--- step 5: ROLE_SERVER_GATED_TOOLS == SERVER_GATED_TOOLS ---"
SERVER_CONST_OUT="$EVIDENCE_DIR/constants-server.json"
(cd "$REPO_ROOT" && docker compose exec -T worker true >/dev/null) || fail "5-constants" "worker unreachable"
(cd "$REPO_ROOT" && docker compose exec -T server node -e \
  "console.log(JSON.stringify(require('/app/dist/src/common/constants/agent.constants.js').ROLE_SERVER_GATED_TOOLS))" \
  >"$SERVER_CONST_OUT") || fail "5-constants" "could not read server ROLE_SERVER_GATED_TOOLS"
WORKER_CONST_OUT="$EVIDENCE_DIR/constants-worker.json"
(cd "$REPO_ROOT" && docker compose exec -T worker node -e "
const fs = require('fs');
const s = fs.readFileSync('/app/dist/role-guard/policy.js', 'utf8');
const m = s.match(/SERVER_GATED_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
if (!m) { console.error('SERVER_GATED_TOOLS block not found'); process.exit(1); }
console.log(JSON.stringify(m[1].match(/'[^']+'/g).map(x => x.slice(1, -1))));
" >"$WORKER_CONST_OUT") || fail "5-constants" "could not extract worker SERVER_GATED_TOOLS"
if ! python3 - "$SERVER_CONST_OUT" "$WORKER_CONST_OUT" "$EVIDENCE_DIR/constants-compare.txt" <<'EOF'
import json,sys
srv = json.load(open(sys.argv[1])); wrk = json.load(open(sys.argv[2]))
assert sorted(srv) == sorted(wrk), "mismatch server=%r worker=%r" % (srv, wrk)
assert len(srv) == 5, "want exactly 5 gated tools, got %r" % (srv,)
open(sys.argv[3], "w").write("server == worker == %s\n" % json.dumps(sorted(srv), ensure_ascii=False))
print("constants: server == worker == %s" % sorted(srv))
EOF
then
  fail "5-constants" "constant sets differ (server: $SERVER_CONST_OUT, worker: $WORKER_CONST_OUT)"
fi
pass "5 (server ROLE_SERVER_GATED_TOOLS == worker SERVER_GATED_TOOLS, 5 values)"

log "ALL STEPS DONE: 0/1/2/3/4a/4b/4c/4d/5/6"
printf '[e2e] \033[32mPASS\033[0m permission-matrix (evidence: %s)\n' "$EVIDENCE_DIR" | tee -a "$E2E_LOG"
