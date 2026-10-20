#!/usr/bin/env bash
# =============================================================================
# repro.sh — one-shot, credential-free reproduction of the opencode v2 spikes
#             T4 (role prompt reaches the model) and T5 (v2 tool registration).
#
# Requires: the real opencode binary (v2) and node. NO provider credentials,
#            NO quota, NO network access to any model provider.
#
#   ./repro.sh                # use /Users/mac/.opencode/bin/opencode
#   OPENCODE_BIN=... ./repro.sh
#
# Everything is written to $SCRATCH (default: a fresh mktemp -d under $TMPDIR).
# The script kills every process it starts.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_BIN="${OPENCODE_BIN:-/Users/mac/.opencode/bin/opencode}"
MOCK_PORT="${MOCK_PORT:-45981}"
SERVE_PORT="${SERVE_PORT:-45980}"
PW="spikepass"
SCRATCH="${SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/opencode-v2-spike.XXXXXX")}"
PROJ="$SCRATCH/proj"
XDG="$SCRATCH/xdg"
REQ="$SCRATCH/requests.jsonl"
SSE="$SCRATCH/sse.log"
RC=0

cleanup() {
  pkill -f "opencode serve --port $SERVE_PORT " 2>/dev/null
  pkill -f "mock-provider.mjs" 2>/dev/null
  sleep 0.3
}
trap cleanup EXIT INT TERM

api() { # api <method> <path> [body]
  local method="$1" apath="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -u "opencode:$PW" -X "$method" -H "content-type: application/json" -d "$body" "http://127.0.0.1:$SERVE_PORT$apath"
  else
    curl -s -u "opencode:$PW" -X "$method" "http://127.0.0.1:$SERVE_PORT$apath"
  fi
}

echo "opencode: $("$OPENCODE_BIN" --version)"
echo "scratch : $SCRATCH"

# ---------------------------------------------------------------- mock provider
mkdir -p "$SCRATCH/out" "$PROJ/.opencode/plugins" "$XDG/.config"
# make sure nothing else already owns the mock port (a stale mock would silently
# swallow the recorded requests and make every assertion look empty)
pkill -f "mock-provider.mjs" 2>/dev/null
sleep 0.3
MOCK_PORT="$MOCK_PORT" MOCK_OUT="$REQ" node "$HERE/mock-provider.mjs" > "$SCRATCH/mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 40); do curl -s "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 && break; sleep 0.25; done
if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo "FATAL: mock provider failed to start (port $MOCK_PORT busy?)"; cat "$SCRATCH/mock.log"; exit 2
fi
export MOCK_PORT

# ---------------------------------------------------------------- project setup
python3 - "$HERE/mock-opencode.json" "$PROJ/opencode.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
d['providers']['spike-mock']['settings']['baseURL']="http://127.0.0.1:%s/v1" % __import__('os').environ.get('MOCK_PORT','45981')
json.dump(d,open(sys.argv[2],'w'),indent=2)
PY
cp "$HERE/v2-tool-plugin.ts" "$PROJ/.opencode/plugins/v2-tool-plugin.ts"

# ---------------------------------------------------------------- start serve
(
  cd "$PROJ" || exit 1
  HOME="$XDG" XDG_CONFIG_HOME="$XDG/.config" XDG_DATA_HOME="$XDG/data" \
  XDG_STATE_HOME="$XDG/state" XDG_CACHE_HOME="$XDG/cache" \
  OPENCODE_SERVER_PASSWORD="$PW" OPENCODE_SERVER_USERNAME=opencode \
  exec "$OPENCODE_BIN" serve --port "$SERVE_PORT" --hostname 127.0.0.1 --print-logs --log-level debug
) > "$SCRATCH/serve.log" 2>&1 &
for i in $(seq 1 100); do
  curl -s -u "opencode:$PW" "http://127.0.0.1:$SERVE_PORT/api/info" >/dev/null 2>&1 && break
  sleep 0.25
done
( curl -sN -u "opencode:$PW" "http://127.0.0.1:$SERVE_PORT/api/event" > "$SSE" 2>&1 ) &
sleep 1

mk_session() { api POST /api/session "{\"location\":{\"directory\":\"$PROJ\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])'; }

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (expected=$2 actual=$3)"; RC=1; fi
}

echo
echo "=== T4: role prompt into the final model request ==="
S1=$(mk_session)
api POST "/api/session/$S1/agent" '{"agent":"vteam-sys"}' >/dev/null
api POST "/api/session/$S1/prompt" '{"text":"T4 probe"}' >/dev/null
sleep 6

S2=$(mk_session)
api POST "/api/session/$S2/prompt" '{"text":"T4 probe","agents":[{"name":"vteam-prom"}]}' >/dev/null
sleep 6

S3=$(mk_session)
api POST "/api/session/$S3/prompt" '{"text":"T4 probe"}' >/dev/null
sleep 6

python3 - "$REQ" "$S1" "$S2" "$S3" <<'PY'
import json,sys
req, s1, s2, s3 = sys.argv[1:5]
rows=[json.loads(l) for l in open(req)]
per={}
for r in rows:
    sid=r['headers'].get('x-opencode-session')
    sysm=[m for m in r['body'].get('messages',[]) if m.get('role')=='system']
    if not sysm: continue
    c=sysm[0].get('content','')
    if 'title generator' in c: continue
    per.setdefault(sid,[]).append(c)
def has(sid,marker):
    return any(marker in c for c in per.get(sid,[]))
print("T4_RESULTS", json.dumps({
  "switch_agent_puts_system_in_request": has(s1,"ROLE_PROMPT_MARKER_VTEAM_SYS"),
  "agents_attachment_pulls_system":      has(s2,"ROLE_PROMPT_MARKER_VTEAM_PROM"),
  "agents_attachment_is_noop":           not has(s2,"ROLE_PROMPT_MARKER_VTEAM_PROM"),
}))
PY

echo
echo "=== T4: delivery=steer on an idle session ==="
S4=$(mk_session)
sleep 1
api POST "/api/session/$S4/prompt" '{"text":"T4 steer probe","delivery":"steer"}' >/dev/null
sleep 5
python3 - "$SSE" "$S4" <<'PY'
import json,sys
sse,sid=sys.argv[1:3]
seq=[]
for line in open(sse):
    if not line.startswith('data: '): continue
    try: ev=json.loads(line[6:])
    except Exception: continue
    if (ev.get('type') or '').startswith('session.inbox') or (ev.get('type') or '').startswith('session.execution'):
        if sid in json.dumps(ev.get('data') or {}):
            seq.append((ev.get('created'), ev.get('type')))
print("T4_STEER_EVENTS", json.dumps(seq))
if len(seq)>=2:
    print("  steer executed immediately: enqueued->started delta = %d ms" % (seq[1][0]-seq[0][0]))
PY

echo
echo "=== T5: v2 plugin tool registered AND invoked ==="
S5=$(mk_session)
api POST "/api/session/$S5/prompt" '{"text":"call spike_probe __TOOL__:spike_probe:{\"note\":\"hi\"}"}' >/dev/null
sleep 8
python3 - "$SSE" "$S5" <<'PY'
import json,sys
sse,sid=sys.argv[1:3]
called=success=False; toolname=None
for line in open(sse):
    if not line.startswith('data: '): continue
    try: ev=json.loads(line[6:])
    except Exception: continue
    t=ev.get('type') or ''
    d=ev.get('data') or {}
    if d.get('sessionID')!=sid: continue
    if t=='session.tool.input.started': toolname=d.get('name')
    if t=='session.tool.called': called=True
    if t=='session.tool.success': success=True
print("T5_RESULTS", json.dumps({"session.tool.called":called,"session.tool.success":success,"tool":toolname}))
PY
python3 - "$REQ" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
for r in rows:
    names=[t['function']['name'] for t in (r['body'].get('tools') or [])]
    if 'spike_probe' in names:
        print("  tool advertised to the model:", names)
        break
for r in rows:
    for m in r['body'].get('messages',[]):
        if m.get('role')=='tool' and 'SPIKE_PROBE_OK' in str(m.get('content','')):
            print("  tool result:", str(m['content'])[:300]); raise SystemExit
PY

echo
echo "=== plugin discovery (from the serve log) ==="
grep -o 'msg="loading plugin" id=[^ ]*' "$SCRATCH/serve.log" | sed 's/^/  /'

echo
if [ "$RC" = "0" ]; then echo "RESULT: see the PASS/FAIL lines above (exit 0)"; else echo "RESULT: at least one check FAILED (exit $RC)"; fi
echo "raw evidence kept in: $SCRATCH"
exit $RC
