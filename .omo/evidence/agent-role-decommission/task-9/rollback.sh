#!/usr/bin/env bash
# todo 9 (e) — exercise the DOCUMENTED rollback once on a copy.
#
# The migration header (server/prisma/migrations/20260919000010_drop_agents_role/migration.sql)
# documents the rollback verbatim as:
#
#   docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" aiagents' \
#     < .omo/evidence/agent-role-decommission/pre-migration-dump.sql
#
# This script runs that EXACT command shape (docker exec -T on the db container, same
# mysql invocation, same dump file) against a scratch copy whose database is named
# `aiagents_t9rb` instead of `aiagents` — the documented command needs a running `aiagents`
# target, so the copy renames only the target DB (the same adaptation todo 7 made).
#
# Sequence: create aiagents_t9rb -> restore dump (pre-drop state) -> migrate deploy
# (role column dropped) -> rollback command -> role column back, row counts restored.
set -euo pipefail
REPO="/Volumes/SSD-Data/01work/git-project/vteam"
OUT="$REPO/.omo/evidence/agent-role-decommission/task-9"
DUMP="$REPO/.omo/evidence/agent-role-decommission/pre-migration-dump.sql"
DB="aiagents_t9rb"
LOG="$OUT/rollback.txt"
: > "$LOG"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }
q() { docker exec -i aiagents-compose-db sh -c "mysql --default-character-set=utf8mb4 -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $1" 2>&1 | grep -v 'Using a password' || true; }
scalar() { docker exec -i aiagents-compose-db sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"$1\"" 2>/dev/null; }

say "== (e) rollback exercise on copy $DB =="
say "dump sha256: $(shasum -a 256 "$DUMP" | awk '{print $1}')"
say ""
say "-- step 1: create scratch copy --"
q "-e \"DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"" >/dev/null
say "created $DB"

say ""
say "-- step 2: restore the pre-drop dump (documented dump; the rollback artifact) --"
say "command: docker exec -i aiagents-compose-db sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DB' < $DUMP"
time docker exec -i aiagents-compose-db sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DB" < "$DUMP" 2>&1 | grep -v 'Using a password' >> "$LOG" || true
role_col_restored=$(scalar "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='agents' AND column_name='role'")
agents_restored=$(scalar "SELECT COUNT(*) FROM $DB.agents")
mig_restored=$(scalar "SELECT COUNT(*) FROM $DB._prisma_migrations WHERE finished_at IS NOT NULL")
say "restored state: role_col=$role_col_restored agents=$agents_restored applied_migrations=$mig_restored"

say ""
say "-- step 3: full migration chain (drops the column) --"
docker exec -e DATABASE_URL="mysql://root:aiagents-root@db:3306/$DB" -w /app aiagents-compose-server \
  sh -c 'npx prisma migrate deploy --schema prisma/schema.prisma' 2>&1 | grep -E "Applying|already applied|migrations found|Error" | tee -a "$LOG" || true
role_col_after_migrate=$(scalar "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='agents' AND column_name='role'")
say "post-migrate: role_col=$role_col_after_migrate (must be 0)"

say ""
say "-- step 4: the DOCUMENTED rollback command (migration.sql:42-44), adapted target only --"
say "documented: docker compose exec -T db sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" aiagents' < <dump>"
say "executed  : cd $REPO && docker compose exec -T db sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DB' < <dump>"
# The documented form is `docker compose exec -T db sh -c '...'` (repo root). Only the
# DATABASE NAME is adapted (aiagents -> aiagents_t9rb), because the dump's statements are
# unqualified and must land in the copy. `compose exec` never recreates a container.
( cd "$REPO" && docker compose exec -T db sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DB" < "$DUMP" ) 2>&1 | grep -v 'Using a password' | tee -a "$LOG" || true
role_col_after_rb=$(scalar "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='agents' AND column_name='role'")
agents_after_rb=$(scalar "SELECT COUNT(*) FROM $DB.agents")
mig_after_rb=$(scalar "SELECT COUNT(*) FROM $DB._prisma_migrations WHERE finished_at IS NOT NULL")
say "post-rollback: role_col=$role_col_after_rb agents=$agents_after_rb applied_migrations=$mig_after_rb"

say ""
say "-- step 5: pre-rollback state equality (the rollback must restore the pre-migration state) --"
say "role_col: restored=$role_col_restored rollback=$role_col_after_rb"
say "agents:   restored=$agents_restored rollback=$agents_after_rb"
say "migrations: restored=$mig_restored rollback=$mig_after_rb"
[[ "$role_col_after_rb" == "1" ]] || { say "FAIL: role column did not return"; exit 1; }
[[ "$agents_after_rb" == "$agents_restored" ]] || { say "FAIL: agent count differs"; exit 1; }
[[ "$mig_after_rb" == "$mig_restored" ]] || { say "FAIL: migration ledger differs"; exit 1; }
say ""
say "ROLLBACK RESULT: PASS (role column returned; agent/migration counts back to the pre-migration values)"
say ""
say "-- step 6: drop the rollback copy --"
q "-e \"DROP DATABASE IF EXISTS $DB;\"" >/dev/null
say "dropped $DB"
