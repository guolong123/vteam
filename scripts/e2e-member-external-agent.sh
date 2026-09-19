#!/usr/bin/env bash
#
# e2e: member external-agent picker on the SETTINGS surface (third-party-agent-display Todo 3).
#
# Proves against the LIVE compose stack (web :13001 + server :13000):
#   A. The team DETAIL page (/teams/[id]) hosts `member-external-agent-select`
#      (settings surface), the option list comes from the engine's external set.
#   B. Select → save → reload persists TeamMember.opencodeAgentName.
#   C. The override caveat is visible verbatim.
#   D. An engine-unknown name surfaces `member-external-agent-unknown`.
#   E. no-agent-picker.spec.ts (UPDATED, M6) stays green: the SESSION page keeps
#      whole-page zero <select>; the settings surface is the only sanctioned host.
#   F. third-party-agents.spec.ts (Todo 2) + roles-members.spec.ts stay green.
#
# Prerequisite: rebuild the compose web image after web source changes:
#   docker compose up -d --build web
#
# Run (from repo root):
#   bash scripts/e2e-member-external-agent.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/third-party-agent-display}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

E2E_LOG="$EVIDENCE_DIR/task-3-e2e.txt"
: >"$E2E_LOG"
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
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose up -d --build web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t3.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(member-external-agent|no-agent-picker|third-party-agents|roles-members)\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
rm -f "$EVIDENCE_DIR/task-3-proof.json"
(cd "$REPO_ROOT/web" && \
  T3_SCREENSHOT="$EVIDENCE_DIR/task-3-member-picker.png" \
  T3_UNKNOWN_SCREENSHOT="$EVIDENCE_DIR/task-3-member-picker-unknown.png" \
  T3_EVIDENCE_JSON="$EVIDENCE_DIR/task-3-proof.json" \
  T2_SCREENSHOT="$EVIDENCE_DIR/task-2-display.png" \
  T2_FAILURE_SCREENSHOT="$EVIDENCE_DIR/task-2-display-failure.png" \
  T7_SCREENSHOT="$EVIDENCE_DIR/task-7-roles-and-members.png" \
  T7_EVIDENCE_JSON="$EVIDENCE_DIR/task-7-proof.json" \
  npx playwright test --config .t3.playwright.config.ts) >"$PW_OUT" 2>&1 \
  || fail "ui" "playwright run failed (raw follows)"
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"

[[ -f "$EVIDENCE_DIR/task-3-member-picker.png" ]] || fail "evidence" "missing task-3-member-picker.png"

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

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi

log "all assertions PASS; evidence: $E2E_LOG"
