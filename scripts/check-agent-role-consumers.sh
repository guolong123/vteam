#!/usr/bin/env bash
#
# check-agent-role-consumers.sh — todo 1 of agent-role-decommission.
#
# Machine check for the `Agent.role` consumer map. It re-runs the EXACT grep
# commands recorded in
#   .omo/evidence/agent-role-decommission/task-1-consumer-map.txt
# and diffs the observed `file:line` set against the committed inventory
#   scripts/agent-role-consumer-manifest.txt
# Prints `UNMAPPED: <n>` (n = observed keys absent from the manifest) plus the
# offending lines, and exits non-zero when n > 0.
#
# Usage:
#   bash scripts/check-agent-role-consumers.sh                 # real tree
#   bash scripts/check-agent-role-consumers.sh --extra-dir DIR # + synthetic probe
#
# The optional --extra-dir greps an ADDITIONAL directory with the same patterns.
# It exists so the negative control (an artificially added unmapped consumer)
# can be exercised WITHOUT committing a synthetic consumer into the tree.
#
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/scripts/agent-role-consumer-manifest.txt"
EXTRA_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --extra-dir)
      EXTRA_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$MANIFEST" ]; then
  echo "manifest not found: $MANIFEST" >&2
  exit 2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

emit_server() {
  grep -rnE "\.role\b" "$ROOT/server/src" --include="*.ts" | grep -v "\.spec\.ts" | cut -d: -f1,2
  grep -rnE "\brole:\s*true\b" "$ROOT/server/src" --include="*.ts" | grep -v "\.spec\.ts" | cut -d: -f1,2
  grep -rnE "resolveTemplateSource|resolveConstantPolicySource|roleToAgentName|isPlanRole|roleNeedsIssueDetail|ROLE_LABELS|constantRoleNameOf|policyKeyOf|agentNameOf|resolvePolicyAgentCandidate" "$ROOT/server/src" --include="*.ts" | grep -v "\.spec\.ts" | cut -d: -f1,2
  grep -rnE "isPlanRoleTarget|PLAN_AGENT_ID|PLANNER_AGENT_ID|listPlanDutyAgents|PLAN_DUTY_AGENTS" "$ROOT/server/src" --include="*.ts" | grep -v "\.spec\.ts" | cut -d: -f1,2
}

emit_web() {
  grep -rnE "\.role\b" "$ROOT/web" --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "\.spec\.ts" | grep -v "e2e/" | cut -d: -f1,2
}

{
  emit_server
  emit_web
  if [ -n "$EXTRA_DIR" ]; then
    grep -rnE "\.role\b" "$EXTRA_DIR" --include="*.ts" --include="*.tsx" | cut -d: -f1,2
  fi
} | sed "s#$ROOT/##" | sort -u > "$TMP"

# Keys observed in a fresh grep but absent from the committed manifest.
UNMAPPED="$(comm -23 "$TMP" "$MANIFEST")"
COUNT="$(printf '%s' "$UNMAPPED" | grep -c . || true)"
TOTAL="$(grep -c . "$TMP" || true)"

echo "MANIFEST: $MANIFEST"
echo "OBSERVED: $TOTAL keys (fresh grep)"
echo "UNMAPPED: ${COUNT:-0}"
if [ "${COUNT:-0}" -gt 0 ]; then
  echo "--- offending lines (in fresh grep, absent from manifest) ---"
  printf '%s\n' "$UNMAPPED"
  exit 1
fi
exit 0
