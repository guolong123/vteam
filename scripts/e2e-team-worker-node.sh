#!/usr/bin/env bash
#
# e2e: team / member preferred worker node (team-worker-node Todo 12).
#
# Proves against the LIVE compose stack (web :13001 + server :13000):
#   A. TEAM-level preferred worker: PATCH /api/v1/teams/:id {preferredWorkerId,
#      version} round-trips through GET /teams/:id, and ""/null clears it back to
#      null (automatic scheduling).
#   B. MEMBER choice beats TEAM: team=w_a + member=w_b ⇒ BOTH projections
#      (GET /teams/:id members[] and GET /tasks/:id instances[]) return w_b;
#      clearing the member value makes BOTH agree again (null = follow team,
#      team value still w_a) — the anti-divergence assertion for the repo's
#      recorded silent-null scar. The "falls back to w_a, not to automatic
#      scheduling" half is proven by a real dispatch (segment C1) that binds the
#      session to w_a: the DTOs echo the member's raw slot, the resolver decides.
#   C. A pin going OFFLINE falls back softly:
#      C1 pin honored (team=w_a, member cleared) → session binds to w_a
#      C2 pin honored (member=w_b, online)     → session binds to w_b
#      C3 w_b OFFLINE → one dispatch, NO 5xx, session binds to w_a (NOT w_b),
#         and the server log carries the pin-miss warning.
#   D. An unavailable pin never throws: pin = a nonexistent id (w_nope) at the
#      member level and at the TEAM level ⇒ dispatch still completes via
#      automatic scheduling (no "no available worker" error caused by the pin).
#   Plus the dangling-id API round trip: saving a nonexistent worker id returns
#      200 and round-trips verbatim (weak-validation contract), and dispatch
#      still auto-schedules (that is the deterministic half of the requirement).
#
# The DOM placeholder echo for a dangling id (a <select> showing the raw id)
# can only be proven by a browser, so it lives in the OPTIONAL Playwright branch
# below (E2E_WITH_PLAYWRIGHT=1; needs :3001 already listening). It is NEVER part
# of the success criteria and NEVER wired into scripts/gate.sh.
#
# ---------------------------------------------------------------------------
# MANDATORY PRECONDITION 1 — BUILD FIRST, THEN RECREATE (enforced in code, §PRE-1)
#   server/Dockerfile bakes prisma/ (migrations) and dist/ into the image, so a
#   bare `docker compose up -d` runs a STALE image: the new migration never
#   applies (teams/team_members.preferred_worker_id do not exist) and the new
#   PATCH field is silently stripped by the global whitelist ValidationPipe
#   (server/src/main.ts: no 400, just a value that never round-trips). This
#   script therefore runs, in this order:
#     docker compose build server web
#     docker compose down
#     (delete a completed init job so migrations + seed re-run)
#     docker compose up -d
#   and then PROVES the columns exist (information_schema guard, §PRE-1b).
#   Skipping is possible only with E2E_REBUILD=0 AND E2E_ACK_STALE_IMAGE=1
#   (loud warning + receipt); that combination is for the mutation reruns only.
#
# MANDATORY PRECONDITION 2 — TWO REAL, ADDRESSABLE WORKERS (enforced, §PRE-2)
#   compose pins container_name vteam-compose-worker and WORKER_ID=w_compose_worker
#   (docker-compose.yml), server/prisma/seed.ts creates NO Worker rows, and
#   --scale is useless (fixed container_name / fixed WORKER_ID). The only
#   workable construction is a second REAL container from the same image:
#     docker compose run -d --name vteam-e2e-worker2 \
#       -e WORKER_ID=w_e2e_second \
#       -e WORKER_ADVERTISE_HOST=http://vteam-e2e-worker2 \
#       -v vteam_e2e_worker2_data:/data/vteam-worker \
#       -v vteam_e2e_worker2_home:/root worker
#   The advertise-host flag is MANDATORY, not optional: docker-compose.yml
#   hardcodes WORKER_ADVERTISE_HOST=http://worker, `compose run` inherits it
#   verbatim, and the server's worker client resolves a node's address from
#   capabilities.baseUrl FIRST (server/src/workers/worker.client.ts) — without it
#   both nodes advertise the same address, segment C fails for the wrong reason
#   and the mutation check misattributes that failure to the fallback design.
#   Pin identity: w_a = w_compose_worker (the service container),
#                w_b = w_e2e_second   (the run container).
#   The two node volumes are separate on purpose: sharing them would put two
#   opencode instances on one opencode.db / one WORK_DIR.
#   REJECTED shortcuts (documented so nobody re-treads them):
#     (1) INSERT a workers row via mysql — markStaleWorkersOffline()
#         (workers.service.ts, onModuleInit + every 10s) flips it offline within
#         ~10s, opencode_version is NOT NULL with no default, and a DB-only node
#         is unreachable so createSession rethrows — the very 5xx segment C
#         forbids.
#     (2) scripts/worker-stub-server.py — that is a fake SERVER (control-plane
#         stub receiving register/heartbeat itself), not a worker; running it
#         adds no online node to the real :13000.
#   Fewer than two online workers ⇒ the script FAILS LOUDLY. A skipped segment
#   is never a pass: A/B/C/D must all PASS.
#
# Secrets: nothing is hardcoded. Login user/password come from E2E_USERNAME /
#   E2E_ADMIN_PASSWORD (or ADMIN_PASSWORD from the environment or the repo-root
#   .env). The DB password comes from MYSQL_ROOT_PASSWORD (the compose variable;
#   its fallback is the dev placeholder documented in docker-compose.yml). No
#   password value is ever asserted on or required to be known.
#
# Run (from repo root):
#   E2E_ADMIN_PASSWORD=<login password> bash scripts/e2e-team-worker-node.sh
#
# Throwaway team/task/DM channel + the second worker container and its volumes
# are removed in cleanup; receipts print. Evidence: $EVIDENCE_DIR/e2e.txt
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/team-worker-node}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

# node identities (see MANDATORY PRECONDITION 2 above)
W_A="${E2E_W_A:-w_compose_worker}"        # the compose `worker` service container
W_B="${E2E_W_B:-w_e2e_second}"            # the `compose run` container
W_NOPE="${E2E_W_NOPE:-w_nope_e2e_dangling}"
WORKER2_NAME="${E2E_WORKER2_NAME:-vteam-e2e-worker2}"
WORKER2_VOL_DATA="${E2E_WORKER2_VOL_DATA:-vteam_e2e_worker2_data}"
WORKER2_VOL_HOME="${E2E_WORKER2_VOL_HOME:-vteam_e2e_worker2_home}"
DB_CONTAINER="${E2E_DB_CONTAINER:-vteam-compose-db}"
SERVER_CONTAINER="${E2E_SERVER_CONTAINER:-vteam-compose-server}"
INIT_CONTAINER="${E2E_INIT_CONTAINER:-vteam-compose-init}"

# build / recreate knobs
E2E_REBUILD="${E2E_REBUILD:-1}"
E2E_ACK_STALE_IMAGE="${E2E_ACK_STALE_IMAGE:-0}"
E2E_KEEP_WORKER2="${E2E_KEEP_WORKER2:-0}"
E2E_BUILD_TIMEOUT_SEC="${E2E_BUILD_TIMEOUT_SEC:-3600}"
E2E_HEALTH_TIMEOUT_SEC="${E2E_HEALTH_TIMEOUT_SEC:-420}"
E2E_WORKER_TIMEOUT_SEC="${E2E_WORKER_TIMEOUT_SEC:-420}"
E2E_DISPATCH_TIMEOUT_SEC="${E2E_DISPATCH_TIMEOUT_SEC:-180}"

# credentials (no password literal anywhere in this file)
E2E_USERNAME="${E2E_USERNAME:-admin}"
if [[ -z "${E2E_ADMIN_PASSWORD:-}" ]]; then
  E2E_ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
fi
if [[ -z "$E2E_ADMIN_PASSWORD" && -f "$REPO_ROOT/.env" ]]; then
  E2E_ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
fi
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-vteam-root}"   # docker-compose.yml dev placeholder

# ---------------------------------------------------------------- helpers
E2E_LOG="$EVIDENCE_DIR/e2e.txt"
: >"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() {
  printf '[e2e] FAIL step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  E2E_RC=1
  exit 1
}
note() { printf '[e2e] NOTE %s\n' "$*" | tee -a "$E2E_LOG"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd docker

TMP_FILES=""
mktmp() { local f; f="$(mktemp)"; TMP_FILES="$TMP_FILES $f"; printf '%s' "$f"; }

# jget <json-file> <python-expr on `d`>
jget() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
v='"$2"'
print("" if v is None else (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))' "$1"
}

# api <METHOD> <path incl. /api/v1> [json-body] → API_CODE / API_OUT
TOKEN=""
api() {
  local method="$1" path="$2" body="${3:-}"
  API_OUT="$(mktmp)"
  local -a args=(-sS -o "$API_OUT" -w '%{http_code}' -X "$method" "$SERVER_URL$path"
                 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
  [[ -n "$body" ]] && args+=(--data "$body")
  API_CODE="$(curl "${args[@]}" || echo 000)"
}
assert2xx() { # $1 = step label
  case "$API_CODE" in
    2*) return 0 ;;
  esac
  fail "$1" "HTTP $API_CODE body=$(head -c 300 "$API_OUT" | tr '\n' ' ')"
}

# dbq <sql> : run one statement against the compose db (stdout only)
DB_OUT="$(mktmp)"; DB_ERR="$(mktmp)"
dbq() {
  docker exec "$DB_CONTAINER" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D vteam -N -e "$1" \
    >"$DB_OUT" 2>"$DB_ERR"
}

# server log slice from an RFC3339 UTC mark (docker parses the zone-less form in
# an unspecified way, so the Z is load-bearing)
slog() { docker logs --since "$1" "$SERVER_CONTAINER" 2>&1 || true; }
mark_utc() { date -u -v-2S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-2 seconds' +%Y-%m-%dT%H:%M:%SZ; }

# run ids discovered during the run (for cleanup)
TEAM_ID=""; MEMBER_ID=""; TASK_ID=""; CHANNEL_ID=""; SESSION_IDS=""
E2E_RC=0   # set to 1 by fail() and by the guard below; the only path to exit 0

cleanup() {
  local rc="${E2E_RC:-0}"
  set +e
  log "----- cleanup receipt -----"
  # 1. throwaway business data (task first: a team running a task refuses delete)
  if [[ -n "$TASK_ID" && -n "$TOKEN" ]]; then
    api DELETE "/api/v1/tasks/$TASK_ID"
    log "cleanup: DELETE /tasks/$TASK_ID -> HTTP $API_CODE"
  fi
  if [[ -n "$TEAM_ID" && -n "$TOKEN" ]]; then
    api DELETE "/api/v1/teams/$TEAM_ID"
    log "cleanup: DELETE /teams/$TEAM_ID -> HTTP $API_CODE"
    case "$API_CODE" in
      2*) ;;
      *) log "cleanup: WARNING team $TEAM_ID was NOT deleted (HTTP $API_CODE body=$(head -c 200 "$API_OUT" | tr '\n' ' ')); remove it by hand, this script will not pretend the stack is clean" ;;
    esac
  fi
  if [[ -n "$TEAM_ID" ]]; then
    if dbq "SELECT COUNT(*) FROM teams WHERE id='$TEAM_ID';"; then
      LEFT="$(head -1 "$DB_OUT" 2>/dev/null | tr -d '\r')"
      log "cleanup: db rows left in teams for $TEAM_ID = ${LEFT:-unknown}"
      [[ "${LEFT:-1}" == "0" ]] || log "cleanup: WARNING the throwaway team row survived; it is listed above for manual removal"
    fi
  fi
  # 2. the sessions this run created, by exact id (team_member_id is nulled once a
  #    session fails, so a member-scoped delete misses them) + the member-scoped
  #    delete as a fallback for any still-attached row
  local ID_LIST=""
  for sid in $SESSION_IDS; do
    [[ -n "$ID_LIST" ]] && ID_LIST="$ID_LIST,"
    ID_LIST="$ID_LIST'$sid'"
  done
  if [[ -n "$ID_LIST" ]]; then
    if dbq "DELETE FROM sessions WHERE id IN ($ID_LIST);"; then
      dbq "SELECT COUNT(*) FROM sessions WHERE id IN ($ID_LIST);"
      local LEFT; LEFT="$(head -1 "$DB_OUT" 2>/dev/null | tr -d '\r')"
      if [[ "${LEFT:-1}" == "0" ]]; then
        log "cleanup: db DELETE sessions by id ($ID_LIST) ok (0 rows left)"
      else
        log "cleanup: WARNING $LEFT session row(s) still present after the delete by id"
      fi
    else
      log "cleanup: WARNING could not delete the session rows by id: $(head -c 200 "$DB_ERR" | tr '\n' ' ')"
    fi
  fi
  if [[ -n "$MEMBER_ID" ]]; then
    dbq "DELETE FROM sessions WHERE team_member_id='$MEMBER_ID';" \
      && log "cleanup: db DELETE sessions for member $MEMBER_ID ok" \
      || log "cleanup: WARNING could not delete the member sessions: $(head -c 200 "$DB_ERR" | tr '\n' ' ')"
  fi
  # 3. the second worker row (its container is about to disappear). Child rows first:
  #    worker_model_availabilities / task_group_instances / sessions all carry an
  #    ON DELETE RESTRICT FK to workers.id.
  if [[ -n "$W_B" ]]; then
    if [[ "$E2E_KEEP_WORKER2" == "1" ]]; then
      log "cleanup: E2E_KEEP_WORKER2=1 -> kept the $W_B worker row (its container is still heartbeating)"
    else
      dbq "DELETE FROM worker_model_availabilities WHERE worker_id='$W_B';" || true
      dbq "DELETE FROM task_group_instances WHERE worker_id='$W_B';" || true
      dbq "DELETE FROM sessions WHERE worker_id='$W_B';" || true
      if dbq "DELETE FROM workers WHERE id='$W_B';"; then
        dbq "SELECT COUNT(*) FROM workers WHERE id='$W_B';"
        if [[ "$(head -1 "$DB_OUT" 2>/dev/null | tr -d '\r')" == "0" ]]; then
          log "cleanup: db DELETE workers id=$W_B ok (availabilities/instances/sessions cleared first; 0 rows left)"
        else
          log "cleanup: WARNING the $W_B worker row is still present after the delete (FK child rows left behind)"
        fi
      else
        dbq "UPDATE workers SET status='online' WHERE id='$W_B';" \
          && log "cleanup: db workers id=$W_B -> status=online (delete refused: $(head -c 160 "$DB_ERR" | tr '\n' ' '); markStaleWorkersOffline flips it offline within ~30s)" \
          || log "cleanup: db workers id=$W_B cleanup FAILED: $(head -c 200 "$DB_ERR" | tr '\n' ' ')"
      fi
    fi
  fi
  # 3. the run container + its private volumes
  if [[ "$E2E_KEEP_WORKER2" != "1" ]]; then
    docker rm -f "$WORKER2_NAME" >/dev/null 2>&1 \
      && log "cleanup: docker rm -f $WORKER2_NAME ok" \
      || log "cleanup: container $WORKER2_NAME absent (nothing to remove)"
    docker volume rm "$WORKER2_VOL_DATA" "$WORKER2_VOL_HOME" >/dev/null 2>&1 \
      && log "cleanup: docker volume rm $WORKER2_VOL_DATA $WORKER2_VOL_HOME ok" \
      || log "cleanup: worker2 volumes absent (nothing to remove)"
  else
    log "cleanup: E2E_KEEP_WORKER2=1 -> kept $WORKER2_NAME + volumes"
  fi
  # 4. temp files
  # shellcheck disable=SC2086
  rm -f $TMP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t12.playwright.config.ts" "$REPO_ROOT/web/.t12.report.json" 2>/dev/null || true
  rm -rf "$REPO_ROOT/web/.t12-worker-node" 2>/dev/null || true
  log "cleanup: temp files removed"
  # Last line of defence against a misleading exit code: the summary guard is the
  # only thing that may authorise exit 0. If the run died before it (abort, unset
  # variable, a swallowed status), the exit code is forced to 1 here rather than
  # letting the trap inherit whatever $? happened to be.
  if ! grep -q '^\[e2e\] all four segments (A/B/C/D) PASS' "$E2E_LOG"; then
    rc=1
    log "EXIT CODE OVERRIDDEN to 1: the summary guard never passed, so this run did NOT prove A/B/C/D — a skipped or unrun segment is never a pass"
  fi
  log "----- exit code: $rc -----"
  exit "$rc"
}
trap cleanup EXIT

# login_admin : obtain a JWT with the credentials resolved from the environment
# (no password literal in this file — see the header's "Secrets" paragraph).
login_admin() {
  [[ -n "$E2E_ADMIN_PASSWORD" ]] || fail "pre-auth" "$(
    printf 'no admin password supplied. Set E2E_ADMIN_PASSWORD (or ADMIN_PASSWORD, or ADMIN_PASSWORD= in the repo-root .env). This script deliberately hardcodes no password.')
  "
  local body out
  body="$(mktmp)"; out="$(mktmp)"
  printf '{"username":"%s","password":"%s"}' "$E2E_USERNAME" "$E2E_ADMIN_PASSWORD" >"$body"
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    fail "pre-auth" "login as $E2E_USERNAME failed: HTTP $code body=$(head -c 300 "$out" | tr '\n' ' ')"
  fi
  TOKEN="$(jget "$out" 'd.get("accessToken") or d.get("access_token") or ""')"
  [[ -n "$TOKEN" ]] || fail "pre-auth" "login response carried no accessToken"
  log "PRE-0 logged in as $E2E_USERNAME (token acquired, value not logged)"
}

# ===========================================================================
# PRE-0 — environment reachability (docker, compose, stack health)
# ===========================================================================
log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD) branch=$(git rev-parse --abbrev-ref HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"
log "W_A=$W_A W_B=$W_B W_NOPE=$W_NOPE WORKER2_NAME=$WORKER2_NAME"

DOCKER_VERSION_OUT="$(mktmp)"
docker version >"$DOCKER_VERSION_OUT" 2>&1
DOCKER_VERSION_RC=$?
log "PRE-0 docker version (exit=$DOCKER_VERSION_RC):"
sed 's/^/[e2e]   /' "$DOCKER_VERSION_OUT" | tee -a "$E2E_LOG"
[[ "$DOCKER_VERSION_RC" -eq 0 ]] || fail "pre-docker" "docker daemon unreachable (run 'docker version' to see the raw error)"
docker compose version >/dev/null 2>&1 || fail "pre-docker" "docker compose plugin missing"

wait_http() { # $1 url, $2 timeout
  local url="$1"
  local timeout="$2"
  local code
  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  return 1
}

PRE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null || echo 000)"
if [[ "$PRE_CODE" != "200" ]]; then
  if [[ "$E2E_REBUILD" != "1" ]]; then
    fail "pre-health" "server not healthy at $SERVER_URL (this run has E2E_REBUILD=$E2E_REBUILD, so it did not build or recreate the stack; run with E2E_REBUILD=1)"
  fi
  log "PRE-0 stack not up yet (health=$PRE_CODE) — PRE-1 will build + recreate it"
fi

# ===========================================================================
# PRE-1 — BUILD FIRST, THEN RECREATE (mandatory; see header)
# ===========================================================================
if [[ "$E2E_REBUILD" == "1" ]]; then
  BUILD_OUT="$(mktmp)"
  log "PRE-1 docker compose build server web (timeout ${E2E_BUILD_TIMEOUT_SEC}s)"
  docker compose build server web >"$BUILD_OUT" 2>&1
  BUILD_RC=$?
  tail -40 "$BUILD_OUT" | sed 's/^/[e2e] build| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose build server web exit=$BUILD_RC (full log: $BUILD_OUT is a temp file; last 40 lines above)"
  [[ "$BUILD_RC" -eq 0 ]] || fail "pre1-build" "docker compose build server web failed (exit=$BUILD_RC)"

  DOWN_OUT="$(mktmp)"
  docker compose down >"$DOWN_OUT" 2>&1
  DOWN_RC=$?
  cat "$DOWN_OUT" | sed 's/^/[e2e] down| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose down exit=$DOWN_RC"
  [[ "$DOWN_RC" -eq 0 ]] || fail "pre1-down" "docker compose down failed (exit=$DOWN_RC)"

  # a completed init job makes `up -d` reuse it and skip migrate deploy + seed
  if docker inspect "$INIT_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$INIT_CONTAINER" >/dev/null 2>&1 || true
    log "PRE-1 removed completed init job $INIT_CONTAINER so prisma migrate deploy + seed re-run"
  fi

  UP_OUT="$(mktmp)"
  log "PRE-1 docker compose up -d"
  docker compose up -d >"$UP_OUT" 2>&1
  UP_RC=$?
  cat "$UP_OUT" | sed 's/^/[e2e] up| /' | tee -a "$E2E_LOG"
  log "PRE-1 docker compose up -d exit=$UP_RC"
  [[ "$UP_RC" -eq 0 ]] || fail "pre1-up" "docker compose up -d failed (exit=$UP_RC)"
else
  log "PRE-1 SKIPPED (E2E_REBUILD=0)"
  if [[ "$E2E_ACK_STALE_IMAGE" != "1" ]]; then
    fail "pre1-stale" "E2E_REBUILD=0 requires E2E_ACK_STALE_IMAGE=1. A bare up -d on a stale image means the migration is absent (teams/team_members.preferred_worker_id missing) and the new PATCH field is silently stripped by the whitelist ValidationPipe (no 400, a value that never round-trips). Re-run with the defaults, or pass E2E_REBUILD=0 E2E_ACK_STALE_IMAGE=1."
  fi
  log "PRE-1 STALE-IMAGE ACK: E2E_ACK_STALE_IMAGE=1 — accepted by the caller (mutation rerun). The PRE-1b schema guard below still proves the columns exist."
fi

log "PRE-1 waiting for server health (timeout ${E2E_HEALTH_TIMEOUT_SEC}s)"
wait_http "$SERVER_URL/api/v1/health" "$E2E_HEALTH_TIMEOUT_SEC" \
  || fail "pre1-health" "server /api/v1/health never returned 200 within ${E2E_HEALTH_TIMEOUT_SEC}s"
log "PRE-1 server healthy; docker compose ps:"
docker compose ps | sed 's/^/[e2e] ps| /' | tee -a "$E2E_LOG"
login_admin

# PRE-1b — prove the migration actually landed (the stale-image tripwire).
SCHEMA_OK=1
for T in teams team_members; do
  if dbq "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='$T' AND column_name='preferred_worker_id';"; then
    N="$(cat "$DB_OUT")"
  else
    N="query-failed: $(head -c 200 "$DB_ERR" | tr '\n' ' ')"
  fi
  log "PRE-1b information_schema $T.preferred_worker_id count=$N"
  [[ "$N" == "1" ]] || SCHEMA_OK=0
done
[[ "$SCHEMA_OK" -eq 1 ]] || fail "pre1-schema" "$(
  printf 'the preferred_worker_id columns do not exist: the running server image is STALE. Fix: docker compose build server web && docker compose down && docker compose up -d (the migration is baked into the image by server/Dockerfile). This run had E2E_REBUILD=%s.' "$E2E_REBUILD")
)"
log "PRE-1b schema guard PASS (both columns exist → migrations ran on this image)"

# ===========================================================================
# PRE-2 — two REAL, addressable workers (mandatory; see header)
# ===========================================================================
log "PRE-2 ensuring a second REAL worker container ($WORKER2_NAME, WORKER_ID=$W_B)"
if docker inspect "$WORKER2_NAME" >/dev/null 2>&1; then
  RUNNING="$(docker inspect -f '{{.State.Running}}' "$WORKER2_NAME" 2>/dev/null || echo false)"
  if [[ "$RUNNING" == "true" ]]; then
    log "PRE-2 $WORKER2_NAME already running — reusing it"
  else
    docker rm -f "$WORKER2_NAME" >/dev/null 2>&1 || true
  fi
fi

if ! docker inspect "$WORKER2_NAME" >/dev/null 2>&1; then
  # stale volumes from an aborted earlier run would hide a broken bootstrap
  docker volume rm "$WORKER2_VOL_DATA" "$WORKER2_VOL_HOME" >/dev/null 2>&1 || true
  RUN_OUT="$(mktmp)"
  # WORKER_ADVERTISE_HOST is MANDATORY: compose hardcodes http://worker and
  # `compose run` inherits it verbatim, while the server resolves a node's
  # address from capabilities.baseUrl FIRST — without this flag both nodes
  # advertise the same address and segment C fails for the wrong reason.
  docker compose run -d --name "$WORKER2_NAME" \
    -e "WORKER_ID=$W_B" \
    -e "WORKER_ADVERTISE_HOST=http://$WORKER2_NAME" \
    -v "$WORKER2_VOL_DATA:/data/vteam-worker" \
    -v "$WORKER2_VOL_HOME:/root" \
    worker >"$RUN_OUT" 2>&1
  RUN_RC=$?
  cat "$RUN_OUT" | sed 's/^/[e2e] run| /' | tee -a "$E2E_LOG"
  log "PRE-2 docker compose run -d --name $WORKER2_NAME -e WORKER_ID=$W_B -e WORKER_ADVERTISE_HOST=http://$WORKER2_NAME -v $WORKER2_VOL_DATA:/data/vteam-worker -v $WORKER2_VOL_HOME:/root worker exit=$RUN_RC"
  [[ "$RUN_RC" -eq 0 ]] || fail "pre2-run" "could not start the second worker container (exit=$RUN_RC; raw above)"
fi

wait_two_online() { # $1 timeout
  local deadline=$(( $(date +%s) + $1 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if dbq "SELECT COUNT(*) FROM workers WHERE id IN ('$W_A','$W_B') AND status <> 'offline';"; then
      if [[ "$(cat "$DB_OUT")" == "2" ]]; then return 0; fi
    fi
    sleep 3
  done
  return 1
}
log "PRE-2 waiting for TWO online workers (timeout ${E2E_WORKER_TIMEOUT_SEC}s)"
wait_two_online "$E2E_WORKER_TIMEOUT_SEC" || fail "pre2-workers" "$(
  printf 'fewer than two online workers (%s and %s) after %ss — this script FAILS LOUDLY instead of skipping: A/B/C/D must all PASS. Raw worker rows: ' "$W_A" "$W_B" "$E2E_WORKER_TIMEOUT_SEC"; \
  dbq "SELECT id, status, last_heartbeat_at FROM workers ORDER BY id;" && cat "$DB_OUT" || echo '(db query failed)')
"
log "PRE-2 two online workers confirmed (db):"
dbq "SELECT id, status, opencode_version, last_heartbeat_at FROM workers WHERE id IN ('$W_A','$W_B') ORDER BY id;"
sed 's/^/[e2e] db| /' "$DB_OUT" | tee -a "$E2E_LOG"

# the advertise-host tripwire: the two nodes must NOT resolve to one address
login_admin
api GET "/api/v1/workers/$W_A"; assert2xx "pre2-workers-a"
BASE_A="$(jget "$API_OUT" 'd.get("capabilities",{}).get("baseUrl")')"
api GET "/api/v1/workers/$W_B"; assert2xx "pre2-workers-b"
BASE_B="$(jget "$API_OUT" 'd.get("capabilities",{}).get("baseUrl")')"
log "PRE-2 capabilities.baseUrl: $W_A=$BASE_A $W_B=$BASE_B"
[[ -n "$BASE_A" && "$BASE_A" != "None" && -n "$BASE_B" && "$BASE_B" != "None" ]] \
  || fail "pre2-baseurl" "a worker published no capabilities.baseUrl (a=$BASE_A b=$BASE_B); the server resolves node addresses from baseUrl FIRST, so segment C could not tell the nodes apart"
[[ "$BASE_A" != "$BASE_B" ]] || fail "pre2-baseurl" "$(
  printf 'both workers advertise the same baseUrl (%s). WORKER_ADVERTISE_HOST was not overridden for %s — docker-compose.yml hardcodes http://worker and the server prefers capabilities.baseUrl, so both nodes would resolve to one address.' "$BASE_A" "$WORKER2_NAME")
"
pass "PRE-2 two real, addressable workers online with distinct baseUrls"

# ===========================================================================
# Setup — one throwaway team with ONE agent member, which is also the main agent
#   (a DM dispatch is gated to the main member when no task is in progress)
#   Members must carry a roleId (Q5: no role-less members), so the role is
#   discovered from the API rather than hardcoded.
# ===========================================================================
api GET "/api/v1/agents?page=1&pageSize=100"
assert2xx "setup-agents"
AGENTS_JSON="$API_OUT"
api GET "/api/v1/agent-roles?page=1&pageSize=100"
assert2xx "setup-roles"
ROLE_ID="$(python3 -c 'import json,sys
roles=json.load(open(sys.argv[1]))
agents={a["id"]:a for a in (json.load(open(sys.argv[2])).get("items") or [])}
items=roles.get("items") or []
no_model=[r for r in items if r.get("defaultAgentId") and not (agents.get(r["defaultAgentId"]) or {}).get("defaultModelId")]
pick=(no_model or [r for r in items if r.get("defaultAgentId")] or items or [{}])[0]
print(pick.get("id",""))' "$API_OUT" "$AGENTS_JSON")"
[[ -n "$ROLE_ID" ]] || fail "setup-roles" "GET /agent-roles returned no usable role (no defaultAgentId to prefill the member)"
api GET "/api/v1/agent-roles/$ROLE_ID"; assert2xx "setup-role-get"
AGENT_ID="$(jget "$API_OUT" 'd.get("defaultAgentId") or ""')"
[[ -n "$AGENT_ID" ]] || fail "setup-role" "role $ROLE_ID has no defaultAgentId to prefill the member"
log "setup role=$ROLE_ID agent=$AGENT_ID (first agent with no default model, so the dispatch model chain stays empty and B1 cannot mask the pin)"

TEAM_NAME="e2e-twn-$(date -u +%H%M%S)"
api POST "/api/v1/teams" "$(printf '{"name":"%s","description":"throwaway (scripts/e2e-team-worker-node.sh)","members":[{"roleId":"%s"}],"mainAgentMemberId":"0"}' "$TEAM_NAME" "$ROLE_ID")"
assert2xx "setup-team"
TEAM_ID="$(jget "$API_OUT" 'd.get("id")')"
MEMBER_ID="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
ms=d.get("members") or []
print(ms[0].get("id","") if ms else "")' "$API_OUT")"
[[ -n "$TEAM_ID" && -n "$MEMBER_ID" ]] || fail "setup-team" "team/member id missing from create response"
log "setup team=$TEAM_ID member=$MEMBER_ID mainAgentMemberId=$(jget "$API_OUT" 'd.get("mainAgentMemberId")')"
api GET "/api/v1/teams/$TEAM_ID"; assert2xx "setup-team-get"
MAIN_ID="$(jget "$API_OUT" 'd.get("mainAgentMemberId")')"
[[ "$MAIN_ID" == "$MEMBER_ID" ]] || fail "setup-team" "$(
  printf 'the team member (%s) is not the main agent (%s); a DM dispatch would be dropped by the main-agent gate and C/D could never prove anything' "$MEMBER_ID" "$MAIN_ID")
"

team_version() { api GET "/api/v1/teams/$TEAM_ID"; assert2xx "team-version"; jget "$API_OUT" 'd.get("version")'; }
team_pin()    { api GET "/api/v1/teams/$TEAM_ID"; assert2xx "team-pin";    jget "$API_OUT" 'd.get("preferredWorkerId") or ""'; }
member_pin()  { api GET "/api/v1/teams/$TEAM_ID"; assert2xx "member-pin"
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for m in d.get("members") or []:
    if m.get("id")==sys.argv[2]: print(m.get("preferredWorkerId") or "")
' "$API_OUT" "$MEMBER_ID"
}
instance_pin() { api GET "/api/v1/tasks/$TASK_ID"; assert2xx "instance-pin"
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for i in d.get("instances") or []:
    if i.get("id")==sys.argv[2]: print(i.get("preferredWorkerId") or "")
' "$API_OUT" "$MEMBER_ID"
}
patch_team() { api PATCH "/api/v1/teams/$TEAM_ID" "$1"; assert2xx "patch-team"; }
patch_member() { api PATCH "/api/v1/teams/$TEAM_ID/members/$MEMBER_ID" "$1"; assert2xx "patch-member"; }

# ===========================================================================
# A — TEAM-level preferred worker round trip + clear-back-to-null
# ===========================================================================
V="$(team_version)"
patch_team "$(printf '{"preferredWorkerId":"%s","version":%s}' "$W_A" "$V")"
GOT="$(team_pin)"
[[ "$GOT" == "$W_A" ]] || fail "A" "PATCH preferredWorkerId=$W_A then GET returned '$GOT'"
log "A PATCH team preferredWorkerId=$W_A → GET returns $GOT"

patch_team "$(printf '{"preferredWorkerId":"","version":%s}' "$(team_version)")"
GOT="$(team_pin)"
[[ -z "$GOT" ]] || fail "A" "PATCH preferredWorkerId=\"\" then GET returned '$GOT' (expected null = automatic scheduling)"
log "A PATCH team preferredWorkerId=\"\" → GET returns null (automatic scheduling)"

patch_team "$(printf '{"preferredWorkerId":null,"version":%s}' "$(team_version)")"
GOT="$(team_pin)"
[[ -z "$GOT" ]] || fail "A" "PATCH preferredWorkerId=null then GET returned '$GOT' (expected null)"
log "A PATCH team preferredWorkerId=null → GET returns null"
pass "A team-level preferred worker set / cleared via PATCH + GET round trip"

# ===========================================================================
# B — MEMBER choice beats TEAM, in BOTH projections (the anti-divergence pair)
# ===========================================================================
patch_team "$(printf '{"preferredWorkerId":"%s","version":%s}' "$W_A" "$(team_version)")"
patch_member "$(printf '{"preferredWorkerId":"%s"}' "$W_B")"
api POST "/api/v1/tasks" "$(printf '{"title":"e2e-twn-%s","teamId":"%s"}' "$(date -u +%H%M%S)" "$TEAM_ID")"
assert2xx "B-task"
TASK_ID="$(jget "$API_OUT" 'd.get("id")')"
[[ -n "$TASK_ID" ]] || fail "B" "task create returned no id"

TM="$(member_pin)"; TI="$(instance_pin)"
[[ "$TM" == "$W_B" ]] || fail "B" "member pin in GET /teams/:id is '$TM', expected $W_B (member must beat team)"
[[ "$TI" == "$W_B" ]] || fail "B" "member pin in GET /tasks/:id instances[] is '$TI', expected $W_B (the two projections diverged — the recorded silent-null scar)"
log "B team=$W_A + member=$W_B → GET /teams/:id member=$TM AND GET /tasks/:id instance=$TI (both $W_B)"

patch_member '{"preferredWorkerId":null}'
TM="$(member_pin)"; TI="$(instance_pin)"; TP="$(team_pin)"
[[ -z "$TM" && -z "$TI" ]] || fail "B" "after clearing the member pin the projections returned team='$TM' task='$TI' (expected both null)"
[[ "$TP" == "$W_A" ]] || fail "B" "team pin drifted to '$TP' while clearing the member pin"
log "B member cleared → GET /teams/:id member=$TM (null) AND GET /tasks/:id instance=$TI (null), team still $TP"
log "B NOTE the DTOs echo the member's raw slot (null = follow team); that the effect falls back to $W_A — not to automatic scheduling — is proven by the dispatch in C1 below"
pass "B member choice beats team in both projections and both agree after clearing"

# ===========================================================================
# Dispatch machinery — a DM channel + one message = exactly one real dispatch
#   The member session is RESET before every dispatch: a healthy already-bound
#   session is reused verbatim and never consults the pin, so without a reset
#   segment C could not observe the pin at all.
# ===========================================================================
dispatch_once() { # $1 label
  local label="$1"
  api POST "/api/v1/teams/$TEAM_ID/members/$MEMBER_ID/reset-session" '{}'
  assert2xx "reset-session($label)"
  api POST "/api/v1/dm-channels" "$(printf '{"teamId":"%s","teamMemberId":"%s"}' "$TEAM_ID" "$MEMBER_ID")"
  assert2xx "dm-channel($label)"
  CHANNEL_ID="$(jget "$API_OUT" 'd.get("id")')"
  [[ -n "$CHANNEL_ID" ]] || fail "dispatch($label)" "dm channel create returned no id"
  DISPATCH_MARK="$(mark_utc)"
  api POST "/api/v1/channels/$CHANNEL_ID/messages" \
    "$(printf '{"text":"[e2e team-worker-node %s] dispatch probe %s"}' "$label" "$(date -u +%FT%TZ)")"
  assert2xx "dispatch-trigger($label)"
  log "dispatch($label): message POST -> HTTP $API_CODE channel=$CHANNEL_ID (fire-and-forget; the binding is read back from the DB)"
}

# sessions/workers columns are snake_case in MySQL (Prisma @map), NOT the
# camelCase field names the API uses — a camelCase query errors out, and a silent
# error here would look exactly like "never bound".
# Output: "<session id> <worker id>". The id is captured because the platform
# nulls team_member_id once a session fails, so a member-scoped delete in cleanup
# would miss exactly the rows this script created.
session_row() {
  if dbq "SELECT id, worker_id FROM sessions WHERE team_member_id='$MEMBER_ID' AND status <> 'archived' ORDER BY created_at DESC LIMIT 1;"; then
    head -1 "$DB_OUT" 2>/dev/null | tr -d '\r' | tr '\t' ' '
  else
    printf 'DB_QUERY_FAILED:%s' "$(head -c 160 "$DB_ERR" | tr '\n' ' ')"
  fi
}
wait_bound() { # $1 timeout; sets SESSION_ID + SESSION_WORKER
  local deadline=$(( $(date +%s) + $1 )) row
  while [[ $(date +%s) -lt $deadline ]]; do
    row="$(session_row)"
    case "$row" in
      DB_QUERY_FAILED*) SESSION_ID=""; SESSION_WORKER="$row"; return 1 ;;
    esac
    SESSION_ID="${row%% *}"
    SESSION_WORKER="${row##* }"
    if [[ -n "$SESSION_WORKER" && "$SESSION_WORKER" != "NULL" ]]; then
      SESSION_IDS="$SESSION_IDS $SESSION_ID"
      return 0
    fi
    sleep 2
  done
  SESSION_WORKER=""
  return 1
}
worker_status() {
  dbq "SELECT status FROM workers WHERE id='$1';" || true
  head -1 "$DB_OUT" 2>/dev/null | tr -d '\r'
}
# Both transitions are heartbeat-driven: the row only changes when the worker
# itself speaks (or stops speaking) — see the C3 note about heartbeat().
wait_offline() { # $1 worker id, $2 timeout
  local deadline=$(( $(date +%s) + $2 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    [[ "$(worker_status "$1")" == "offline" ]] && return 0
    sleep 3
  done
  return 1
}
wait_not_offline() { # $1 worker id, $2 timeout
  local deadline=$(( $(date +%s) + $2 )) st
  while [[ $(date +%s) -lt $deadline ]]; do
    st="$(worker_status "$1")"
    [[ -n "$st" && "$st" != "offline" ]] && return 0
    sleep 3
  done
  return 1
}
log_slice() { slog "$1" | tee -a "$E2E_LOG"; }

# ===========================================================================
# C — pinned node behavior: honored, then OFFLINE ⇒ soft fallback
# ===========================================================================
# C1 (positive control): member cleared + team=w_a ⇒ the session MUST bind to w_a
dispatch_once "C1"
wait_bound "$E2E_DISPATCH_TIMEOUT_SEC" || fail "C1" "no session bound within ${E2E_DISPATCH_TIMEOUT_SEC}s after the dispatch probe"
[[ "$SESSION_WORKER" == "$W_A" ]] || fail "C1" "session bound to '$SESSION_WORKER', expected the team pin $W_A (the pin is not honored when it should be)"
log "C1 session bound worker=$SESSION_WORKER (team pin $W_A honored)"

# C2: member=w_b (online) ⇒ the session MUST bind to w_b (member beats team)
patch_member "$(printf '{"preferredWorkerId":"%s"}' "$W_B")"
dispatch_once "C2"
wait_bound "$E2E_DISPATCH_TIMEOUT_SEC" || fail "C2" "no session bound within ${E2E_DISPATCH_TIMEOUT_SEC}s"
[[ "$SESSION_WORKER" == "$W_B" ]] || fail "C2" "session bound to '$SESSION_WORKER', expected the member pin $W_B (member choice did not win)"
log "C2 session bound worker=$SESSION_WORKER (member pin $W_B honored, team pin $W_A overridden)"

# C3: take w_b OFFLINE, then dispatch once more.
#   A bare `UPDATE workers SET status='offline'` is NOT enough: the worker is
#   still running and heartbeat() rewrites status=online every 10s. The node must
#   actually stop heartbeating, after which markStaleWorkersOffline()
#   (lastHeartbeatAt < now-30s, checked every 10s) flips the row — so stop the
#   container and WAIT for the transition, self-verified against the DB.
if ! docker stop "$WORKER2_NAME" >/dev/null 2>&1; then
  fail "C3" "could not stop the $WORKER2_NAME container (the pinned node must really go offline)"
fi
log "C3 docker stop $WORKER2_NAME -> ok; waiting for the DB row to flip offline (markStaleWorkersOffline, up to 120s)"
if ! wait_offline "$W_B" 120; then
  W_B_STATUS="$(worker_status "$W_B")"
  fail "C3" "$W_B never reached status=offline after being stopped (db status: '${W_B_STATUS:-<no row>}'); the pin-miss branch could not be exercised, and this script never substitutes a guess for the real state"
fi
log "C3 db: $W_B -> offline"
dispatch_once "C3"
wait_bound "$E2E_DISPATCH_TIMEOUT_SEC" || fail "C3" "no session bound within ${E2E_DISPATCH_TIMEOUT_SEC}s after taking $W_B offline (the dispatch failed instead of falling back)"
[[ "$SESSION_WORKER" != "$W_B" ]] || fail "C3" "session still bound to the offline node $W_B"
[[ "$SESSION_WORKER" == "$W_A" ]] || fail "C3" "session bound to '$SESSION_WORKER', expected the remaining node $W_A"
C3_SLICE="$(log_slice "$DISPATCH_MARK")"
grep -q "assignWorker 首选 worker $W_B 未命中" <<<"$C3_SLICE" \
  || fail "C3" "the server log slice has no pin-miss warning (assignWorker 首选 worker $W_B 未命中); soft fallback was not observable"
grep -q "无可用 worker" <<<"$C3_SLICE" \
  && fail "C3" "the server log slice contains '无可用 worker' — the pin blocked scheduling"
grep -qE "dispatch failed|dispatchForTeamTarget" <<<"$C3_SLICE" \
  && fail "C3" "the server log slice contains a dispatch failure; the dispatch did not complete"
log "C3 warn line: $(grep 'assignWorker 首选 worker' <<<"$C3_SLICE" | head -1)"
log "C3 session bound worker=$SESSION_WORKER (not the offline $W_B); no 5xx-class dispatch failure in the server log slice"
pass "C pinned node offline → soft fallback, no 5xx, pin-miss warning logged"

# ===========================================================================
# D — an unavailable pin never throws (dangling id at member AND team level)
# ===========================================================================
# segment D needs a REAL node to fall back to: the row only leaves offline when
# the restarted worker's next heartbeat lands, hence the wait (both directions
# are heartbeat-driven — see C3's note on why a DB UPDATE alone is not enough).
if ! docker start "$WORKER2_NAME" >/dev/null 2>&1; then
  fail "D" "could not restart the $WORKER2_NAME container for the dangling-pin segments"
fi
log "D docker start $WORKER2_NAME -> ok; waiting for the DB row to leave offline (up to 120s)"
if ! wait_not_offline "$W_B" 120; then
  fail "D" "$W_B is still offline 120s after the restart (db status: '$(worker_status "$W_B")'); the dangling-pin segments need a real node to fall back to"
fi
log "D restored $W_B -> $(worker_status "$W_B")"

# D1 member-level dangling pin: weak validation ⇒ 200 + verbatim round trip
patch_member "$(printf '{"preferredWorkerId":"%s"}' "$W_NOPE")"
GOT="$(member_pin)"
[[ "$GOT" == "$W_NOPE" ]] || fail "D1" "PATCH member preferredWorkerId=$W_NOPE returned '$GOT' (the dangling id must round-trip verbatim: weak validation, no existence check)"
log "D1 dangling member pin $W_NOPE saved and round-tripped verbatim (HTTP 2xx, no existence check)"
dispatch_once "D1"
wait_bound "$E2E_DISPATCH_TIMEOUT_SEC" || fail "D1" "no session bound within ${E2E_DISPATCH_TIMEOUT_SEC}s with a dangling pin"
[[ "$SESSION_WORKER" != "$W_NOPE" ]] || fail "D1" "session bound to the nonexistent $W_NOPE"
[[ "$SESSION_WORKER" == "$W_A" || "$SESSION_WORKER" == "$W_B" ]] || fail "D1" "session bound to '$SESSION_WORKER', expected a real node ($W_A or $W_B)"
D1_SLICE="$(log_slice "$DISPATCH_MARK")"
grep -q "无可用 worker" <<<"$D1_SLICE" && fail "D1" "'无可用 worker' raised because of the unavailable pin"
grep -qE "dispatch failed|dispatchForTeamTarget" <<<"$D1_SLICE" && fail "D1" "dispatch failure in the server log slice"
log "D1 session bound worker=$SESSION_WORKER (automatic scheduling, pin ignored); warn: $(grep 'assignWorker 首选 worker' <<<"$D1_SLICE" | head -1)"

# D2 team-level dangling pin (the mutation-check scenario)
patch_member '{"preferredWorkerId":null}'
patch_team "$(printf '{"preferredWorkerId":"%s","version":%s}' "$W_NOPE" "$(team_version)")"
GOT="$(team_pin)"
[[ "$GOT" == "$W_NOPE" ]] || fail "D2" "team pin '$GOT' != dangling $W_NOPE"
dispatch_once "D2"
wait_bound "$E2E_DISPATCH_TIMEOUT_SEC" || fail "D2" "no session bound within ${E2E_DISPATCH_TIMEOUT_SEC}s with a dangling TEAM pin"
[[ "$SESSION_WORKER" != "$W_NOPE" ]] || fail "D2" "session bound to the nonexistent $W_NOPE"
[[ "$SESSION_WORKER" == "$W_A" || "$SESSION_WORKER" == "$W_B" ]] || fail "D2" "session bound to '$SESSION_WORKER', expected a real node"
D2_SLICE="$(log_slice "$DISPATCH_MARK")"
grep -q "无可用 worker" <<<"$D2_SLICE" && fail "D2" "'无可用 worker' raised because of the unavailable TEAM pin"
grep -qE "dispatch failed|dispatchForTeamTarget" <<<"$D2_SLICE" && fail "D2" "dispatch failure in the server log slice"
log "D2 team pin $W_NOPE (dangling) → session bound worker=$SESSION_WORKER; warn: $(grep 'assignWorker 首选 worker' <<<"$D2_SLICE" | head -1)"
pass "D unavailable/dangling pin (member and team) → dispatch still auto-schedules, no throw"

# leave the stack in a neutral state for the next run (after the optional
# Playwright branch, which needs the dangling id still selected)
if [[ "${E2E_WITH_PLAYWRIGHT:-0}" != "1" ]]; then
  patch_team "$(printf '{"preferredWorkerId":null,"version":%s}' "$(team_version)")"
  log "final state: team pin='$(team_pin)' member pin='$(member_pin)' (both cleared)"
fi

# ===========================================================================
# OPTIONAL Playwright branch — DOM placeholder echo for a dangling id.
# NEVER part of the success criteria, NEVER wired into scripts/gate.sh.
# ===========================================================================
if [[ "${E2E_WITH_PLAYWRIGHT:-0}" == "1" ]]; then
  PW_SPEC_DIR="$REPO_ROOT/web/.t12-worker-node"
  mkdir -p "$PW_SPEC_DIR"
  cat >"$REPO_ROOT/web/.t12.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./.t12-worker-node",
  testMatch: /t12-worker-node\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3001", channel: "chrome", trace: "off" },
});
EOF
  cat >"$PW_SPEC_DIR/t12-worker-node.spec.ts" <<'EOF'
import { test, expect } from "@playwright/test";

const TEAM_ID = process.env.T12_TEAM_ID ?? "";
const DANGLING = process.env.T12_DANGLING_WORKER ?? "";

test("dangling worker id still renders in the team select (OPTIONAL, non-gating)", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("username").fill(process.env.T12_USERNAME ?? "admin");
  await page.getByTestId("password").fill(process.env.T12_PASSWORD ?? "");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 30_000 });
  await page.goto(`/teams/${TEAM_ID}`);
  const sel = page.getByTestId("team-worker-select");
  await expect(sel).toBeVisible({ timeout: 30_000 });
  await expect(sel).toHaveValue(DANGLING, { timeout: 15_000 });
  await expect(page.locator(`option[value="${DANGLING}"]`)).toHaveCount(1);
});
EOF
  if curl -sS -o /dev/null -w '%{http_code}' "http://localhost:3001/login" 2>/dev/null | grep -q '^200$'; then
    PW_OUT="$(mktmp)"
    (cd "$REPO_ROOT/web" && T12_TEAM_ID="$TEAM_ID" T12_DANGLING_WORKER="$W_NOPE" \
      T12_USERNAME="$E2E_USERNAME" T12_PASSWORD="$E2E_ADMIN_PASSWORD" \
      npx playwright test --config .t12.playwright.config.ts) >"$PW_OUT" 2>&1
    PW_RC=$?
    cat "$PW_OUT" | sed 's/^/[e2e] pw| /' | tee -a "$E2E_LOG"
    if [[ "$PW_RC" -ne 0 ]]; then
      fail "optional-playwright" "E2E_WITH_PLAYWRIGHT=1 was requested and the branch failed (exit=$PW_RC; raw above)"
    fi
    pass "OPTIONAL Playwright: dangling id renders in the team select (non-gating branch)"
    patch_team "$(printf '{"preferredWorkerId":null,"version":%s}' "$(team_version)")"
    log "final state: team pin='$(team_pin)' member pin='$(member_pin)' (both cleared)"
  else
    log "OPTIONAL Playwright SKIPPED: nothing is listening on :3001. This branch is explicitly NOT a success criterion (the DOM placeholder echo for a dangling id has no automatic guard this round — recorded as non-blocking)."
  fi
else
  log "OPTIONAL Playwright not requested (E2E_WITH_PLAYWRIGHT != 1). The DOM placeholder echo for a dangling id therefore has NO automatic guard this round — recorded as non-blocking, never a success criterion, and never part of scripts/gate.sh."
fi

# ===========================================================================
# Summary — an anti-skip guard that re-reads the raw log
# ===========================================================================
for SEG in A B C D; do
  grep -q "^\[e2e\] PASS $SEG " "$E2E_LOG" || fail "summary" "segment $SEG has no PASS line in $E2E_LOG — a skipped or unrun segment is never a pass"
done
log "----- assertions -----"
grep '^\[e2e\] PASS ' "$E2E_LOG" | sed 's/^/[e2e] /' | tee -a "$E2E_LOG"
log "all four segments (A/B/C/D) PASS against the live stack; evidence: $E2E_LOG"
log "workers at exit:"
dbq "SELECT id, status FROM workers ORDER BY id;" && sed 's/^/[e2e] db| /' "$DB_OUT" | tee -a "$E2E_LOG" || true
log "done"
