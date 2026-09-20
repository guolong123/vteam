#!/usr/bin/env bash
#
# e2e: native permission edits reach the worker (plan Todo 8 proof, parts b-e).
#
# Proves, against a LIVE stack (server + worker, no model/serve needed):
#   (c) frozen-baseline sha gate  : baseline-agent-policies.json sha256 is checked at
#                                   start AND at end; never modified.
#   (b) live round-trip           : PATCH a builtin's permission.edit -> POLL the
#                                   injected opencode.json + .vteam-role-guard/roles.json
#                                   until the rule lands (propagation is AUTOMATIC via the
#                                   todo-9 reload-config broadcast; NO restart is issued)
#                                   -> other 6 builtins stay byte-identical to the
#                                   frozen baseline -> restore + prove byte-identity.
#   (d) permission.write stripped : a PATCH carrying permission.write is stored WITHOUT
#                                   the key and /agent-policies never emits it (the worker
#                                   throws on it at opencode-config-builder.ts:111-115,
#                                   which would neutralize the whole guard).
#   (e) M1 case                   : a PATCH with permission.edit ABSENT is stored with the
#                                   catch-all { '*': 'deny' }.
#
# Rule: any failed assertion prints FAIL and exits non-zero. Restore is best-effort and
# runs on EXIT (success or failure) so ep_product never stays mutated.
#
# Required env:
#   SERVER_URL          server base WITHOUT /api/v1. Default: http://localhost:13000
# Optional env:
#   ADMIN_USERNAME/ADMIN_PASSWORD  default admin / admin123
#   ADMIN_JWT           skip login
#   EDIT_POLICY_ID      builtin edited for the proof. Default: ep_product
#   WORKER_WORK_DIR     work dir INSIDE the worker container. Default: /data/vteam-worker
#   X_WORKER_TOKEN      worker token for GET /agent-policies. Default: compose-worker-token
#   EVIDENCE_DIR        where raw responses are stashed. Default: .omo/evidence/agent-native-permission-editor
#   POLL_TIMEOUT_SEC    injection poll budget. Default: 120
#   POLL_INTERVAL_SEC   poll interval. Default: 5
#   CLEANUP_POLL_SEC    restore poll budget in the EXIT trap. Default: 90
#   INJECTED_OPENCODE_JSON / INJECTED_ROLES_JSON  override local artifact paths (tests only)
#
# Run:
#   bash scripts/e2e-native-edit-enforcement.sh
#
set -euo pipefail

# ---------------------------------------------------------------- env / defaults
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
ADMIN_JWT="${ADMIN_JWT:-}"
EDIT_POLICY_ID="${EDIT_POLICY_ID:-ep_product}"
WORKER_WORK_DIR="${WORKER_WORK_DIR:-/data/vteam-worker}"
X_WORKER_TOKEN="${X_WORKER_TOKEN:-compose-worker-token}"
POLL_TIMEOUT_SEC="${POLL_TIMEOUT_SEC:-120}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}"
CLEANUP_POLL_SEC="${CLEANUP_POLL_SEC:-90}"
PROBE_MARKER="${PROBE_MARKER:-**t8-enforce/**}"
BASELINE_POLICIES="${BASELINE_POLICIES:-}"
FROZEN_BASELINE_SHA256="${FROZEN_BASELINE_SHA256:-3d26b49f5ccd81d546f69dbfda8bd7c2568803a6128063f936b9f57045c5d3ee}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/.omo/evidence/agent-native-permission-editor}"
T8_DIR="$EVIDENCE_DIR/task-8"
if [[ -z "$BASELINE_POLICIES" ]]; then
  BASELINE_POLICIES="$REPO_ROOT/.omo/evidence/opencode-native-permissions-and-fixes/baseline-agent-policies.json"
fi
mkdir -p "$T8_DIR"

# ---------------------------------------------------------------- helpers
docker_compose() { (cd "$REPO_ROOT" && docker compose "$@"); }

log()  { printf '[e2e] %s\n' "$*"; }
pass() { printf '[e2e] PASS %s\n' "$*"; }
fail() { # $1 = scenario, $2 = reason
  printf '[e2e] FAIL scenario=%s reason=%s\n' "$1" "$2"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1"; exit 2; }
}
need_cmd curl
need_cmd python3

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

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

# login <username> <password> : prints accessToken.
login() {
  local body out code
  body="$(mktemp)"; out="$(mktemp)"
  printf '{"username":"%s","password":"%s"}' "$1" "$2" >"$body"
  code="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data @"$body")"
  rm -f "$body"
  if [[ "$code" != "200" && "$code" != "201" ]]; then
    cp "$out" "$T8_DIR/login-$1.txt"; rm -f "$out"
    printf '[e2e] login %s failed: HTTP %s (body in %s)\n' "$1" "$code" "$T8_DIR/login-$1.txt"
    return 1
  fi
  jget "$out" 'd.get("accessToken") or d.get("access_token") or ""'
  rm -f "$out"
}

# fetch_agent_policies <out-file> : worker-token first (mirrors the worker), else JWT.
fetch_agent_policies() {
  local out="$1"
  curl -sS -o "$out" -w '%{http_code}' "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $X_WORKER_TOKEN"
}

# read_artifacts <opencode-out> <roles-out> : cat both injected artifacts out of the worker.
read_artifacts() {
  local oc="$1" rl="$2"
  docker_compose exec -T worker cat "$WORKER_WORK_DIR/opencode.json" >"$oc" 2>/dev/null \
    || docker exec aiagents-compose-worker cat "$WORKER_WORK_DIR/opencode.json" >"$oc"
  docker_compose exec -T worker cat "$WORKER_WORK_DIR/.vteam-role-guard/roles.json" >"$rl" 2>/dev/null \
    || docker exec aiagents-compose-worker cat "$WORKER_WORK_DIR/.vteam-role-guard/roles.json" >"$rl"
}

# probe_in_artifact <opencode.json> : exit 0 iff vteam-product's injected permission.edit
# carries the probe with the pre-existing globs intact.
probe_in_artifact() {
  python3 - "$1" "$PROBE_MARKER" <<'EOF'
import json,sys
oc=json.load(open(sys.argv[1])); probe=sys.argv[2]
entry=((oc.get("agent") or {}).get("vteam-product") or {}).get("permission") or {}
edit=entry.get("edit")
assert isinstance(edit,dict), "vteam-product.permission.edit missing/not object"
assert edit.get(probe)=="allow", "probe %r not allow in injected edit: %r" % (probe, edit)
assert edit.get("*")=="deny", "catch-all not deny in injected edit: %r" % (edit,)
for g in ("**tasks/*/prototypes/**","**tasks/*/docs/**"):
    assert edit.get(g)=="allow", "pre-existing glob %s lost: %r" % (g, edit)
EOF
}

# probe_absent_artifact <opencode.json> : exit 0 iff the probe is gone from vteam-product.
probe_absent_artifact() {
  python3 - "$1" "$PROBE_MARKER" <<'EOF'
import json,sys
oc=json.load(open(sys.argv[1])); probe=sys.argv[2]
edit=(((oc.get("agent") or {}).get("vteam-product") or {}).get("permission") or {}).get("edit") or {}
assert probe not in edit, "probe %r still present after restore: %r" % (probe, edit)
EOF
}

# ---------------------------------------------------------------- EXIT trap / cleanup
RESTORE_BODY_FILE=""
RESTORE_DONE=""
THROWAWAY_POLICY_IDS=()
cleanup() {
  local rc=$?
  if [[ -n "$RESTORE_BODY_FILE" && -f "$RESTORE_BODY_FILE" && -n "${ADMIN_JWT:-}" ]]; then
    printf '[e2e] cleanup: restoring %s original config ...\n' "$EDIT_POLICY_ID"
    api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$RESTORE_BODY_FILE" \
      "$T8_DIR/cleanup-restore-$EDIT_POLICY_ID.json" >/dev/null 2>&1 || true
    # Poll until the probe disappears from the injected artifact.
    if command -v docker >/dev/null 2>&1; then
      local deadline=$((SECONDS + CLEANUP_POLL_SEC)) i=0 restored=""
      while [[ $SECONDS -lt $deadline ]]; do
        i=$((i+1))
        if read_artifacts "$T8_DIR/cleanup-opencode.json" "$T8_DIR/cleanup-roles.json" 2>/dev/null; then
          if probe_absent_artifact "$T8_DIR/cleanup-opencode.json" 2>/dev/null; then restored="yes"; break; fi
        fi
        sleep "$POLL_INTERVAL_SEC"
      done
      printf '[e2e] cleanup: probe absent from injected artifact = %s (iters=%s)\n' "${restored:-no}" "$i"
      # Best-effort byte-identity of all 7 against the frozen baseline.
      if [[ -n "$restored" ]]; then
        if fetch_agent_policies "$T8_DIR/cleanup-agent-policies.json" >/dev/null 2>&1; then
          python3 - "$T8_DIR/cleanup-agent-policies.json" "$BASELINE_POLICIES" <<'EOF' || true
import json,sys
live=json.load(open(sys.argv[1])); base=json.load(open(sys.argv[2]))
def canon(o): return json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"))
order=[a["name"] for a in base["agents"]]
la={a["name"]:a for a in live.get("agents") or []}
lr=(live.get("guard") or {}).get("roles") or {}
subset={"agents":[la[n] for n in order],"guard":{"enabled":live["guard"]["enabled"],"roles":{n:lr[n] for n in order}}}
print("[e2e] cleanup: all 7 builtins byte-identical to baseline =", canon(subset)==canon(base))
EOF
        fi
      fi
    fi
  fi
  # Delete any throwaway policy created by this run.
  if [[ ${#THROWAWAY_POLICY_IDS[@]} -gt 0 && -n "${ADMIN_JWT:-}" ]]; then
    for pid in "${THROWAWAY_POLICY_IDS[@]}"; do
      local code
      code="$(api DELETE "/execution-policies/$pid" "$ADMIN_JWT" '' "$T8_DIR/cleanup-delete-$pid.json" || true)"
      printf '[e2e] cleanup: DELETE throwaway policy %s -> HTTP %s\n' "$pid" "$code"
    done
  fi
  if [[ -f "$BASELINE_POLICIES" ]]; then
    printf '[e2e] cleanup: baseline sha256 = %s\n' "$(sha256_of "$BASELINE_POLICIES")"
  fi
  RESTORE_DONE="yes"
  return $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------- preconditions
[[ -f "$BASELINE_POLICIES" ]] || fail "c" "baseline not found: $BASELINE_POLICIES"
have_docker() { command -v docker >/dev/null 2>&1 && docker_compose version >/dev/null 2>&1; }
have_docker || fail "b" "docker unavailable; cannot read injected artifacts"

log "SERVER_URL=$SERVER_URL EDIT_POLICY_ID=$EDIT_POLICY_ID WORKER_WORK_DIR=$WORKER_WORK_DIR"
log "EVIDENCE_DIR=$EVIDENCE_DIR"

# ================================================================ (c) frozen-sha gate START
log "--- (c) frozen-sha gate (start) ---"
baseline_sha="$(sha256_of "$BASELINE_POLICIES")"
log "baseline sha256 = $baseline_sha (frozen: $FROZEN_BASELINE_SHA256)"
[[ "$baseline_sha" == "$FROZEN_BASELINE_SHA256" ]] \
  || fail "c" "baseline sha256 $baseline_sha != frozen $FROZEN_BASELINE_SHA256 (stale/tampered baseline)"
pass "c (frozen baseline sha256 matches at start)"

# ---------------------------------------------------------------- login
log "login $ADMIN_USERNAME ..."
ADMIN_JWT="${ADMIN_JWT:-$(login "$ADMIN_USERNAME" "$ADMIN_PASSWORD")}" || exit 1
[[ -n "$ADMIN_JWT" ]] || { printf '[e2e] empty admin accessToken\n'; exit 1; }

# ---------------------------------------------------------------- pre-flight: artifact must be clean
read_artifacts "$T8_DIR/pre-opencode.json" "$T8_DIR/pre-roles.json"
if probe_in_artifact "$T8_DIR/pre-opencode.json" 2>/dev/null; then
  fail "setup" "injected artifact already carries the probe marker $PROBE_MARKER; restore ep_product (or rerun after the EXIT trap converges) before running"
fi
log "pre-flight: injected artifact is free of the probe marker"

# ================================================================ (b) live round-trip
log "--- (b) live round-trip: PATCH edit rule -> poll injected artifacts ---"

# 1. Snapshot the original policy for restore (name/description/config).
ORIG_OUT="$T8_DIR/original-$EDIT_POLICY_ID.json"
code="$(api GET "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" '' "$ORIG_OUT")"
[[ "$code" == "200" ]] || fail "b" "GET /execution-policies/$EDIT_POLICY_ID HTTP $code (raw: $ORIG_OUT)"
RESTORE_BODY_FILE="$T8_DIR/restore-$EDIT_POLICY_ID.json"
EDIT_BODY_FILE="$T8_DIR/edit-$EDIT_POLICY_ID.json"
python3 - "$ORIG_OUT" "$RESTORE_BODY_FILE" "$EDIT_BODY_FILE" "$PROBE_MARKER" <<'EOF'
import json,sys
orig=json.load(open(sys.argv[1])); restore=sys.argv[2]; edited=sys.argv[3]; probe=sys.argv[4]
cfg=orig["config"]
json.dump({"name":orig.get("name"),"description":orig.get("description"),"config":cfg},
          open(restore,"w"), ensure_ascii=False)
perm=dict(cfg.get("permission") or {})
edit=dict(perm.get("edit") or {})
edit[probe]="allow"
perm["edit"]=edit
new_cfg={"permission":perm,"correction":cfg.get("correction")}
if "tools" in cfg: new_cfg["tools"]=cfg["tools"]
json.dump({"config":new_cfg}, open(edited,"w"), ensure_ascii=False)
print("edit body: add permission.edit[%r]='allow' (catch-all + existing globs preserved)" % probe)
EOF

# 2. PATCH it.
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$EDIT_BODY_FILE" "$T8_DIR/patch.json")"
[[ "$code" == "200" ]] || fail "b" "PATCH /execution-policies/$EDIT_POLICY_ID HTTP $code (raw: $T8_DIR/patch.json)"
cp "$EDIT_BODY_FILE" "$T8_DIR/b-edit-body.json"
pass "b1 (PATCH accepted; edit rule stored)"

# 2b. Control plane reflects the edit immediately (no worker involved).
code="$(fetch_agent_policies "$T8_DIR/b-control-plane.json")"
[[ "$code" == "200" ]] || fail "b" "GET /agent-policies HTTP $code"
python3 - "$T8_DIR/b-control-plane.json" "$PROBE_MARKER" <<'EOF' || fail "b" "control-plane /agent-policies does not reflect the edit"
import json,sys
d=json.load(open(sys.argv[1])); probe=sys.argv[2]
role=(d.get("guard") or {}).get("roles",{}).get("vteam-product") or {}
edit=(role.get("permission") or {}).get("edit") or {}
assert edit.get(probe)=="allow", "guard.roles.vteam-product.permission.edit lacks probe: %r" % (edit,)
agent={a["name"]:a for a in d.get("agents") or []}.get("vteam-product") or {}
aedit=(agent.get("permission") or {}).get("edit") or {}
assert aedit.get(probe)=="allow", "agents[vteam-product].permission.edit lacks probe: %r" % (aedit,)
print("control-plane: /agent-policies reflects edit for vteam-product")
EOF
pass "b2 (control-plane /agent-policies reflects the edit)"

# 3. POLL injected artifacts (NO restart issued; propagation is the todo-9 broadcast).
log "polling injected artifacts (budget ${POLL_TIMEOUT_SEC}s, interval ${POLL_INTERVAL_SEC}s; NO restart) ..."
deadline=$((SECONDS + POLL_TIMEOUT_SEC)); i=0; found=""
while [[ $SECONDS -lt $deadline ]]; do
  i=$((i+1))
  if read_artifacts "$T8_DIR/injected-opencode.json" "$T8_DIR/injected-roles.json"; then
    if probe_in_artifact "$T8_DIR/injected-opencode.json" 2>/dev/null; then found="yes"; break; fi
  fi
  log "poll #$i: probe not yet present in injected opencode.json"
  sleep "$POLL_INTERVAL_SEC"
done
[[ -n "$found" ]] || fail "b" "injected opencode.json did not carry the probe within ${POLL_TIMEOUT_SEC}s (last raw: $T8_DIR/injected-opencode.json)"
log "probe landed after ~$((i * POLL_INTERVAL_SEC))s (iters=$i)"
pass "b3 (injected opencode.json carries the edited rule; auto-propagated, no restart)"

# 4a. Probe present in vteam-product edit; roles.json well-formed; tool count unchanged.
python3 - "$T8_DIR/injected-opencode.json" "$T8_DIR/injected-roles.json" "$PROBE_MARKER" <<'EOF' || fail "b" "injected artifact shape assertion failed"
import json,sys
oc=json.load(open(sys.argv[1])); rd=json.load(open(sys.argv[2])); probe=sys.argv[3]
edit=(((oc.get("agent") or {}).get("vteam-product") or {}).get("permission") or {}).get("edit") or {}
assert edit.get(probe)=="allow", "probe missing: %r" % (edit,)
roles=rd.get("roles") or {}
role=roles.get("vteam-product")
assert role, "injected roles.json lacks vteam-product"
tools=role.get("tools") or {}
assert len(tools)==27, "vteam-product tool count changed: %d (want 27)" % len(tools)
assert probe not in tools, "edit glob leaked into roles.json tools map: %r" % (probe,)
print("injected: probe present in opencode.json edit; roles.json well-formed; vteam-product tools=27 (unchanged); glob not in tools map")
EOF
pass "b4 (roles.json well-formed, tool count unchanged, no glob corruption)"

# 4b. Other SIX builtins byte-identical to the frozen baseline (canonical /agent-policies compare).
code="$(fetch_agent_policies "$T8_DIR/b-postedit-agent-policies.json")"
[[ "$code" == "200" ]] || fail "b" "GET /agent-policies (post-edit) HTTP $code"
python3 - "$T8_DIR/b-postedit-agent-policies.json" "$BASELINE_POLICIES" "$PROBE_MARKER" <<'EOF' || fail "b" "other builtins drifted from the frozen baseline (raw: $T8_DIR/b-postedit-agent-policies.json)"
import json,sys
live=json.load(open(sys.argv[1])); base=json.load(open(sys.argv[2])); probe=sys.argv[3]
def canon(o): return json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"))
order=[a["name"] for a in base["agents"]]
la={a["name"]:a for a in live.get("agents") or []}
lr=(live.get("guard") or {}).get("roles") or {}
b_roles=(base.get("guard") or {}).get("roles") or {}
for name in order:
    if name=="vteam-product":
        edit=(lr.get(name,{}).get("permission") or {}).get("edit") or {}
        assert edit.get(probe)=="allow", "edited role missing probe"
        continue
    assert name in la, "agent %s missing from /agent-policies" % name
    assert canon(lr.get(name))==canon(b_roles.get(name)), "guard role %s drifted from baseline" % name
print("other 6 builtins byte-identical to frozen baseline (canonical)")
EOF
pass "b5 (other 6 builtins byte-identical to frozen baseline)"

# 5. RESTORE via snapshot and poll until the probe is gone.
log "restoring $EDIT_POLICY_ID ..."
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$RESTORE_BODY_FILE" "$T8_DIR/b-restore-patch.json")"
[[ "$code" == "200" ]] || fail "b" "restore PATCH HTTP $code (raw: $T8_DIR/b-restore-patch.json)"
log "polling for probe-absent (budget ${POLL_TIMEOUT_SEC}s) ..."
deadline=$((SECONDS + POLL_TIMEOUT_SEC)); i=0; restored=""
while [[ $SECONDS -lt $deadline ]]; do
  i=$((i+1))
  if read_artifacts "$T8_DIR/b-restored-opencode.json" "$T8_DIR/b-restored-roles.json"; then
    if probe_absent_artifact "$T8_DIR/b-restored-opencode.json" 2>/dev/null; then restored="yes"; break; fi
  fi
  log "poll #$i: probe still present after restore"
  sleep "$POLL_INTERVAL_SEC"
done
[[ -n "$restored" ]] || fail "b" "probe did not disappear from injected artifact within ${POLL_TIMEOUT_SEC}s"

# 6. Prove the restore: stored config == snapshot, and all 7 byte-identical to baseline.
code="$(api GET "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" '' "$T8_DIR/b-restored-policy.json")"
[[ "$code" == "200" ]] || fail "b" "GET after restore HTTP $code"
python3 - "$T8_DIR/b-restored-policy.json" "$ORIG_OUT" <<'EOF' || fail "b" "stored config after restore != snapshot"
import json,sys
now=json.load(open(sys.argv[1])); orig=json.load(open(sys.argv[2]))
def canon(o): return json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"))
assert now.get("name")==orig.get("name"), "name drifted"
assert now.get("description")==orig.get("description"), "description drifted"
assert canon(now.get("config"))==canon(orig.get("config")), "config drifted after restore"
print("restore: stored name/description/config == snapshot (canonical)")
EOF
code="$(fetch_agent_policies "$T8_DIR/b-after-agent-policies.json")"
[[ "$code" == "200" ]] || fail "b" "GET /agent-policies (after restore) HTTP $code"
python3 - "$T8_DIR/b-after-agent-policies.json" "$BASELINE_POLICIES" <<'EOF' || fail "b" "post-restore 7 builtins not byte-identical to baseline"
import json,sys
live=json.load(open(sys.argv[1])); base=json.load(open(sys.argv[2]))
def canon(o): return json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"))
order=[a["name"] for a in base["agents"]]
la={a["name"]:a for a in live.get("agents") or []}
lr=(live.get("guard") or {}).get("roles") or {}
subset={"agents":[la[n] for n in order],"guard":{"enabled":live["guard"]["enabled"],"roles":{n:lr[n] for n in order}}}
assert canon(subset)==canon(base), "post-restore builtins differ from baseline"
print("post-restore: all 7 builtins byte-identical to frozen baseline")
EOF
pass "b6 (restored; probe gone; stored config == snapshot; all 7 byte-identical to baseline)"

# ================================================================ (d) permission.write stripped / never emitted
log "--- (d) permission.write stripped and never emitted ---"
WRITE_EDIT="$T8_DIR/d-write-edit.json"
python3 - "$ORIG_OUT" "$WRITE_EDIT" <<'EOF'
import json,sys
orig=json.load(open(sys.argv[1])); out=sys.argv[2]
cfg=orig["config"]
perm=dict(cfg.get("permission") or {})
perm["write"]="allow"                      # the illegal key that must be stripped
new_cfg={"permission":perm,"correction":cfg.get("correction")}
if "tools" in cfg: new_cfg["tools"]=cfg["tools"]
json.dump({"config":new_cfg}, open(out,"w"), ensure_ascii=False)
print("write-edit body: permission contains a 'write' key (must be stripped)")
EOF
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$WRITE_EDIT" "$T8_DIR/d-patch.json")"
[[ "$code" == "200" ]] || fail "d" "PATCH write-key HTTP $code (raw: $T8_DIR/d-patch.json)"
code="$(api GET "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" '' "$T8_DIR/d-stored.json")"
[[ "$code" == "200" ]] || fail "d" "GET after write PATCH HTTP $code"
python3 - "$T8_DIR/d-stored.json" "$ORIG_OUT" <<'EOF' || fail "d" "permission.write not fully stripped from stored config"
import json,sys
stored=json.load(open(sys.argv[1])); orig=json.load(open(sys.argv[2]))
perm=stored.get("config",{}).get("permission") or {}
assert "write" not in perm, "stored config.permission still has 'write': %r" % (perm,)
def canon(o): return json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"))
assert canon(perm)==canon(orig["config"]["permission"]), "strip changed more than the write key"
print("stored: config.permission has NO 'write' key; equals snapshot permission")
EOF
code="$(fetch_agent_policies "$T8_DIR/d-agent-policies.json")"
[[ "$code" == "200" ]] || fail "d" "GET /agent-policies HTTP $code"
python3 - "$T8_DIR/d-agent-policies.json" <<'EOF' || fail "d" "/agent-policies emits a 'write' key somewhere"
import json,sys
d=json.load(open(sys.argv[1]))
hits=[]
def walk(o,path):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=="write": hits.append(path+["write"])
            walk(v,path+[k])
    elif isinstance(o,list):
        for idx,v in enumerate(o): walk(v,path+[str(idx)])
walk(d,[])
assert not hits, "emitted /agent-policies contains write key(s): %r" % hits
print("/agent-policies: no 'write' key anywhere (worker would throw at opencode-config-builder.ts:111)")
EOF
pass "d (permission.write stripped on store; never emitted by /agent-policies)"

# Restore before (e).
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$RESTORE_BODY_FILE" "$T8_DIR/d-restore.json")"
[[ "$code" == "200" ]] || fail "d" "restore PATCH HTTP $code"

# ================================================================ (e) M1: edit ABSENT -> catch-all stored
log "--- (e) M1: permission.edit ABSENT is stored with the catch-all ---"
M1_EDIT="$T8_DIR/e-m1-edit.json"
python3 - "$ORIG_OUT" "$M1_EDIT" <<'EOF'
import json,sys
orig=json.load(open(sys.argv[1])); out=sys.argv[2]
cfg=orig["config"]
new_cfg={"permission":{"bash":"deny"},"correction":cfg.get("correction")}
if "tools" in cfg: new_cfg["tools"]=cfg["tools"]
json.dump({"config":new_cfg}, open(out,"w"), ensure_ascii=False)
print("m1-edit body: permission={ bash: 'deny' } (NO edit key)")
EOF
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$M1_EDIT" "$T8_DIR/e-patch.json")"
[[ "$code" == "200" ]] || fail "e" "PATCH edit-absent HTTP $code (raw: $T8_DIR/e-patch.json)"
code="$(api GET "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" '' "$T8_DIR/e-stored.json")"
[[ "$code" == "200" ]] || fail "e" "GET after edit-absent PATCH HTTP $code"
python3 - "$T8_DIR/e-stored.json" <<'EOF' || fail "e" "edit ABSENT was NOT stored with the catch-all {'*':'deny'}"
import json,sys
stored=json.load(open(sys.argv[1]))
perm=stored.get("config",{}).get("permission") or {}
edit=perm.get("edit")
print("stored config.permission =", json.dumps(perm, ensure_ascii=False))
assert edit=={"*":"deny"}, "edit=%r (want {'*':'deny'})" % (edit,)
assert perm.get("bash")=="deny", "bash=%r" % (perm.get("bash"),)
print("stored: permission.edit == {'*': 'deny'} (catch-all injected)")
EOF
pass "e (edit ABSENT stored with the catch-all)"

# Restore after (e).
log "restoring $EDIT_POLICY_ID after (e) ..."
code="$(api PATCH "/execution-policies/$EDIT_POLICY_ID" "$ADMIN_JWT" "$RESTORE_BODY_FILE" "$T8_DIR/e-restore.json")"
[[ "$code" == "200" ]] || fail "e" "restore PATCH HTTP $code (raw: $T8_DIR/e-restore.json)"
deadline=$((SECONDS + POLL_TIMEOUT_SEC)); i=0; ok=""
while [[ $SECONDS -lt $deadline ]]; do
  i=$((i+1))
  if read_artifacts "$T8_DIR/final-opencode.json" "$T8_DIR/final-roles.json"; then
    if probe_absent_artifact "$T8_DIR/final-opencode.json" 2>/dev/null; then ok="yes"; break; fi
  fi
  sleep "$POLL_INTERVAL_SEC"
done
[[ -n "$ok" ]] || fail "e" "artifact did not settle to the restored state within ${POLL_TIMEOUT_SEC}s"
pass "e-restore (worker artifact settled; probe absent)"

# ================================================================ (c) frozen-sha gate END
log "--- (c) frozen-sha gate (end) ---"
final_sha="$(sha256_of "$BASELINE_POLICIES")"
log "baseline sha256 = $final_sha (frozen: $FROZEN_BASELINE_SHA256)"
[[ "$final_sha" == "$FROZEN_BASELINE_SHA256" ]] \
  || fail "c" "baseline sha256 changed: $final_sha != $FROZEN_BASELINE_SHA256 (it must never be modified)"
pass "c (frozen baseline sha256 matches at end)"

log "ALL ASSERTIONS PASSED: b (live round-trip + restore), c (frozen gate x2), d (write stripped/never emitted), e (M1 catch-all)"
