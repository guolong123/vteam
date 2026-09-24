# Tech-Debt Rollback Runbook (W6–W9 DDL waves)

> This is the ONLY recovery path for the four one-way DDL waves. The repo has
> NO down-migrations anywhere under `server/prisma/migrations/` — the stated
> rollback in `server/prisma/migrations/20260907000001_drop_task_agent_domain/migration.sql:20`
> and `server/prisma/migrations/20260919000010_drop_agents_role/migration.sql:35-42`
> is dump-restore. Todos 32/39/43/47 take the preflight dump; todos 36/38/42/44
> are the one-way DDL steps that depend on it.

## 1. Rollback trigger (green gate)

Any red gate, any failed preflight probe, or any failed DDL → STOP immediately,
do NOT start the next todo, execute the two-step rollback below, and report.
Do NOT attempt an in-place fix-forward on a DDL wave.

```bash
# 1. Record where you are, then return the tree to the last green commit.
git log --oneline -5
git reset --hard <last-green-commit>

# 2. If a DDL wave already ran (migrate deploy applied), ALSO restore the dump
#    (section 3 below). Code reset alone does NOT undo a DROP COLUMN.
# 3. Re-run the gate to prove recovery:
bash scripts/gate.sh
```

Rule: recovery from a bad DDL is `git reset --hard <last-green-commit>` PLUS
`mysql -h ... < dump.sql` — both, in that order (code first, then data).

## 2. Preflight backup (mandatory before every DDL wave)

Run BEFORE any schema change in the wave. Verify the dump is non-empty and
restorable into a scratch DB before proceeding.

```bash
mkdir -p .omo/evidence

mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 -h <host> -P <port> -u <user> -p <db> > .omo/evidence/ddl-<wave>-<date>.sql

ls -lh .omo/evidence/ddl-<wave>-<date>.sql
```

Defaults from `chart/vteam/values.yaml:48-54`: database `aiagents`, port `3306`
(`db.database: aiagents`, `db.port: 3306`, `db.enabled: true` = built-in MySQL 8
StatefulSet). Compose likewise uses `mysql:8`. Use placeholders above — never
paste real passwords; prefer compose variable names (e.g. `$MYSQL_ROOT_PASSWORD`)
or `<host> / <port> / <user> / <db>` when documenting.

Example naming: `.omo/evidence/ddl-W6-20260924.sql`,
`.omo/evidence/ddl-W7-20260924.sql`, etc. — one dump per wave, taken by the
preflight todo (W6: todo 32, W7: todo 39, W8: todo 43, W9: todo 47).

## 3. Restore (discards everything written after the migration)

```bash
mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-<wave>-<date>.sql
```

Notes:

- Restore returns the database to the pre-migration state; any writes made
  after the bad migration are discarded. That is intentional — there is no
  partial "undo" for `DROP COLUMN`.
- After restore, re-run the gate to confirm the tree is green:

```bash
bash scripts/gate.sh
```

- The migration files themselves document this same contract inline (not by
  reference): `20260907000001_drop_task_agent_domain/migration.sql:1-40`
  ("生产先有本迁移前 mysqldump 备份") and
  `20260919000010_drop_agents_role/migration.sql:35-42`
  ("回滚 = 恢复迁移前全库 dump" + literal dump/restore commands).

## 4. Helm rollback (K8s release recovery)

Sourced from `docs/deployment.md:224-241` (4.1 full-values baseline),
`docs/deployment.md:485` (5.1 row 1), `docs/deployment.md:549` (6.1 REV17
recovery), and `learnings.md:149-150` (REV14 fix path). Inline procedure —
do not rely on a bare `helm rollback` without the surrounding steps:

```bash
# 1. Inspect history and diff the failed revision against the last good one.
helm history vteam -n vteam
helm get values vteam -n vteam -o yaml > /tmp/opencode/vteam-failed.yaml
helm get values vteam -n vteam --revision <last-good-rev> -o yaml > /tmp/opencode/vteam-good.yaml
diff /tmp/opencode/vteam-good.yaml /tmp/opencode/vteam-failed.yaml || true

# 2. Roll back the release (REV17 pattern: "rollback 13 + 删旧 Job + 完整基线 upgrade").
helm rollback vteam <last-good-rev> -n vteam

# 3. The init Job template is immutable — a stale Job blocks the next upgrade.
kubectl delete job vteam-init -n vteam --ignore-not-found

# 4. Re-upgrade on the FULL values baseline (never a lone --set; see 4.1).
helm get values vteam -n vteam -o yaml > /tmp/opencode/vteam-baseline.yaml
# Edit only the fields that must change (e.g. image tag / replica count) in the baseline file, then:
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline.yaml --wait --timeout 300s

# 5. ConfigMap/Secret changes do NOT hot-reload — restart the workloads.
kubectl rollout restart deploy/vteam-server -n vteam
kubectl rollout restart deploy/vteam-web -n vteam
kubectl rollout restart sts/vteam-worker -n vteam

# 6. Verify (docs/deployment.md 5.2-5.3 baseline).
kubectl get configmap vteam-config -n vteam -o yaml | grep -i database_url
helm history vteam -n vteam
curl -H "Host: vteam.ketaops.cc" http://<node>:32054/api/v1/health
```

Troubleshooting pointers (5.1 row 1): if server CrashLoops with
`Authentication failed against database server`, compare
`kubectl get configmap vteam-config -o yaml` DATABASE_URL against
`kubectl get secret vteam-secret -o jsonpath='{.data.DB_PASSWORD}'`
(base64-decoded) — a mismatch means a partial-values upgrade randomized the
password (REV14 accident).

## 5. `scripts/deploy-k8s.sh` has NO `--rollback` flag

`scripts/deploy-k8s.sh` provides NO `--rollback` flag. Its
`scripts/deploy-k8s.sh:358-363` block only sets `--history-max 5` on the
`helm upgrade --install` invocation — that retains history, it does not roll
anything back. Supported flags are `--tag`, `--registry`, `--namespace`,
`--platform`, `--release`, `--no-build`, `--no-push`, `--dry-run`,
`--reset-secrets`, `--skip-health` (`scripts/deploy-k8s.sh:1-57`); there is no
rollback entry point.

Consequence: a bad image must be re-deployed with a prior `--tag`, or rolled
back by hand with the Helm procedure in section 4:

```bash
# Re-deploy the last good tag explicitly (forward-fix by re-pinning).
scripts/deploy-k8s.sh --tag <last-good-tag>

# OR roll back by hand:
helm rollback vteam <last-good-rev> -n vteam
```

Do NOT modify `scripts/deploy-k8s.sh` or anything under `chart/` as part of a
rollback — they are out of scope for this runbook.

## 6. DDL waves requiring a preflight dump

| Wave | Scope | Affected schema objects | Preflight (dump first) |
|------|-------|-------------------------|------------------------|
| W6 | Compat column removal (todos 32-38) | `tasks.main_agent_id`, `tasks.main_agent_instance_id`, `tasks.execution_mode`, `sessions.task_agent_id`, `chat_channels.task_agent_id`, index `uk_sessions_task_agent` | Todo 32: read-only probes + `mysqldump --single-transaction ... > .omo/evidence/ddl-W6-<date>.sql` |
| W7 | `fireAt` removal (todos 39-42) | `triggers.due_at` → NOT NULL, DROP `triggers.fire_at` + index `idx_timers_status_fire_at` (keep `idx_triggers_status_due_at`) | Todo 39: `due_at IS NULL` = 0 probe + `mysqldump --single-transaction ... > .omo/evidence/ddl-W7-<date>.sql` |
| W8 | `task_group` purge (todos 43-46) | `chat_channels.type='task_group'` rows merged into `team_group`; `messages.channel_id` re-pointed (FK `Restrict` — order is load-bearing); `CHANNEL_TYPE.task_group` member removed; already-soft-deleted rows and `team_id IS NULL` orphans left alone | Todo 43: six merge-input probes + `chat_channels` + `messages` dump `> .omo/evidence/ddl-W8-<date>.sql` |
| W9 | `lastActivityAt` Map removal (todos 47-50) | Backfill NULL `last_activity_at` from each row's own `updated_at`, then remove the in-memory Map (keep the DB scan leg and the pending veto) | Todo 47: quantify + backfill + dump `> .omo/evidence/ddl-W9-<date>.sql` |

Waves 0-5 and the non-DDL parts of Wave 6 are individually revertible with
`git reset --hard <last-green-commit>` alone. W6 (todos 36, 38), W7 (todo 42),
W8 (todo 44), and W9 (todo 47's backfill) are one-way — code reset PLUS
`mysql -h <host> -P <port> -u <user> -p <db> < .omo/evidence/ddl-<wave>-<date>.sql`,
in that order. Schedule Waves W6-W9 as maintenance-window work: even though
MySQL 8 supports `ALGORITHM=INSTANT, LOCK=NONE` for these drops, a half-applied
migration cannot be undone by Helm, and `scripts/deploy-k8s.sh` offers no
`--rollback` flag.
