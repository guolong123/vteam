#!/usr/bin/env bash
#
# gate.sh — single executable gate entry point (tech-debt-remediation Todo 5).
#
# Runs the full self-contained gate in order and exits non-zero on the
# first failure:
#   server/ — npx prisma generate, npm run "lint:check", npm test,
#             npm run test:e2e, npm run build
#   worker/ — npm run typecheck, npm test, npm run build
#   web/    — npm run "lint:check", npm run build
#
# Usage:
#   bash scripts/gate.sh [--with-playwright]
#
# --with-playwright additionally runs `npm run test:e2e` in web/.
# Playwright prerequisites: the web dev server must ALREADY be listening on
# :3001 with the full stack up — web/playwright.config.ts configures no
# webServer auto-start, targets http://localhost:3001, and requires a system
# chrome channel. Playwright never runs by default.
#
# Paths resolve relative to this script's own location, so the gate works
# from any cwd. No MySQL service, no new dependencies, no env vars.
#
# NOTE (grep guard): the mutating --fix lint entry point must never appear
# here — only the check variant via $LINT_CHECK below. Keep it that way:
# the contiguous mutating invocation substring must not occur in this file.
#
set -euo pipefail

WITH_PLAYWRIGHT=0
for arg in "$@"; do
  case "$arg" in
    --with-playwright) WITH_PLAYWRIGHT=1 ;;
    -h|--help)
      echo "usage: gate.sh [--with-playwright]"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/server"
WORKER_DIR="$ROOT/worker"
WEB_DIR="$ROOT/web"

# Check-only lint entry point (never the --fix variant).
LINT_CHECK="lint:check"

run() {
  local label="$1"
  local dir="$2"
  shift 2
  echo "+ [${label}] (cd ${dir} && $*)"
  if (cd "$dir" && "$@"); then
    echo "ok: ${label} (exit 0)"
  else
    local code=$?
    echo "FAIL: ${label} (exit ${code})" >&2
    exit "${code}"
  fi
}

# Bare-catch regression guard (tech-debt-remediation Todo 21).
# Baseline post-Wave-3 count of bare `catch {` / `catch {}` occurrences in
# server/src (excluding *.spec.ts — tests legitimately use bare catches).
# A bare-catch-with-log still counts as bare (it is syntactically bare).
# This threshold may only be lowered, never raised, in a separate explicit
# change. Mirrored as a step in .github/workflows/ci.yml (`server` job).
BARE_CATCH_BASELINE=175

echo "+ [server bare-catch guard] (count bare 'catch {' in server/src, excluding *.spec.ts)"
BARE_CATCH_COUNT="$( { grep -rn --include='*.ts' -E 'catch[[:space:]]*\{' "$SERVER_DIR/src" || true; } | grep -v '\.spec\.ts' | wc -l | tr -d ' ' )"
echo "bare-catch count: ${BARE_CATCH_COUNT} (baseline ${BARE_CATCH_BASELINE})"
if [ "${BARE_CATCH_COUNT}" -gt "${BARE_CATCH_BASELINE}" ]; then
  echo "FAIL: server bare-catch guard (count ${BARE_CATCH_COUNT} exceeded baseline ${BARE_CATCH_BASELINE})" >&2
  exit 1
fi
echo "ok: server bare-catch guard (exit 0)"

run "server npx prisma generate" "$SERVER_DIR" npx prisma generate
run "server npm run ${LINT_CHECK}" "$SERVER_DIR" npm run "${LINT_CHECK}"
run "server npm test" "$SERVER_DIR" npm test
run "server npm run test:e2e" "$SERVER_DIR" npm run test:e2e
run "server npm run build" "$SERVER_DIR" npm run build

run "worker npm run typecheck" "$WORKER_DIR" npm run typecheck
run "worker npm test" "$WORKER_DIR" npm test
run "worker npm run build" "$WORKER_DIR" npm run build

run "web npm run ${LINT_CHECK}" "$WEB_DIR" npm run "${LINT_CHECK}"
run "web npm run build" "$WEB_DIR" npm run build

if [ "$WITH_PLAYWRIGHT" = "1" ]; then
  echo "Playwright prerequisite reminder: the web dev server must already be"
  echo "listening on :3001 with the full stack up (no webServer auto-start;"
  echo "see web/playwright.config.ts: baseURL http://localhost:3001, system"
  echo "chrome channel required)."
  run "web npm run test:e2e" "$WEB_DIR" npm run test:e2e
fi

echo "GATE GREEN: all steps passed (exit 0)"
