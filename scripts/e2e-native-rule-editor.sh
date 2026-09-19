#!/usr/bin/env bash
#
# e2e: native glob rule-list editor (agent-native-permission-editor Todo 3).
#
# Proves against the LIVE compose stack (web :13001 + server :13000) that the
# four native permission rows on the agents page are real controls:
#   1. all four rows always render (incl. a missing `task` key); edit/read
#      expose the glob rule editor, bash the tri-state, task is read-only + note;
#   2. a stored `{ '*':'deny', x:'ask' }` renders `ask` and re-emits `ask`
#      across an add/remove edit cycle (never coerced), `*` stays first;
#   3. switching `*` off `deny` surfaces the catch-all warning;
#   4. a duplicate glob is rejected client-side and the committed map does not grow;
#   5. bash exposes allow/ask/deny with the stored value selected.
#
# Prerequisite (run once, per task MUST DO): the compose web image must contain
# the editor; rebuild + recreate web after changing web source:
#   docker compose build web && docker compose up -d web
#
# Run (from repo root):
#   bash scripts/e2e-native-rule-editor.sh
#
# The spec creates throwaway agents + their custom policies and deletes them at
# the end of each test (cleanup receipts are printed in the log).
# Screenshot lands in $EVIDENCE_DIR/task-3-native-editor.png; JSON log in
# $EVIDENCE_DIR/task-3-native-editor.json.
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
  echo "===== todo 3 run $(date -u +%FT%TZ) ====="
  echo
} >>"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t3.playwright.config.ts" "$REPO_ROOT/web/.t3.report.json" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t3.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /native-rule-editor\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".t3.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
rm -f "$EVIDENCE_DIR/task-3-native-editor.json"
PW_STATUS=0
(cd "$REPO_ROOT/web" && \
  T3_SCREENSHOT="$EVIDENCE_DIR/task-3-native-editor.png" \
  T3_EVIDENCE_JSON="$EVIDENCE_DIR/task-3-native-editor.json" \
  npx playwright test --config .t3.playwright.config.ts) >"$PW_OUT" 2>&1 || PW_STATUS=$?
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"
[[ "$PW_STATUS" -eq 0 ]] || fail "ui" "playwright run failed (raw above)"

[[ -f "$EVIDENCE_DIR/task-3-native-editor.png" ]] || fail "evidence" "missing screenshot task-3-native-editor.png"
[[ -f "$EVIDENCE_DIR/task-3-native-editor.json" ]] || fail "evidence" "missing evidence json"
pass "playwright green; screenshot + json present"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi
log "cleanup receipts (agent + policy DELETE + re-GET status) recorded above"

python3 - "$REPO_ROOT/web/.t3.report.json" >>"$E2E_LOG" <<'EOF'
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
