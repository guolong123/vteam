#!/usr/bin/env bash
#
# e2e: agent-choice surfaces after issue 3 (opencode-native-permissions-and-fixes todo 7).
#
# Proves against the LIVE compose stack (web :13001 + server :13000):
#   A. no-agent-picker.spec.ts — the SESSION page keeps whole-page zero <select>;
#      the team DETAIL page renders zero `member-external-agent*` testids (the
#      per-member picker was removed — the role editor owns the agent choice).
#   B. third-party-agents.spec.ts — the /agents 「外部 Agent」 tab stays read-only
#      and keeps proving the live engine list + warning + no-edit-controls contract.
#   C. roles-members.spec.ts — the role editor offers our agents AND external
#      engine agents in ONE `role-default-agent` control; the external⇄internal
#      slot round-trip persists across reload; the slot invariant stays visible.
#
# Prerequisite: rebuild the compose web image after web source changes:
#   docker compose build web && docker compose up -d web
#   (never --force-recreate: it re-runs init and reseeds)
#
# Run (from repo root):
#   bash scripts/e2e-agent-surfaces.sh
#   EVIDENCE_DIR=.omo/evidence/<plan> bash scripts/e2e-agent-surfaces.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/opencode-native-permissions-and-fixes}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

E2E_LOG="$EVIDENCE_DIR/task-7-agent-surfaces-e2e.txt"
: >"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.tas.playwright.config.ts" "$REPO_ROOT/web/.tas.report.json" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

cat >"$REPO_ROOT/web/.tas.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(no-agent-picker|third-party-agents|roles-members)\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".tas.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF

PW_OUT="$(mktemp)"; CLEANUP_FILES="$PW_OUT"
(cd "$REPO_ROOT/web" && \
  T2_SCREENSHOT="$EVIDENCE_DIR/task-7-external-agents.png" \
  T2_FAILURE_SCREENSHOT="$EVIDENCE_DIR/task-7-external-agents-failure.png" \
  T7_SCREENSHOT="$EVIDENCE_DIR/task-7-roles-and-members.png" \
  T7_ROLE_AGENT_SCREENSHOT="$EVIDENCE_DIR/task-7-role-agent-select.png" \
  T7_EVIDENCE_JSON="$EVIDENCE_DIR/task-7-proof.json" \
  npx playwright test --config .tas.playwright.config.ts) >"$PW_OUT" 2>&1 \
  || fail "ui" "playwright run failed (raw follows)"
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"

python3 - "$REPO_ROOT/web/.tas.report.json" >>"$E2E_LOG" <<'EOF'
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
