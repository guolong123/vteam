#!/usr/bin/env bash
#
# e2e: external (non-vteam) agents stay OUTSIDE vteam policy — live-stack proof
#      (third-party-agent-display Todo 5, the plan's closing honesty claim).
#
# Proves, against the LIVE compose stack, that:
#   A. `GET /api/v1/agents/opencode`'s external set is populated FROM THE ENGINE,
#      not a baked-in list. The engine list is obtained INDEPENDENTLY (see below)
#      and compared as SETS (extras/omissions reported both directions):
#        (a) endpoint governed:true            == serve names starting with vteam-
#        (b) endpoint governed:false           == serve names NOT starting with vteam-
#        (c) endpoint !governed && !hidden     == serve non-vteam-* && !hidden  (the UI set)
#        (d) endpoint governed:true            == GET /api/v1/agent-policies agents[].name
#   B. The injected artifacts carry NO external name in any agent-name slot:
#        - <workDir>/opencode.json            -> `agent` object keys
#        - <workDir>/.vteam-role-guard/roles.json -> `roles` object keys
#        - guard session mappings (.vteam-role-guard/sessions/*.json `agent` value)
#      plus a classified raw-text scan (allow-list: correction.handoff task-type
#      mapping keys like "plan": "vteam-plan" are NOT agent-name slots).
#   C. A negative control proves the structural check is discriminating: a real
#      external name injected into a /tmp COPY of each artifact is DETECTED;
#      the copies are then discarded and the live artifacts re-hashed unchanged.
#   D. The frozen baseline sha and worker/** are untouched.
#
# Independent engine sources (D1):
#   PRIMARY  — opencode serve direct HTTP from INSIDE the worker container:
#              `docker exec <worker> sh -c "curl -s http://127.0.0.1:<port>/agent?directory=<workDir>"`
#              Path: container -> serve. NO vteam code in between, whereas the
#              endpoint goes server -> worker exec endpoint -> serve. Equality is
#              therefore a real cross-path check, not self-grading.
#   SECONDARY— the injected opencode.json `agent` keys (the file opencode consumes).
#   REJECTED — `opencode agent list` CLI: observed NON-DETERMINISTIC truncation
#              (24/24/21/16/24 entries across runs of the same live stack; missing
#              vteam-* names) — it must NOT be used as an assertion source (D1).
#
# Immutability: this script is READ-ONLY for the stack. It does not restart or
# reload anything; no `docker compose up --force-recreate` (would rerun init/reseed).
# If the canonical artifacts were ABSENT, the script fails (with the discovery
# command in the log) rather than mutating state; `reload-config` is broadcast
# internally by the resource services on resource change and has no public
# per-worker HTTP route (checked: server/src/workers/workers.controller.ts).
#
# Run (from repo root):
#   bash scripts/e2e-third-party-no-policy-leak.sh
#
# Evidence: .omo/evidence/third-party-agent-display/task-5-live.txt
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEB_URL="${WEB_URL:-http://localhost:13001}"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
WORKER_CONTAINER="${WORKER_CONTAINER:-aiagents-compose-worker}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
FROZEN_BASELINE=".omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json"
FROZEN_SHA="3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87"
EVIDENCE_DIR="${EVIDENCE_DIR:-.omo/evidence/third-party-agent-display}"
case "$EVIDENCE_DIR" in /*) ;; *) EVIDENCE_DIR="$REPO_ROOT/$EVIDENCE_DIR";; esac
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/task-5-live.txt"
: >"$EVIDENCE_FILE"

log()  { printf '[e2e] %s\n' "$*" | tee -a "$EVIDENCE_FILE"; }
pass() { printf '[e2e] PASS %s\n' "$*" | tee -a "$EVIDENCE_FILE"; }
fail() { printf '[e2e] FAIL %s reason=%s\n' "$1" "$2" | tee -a "$EVIDENCE_FILE"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || { printf '[e2e] missing required command: %s\n' "$1" | tee -a "$EVIDENCE_FILE"; exit 2; }; }
need_cmd curl
need_cmd python3
need_cmd docker
need_cmd shasum

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log "date=$(date -u +%FT%TZ) HEAD=$(git rev-parse HEAD)"
log "SERVER_URL=$SERVER_URL WEB_URL=$WEB_URL WORKER_CONTAINER=$WORKER_CONTAINER EVIDENCE=$EVIDENCE_FILE"

# ---------------------------------------------------------------- pre-flight
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "server not healthy at $SERVER_URL"
curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "pre" "web not healthy at $WEB_URL"
docker ps --format '{{.Names}}' | grep -qx "$WORKER_CONTAINER" \
  || fail "pre" "worker container '$WORKER_CONTAINER' not running"
log "stack healthy (server + web + worker container)"

LOGIN_BODY="$(python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$ADMIN_USER" "$ADMIN_PASS")"
JWT="$(curl -sS -X POST "$SERVER_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  --data "$LOGIN_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("accessToken") or "")')"
[[ -n "$JWT" ]] || fail "pre" "login $ADMIN_USER failed (no accessToken)"
log "login OK ($ADMIN_USER)"

# ---------------------------------------------------------------- A0: independent engine source (D1)
WORK_DIR="$(docker exec "$WORKER_CONTAINER" printenv WORK_DIR 2>/dev/null | tr -d '\r')"
[[ -n "$WORK_DIR" ]] || WORK_DIR="/data/vteam-worker"
SERVE_PORT="$(docker exec "$WORKER_CONTAINER" sh -c "ps aux 2>/dev/null | grep '[o]pencode serve' | sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' | head -1" | tr -d '\r')"
SERVE_PORT_SOURCE="ps aux | grep '[o]pencode serve'"
if [[ -z "$SERVE_PORT" || "$SERVE_PORT" == "0" ]]; then
  SERVE_PORT="$(docker exec "$WORKER_CONTAINER" printenv OPENCODE_SERVE_PORT 2>/dev/null | tr -d '\r')"
  SERVE_PORT_SOURCE="env OPENCODE_SERVE_PORT (ps parse unavailable)"
fi
[[ -n "$SERVE_PORT" && "$SERVE_PORT" != "0" ]] || fail "A0" "cannot determine opencode serve port inside $WORKER_CONTAINER"
WORKER_STARTED_AT="$(docker inspect "$WORKER_CONTAINER" --format '{{.State.StartedAt}}')"
WORKER_ID_ENV="$(docker exec "$WORKER_CONTAINER" printenv WORKER_ID 2>/dev/null | tr -d '\r')"
log "[A0] independent source (primary): opencode serve direct HTTP from INSIDE the worker container"
log "[A0]   command: docker exec $WORKER_CONTAINER sh -c \"curl -sS http://127.0.0.1:$SERVE_PORT/agent?directory=$WORK_DIR\""
log "[A0]   why independent: container -> serve with NO vteam code in between; the endpoint path is server -> worker exec endpoint -> serve, so equality is a cross-path check, not self-grading"
log "[A0]   servePort=$SERVE_PORT (source: $SERVE_PORT_SOURCE), workDir=$WORK_DIR (worker env WORK_DIR)"
log "[A0] independent source (secondary): injected opencode.json 'agent' keys (the file opencode itself consumes)"
log "[A0] source REJECTED: 'opencode agent list' CLI — non-deterministic truncation observed 2026-09-19 on the SAME live stack (24/24/21/16/24 entries across 5 runs; 21-run missed vteam-product,vteam-project_manager,vteam-tester; 16-run missed all 8 vteam-* names). Not used as an assertion source (D1)."
log "[A0] worker container StartedAt=$WORKER_STARTED_AT workerId=$WORKER_ID_ENV"

# ---------------------------------------------------------------- A1/A2: fetch all three datasets
ENDPOINT_HTTP="$(curl -sS -o "$TMP_DIR/endpoint.json" -w '%{http_code}' \
  "$SERVER_URL/api/v1/agents/opencode" -H "Authorization: Bearer $JWT")"
[[ "$ENDPOINT_HTTP" == "200" ]] || fail "A1" "GET /agents/opencode HTTP $ENDPOINT_HTTP"
POLICIES_HTTP="$(curl -sS -o "$TMP_DIR/policies.json" -w '%{http_code}' \
  "$SERVER_URL/api/v1/agent-policies" -H "Authorization: Bearer $JWT")"
[[ "$POLICIES_HTTP" == "200" ]] || fail "A2" "GET /agent-policies HTTP $POLICIES_HTTP"

docker exec "$WORKER_CONTAINER" sh -c "curl -sS -m 20 'http://127.0.0.1:$SERVE_PORT/agent?directory=$WORK_DIR'" >"$TMP_DIR/serve-agents.json" \
  || fail "A3" "direct serve /agent fetch failed"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,list) and d, "empty serve list"; print(len(d))' "$TMP_DIR/serve-agents.json" >/dev/null \
  || fail "A3" "direct serve /agent returned no list"

# ---------------------------------------------------------------- A4: set comparisons (a)-(d)
if ! python3 - "$TMP_DIR/endpoint.json" "$TMP_DIR/serve-agents.json" "$TMP_DIR/policies.json" "$SERVE_PORT" "$WORK_DIR" "$WORKER_STARTED_AT" <<'PY' | tee -a "$EVIDENCE_FILE"
import json, sys
ep_doc = json.load(open(sys.argv[1])); serve = json.load(open(sys.argv[2])); pol = json.load(open(sys.argv[3]))
serve_port, work_dir, started = sys.argv[4], sys.argv[5], sys.argv[6]
ep = ep_doc.get("agents") or []
def fmt(s): return json.dumps(sorted(s), ensure_ascii=False)
def cmp(label, got, want):
    extras = sorted(got - want); omissions = sorted(want - got)
    print(f"[set] {label}: n={len(got)} extras={fmt(extras)} omissions={fmt(omissions)}")
    return not extras and not omissions
sv = {a["name"]: a for a in serve}
sv_names = set(sv)
hidden = {n: bool(sv[n].get("hidden")) for n in sv}
ep_names = {a["name"] for a in ep}
ep_gov = {a["name"] for a in ep if a.get("governed") is True}
ep_ext_all = {a["name"] for a in ep if a.get("governed") is False}
ep_ext_visible = {a["name"] for a in ep if a.get("governed") is False and not a.get("hidden")}
sv_gov = {n for n in sv_names if n.startswith("vteam-")}
sv_ext = sv_names - sv_gov
sv_ext_visible = {n for n in sv_ext if not hidden[n]}
pol_names = {a["name"] for a in (pol.get("agents") or [])}
print("=== A. independent engine source & set comparison ===")
print(f"[A1] GET /api/v1/agents/opencode: workerId={ep_doc.get('workerId')} degraded={ep_doc.get('degraded')} count={len(ep)}")
print(f"[A2] serve direct GET /agent?directory={work_dir} (port {serve_port}): count={len(sv)}")
ok = True
ok &= cmp("(a) governed     endpoint governed:true  == serve vteam-*          ", ep_gov, sv_gov)
ok &= cmp("(b) external     endpoint governed:false == serve non-vteam-*      ", ep_ext_all, sv_ext)
ok &= cmp("(c) visible-ext  endpoint !gov && !hidden == serve !vteam-* && !hidden", ep_ext_visible, sv_ext_visible)
ok &= cmp("(d) policies     endpoint governed:true  == /agent-policies names ", ep_gov, pol_names)
ok &= cmp("(#) sanity       endpoint all names       == serve all names      ", ep_names, sv_names)
drift_non_gov = sorted(sv_gov - ep_gov)
drift_gov = sorted(n for n in sv_ext if n in ep_gov)
print(f"[drift] vteam-* names NOT governed: {fmt(drift_non_gov)}")
print(f"[drift] non-vteam names governed:  {fmt(drift_gov)}")
print(f"[A3] endpoint all count={len(ep_names)} governed={len(ep_gov)} external={len(ep_ext_all)} visible-external={len(ep_ext_visible)}")
print(f"[A3] serve    all count={len(sv_names)} vteam-*={len(sv_gov)} non-vteam-*={len(sv_ext)} visible-non-vteam={len(sv_ext_visible)}")
print(f"[A4] hidden names (serve): {fmt({n for n in sv if hidden[n]})}")
print("[A5] secondary source check will compare opencode.json agent keys vs /agent-policies (section B/C)")
sys.exit(0 if ok else 1)
PY
then
  fail "A" "set comparison mismatch (see extras/omissions above)"
fi
pass "A (all set comparisons a/b/c/d match; no extras, no omissions)"

# ---------------------------------------------------------------- B: artifact discovery + leak check
log "=== B. injected-artifact leak check (STRUCTURAL) ==="
DISC="$(docker exec "$WORKER_CONTAINER" sh -c "find '$WORK_DIR' -maxdepth 3 \\( -name opencode.json -o -name roles.json \\) 2>/dev/null" | tr -d '\r')"
log "[B0] discovery: docker exec $WORKER_CONTAINER sh -c \"find $WORK_DIR -maxdepth 3 \\( -name opencode.json -o -name roles.json \\)\""
log "[B0] found:"
printf '%s\n' "$DISC" | sed 's/^/[B0]   /' | tee -a "$EVIDENCE_FILE"
printf '%s\n' "$DISC" | grep -qx "$WORK_DIR/opencode.json" || fail "B0" "canonical $WORK_DIR/opencode.json missing"
printf '%s\n' "$DISC" | grep -qx "$WORK_DIR/.vteam-role-guard/roles.json" || fail "B0" "canonical $WORK_DIR/.vteam-role-guard/roles.json missing"

mkdir -p "$TMP_DIR/live"
docker cp "$WORKER_CONTAINER:$WORK_DIR/opencode.json" "$TMP_DIR/live/opencode.json" >/dev/null
docker cp "$WORKER_CONTAINER:$WORK_DIR/.vteam-role-guard/roles.json" "$TMP_DIR/live/roles.json" >/dev/null
CANON_COUNT=2
EXTRA_LIST=""
if docker exec "$WORKER_CONTAINER" sh -c 'test -f /root/.config/opencode/opencode.json' 2>/dev/null; then
  docker cp "$WORKER_CONTAINER:/root/.config/opencode/opencode.json" "$TMP_DIR/live/opencode-home.json" >/dev/null
  EXTRA_LIST="/root/.config/opencode/opencode.json"
  CANON_COUNT=3
fi
log "[B0] files checked: $CANON_COUNT (2 canonical injected artifacts${EXTRA_LIST:+ + 1 supplementary HOME model-credential config: $EXTRA_LIST})"
log "[B0] sha256 opencode.json = $(shasum -a 256 "$TMP_DIR/live/opencode.json" | awk '{print $1}') (mtime: $(docker exec "$WORKER_CONTAINER" sh -c "stat -c '%y' '$WORK_DIR/opencode.json'" 2>/dev/null | tr -d '\r'))"
log "[B0] sha256 roles.json    = $(shasum -a 256 "$TMP_DIR/live/roles.json" | awk '{print $1}') (mtime: $(docker exec "$WORKER_CONTAINER" sh -c "stat -c '%y' '$WORK_DIR/.vteam-role-guard/roles.json'" 2>/dev/null | tr -d '\r'))"
log "[B0] policy-set equality (freshness signal): comparing artifact keys vs /agent-policies names"

python3 - "$TMP_DIR/endpoint.json" "$TMP_DIR/live/opencode.json" "$TMP_DIR/live/roles.json" <<'PY' | tee -a "$EVIDENCE_FILE"
import json, sys
ep = json.load(open(sys.argv[1])); oc = json.load(open(sys.argv[2])); rl = json.load(open(sys.argv[3]))
policies = {a["name"] for a in ep["agents"] if a.get("governed")}
oc_keys = set((oc.get("agent") or {}).keys()); role_keys = set((rl.get("roles") or {}).keys())
print(f"[B1] opencode.json agent keys ({len(oc_keys)}) == /agent-policies governed names: {oc_keys == policies}")
if oc_keys != policies: print(f"[B1]   divergence: extra={sorted(oc_keys-policies)} missing={sorted(policies-oc_keys)} (stale injection? no state was mutated by this script)")
print(f"[B1] roles.json roles keys ({len(role_keys)}) == /agent-policies governed names: {role_keys == policies}")
if role_keys != policies: print(f"[B1]   divergence: extra={sorted(role_keys-policies)} missing={sorted(policies-role_keys)}")
print(f"[B1] guard session-mapping agent-name key set (roles.json keys) is exactly the governed set — external-name membership is asserted structurally in the leak check below")
print(f"[B1] roles.json enabled={rl.get('enabled')}")
PY

# external name list is ENGINE-DERIVED at runtime (never hardcoded as source of truth)
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(sorted(a["name"] for a in d["agents"] if a.get("governed") is False), ensure_ascii=False))' \
  "$TMP_DIR/endpoint.json" >"$TMP_DIR/externals.json"
RUNTIME_EXT_COUNT="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TMP_DIR/externals.json")"
log "[B2] external names (engine-derived, $RUNTIME_EXT_COUNT): $(cat "$TMP_DIR/externals.json")"

# structural checker (same code used for the negative control in C)
cat >"$TMP_DIR/check.py" <<'PY'
#!/usr/bin/env python3
"""Structural leak checker for injected opencode artifacts.

A name is a LEAK only in an agent-name SLOT:
  - kind=opencode / opencode-home : top-level key of the root `agent` object
  - kind=roles                    : top-level key of the root `roles` object
Any other hit must be explicitly justifiable; the only allow-listed shape is the
roles.json `correction.handoff` task-type -> governed-agent mapping key
(e.g. "plan": "vteam-plan"), whose value MUST be a vteam-* name. Everything else
is reported as UNEXPLAINED and makes the check fail. A raw-text residue check
(quoted-token occurrences not attributable to a walked JSON hit) fails too.
Exit 0 = clean, 1 = leak/unexplained.
"""
import json, re, sys

HANDOFF_RE = re.compile(r"^roles/[^/]+/correction/handoff/[^/]+$")

def walk(node, path, ext, hits):
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}/{k}" if path else str(k)
            if k in ext:
                hits.append({"path": p, "kind": "key", "value": v if isinstance(v, str) else None})
            if isinstance(v, str) and v in ext:
                hits.append({"path": p, "kind": "value", "value": v})
            walk(v, p, ext, hits)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}/{i}", ext, hits)
    return hits

def is_slot(kind, hit):
    """An agent-name SLOT = a TOP-LEVEL key of the root `agent`/`roles` object.

    Exact depth-2 check (`agent/<name>` / `roles/<name>`): a nested occurrence
    (e.g. the roles.json `correction.handoff` task-type mapping key `plan`) is
    NOT an agent-name slot and must be justified separately.
    """
    parts = hit["path"].split("/")
    if kind in ("opencode", "opencode-home"):
        return len(parts) == 2 and parts[0] == "agent"
    if kind == "roles":
        return len(parts) == 2 and parts[0] == "roles"
    return False

def is_justified(kind, hit):
    if kind == "roles" and hit["kind"] == "key" and HANDOFF_RE.match(hit["path"]):
        v = hit.get("value")
        return isinstance(v, str) and v.startswith("vteam-")
    return False

def main():
    path, kind, ext_path = sys.argv[1], sys.argv[2], sys.argv[3]
    display = sys.argv[4] if len(sys.argv) > 4 else path
    raw = open(path, encoding="utf-8").read()
    doc = json.loads(raw)
    ext = set(json.load(open(ext_path, encoding="utf-8")))
    hits = walk(doc, "", ext, [])
    slots = [h for h in hits if is_slot(kind, h)]
    nonslots = [h for h in hits if not is_slot(kind, h)]
    justified = [h for h in nonslots if is_justified(kind, h)]
    unexplained = [h for h in nonslots if not is_justified(kind, h)]
    root_key = "roles" if kind == "roles" else "agent"
    has_section = isinstance(doc.get(root_key), dict)
    residue = []
    for n in sorted(ext):
        token = '"' + n + '"'
        cnt = raw.count(token)
        wcnt = sum(1 for h in hits if (h["kind"] == "key" and h["path"].split("/")[-1] == n) or (h["kind"] == "value" and h["value"] == n))
        if cnt > wcnt:
            i = raw.find(token)
            residue.append({"name": n, "rawCount": cnt, "walkCount": wcnt, "context": raw[max(0, i - 60):i + 60]})
    print(f"[check] {display} kind={kind} bytes={len(raw)}")
    if not has_section:
        print(f"[check]   note: no `{root_key}` section present (agent-slot assertion is vacuously clean for this file)")
    print(f"[check]   agent-name slot hits: {len(slots)}")
    for h in slots:
        print(f"[LEAK]    slot={h['path']} kind={h['kind']} value={json.dumps(h['value'], ensure_ascii=False)}")
    print(f"[check]   non-slot hits: {len(nonslots)} (justified={len(justified)}, unexplained={len(unexplained)})")
    for h in justified:
        print(f"[hit]     path={h['path']} kind={h['kind']} value={json.dumps(h['value'], ensure_ascii=False)} classification=handoff-task-type-mapping(justified)")
    for h in unexplained:
        print(f"[UNEXPLAINED] path={h['path']} kind={h['kind']} value={json.dumps(h['value'], ensure_ascii=False)}")
    for r in residue:
        print(f"[UNEXPLAINED] raw-text residue name={r['name']!r} rawCount={r['rawCount']} walkCount={r['walkCount']} context={r['context']!r}")
    clean = not slots and not unexplained and not residue
    print(f"[check]   result: {'CLEAN' if clean else 'LEAK'} (slotHits={len(slots)} unexplainedHits={len(unexplained) + len(residue)})")
    sys.exit(0 if clean else 1)

main()
PY

check_artifact() { # <path> <kind> <display>
  local out rc
  out="$(python3 "$TMP_DIR/check.py" "$1" "$2" "$TMP_DIR/externals.json" "$3" 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out" | tee -a "$EVIDENCE_FILE"
  return $rc
}

check_artifact "$TMP_DIR/live/opencode.json" opencode "$WORK_DIR/opencode.json" \
  || fail "B-oc" "opencode.json has an agent-slot leak / unexplained hit"
check_artifact "$TMP_DIR/live/roles.json" roles "$WORK_DIR/.vteam-role-guard/roles.json" \
  || fail "B-roles" "roles.json has a roles-slot leak / unexplained hit"
if [[ -f "$TMP_DIR/live/opencode-home.json" ]]; then
  check_artifact "$TMP_DIR/live/opencode-home.json" opencode-home "/root/.config/opencode/opencode.json" \
    || fail "B-home" "HOME opencode.json has an agent-slot leak / unexplained hit"
fi
pass "B (structural leak check clean on $CANON_COUNT files; slotHits=0; unexplainedHits=0)"

# ---------------------------------------------------------------- B3: guard session mappings
log "=== B3. guard session->policy mappings ==="
SESS_DIR="$WORK_DIR/.vteam-role-guard/sessions"
mkdir -p "$TMP_DIR/sessions"
while IFS= read -r sf; do
  [[ -n "$sf" ]] || continue
  docker cp "$WORKER_CONTAINER:$sf" "$TMP_DIR/sessions/$(basename "$sf")" >/dev/null
done < <(docker exec "$WORKER_CONTAINER" sh -c "ls -1 '$SESS_DIR'/*.json 2>/dev/null" | tr -d '\r' || true)
SESS_COUNT="$(find "$TMP_DIR/sessions" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
log "[B3] discovered session mapping files: $SESS_COUNT"
if ! python3 - "$TMP_DIR/sessions" "$TMP_DIR/externals.json" "$TMP_DIR/live/roles.json" <<'PY' | tee -a "$EVIDENCE_FILE"
import json, os, sys
sess_dir, ext_path, roles_path = sys.argv[1], sys.argv[2], sys.argv[3]
ext = set(json.load(open(ext_path))); role_keys = set((json.load(open(roles_path)).get("roles") or {}).keys())
bad = []
files = sorted(f for f in os.listdir(sess_dir) if f.endswith(".json")) if os.path.isdir(sess_dir) else []
for f in files:
    d = json.load(open(os.path.join(sess_dir, f)))
    agent = d.get("agent")
    mapped = agent in role_keys
    external = agent in ext
    print(f"[B3] {f}: agent={agent!r} mapped-to-policy={mapped} external={external} dir={d.get('dir')}")
    if external or not mapped:
        bad.append(f)
print(f"[B3] session mappings checked={len(files)} violations={len(bad)} (external agent mapped or unmapped agent: {bad})")
sys.exit(1 if bad else 0)
PY
then
  fail "B3" "session mapping contains an external or unmapped agent name"
fi
pass "B3 (all session mappings point at governed agents; no external mapping)"

# ---------------------------------------------------------------- C: negative control (D4)
log "=== C. negative control — the structural check MUST detect an injected external name ==="
# Prefer the external name 'plan' when present: it is ALSO a legitimate handoff
# task-type mapping KEY (`correction.handoff.plan` -> "vteam-plan"), so it proves
# the checker distinguishes a true agent-name slot from a justified non-slot hit.
NC_NAME="$(python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); print("plan" if "plan" in e else sorted(e)[0])' "$TMP_DIR/externals.json")"
log "[C1] chosen real external name (from the engine list): $(printf '%s' "$NC_NAME") (also a legitimate handoff mapping key — the control proves slot vs non-slot discrimination)"
mkdir -p "$TMP_DIR/nc"
python3 - "$TMP_DIR/live/opencode.json" "$TMP_DIR/live/roles.json" "$TMP_DIR/nc" "$NC_NAME" <<'PY'
import json, sys
oc_path, roles_path, out_dir, name = sys.argv[1:5]
oc = json.load(open(oc_path)); rl = json.load(open(roles_path))
oc.setdefault("agent", {})[name] = {"mode": "primary", "description": "negative-control injection"}
rl.setdefault("roles", {})[name] = {"permission": {}, "tools": {}}
json.dump(oc, open(f"{out_dir}/opencode.json", "w"), ensure_ascii=False, indent=2)
json.dump(rl, open(f"{out_dir}/roles.json", "w"), ensure_ascii=False, indent=2)
print(f"[C2] injected {name!r} as a top-level key of opencode.json `agent` and roles.json `roles` (TMP COPIES ONLY)")
PY
NC_OC_RC=0; NC_ROLES_RC=0
python3 "$TMP_DIR/check.py" "$TMP_DIR/nc/opencode.json" opencode "$TMP_DIR/externals.json" "NC copy opencode.json" >"$TMP_DIR/nc-oc.txt" 2>&1 || NC_OC_RC=$?
python3 "$TMP_DIR/check.py" "$TMP_DIR/nc/roles.json" roles "$TMP_DIR/externals.json" "NC copy roles.json" >"$TMP_DIR/nc-roles.txt" 2>&1 || NC_ROLES_RC=$?
cat "$TMP_DIR/nc-oc.txt" "$TMP_DIR/nc-roles.txt" | tee -a "$EVIDENCE_FILE"
[[ "$NC_OC_RC" -ne 0 ]] || fail "C" "negative control NOT detected in opencode.json copy (check is not discriminating)"
[[ "$NC_ROLES_RC" -ne 0 ]] || fail "C" "negative control NOT detected in roles.json copy (check is not discriminating)"
grep -q 'result: LEAK' "$TMP_DIR/nc-oc.txt" || fail "C" "opencode.json NC exited non-zero for a non-detection reason (crash, not a leak)"
grep -q 'result: LEAK' "$TMP_DIR/nc-roles.txt" || fail "C" "roles.json NC exited non-zero for a non-detection reason (crash, not a leak)"
grep -q '\[LEAK\]' "$TMP_DIR/nc-oc.txt" || fail "C" "opencode.json NC did not report a [LEAK] slot hit"
grep -q '\[LEAK\]' "$TMP_DIR/nc-roles.txt" || fail "C" "roles.json NC did not report a [LEAK] slot hit"
log "[C3] both NC copies correctly DETECTED (exit 1 each + 'result: LEAK' + [LEAK] slot hit) — the structural check is discriminating"

# re-verify live artifacts are byte-identical after the control (they were never touched)
docker cp "$WORKER_CONTAINER:$WORK_DIR/opencode.json" "$TMP_DIR/live/opencode.post.json" >/dev/null
docker cp "$WORKER_CONTAINER:$WORK_DIR/.vteam-role-guard/roles.json" "$TMP_DIR/live/roles.post.json" >/dev/null
shasum -a 256 "$TMP_DIR/live/opencode.json" "$TMP_DIR/live/opencode.post.json" | tee -a "$EVIDENCE_FILE"
shasum -a 256 "$TMP_DIR/live/roles.json" "$TMP_DIR/live/roles.post.json" | tee -a "$EVIDENCE_FILE"
cmp -s "$TMP_DIR/live/opencode.json" "$TMP_DIR/live/opencode.post.json" || fail "C4" "live opencode.json changed during the run"
cmp -s "$TMP_DIR/live/roles.json" "$TMP_DIR/live/roles.post.json" || fail "C4" "live roles.json changed during the run"
rm -rf "$TMP_DIR/nc" "$TMP_DIR/nc-oc.txt" "$TMP_DIR/nc-roles.txt"
pass "C (NC detected in both artifacts; live artifacts byte-identical before/after; copies discarded)"

# ---------------------------------------------------------------- D: frozen baseline + worker untouched
log "=== D. frozen baseline + worker/** untouched ==="
ACTUAL_SHA="$(shasum -a 256 "$FROZEN_BASELINE" | awk '{print $1}')"
log "[D1] $FROZEN_BASELINE"
log "[D1] sha256 actual=$ACTUAL_SHA expected=$FROZEN_SHA"
[[ "$ACTUAL_SHA" == "$FROZEN_SHA" ]] || fail "D1" "frozen baseline sha changed"
pass "D1 (frozen baseline sha unchanged)"
WORKER_DIFF="$(git diff --stat -- worker/)"
WORKER_UNTRACKED="$(git status --porcelain -- worker/)"
[[ -z "$WORKER_DIFF" ]] || fail "D2" "worker/ has tracked modifications: $WORKER_DIFF"
[[ -z "$WORKER_UNTRACKED" ]] || fail "D2" "worker/ has untracked/other changes: $WORKER_UNTRACKED"
pass "D2 (worker/** untouched: no tracked diff, no untracked files)"

# ---------------------------------------------------------------- E: stack still healthy
curl -sS -o /dev/null -w '%{http_code}' "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '^200$' \
  || fail "E" "server health lost after run"
curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/login" 2>/dev/null | grep -q '^200$' \
  || fail "E" "web health lost after run"
docker ps --format '{{.Names}}' | grep -qx "$WORKER_CONTAINER" || fail "E" "worker container gone"
pass "E (stack still healthy: server + web + worker)"

log ""
log "SUMMARY: (a)(b)(c)(d) set-equal (extras=[] omissions=[]); $CANON_COUNT artifacts checked, 0 agent-slot leak hits, 0 unexplained hits; negative control detected; frozen sha unchanged; worker/** untouched; stack healthy."
log "all assertions PASS; evidence: $EVIDENCE_FILE"
