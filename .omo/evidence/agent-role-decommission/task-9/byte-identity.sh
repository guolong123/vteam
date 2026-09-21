#!/usr/bin/env bash
# todo 9 (c) — frozen-sha byte-identity gate against the LIVE stack.
#
# This runs the frozen-sha gate of scripts/e2e-role-boundaries.sh (its scenario-f
# python comparison, quoted verbatim below) WITHOUT executing the whole shell script:
# the script's EXIT trap issues `docker compose up -d --force-recreate worker`
# (scripts/e2e-role-boundaries.sh:149), and this todo's constraints forbid
# `--force-recreate` outright. The comparison logic is therefore the script's own,
# run against the live stack; no live-DB edit is involved in this part.
#
# Proven here:
#   1. the frozen baseline file's sha256 == the frozen sha and the file is git-clean
#      (it is NOT modified by this todo);
#   2. LIVE GET /agent-policies: the 7 built-ins canonical subset is byte-identical
#      to the frozen baseline;
#   3. the LIVE worker's injected artifacts (opencode.json + .vteam-role-guard/roles.json):
#      the 7 built-ins are byte-identical to the frozen baseline;
#   4. the canonical subset written as after-agent-policies.json is byte-identical
#      to before-agent-policies.json (sha256 equality, as the script does).
set -euo pipefail

REPO="/Volumes/SSD-Data/01work/git-project/vteam"
OUT="$REPO/.omo/evidence/agent-role-decommission/task-9"
BASELINE="$REPO/.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json"
FROZEN_SHA="3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87"
SERVER_URL="${SERVER_URL:-http://localhost:13000}"
TOKEN="${X_WORKER_TOKEN:-compose-worker-token}"
DOCKER() { docker "$@"; }

echo "== 1. frozen baseline integrity =="
actual_sha="$(shasum -a 256 "$BASELINE" | awk '{print $1}')"
echo "frozen file sha256 = $actual_sha"
echo "expected frozen sha = $FROZEN_SHA"
[[ "$actual_sha" == "$FROZEN_SHA" ]] || { echo "FAIL: frozen sha drift"; exit 1; }
echo "--- git status of the baseline (must be unchanged) ---"
git -C "$REPO" status --porcelain -- "$BASELINE" | sed 's/^/  /'
changes="$(git -C "$REPO" status --porcelain -- "$BASELINE" | wc -l | tr -d ' ')"
echo "git-dirty-lines = $changes"
[[ "$changes" == "0" ]] || { echo "FAIL: frozen baseline modified"; exit 1; }

echo "== 2. LIVE GET /agent-policies vs frozen baseline =="
curl -sS -o "$OUT/live-agent-policies.json" -w 'HTTP %{http_code}\n' \
  "$SERVER_URL/api/v1/agent-policies" -H "X-Worker-Token: $TOKEN"

echo "== 3. LIVE worker injected artifacts =="
DOCKER cp aiagents-compose-worker:/data/vteam-worker/opencode.json "$OUT/live-injected-opencode.json"
DOCKER cp aiagents-compose-worker:/data/vteam-worker/.vteam-role-guard/roles.json "$OUT/live-injected-roles.json"

python3 - "$OUT/live-agent-policies.json" "$BASELINE" "$OUT/after-agent-policies.json" \
         "$OUT/live-injected-opencode.json" "$OUT/live-injected-roles.json" "$OUT/byte-identity.txt" <<'EOF'
import json, sys, hashlib
live_path, base_path, after_path, oc_path, roles_path, report = sys.argv[1:7]
def canon(o): return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
base = json.load(open(base_path))
live = json.load(open(live_path))
order = [a["name"] for a in base["agents"]]
lines = []

# --- (2) live /agent-policies canonical subset (verbatim logic from e2e-role-boundaries.sh) ---
la = {a["name"]: a for a in live.get("agents") or []}
lr = (live.get("guard") or {}).get("roles") or {}
subset = {"agents": [la[n] for n in order],
          "guard": {"enabled": live["guard"]["enabled"], "roles": {n: lr[n] for n in order}}}
json.dump(subset, open(after_path, "w"), ensure_ascii=False, indent=2)
open(after_path, "a").write("\n")
same_api = canon(subset) == canon(base)
lines.append("LIVE /agent-policies 7-builtin canonical subset == frozen baseline: %s" % same_api)
lines.append("  live agent count = %d, builtin order = %r" % (len(live.get("agents") or []), order))

# --- (4) after vs before byte-identity (sha256, exactly as the script does) ---
after_sha = hashlib.sha256(open(after_path, "rb").read()).hexdigest()
before_sha = hashlib.sha256(open(base_path, "rb").read()).hexdigest()
lines.append("after-agent-policies.json sha256  = %s" % after_sha)
lines.append("before-agent-policies.json sha256 = %s" % before_sha)
lines.append("byte-identical = %s" % (after_sha == before_sha))

# --- (3) live injected artifacts: the 7 builtins must be byte-identical ---
oc = json.load(open(oc_path))
roles_doc = json.load(open(roles_path))
oc_agents = oc.get("agent") or {}
roles = roles_doc.get("roles") or {}
base_roles = (base.get("guard") or {}).get("roles") or {}
ok_roles = ok_oc = True
for name in order:
    same_role = canon(roles.get(name)) == canon(base_roles.get(name))
    ok_roles = ok_roles and same_role
    oc_entry = oc_agents.get(name) or {}
    oc_perm = oc_entry.get("permission")
    roles_perm = (base_roles.get(name) or {}).get("permission")
    full_entry = {"description": oc_entry.get("description"), "mode": oc_entry.get("mode"),
                  "permission": oc_perm}
    base_entry = {"description": next(a["description"] for a in base["agents"] if a["name"] == name),
                  "mode": next(a["mode"] for a in base["agents"] if a["name"] == name),
                  "permission": roles_perm}
    same_oc = canon(full_entry) == canon(base_entry)
    ok_oc = ok_oc and same_oc
    lines.append("  injected roles.json[%s] IDENTICAL: %s | injected opencode.json[%s] IDENTICAL: %s"
                 % (name, same_role, name, same_oc))
lines.append("injected roles.json enabled = %s; injected agent names = %r" % (roles_doc.get("enabled"), sorted(oc_agents)))
lines.append("ALL injected 7-builtin entries byte-identical: roles=%s opencode=%s" % (ok_roles, ok_oc))

text = "\n".join(lines) + "\n"
open(report, "w").write(text)
print(text)
assert same_api and after_sha == before_sha and ok_roles and ok_oc, "byte-identity gate FAILED"
EOF
echo "BYTE_IDENTITY_RC=$?"
