#!/usr/bin/env bash
#
# e2e: create-agent role picker (agent-native-permission-editor Todo 6).
#
# Proves against the LIVE compose stack (web :13001 + server :13000) that the
# create-agent modal ships a role picker whose selection changes the inherited
# execution policy:
#   A. option set = 「无」 + product/project_manager/architect/developer/tester;
#      `plan` is NOT offered (ep_plan's task:allow only applies to the literal
#      `vteam-plan` opencode name — registered in the seeded Agent row).
#   B. creating with role=developer binds the developer capability set
#      (edit['**tasks/*/**']=allow, bash=allow, non-empty tools), NOT the skeleton.
#   C. creating with 「无」 binds the deny-by-default skeleton
#      (edit={'*':'deny'}, bash=deny, tools={}).
#   D. 「无」 posts NO `role` key (undefined, never ''); developer posts role:"developer".
#
# Prerequisite (run once, per task MUST DO): the compose web image must contain
# the picker; rebuild + recreate web after changing web source:
#   docker compose build web && docker compose up -d web
#
# Run (from repo root):
#   bash scripts/e2e-create-agent-role.sh
#
# The spec creates two throwaway agents + their custom policies and deletes
# them at the end of each test (cleanup receipts are printed in the log).
# Screenshots land in $EVIDENCE_DIR/task-6-role-picker.png (modal picker) and
# *-panel.png (developer / skeleton effective-permission panels).
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
: >"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t6.playwright.config.ts" "$REPO_ROOT/web/.t6.report.json" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t6.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /create-agent-role\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".t6.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
rm -f "$EVIDENCE_DIR/task-6-proof.json"
(cd "$REPO_ROOT/web" && \
  T6_SCREENSHOT="$EVIDENCE_DIR/task-6-role-picker.png" \
  T6_SCREENSHOT_DEV_PANEL="$EVIDENCE_DIR/task-6-developer-panel.png" \
  T6_SCREENSHOT_NONE_PANEL="$EVIDENCE_DIR/task-6-none-panel.png" \
  T6_EVIDENCE_JSON="$EVIDENCE_DIR/task-6-proof.json" \
  npx playwright test --config .t6.playwright.config.ts) >"$PW_OUT" 2>&1 \
  || fail "ui" "playwright run failed (raw follows)"
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"

for shot in task-6-role-picker.png task-6-developer-panel.png task-6-none-panel.png; do
  [[ -f "$EVIDENCE_DIR/$shot" ]] || fail "evidence" "missing screenshot $shot"
done
pass "playwright 4/4 green; screenshots present (role-picker / developer-panel / none-panel)"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi
log "cleanup receipts (agent + policy DELETE + re-GET status) recorded above"

python3 - "$REPO_ROOT/web/.t6.report.json" >>"$E2E_LOG" <<'EOF'
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
