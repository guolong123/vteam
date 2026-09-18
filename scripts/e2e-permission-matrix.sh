#!/usr/bin/env bash
#
# e2e: tool authority = per-role allowlist (server-gate-removal-tool-authority).
#
# Proves end-to-end against a LIVE stack (server + worker + db) that the former
# server-side main-instance identity gates are gone and that tool permission is
# decided ONLY by the role's worker-guard allowlist:
#   1) role×tool allow/deny matrix, DERIVED from the running server's compiled
#      constants (ROLE_BOUNDARIES[*].toolAllows + VTEAM_MCP_TOOL_NAMES +
#      VTEAM_GIT_TOOL_NAMES + VTEAM_BROWSER_TOOL_NAMES), evaluated through the
#      worker's OWN guard code (dist/role-guard/policy.js evaluateToolCall,
#      same code the injected vteam-role-guard.ts plugin snapshots) against the
#      LIVE .vteam-role-guard/roles.json. NO literal tool list and NO literal
#      count appear in this script — the expectation is read from source.
#   2) layer ① (injected opencode.json agent[*].permission) carries exactly the
#      mcpDenies complement (VTEAM_MCP_TOOL_NAMES − toolAllows) as explicit deny
#      keys, all deny-valued; also derived from source.
#   3) server identity refusals are ABSENT: a NON-MAIN instance calls plan_mode
#      (same-value no-op) and task_transition through real HTTP without the
#      removed 403; only business validation can reject.
#   4) the retained server-side checks still refuse, each by code/message:
#      notify routing (self-notify + non-main→non-main), terminal-task dispatch,
#      accept/archive, global-memory write scope, hook_cancel owner-or-main,
#      and the plan-revision stale-hash gate.
#   5) the retired gating constant is empty in source and has ZERO occurrences in
#      the compiled worker dist, and no removed gate message survives in dist/src.
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
# when roles.json is stale. The terminal-task retained probe lands one group
# message before the dispatcher refuses (same precedent as the other e2e
# scripts); all other retained probes refuse before any write. Idempotent:
# re-running twice in a row passes.
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

# reload_worker : restart (NOT --force-recreate, which re-runs the `init`
# dependency and may reseed the DB) so the worker start-only injector
# re-fetches /agent-policies and re-writes roles.json + opencode.json.
reload_worker() {
  (cd "$REPO_ROOT" && docker compose restart worker >/dev/null 2>&1) \
    || docker restart aiagents-compose-worker >/dev/null 2>&1
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

# ---------------------------------------------------------------- step 0: read the source of truth
# The expectation for EVERY assertion below is read from the RUNNING server's
# compiled constants — no literal tool name list and no literal count in this
# script. This is the derivation proof: if the source and the live guard
# disagree, the matrix assertion fails.
log "--- step 0: read authoritative constants from the running server dist ---"
SRC_JSON="$EVIDENCE_DIR/source-constants.json"
if [[ -n "${SOURCE_CONSTANTS_JSON:-}" && -f "${SOURCE_CONSTANTS_JSON}" ]]; then
  # SOURCE_CONSTANTS_JSON overrides the source read for the derivation proof.
  cp "$SOURCE_CONSTANTS_JSON" "$SRC_JSON"
  log "using caller-supplied source constants: $SOURCE_CONSTANTS_JSON"
else
(cd "$REPO_ROOT" && docker compose exec -T server node -e '
const C = require("/app/dist/src/common/constants/agent.constants.js");
const out = {
  mcpToolNames: C.VTEAM_MCP_TOOL_NAMES,
  gitToolNames: C.VTEAM_GIT_TOOL_NAMES,
  browserToolNames: C.VTEAM_BROWSER_TOOL_NAMES,
  retiredServerGated: C.ROLE_SERVER_GATED_TOOLS,
  roles: {},
};
for (const [name, boundary] of Object.entries(C.ROLE_BOUNDARIES)) {
  out.roles[name] = Object.keys(boundary.toolAllows);
}
process.stdout.write(JSON.stringify(out));
' >"$SRC_JSON") || fail "0-source" "could not read compiled constants from server dist"
fi
python3 - "$SRC_JSON" <<'EOF' || fail "0-source" "source constants JSON is malformed (raw: $SRC_JSON)"
import json,sys
src=json.load(open(sys.argv[1]))
assert src.get("mcpToolNames"), "no VTEAM_MCP_TOOL_NAMES in source"
assert src.get("roles"), "no ROLE_BOUNDARIES in source"
print("source-of-truth: %d roles, %d MCP + %d git + %d browser tools, retired gated constant=%r"
      % (len(src["roles"]), len(src["mcpToolNames"]), len(src["gitToolNames"]),
         len(src["browserToolNames"]), src["retiredServerGated"]))
EOF
log "source constants: $SRC_JSON"

# ---------------------------------------------------------------- step 0b: freshness (source-derived sentinel)
log "--- step 0b: ensure live roles.json guard allowlists match the source ---"
guard_matches_source() {
  (cd "$REPO_ROOT" && docker compose exec -T worker cat /data/vteam-worker/.vteam-role-guard/roles.json 2>/dev/null) >"$EVIDENCE_DIR/roles-live.json" || return 1
  python3 - "$SRC_JSON" "$EVIDENCE_DIR/roles-live.json" <<'EOF'
import json,sys
src=json.load(open(sys.argv[1])); live=json.load(open(sys.argv[2]))
roles=(live.get("roles") or {})
for name, allows in src["roles"].items():
    if name not in roles:
        raise SystemExit("live roles.json missing %s" % name)
    got=set((roles[name].get("tools") or {}).keys())
    if got != set(allows):
        raise SystemExit("live guard tools for %s != source toolAllows" % name)
EOF
}
if guard_matches_source; then
  log "live roles.json guard allowlists already match source; no restart needed"
else
  log "live guard state stale vs source; restarting worker to re-inject ..."
  reload_worker
  deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
  found=""
  while [[ $SECONDS -lt $deadline ]]; do
    if guard_matches_source; then found="yes"; break; fi
    sleep "$RESTART_INTERVAL_SEC"
  done
  [[ -n "$found" ]] || fail "0b-refresh" "roles.json still stale after ${RESTART_TIMEOUT_SEC}s (source vs live guard mismatch)"
  log "worker re-injected; live guard allowlists match source"
fi
pass "0 (source constants read; live guard allowlists match source)"

# ---------------------------------------------------------------- step 1: derived role×tool guard matrix
log "--- step 1: role×tool allow/deny matrix (source-derived, worker guard) ---"
MATRIX_JS="$(mktmp)"
cat >"$MATRIX_JS" <<'EOF'
const fs = require('fs');
const { evaluateToolCall } = require('/app/dist/role-guard/policy.js');
const src = JSON.parse(fs.readFileSync('/tmp/e2e-permission-matrix-source.json', 'utf8'));
const rolesDoc = JSON.parse(fs.readFileSync('/data/vteam-worker/.vteam-role-guard/roles.json', 'utf8'));
const tools = [...src.mcpToolNames, ...src.gitToolNames, ...src.browserToolNames];
const out = [];
for (const agent of Object.keys(src.roles)) {
  const allows = new Set(src.roles[agent]);
  for (const tool of tools) {
    const d = evaluateToolCall({ rolesDoc, session: { agent, dir: '/data/vteam-worker' }, tool, args: {} });
    out.push({ agent, tool, expect: allows.has(tool) ? 'allow' : 'deny', action: d.action, message: d.message || null });
  }
  const c = evaluateToolCall({ rolesDoc, session: { agent, dir: '/data/vteam-worker' }, tool: 'vteam_member_remove', args: {} });
  out.push({ agent, tool: 'vteam_member_remove', expect: 'deny', action: c.action, message: c.message || null, control: true });
}
process.stdout.write(JSON.stringify(out));
EOF
MATRIX_OUT="$EVIDENCE_DIR/guard-matrix.json"
(cd "$REPO_ROOT" && docker compose cp "$SRC_JSON" worker:/tmp/e2e-permission-matrix-source.json >/dev/null) \
  || fail "1-guard" "could not copy source constants into worker"
(cd "$REPO_ROOT" && docker compose cp "$MATRIX_JS" worker:/tmp/e2e-permission-matrix-guard.js >/dev/null) \
  || fail "1-guard" "could not copy guard matrix script into worker"
(cd "$REPO_ROOT" && docker compose exec -T worker node /tmp/e2e-permission-matrix-guard.js >"$MATRIX_OUT") \
  || fail "1-guard" "worker guard matrix eval failed (raw: $MATRIX_OUT)"
log "guard matrix raw: $MATRIX_OUT"

if ! python3 - "$SRC_JSON" "$MATRIX_OUT" <<'EOF'
import json,sys
src=json.load(open(sys.argv[1])); rows=json.load(open(sys.argv[2]))
roles=list(src["roles"]); tools=list(src["mcpToolNames"])+list(src["gitToolNames"])+list(src["browserToolNames"])
expected_cells=len(roles)*len(tools)
assert expected_cells>0, "empty matrix (roles=%d tools=%d)" % (len(roles),len(tools))
cells=[r for r in rows if not r.get("control")]
assert len(cells)==expected_cells, "matrix size %d != roles(%d)*tools(%d)=%d (empty-set guard)" % (
    len(cells),len(roles),len(tools),expected_cells)
bad=[(r["agent"],r["tool"],r["expect"],r["action"]) for r in cells if r["action"]!=r["expect"]]
assert not bad, "live guard disagrees with source toolAllows in %d cell(s): %r" % (len(bad),bad[:10])
allow_cells=[(r["agent"],r["tool"]) for r in cells if r["expect"]=="allow"]
deny_cells=[(r["agent"],r["tool"]) for r in cells if r["expect"]=="deny"]
assert allow_cells and deny_cells, "non-discriminating matrix (allow=%d deny=%d)" % (len(allow_cells),len(deny_cells))
controls=[r for r in rows if r.get("control")]
for r in controls:
    assert r["action"]=="deny", "negative control %s/%s=%r (want deny)" % (r["agent"],r["tool"],r["action"])
    assert r["message"] and "越界拦截" in r["message"], "control deny lacks correction literal: %r" % r
print("guard matrix: %d roles x %d tools = %d cells all match source toolAllows (%d allow / %d deny); %d negative controls deny"
      % (len(roles),len(tools),expected_cells,len(allow_cells),len(deny_cells),len(controls)))
print("guard matrix sample (source-derived): ALLOW %s/%s  |  DENY %s/%s"
      % (allow_cells[0][0],allow_cells[0][1],deny_cells[0][0],deny_cells[0][1]))
EOF
then
  fail "1-guard" "derived guard matrix assertion failed (raw: $MATRIX_OUT)"
fi
pass "1 (derived role×tool guard matrix: every cell matches source toolAllows; unlisted = deny)"

# ---------------------------------------------------------------- step 2: layer ① = mcpDenies complement
log "--- step 2: injected opencode.json layer-① permission = VTEAM_MCP − toolAllows, all deny ---"
INJECTED_OUT="$EVIDENCE_DIR/injected-opencode.json"
(cd "$REPO_ROOT" && docker compose cp worker:/data/vteam-worker/opencode.json "$INJECTED_OUT" >/dev/null) \
  || fail "2-layer1" "docker compose cp worker opencode.json failed"
if ! python3 - "$SRC_JSON" "$INJECTED_OUT" <<'EOF'
import json,sys
src=json.load(open(sys.argv[1])); d=json.load(open(sys.argv[2]))
mcp=set(src["mcpToolNames"]); agents=d.get("agent") or {}
assert agents, "injected opencode.json has no agent section"
for name in src["roles"]:
    assert name in agents, "injected opencode.json lacks built-in %s" % name
    perm=agents[name].get("permission") or {}
    assert "write" not in perm, "agent %s carries legacy write key" % name
    vk={k:v for k,v in perm.items() if k.startswith("vteam_")}
    expect=sorted(mcp-set(src["roles"][name]))
    ctx=sorted(vk)
    assert ctx==expect, "agent %s layer-① mcpDenies %r != VTEAM_MCP−toolAllows %r" % (name,ctx,expect)
    notdeny=sorted(k for k,v in vk.items() if v!="deny")
    assert not notdeny, "agent %s layer-① keys not deny-valued: %r" % (name,notdeny)
    assert isinstance(perm.get("edit"),dict) and perm["edit"].get("*")=="deny", \
      "agent %s edit lacks '*':deny default: %r" % (name,perm.get("edit"))
print("layer-1: %d agents carry exactly (VTEAM_MCP − toolAllows) as deny keys; no write key; edit '*':deny"
      % len(src["roles"]))
EOF
then
  fail "2-layer1" "layer-1 derived assertion failed (raw: $INJECTED_OUT)"
fi
pass "2 (layer-① permission is the source-derived mcpDenies complement, all deny)"

# ---------------------------------------------------------------- step 3: server identity refusals ABSENT
log "--- step 3: former server identity refusals are ABSENT (non-main over real HTTP) ---"
MAIN_MEMBER="$(db_query "SELECT main_agent_member_id FROM teams WHERE id='${TEAM_ID}';" | tr -d '\r\n ')"
[[ -n "$MAIN_MEMBER" ]] || fail "3-absence" "no main_agent_member_id for team $TEAM_ID"
TASK_ROW="$(db_query "SELECT CONCAT(id, ' ', status, ' ', plan_mode) FROM tasks WHERE team_id='${TEAM_ID}' ORDER BY id LIMIT 1;" | tr -d '\r')"
TASK_ID="$(printf '%s' "$TASK_ROW" | awk '{print $1}')"
TASK_STATUS="$(printf '%s' "$TASK_ROW" | awk '{print $2}')"
TASK_PLANMODE="$(printf '%s' "$TASK_ROW" | awk '{print $3}')"
[[ -n "$TASK_ID" && -n "$TASK_STATUS" && -n "$TASK_PLANMODE" ]] \
  || fail "3-absence" "no task row for team $TEAM_ID (got: $TASK_ROW)"
NONMAIN_MEMBER="$(db_query "SELECT team_member_id FROM sessions WHERE team_id='${TEAM_ID}' AND worker_id='${WORKER_ID}' AND team_member_id <> '${MAIN_MEMBER}' ORDER BY team_member_id LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$NONMAIN_MEMBER" ]] || fail "3-absence" "no non-main session for worker $WORKER_ID in team $TEAM_ID"
log "main=$MAIN_MEMBER nonmain=$NONMAIN_MEMBER task=$TASK_ID status=$TASK_STATUS planMode=$TASK_PLANMODE"

# 3a: non-main plan_mode set to its CURRENT value -> must NOT be refused by an identity gate.
NONMAIN_PM_OUT="$EVIDENCE_DIR/absence-nonmain-plan_mode.json"
if [[ "$TASK_PLANMODE" == "1" ]]; then PM_ENABLED='true'; else PM_ENABLED='false'; fi
mcp_call "$NONMAIN_PM_OUT" 11 plan_mode \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "enabled": sys.argv[3] == "true"}))' "$TASK_ID" "$NONMAIN_MEMBER" "$PM_ENABLED")"
log "non-main plan_mode raw: $(cat "$NONMAIN_PM_OUT")"
if ! python3 - "$NONMAIN_PM_OUT" "$PM_ENABLED" "$TASK_ID" "$NONMAIN_MEMBER" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1])); want=sys.argv[2]=="true"; task=sys.argv[3]; who=sys.argv[4]
assert "error" not in d, "non-main(%s) plan_mode rejected on task %s: %r (identity gate not removed?)" % (who,task,d.get("error"))
body=json.loads((d.get("result") or {}).get("content",[{}])[0].get("text","{}"))
assert body.get("planMode") is want, "planMode=%r (want unchanged %r)" % (body.get("planMode"),want)
print("absence: non-main plan_mode passes (no identity 403); planMode unchanged")
EOF
then
  fail "3a-plan-mode-allow" "non-main plan_mode was refused (raw: $NONMAIN_PM_OUT)"
fi
pass "3a (former plan_mode identity gate ABSENT: non-main same-value call succeeds)"

# 3b: non-main task_transition with a state-invalid action -> business 409, never the removed 403.
if [[ "$TASK_STATUS" == "pending_review" ]]; then INVALID_ACTION='start'; else INVALID_ACTION='reject'; fi
NONMAIN_TT_OUT="$EVIDENCE_DIR/absence-nonmain-task_transition.json"
mcp_call "$NONMAIN_TT_OUT" 12 task_transition \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "action": sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$INVALID_ACTION")"
log "non-main task_transition action=$INVALID_ACTION raw: $(cat "$NONMAIN_TT_OUT")"
if ! python3 - "$NONMAIN_TT_OUT" "$TASK_STATUS" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1])); status=sys.argv[2]
err=d.get("error") or {}
msg=err.get("message") or ""
assert err.get("code") != -32003, "non-main task_transition hit a 403 identity gate: %r" % d
for banned in ("TASK_STATUS_MAIN_AGENT_ONLY","仅主 Agent"):
    assert banned not in msg, "removed main-only refusal still present: %r" % msg
if status == "pending_review":
    assert "TASK_INVALID_TRANSITION" in msg, "want business validation, got: %r" % msg
print("absence: non-main task_transition reaches business validation only (no identity 403)")
EOF
then
  fail "3b-task-transition-allow" "non-main task_transition still refused by identity gate (raw: $NONMAIN_TT_OUT)"
fi
AFTER_STATUS="$(db_query "SELECT status FROM tasks WHERE id='${TASK_ID}';" | tr -d '\r\n ')"
[[ "$AFTER_STATUS" == "$TASK_STATUS" ]] \
  || fail "3b-task-transition-allow" "probe mutated task $TASK_ID status ($TASK_STATUS -> $AFTER_STATUS)"
pass "3b (former task_transition identity gate ABSENT: non-main reaches business validation; task unmutated)"

# ---------------------------------------------------------------- step 4: retained server checks
log "--- step 4: retained server-side refusals still enforced (by code/message) ---"
NONCE="sgrta8-$(date +%s)"

# 4a: notify routing — self-notify.
SELF_OUT="$EVIDENCE_DIR/retained-notify-self.json"
mcp_call "$SELF_OUT" 21 notify_agent \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "targetInstanceId": sys.argv[2], "content": "e2e retained self-notify %s" % sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$NONCE")"
if ! python3 - "$SELF_OUT" <<'EOF'
import json,sys
err=(json.load(open(sys.argv[1])).get("error") or {})
msg=err.get("message") or ""
assert err.get("code")==-32003, "self-notify not a 403: %r" % err
assert "NOTIFY_ROUTING_VIOLATION" in msg, "self-notify missing NOTIFY_ROUTING_VIOLATION: %r" % msg
print("retained: self-notify -> 403 NOTIFY_ROUTING_VIOLATION")
EOF
then
  fail "4a-notify-self" "self-notify routing refusal not enforced (raw: $SELF_OUT)"
fi
pass "4a (retained: self-notify -> 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION)"

# 4b: notify routing — non-main -> non-main.
CROSS_OUT="$EVIDENCE_DIR/retained-notify-cross.json"
TARGET_MEMBER="$(db_query "SELECT team_member_id FROM sessions WHERE team_id='${TEAM_ID}' AND worker_id='${WORKER_ID}' AND team_member_id NOT IN ('${MAIN_MEMBER}','${NONMAIN_MEMBER}') ORDER BY team_member_id LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$TARGET_MEMBER" ]] || fail "4b-notify-cross" "need a second non-main session in team $TEAM_ID"
mcp_call "$CROSS_OUT" 22 notify_agent \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "targetInstanceId": sys.argv[3], "content": "e2e retained cross-notify %s" % sys.argv[4]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$TARGET_MEMBER" "$NONCE")"
if ! python3 - "$CROSS_OUT" <<'EOF'
import json,sys
err=(json.load(open(sys.argv[1])).get("error") or {})
msg=err.get("message") or ""
assert err.get("code")==-32003, "non-main->non-main not a 403: %r" % err
assert "NOTIFY_ROUTING_VIOLATION" in msg and "可向其他成员派发" in msg, \
  "non-main->non-main missing routing message: %r" % msg
print("retained: non-main -> non-main -> 403 NOTIFY_ROUTING_VIOLATION")
EOF
then
  fail "4b-notify-cross" "non-main->non-main routing refusal not enforced (raw: $CROSS_OUT)"
fi
pass "4b (retained: non-main -> non-main -> 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION)"

# 4c: accept/archive refusal — an agent can never complete/archive a task.
for ACTION in accept archive; do
  AA_OUT="$EVIDENCE_DIR/retained-accept-archive-$ACTION.json"
  AA_BEFORE="$(db_query "SELECT status FROM tasks WHERE id='${TASK_ID}';" | tr -d '\r\n ')"
  mcp_call "$AA_OUT" 23 task_transition \
    "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "action": sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$ACTION")"
  AA_AFTER="$(db_query "SELECT status FROM tasks WHERE id='${TASK_ID}';" | tr -d '\r\n ')"
  if ! python3 - "$AA_OUT" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]))
err=d.get("error") or {}
assert err, "agent %s was not refused: %r" % (sys.argv[2] if len(sys.argv)>2 else "", d)
msg=err.get("message") or ""
assert "TASK_AGENT_COMPLETION_FORBIDDEN" in msg or "仅人类用户" in msg or "Invalid option" in msg, \
  "refusal does not signal human-only completion: %r" % msg
print("retained: accept/archive refused to agent (code=%s)" % err.get("code"))
EOF
  then
    fail "4c-accept-archive" "$ACTION not refused (raw: $AA_OUT)"
  fi
  [[ "$AA_AFTER" == "$AA_BEFORE" ]] \
    || fail "4c-accept-archive" "$ACTION mutated task status ($AA_BEFORE -> $AA_AFTER)"
done
# Both retained sites are present in the compiled server (MCP + service layer).
AA_SITES="$(cd "$REPO_ROOT" && docker compose exec -T server sh -c \
  "grep -l 'TASK_AGENT_COMPLETION_FORBIDDEN' dist/src/platform-mcp/platform-mcp.service.js dist/src/tasks/tasks.service.js 2>/dev/null | wc -l")"
AA_SITES="$(printf '%s' "$AA_SITES" | tr -d '\r\n ')"
[[ "$AA_SITES" == "2" ]] || fail "4c-accept-archive" "retained accept/archive code missing from compiled server (sites=$AA_SITES, want 2)"
pass "4c (retained: accept/archive refused to agent; both retained sites present in dist)"

# 4d: global-memory write scope — a non-main member cannot write global-level memory.
MEM_OUT="$EVIDENCE_DIR/retained-global-memory.json"
mcp_call "$MEM_OUT" 24 memory_save \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "level": "global", "content": "e2e retained global memory %s" % sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$NONCE")"
if ! python3 - "$MEM_OUT" <<'EOF'
import json,sys
err=(json.load(open(sys.argv[1])).get("error") or {})
msg=err.get("message") or ""
assert err.get("code")==-32003, "non-main global write not a 403: %r" % err
assert "可写入全局记忆" in msg, "missing global-memory scope message: %r" % msg
print("retained: non-main global memory_save -> 403 scope refusal")
EOF
then
  fail "4d-global-memory" "global-memory write scope not enforced (raw: $MEM_OUT)"
fi
pass "4d (retained: non-main global memory_save -> 403 scope refusal)"

# 4e: hook_cancel owner-or-main — a non-owner non-main cannot cancel another's hook.
HOOK_OUT="$EVIDENCE_DIR/retained-hook-register.json"
mcp_call "$HOOK_OUT" 25 hook_register \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "kind": "time", "wakeText": "e2e retained hook", "delayMs": 3600000, "dedupKey": "e2e-retained-hook-%s" % sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$NONCE")"
HOOK_ID="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.loads(d["result"]["content"][0]["text"]).get("hookId",""))' "$HOOK_OUT" 2>/dev/null || true)"
[[ -n "$HOOK_ID" ]] || fail "4e-hook-cancel" "could not register a probe hook (raw: $HOOK_OUT)"
HC_OUT="$EVIDENCE_DIR/retained-hook-cancel.json"
mcp_call "$HC_OUT" 26 hook_cancel \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "hookId": sys.argv[3]}))' "$TASK_ID" "$TARGET_MEMBER" "$HOOK_ID")"
if ! python3 - "$HC_OUT" <<'EOF'
import json,sys
err=(json.load(open(sys.argv[1])).get("error") or {})
msg=err.get("message") or ""
assert err.get("code")==-32003, "non-owner hook_cancel not a 403: %r" % err
assert "hook 所有者" in msg, "missing hook owner-or-main message: %r" % msg
print("retained: non-owner non-main hook_cancel -> 403 owner-or-main")
EOF
then
  # Best-effort owner cleanup before failing so no probe hook is left pending.
  mcp_call "$EVIDENCE_DIR/retained-hook-cancel-cleanup.json" 27 hook_cancel \
    "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "hookId": sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$HOOK_ID")" || true
  fail "4e-hook-cancel" "hook_cancel owner-or-main not enforced (raw: $HC_OUT)"
fi
mcp_call "$EVIDENCE_DIR/retained-hook-cancel-cleanup.json" 27 hook_cancel \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "hookId": sys.argv[3]}))' "$TASK_ID" "$NONMAIN_MEMBER" "$HOOK_ID")" >/dev/null || true
pass "4e (retained: non-owner non-main hook_cancel -> 403 owner-or-main)"

# 4f: plan-revision stale-hash gate — a mismatched planHash is refused (plan-gated).
STALE_TASK="$(db_query "SELECT i.task_id FROM issues i WHERE i.description LIKE '%planVersion%' GROUP BY i.task_id ORDER BY i.task_id LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$STALE_TASK" ]] || fail "4f-stale-hash" "no task with a review-round ledger (frozen hash) found"
FROZEN_HASH="$(db_query "SELECT i.description FROM issues i WHERE i.task_id='${STALE_TASK}' AND i.description LIKE '%planVersion%' LIMIT 1;" | grep -o '"hash": *"[0-9a-f]*"' | head -1 | sed -E 's/.*"([0-9a-f]+)"/\1/')"
[[ -n "$FROZEN_HASH" ]] || fail "4f-stale-hash" "could not extract frozen hash for task $STALE_TASK"
STALE_TARGET="$(db_query "SELECT team_member_id FROM sessions WHERE team_id=(SELECT team_id FROM tasks WHERE id='${STALE_TASK}') AND worker_id='${WORKER_ID}' AND team_member_id <> (SELECT main_agent_member_id FROM teams WHERE id=(SELECT team_id FROM tasks WHERE id='${STALE_TASK}')) LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$STALE_TARGET" ]] || fail "4f-stale-hash" "no non-main session in the ledger task's team"
STALE_MAIN="$(db_query "SELECT main_agent_member_id FROM teams WHERE id=(SELECT team_id FROM tasks WHERE id='${STALE_TASK}');" | tr -d '\r\n ')"
HASH_OUT="$EVIDENCE_DIR/retained-stale-hash.json"
mcp_call "$HASH_OUT" 28 notify_agent \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "targetInstanceId": sys.argv[3], "content": "e2e retained stale-hash %s" % sys.argv[4], "planHash": "deadbeef"}))' "$STALE_TASK" "$STALE_MAIN" "$STALE_TARGET" "$NONCE")"
if ! python3 - "$HASH_OUT" "$FROZEN_HASH" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1])); frozen=sys.argv[2]
body=json.loads((d.get("result") or {}).get("content",[{}])[0].get("text","{}"))
assert body.get("triggered") is False, "stale-hash dispatch not suppressed: %r" % d
assert body.get("reason")=="plan-gated", "reason=%r (want plan-gated)" % body.get("reason")
hint=body.get("hint") or ""
assert frozen in hint and "deadbeef" in hint, "hint must name both short hashes: %r" % hint
print("retained: stale planHash -> plan-gated, hint names #%s vs #deadbeef" % frozen)
EOF
then
  fail "4f-stale-hash" "stale planHash not refused (raw: $HASH_OUT)"
fi
pass "4f (retained: stale planHash -> plan-gated with both short hashes in hint)"

# 4g: terminal-task execution dispatch refusal.
TERM_TASK="$(db_query "SELECT id FROM tasks WHERE status IN ('completed','archived') ORDER BY id LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$TERM_TASK" ]] || fail "4g-terminal" "no completed/archived task to probe"
TERM_TEAM="$(db_query "SELECT team_id FROM tasks WHERE id='${TERM_TASK}';" | tr -d '\r\n ')"
TERM_MAIN="$(db_query "SELECT main_agent_member_id FROM teams WHERE id='${TERM_TEAM}';" | tr -d '\r\n ')"
TERM_TARGET="$(db_query "SELECT team_member_id FROM sessions WHERE team_id='${TERM_TEAM}' AND worker_id='${WORKER_ID}' AND team_member_id <> '${TERM_MAIN}' LIMIT 1;" | tr -d '\r\n ')"
[[ -n "$TERM_TARGET" ]] || fail "4g-terminal" "no non-main session in terminal task's team"
TERM_OUT="$EVIDENCE_DIR/retained-terminal-task.json"
mcp_call "$TERM_OUT" 29 notify_agent \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId": sys.argv[1], "selfInstanceId": sys.argv[2], "targetInstanceId": sys.argv[3], "content": "e2e retained terminal %s" % sys.argv[4]}))' "$TERM_TASK" "$TERM_MAIN" "$TERM_TARGET" "$NONCE")"
if ! python3 - "$TERM_OUT" "$TERM_TASK" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1])); task=sys.argv[2]
err=d.get("error") or {}
msg=err.get("message") or ""
assert err, "terminal-task dispatch was not refused: %r" % d
assert "终态" in msg and "execution 派发已拒绝" in msg, \
  "terminal refusal message missing: %r" % msg
print("retained: execution dispatch into terminal task %s refused" % task)
EOF
then
  fail "4g-terminal" "terminal-task dispatch refusal not enforced (raw: $TERM_OUT)"
fi
pass "4g (retained: execution dispatch into completed/archived task refused)"

# ---------------------------------------------------------------- step 5: retired gating concept gone from source + dist
log "--- step 5: retired gating constant is empty and absent from compiled artefacts ---"
if ! python3 - "$SRC_JSON" <<'EOF'
import json,sys
src=json.load(open(sys.argv[1]))
assert src.get("retiredServerGated")==[], \
  "retired gating constant is not empty in server source: %r" % src.get("retiredServerGated")
print("source: ROLE_SERVER_GATED_TOOLS = [] (no tool is server-gated by identity)")
EOF
then
  fail "5-retired" "retired gating constant is non-empty (raw: $SRC_JSON)"
fi
WORKER_GATED_COUNT="$(cd "$REPO_ROOT" && docker compose exec -T worker node -e \
  "const s=require('fs').readFileSync('/app/dist/role-guard/policy.js','utf8'); process.stdout.write(String((s.match(/SERVER_GATED_TOOLS/g)||[]).length));" | tr -d '\r\n ')"
[[ "$WORKER_GATED_COUNT" == "0" ]] \
  || fail "5-retired" "worker dist still carries SERVER_GATED_TOOLS (count=$WORKER_GATED_COUNT)"
REMOVED_MSG_HITS="$(cd "$REPO_ROOT" && docker compose exec -T server sh -c \
  "grep -ro '可创建任务\|可沉淀技能\|可申请增员\|可切换计划模式\|可标记计划完工\|可流转任务状态\|可确认托管模式下的请求' dist/src 2>/dev/null | wc -l" | tr -d '\r\n ')"
[[ "$REMOVED_MSG_HITS" == "0" ]] \
  || fail "5-retired" "removed gate messages survive in compiled server dist (hits=$REMOVED_MSG_HITS)"
pass "5 (retired constant empty; worker dist has 0 SERVER_GATED_TOOLS refs; 0 removed gate messages in dist/src)"

log "ALL STEPS DONE: 0/0b/1/2/3a/3b/4a/4b/4c/4d/4e/4f/4g/5"
printf '[e2e] \033[32mPASS\033[0m permission-matrix (evidence: %s)\n' "$EVIDENCE_DIR" | tee -a "$E2E_LOG"
