#!/usr/bin/env bash
#
# e2e: worker-restart notice after policy edits (agent-native-permission-editor Todo 5).
#
# Proves against the LIVE compose stack (web :13001 + server :13000) that the
# agents page permission section surfaces the worker-restart requirement:
#   1. the notice appears ONLY after a successful policy write, and says the
#      change is stored but NOT yet effective (global policy × per-worker
#      injectAll() propagation rule);
#   2. saving does NOT auto-restart any worker (restart endpoint intercepted,
#      request count must be 0);
#   3. clicking the action restarts EVERY registered worker (one request per id
#      from GET /workers), then shows the done hint;
#   4. with zero workers the empty state renders and NO dead button exists.
#
# Safety: test 2/3 intercept `**/workers/*/restart` via page.route and fulfil
# locally, so no real restart command is queued against the live worker.
#
# Prerequisite: the compose web image must contain this change:
#   docker compose build web && docker compose up -d web
#
# Run (from repo root):
#   bash scripts/e2e-policy-restart-notice.sh
#
# The spec creates throwaway agents + their custom policies and deletes them at
# the end of each test (cleanup receipts printed in the log).
# Screenshot + JSON land in $EVIDENCE_DIR (task-5-restart-notice.*).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/agent-native-permission-editor}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

E2E_LOG="$EVIDENCE_DIR/e2e.txt"
# APPEND — e2e.txt is shared evidence; a previous run's section must never be lost.
: >>"$E2E_LOG"
{
  echo
  echo "===== todo 5 run $(date -u +%FT%TZ) ====="
  echo
} >>"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t5.playwright.config.ts" "$REPO_ROOT/web/.t5.report.json" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t5.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /policy-restart-notice\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".t5.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
rm -f "$EVIDENCE_DIR/task-5-restart-notice.json"
PW_STATUS=0
(cd "$REPO_ROOT/web" && \
  T5_SCREENSHOT="$EVIDENCE_DIR/task-5-restart-notice.png" \
  T5_EVIDENCE_JSON="$EVIDENCE_DIR/task-5-restart-notice.json" \
  npx playwright test --config .t5.playwright.config.ts) >"$PW_OUT" 2>&1 || PW_STATUS=$?
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"
[[ "$PW_STATUS" -eq 0 ]] || fail "ui" "playwright run failed (raw above)"

[[ -f "$EVIDENCE_DIR/task-5-restart-notice.png" ]] || fail "evidence" "missing screenshot task-5-restart-notice.png"
[[ -f "$EVIDENCE_DIR/task-5-restart-notice.json" ]] || fail "evidence" "missing evidence json"
pass "playwright green; screenshot + json present"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi
log "cleanup receipts (agent + policy DELETE + re-GET status) recorded above"

python3 - "$REPO_ROOT/web/.t5.report.json" >>"$E2E_LOG" <<'EOF'
import json,sys
rep=json.load(open(sys.argv[1]))
def walk(suites):
    for s in suites or []:
        for spec in s.get("specs") or []:
            res=(spec.get("tests") or [{}])[0].get("results",[])
            ok=bool(res) and all(r.get("status")=="passed" for r in res)
            print("[e2e] result %s\t%s" % ("passed" if ok else "failed", spec.get("title","")))
        walk(s.get("suites"))
walk(rep.get("suites"))
EOF

log "all assertions PASS; evidence: $E2E_LOG"
