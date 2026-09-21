#!/usr/bin/env bash
#
# e2e: layered role enforcement boundaries (plan Todo 21).
#
# Covers scenarios a/c/d/e/f/f2/g against a LIVE stack (server + worker + opencode serve):
#   a) product role edits out-of-scope path         -> layer-1 (native) edit deny
#   c) bound-session ask flow via group @mention    -> permission question reply 200 (not 503)
#   d) developer in-scope edit                      -> allowed (message arrives, no denial)
#   e) project-manager dangerous bash               -> denied (layer-1 native bash)
#   f) task tool contract                           -> /agent-policies + injected opencode.json:
#                                                      exactly vteam-plan task=allow, others deny
#   f2) DB-driven builtin policy (plan Todo 15)     -> PATCH a builtin policy's tools/permission,
#                                                      reload the worker, and prove the change lands in the
#                                                      injected opencode.json + roles.json while the other 6
#                                                      builtins stay byte-identical to the frozen baseline
#   g) cloned product role still denied             -> same expectation as (a)
#
# Required env:
#   SERVER_URL               server base WITHOUT /api/v1, e.g. http://localhost:13000 (docker host port)
#                            or http://localhost:3000 (local dev). Default: http://localhost:13000
#   X_WORKER_TOKEN           worker token (must match server WORKER_TOKEN; used for /agent-policies)
#   WORK_DIR                 worker work dir, e.g. /data/vteam-worker (taskDir=$WORK_DIR/tasks/$taskId).
#                            Required for a/c/d/e/g; for SCENARIOS=f only when INJECTED_OPENCODE_JSON unset.
#   SERVE_BASE_URL           opencode serve base, e.g. http://127.0.0.1:4096 (from worker capabilities.baseUrl).
#                            Required for a/c/d/e/g (not needed for the deterministic SCENARIOS=f).
#   OPENCODE_SERVER_PASSWORD serve Basic-auth password (username is always `opencode`; empty = no auth)
#   WORKER_EXEC_URL          worker exec endpoint base, e.g. http://<worker-host>:4198.
#                            If unset, derived as <scheme>://<host>:4198 from SERVE_BASE_URL origin
#                            (override when worker exec port/host differs; see WORKER_EXEC_PORT).
#   MEMBER_JWT               Bearer JWT of a user who is a member of TEAM_ID (ask flow polls
#                            GET /questions and posts replies as this user). If unset, auto-login
#                            as seed-admin/Admin@123456 (owner of tm_0000000001). NOTE: seed-member
#                            is NOT a member of tm_0000000001 (live-verified 2026-09-13: reply/poll
#                            returns 403 PERMISSION_TEAM_NOT_MEMBER), so do NOT substitute it blindly.
# Optional env:
#   TEAM_ID                  default tm_0000000001
#   CLONE_AGENT              opencode agent name of the cloned product role (default vteam-product-clone).
#                            Must exist in the stack, otherwise scenario (g) reports INCONCLUSIVE.
#   MENTION_NAME             display name to @ in scenario (c). Default: 测试-1
#   POLL_TIMEOUT_SEC         per-scenario poll budget. Default: 180
#   POLL_INTERVAL_SEC        poll interval. Default: 5
#   ADMIN_JWT                override seed-admin JWT (else auto-login seed-admin/Admin@123456).
#   EVIDENCE_DIR             where to stash raw JSON responses. Default: ./e2e-evidence (gitignored by caller).
#   INJECTED_OPENCODE_JSON   override path of the worker-injected opencode.json for scenario (f).
#                            Scenario (f2) additionally asserts `.vteam-role-guard/` is NOT written (todo 5).
#                            Default: $WORK_DIR/opencode.json. In containerized deployments the
#                            worker WORK_DIR lives inside the worker container; point this at a
#                            local copy (e.g. via `docker cp worker:/data/vteam-worker/opencode.json`).
#   SCENARIOS                "all" (default) or a comma list of a,c,d,e,f,g. Use SCENARIOS=f for the
#                            deterministic policy contract + DB-driven proof without a model/serve.
#                            See the (f2) knob block below for BASELINE_POLICIES / EDIT_POLICY_ID /
#                            WORKER_WORK_DIR / RESTART_TIMEOUT_SEC.
#
# Run:
#   SERVER_URL=http://localhost:13000 X_WORKER_TOKEN=... WORK_DIR=/data/vteam-worker \
#     SERVE_BASE_URL=http://127.0.0.1:<serve-port> OPENCODE_SERVER_PASSWORD=... \
#     bash scripts/e2e-role-boundaries.sh
#   MEMBER_JWT must belong to TEAM_ID (defaults to the team owner login).
#
# Rule: any poll timeout without the expected tool/message prints INCONCLUSIVE and exits
# non-zero. This script NEVER passes by default.
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
X_WORKER_TOKEN="${X_WORKER_TOKEN:-}"
WORK_DIR="${WORK_DIR:-}"
SERVE_BASE_URL="${SERVE_BASE_URL:-}"
OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
TEAM_ID="${TEAM_ID:-tm_0000000001}"
CLONE_AGENT="${CLONE_AGENT:-vteam-product-clone}"
MENTION_NAME="${MENTION_NAME:-测试-1}"
POLL_TIMEOUT_SEC="${POLL_TIMEOUT_SEC:-180}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}"
MEMBER_JWT="${MEMBER_JWT:-}"
ADMIN_JWT="${ADMIN_JWT:-}"
EVIDENCE_DIR="${EVIDENCE_DIR:-./e2e-evidence}"
#
# Scenario (f2) — DB-driven builtin policy proof (plan Todo 15) — knobs:
#   BASELINE_POLICIES   frozen factory baseline (baseline-agent-policies.json, todo 5:
#                       agents[].permission native-only + guard.roles[*] = {permission}).
#                       Default the repo evidence copy;
#                       its sha256 is checked against FROZEN_BASELINE_SHA256 before any
#                       assertion so a tampered/stale baseline fails loudly.
#   FROZEN_BASELINE_SHA256  expected sha256 of BASELINE_POLICIES.
#   EDIT_POLICY_ID      builtin policy row edited for the proof. Default ep_product.
#   WORKER_WORK_DIR     worker work dir INSIDE the worker container. Default $WORK_DIR.
#                       (WORK_DIR stays the host-visible contract for scenario f.)
#   RESTART_TIMEOUT_SEC / RESTART_INTERVAL_SEC  worker-reload poll budget (default 180/5).
BASELINE_POLICIES="${BASELINE_POLICIES:-}"
FROZEN_BASELINE_SHA256="${FROZEN_BASELINE_SHA256:-22aaf9e1322ae333d461733162d1a149293ac604350167ad96e1af9d58054ffe}"
EDIT_POLICY_ID="${EDIT_POLICY_ID:-ep_product}"
WORKER_WORK_DIR="${WORKER_WORK_DIR:-${WORK_DIR:-/data/vteam-worker}}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-180}"
RESTART_INTERVAL_SEC="${RESTART_INTERVAL_SEC:-5}"

# SCENARIOS selects which scenarios run: "all" (default) or a comma list of
# a,c,d,e,f,g (e.g. SCENARIOS=f runs only the deterministic policy contract,
# which needs neither the opencode serve exec endpoint nor a model).
SCENARIOS="${SCENARIOS:-all}"
want() {
  if [[ "$SCENARIOS" == "all" ]]; then return 0; fi
  case ",$SCENARIOS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

if [[ -z "${WORKER_EXEC_URL:-}" && -n "$SERVE_BASE_URL" ]]; then
  # Derive from SERVE_BASE_URL origin + execPort 4198 (plan Todo 21). Override via
  # WORKER_EXEC_URL when the worker exec endpoint lives elsewhere.
  _origin="$(printf '%s' "$SERVE_BASE_URL" | sed -E 's#(https?://[^/:]+).*#\1#')"
  WORKER_EXEC_URL="${_origin}:4198"
fi

# ---------------------------------------------------------------- helpers
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$EVIDENCE_DIR"

docker_compose() { (cd "$REPO_ROOT" && docker compose "$@"); }
have_docker() {
  command -v docker >/dev/null 2>&1 && docker_compose version >/dev/null 2>&1
}

# reload_worker : restart the worker container so its start-only injector re-fetches
# /agent-policies. Deliberately `restart`, NOT `up -d --force-recreate`: the latter
# re-runs the `init` dependency, whose seed can overwrite the just-made DB edit
# (pre-Todo-9 init images reseed config unconditionally) and thus confound the proof.
reload_worker() {
  docker_compose restart worker >/dev/null 2>&1 \
    || docker restart aiagents-compose-worker >/dev/null 2>&1
}

# sha256_of <file> : prints the file's sha256 (coreutils/BSD compatible).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# api PATCH helper target for the DB-driven proof; restored on EXIT.
RESTORE_CONFIG_FILE=""
RESTORE_DONE=""
restore_edited_policy() {
  if [[ -n "$RESTORE_DONE" ]]; then return 0; fi
  if [[ -n "$RESTORE_CONFIG_FILE" && -f "$RESTORE_CONFIG_FILE" && -n "${ADMIN_JWT:-}" ]]; then
    printf '[e2e] cleanup: restoring %s original config ...\n' "$EDIT_POLICY_ID"
    api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$RESTORE_CONFIG_FILE" \
      "$EVIDENCE_DIR/policy-restore.json" >/dev/null 2>&1 || true
    if [[ -n "${WORKER_RELOADED_FOR_F2:-}" ]] && have_docker; then
      # restart (NOT --force-recreate, which re-runs the `init` dependency and can
      # reseed the DB) is sufficient to re-run the start-only injector.
      docker_compose restart worker >/dev/null 2>&1 || true
    fi
  fi
  RESTORE_DONE="yes"
}
trap restore_edited_policy EXIT

log()  { printf '[e2e] %s\n' "$*"; }
pass() { printf '[e2e] PASS %s\n' "$*"; }
inconclusive() { # $1 = scenario, $2 = reason
  printf '[e2e] INCONCLUSIVE scenario=%s reason=%s\n' "$1" "$2"
  exit 1
}
fail() { # $1 = scenario, $2 = reason
  printf '[e2e] FAIL scenario=%s reason=%s\n' "$1" "$2"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1"; exit 2; }
}
need_cmd curl
need_cmd python3

# serve Basic auth: username is ALWAYS `opencode` (worker/.env.example:27).
# NOTE (bash<4.4 compat, e.g. macOS bash 3.2): never expand an empty array
# under `set -u` — `"${serve_auth_args[@]}"` aborts when the password is
# empty. All serve curl goes through serve_curl() which branches instead.
serve_curl() { # serve_curl <out-file> <curl-args...> : curl with serve auth iff password set.
  local out="$1"; shift
  if [[ -n "$OPENCODE_SERVER_PASSWORD" ]]; then
    curl -sS -o "$out" "$@" -u "opencode:${OPENCODE_SERVER_PASSWORD}"
  else
    curl -sS -o "$out" "$@"
  fi
}

# jget <json-file> <python-expr on `d`> : print extracted value or empty.
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v='"$2"'; print("" if v is None else (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))' "$1"; }

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

# login <username> <password> : prints accessToken (server returns {accessToken,...}).
login() {
  local body out code
  body="$(mktemp)"; out="$(mktemp)"
  printf '{"username":"%s","password":"%s"}' "$1" "$2" >"$body"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  rm -f "$body"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    cp "$out" "$EVIDENCE_DIR/login-$1.txt"; rm -f "$out"
    printf '[e2e] login %s failed: HTTP %s (body in %s)\n' "$1" "$code" "$EVIDENCE_DIR/login-$1.txt"
    return 1
  fi
  jget "$out" 'd.get("accessToken") or d.get("access_token") or ""'
  rm -f "$out"
}

# serve_create_session : prints serve session id (POST {SERVE_BASE_URL}/session -> {id}).
serve_create_session() {
  local out code
  out="$(mktemp)"
  code="$(serve_curl "$out" -w '%{http_code}' -X POST "$SERVE_BASE_URL/session")"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    cp "$out" "$EVIDENCE_DIR/serve-session-create.txt"; rm -f "$out"
    return 1
  fi
  jget "$out" 'd.get("id") or d.get("sessionId") or ""'
  rm -f "$out"
}

# worker_execute <agent> <directory> <sessionId> <taskId> <agentId> <prompt-text> : expect 202.
worker_execute() {
  local body out code
  body="$(mktemp)"; out="$(mktemp)"
  python3 - "$body" "$1" "$2" "$3" "$4" "$5" "$6" <<'EOF'
import json,sys
out,agent,directory,sid,task,agentId,text = sys.argv[1:8]
json.dump({"agent":agent,"directory":directory,"sessionId":sid,"taskId":task,
           "agentId":agentId,"prompt":[{"type":"text","text":text}]}, open(out,"w"), ensure_ascii=False)
EOF
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$WORKER_EXEC_URL/execute" \
    -H 'Content-Type: application/json' --data @"$body")"
  rm -f "$body"
  printf '%s %s\n' "$code" "$out"
}

# poll_serve_message <SID> <expect-grep-ere> <scenario> : poll GET /session/$SID/message
# until the body matches; on timeout -> INCONCLUSIVE (non-zero).
poll_serve_message() {
  local sid="$1" expect="$2" scenario="$3"
  local deadline out body i=0
  deadline=$((SECONDS + POLL_TIMEOUT_SEC))
  out="$EVIDENCE_DIR/serve-msg-$scenario.json"
  while [[ $SECONDS -lt $deadline ]]; do
    i=$((i+1))
    if serve_curl "$out" "$SERVE_BASE_URL/session/$sid/message"; then
      if grep -Eq "$expect" "$out" 2>/dev/null; then
        log "scenario=$scenario matched after ~$((i * POLL_INTERVAL_SEC))s (raw: $out)"
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  inconclusive "$scenario" "poll timeout ${POLL_TIMEOUT_SEC}s without match /$expect/ (raw: $out)"
}

poll_questions_pending() { # $1 = taskId, $2 = scenario : prints question id or INCONCLUSIVE-exits.
  local taskId="$1" scenario="$2" out qid deadline i=0
  out="$EVIDENCE_DIR/questions-pending-$scenario.json"
  deadline=$((SECONDS + POLL_TIMEOUT_SEC))
  while [[ $SECONDS -lt $deadline ]]; do
    i=$((i+1))
    code="$(api GET "/questions?taskId=$taskId&status=pending" "$MEMBER_JWT" '' "$out")"
    if [[ "$code" == "200" ]]; then
      qid="$(jget "$out" '(d[0].get("id") if isinstance(d,list) and d else (d.get("items") or [{}])[0].get("id")) or ""')"
      if [[ -n "$qid" ]]; then
        log "scenario=$scenario pending question id=$qid after ~$((i * POLL_INTERVAL_SEC))s"
        printf '%s' "$qid"
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL_SEC"
  done
  inconclusive "$scenario" "poll timeout ${POLL_TIMEOUT_SEC}s without pending question (raw: $out)"
}

# ---------------------------------------------------------------- preconditions
[[ -n "$X_WORKER_TOKEN" ]] || { printf '[e2e] X_WORKER_TOKEN is required\n'; exit 2; }
if want f && [[ -z "$BASELINE_POLICIES" ]]; then
  BASELINE_POLICIES="$REPO_ROOT/.omo/evidence/opencode-native-permissions-and-fixes/baseline-agent-policies.json"
fi
needs_serve=""
for _s in a c d e g; do want "$_s" && needs_serve="yes"; done
if [[ -n "$needs_serve" ]]; then
  [[ -n "$WORK_DIR" ]] || { printf '[e2e] WORK_DIR is required\n'; exit 2; }
  [[ -n "$SERVE_BASE_URL" ]] || { printf '[e2e] SERVE_BASE_URL is required\n'; exit 2; }
fi
log "SERVER_URL=$SERVER_URL TEAM_ID=$TEAM_ID WORKER_EXEC_URL=${WORKER_EXEC_URL:-<unset>} SCENARIOS=$SCENARIOS"

log "login seed-admin ..."
ADMIN_JWT="${ADMIN_JWT:-$(login seed-admin 'Admin@123456')}" || exit 1
[[ -n "$ADMIN_JWT" ]] || { printf '[e2e] empty admin accessToken\n'; exit 1; }
if [[ -z "$MEMBER_JWT" ]]; then
  log "login seed-admin as MEMBER_JWT (team owner; seed-member is not in $TEAM_ID) ..."
  MEMBER_JWT="$(login seed-admin 'Admin@123456')" || exit 1
fi
[[ -n "$MEMBER_JWT" ]] || { printf '[e2e] empty member accessToken\n'; exit 1; }

# ---------------------------------------------------------------- setup: task
TASK_ID=""
if want a || want d || want e || want g || want c; then
  TASK_BODY="$(mktemp)"; TASK_OUT="$EVIDENCE_DIR/task-create.json"
  printf '{"title":"e2e-role-boundaries","teamId":"%s"}' "$TEAM_ID" >"$TASK_BODY"
  code="$(api POST '/tasks' "$ADMIN_JWT" "$TASK_BODY" "$TASK_OUT")"
  rm -f "$TASK_BODY"
  [[ "$code" == "200" || "$code" == "201" ]] || inconclusive "setup" "POST /tasks HTTP $code (raw: $TASK_OUT)"
  TASK_ID="$(jget "$TASK_OUT" 'd.get("id") or d.get("taskId") or ""')"
  [[ -n "$TASK_ID" ]] || inconclusive "setup" "task create returned no id (raw: $TASK_OUT)"
  TASK_DIR="$WORK_DIR/tasks/$TASK_ID"
  log "taskId=$TASK_ID taskDir=$TASK_DIR"
fi

# ---------------------------------------------------------------- expected substrings
# opencode-native-permissions-and-fixes todo 5: the hand-rolled guard is deleted, so the
# only stable contract is the engine's own layer-1 (native `permission`) denial. Its exact
# serve wording is version-dependent; match the deny family.
NATIVE_DENY='[Dd]eny|[Dd]enied|not allowed|拒绝'

# ---------------------------------------------------------------- scenario (a): product out-of-scope edit -> deny
if want a; then
log "--- scenario (a): product edits server/src/foo.ts (out of scope) ---"
SID_A="$(serve_create_session)" || inconclusive "a" "POST {SERVE_BASE_URL}/session failed (no serve?)"
[[ -n "$SID_A" ]] || inconclusive "a" "serve session create returned no id"
log "scenario=a sid=$SID_A"
read -r CODE_A OUT_A <<<"$(worker_execute 'vteam-product' "$TASK_DIR" "$SID_A" "$TASK_ID" 'a_product' '请直接修改文件 server/src/foo.ts，在文件末尾追加一行注释 // e2e-a，然后汇报完成。')"
cp "$OUT_A" "$EVIDENCE_DIR/execute-a.json"; rm -f "$OUT_A"
[[ "$CODE_A" == "202" ]] || inconclusive "a" "POST /execute HTTP $CODE_A (raw: $EVIDENCE_DIR/execute-a.json)"
poll_serve_message "$SID_A" "$NATIVE_DENY" "a"
pass "a (product out-of-scope edit denied)"
fi

# ---------------------------------------------------------------- scenario (d): developer in-scope -> allow
if want d; then
log "--- scenario (d): developer in-scope write (allowed) ---"
SID_D="$(serve_create_session)" || inconclusive "d" "POST {SERVE_BASE_URL}/session failed"
[[ -n "$SID_D" ]] || inconclusive "d" "serve session create returned no id"
read -r CODE_D OUT_D <<<"$(worker_execute 'vteam-developer' "$TASK_DIR" "$SID_D" "$TASK_ID" 'a_developer' '请在当前任务目录（serve 会话 cwd 为 worker 根 /data/vteam-worker，任务目录相对路径为 tasks/'"$TASK_ID"'）下新建文件 tasks/'"$TASK_ID"'/src/e2e-ok.txt，内容为 hello-e2e，然后读取该文件验证内容并汇报完成。')"
cp "$OUT_D" "$EVIDENCE_DIR/execute-d.json"; rm -f "$OUT_D"
[[ "$CODE_D" == "202" ]] || inconclusive "d" "POST /execute HTTP $CODE_D (raw: $EVIDENCE_DIR/execute-d.json)"
# Allow = the written content round-trips through serve readback with NO denial.
# NOTE: poll pattern must be the content literal `hello-e2e` — a generic
# `text|part|...` pattern also matches the prompt echo envelope and would pass
# vacuously even when the model never ran (observed 2026-09-13: cost=0/tokens=0).
poll_serve_message "$SID_D" 'hello-e2e' "d"
if grep -Eq "$NATIVE_DENY" "$EVIDENCE_DIR/serve-msg-d.json"; then
  fail "d" "developer in-scope run hit denial markers (raw: $EVIDENCE_DIR/serve-msg-d.json)"
fi
pass "d (developer in-scope allowed)"
fi

# ---------------------------------------------------------------- scenario (e): PM dangerous bash -> deny
if want e; then
log "--- scenario (e): project-manager dangerous bash (denied) ---"
SID_E="$(serve_create_session)" || inconclusive "e" "POST {SERVE_BASE_URL}/session failed"
[[ -n "$SID_E" ]] || inconclusive "e" "serve session create returned no id"
read -r CODE_E OUT_E <<<"$(worker_execute 'vteam-project_manager' "$TASK_DIR" "$SID_E" "$TASK_ID" 'a_project_manager' '请执行 rm -rf /tmp/vteam-e2e-marker-dir 并汇报结果。')"
cp "$OUT_E" "$EVIDENCE_DIR/execute-e.json"; rm -f "$OUT_E"
[[ "$CODE_E" == "202" ]] || inconclusive "e" "POST /execute HTTP $CODE_E (raw: $EVIDENCE_DIR/execute-e.json)"
poll_serve_message "$SID_E" "$NATIVE_DENY" "e"
pass "e (project-manager dangerous bash denied)"
fi

# ---------------------------------------------------------------- scenario (g): cloned product role still denied
if want g; then
log "--- scenario (g): clone ($CLONE_AGENT) out-of-scope edit (denied) ---"
SID_G="$(serve_create_session)" || inconclusive "g" "POST {SERVE_BASE_URL}/session failed"
[[ -n "$SID_G" ]] || inconclusive "g" "serve session create returned no id"
read -r CODE_G OUT_G <<<"$(worker_execute "$CLONE_AGENT" "$TASK_DIR" "$SID_G" "$TASK_ID" 'a_product_clone' '请直接修改文件 server/src/foo.ts，在文件末尾追加一行注释 // e2e-g，然后汇报完成。')"
cp "$OUT_G" "$EVIDENCE_DIR/execute-g.json"; rm -f "$OUT_G"
[[ "$CODE_G" == "202" ]] || inconclusive "g" "POST /execute HTTP $CODE_G (set CLONE_AGENT to an existing clone agent; raw: $EVIDENCE_DIR/execute-g.json)"
poll_serve_message "$SID_G" "$NATIVE_DENY" "g"
pass "g (clone role still denied)"
fi

# ---------------------------------------------------------------- scenario (c): bound-session ask flow
if want c; then
log "--- scenario (c): group @mention -> permission question -> reply once ---"
CHAN_OUT="$EVIDENCE_DIR/channels.json"
code="$(api GET "/channels?teamId=$TEAM_ID" "$MEMBER_JWT" '' "$CHAN_OUT")"
[[ "$code" == "200" ]] || inconclusive "c" "GET /channels HTTP $code (raw: $CHAN_OUT)"
CHANNEL_ID="$(python3 - "$CHAN_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
items = d if isinstance(d, list) else d.get("items") or d.get("channels") or []
for ch in items:
    if ch.get("type") == "team_group" or ch.get("teamId"):
        print(ch.get("id")); break
else:
    if items: print(items[0].get("id",""))
EOF
)"
[[ -n "$CHANNEL_ID" ]] || inconclusive "c" "no channel for team $TEAM_ID (raw: $CHAN_OUT)"
log "scenario=c channel=$CHANNEL_ID"

# Resolve @mention target agentId for MENTION_NAME via team detail (best effort).
TEAM_OUT="$EVIDENCE_DIR/team.json"
api GET "/teams/$TEAM_ID" "$MEMBER_JWT" '' "$TEAM_OUT" >/dev/null || true
MENTION_AGENT="$(python3 - "$TEAM_OUT" "$MENTION_NAME" <<'EOF' 2>/dev/null || true
import json,sys
name = sys.argv[2]
try: d = json.load(open(sys.argv[1]))
except Exception: raise SystemExit
def walk(o):
    if isinstance(o, dict):
        dn = str(o.get("displayName") or o.get("name") or "")
        if name in dn and o.get("agentId"):
            print(o["agentId"]); raise SystemExit
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(d)
EOF
)"
MSG_BODY="$(mktemp)"; MSG_OUT="$EVIDENCE_DIR/message-c.json"
if [[ -n "${MENTION_AGENT:-}" ]]; then
  python3 - "$MSG_BODY" "$TASK_ID" "$MENTION_NAME" "$MENTION_AGENT" <<'EOF'
import json,sys
out,task,name,aid = sys.argv[1:5]
json.dump({"taskId":task,"text":"@%s 请执行一次需要权限确认的测试操作（e2e-c），完成后汇报。" % name,
           "mentions":[{"type":"agent","agentId":aid}]}, open(out,"w"), ensure_ascii=False)
EOF
else
  log "scenario=c could not resolve agentId for $MENTION_NAME; sending text-only @mention"
  python3 - "$MSG_BODY" "$TASK_ID" "$MENTION_NAME" <<'EOF'
import json,sys
out,task,name = sys.argv[1:4]
json.dump({"taskId":task,"text":"@%s 请执行一次需要权限确认的测试操作（e2e-c），完成后汇报。" % name},
          open(out,"w"), ensure_ascii=False)
EOF
fi
code="$(api POST "/channels/$CHANNEL_ID/messages" "$MEMBER_JWT" "$MSG_BODY" "$MSG_OUT")"
rm -f "$MSG_BODY"
[[ "$code" == "200" || "$code" == "201" ]] || inconclusive "c" "POST /channels/:id/messages HTTP $code (raw: $MSG_OUT)"
log "scenario=c group message sent"

QID="$(poll_questions_pending "$TASK_ID" "c")"
REPLY_BODY="$(mktemp)"; REPLY_OUT="$EVIDENCE_DIR/reply-c.json"
printf '{"response":"once"}' >"$REPLY_BODY"
code="$(api POST "/questions/$QID/reply" "$MEMBER_JWT" "$REPLY_BODY" "$REPLY_OUT")"
rm -f "$REPLY_BODY"
if [[ "$code" == "503" ]]; then
  fail "c" "reply returned 503 QUESTION_WORKER_UNAVAILABLE (session not bound? raw: $REPLY_OUT)"
fi
[[ "$code" == "200" ]] || fail "c" "reply HTTP $code (raw: $REPLY_OUT)"
if grep -q 'QUESTION_WORKER_UNAVAILABLE' "$REPLY_OUT"; then
  fail "c" "reply body contains QUESTION_WORKER_UNAVAILABLE (raw: $REPLY_OUT)"
fi
# The question must no longer be pending.
PENDING_OUT="$EVIDENCE_DIR/questions-after-c.json"
code="$(api GET "/questions?taskId=$TASK_ID&status=pending" "$MEMBER_JWT" '' "$PENDING_OUT")"
if [[ "$code" == "200" ]] && grep -q "$QID" "$PENDING_OUT"; then
  fail "c" "question $QID still pending after reply (raw: $PENDING_OUT)"
fi
pass "c (bound-session ask reply 200, question resolved)"
fi

# ---------------------------------------------------------------- scenario (f): task tool contract (deterministic)
if want f; then
log "--- scenario (f): permission.task contract (only vteam-plan allow) ---"
POL_OUT="$EVIDENCE_DIR/agent-policies.json"
if [[ -n "$X_WORKER_TOKEN" ]]; then
  code="$(curl -sS -o "$POL_OUT" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN")"
else
  code="$(api GET '/agent-policies' "$MEMBER_JWT" '' "$POL_OUT")"
fi
[[ "$code" == "200" ]] || inconclusive "f" "GET /agent-policies HTTP $code (raw: $POL_OUT)"
# The task-tool contract is role-scoped, not global: ONLY vteam-plan carries
# permission.task=allow (it fans out read-only reviewer subagents); every other
# agent stays deny. The previous "all agents task=deny" form contradicted the
# frozen baseline (before-agent-policies.json: vteam-plan task=allow) and could
# never pass against a real stack — corrected here, not weakened (strictly more
# specific: exactly-one allow + everyone else deny + no write key).
if ! python3 - "$POL_OUT" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
agents = d.get("agents") or []
assert agents, "no agents in /agent-policies"
allowed = []
for a in agents:
    perm = a.get("permission") or {}
    assert "write" not in perm, "agent %s has legacy write key" % a.get("name")
    task = perm.get("task")
    if a.get("name") == "vteam-plan":
        assert task == "allow", "vteam-plan permission.task=%r (want allow)" % task
        allowed.append(a.get("name"))
    else:
        assert task == "deny", "agent %s permission.task=%r (want deny)" % (a.get("name"), task)
assert allowed == ["vteam-plan"], "want exactly vteam-plan task=allow, got %r" % allowed
print("agent-policies: %d agents, exactly vteam-plan task=allow, others deny, no write key" % len(agents))
EOF
then
  fail "f" "contract check on /agent-policies failed (raw: $POL_OUT)"
fi
INJECTED="$WORK_DIR/opencode.json"
if [[ -n "${INJECTED_OPENCODE_JSON:-}" ]]; then
  INJECTED="$INJECTED_OPENCODE_JSON"
fi
[[ -f "$INJECTED" ]] || inconclusive "f" "injected $INJECTED not found on this host (worker WORK_DIR differs? set INJECTED_OPENCODE_JSON)"
if ! python3 - "$INJECTED" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1]))
agents = d.get("agent") or d.get("agents") or {}
assert agents, "no agent section in injected opencode.json"
# opencode.json agent section is keyed by agent name; entries carry
# {description, mode, permission} with no `name` field.
pairs = list(agents.items()) if isinstance(agents, dict) else [
    ((a or {}).get("name"), a) for a in agents]
n = 0
allow = []
for name, a in pairs:
    perm = (a.get("permission") or {}) if isinstance(a, dict) else {}
    if not perm: continue
    n += 1
    task = perm.get("task")
    if name == "vteam-plan":
        assert task == "allow", "vteam-plan injected permission.task=%r (want allow)" % task
        allow.append(name)
    else:
        assert task == "deny", "agent %s injected permission.task=%r" % (name, task)
assert n > 0, "no permission-bearing agents in injected opencode.json"
assert allow == ["vteam-plan"], "want exactly vteam-plan injected task=allow, got %r" % allow
print("opencode.json: %d agents, exactly vteam-plan task=allow, others deny" % n)
EOF
then
  fail "f" "contract check on injected opencode.json failed ($INJECTED)"
fi
pass "f (task contract on /agent-policies + injected opencode.json)"
fi

# ---------------------------------------------------------------- scenario (f2): DB-driven builtin policy proof (plan Todo 15)
if want f; then
log "--- scenario (f2): DB-driven builtin policy (edit $EDIT_POLICY_ID -> worker reload) ---"

# Frozen baseline integrity gate: a stale/tampered baseline must fail loudly.
[[ -f "$BASELINE_POLICIES" ]] || fail "f2" "baseline not found: $BASELINE_POLICIES (set BASELINE_POLICIES)"
baseline_sha="$(sha256_of "$BASELINE_POLICIES")"
if [[ "$baseline_sha" != "$FROZEN_BASELINE_SHA256" ]]; then
  fail "f2" "baseline sha256 $baseline_sha != frozen $FROZEN_BASELINE_SHA256 (stale/tampered baseline)"
fi
log "baseline sha256 ok: $baseline_sha"

# Capture the LIVE pre-edit /agent-policies and assert the factory built-ins are
# byte-identical to the frozen baseline (canonical JSON, subset of 7).
PRE_OUT="$EVIDENCE_DIR/f2-pre-agent-policies.json"
code="$(curl -sS -o "$PRE_OUT" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN")"
[[ "$code" == "200" ]] || inconclusive "f2" "GET /agent-policies (pre) HTTP $code (raw: $PRE_OUT)"
if ! python3 - "$PRE_OUT" "$BASELINE_POLICIES" "$EVIDENCE_DIR/f2-pre-builtins.json" <<'EOF'
import json,sys
live = json.load(open(sys.argv[1])); base = json.load(open(sys.argv[2])); out = sys.argv[3]
def canon(o): return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
order = [a["name"] for a in base["agents"]]
live_agents = {a["name"]: a for a in live.get("agents") or []}
live_roles = (live.get("guard") or {}).get("roles") or {}
subset = {"agents": [live_agents[n] for n in order],
          "guard": {"enabled": live["guard"]["enabled"], "roles": {n: live_roles[n] for n in order}}}
assert canon(subset) == canon(base), "live factory builtins differ from frozen baseline"
json.dump(subset, open(out, "w"), ensure_ascii=False, indent=2)
open(out, "a").write("\n")
print("pre-edit: live 7 builtins == frozen baseline (canonical)")
EOF
then
  fail "f2" "pre-edit live builtins differ from frozen baseline (raw: $PRE_OUT)"
fi
pass "f2a (pre-edit live 7 builtins byte-identical to frozen baseline)"

# Snapshot the original config for guaranteed restore on EXIT.
ORIG_OUT="$EVIDENCE_DIR/f2-original-policy.json"
code="$(api GET "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" '' "$ORIG_OUT")"
[[ "$code" == "200" ]] || fail "f2" "GET /execution-policies/$EDIT_POLICY_ID HTTP $code (raw: $ORIG_OUT)"
RESTORE_CONFIG_FILE="$EVIDENCE_DIR/f2-restore-$EDIT_POLICY_ID.json"
python3 - "$ORIG_OUT" "$RESTORE_CONFIG_FILE" "$EVIDENCE_DIR/f2-edit-$EDIT_POLICY_ID.json" <<'EOF'
import json,sys
orig = json.load(open(sys.argv[1])); restore = sys.argv[2]; edited = sys.argv[3]
json.dump({"config": orig["config"]}, open(restore, "w"), ensure_ascii=False)
cfg = orig["config"]
# Edit the guard tool state: deny group_post, ask memory_search, deny hook_cancel.
tools = dict(cfg.get("tools") or {})
tools["vteam_group_post"] = "deny"
tools["vteam_memory_search"] = "ask"
tools["vteam_hook_cancel"] = "deny"
cfg["tools"] = tools
# Edit layer-1 permission too (proves DB drives the opencode.json agent entry).
perm = dict(cfg.get("permission") or {})
perm["bash"] = "deny"
cfg["permission"] = perm
json.dump({"config": cfg}, open(edited, "w"), ensure_ascii=False)
print("edit body: %s (tools=deny ask deny, permission.bash=deny)" % edited)
EOF

code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$EVIDENCE_DIR/f2-edit-$EDIT_POLICY_ID.json" "$EVIDENCE_DIR/f2-patch.json")"
[[ "$code" == "200" ]] || fail "f2" "PATCH /execution-policies/$EDIT_POLICY_ID HTTP $code (raw: $EVIDENCE_DIR/f2-patch.json)"

# The control plane must reflect the edit immediately.
code="$(curl -sS -o "$EVIDENCE_DIR/f2-postedit-agent-policies.json" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN")"
[[ "$code" == "200" ]] || fail "f2" "GET /agent-policies (post-edit) HTTP $code"
if ! python3 - "$EVIDENCE_DIR/f2-postedit-agent-policies.json" "$EDIT_POLICY_ID" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); pid = sys.argv[2]
role_name = "vteam-" + pid[len("ep_"):]
role = (d.get("guard") or {}).get("roles", {}).get(role_name)
assert role, "guard.roles lacks %s" % role_name
# todo 5: the payload carries permission only; the tool matrix that the DB edit
# targets is consumed by resolveByAgent (server gate) and is asserted live by
# scripts/e2e-permission-matrix.sh step 1, not re-emitted here.
assert sorted(role) == ["permission"], "guard role keys=%r (want ['permission'])" % sorted(role)
assert (role["permission"] or {}).get("bash") == "deny", "control-plane permission.bash not edited"
agent = next(a for a in d.get("agents") or [] if a.get("name") == role_name)
assert (agent.get("permission") or {}).get("bash") == "deny", "agents[] permission.bash not projected from the edit"
print("control-plane: %s permission reflects DB edit (tools live in resolveByAgent, asserted by e2e-permission-matrix)" % role_name)
EOF
then
  fail "f2" "control-plane /agent-policies does not reflect the edit (DB read path dead?)"
fi
pass "f2b (control-plane /agent-policies reflects the DB edit; guard role = {permission})"

# Reload the worker so its start-only injector re-fetches /agent-policies.
have_docker || inconclusive "f2" "docker unavailable; cannot reload the worker to prove injection"
log "reloading worker (restart) ..."
reload_requested_at="$(date -u +%FT%TZ)"
reload_worker
WORKER_RELOADED_FOR_F2="yes"

# fetch_injected_opencode <out> : copy the worker-injected opencode.json to the host.
fetch_injected_opencode() {
  local out="$1"
  docker_compose cp "worker:$WORKER_WORK_DIR/opencode.json" "$out" >/dev/null 2>&1 \
    || docker_compose exec -T worker cat "$WORKER_WORK_DIR/opencode.json" >"$out"
}
# injected_role_bash <out> : print the edited role's permission.bash value.
# Reads the edited role's field, not the whole file: the baseline already contains
# `"bash": "deny"` for vteam-project_manager, so a file-wide grep would pass before
# the restart finished injecting.
injected_role_bash() {
  fetch_injected_opencode "$1" || return 1
  python3 - "$1" "$EDIT_POLICY_ID" <<'PY'
import json,sys
oc=json.load(open(sys.argv[1])); pid=sys.argv[2]
name="vteam-"+pid[len("ep_"):]
entry=(oc.get("agent") or {}).get(name) or {}
print((entry.get("permission") or {}).get("bash") or "")
PY
}
# wait_worker_restarted : true once the container has actually come up again, so a stale
# pre-restart container cannot satisfy the poll below.
wait_worker_restarted() {
  local started
  started="$(docker inspect aiagents-compose-worker --format '{{.State.StartedAt}}' 2>/dev/null || true)"
  [[ -n "$started" && "$started" > "$reload_requested_at" ]]
}

deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
injected_ready=""
while [[ $SECONDS -lt $deadline ]]; do
  if wait_worker_restarted; then
    if [[ "$(injected_role_bash "$EVIDENCE_DIR/f2-injected-opencode.json" || true)" == "deny" ]]; then
      injected_ready="yes"; break
    fi
  fi
  sleep "$RESTART_INTERVAL_SEC"
done
[[ -n "$injected_ready" ]] || fail "f2" "worker opencode.json did not pick up the edit within ${RESTART_TIMEOUT_SEC}s"
# Re-fetch right before the assertions so the comparison cannot read a pre-restart file.
injected_role_bash "$EVIDENCE_DIR/f2-injected-opencode.json" >/dev/null 2>&1 || true

# todo 5: the deleted role-guard layer's persisted artifacts must be gone from the live
# worker volume (otherwise opencode would still load the removed plugin module).
if docker_compose exec -T worker test -e "$WORKER_WORK_DIR/.vteam-role-guard" 2>/dev/null; then
  fail "f2" "live worker still has $WORKER_WORK_DIR/.vteam-role-guard (deleted guard layer not purged)"
fi
if docker_compose exec -T worker grep -q 'vteam-role-guard' "$WORKER_WORK_DIR/opencode.json" 2>/dev/null; then
  fail "f2" "injected opencode.json still registers the removed vteam-role-guard plugin"
fi

# The DB edit must reach the injected opencode.json, while the other 6 built-ins stay
# byte-identical to the frozen baseline; no guard artifact may reappear.
if ! python3 - "$EVIDENCE_DIR/f2-injected-opencode.json" \
  "$BASELINE_POLICIES" "$EDIT_POLICY_ID" "$EVIDENCE_DIR/f2-injected-summary.txt" <<'EOF'
import json,sys
oc = json.load(open(sys.argv[1]))
base = json.load(open(sys.argv[2]))
pid = sys.argv[3]
report = sys.argv[4]
def canon(o): return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
role_name = "vteam-" + pid[len("ep_"):]
order = [a["name"] for a in base["agents"]]
lines = []
ok = True
oc_agents = oc.get("agent") or {}
# (i) edited role reflects the DB edit in its opencode.json agent entry.
entry = oc_agents.get(role_name) or {}
oc_bash = (entry.get("permission") or {}).get("bash")
same = oc_bash == "deny"
lines.append("opencode.agent[%s].permission.bash = %r (want 'deny'): %s" % (role_name, oc_bash, "OK" if same else "MISMATCH"))
ok = ok and same
# (ii) other 6 built-ins byte-identical to the frozen baseline agent entries (native-only).
base_agents = {a["name"]: a for a in base.get("agents") or []}
for name in order:
    if name == role_name:
        continue
    oc_perm = (oc_agents.get(name) or {}).get("permission")
    base_perm = (base_agents.get(name) or {}).get("permission")
    same_perm = canon(oc_perm) == canon(base_perm)
    lines.append("opencode.agent[%s] permission vs baseline agent[%s]: %s" % (
        name, name, "IDENTICAL" if same_perm else "MISMATCH"))
    ok = ok and same_perm
    vteam_leak = [k for k in (oc_perm or {}) if k.startswith("vteam_")]
    lines.append("opencode.agent[%s] vteam_ leak: %r" % (name, vteam_leak))
    ok = ok and not vteam_leak
# (iii) todo 5: no role-guard artifact/registration anywhere in the injected config.
plugin_entries = [p for p in (oc.get("plugin") or []) if isinstance(p, str) and "vteam-role-guard" in p]
lines.append("opencode.plugin vteam-role-guard entries: %r" % plugin_entries)
ok = ok and not plugin_entries
role_guard_section = [k for k in oc if "role-guard" in k]
lines.append("opencode top-level role-guard keys: %r" % role_guard_section)
ok = ok and not role_guard_section
open(report, "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
assert ok, "DB-driven injection / byte-identity mismatches above"
EOF
then
  fail "f2" "injected artifacts do not reflect the edit or other builtins drifted (raw: $EVIDENCE_DIR/f2-injected-summary.txt)"
fi
pass "f2c (DB edit reached injected opencode.json; other 6 builtins byte-identical; no guard artifact)" 

# Restore the original config and reload the worker; then capture after-agent-policies.json.
restore_edited_policy
log "reloading worker after restore ..."
reload_requested_at="$(date -u +%FT%TZ)"
reload_worker
deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
restored=""
while [[ $SECONDS -lt $deadline ]]; do
  if wait_worker_restarted; then
    if [[ "$(injected_role_bash "$EVIDENCE_DIR/f2-restored-opencode.json" || true)" != "deny" ]]; then
      restored="yes"; break
    fi
  fi
  sleep "$RESTART_INTERVAL_SEC"
done
[[ -n "$restored" ]] || fail "f2" "worker opencode.json did not return to factory state within ${RESTART_TIMEOUT_SEC}s"
injected_role_bash "$EVIDENCE_DIR/f2-restored-opencode.json" >/dev/null 2>&1 || true
rm -f "$EVIDENCE_DIR/f2-restored-opencode.json"

AFTER_OUT="$EVIDENCE_DIR/after-agent-policies.json"
code="$(curl -sS -o "$EVIDENCE_DIR/f2-after-raw.json" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN")"
[[ "$code" == "200" ]] || fail "f2" "GET /agent-policies (after) HTTP $code"
python3 - "$EVIDENCE_DIR/f2-after-raw.json" "$BASELINE_POLICIES" "$AFTER_OUT" "$EVIDENCE_DIR/f2-after-summary.txt" <<'EOF'
import json,sys,hashlib
live = json.load(open(sys.argv[1])); base_path = sys.argv[2]; out = sys.argv[3]; report = sys.argv[4]
def canon(o): return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
base = json.load(open(base_path))
order = [a["name"] for a in base["agents"]]
la = {a["name"]: a for a in live.get("agents") or []}
lr = (live.get("guard") or {}).get("roles") or {}
subset = {"agents": [la[n] for n in order],
          "guard": {"enabled": live["guard"]["enabled"], "roles": {n: lr[n] for n in order}}}
json.dump(subset, open(out, "w"), ensure_ascii=False, indent=2)
open(out, "a").write("\n")
base_raw = open(base_path, "rb").read()
after_raw = open(out, "rb").read()
same = hashlib.sha256(after_raw).hexdigest() == hashlib.sha256(base_raw).hexdigest()
open(report, "w").write(
    "after-agent-policies.json sha256 = %s\nbefore-agent-policies.json sha256 = %s\nbyte-identical = %s\n" %
    (hashlib.sha256(after_raw).hexdigest(), hashlib.sha256(base_raw).hexdigest(), same))
print(open(report).read().strip())
assert same, "after-agent-policies.json is not byte-identical to the frozen baseline"
EOF
pass "f2d (post-restore after-agent-policies.json byte-identical to frozen baseline)"
fi

log "ALL SCENARIOS DONE: a/c/d/e/f/f2/g"
