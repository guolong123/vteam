#!/usr/bin/env bash
#
# e2e: serialized policy writes (agent-native-permission-editor Todo 4).
#
# Proves against the LIVE compose stack (web :13001 + server :13000) that native
# permission edits and MCP tool toggles share ONE mutation with ONE in-flight
# gate and a config built from the freshest client state:
#   1. no lost update — bash switch + add edit rule in one burst, stored config
#      contains BOTH, and both survive a reload;
#   2. in-flight gate — while a PATCH is held (page.route), every native editor
#      input/chip AND every MCP tool select is disabled, re-enabled on release;
#   3. native edit persists — bash allow survives reload;
#   4. debounce coalesces a keystroke burst into exactly ONE PATCH.
#
# Prerequisite: the compose web image must contain this change:
#   docker compose build web && docker compose up -d web
#
# Run (from repo root):
#   bash scripts/e2e-policy-serialize.sh
#
# The spec creates throwaway agents + their custom policies and deletes them at
# the end of each test (cleanup receipts printed in the log).
# Screenshot/JSON land in $EVIDENCE_DIR (task-4-serialized.json).
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
  echo "===== todo 4 run $(date -u +%FT%TZ) ====="
  echo
} >>"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t4.playwright.config.ts" "$REPO_ROOT/web/.t4.report.json" 2>/dev/null || true
  rm -rf "$REPO_ROOT/web/.t4-trace" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t4.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /policy-serialize\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".t4.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
rm -f "$EVIDENCE_DIR/task-4-serialized.json"
PW_STATUS=0
(cd "$REPO_ROOT/web" && \
  T4_EVIDENCE_JSON="$EVIDENCE_DIR/task-4-serialized.json" \
  npx playwright test --config .t4.playwright.config.ts) >"$PW_OUT" 2>&1 || PW_STATUS=$?
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"
[[ "$PW_STATUS" -eq 0 ]] || fail "ui" "playwright run failed (raw above)"

[[ -f "$EVIDENCE_DIR/task-4-serialized.json" ]] || fail "evidence" "missing evidence json"
pass "playwright green; evidence json present"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi
log "cleanup receipts (agent + policy DELETE + re-GET status) recorded above"

python3 - "$REPO_ROOT/web/.t4.report.json" >>"$E2E_LOG" <<'EOF'
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
