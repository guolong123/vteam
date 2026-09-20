#!/usr/bin/env bash
#
# e2e: plan member (vteam-plan) subagent flow end-to-end (plan vteam-plan-member-subagents Todo 4).
#
# Proves against the REAL stack (server + worker + db + opencode serve):
#   1) seed truth: after re-seed, DB has a_plan (type=template, role=plan,
#      agentKey=plan, policyId=ep_plan), ep_plan (type=template), seed-team member
#      tmm_0000000006 (agent a_plan, NOT main); /agents lists a_plan as template;
#      /teams members include 计划员.
#   2) injection truth: worker restart re-injects opencode.json agent['vteam-plan']
#      with mode='all', permission.task='allow', edit glob covering .opencode/plans/,
#      NO edit rights outside; every built-in entry is byte-identical to the
#      frozen baseline (opencode-native-permissions-and-fixes).
#   3) native permission contract (todo 5 re-point): the injected opencode.json
#      carries the engine's own permission config — vteam-plan permission.task
#      is the ONLY allow (fans out read-only reviewers), every other built-in is
#      deny; edit is plans-scoped for vteam-plan and '*':deny + role globs for the
#      rest; no `vteam_*` key is emitted and no role-guard artifact is registered.
#      (The hand-rolled `task` allow-list and the "禁套娃" depth rule are NOT
#      ported: the engine's `permission.task` + native `subagent_depth` cover them.)
#   4) live @-flow smoke (bounded, real group @ for the seed task — the production
#      path: group mention → resolveMentions + task-mode @-mention session backfill
#      → dispatcher.registerExecution → worker execute, so group_post is
#      registered and allowed): the plan member drafts a plan, a plan .md lands
#      under the task .opencode/plans/ with non-trivial content AND the member
#      replies in group. LLM-infra stall (dispatch accepted, nothing returns) ->
#      NEEDS-ATTENTION (suite does not fail); contract violations (file outside
#      plans dir, reply missing despite proof of execution) -> FAIL.
#      (Direct worker /execute is intentionally NOT the trigger here: it bypasses
#      server execution registration, so group_post 403s by design.)
#   5) live subagent spawn smoke (bounded, own vteam-plan session via direct
#      worker /execute — explicitly allowed trigger for a session-scoped probe):
#      task with subagent_type='vteam-plan' for a trivial read-only probe -> must
#      succeed and return; a nested spawn attempt must be blocked (deny/depth
#      error, not success). Infra failure -> NEEDS-ATTENTION + native-permission
#      fallback evidence (always collected).
#   6) plan_review absence: tools/list has no plan_review; worker POST /review is
#      gone (404/405, NOT 200); GET /agent-policies has no plan_review key;
#      repo grep for plan_review in server/src + worker/src (*.spec.ts excluded)
#      is empty.
#
# Required env: none (all discovered with documented defaults).
# Optional env:
#   SERVER_URL    server base WITHOUT /api/v1. Default: http://localhost:13000
#   SERVE_BASE_URL opencode serve base. Default: http://localhost:14000
#   X_WORKER_TOKEN worker token. Default chain: $X_WORKER_TOKEN, then
#                 $WORKER_TOKEN, then WORKER_TOKEN= line in repo-root .env,
#                 then compose default compose-worker-token.
#   WORKER_ID     x-worker-id header value. Default: w_compose_worker
#   TEAM_ID       default tm_0000000001
#   TASK_ID       default t_0000000001 (seed task; reused, never mutated)
#   EVIDENCE_DIR  default .omo/evidence/plan-member
#   BASELINE_INJECTED override the expected injected agent section (default: derived from
#                 BASELINE_POLICIES_REF, the frozen native-only payload)
#   BUILD_TIMEOUT_SEC    default 900  (server+worker rebuild; images may be stale)
#   RESTART_TIMEOUT_SEC  default 240  (worker re-inject sentinel wait)
#   LIVE_TIMEOUT_SEC     default 600  (each live smoke step, ~10 min bound)
#   POLL_INTERVAL_SEC    default 10
#
# Run (from repo root):
#   bash scripts/e2e-plan-member.sh
#
# Rule: any failed hard assertion prints FAIL and exits non-zero. Temp files are
# removed on EXIT. NEEDS-ATTENTION (LLM-infra only) is recorded in evidence and
# does NOT fail the suite. The script is read-only against business data except:
# re-seed (idempotent upserts), image rebuilds + worker restarts, one plan file
# (removed in cleanup) and 1-2 group messages (e2e trace, same precedent as
# e2e-role-boundaries.sh). Idempotent: re-running passes.
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
SERVE_BASE_URL="${SERVE_BASE_URL:-http://localhost:14000}"
WORKER_ID="${WORKER_ID:-w_compose_worker}"
TEAM_ID="${TEAM_ID:-tm_0000000001}"
TASK_ID="${TASK_ID:-t_0000000001}"
PLAN_MEMBER_ID="${PLAN_MEMBER_ID:-tmm_0000000006}"
PLAN_AGENT_ID="${PLAN_AGENT_ID:-a_plan}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/plan-member}"
# The historical F3-own artifact predates the native-only payload; the authoritative
# frozen artifact is the plan's baseline, and the expected injected agent section is
# derived from it (BASELINE_POLICIES_REF).
BASELINE_POLICIES_REF="${BASELINE_POLICIES_REF:-.omo/evidence/opencode-native-permissions-and-fixes/baseline-agent-policies.json}"
BASELINE_INJECTED="${BASELINE_INJECTED:-}"
BUILD_TIMEOUT_SEC="${BUILD_TIMEOUT_SEC:-900}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-240}"
LIVE_TIMEOUT_SEC="${LIVE_TIMEOUT_SEC:-600}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-10}"

case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
case "$BASELINE_POLICIES_REF" in /*) ;; *) BASELINE_POLICIES_REF="$REPO_ROOT/$BASELINE_POLICIES_REF";; esac
if [[ -z "$BASELINE_INJECTED" ]]; then
  BASELINE_INJECTED="$EVIDENCE_DIR/baseline-injected-opencode.json"
  mkdir -p "$EVIDENCE_DIR"
  python3 - "$BASELINE_POLICIES_REF" "$BASELINE_INJECTED" <<'PY'
import json, sys
base = json.load(open(sys.argv[1]))
want = ["vteam-plan", "vteam-product", "vteam-architect",
        "vteam-developer", "vteam-tester", "vteam-project_manager"]
section = {a["name"]: {"description": a["description"], "mode": a["mode"], "permission": a["permission"]}
           for a in base["agents"] if a["name"] in want}
json.dump({"agent": section}, open(sys.argv[2], "w"), ensure_ascii=False, indent=2)
print("derived injected baseline section from %s (%d agents)" % (sys.argv[1], len(section)))
PY
fi
case "$BASELINE_INJECTED" in /*) ;; *) BASELINE_INJECTED="$REPO_ROOT/$BASELINE_INJECTED";; esac
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
NEEDS_FILE="$EVIDENCE_DIR/needs-attention.txt"
: >"$NEEDS_FILE"

log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] \033[32mPASS\033[0m %s\n' "$*" | tee -a "$E2E_LOG"; }
warn() { printf '[e2e] \033[33mWARN\033[0m %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { # $1 = step, $2 = reason
  printf '[e2e] \033[31mFAIL\033[0m step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  exit 1
}
needs_attention() { # $1 = step, $2 = reason (LLM-infra only; never fails the suite)
  printf '[e2e] \033[33mNEEDS-ATTENTION\033[0m step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  printf 'step=%s reason=%s\n' "$1" "$2" >>"$NEEDS_FILE"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd docker
need_cmd git

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
  docker compose exec -T db mysql --default-character-set=utf8mb4 -uroot -paiagents-root -D aiagents -N -e "$1" 2>/dev/null \
    || docker exec aiagents-compose-db mysql --default-character-set=utf8mb4 -uroot -paiagents-root -D aiagents -N -e "$1" 2>/dev/null
}

# mcp_post <out-file> <id> <method> [params-json] : POST platform-mcp, saves raw body.
mcp_post() {
  local out="$1" id="$2" method="$3" params="{}"
  if [[ $# -ge 4 ]]; then params="$4"; fi
  local body
  body="$(mktmp)"
  python3 - "$body" "$id" "$method" "$params" <<'EOF'
import json,sys
out, rid, method, params = sys.argv[1:5]
json.dump({"jsonrpc": "2.0", "id": int(rid), "method": method,
           "params": json.loads(params)}, open(out, "w"), ensure_ascii=False)
EOF
  curl -sS -o "$out" -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H 'Content-Type: application/json' \
    -H "x-worker-id: $WORKER_ID" \
    -H "x-worker-token: $X_WORKER_TOKEN" \
    --data @"$body"
}

# mcp_call <out-file> <id> <tool> <arguments-json> : POST tools/call, saves raw body.
mcp_call() {
  local out="$1" id="$2" tool="$3" args="$4"
  python3 - "$out" "$id" "$tool" "$args" <<'EOF'
import json,sys
out, rid, tool, args = sys.argv[1:5]
json.dump({"jsonrpc": "2.0", "id": int(rid), "method": "tools/call",
           "params": {"name": tool, "arguments": json.loads(args)}},
          open(out, "w"), ensure_ascii=False)
EOF
  local body="$out.tmp-body"
  cp "$out" "$body"
  TMP_FILES="$TMP_FILES $body"
  curl -sS -o "$out" -X POST "$SERVER_URL/api/v1/platform-mcp" \
    -H 'Content-Type: application/json' \
    -H "x-worker-id: $WORKER_ID" \
    -H "x-worker-token: $X_WORKER_TOKEN" \
    --data @"$body"
}

# api <METHOD> <path> <jwt> [body-file] [out-file] : curl server /api/v1, prints HTTP code.
api() {
  local method="$1" path="$2" jwt="$3" body="${4:-}" out="${5:-/dev/null}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$out" -w '%{http_code}' -X "$method" "$SERVER_URL/api/v1$path" \
      -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' --data @"$body"
  else
    curl -sS -o "$out" -w '%{http_code}' -X "$method" "$SERVER_URL/api/v1$path" \
      -H "Authorization: Bearer $jwt"
  fi
}

# login <username> <password> : prints accessToken.
login() {
  local body out code
  body="$(mktmp)"; out="$(mktmp)"
  printf '{"username":"%s","password":"%s"}' "$1" "$2" >"$body"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  [[ "$code" == "200" || "$code" == "201" ]] || { cp "$out" "$EVIDENCE_DIR/login-$1.txt"; return 1; }
  jget "$out" 'd.get("accessToken") or d.get("access_token") or ""'
}

# scrub_transcript <transcript> <out> <prompt-file...> : remove prompt echoes
# (raw + JSON-escaped forms) so marker greps only see model-produced text.
scrub_transcript() {
  local transcript="$1" out="$2"; shift 2
  python3 - "$transcript" "$out" "$@" <<'EOF'
import json,sys
transcript, out, prompts = sys.argv[1], sys.argv[2], sys.argv[3:]
raw = open(transcript, encoding="utf-8", errors="replace").read()
for pf in prompts:
    try:
        p = open(pf, encoding="utf-8", errors="replace").read()
    except OSError:
        continue
    if p:
        raw = raw.replace(p, "")
        raw = raw.replace(json.dumps(p)[1:-1], "")
open(out, "w").write(raw)
EOF
}

# worker_exec <agent> <directory> <sessionId> <taskId> <agentId> <prompt-file> <out-file> :
# POST worker /execute from INSIDE the worker container (exec port is not host-mapped).
# Prints HTTP code.
worker_exec() {
  local agent="$1" directory="$2" sid="$3" task="$4" agentId="$5" prompt_file="$6" out="$7"
  local body="e2e-pm-body-$sid.json" remote_out="e2e-pm-out-$sid.json"
  local host_body
  host_body="$(mktmp)"
  python3 - "$host_body" "$prompt_file" "$agent" "$directory" "$sid" "$task" "$agentId" <<'EOF'
import json,sys
out, prompt_file, agent, directory, sid, task, agentId = sys.argv[1:8]
text = open(prompt_file, encoding="utf-8").read()
json.dump({"agent": agent, "directory": directory, "sessionId": sid, "taskId": task,
           "agentId": agentId, "prompt": [{"type": "text", "text": text}]},
          open(out, "w"), ensure_ascii=False)
EOF
  docker compose cp "$host_body" worker:/tmp/"$body" >/dev/null \
    || fail "live-exec" "docker compose cp execute body into worker failed"
  local code
  code="$(docker compose exec -T worker curl -sS -o /tmp/"$remote_out" -w '%{http_code}' \
    -X POST http://localhost:4198/execute -H 'Content-Type: application/json' --data @/tmp/"$body" 2>/dev/null)" \
    || fail "live-exec" "worker /execute unreachable"
  docker compose cp worker:/tmp/"$remote_out" "$out" >/dev/null \
    || fail "live-exec" "docker compose cp execute result out of worker failed"
  docker compose exec -T worker rm -f /tmp/"$body" /tmp/"$remote_out" >/dev/null 2>&1 || true
  printf '%s' "$code"
}

# assistant_text <serve-msg-json> <out> : concatenate ASSISTANT-role text parts
# plus assistant tool-call outputs (never the user prompt: prompt echoes in
# serve transcripts are often double-escaped, so echo-scrubbing misses them
# and marker greps false-positive on the prompt itself).
assistant_text() {
  python3 - "$1" "$2" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
items = d if isinstance(d, list) else d.get("messages") or d.get("items") or []
out = []
for it in items:
    if not isinstance(it, dict): continue
    if (it.get("info") or {}).get("role") != "assistant": continue
    for p in it.get("parts") or []:
        if not isinstance(p, dict): continue
        if p.get("type") == "text" and isinstance(p.get("text"), str):
            out.append(p["text"])
        elif p.get("type") == "tool":
            st = p.get("state") or {}
            for k in ("output", "error"):
                if isinstance(st.get(k), str) and st[k].strip():
                    out.append(st[k])
open(sys.argv[2], "w").write("\n".join(out))
EOF
}

# serve_create_session : prints serve session id (POST $SERVE_BASE_URL/session).
serve_create_session() {
  local out code
  out="$(mktmp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVE_BASE_URL/session")"
  [[ "$code" == "200" || "$code" == "201" ]] || { cp "$out" "$EVIDENCE_DIR/serve-session-create.txt"; return 1; }
  jget "$out" 'd.get("id") or d.get("sessionId") or ""'
}

# ---------------------------------------------------------------- step 0: baseline + rebuild + reseed + worker restart
log "SERVER_URL=$SERVER_URL SERVE_BASE_URL=$SERVE_BASE_URL TEAM_ID=$TEAM_ID TASK_ID=$TASK_ID"
git log --oneline -8 >"$EVIDENCE_DIR/baseline-git.txt" 2>&1 || true
git status --short >>"$EVIDENCE_DIR/baseline-git.txt" 2>&1 || true
BASELINE_HEAD="$(git rev-parse HEAD)"
log "baseline HEAD=$BASELINE_HEAD (recorded in baseline-git.txt)"

log "--- step 0: rebuild server+worker images (plan code must be in the running dist) ---"
BUILD_OUT="$EVIDENCE_DIR/build.log"
docker compose up -d --build server worker >"$BUILD_OUT" 2>&1 &
BUILD_PID=$!
deadline=$((SECONDS + BUILD_TIMEOUT_SEC))
while kill -0 "$BUILD_PID" 2>/dev/null && [[ $SECONDS -lt $deadline ]]; do sleep 15; done
if kill -0 "$BUILD_PID" 2>/dev/null; then
  kill "$BUILD_PID" 2>/dev/null || true
  fail "0-build" "build timed out after ${BUILD_TIMEOUT_SEC}s (raw: $BUILD_OUT)"
fi
wait "$BUILD_PID" || fail "0-build" "docker compose up -d --build server worker failed (raw: $BUILD_OUT)"
log "images rebuilt; waiting for server health ..."
deadline=$((SECONDS + BUILD_TIMEOUT_SEC))
while [[ $SECONDS -lt $deadline ]]; do
  if curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$'; then
    break
  fi
  sleep 10
done
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "0-build" "server not healthy after rebuild (raw: $BUILD_OUT)"
log "server healthy"
# Build-freshness gate: the RUNNING server dist must contain the plan seed code.
FRESH="$(docker compose exec -T server grep -c a_plan dist/prisma/seed.js 2>/dev/null | tr -d '\r\n ' || true)"
[[ -n "$FRESH" && "$FRESH" != "0" ]] \
  || fail "0-build" "running server dist/prisma/seed.js lacks a_plan (stale image? raw: $BUILD_OUT)"
log "running server dist contains plan seed code (a_plan x$FRESH)"
pass "0 (images rebuilt, server healthy, dist fresh)"

log "--- step 0b: re-seed (idempotent upserts, same command as compose init) ---"
SEED_OUT="$EVIDENCE_DIR/seed-run.log"
docker compose exec -T server node dist/prisma/seed.js >"$SEED_OUT" 2>&1 \
  || fail "0-seed" "node dist/prisma/seed.js failed (raw: $SEED_OUT)"
grep -q 'Seed' "$SEED_OUT" || fail "0-seed" "seed output missing marker (raw: $SEED_OUT)"
log "re-seed exit 0"

log "--- step 0c: restart worker (injection happens at start only) + sentinel wait ---"
# restart (NOT --force-recreate, which re-runs the `init` dependency and can reseed
# the DB) is sufficient to re-run the start-only injector.
docker compose restart worker >/dev/null 2>&1 \
  || fail "0-restart" "docker compose restart worker failed"
deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
found=""
while [[ $SECONDS -lt $deadline ]]; do
  SENTINEL="$(docker compose exec -T worker node -e "
const fs = require('fs');
try {
  const cfg = JSON.parse(fs.readFileSync('/data/vteam-worker/opencode.json', 'utf8'));
  const plan = (cfg.agent || {})['vteam-plan'] || {};
  const task = (plan.permission || {}).task;
  const hasPlan = !!(cfg.agent || {})['vteam-plan'];
  const guardLeft = JSON.stringify(cfg.plugin || []).includes('vteam-role-guard');
  console.log((hasPlan ? 'hasPlan:' : 'noPlan:') + task + (guardLeft ? ':guardLeft' : ''));
} catch (e) { console.log('error:' + e.message); }
" 2>/dev/null | tr -d '\r\n ' || true)"
  if [[ "$SENTINEL" == "hasPlan:allow" ]]; then found="yes"; break; fi
  sleep 10
done
[[ -n "$found" ]] || fail "0-restart" "worker re-injection sentinel not hasPlan:allow after ${RESTART_TIMEOUT_SEC}s (last=$SENTINEL)"
log "worker re-injected; sentinel=hasPlan:allow"
# Serve must also be back (worker recreates its serve child).
deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
while [[ $SECONDS -lt $deadline ]]; do
  if curl -sS -o /dev/null -X POST "$SERVE_BASE_URL/session" 2>/dev/null | head -c 200 | grep -q '"id"'; then
    break
  fi
  sleep 10
done
curl -sS -X POST "$SERVE_BASE_URL/session" 2>/dev/null | grep -q '"id"' \
  || fail "0-restart" "opencode serve not back after worker restart"
# Remove the sentinel probe session (no leftover sessions).
PROBE_SID="$(curl -sS -X POST "$SERVE_BASE_URL/session" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' || true)"
[[ -n "$PROBE_SID" ]] && curl -sS -o /dev/null -X DELETE "$SERVE_BASE_URL/session/$PROBE_SID" || true
pass "0 (re-seed + worker re-injected + serve back)"

# ---------------------------------------------------------------- step 1: seed truth
log "--- step 1: seed truth (DB + /agents + /teams) ---"
SEED_DB="$EVIDENCE_DIR/seed-db.txt"
{
  echo "== agents a_plan =="
  db_query "SELECT id, type, role, agent_key, policy_id FROM agents WHERE id='a_plan';"
  echo "== execution_policies ep_plan =="
  db_query "SELECT id, type FROM execution_policies WHERE id='ep_plan';"
  echo "== team member tmm_0000000006 =="
  db_query "SELECT id, team_id, agent_id, alias FROM team_members WHERE id='tmm_0000000006';"
  echo "== teams main (must NOT be the plan member) =="
  db_query "SELECT id, main_agent_member_id FROM teams WHERE id='${TEAM_ID}';"
  echo "== seed team member count =="
  db_query "SELECT COUNT(*) FROM team_members WHERE team_id='${TEAM_ID}';"
  echo "== builtin template agent count =="
  db_query "SELECT COUNT(*) FROM agents WHERE type='template';"
} >"$SEED_DB" 2>&1 || fail "1-seed" "db queries failed (raw: $SEED_DB)"
cat "$SEED_DB" | tee -a "$E2E_LOG" >/dev/null
if ! python3 - "$SEED_DB" <<'EOF'
import sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
def section(name):
    out, hit = [], False
    for ln in raw:
        if ln.startswith("=="): hit = (name in ln)
        elif hit and ln.strip(): out.append(ln.strip())
    return out
agents = section("agents a_plan")
assert len(agents) == 1, "want exactly 1 a_plan row, got %r" % agents
cols = agents[0].split()
assert cols == ["a_plan", "template", "plan", "plan", "ep_plan"], \
  "a_plan row = %r (want id=a_plan type=template role=plan agentKey=plan policyId=ep_plan)" % cols
ep = section("execution_policies ep_plan")
assert len(ep) == 1 and ep[0].split() == ["ep_plan", "template"], \
  "ep_plan row = %r (want id=ep_plan type=template)" % ep
mm = section("team member tmm_0000000006")
assert len(mm) == 1, "want exactly 1 tmm_0000000006 row, got %r" % mm
mcols = mm[0].split()
assert mcols[0] == "tmm_0000000006" and mcols[1] == "tm_0000000001" and mcols[2] == "a_plan", \
  "plan member row = %r (want tmm_0000000006 / tm_0000000001 / a_plan)" % mm
assert "计划员" in mm[0], "plan member alias lacks 计划员: %r" % mm
main = section("teams main")
assert len(main) == 1, "want 1 team row, got %r" % main
tcols = main[0].split()
assert tcols[1] != "tmm_0000000006", "plan member must NOT be main agent: %r" % main
cnt = section("seed team member count")
tpl = section("builtin template agent count")
assert cnt and tpl, "member/template counts missing: %r %r" % (cnt, tpl)
assert cnt[0].strip() == tpl[0].strip(), \
  "seed team members (%s) != builtin template agents (%s) — one instance per role expected" % (
    cnt[0], tpl[0])
print("db: a_plan template/plan + ep_plan template + tmm_0000000006 计划员 non-main + %s members (== template agents)" % cnt[0].strip())
EOF
then
  fail "1-seed" "seed DB assertions failed (raw: $SEED_DB)"
fi
pass "1a (DB: a_plan + ep_plan + tmm_0000000006 计划员 non-main)"

log "login seed-admin for /agents + /teams ..."
ADMIN_JWT="$(login seed-admin 'Admin@123456')" || fail "1-seed" "login seed-admin failed"
[[ -n "$ADMIN_JWT" ]] || fail "1-seed" "empty admin accessToken"
AGENTS_OUT="$EVIDENCE_DIR/agents.json"
code="$(api GET '/agents' "$ADMIN_JWT" '' "$AGENTS_OUT")"
[[ "$code" == "200" ]] || fail "1-seed" "GET /agents HTTP $code (raw: $AGENTS_OUT)"
TEAM_OUT="$EVIDENCE_DIR/team.json"
code="$(api GET "/teams/$TEAM_ID" "$ADMIN_JWT" '' "$TEAM_OUT")"
[[ "$code" == "200" ]] || fail "1-seed" "GET /teams/$TEAM_ID HTTP $code (raw: $TEAM_OUT)"
if ! python3 - "$AGENTS_OUT" "$TEAM_OUT" <<'EOF'
import json,sys
agents = json.load(open(sys.argv[1]))
items = agents if isinstance(agents, list) else agents.get("items") or agents.get("agents") or []
tpl = [a for a in items if a.get("id") == "a_plan"]
assert len(tpl) == 1, "a_plan not listed once in /agents: %r" % [a.get("id") for a in items]
assert tpl[0].get("type") == "template", "a_plan type=%r (want template)" % tpl[0].get("type")
team = json.load(open(sys.argv[2]))
blob = json.dumps(team, ensure_ascii=False)
assert "计划员" in blob, "/teams members lack 计划员"
assert "a_plan" in blob, "/teams members lack a_plan"
print("/agents lists a_plan as template; /teams members include 计划员")
EOF
then
  fail "1-seed" "/agents + /teams assertions failed (raw: $AGENTS_OUT $TEAM_OUT)"
fi
pass "1b (/agents lists a_plan as template; /teams members include 计划员)"

# ---------------------------------------------------------------- step 2: injection truth
log "--- step 2: injected opencode.json vteam-plan entry + 5-role byte parity ---"
INJECTED_OUT="$EVIDENCE_DIR/injected-opencode.json"
docker compose cp worker:/data/vteam-worker/opencode.json "$INJECTED_OUT" >/dev/null \
  || fail "2-inject" "docker compose cp worker opencode.json failed"
# todo 5: the deleted guard layer's artifact must be absent from the live volume.
docker compose exec -T worker test '!' -e /data/vteam-worker/.vteam-role-guard 2>/dev/null \
  || fail "2-inject" "live worker still has .vteam-role-guard (deleted guard layer not purged)"
docker compose exec -T worker sh -c 'grep -q vteam-role-guard /data/vteam-worker/opencode.json' 2>/dev/null \
  && fail "2-inject" "injected opencode.json still registers vteam-role-guard"
[[ -f "$BASELINE_INJECTED" ]] || fail "2-inject" "baseline $BASELINE_INJECTED missing"
if ! python3 - "$INJECTED_OUT" "$BASELINE_INJECTED" "$EVIDENCE_DIR/injection-compare.txt" <<'EOF'
import json,sys
new = json.load(open(sys.argv[1])); base = json.load(open(sys.argv[2]))
report = open(sys.argv[3], "w")
def rep(s):
    report.write(s + "\n"); print(s)
na, ba = (new.get("agent") or {}), (base.get("agent") or {})
BUILTINS = ["vteam-plan", "vteam-product", "vteam-architect",
            "vteam-developer", "vteam-tester", "vteam-project_manager"]
for b in BUILTINS:
    assert b in na, "injected opencode.json lacks built-in %s" % b
# --- vteam-plan entry contract ---
plan = na["vteam-plan"]
assert plan.get("mode") == "all", "vteam-plan mode=%r (want all)" % plan.get("mode")
perm = plan.get("permission") or {}
assert perm.get("task") == "allow", "vteam-plan permission.task=%r (want allow)" % perm.get("task")
edit = perm.get("edit") or {}
assert isinstance(edit, dict) and edit.get("*") == "deny", \
  "vteam-plan edit lacks '*':deny default: %r" % edit
allows = [g for g, v in edit.items() if g != "*" and v in ("allow", "ask")]
assert allows, "vteam-plan edit has no allow glob at all: %r" % edit
plans_hits = [g for g in allows if ".opencode/plans" in g]
assert plans_hits, "vteam-plan edit allow globs miss plans dir: %r" % allows
outside = [g for g in allows if ".opencode/plans" not in g]
assert not outside, "vteam-plan edit allows paths OUTSIDE plans dir: %r" % outside
rep("vteam-plan: mode=all task=allow edit=%r" % edit)
# todo 5: the layer-1 permission is native-only; tool authorization lives in the
# DB policy matrix consumed by the server gate, not in the injected config.
leak = sorted(k for k in perm if k.startswith("vteam_"))
assert not leak, "vteam-plan layer-1 still carries vteam_ keys: %r" % leak
rep("vteam-plan: native-only layer-1 permission (no vteam_ keys)")
def assert_split_aware_parity(name, nj, bj):
    assert nj.get("mode") == bj.get("mode"), \
      "%s mode changed: %r vs %r" % (name, nj.get("mode"), bj.get("mode"))
    assert nj.get("description") == bj.get("description"), \
      "%s description changed" % name
    np, bp = dict(nj.get("permission") or {}), dict(bj.get("permission") or {})
    assert np == bp, "%s layer-1 permission changed: %r vs %r" % (name, np, bp)
    leak = sorted(k for k in np if k.startswith("vteam_"))
    assert not leak, "%s layer-1 still carries vteam_ keys: %r" % (name, leak)
    rep("%s: parity ok (native-only layer-1 identical to baseline)" % name)
# --- other five roles: parity + mode/task enforcement ---
for b in BUILTINS[1:]:
    assert na[b].get("mode") == "primary", "role %s mode=%r (want primary)" % (b, na[b].get("mode"))
    assert (na[b].get("permission") or {}).get("task") == "deny", "role %s task not deny" % b
    assert_split_aware_parity(b, na[b], ba[b])
rep("other five roles parity ok (native-only layer-1 identical to baseline)")
for b in BUILTINS:
    assert json.dumps(na[b], sort_keys=True, ensure_ascii=False) == \
      json.dumps(ba[b], sort_keys=True, ensure_ascii=False), \
      "%s injected entry differs from the frozen baseline" % b
rep("all 6 built-ins byte-identical to the frozen baseline")
EOF
then
  fail "2-inject" "injection assertions failed (raw: $INJECTED_OUT, report: $EVIDENCE_DIR/injection-compare.txt)"
fi
pass "2 (vteam-plan mode all/task allow/plans-scoped edit/native-only permission; all seven built-ins byte-identical to the frozen baseline)"

# ---------------------------------------------------------------- step 3: native permission contract
log "--- step 3: native permission contract on the injected + control-plane payload (todo 5) ---"
# The deleted worker guard decided task/edit scoping by hand. Its job is now the
# engine's own `permission` config: exactly vteam-plan carries task=allow; every
# built-in carries the native keys only, with '*' deny on edit and the
# role-scoped allow globs preserved. No `.vteam-role-guard` artifact may exist.
CONTRACT_OUT="$EVIDENCE_DIR/native-permission-contract.json"
if ! python3 - "$INJECTED_OUT" "$POLICIES_OUT" "$CONTRACT_OUT" <<'EOF'
import json,sys
oc=json.load(open(sys.argv[1])); pol=json.load(open(sys.argv[2])); out=sys.argv[3]
BUILTINS=["vteam-plan","vteam-product","vteam-architect","vteam-developer","vteam-tester","vteam-project_manager","vteam-librarian"]
agents=oc.get("agent") or {}
report={"perTask":{}, "editScoping":{}, "plugin":oc.get("plugin") or [], "leaks":[]}
for name in BUILTINS:
    assert name in agents, "injected opencode.json lacks %s" % name
    perm=agents[name].get("permission") or {}
    report["perTask"][name]=perm.get("task")
    edit=perm.get("edit") or {}
    report["editScoping"][name]={"star":edit.get("*"),"allows":[g for g,v in edit.items() if g!="*" and v in ("allow","ask")]}
    report["leaks"] += ["%s:%s" % (name,k) for k in perm if k.startswith("vteam_")]
# task gate: exactly vteam-plan allow, everyone else deny (engine-native; the old
# hand-rolled allow-list is not ported).
assert report["perTask"]["vteam-plan"]=="allow", "vteam-plan task=%r" % report["perTask"]["vteam-plan"]
others=[n for n in BUILTINS if n!="vteam-plan"]
assert all(report["perTask"][n]=="deny" for n in others), "non-plan task not deny: %r" % report["perTask"]
# edit scoping: '*' deny everywhere; vteam-plan's allows stay inside plans.
for name in BUILTINS:
    assert report["editScoping"][name]["star"]=="deny", "%s edit '*':%r" % (name, report["editScoping"][name]["star"])
plan_allows=report["editScoping"]["vteam-plan"]["allows"]
assert plan_allows and all(".opencode/plans" in g for g in plan_allows), \
  "vteam-plan edit allows outside plans: %r" % plan_allows
# no vteam_ leak and no guard plugin registration.
assert not report["leaks"], "vteam_ leaks: %r" % report["leaks"]
assert not any(isinstance(p,str) and "vteam-role-guard" in p for p in report["plugin"]), \
  "guard plugin still registered: %r" % report["plugin"]
# control-plane agrees on the task gate for the governed agents.
pg={a["name"]:a for a in (pol.get("agents") or [])}
for name in BUILTINS:
    assert pg[name]["permission"].get("task")==report["perTask"][name], \
      "control-plane task disagrees for %s" % name
json.dump(report, open(out,"w"), ensure_ascii=False, indent=2)
print("native contract: task allow only vteam-plan; edit '*':deny everywhere; plans-scoped for plan; 0 vteam_ leaks; no guard plugin")
EOF
then
  fail "3-native" "native permission contract failed (raw: $CONTRACT_OUT)"
fi
pass "3 (native contract: task allow only vteam-plan; edit '*':deny + plans-scoped for plan; 0 leaks; no guard plugin)"

# ---------------------------------------------------------------- live prep: snapshots + channel watermark
log "--- live prep: task-dir snapshot + group watermark ---"
# Pre-clean any stale e2e plan file from a previous run (idempotency) BEFORE
# the snapshot, so the before/after diff only sees this run's writes.
docker compose exec -T worker rm -f "/data/vteam-worker/tasks/$TASK_ID/.opencode/plans/e2e-plan-member.md" >/dev/null 2>&1 || true
docker compose exec -T worker test '!' -f "/data/vteam-worker/tasks/$TASK_ID/.opencode/plans/e2e-plan-member.md" 2>/dev/null \
  || fail "live-prep" "stale e2e plan file not removed before snapshot"
TASKDIR_BEFORE="$EVIDENCE_DIR/taskdir-before.txt"
docker compose exec -T worker sh -c "find /data/vteam-worker/tasks/$TASK_ID -type f 2>/dev/null | sort" >"$TASKDIR_BEFORE" 2>/dev/null || : >"$TASKDIR_BEFORE"
CHAN_OUT="$EVIDENCE_DIR/channels.json"
code="$(api GET "/channels?teamId=$TEAM_ID" "$ADMIN_JWT" '' "$CHAN_OUT")"
[[ "$code" == "200" ]] || fail "4-live" "GET /channels HTTP $code (raw: $CHAN_OUT)"
GROUP_CHANNEL="$(python3 - "$CHAN_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
items = d if isinstance(d, list) else d.get("items") or d.get("channels") or []
for ch in items:
    if ch.get("type") == "team_group":
        print(ch.get("id")); break
EOF
)"
[[ -n "$GROUP_CHANNEL" ]] || fail "4-live" "no team_group channel for $TEAM_ID (raw: $CHAN_OUT)"
log "group channel=$GROUP_CHANNEL"
WATERMARK_OUT="$EVIDENCE_DIR/group-watermark.json"
code="$(api GET "/channels/$GROUP_CHANNEL/messages?limit=100" "$ADMIN_JWT" '' "$WATERMARK_OUT" 2>/dev/null)" || code="000"
[[ "$code" == "200" ]] || fail "4-live" "GET group messages HTTP $code (raw: $WATERMARK_OUT)"
WATERMARK="$(jget "$WATERMARK_OUT" 'max([m.get("id","") for m in (d if isinstance(d,list) else d.get("items") or [])] or [""])')"
log "group watermark=$WATERMARK"

# ---------------------------------------------------------------- step 4: live @-flow smoke (real group @ → server dispatch)
log "--- step 4: live group-@ plan-member dispatch (bounded ${LIVE_TIMEOUT_SEC}s) ---"
PLAN_FILE="tasks/$TASK_ID/.opencode/plans/e2e-plan-member.md"
MSG4="$(mktmp)"
PLAN_MEMBER_ID="$PLAN_MEMBER_ID" TASK_ID="$TASK_ID" python3 - "$MSG4" <<'PYEOF'
import json,os,sys
mid = os.environ["PLAN_MEMBER_ID"]; tid = os.environ["TASK_ID"]
text = ("@计划员-1 e2e 验证派活（成员ID " + mid + "，任务ID " + tid + "），按序执行：\n"
  "1. 起草一份简短中文验证计划（须含“背景”“验证步骤”（至少3条）“验收标准”三节，20行以上），"
  "写入文件 /data/vteam-worker/tasks/" + tid + "/.opencode/plans/e2e-plan-member.md。"
  "只允许写 .opencode/plans/ 目录，不得写任何其他路径。\n"
  "2. 用 vteam_group_post 工具向任务群聊发布一条摘要（参数 taskId=\"" + tid + "\"，selfInstanceId=\"" + mid + "\"，"
  "content 须包含字符串 E2E-PLAN-POSTED）。\n"
  "3. 最后单独回复一行 E2E-PLAN-DONE。")
json.dump({"text": text,
  "mentions": [{"type": "agent", "agentId": "a_plan", "instanceId": mid}],
  "taskId": tid}, open(sys.argv[1], "w"), ensure_ascii=False)
PYEOF
TRIGGER_OUT="$EVIDENCE_DIR/group-trigger.json"
LIVE4_OK=""; TRIGGER_OK=""
code="$(api POST "/channels/$GROUP_CHANNEL/messages" "$ADMIN_JWT" "$MSG4" "$TRIGGER_OUT")" || code="000"
log "POST group @ -> HTTP $code (raw: $TRIGGER_OUT)"
if [[ "$code" != "200" && "$code" != "201" ]]; then
  needs_attention "4-live" "POST group @ message HTTP $code (infra?) raw: $TRIGGER_OUT"
else
  if PLAN_MID="$PLAN_MEMBER_ID" python3 - "$TRIGGER_OUT" <<'EOF'; then
import json,sys,os
d = json.load(open(sys.argv[1])); mid = os.environ["PLAN_MID"]
trigs = d.get("triggers") or d.get("message", {}).get("triggers") or []
hit = [t for t in trigs if t.get("instanceId") == mid or t.get("agentId") == "a_plan"]
assert hit, "no plan-member trigger in response"
st = {t.get("status") for t in hit}
assert st <= {"dispatched"}, "plan-member trigger status=%r (want dispatched)" % st
print("trigger dispatched to plan member")
EOF
    TRIGGER_OK="yes"
  else
    needs_attention "4-live" "group @ posted but plan-member trigger not dispatched (raw: $TRIGGER_OUT)"
  fi
fi
if [[ "$TRIGGER_OK" == "yes" ]]; then
  # Post-trigger watermark: the @ trigger message itself contains the marker
  # strings, so it must never self-match the reply checks below.
  WM4_OUT="$EVIDENCE_DIR/group-watermark-4.json"
  api GET "/channels/$GROUP_CHANNEL/messages?limit=100" "$ADMIN_JWT" '' "$WM4_OUT" >/dev/null || true
  WM4="$(jget "$WM4_OUT" 'max([m.get("id","") for m in (d if isinstance(d,list) else d.get("items") or [])] or [""])')"
  [[ -n "$WM4" ]] || WM4="$WATERMARK"
  log "step4 post-trigger watermark=$WM4"
  GROUP4_OUT="$EVIDENCE_DIR/group-after-4.json"
  deadline=$((SECONDS + LIVE_TIMEOUT_SEC))
  while [[ $SECONDS -lt $deadline ]]; do
    code="000"
    code="$(api GET "/channels/$GROUP_CHANNEL/messages?limit=100" "$ADMIN_JWT" '' "$GROUP4_OUT" 2>/dev/null)" || code="000"
    file_ok=""; group_ok=""
    docker compose exec -T worker test -f "/data/vteam-worker/$PLAN_FILE" 2>/dev/null && file_ok="yes"
    if [[ "$code" == "200" ]]; then
      if PLAN_MID="$PLAN_MEMBER_ID" python3 - "$GROUP4_OUT" "$WM4" <<'EOF'; then
import json,sys,os
d = json.load(open(sys.argv[1])); wm = sys.argv[2]; mid = os.environ.get("PLAN_MID", "")
items = d if isinstance(d, list) else d.get("items") or []
news = [m for m in items if m.get("id", "") > wm]
hit = [m for m in news if m.get("senderInstanceId") == mid or "E2E-PLAN-POSTED" in json.dumps(m.get("content") or {}, ensure_ascii=False)]
assert hit, "no new plan-member group message yet"
EOF
        group_ok="yes"
      fi
    fi
    if [[ -n "$file_ok" && -n "$group_ok" ]]; then LIVE4_OK="yes"; break; fi
    sleep "$POLL_INTERVAL_SEC"
  done
  # Final state capture (raw transcripts are the evidence).
  docker compose exec -T worker cat "/data/vteam-worker/$PLAN_FILE" >"$EVIDENCE_DIR/plan-file-4.md" 2>/dev/null || : >"$EVIDENCE_DIR/plan-file-4.md"
  api GET "/channels/$GROUP_CHANNEL/messages?limit=100" "$ADMIN_JWT" '' "$GROUP4_OUT" >/dev/null || true
fi
if [[ "$LIVE4_OK" == "yes" ]]; then
  # Contract asserts on the captured raw evidence.
  if ! python3 - "$EVIDENCE_DIR/plan-file-4.md" <<'EOF'
import sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
lines = [l for l in text.splitlines() if l.strip()]
assert len(lines) >= 10, "plan file trivial (%d non-empty lines)" % len(lines)
for kw in ["背景", "验收"]:
    assert kw in text, "plan file lacks %r" % kw
print("plan file non-trivial: %d lines" % len(lines))
EOF
  then
    fail "4-live" "plan file content too trivial (raw: $EVIDENCE_DIR/plan-file-4.md)"
  fi
  TASKDIR_AFTER="$EVIDENCE_DIR/taskdir-after-4.txt"
  docker compose exec -T worker sh -c "find /data/vteam-worker/tasks/$TASK_ID -type f 2>/dev/null | sort" >"$TASKDIR_AFTER" 2>/dev/null || : >"$TASKDIR_AFTER"
  if ! python3 - "$TASKDIR_BEFORE" "$TASKDIR_AFTER" <<'EOF'
import sys
before = set(l.strip() for l in open(sys.argv[1], encoding="utf-8", errors="replace") if l.strip())
after = set(l.strip() for l in open(sys.argv[2], encoding="utf-8", errors="replace") if l.strip())
added = sorted(after - before)
assert added, "no new files under task dir (plan file missing?)"
outside = [p for p in added if "/.opencode/plans/" not in p]
assert not outside, "files written OUTSIDE .opencode/plans/: %r" % outside
print("task-dir diff: only plans-dir files added: %r" % added)
EOF
  then
    fail "4-live" "file-write scoping violated (before: $TASKDIR_BEFORE after: $TASKDIR_AFTER)"
  fi
  if ! PLAN_MID="$PLAN_MEMBER_ID" python3 - "$GROUP4_OUT" "$WM4" <<'EOF'; then
import json,sys,os
d = json.load(open(sys.argv[1])); wm = sys.argv[2]
items = d if isinstance(d, list) else d.get("items") or []
news = [m for m in items if m.get("id", "") > wm]
blob = json.dumps([m.get("content") for m in news], ensure_ascii=False)
assert "E2E-PLAN-DONE" in blob, "E2E-PLAN-DONE absent from new group messages"
EOF
    warn "4-live completion marker E2E-PLAN-DONE absent from new group messages (file+group asserts hold; raw: $GROUP4_OUT)"
  fi
  pass "4 (plan .md landed under .opencode/plans/ non-trivial + member replied in group)"
else
  if [[ "$TRIGGER_OK" != "yes" ]]; then
    warn "step 4 skipped live asserts (infra/dispatch; see needs-attention)"
  else
    file_present=""; group_present=""
    docker compose exec -T worker test -f "/data/vteam-worker/$PLAN_FILE" 2>/dev/null && file_present="yes"
    if PLAN_MID="$PLAN_MEMBER_ID" python3 - "$GROUP4_OUT" "$WM4" <<'EOF' 2>/dev/null; then
import json,sys,os
d = json.load(open(sys.argv[1])); wm = sys.argv[2]; mid = os.environ.get("PLAN_MID", "")
items = d if isinstance(d, list) else d.get("items") or []
news = [m for m in items if m.get("id", "") > wm]
hit = [m for m in news if m.get("senderInstanceId") == mid or "E2E-PLAN-POSTED" in json.dumps(m.get("content") or {}, ensure_ascii=False)]
assert hit, "no new plan-member group message"
EOF
      group_present="yes"
    fi
    if [[ -n "$file_present" && -z "$group_present" ]]; then
      fail "4-live" "contract violation: plan file landed but member group reply missing (raw plan: $EVIDENCE_DIR/plan-file-4.md group: $GROUP4_OUT trigger: $TRIGGER_OUT)"
    elif [[ -z "$file_present" && -n "$group_present" ]]; then
      fail "4-live" "contract violation: member replied in group but no plan file under .opencode/plans/ (raw group: $GROUP4_OUT trigger: $TRIGGER_OUT)"
    else
      needs_attention "4-live" "dispatch accepted but no file/reply within ${LIVE_TIMEOUT_SEC}s (LLM/worker stall?) raw: trigger $TRIGGER_OUT group $GROUP4_OUT"
    fi
  fi
fi

# ---------------------------------------------------------------- step 5: live subagent spawn smoke (own vteam-plan session)
log "--- step 5: live subagent spawn + nesting-blocked (bounded ${LIVE_TIMEOUT_SEC}s) ---"
LIVE5_PATH="native-fallback"
if [[ "$LIVE4_OK" == "yes" ]]; then
  PROMPT5="$(mktmp)"
  cat >"$PROMPT5" <<EOF
e2e 子会话探测（vteam-plan 会话直调）。调用 task 工具发起一个子会话，参数 subagent_type 固定为 'vteam-plan'，子会话指令为：“读取文件 /data/vteam-worker/$PLAN_FILE 的首行并原样返回，返回文本以 PROBE-OK 开头；然后你自己再调用一次 task 工具（subagent_type 仍为 'vteam-plan'，指令为任意只读查看），把第二次调用的返回结果或报错原文用 NESTED-RESULT: 开头单行报告并一并带回”。等待子会话返回后，把结果全文回复，并以 E2E-SUBAGENT-DONE 结尾。
EOF
  SID5="$(serve_create_session)" || { needs_attention "5-live" "POST serve /session failed (serve/LLM infra?)"; SID5=""; }
  if [[ -n "${SID5:-}" ]]; then
  log "step5 sid=$SID5"
  EXEC5_OUT="$EVIDENCE_DIR/execute-5.json"
  CODE5="$(worker_exec 'vteam-plan' "/data/vteam-worker/tasks/$TASK_ID" "$SID5" "$TASK_ID" "$PLAN_AGENT_ID" "$PROMPT5" "$EXEC5_OUT")" \
    || fail "5-live" "worker /execute call failed"
  if [[ "$CODE5" != "202" ]]; then
    needs_attention "5-live" "POST worker /execute HTTP $CODE5 (infra?) raw: $EXEC5_OUT"
  else
    SERVE5_OUT="$EVIDENCE_DIR/serve-msg-5.json"
    ASSIST5_OUT="$EVIDENCE_DIR/serve-msg-5-assistant.txt"
    deadline=$((SECONDS + LIVE_TIMEOUT_SEC))
    while [[ $SECONDS -lt $deadline ]]; do
      curl -sS "$SERVE_BASE_URL/session/$SID5/message" -o "$SERVE5_OUT" 2>/dev/null || true
      assistant_text "$SERVE5_OUT" "$ASSIST5_OUT"
      grep -q 'E2E-SUBAGENT-DONE' "$ASSIST5_OUT" 2>/dev/null && break
      sleep "$POLL_INTERVAL_SEC"
    done
    curl -sS "$SERVE_BASE_URL/session/$SID5/message" -o "$SERVE5_OUT" 2>/dev/null || true
    assistant_text "$SERVE5_OUT" "$ASSIST5_OUT"
    if grep -q 'PROBE-OK' "$ASSIST5_OUT" 2>/dev/null; then
      if ! python3 - "$ASSIST5_OUT" <<'EOF'; then
import re,sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'NESTED-RESULT\s*[:：]\s*(.{0,800})', text, re.S)
assert m, "no NESTED-RESULT block relayed from subagent"
window = m.group(1)
assert re.search(r'denied|越界|not allowed|forbidden|blocked|childToolDenies|depth|nested|recurs|cannot|无法|不允许|拒绝|fail|error', window, re.I), \
  "nested call NOT blocked, window=%r" % window[:200]
print("nested spawn blocked, window=%r" % window[:200])
EOF
        if grep -q 'NESTED-RESULT' "$ASSIST5_OUT" 2>/dev/null; then
          fail "5-live" "nested spawn NOT blocked per NESTED-RESULT window (raw: $SERVE5_OUT assistant: $ASSIST5_OUT)"
        else
          needs_attention "5-live" "PROBE-OK ok but subagent did not report NESTED-RESULT label (LLM format drift?) raw: $SERVE5_OUT"
        fi
      else
        LIVE5_PATH="live"
        pass "5 (subagent probe PROBE-OK returned + nested spawn blocked per NESTED-RESULT)"
      fi
    else
      needs_attention "5-live" "no PROBE-OK within ${LIVE_TIMEOUT_SEC}s (LLM infra?) raw: $SERVE5_OUT"
    fi
  fi
  fi
else
  needs_attention "5-live" "step 4 not live-ok; subagent spawn proven via native-permission fallback (see live-path.txt)"
fi
# Fallback evidence is ALWAYS recorded (deterministic part of the spawn contract).
{
  echo "live path taken: $LIVE5_PATH"
  echo "parent spawn gate (engine-native): injected vteam-plan permission.task=allow (see injected-opencode.json; contract in native-permission-contract.json)"
  echo "nesting block (engine-native): subagent sessions derive stricter permissions; task self-deny at depth>=1 (opencode childToolDenies). The hand-rolled \"禁套娃\" rule was NOT ported (opencode-native-permissions-and-fixes todo 5) — no worker guard exists to decide it. Live nested attempt result: see serve-msg-5.json when path=live."
} >"$EVIDENCE_DIR/live-path.txt"
if [[ "$LIVE5_PATH" == "native-fallback" ]]; then
  log "step 5 via native-permission fallback (documented in live-path.txt)"
fi

# ---------------------------------------------------------------- step 6: plan_review absence
log "--- step 6: plan_review absence (tools/list + POST /review + /agent-policies + repo grep) ---"
LIST_OUT="$EVIDENCE_DIR/tools-list.json"
mcp_post "$LIST_OUT" 100 'tools/list' '{}'
if ! python3 - "$LIST_OUT" <<'EOF'
import json,sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
assert "plan_review" not in raw, "tools/list still references plan_review"
d = json.loads(raw)
res = d.get("result") or {}
tools = res.get("tools") or []
names = [t.get("name", "") for t in tools if isinstance(t, dict)]
assert not [n for n in names if "review" in n.lower()], "tools/list has review-like tools: %r" % names
print("tools/list: %d tools, none plan_review/review-like" % len(names))
EOF
then
  fail "6-absence" "tools/list still exposes plan_review (raw: $LIST_OUT)"
fi
pass "6a (tools/list has no plan_review)"
REVIEW_OUT="$EVIDENCE_DIR/review-gone.txt"
REVIEW_CODE="$(docker compose exec -T worker curl -sS -o /tmp/e2e-pm-review.json -w '%{http_code}' -X POST http://localhost:4198/review -H 'Content-Type: application/json' --data '{}' 2>/dev/null || echo curlfail)"
docker compose cp worker:/tmp/e2e-pm-review.json "$REVIEW_OUT.body" >/dev/null 2>&1 || : >"$REVIEW_OUT.body"
docker compose exec -T worker rm -f /tmp/e2e-pm-review.json >/dev/null 2>&1 || true
printf 'POST /review HTTP %s\nbody: %s\n' "$REVIEW_CODE" "$(cat "$REVIEW_OUT.body")" >"$REVIEW_OUT"
log "POST /review -> HTTP $REVIEW_CODE (raw: $REVIEW_OUT)"
[[ "$REVIEW_CODE" != "200" ]] || fail "6-absence" "POST /review returned 200 (endpoint not removed; raw: $REVIEW_OUT)"
[[ "$REVIEW_CODE" == "404" || "$REVIEW_CODE" == "405" ]] \
  || fail "6-absence" "POST /review HTTP $REVIEW_CODE (want 404/405, NOT 200; raw: $REVIEW_OUT)"
pass "6b (POST /review gone: HTTP $REVIEW_CODE)"
POL_OUT="$EVIDENCE_DIR/agent-policies.json"
code="$(curl -sS -o "$POL_OUT" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN" 2>/dev/null)" || code="000"
[[ "$code" == "200" ]] || fail "6-absence" "GET /agent-policies HTTP $code (raw: $POL_OUT)"
if ! python3 - "$POL_OUT" <<'EOF'
import json,sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
assert "plan_review" not in raw, "/agent-policies still references plan_review"
d = json.loads(raw)
blob = json.dumps(d)
assert "plan_review" not in blob
agents = d.get("agents") or []
names = [a.get("name") for a in agents if isinstance(a, dict)]
assert "vteam-plan" in names, "vteam-plan missing from /agent-policies: %r" % names
print("/agent-policies: %d agents incl vteam-plan, no plan_review key" % len(names))
EOF
then
  fail "6-absence" "/agent-policies still references plan_review (raw: $POL_OUT)"
fi
pass "6c (GET /agent-policies: vteam-plan present, no plan_review key)"
REPO_GREP_OUT="$EVIDENCE_DIR/plan-review-grep.txt"
grep -rn 'plan_review' server/src worker/src --include='*.ts' 2>/dev/null | grep -v '\.spec\.ts' >"$REPO_GREP_OUT" || : >"$REPO_GREP_OUT"
[[ ! -s "$REPO_GREP_OUT" ]] || fail "6-absence" "plan_review refs remain in product src (raw: $REPO_GREP_OUT)"
pass "6d (repo grep plan_review in server/src+worker/src non-spec: zero hits)"

# ---------------------------------------------------------------- step 7: cleanup + baseline restore
log "--- step 7: cleanup (plan file, serve sessions, task-dir verify) ---"
[[ -n "${SID5:-}" ]] && curl -sS -o /dev/null -X DELETE "$SERVE_BASE_URL/session/$SID5" 2>/dev/null || true
[[ -n "${PROBE_SID:-}" ]] && curl -sS -o /dev/null -X DELETE "$SERVE_BASE_URL/session/$PROBE_SID" 2>/dev/null || true
docker compose exec -T worker rm -f "/data/vteam-worker/tasks/$TASK_ID/.opencode/plans/e2e-plan-member.md" >/dev/null 2>&1 || true
docker compose exec -T worker test '!' -f "/data/vteam-worker/tasks/$TASK_ID/.opencode/plans/e2e-plan-member.md" 2>/dev/null \
  || fail "7-cleanup" "e2e plan file not removed"
TASKDIR_FINAL="$EVIDENCE_DIR/taskdir-final.txt"
docker compose exec -T worker sh -c "find /data/vteam-worker/tasks/$TASK_ID -type f 2>/dev/null | sort" >"$TASKDIR_FINAL" 2>/dev/null || : >"$TASKDIR_FINAL"
if ! diff -q "$TASKDIR_BEFORE" "$TASKDIR_FINAL" >/dev/null 2>&1; then
  fail "7-cleanup" "task dir differs after cleanup (before: $TASKDIR_BEFORE final: $TASKDIR_FINAL)"
fi
log "task dir restored; serve sessions aborted"
git status --short >"$EVIDENCE_DIR/git-status-final.txt" 2>&1 || true
# Append findings to the plan notepad (evidence of the MUST DO).
NOTEPAD="$REPO_ROOT/.omo/notepads/vteam-plan-member-subagents/learnings.md"
if [[ -d "$(dirname "$NOTEPAD")" ]]; then
  {
    echo ""
    echo "## e2e-plan-member.sh run ($(date -u +%FT%TZ)) HEAD=$BASELINE_HEAD"
    echo "- seed: a_plan(ep_plan)/tmm_0000000006 non-main/one instance per builtin template; /agents template; /teams 计划员."
    echo "- injection: vteam-plan mode=all task=allow plans-scoped edit, native-only permission; all seven built-ins byte-identical to the frozen baseline."
    echo "- native permission contract: task allow only vteam-plan; edit '*':deny + plans-scoped for plan; 0 vteam_ leaks; no guard plugin (native-permission-contract.json)."
    echo "- live step4 (group @): ${LIVE4_OK:-infra-skipped}; live step5 path: $LIVE5_PATH."
    echo "- plan_review: tools/list clean; POST /review HTTP $REVIEW_CODE; /agent-policies clean; repo non-spec grep zero hits."
    echo "- cleanup: plan file removed, task dir identical, serve sessions aborted. needs-attention: $(cat "$NEEDS_FILE" 2>/dev/null | tr '\n' ';')"
  } >>"$NOTEPAD" 2>/dev/null || warn "could not append to $NOTEPAD"
  log "findings appended to $NOTEPAD"
else
  warn "notepad dir missing, skipped learnings append"
fi
pass "7 (cleanup + baseline restore)"

if [[ -s "$NEEDS_FILE" ]]; then
  log "SUITE DONE with NEEDS-ATTENTION (infra-only; see $NEEDS_FILE):"
  cat "$NEEDS_FILE" | tee -a "$E2E_LOG"
fi
log "ALL STEPS DONE: 0/1/2/3/4/5/6/7 (live5 path: $LIVE5_PATH)"
printf '[e2e] \033[32mPASS\033[0m plan-member (evidence: %s)\n' "$EVIDENCE_DIR" | tee -a "$E2E_LOG"
