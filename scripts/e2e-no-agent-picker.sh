#!/usr/bin/env bash
#
# e2e: agent-picker removal regression (plan vteam-no-agent-picker Todo 2).
#
# Proves against the compose stack (web :13001 + server :13000, seed team
# tm_0000000001 with 计划员-1 tmm_0000000006):
#   A1 selector gone: team session page has no agent <select> in/near the
#      message input, no `message-agent-select` testid.
#   A2 @ works: typing @ shows member candidates incl 计划员-1; selecting
#      one inserts the mention.
#   A3 send works: probe send succeeds and renders; input clears; 0 console
#      errors. The probe POST is route-mocked (fulfilled, never reaches the
#      server), so shared channels keep zero residue.
#   A4 backend untouched: TeamMember.opencodeAgentName column still exists;
#      removal commit 37a1b0c touches no server/ or worker/ files; dispatch
#      fallback (policy-candidate-then-explicit in worker-dispatcher.ts)
#      still present.
#   A5 plan-member reachability: team members list contains tmm_0000000006
#      (buildTeamMemberTrigger resolves by (teamId, memberId)); no real LLM
#      execution is triggered.
#   A6 cleanup: probe text absent from the real group channel after the run.
#
# Prerequisite (run once, per task MUST DO):
#   docker compose build web && docker compose up -d --force-recreate web
# This script only VERIFIES (fails if the stack is down); it never modifies
# product source (no server/ or worker/ writes) and never pushes.
#
# Run (from repo root):
#   bash scripts/e2e-no-agent-picker.sh
#
# Rule: any failed hard assertion prints FAIL and exits non-zero. Produces
# .omo/evidence/no-agent-picker/e2e.txt with PASS/FAIL per assertion.
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
TEAM_ID="${TEAM_ID:-tm_0000000001}"
PLAN_MEMBER_ID="${PLAN_MEMBER_ID:-tmm_0000000006}"
REMOVAL_HEAD="${REMOVAL_HEAD:-37a1b0c}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/no-agent-picker}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

# ---------------------------------------------------------------- helpers
E2E_LOG="$EVIDENCE_DIR/e2e.txt"
: >"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { # $1 = assertion, $2 = reason
  printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  exit 1
}
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd git
need_cmd npx

TMP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $TMP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.nap.playwright.config.ts" 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.nap.report.json" 2>/dev/null || true
}
trap cleanup EXIT
mktmp() {
  local f
  f="$(mktemp)"
  TMP_FILES="$TMP_FILES $f"
  printf '%s' "$f"
}

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD) REMOVAL_HEAD=$REMOVAL_HEAD"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL TEAM_ID=$TEAM_ID"

# ---------------------------------------------------------------- pre: stack health (rebuild is a manual prerequisite)
curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose build web && docker compose up -d --force-recreate web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

# ---------------------------------------------------------------- UI: Playwright spec (A1/A2/A3/A5)
cat >"$REPO_ROOT/web/.nap.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /no-agent-picker\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".nap.report.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
EOF
PW_OUT="$(mktmp)"
(cd "$REPO_ROOT/web" && npx playwright test --config .nap.playwright.config.ts >"$PW_OUT" 2>&1) \
  || fail "ui" "playwright run failed (raw follows)"
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"
log "playwright exit 0; parsing per-test results ..."
RESULTS="$(mktmp)"
python3 - "$REPO_ROOT/web/.nap.report.json" >"$RESULTS" <<'EOF'
import json,sys
rep = json.load(open(sys.argv[1]))
def walk(suites):
    for s in suites or []:
        for spec in s.get("specs") or []:
            title = spec.get("title", "")
            res = (spec.get("tests") or [{}])[0].get("results", [])
            ok = bool(res) and all(r.get("status") == "passed" for r in res)
            print("%s\t%s" % ("passed" if ok else "failed", title))
        walk(s.get("suites"))
walk(rep.get("suites"))
EOF
check_ui() { # $1 = key-substring, $2 = assertion label
  if grep -q "^passed	.*$1" "$RESULTS"; then
    pass "$2"
  else
    fail "$2" "see playwright raw above ($(grep ".*$1" "$RESULTS" || echo 'missing result'))"
  fi
}
check_ui "1. 选择器消失" "A1 (selector gone: no message-agent-select, zero <select>)"
check_ui "2. @ 可用" "A2 (@ shows candidates incl 计划员-1; click inserts mention)"
check_ui "3. 发送可用" "A3 (mocked probe renders; input clears; 0 console errors)"
check_ui "4. 计划员可达" "A5 (team members contain tmm_0000000006; opencodeAgentName key kept; no LLM run)"

# ---------------------------------------------------------------- A4: backend untouched
STAT_OUT="$EVIDENCE_DIR/removal-stat.txt"
git show "$REMOVAL_HEAD" --stat >"$STAT_OUT" 2>&1 \
  || fail "A4" "git show $REMOVAL_HEAD failed"
if git diff "${REMOVAL_HEAD}^" "$REMOVAL_HEAD" -- server/ worker/ | grep -q .; then
  git diff "${REMOVAL_HEAD}^" "$REMOVAL_HEAD" --stat -- server/ worker/ | tee -a "$E2E_LOG" >/dev/null
  fail "A4" "removal commit touches server/ or worker/ (stat above)"
fi
grep -q 'opencodeAgentName' server/prisma/schema.prisma \
  || fail "A4" "TeamMember.opencodeAgentName missing from schema.prisma"
grep -q 'policyCandidateAgent' server/src/chat/worker-dispatcher.ts \
  || fail "A4" "policy-candidate fallback missing from worker-dispatcher.ts"
grep -q 'opencodeAgentName' server/src/chat/worker-dispatcher.ts \
  || fail "A4" "explicit opencodeAgentName fallback missing from worker-dispatcher.ts"
log "removal stat (web + evidence only):"
sed 's/^/[e2e]   /' "$STAT_OUT" >>"$E2E_LOG"
pass "A4 (37a1b0c touches zero server/worker files; opencodeAgentName column + policy-candidate-then-explicit fallback intact)"

# ---------------------------------------------------------------- A6: cleanup (probe never persisted)
JWT="$(curl -sS -X POST "$SERVER_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"admin123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("accessToken",""))')"
[[ -n "$JWT" ]] || fail "A6" "admin login failed"
CHAN="$(curl -sS "$SERVER_URL/api/v1/channels?teamId=$TEAM_ID" -H "Authorization: Bearer $JWT" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get("items") or []; print(next((c.get("id","") for c in items if c.get("type")=="team_group"),""))')"
[[ -n "$CHAN" ]] || fail "A6" "no team_group channel for $TEAM_ID"
if curl -sS "$SERVER_URL/api/v1/channels/$CHAN/messages?limit=100" -H "Authorization: Bearer $JWT" \
  | grep -q 'e2e-no-agent-picker probe'; then
  fail "A6" "probe text found in real group channel $CHAN"
fi
pass "A6 (probe POST was route-mocked; real group channel $CHAN has zero probe residue)"

log "all assertions PASS; evidence: $E2E_LOG"
