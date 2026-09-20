#!/usr/bin/env bash
#
# e2e: task 原生权限可编辑 (opencode-native-permissions-and-fixes Todo 6).
#
# Proves against the LIVE compose stack (web :13001 + server :13000) that:
#   1. the `task` row renders the same editable tri-state as `bash`
#      (native-task-effect, allow/ask/deny), the old read-only
#      `native-task-note` is gone, and the replacement note makes no stale
#      guard/vteam-plan claim;
#   2. deny→ask survives a reload AND is reported the same way by the engine's
#      injection source `GET /agent-policies` — then the change is restored and
#      the stored config is byte-compared (canonical) against the pre-run value;
#   3. an illegal stored value is never displayed and a legal click always
#      writes through (no silent no-op); the only input is the three chips.
#
# Also re-runs the native rule editor spec, whose two `native-task-note`
# assertions were updated to the new editable surface in the same commit.
#
# Prerequisite: the compose web image must contain the change:
#   docker compose up -d --build web
#
# Run (from repo root):
#   bash scripts/e2e-task-permission-editable.sh
#
# Evidence: $EVIDENCE_DIR/task-6-task-editable.{png,json} + task-6-e2e.txt
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/opencode-native-permissions-and-fixes}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

E2E_LOG="$EVIDENCE_DIR/task-6-e2e.txt"
# APPEND — shared evidence; a previous run's section must never be lost.
: >>"$E2E_LOG"
{
  echo
  echo "===== todo 6 run $(date -u +%FT%TZ) ====="
  echo
} >>"$E2E_LOG"
log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; exit 1; }

CLEANUP_FILES=""
cleanup() {
  # shellcheck disable=SC2086
  rm -f $CLEANUP_FILES 2>/dev/null || true
  rm -f "$REPO_ROOT/web/.t6.playwright.config.ts" "$REPO_ROOT/web/.t6.report.json" 2>/dev/null || true
  rm -rf "$REPO_ROOT/web/test-results" 2>/dev/null || true
}
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "WEB_URL=$WEB_URL SERVER_URL=$SERVER_URL EVIDENCE_DIR=$EVIDENCE_DIR"

curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL (run: docker compose up -d --build web)"
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
log "stack healthy (web + server)"

# Pre-run snapshot of the seed policy the round-trip test edits (restore proof).
TOKEN="$(curl -sS -X POST "$SERVER_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')"
SNAP_BEFORE="$EVIDENCE_DIR/task-6-ep_product-before.json"
curl -sS "$SERVER_URL/api/v1/execution-policies/ep_product" -H "Authorization: Bearer $TOKEN" > "$SNAP_BEFORE"
SNAP_AFTER="$EVIDENCE_DIR/task-6-ep_product-after.json"
RESTORE_RECEIPT="$EVIDENCE_DIR/task-6-restore-receipt.json"

python3 - "$SNAP_BEFORE" "$E2E_LOG" <<'EOF'
import json,sys,hashlib
raw=open(sys.argv[1],'rb').read()
d=json.loads(raw)
line="[e2e] pre-run ep_product task=%s sha256=%s" % (
    d["config"]["permission"].get("task"), hashlib.sha256(raw).hexdigest())
print(line)
open(sys.argv[2],'a').write(line+"\n")
EOF

cat >"$REPO_ROOT/web/.t6.playwright.config.ts" <<'EOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(task-permission-editable|native-rule-editor)\.spec\.ts/,
  timeout: 120_000,
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
rm -f "$EVIDENCE_DIR/task-6-task-editable.json" "$EVIDENCE_DIR/task-6-task-editable.png"
PW_STATUS=0
(cd "$REPO_ROOT/web" && \
  T6_SCREENSHOT="$EVIDENCE_DIR/task-6-task-editable.png" \
  T6_SCREENSHOT_FIRST="$EVIDENCE_DIR/task-6-task-editable-first.png" \
  T6_EVIDENCE_JSON="$EVIDENCE_DIR/task-6-task-editable.json" \
  T3_EVIDENCE_JSON="$EVIDENCE_DIR/task-6-native-rule-editor.json" \
  npx playwright test --config .t6.playwright.config.ts) >"$PW_OUT" 2>&1 || PW_STATUS=$?
{
  echo "----- playwright raw -----"
  cat "$PW_OUT"
  echo "----- end playwright raw -----"
} >>"$E2E_LOG"
[[ "$PW_STATUS" -eq 0 ]] || fail "ui" "playwright run failed (raw above)"

[[ -f "$EVIDENCE_DIR/task-6-task-editable.png" ]] || fail "evidence" "missing screenshot task-6-task-editable.png"
[[ -f "$EVIDENCE_DIR/task-6-task-editable.json" ]] || fail "evidence" "missing evidence json"
pass "playwright green; screenshot + json present"

if grep -q '\[cleanup\]' "$PW_OUT"; then
  grep '\[cleanup\]' "$PW_OUT" | sed 's/^/[e2e] cleanup /' >>"$E2E_LOG"
fi

# Post-run restore proof: the seed policy must be back to its pre-run value.
curl -sS "$SERVER_URL/api/v1/execution-policies/ep_product" -H "Authorization: Bearer $TOKEN" > "$SNAP_AFTER"
RESTORE_OK=0
python3 - "$SNAP_BEFORE" "$SNAP_AFTER" "$RESTORE_RECEIPT" "$E2E_LOG" <<'EOF' || RESTORE_OK=$?
import json,sys,hashlib
def canon(v):
    return json.dumps(v, sort_keys=True, separators=(',',':'))
before=json.load(open(sys.argv[1]))["config"]
after=json.load(open(sys.argv[2]))["config"]
ok = canon(before)==canon(after)
receipt={"canonical_config_equal": ok,
         "task_before": before["permission"].get("task"),
         "task_after": after["permission"].get("task"),
         "tools_count": len(after.get("tools") or {}),
         "after_sha256": hashlib.sha256(open(sys.argv[2],'rb').read()).hexdigest()}
json.dump(receipt, open(sys.argv[3], "w"), ensure_ascii=False, indent=2, sort_keys=True)
line="[e2e] restore: task before=%s after=%s canonical_equal=%s" % (
    receipt["task_before"], receipt["task_after"], ok)
print(line)
open(sys.argv[4],'a').write(line+"\n")
sys.exit(0 if ok else 1)
EOF
[[ "$RESTORE_OK" -eq 0 ]] || fail "restore" "ep_product config did not return to its pre-run value"
pass "seed policy restored (canonical config equal)"

python3 - "$REPO_ROOT/web/.t6.report.json" "$E2E_LOG" <<'EOF' || true
import json,sys
rep=json.load(open(sys.argv[1]))
out=[]
def walk(suites):
    for s in suites or []:
        for spec in s.get("specs") or []:
            res=(spec.get("tests") or [{}])[0].get("results",[])
            ok=bool(res) and all(r.get("status")=="passed" for r in res)
            out.append("[e2e] result %s\t%s" % ("passed" if ok else "failed", spec.get("title","")))
        walk(s.get("suites"))
walk(rep.get("suites"))
open(sys.argv[2],'a').write("\n".join(out)+"\n")
print("\n".join(out))
EOF

log "all assertions PASS; evidence: $E2E_LOG"
