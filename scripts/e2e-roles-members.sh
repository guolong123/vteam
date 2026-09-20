#!/usr/bin/env bash
#
# e2e: roles tab + member⇄role linking (agent-role-entity Todo 7).
#
# Proves against the LIVE compose stack (web :13001 + server :13000):
#   A. /agents ships two tabs (Agent / 角色); the Roles tab lists the 7 builtins
#      with a builtin badge.
#   B. A builtin role is read-only with NO delete control; a custom role can be
#      created, its default agent edited + persisted (reload re-reads it), deleted.
#   C. Adding a member by role alone pre-fills the role's default agent; switching
#      the agent overrides it and the override persists (agentId=a_tester,
#      roleId=ar_developer).
#   D. The role editor's single `role-default-agent` control carries the mutually
#      exclusive internal/external slot: picking a live engine external agent
#      persists defaultOpencodeAgentName (defaultAgentId null) and survives
#      reload; switching back to internal clears the external slot (a_tester).
#
# Prerequisite: rebuild the compose web + server images after source changes:
#   docker compose build server web && docker compose up -d server web
#
# Run (from repo root):
#   bash scripts/e2e-roles-members.sh
#
# Throwaway roles/teams + their tasks are deleted in test/cleanup; receipts print.
# Screenshot: $EVIDENCE_DIR/task-7-roles-and-members.png
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/agent-role-entity}"
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
  rm -f "$REPO_ROOT/web/.t7.playwright.config.ts" "$REPO_ROOT/web/.t7.report.json" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build server web && docker compose up -d server web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.t7.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /roles-members\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".t7.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
rm -f "$EVIDENCE_DIR/task-7-proof.json"
(cd "$REPO_ROOT/web" && \
  T7_SCREENSHOT="$EVIDENCE_DIR/task-7-roles-and-members.png" \
  T7_EVIDENCE_JSON="$EVIDENCE_DIR/task-7-proof.json" \
  npx playwright test --config .t7.playwright.config.ts) >"$PW_OUT" 2>&1 \
  || fail "ui" "playwright run failed (raw follows)"
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"

[[ -f "$EVIDENCE_DIR/task-7-roles-and-members.png" ]] || fail "evidence" "missing screenshot task-7-roles-and-members.png"
pass "playwright 4/4 green; screenshot present (roles tab)"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi

python3 - "$REPO_ROOT/web/.t7.report.json" >>"$E2E_LOG" <<'EOF'
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
