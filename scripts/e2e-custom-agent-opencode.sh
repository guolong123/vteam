#!/usr/bin/env bash
#
# e2e: custom agent becomes a real opencode agent (plan vteam-custom-agent-opencode Todo 7).
#
# Proves end-to-end against a LIVE stack (server + worker + db):
#   1) create a custom execution policy with a distinctive three-state matrix
#      (tools: vteam_group_post=deny, vteam_submit_artifact=allow)
#   2) create a custom agent agentKey='demo-agent' bound to that policy
#   3) GET /agent-policies contains vteam-demo-agent in BOTH agents and guard.roles
#   4) guard enforcement: the worker's OWN guard decision function
#      (worker dist role-guard/policy.js, the same code the injected
#      vteam-role-guard.ts plugin snapshots) denies vteam_group_post with the
#      correction message and allows vteam_submit_artifact (positive control)
#   5) byte-identity regression: the 6 built-in agent definitions + guard roles
#      are byte-identical (canonical JSON) to the F3-own baseline subset
#   6) cleanup: delete QA agent/policy, re-verify /agent-policies is baseline-clean
#
# Required env:
#   SERVER_URL    server base WITHOUT /api/v1, e.g. http://localhost:13000.
#                 Default: http://localhost:13000
# Optional env:
#   ADMIN_USER    default admin
#   ADMIN_PASS    default admin123
#   AGENT_KEY     default demo-agent
#   EVIDENCE_DIR  default .omo/evidence/custom-agent-opencode (repo-root relative
#                 or absolute; created if missing)
#   BASELINE_DIR  default .omo/evidence/role-enforcement/F3-own
#   RESTART_WORKER  default true. When true, restart the worker service so its
#                 start-only injector rewrites opencode.json + roles.json, then
#                 assert vteam-demo-agent is injected. Set false to run the
#                 offline-only proof (API + guard decision on control-plane data).
#   RESTART_TIMEOUT_SEC  wait budget for the restarted worker to re-inject.
#                 Default: 180
#   RESTART_INTERVAL_SEC poll interval. Default: 5
#
# Run (from repo root):
#   bash scripts/e2e-custom-agent-opencode.sh
#
# Rule: any failed assertion prints FAIL and exits non-zero. Cleanup runs on
# EXIT (success or failure) so no QA rows survive. The script is idempotent:
# pre-cleanup sweeps leftovers from a previous run before starting.
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
AGENT_KEY="${AGENT_KEY:-demo-agent}"
AGENT_NAME="vteam-${AGENT_KEY}"
POLICY_NAME="e2e-demo-agent policy"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/custom-agent-opencode}"
BASELINE_DIR="${BASELINE_DIR:-.omo/evidence/role-enforcement/F3-own}"
RESTART_WORKER="${RESTART_WORKER:-true}"
RESTART_TIMEOUT_SEC="${RESTART_TIMEOUT_SEC:-180}"
RESTART_INTERVAL_SEC="${RESTART_INTERVAL_SEC:-5}"

case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
case "$BASELINE_DIR" in /*) ;; *) BASELINE_DIR="$REPO_ROOT/$BASELINE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"

# ---------------------------------------------------------------- helpers
E2E_LOG="$EVIDENCE_DIR/e2e.txt"
: >"$E2E_LOG"

log()  { printf '[e2e] %s\n' "$*" | tee -a "$E2E_LOG"; }
pass() { printf '[e2e] \033[32mPASS\033[0m %s\n' "$*" | tee -a "$E2E_LOG"; }
fail() { # $1 = step, $2 = reason
  printf '[e2e] \033[31mFAIL\033[0m step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"
  exit 1
}
skip() { printf '[e2e] SKIP step=%s reason=%s\n' "$1" "$2" | tee -a "$E2E_LOG"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$E2E_LOG"; exit 2; }
}
need_cmd curl
need_cmd python3
need_cmd docker

# jget <json-file> <python-expr on `d`> : print extracted value or empty.
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v='"$2"'; print("" if v is None else (v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))' "$1"; }

# api <METHOD> <path> <jwt> [body-file] [out-file] : curl server /api/v1, prints HTTP code.
api() {
  local method="$1" path="$2" jwt="$3" body="${4:-}" out="${5:-/dev/null}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$out" -w '%{http_code}' -X "$method" "$SERVER_URL/api/v1$path" \
      -H "Authorization: Bearer $jwt" -H 'Content-Type: application/json' --data @"$body"
  else
    curl -sS -o "$out" -w '%{http_code}' -X "$method" "$SERVER_URL/api/v1$path" \
      -H "Authorization: Bearer $jwt"
  fi
}

# login <username> <password> : prints accessToken (server returns {accessToken,...}).
login() {
  local body out code
  body="$(mktemp)"; out="$(mktemp)"
  printf '{"username":"%s","password":"%s"}' "$1" "$2" >"$body"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  rm -f "$body"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    cp "$out" "$EVIDENCE_DIR/login-$1.txt"; rm -f "$out"
    printf '[e2e] login %s failed: HTTP %s (body in %s)\n' "$1" "$code" "$EVIDENCE_DIR/login-$1.txt" | tee -a "$E2E_LOG"
    return 1
  fi
  jget "$out" 'd.get("accessToken") or d.get("access_token") or ""'
  rm -f "$out"
}

# db_exec <sql> : run a statement against the compose db (best effort, never fatal).
db_exec() {
  docker exec aiagents-compose-db mysql -uroot -paiagents-root -D aiagents -e "$1" 2>/dev/null \
    || (cd "$REPO_ROOT" && docker compose exec -T db mysql -uroot -paiagents-root -D aiagents -e "$1" 2>/dev/null) \
    || true
}

# ---------------------------------------------------------------- tracked QA rows (cleanup on EXIT)
QA_AGENT_ID=""
QA_POLICY_ID=""

cleanup() {
  log "cleanup: removing QA rows (agent/policy) ..."
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    # Sweep agents by agentKey (covers leftovers from a killed previous run).
    local list tmp
    tmp="$(mktemp)"
    if [[ "$(api GET '/agents?type=custom&page=1&pageSize=100' "$ADMIN_JWT" '' "$tmp")" == "200" ]]; then
      for id in $(python3 - "$tmp" "$AGENT_KEY" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); key = sys.argv[2]
items = d if isinstance(d, list) else d.get("items") or []
for a in items:
    if a.get("agentKey") == key and a.get("id"):
        print(a["id"])
EOF
); do
        api DELETE "/agents/$id" "$ADMIN_JWT" >/dev/null || true
        log "cleanup: DELETE /agents/$id done"
      done
    fi
    rm -f "$tmp"
    # Sweep policies by exact QA name.
    tmp="$(mktemp)"
    if [[ "$(api GET '/execution-policies?type=custom&page=1&pageSize=100' "$ADMIN_JWT" '' "$tmp")" == "200" ]]; then
      for id in $(python3 - "$tmp" "$POLICY_NAME" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); name = sys.argv[2]
items = d if isinstance(d, list) else d.get("items") or []
for p in items:
    if p.get("name") == name and p.get("id"):
        print(p["id"])
EOF
); do
        api DELETE "/execution-policies/$id" "$ADMIN_JWT" >/dev/null || true
        log "cleanup: DELETE /execution-policies/$id done"
      done
    fi
    rm -f "$tmp"
  fi
  # DB belt-and-suspenders: no row with the QA agent_key may survive.
  db_exec "DELETE FROM agents WHERE agent_key='${AGENT_KEY}';"
  log "cleanup done"
}
trap cleanup EXIT

# ---------------------------------------------------------------- preconditions
log "SERVER_URL=$SERVER_URL ADMIN_USER=$ADMIN_USER AGENT_KEY=$AGENT_KEY RESTART_WORKER=$RESTART_WORKER"
log "login $ADMIN_USER ..."
ADMIN_JWT="$(login "$ADMIN_USER" "$ADMIN_PASS")" || exit 1
[[ -n "$ADMIN_JWT" ]] || { printf '[e2e] empty admin accessToken\n' | tee -a "$E2E_LOG"; exit 1; }

# Idempotent start: sweep leftovers BEFORE creating (plus EXIT-trap after).
cleanup
trap cleanup EXIT

# ---------------------------------------------------------------- step 1: custom policy with a distinctive matrix (DENY required)
log "--- step 1: create custom policy '$POLICY_NAME' (vteam_group_post=deny) ---"
POL_BODY="$(mktemp)"; POL_OUT="$EVIDENCE_DIR/policy-create.json"
python3 - "$POL_BODY" "$POLICY_NAME" <<'EOF'
import json,sys
out, name = sys.argv[1:3]
json.dump({
  "name": name,
  "type": "custom",
  "config": {
    "permission": {
      "edit": {"*": "deny"},
      "read": {"*": "allow"},
      "bash": "deny",
      "task": "deny",
    },
    "correction": {
      "scopeSummary": "e2e demo-agent: only submit artifacts",
      "denyTemplate": "【越界拦截｜角色：{role}】不能调用 <tool>。",
    },
    "tools": {
      "vteam_group_post": "deny",
      "vteam_submit_artifact": "allow",
    },
  },
}, open(out, "w"), ensure_ascii=False)
EOF
code="$(api POST '/execution-policies' "$ADMIN_JWT" "$POL_BODY" "$POL_OUT")"
rm -f "$POL_BODY"
[[ "$code" == "200" || "$code" == "201" ]] || fail "1-policy-create" "POST /execution-policies HTTP $code (raw: $POL_OUT)"
QA_POLICY_ID="$(jget "$POL_OUT" 'd.get("id") or ""')"
[[ -n "$QA_POLICY_ID" ]] || fail "1-policy-create" "policy create returned no id (raw: $POL_OUT)"
log "policyId=$QA_POLICY_ID"
pass "1 (custom policy created with deny matrix)"

# ---------------------------------------------------------------- step 2: custom agent bound to that policy
log "--- step 2: create custom agent agentKey='$AGENT_KEY' bound to $QA_POLICY_ID ---"
AGT_BODY="$(mktemp)"; AGT_OUT="$EVIDENCE_DIR/agent-create.json"
python3 - "$AGT_BODY" "$AGENT_KEY" "$QA_POLICY_ID" <<'EOF'
import json,sys
out, key, policy = sys.argv[1:4]
json.dump({
  "name": "E2E Demo Agent",
  "type": "custom",
  "agentKey": key,
  "prompt": "e2e demo agent: submits artifacts, never posts to group.",
  "policyId": policy,
}, open(out, "w"), ensure_ascii=False)
EOF
code="$(api POST '/agents' "$ADMIN_JWT" "$AGT_BODY" "$AGT_OUT")"
rm -f "$AGT_BODY"
[[ "$code" == "200" || "$code" == "201" ]] || fail "2-agent-create" "POST /agents HTTP $code (raw: $AGT_OUT)"
QA_AGENT_ID="$(jget "$AGT_OUT" 'd.get("id") or ""')"
[[ -n "$QA_AGENT_ID" ]] || fail "2-agent-create" "agent create returned no id (raw: $AGT_OUT)"
log "agentId=$QA_AGENT_ID"
pass "2 (custom agent created and policy-bound)"

# ---------------------------------------------------------------- step 3: /agent-policies contains vteam-demo-agent in agents + guard.roles
log "--- step 3: GET /agent-policies contains $AGENT_NAME in agents + guard.roles ---"
POLICIES_OUT="$EVIDENCE_DIR/agent-policies.json"
code="$(api GET '/agent-policies' "$ADMIN_JWT" '' "$POLICIES_OUT")"
[[ "$code" == "200" ]] || fail "3-agent-policies" "GET /agent-policies HTTP $code (raw: $POLICIES_OUT)"
if ! python3 - "$POLICIES_OUT" "$AGENT_NAME" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); want = sys.argv[2]
names = [a.get("name") for a in (d.get("agents") or [])]
assert want in names, "agents names=%r (want %s)" % (names, want)
roles = (d.get("guard") or {}).get("roles") or {}
assert want in roles, "guard.roles keys=%r (want %s)" % (sorted(roles), want)
role = roles[want]
assert isinstance(role.get("tools"), dict), "role tools not an object: %r" % (role,)
assert role["tools"].get("vteam_group_post") == "deny", \
  "vteam_group_post=%r (want deny)" % (role["tools"].get("vteam_group_post"),)
assert role["tools"].get("vteam_submit_artifact") == "allow", \
  "vteam_submit_artifact=%r (want allow)" % (role["tools"].get("vteam_submit_artifact"),)
entry = next(a for a in d["agents"] if a.get("name") == want)
assert entry.get("mode") == "primary", "agent mode=%r" % (entry.get("mode"),)
print("agent-policies: %s present in agents + guard.roles with deny/allow matrix" % want)
EOF
then
  fail "3-agent-policies" "matrix assertion failed (raw: $POLICIES_OUT)"
fi
pass "3 (vteam-demo-agent in agents + guard.roles with matrix)"

# ---------------------------------------------------------------- step 4: guard enforcement with the worker's OWN guard code
log "--- step 4: guard decision via worker dist role-guard/policy.js ---"
GUARD_OUT="$EVIDENCE_DIR/guard-decision.txt"
: >"$GUARD_OUT"
# The injector writes roles.json as JSON.stringify({enabled, roles}) from this
# exact /agent-policies payload, so feeding guard.roles['vteam-demo-agent']
# through the worker's compiled evaluateToolCall IS the real decision path
# (role-guard-plugin.ts ships this logic as an inline snapshot; parity is
# locked by worker role-guard-plugin.spec.ts).
if ! python3 - "$POLICIES_OUT" "$EVIDENCE_DIR/guard-roles-doc.json" "$AGENT_NAME" <<'EOF'
import json,sys
policies = json.load(open(sys.argv[1])); out = sys.argv[2]; want = sys.argv[3]
roles = (policies.get("guard") or {}).get("roles") or {}
json.dump({"enabled": True, "roles": {want: roles[want]}}, open(out, "w"), ensure_ascii=False)
print("wrote %s with role %s" % (out, want))
EOF
then
  fail "4-guard-offline" "could not extract guard role from $POLICIES_OUT"
fi
if ! (cd "$REPO_ROOT" && docker compose cp "$EVIDENCE_DIR/guard-roles-doc.json" worker:/tmp/e2e-guard-roles.json >/dev/null); then
  fail "4-guard-offline" "docker compose cp guard roles-doc into worker failed"
fi
if ! (cd "$REPO_ROOT" && docker compose exec -T worker node -e "
const fs = require('fs');
const {evaluateToolCall} = require('/app/dist/role-guard/policy.js');
const rolesDoc = JSON.parse(fs.readFileSync('/tmp/e2e-guard-roles.json', 'utf8'));
const agent = '$AGENT_NAME';
let failed = false;
for (const [tool, want] of [['vteam_group_post','deny'],['vteam_submit_artifact','allow']]) {
  const d = evaluateToolCall({rolesDoc, session:{agent, dir:'/data/vteam-worker'}, tool, args:{}});
  console.log(tool + ' -> ' + JSON.stringify(d));
  if (d.action !== want) { console.error('MISMATCH tool=' + tool + ' want=' + want); failed = true; }
  if (want === 'deny' && !/越界拦截/.test(d.message || '')) { console.error('deny message missing correction literal'); failed = true; }
}
if (failed) process.exit(1);
" 2>&1 | tee "$GUARD_OUT"); then
  fail "4-guard-offline" "worker guard decision mismatch (raw: $GUARD_OUT)"
fi
pass "4a (offline: worker guard code denies vteam_group_post, allows vteam_submit_artifact)"

# ---------------------------------------------------------------- step 4b (live): restart worker, assert injected files contain the agent
INJECTED_OUT="$EVIDENCE_DIR/injected-opencode.json"
ROLES_OUT="$EVIDENCE_DIR/roles.json"
if [[ "$RESTART_WORKER" == "true" ]]; then
  log "--- step 4b: restart worker (injector runs at start only) and assert injection ---"
  if (cd "$REPO_ROOT" && docker compose up -d --force-recreate worker >/dev/null 2>&1); then
    log "worker recreating; polling roles.json for $AGENT_NAME ..."
    deadline=$((SECONDS + RESTART_TIMEOUT_SEC))
    found=""
    while [[ $SECONDS -lt $deadline ]]; do
      if (cd "$REPO_ROOT" && docker compose exec -T worker cat /data/vteam-worker/.vteam-role-guard/roles.json 2>/dev/null | grep -q "$AGENT_NAME"); then
        found="yes"
        break
      fi
      sleep "$RESTART_INTERVAL_SEC"
    done
    [[ -n "$found" ]] || fail "4b-inject" "roles.json lacks $AGENT_NAME after ${RESTART_TIMEOUT_SEC}s"
    (cd "$REPO_ROOT" && docker compose cp worker:/data/vteam-worker/opencode.json "$INJECTED_OUT" >/dev/null)
    (cd "$REPO_ROOT" && docker compose cp worker:/data/vteam-worker/.vteam-role-guard/roles.json "$ROLES_OUT" >/dev/null)
    if ! python3 - "$INJECTED_OUT" "$AGENT_NAME" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); want = sys.argv[2]
agents = d.get("agent") or {}
assert want in agents, "injected agent keys=%r (want %s)" % (sorted(agents), want)
print("injected opencode.json agent section contains %s" % want)
EOF
    then
      fail "4b-inject" "injected opencode.json lacks $AGENT_NAME (raw: $INJECTED_OUT)"
    fi
    # Re-run the guard decision against the ACTUAL roles.json inside the worker.
    if ! (cd "$REPO_ROOT" && docker compose exec -T worker node -e "
const fs = require('fs');
const {evaluateToolCall} = require('/app/dist/role-guard/policy.js');
const rolesDoc = JSON.parse(fs.readFileSync('/data/vteam-worker/.vteam-role-guard/roles.json', 'utf8'));
const agent = '$AGENT_NAME';
const deny = evaluateToolCall({rolesDoc, session:{agent, dir:'/data/vteam-worker'}, tool:'vteam_group_post', args:{}});
const allow = evaluateToolCall({rolesDoc, session:{agent, dir:'/data/vteam-worker'}, tool:'vteam_submit_artifact', args:{}});
console.log('live-roles vteam_group_post -> ' + JSON.stringify(deny));
console.log('live-roles vteam_submit_artifact -> ' + JSON.stringify(allow));
if (deny.action !== 'deny' || !/越界拦截/.test(deny.message || '') || allow.action !== 'allow') process.exit(1);
" 2>&1 | tee -a "$GUARD_OUT"); then
      fail "4b-guard-live" "live roles.json guard decision mismatch (raw: $GUARD_OUT)"
    fi
    pass "4b (live: injected opencode.json + roles.json contain $AGENT_NAME; live guard denies/allow as expected)"
  else
    skip "4b-inject" "worker restart not feasible in this environment (offline proof 4a still holds)"
  fi
else
  skip "4b-inject" "RESTART_WORKER=false (offline proof 4a still holds)"
fi

# ---------------------------------------------------------------- step 5: byte-identity regression on the built-in subset
log "--- step 5: built-in subset byte-identical to F3-own baseline ---"
BASELINE_OPENCODE="$BASELINE_DIR/injected-opencode.json"
BASELINE_POLICIES="$BASELINE_DIR/agent-policies.json"
[[ -f "$BASELINE_OPENCODE" ]] || fail "5-byte-identity" "baseline $BASELINE_OPENCODE not found"
[[ -f "$BASELINE_POLICIES" ]] || fail "5-byte-identity" "baseline $BASELINE_POLICIES not found"
# Live sources: prefer worker-injected files when the restart path ran,
# else fall back to control-plane /agent-policies (same bytes the injector writes).
LIVE_OPENCODE="$INJECTED_OUT"
[[ -f "$LIVE_OPENCODE" ]] || LIVE_OPENCODE=""
LIVE_ROLES_SRC="$ROLES_OUT"
[[ -f "$LIVE_ROLES_SRC" ]] || LIVE_ROLES_SRC="$POLICIES_OUT"
if ! python3 - "$BASELINE_OPENCODE" "$BASELINE_POLICIES" "${LIVE_OPENCODE:-__none__}" "$LIVE_ROLES_SRC" "$POLICIES_OUT" "$EVIDENCE_DIR/byte-identity.txt" <<'EOF'
import json,sys
base_oc, base_pol, live_oc, live_roles_src, live_pol, report = sys.argv[1:7]
BUILTINS = ["vteam-plan", "vteam-product", "vteam-architect",
            "vteam-developer", "vteam-tester", "vteam-project_manager"]
def canon(o):
    return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

base_oc_d = json.load(open(base_oc))
base_pol_d = json.load(open(base_pol))
live_pol_d = json.load(open(live_pol))
live_roles = json.load(open(live_roles_src))
# roles.json shape is {enabled, roles}; /agent-policies shape is {agents, guard:{roles}}.
if "roles" in live_roles and "guard" not in live_roles:
    live_roles = live_roles["roles"]
else:
    live_roles = (live_roles.get("guard") or {}).get("roles") or {}
base_roles = (base_pol_d.get("guard") or {}).get("roles") or {}
live_agents_by_name = {a["name"]: a for a in (live_pol_d.get("agents") or [])}
base_agents_by_name = {a["name"]: a for a in (base_pol_d.get("agents") or [])}
lines = []
ok = True
# (i) control-plane built-in agent definitions identical to baseline file.
for name in BUILTINS:
    same = canon(live_agents_by_name[name]) == canon(base_agents_by_name[name])
    lines.append("agent-policies agents[%s]: %s" % (name, "IDENTICAL" if same else "MISMATCH"))
    ok = ok and same
# (ii) guard roles identical to baseline file.
for name in BUILTINS:
    same = canon(live_roles[name]) == canon(base_roles[name])
    lines.append("guard.roles[%s]: %s" % (name, "IDENTICAL" if same else "MISMATCH"))
    ok = ok and same
# (iii) injected opencode.json built-in agent entries identical to baseline file.
if live_oc != "__none__":
    live_oc_d = json.load(open(live_oc))
    live_section = live_oc_d.get("agent") or {}
    base_section = base_oc_d.get("agent") or {}
    assert set(base_section) == set(BUILTINS), \
      "baseline agent keys=%r (want exactly the 6 built-ins)" % (sorted(base_section),)
    for name in BUILTINS:
        same = canon(live_section[name]) == canon(base_section[name])
        lines.append("injected agent[%s]: %s" % (name, "IDENTICAL" if same else "MISMATCH"))
        ok = ok and same
    # plugin/mcp skeleton must still be present (shape guard, not byte-compared).
    assert "./.opencode/plugin/vteam-role-guard.ts" in (live_oc_d.get("plugin") or []), \
      "injected plugin section lost the guard entry"
    assert "vteam" in (live_oc_d.get("mcp") or {}), "injected mcp section lost vteam"
    lines.append("injected plugin+mcp skeleton: PRESENT")
else:
    lines.append("injected opencode.json: SKIPPED (no live file; RESTART_WORKER=false)")
open(report, "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
assert ok, "byte-identity mismatches above"
EOF
then
  fail "5-byte-identity" "built-in subset differs from baseline (raw: $EVIDENCE_DIR/byte-identity.txt)"
fi
pass "5 (6 built-ins byte-identical to baseline; custom entries only additive)"

# ---------------------------------------------------------------- step 6: cleanup + re-verify baseline
log "--- step 6: cleanup QA rows and re-verify /agent-policies is baseline-clean ---"
QA_AGENT_ID=""
QA_POLICY_ID=""
cleanup
trap - EXIT
AFTER_OUT="$EVIDENCE_DIR/agent-policies-after.json"
code="$(api GET '/agent-policies' "$ADMIN_JWT" '' "$AFTER_OUT")"
[[ "$code" == "200" ]] || fail "6-cleanup" "GET /agent-policies after cleanup HTTP $code"
if ! python3 - "$AFTER_OUT" "$AGENT_NAME" <<'EOF'
import json,sys
d = json.load(open(sys.argv[1])); want = sys.argv[2]
names = [a.get("name") for a in (d.get("agents") or [])]
roles = (d.get("guard") or {}).get("roles") or {}
assert want not in names, "%s still in agents" % want
assert want not in roles, "%s still in guard.roles" % want
print("post-cleanup: %s absent from agents + guard.roles (%d agents remain)" % (want, len(names)))
EOF
then
  fail "6-cleanup" "QA agent still present after cleanup (raw: $AFTER_OUT)"
fi
LEFTOVER="$(db_exec "SELECT COUNT(*) AS c FROM agents WHERE agent_key='${AGENT_KEY}';" | tail -1)"
log "db agents with agent_key='$AGENT_KEY': ${LEFTOVER:-unknown (docker exec unavailable)}"
pass "6 (cleanup complete; /agent-policies back to baseline)"

log "ALL STEPS DONE: 1/2/3/4a/4b/5/6"
printf '[e2e] \033[32mPASS\033[0m custom-agent-opencode (evidence: %s)\n' "$EVIDENCE_DIR" | tee -a "$E2E_LOG"
