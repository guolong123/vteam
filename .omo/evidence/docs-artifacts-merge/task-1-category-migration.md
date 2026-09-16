# Evidence — T1 Prisma `Artifact.category` nullable column + migration

Plan: `.omo/plans/docs-artifacts-merge.md` todo 1. Branch: `feat/docs-artifacts-merge`.

## Changed files

- `server/prisma/schema.prisma` (Artifact model only): `category String?` + `@@index([taskId, category], map: "idx_artifacts_task_category")`
- `server/prisma/migrations/20260919000000_add_artifact_category/migration.sql` (new)

Diff (`git diff -- server/prisma/schema.prisma`):

```diff
 model Artifact {
   id             String   @id
   taskId         String   @map("task_id")
   type           String
   title          String
+  category       String?
   currentVersion Int      @default(0) @map("current_version")
```

```diff
   @@index([taskId, type], map: "idx_artifacts_task_type")
+  @@index([taskId, category], map: "idx_artifacts_task_category")
   @@index([taskId], map: "idx_artifacts_task")
   @@map("artifacts")
```

Migration SQL (`server/prisma/migrations/20260919000000_add_artifact_category/migration.sql`):

```sql
ALTER TABLE `artifacts` ADD COLUMN `category` TEXT NULL;
CREATE INDEX `idx_artifacts_task_category` ON `artifacts`(`task_id`, `category`(191));
```

(plus Chinese header comment; no `NOT NULL`, no `DEFAULT`. `category(191)` prefix is
required because MySQL error 1170 forbids a full-length TEXT column in a key.)

## Acceptance block (commands + outputs, verbatim)

1. `prisma validate` — run from `server/` (repo root has no `DATABASE_URL`; `server/.env` provides it):
   `$ ./node_modules/.bin/prisma validate --schema prisma/schema.prisma`
   ```
   The schema at prisma/schema.prisma is valid 🚀
   ```
   exit 0. (Note: `npx prisma validate --schema server/prisma/schema.prisma` from repo root
   fails with `P1012: Environment variable not found: DATABASE_URL` — env-loading scope
   issue only, not a schema problem.)

2. No-NOT-NULL gate:
   `$ grep -A2 "ADD COLUMN" server/prisma/migrations/20260919000000_add_artifact_category/migration.sql | grep -qi "NOT NULL"; echo $?`
   ```
   1
   ```
   (exit 1 = no match = good.)

3. Schema mentions gate:
   `$ grep -c "category" server/prisma/schema.prisma`
   ```
   2
   ```
   (field + index; baseline was 0.)

4. `migrate deploy` smoke — host has no TCP route to the compose MySQL (port 3306 not
   published; Docker Desktop macOS), so the exact repo files were copied into the running
   dev container and deployed there:
   ```
   $ docker cp server/prisma/migrations/20260919000000_add_artifact_category aiagents-compose-server:/app/prisma/migrations/20260919000000_add_artifact_category
   $ docker cp server/prisma/schema.prisma aiagents-compose-server:/app/prisma/schema.prisma
   $ docker exec aiagents-compose-server npx prisma migrate deploy --schema prisma/schema.prisma
   53 migrations found in prisma/migrations
   Applying migration `20260919000000_add_artifact_category`
   The following migration(s) have been applied:
   migrations/
     └─ 20260919000000_add_artifact_category/
       └─ migration.sql
   All migrations have been successfully applied.
   ```
   exit 0.

5. `DESCRIBE` gate (dev DB `aiagents`, table had 40 pre-existing rows — all NULL category):
   `$ docker exec aiagents-compose-db mysql -uroot -paiagents-root -e "DESCRIBE aiagents.artifacts; SHOW INDEX FROM aiagents.artifacts WHERE Key_name='idx_artifacts_task_category';"`
   ```
   category  text  YES  NULL
   artifacts  1  idx_artifacts_task_category  1  task_id   A  ...
   artifacts  1  idx_artifacts_task_category  2  category  A  ...  191  ...  YES  BTREE  ...
   ```
   and `_prisma_migrations` contains `20260919000000_add_artifact_category` (finished).

6. Regression:
   `$ npm test --prefix server -- --runInBand src/artifacts/artifacts.service.spec.ts`
   ```
   Test Suites: 1 passed, 1 total
   Tests:       34 passed, 34 total
   ```

## Failure QA (required column must fail — recorded, NOT committed)

Temp migration created **inside the container only**
(`/app/prisma/migrations/999999000000_tmp_require_category/migration.sql`,
never in the repo tree):
```sql
ALTER TABLE `artifacts` MODIFY COLUMN `category` TEXT NOT NULL;
```
`migrate deploy` output:
```
Database error code: 1138
Database error:
Invalid use of NULL value
Please check the query number 1 from the migration file.
```
Proves nullable-first is mandatory (40 existing rows are NULL).
Cleanup receipts:
- `rm -rf /app/prisma/migrations/999999000000_tmp_require_category` (container; `ls | grep -c tmp` → `0`)
- `prisma migrate resolve --rolled-back "999999000000_tmp_require_category"` → "marked as rolled back"
- `DELETE FROM aiagents._prisma_migrations WHERE migration_name='999999000000_tmp_require_category'` → `tmp_rows = 0`
- Final `prisma migrate status` → `Database schema is up to date!`; final `migrate deploy` → `No pending migrations to apply.`

## Scope discipline

- Untouched: `type` column, `ArtifactVersion` model, `@@unique([artifactId, version])`,
  `idx_artifacts_task_type`, `resyncIdPrefix`, id generator, seed data, all other models.
- No `*.spec.ts` changes needed — existing artifact tests pass unmodified (no behavior change).
- Container-side copies (`/app/prisma/schema.prisma`, `/app/prisma/migrations/...`) mirror the
  committed repo files exactly; no other container state was changed.

## Risks / notes for downstream

- Prisma maps `String?` on MySQL to `VARCHAR(191) NULL` by default, but the hand-written
  migration uses `TEXT NULL` per plan verbatim. This is intentional drift (validate/deploy
  unaffected); do NOT "fix" it with `migrate dev` — T2/T4 only need column existence.
- `category(191)` index prefix: queries filtering on long category values still work;
  the column holds short CJK labels anyway.
