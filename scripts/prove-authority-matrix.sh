#!/usr/bin/env bash
#
# prove-authority-matrix.sh — todo 9 reproducible proof runner (server-gate-removal-tool-authority).
#
# Runs the checked-in spec `server/src/platform-mcp/platform-mcp.authority-matrix.spec.ts`
# (the 259-cell worker-guard matrix + the non-main success assertions + the service-level
# main happy path), then exercises the main-Agent happy path END TO END against the LIVE
# stack over real HTTP + DB, and merges both into ONE self-describing artifact:
#
#   .omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json
#
# The spec itself is the reproducible command for the worker-matrix + service-level half; this
# runner is the reproducible command for the live half. Every assertion is on a DECISION VALUE
# (allow/deny, status, error code) — never on a log line.
#
# Run (from repo root):
#   bash scripts/prove-authority-matrix.sh
#
# Optional env:
#   SERVER_URL   server base WITHOUT /api/v1 (default http://localhost:13000)
#   WORKER_ID    x-worker-id header (default w_compose_worker)
#   TEAM_ID      idle team to drive (default tm_0000000006)
#   EVIDENCE     artifact path (default .omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json)
#
# Side effects: creates ONE real task via task_create, drives it to pending_review, then
# deletes it and its plan/events/messages/queue rows in a scoped cleanup. A session fixture
# row is inserted for the team's main member (idempotent) so the MCP归属 check has a live
# session to bind to. No production source is touched. Re-running is safe.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
WORKER_ID="${WORKER_ID:-w_compose_worker}"
TEAM_ID="${TEAM_ID:-tm_0000000006}"
EVIDENCE="${EVIDENCE:-$REPO_ROOT/.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json}"

log()  { printf '[prove] %s\n' "$*"; }
fail() { printf '[prove] FAIL %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || { printf '[prove] missing command: %s\n' "$1" >&2; exit 2; }; }
need_cmd curl
need_cmd python3
need_cmd docker
need_cmd npx

# ---------------------------------------------------------------- worker token
if [[ -z "${X_WORKER_TOKEN:-}" ]]; then
  if [[ -n "${WORKER_TOKEN:-}" ]]; then
    X_WORKER_TOKEN="$WORKER_TOKEN"
  elif [[ -f "$REPO_ROOT/.env" ]]; then
    X_WORKER_TOKEN="$(grep -E '^WORKER_TOKEN=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
  fi
fi
X_WORKER_TOKEN="${X_WORKER_TOKEN:-compose-worker-token}"

# db_query <sql> : single/multi-value DB query against the compose db (stdout).
db_query() {
  docker exec aiagents-compose-db mysql -uroot -paiagents-root -D aiagents --default-character-set=utf8mb4 -N -e "$1" 2>/dev/null \
    || (cd "$REPO_ROOT" && docker compose exec -T db mysql -uroot -paiagents-root -D aiagents --default-character-set=utf8mb4 -N -e "$1" 2>/dev/null)
}
db_exec() {
  docker exec aiagents-compose-db mysql -uroot -paiagents-root -D aiagents --default-character-set=utf8mb4 -e "$1" 2>/dev/null \
    || (cd "$REPO_ROOT" && docker compose exec -T db mysql -uroot -paiagents-root -D aiagents --default-character-set=utf8mb4 -e "$1" 2>/dev/null)
}

# mcp_call <out-file> <id> <tool> <args-json> : POST tools/call, saves raw body.
mcp_call() {
  local out="$1" id="$2" tool="$3" args="$4"
  local body
  body="$(mktemp)"
  python3 - "$body" "$id" "$tool" "$args" <<'EOF'
import json,sys
out, rid, tool, args = sys.argv[1:5]
json.dump({"jsonrpc":"2.0","id":int(rid),"method":"tools/call",
           "params":{"name":tool,"arguments":json.loads(args)}},
          open(out,"w"), ensure_ascii=False)
EOF
  curl -sS -o "$out" -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H 'Content-Type: application/json' \
    -H "x-worker-id: $WORKER_ID" \
    -H "x-worker-token: $X_WORKER_TOKEN" \
    --data @"$body"
  rm -f "$body"
}

TMP="$(mktemp -d)"
TASK_ID=""
FIX_INSERTED=""
FIX_ID=""
cleanup() {
  if [[ -n "$TASK_ID" ]]; then
    db_exec "UPDATE teams SET current_task_id=NULL WHERE id='${TEAM_ID}';
             DELETE FROM messages WHERE task_id='${TASK_ID}';
             DELETE FROM task_events WHERE task_id='${TASK_ID}';
             DELETE FROM team_queues WHERE task_id='${TASK_ID}';
             DELETE FROM plans WHERE task_id='${TASK_ID}';
             DELETE FROM tasks WHERE id='${TASK_ID}';" >/dev/null 2>&1 || true
  fi
  if [[ -n "$FIX_INSERTED" && -n "$FIX_ID" ]]; then
    db_exec "DELETE FROM sessions WHERE id='${FIX_ID}';" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------- step 1: unit-level proof
log "--- step 1: run the worker-matrix + service-level spec (writes the matrix half) ---"
(cd "$REPO_ROOT/server" && npx jest src/platform-mcp/platform-mcp.authority-matrix.spec.ts --runInBand) \
  || fail "authority-matrix spec failed"
[[ -f "$EVIDENCE" ]] || fail "spec did not write $EVIDENCE"
MATRIX_OK="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); m=d["matrix"]; print("ok" if m["allCellsMatch"] and m["iteratedCellCount"]>0 and m["allowCellCount"]>0 and m["denyCellCount"]>0 else "bad")' "$EVIDENCE")"
[[ "$MATRIX_OK" == "ok" ]] || fail "matrix artifact not discriminating / not all-match"
log "spec matrix: $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["matrix"]; print("%d roles x %d tools = %d cells (%d allow / %d deny), allMatch=%s" % (len(m["roles"]),len(m["tools"]),m["iteratedCellCount"],m["allowCellCount"],m["denyCellCount"],m["allCellsMatch"]))' "$EVIDENCE")"

# ---------------------------------------------------------------- step 2: live preconditions
log "--- step 2: live stack preconditions ---"
HEALTH="$(curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" || true)"
[[ "$HEALTH" == "200" ]] || fail "server not healthy at $SERVER_URL (health=$HEALTH)"

MAIN_MEMBER="$(db_query "SELECT main_agent_member_id FROM teams WHERE id='${TEAM_ID}';" | tr -d '\r\n ')"
[[ -n "$MAIN_MEMBER" && "$MAIN_MEMBER" != "NULL" ]] || fail "team ${TEAM_ID} has no main_agent_member_id"
CURRENT_TASK="$(db_query "SELECT COALESCE(current_task_id,'NULL') FROM teams WHERE id='${TEAM_ID}';" | tr -d '\r\n ')"
[[ "$CURRENT_TASK" == "NULL" ]] || fail "team ${TEAM_ID} is busy (current_task_id=$CURRENT_TASK); pick an idle TEAM_ID"

# Idempotent session fixture: the MCP归属 check needs a live worker session bound to the
# main member. Insert only when absent (id is stable so the cleanup above is scoped).
FIX_ID="s_t9matrix_${TEAM_ID##*_}"
db_exec "INSERT INTO sessions (id, task_id, agent_id, worker_id, status, team_member_id, team_id, updated_at)
         SELECT '${FIX_ID}', NULL, tm.agent_id, '${WORKER_ID}', 'created', tm.id, tm.team_id, NOW(3)
         FROM team_members tm
         WHERE tm.id='${MAIN_MEMBER}'
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.team_id='${TEAM_ID}' AND s.team_member_id='${MAIN_MEMBER}' AND s.worker_id='${WORKER_ID}');" >/dev/null
SESSION_OK="$(db_query "SELECT COUNT(*) FROM sessions WHERE team_id='${TEAM_ID}' AND team_member_id='${MAIN_MEMBER}' AND worker_id='${WORKER_ID}';" | tr -d '\r\n ')"
[[ "$SESSION_OK" != "0" ]] || fail "could not bind a live session for ${MAIN_MEMBER} on ${TEAM_ID}"
FIX_PRESENT="$(db_query "SELECT COUNT(*) FROM sessions WHERE id='${FIX_ID}';" | tr -d '\r\n ')"
if [[ "$FIX_PRESENT" == "1" ]]; then FIX_INSERTED="yes"; fi
log "team=${TEAM_ID} main=${MAIN_MEMBER} worker=${WORKER_ID} session_bound=${SESSION_OK}"

# ---------------------------------------------------------------- step 3: live happy path
log "--- step 3: main-Agent happy path over real HTTP/DB ---"

# 3a. task_create
CREATE_OUT="$TMP/create.json"
mcp_call "$CREATE_OUT" 1 task_create \
  "$(python3 -c 'import json,sys; print(json.dumps({"teamId":sys.argv[1],"selfInstanceId":sys.argv[2],"title":"t9-authority-matrix happy path","description":"todo9 live happy path (auto-deleted by prove-authority-matrix.sh)"}))' "$TEAM_ID" "$MAIN_MEMBER")"
TASK_ID="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if "error" in d: sys.exit("task_create error: %r" % d["error"])
print(json.loads(d["result"]["content"][0]["text"])["id"])' "$CREATE_OUT")"
[[ -n "$TASK_ID" ]] || fail "task_create returned no id"
log "3a task_create -> $TASK_ID"

# plan row is auto-ensured at creation; confirm it exists (draft).
PLAN_ID="$(db_query "SELECT COALESCE(id,'NULL') FROM plans WHERE task_id='${TASK_ID}';" | tr -d '\r\n ')"
[[ "$PLAN_ID" != "NULL" && -n "$PLAN_ID" ]] || fail "no plan row auto-created for $TASK_ID"

# 3b. task_transition start
START_OUT="$TMP/start.json"
mcp_call "$START_OUT" 2 task_transition \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId":sys.argv[1],"selfInstanceId":sys.argv[2],"action":"start"}))' "$TASK_ID" "$MAIN_MEMBER")"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if "error" in d: sys.exit("start error: %r" % d["error"])
assert json.loads(d["result"]["content"][0]["text"])["status"]=="in_progress", d' "$START_OUT" \
  || fail "task_transition start did not reach in_progress"
log "3b task_transition.start -> in_progress"

# 3c. plan_mode (same-value no-op is not enough — assert the returned planMode)
PLANMODE_OUT="$TMP/plan_mode.json"
mcp_call "$PLANMODE_OUT" 3 plan_mode \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId":sys.argv[1],"selfInstanceId":sys.argv[2],"enabled":True}))' "$TASK_ID" "$MAIN_MEMBER")"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if "error" in d: sys.exit("plan_mode error: %r" % d["error"])
b=json.loads(d["result"]["content"][0]["text"])
assert b["planMode"] is True, b' "$PLANMODE_OUT" \
  || fail "plan_mode did not return planMode=true"
log "3c plan_mode -> planMode=true"

# 3d. plan_complete requires the plan row to be 'executing'. Seed that state through the DB
# to isolate the de-gated server path (the plan-status gate for dispatch is a separate todo).
db_exec "UPDATE plans SET status='executing' WHERE task_id='${TASK_ID}';" >/dev/null
PLAN_COMPLETE_OUT="$TMP/plan_complete.json"
mcp_call "$PLAN_COMPLETE_OUT" 4 plan_complete \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId":sys.argv[1],"selfInstanceId":sys.argv[2]}))' "$TASK_ID" "$MAIN_MEMBER")"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if "error" in d: sys.exit("plan_complete error: %r" % d["error"])
b=json.loads(d["result"]["content"][0]["text"])
assert b["status"]=="completed", b' "$PLAN_COMPLETE_OUT" \
  || fail "plan_complete did not reach status=completed"
log "3d plan_complete -> completed"

# 3e. mark-pending-review
PENDING_OUT="$TMP/pending_review.json"
mcp_call "$PENDING_OUT" 5 task_transition \
  "$(python3 -c 'import json,sys; print(json.dumps({"taskId":sys.argv[1],"selfInstanceId":sys.argv[2],"action":"mark-pending-review"}))' "$TASK_ID" "$MAIN_MEMBER")"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if "error" in d: sys.exit("mark-pending-review error: %r" % d["error"])
assert json.loads(d["result"]["content"][0]["text"])["status"]=="pending_review", d' "$PENDING_OUT" \
  || fail "mark-pending-review did not reach pending_review"
DB_STATUS="$(db_query "SELECT status FROM tasks WHERE id='${TASK_ID}';" | tr -d '\r\n ')"
[[ "$DB_STATUS" == "pending_review" ]] || fail "DB truth: task status=$DB_STATUS (want pending_review)"
log "3e mark-pending-review -> pending_review (DB truth=$DB_STATUS)"

# ---------------------------------------------------------------- step 4: merge live half into artifact
log "--- step 4: merge live happy path into $EVIDENCE ---"
python3 - "$EVIDENCE" "$TMP" "$TASK_ID" "$TEAM_ID" "$MAIN_MEMBER" "$WORKER_ID" <<'EOF'
import json, sys
evidence, tmp, task_id, team_id, main_member, worker_id = sys.argv[1:7]
base = json.load(open(evidence))
steps = []
for step, fname in [
    ("task_create", "create.json"),
    ("task_transition.start", "start.json"),
    ("plan_mode", "plan_mode.json"),
    ("plan_complete", "plan_complete.json"),
    ("task_transition.mark-pending-review", "pending_review.json"),
]:
    raw = json.load(open(f"{tmp}/{fname}"))
    result = json.loads(raw["result"]["content"][0]["text"])
    error = raw.get("error")
    steps.append({"step": step, "ok": error is None, "error": error, "result": result})
base["liveHappyPath"] = {
    "requiredSteps": [
        "task_create",
        "task_transition.start",
        "plan_mode",
        "plan_complete",
        "task_transition.mark-pending-review",
    ],
    "taskId": task_id,
    "teamId": team_id,
    "selfInstanceId": main_member,
    "workerId": worker_id,
    "allStepsOk": all(s["ok"] for s in steps),
    "steps": steps,
    "dbTruth": {"taskStatus": "pending_review"},
    "note": "task + plan/events/messages rows deleted by the runner's scoped cleanup after this artifact is written",
}
json.dump(base, open(evidence, "w"), ensure_ascii=False, indent=2)
open(evidence, "a").write("\n")
print("live happy path merged: %d steps allOk=%s" % (len(steps), base["liveHappyPath"]["allStepsOk"]))
EOF

# ---------------------------------------------------------------- step 5: final artifact assertions
log "--- step 5: assert the artifact is a complete, discriminating proof ---"
python3 - "$EVIDENCE" <<'EOF' || fail "artifact assertion failed"
import json, sys
d = json.load(open(sys.argv[1]))
m = d["matrix"]
assert m["iteratedCellCount"] == m["expectedCellCount"] > 0, "matrix not complete"
assert m["allCellsMatch"] is True, "matrix has mismatches"
assert m["allowCellCount"] > 0 and m["denyCellCount"] > 0, "matrix not discriminating (needs negative cells)"
assert d["liveHappyPath"]["allStepsOk"] is True, "live happy path not fully green"
assert [s["step"] for s in d["liveHappyPath"]["steps"]] == d["liveHappyPath"]["requiredSteps"], "happy-path steps missing"
print("ARTIFACT OK: %d cells (%d allow / %d deny), live happy path %d/%d steps" % (
    m["iteratedCellCount"], m["allowCellCount"], m["denyCellCount"],
    sum(1 for s in d["liveHappyPath"]["steps"] if s["ok"]), len(d["liveHappyPath"]["steps"])))
EOF

printf '[prove] PASS authority matrix proof (artifact: %s)\n' "$EVIDENCE"
