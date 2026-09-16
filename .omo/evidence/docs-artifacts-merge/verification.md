# T13 verification — docs-artifacts-merge closeout

- Plan: `.omo/plans/docs-artifacts-merge.md` todo 13
- Branch: `feat/docs-artifacts-merge`
- Date: 2026-09-17 UTC
- Protocol docs (12篇 §10 + 09篇 team row): landed directly by orchestrator, reviewed;
  this file covers evidence indexing, gate paste, and READ-back only.

## 1. Evidence index (14 files + this file = 15 total)

Plan T13 acceptance says "14 files". Actual set on disk is
task-1, 2, 3, 4, 5, 6, 7, 8, 8b, 9, 10, 11, 12, 14 (= 14 files),
plus this verification.md (= 15 total). The count mismatch is naming, not loss:
proto-tab evidence lives under the plan-era name `task-8b-proto-tab.md` (full),
while `task-14-proto-tab.md` is a 2-line pointer to it (todo-number index).
All 14 confirmed present via `ls` (see §7).

| File | One-line content summary (from actual content, not filename) |
| --- | --- |
| `task-1-category-migration.md` | Prisma `Artifact.category String?` + `idx_artifacts_task_category` migration, container `migrate deploy` smoke, DESCRIBE gate, NOT NULL failure QA (MySQL 1138), 34-test regression green. |
| `task-2-backfill.md` | Idempotent backfill script with `--dry-run`; dry-run 14, fixture run 23, re-run 0; 11-row mapping fixture all correct, no-overwrite guard holds, NULL kept for no-match, vocab GROUP BY clean. |
| `task-3-slug.md` | Slug logic deduped into server + web canonical modules; 13-test jest spec green, 150-assertion server/web parity proof, old-vs-new 160-vector byte-identical diff, single-definition gate. |
| `task-4-category-write.md` | `ARTIFACT_CATEGORIES` server source + web mirror, DTO validation, `append`/`archiveFile` persistence (no overwrite on append), `findByTask` filter, list-item exposure; 77 tests green; live curl honestly deferred (image predates code). |
| `task-5-team-endpoint.md` | New `GET /teams/:id/artifacts` with `PermissionGuard` + `artifacts.view` + method-level member check; `findByTeam` returns list items plus `taskName`; 14 new tests green; container harness live proof (filter, clamp, 403, 404). |
| `task-6-proto-direct.md` | `listPrototypes`/`readPrototype` rewritten to DB + uploads; shape gate true, byte-identical diff exit 0, disk-independence proven with `docs-root` moved away; T11 unblocked from T6 side. |
| `task-7-mcp-category.md` | `submit_artifact` zod optional category + handler passthrough (text via `append`, file via `archiveFile` third arg), `doclib` list/detail exposure, tool count stays 26, old calls byte-identical, illegal value 400. |
| `task-8-unified-page.md` | New team-scoped `/docs` page, DB-only (N+1 grep 0, registry grep 0); tsc + eslint clean; temp Playwright spec 2 passed; `parent` empty proof pasted (flat tree justified); 7 screenshots gitignored local. |
| `task-8b-proto-tab.md` | Full T14 evidence (plan-era name): docs/protos dual tab, `PrototypePanel` reuse, count badge, `?proto=` deep link, team-level disabled empty state; temp spec 6/6 green; fixture fully cleaned. |
| `task-9-render-matrix.md` | `file-preview.tsx` matrix (text to md with explicit urlTransform allowlist, txt/csv/json pre with 256KB cut, pdf sandboxed iframe, office download card, svg img-only); allowlist plus webp/svg/json; XSS temp spec 8/8; `text-fallback` render retired. |
| `task-10-routes.md` | `/artifacts` slim redirect page, `/docs/[taskId]` thin alias with deferred mount + teamId reverse lookup, board/session retargeted, orphan `docs-site.spec.ts` deletion proven via project list, redirect + guard specs green. |
| `task-11-mirror-removal.md` | Mirror service + spec deleted, `PrototypesService` verbatim relocation, registry/prd routes deleted, `syncTask` fully removed; zero-reference grep double 0; full jest 2650 green; boot log zero `docs-mirror`; `docs-root` zero writes. |
| `task-12-qa-sweep.md` | Permanent `docs-unified.spec.ts` (17 tests) + `docs` project + tsx fixture; image rebuilt via commitretag; full gates (117 suites / 2651 tests, dual tsc, dual lint, 17 e2e); all deferred live gates re-verified; T10 failures dispositioned. |
| `task-14-proto-tab.md` | 2-line pointer only: full evidence is `task-8b-proto-tab.md` under the plan-era label. |
| `verification.md` | This file (closeout index + pasted gates + READ-back). |

Screenshots on disk in this checkout: the five `t14-*.png` files
(`t14-docs-tab`, `t14-proto-deeplink`, `t14-protos-tab`, `t14-team-disabled`,
`t14-team-proto-empty`) confirmed via `ls`. T8/T9/T12 shots are gitignored
per their evidence files and are not present in this checkout; their assertions
live in the per-task evidence above, not re-asserted here.

## 2. Final gates (VERIFIED BY ORCHESTRATOR)

Values below are pasted verbatim from the orchestrator re-run. They were NOT
independently re-executed by the T13 executor (re-running wastes shared infra
and risks the hot tree).

| Gate | Result |
| --- | --- |
| Server `tsc` (pristine worktree @e7febac) | exit 0 |
| Server `tsc` (dirty tree) | exit 0 |
| Web `tsc` | exit 0 |
| Full server jest | 117 suites / 2651 tests green |
| Web eslint | 0 errors (1 pre-existing warning in untouched file, proven by diff) |
| E2E docs project | 17/17 per worker, with XSS/protos screenshots corroborated by orchestrator viewing |
| Category SQL gate | 0 rows |
| Mirror grep gate | 0 |
| N+1 grep gate | 0 |
| Preview-dep grep gate | 0 |
| Router-push grep gate | 0 |

Residual risk (stated explicitly): the e2e 17/17 result is taken from the
orchestrator re-run and was NOT independently re-executed in T13. If the tree
moves before Final Wave review, F-reviewers should re-run
`npx playwright test --project=docs`.

## 3. T12 branch-integrity history

T12 exposed clean-HEAD server tsc red (2 errors) from foreign hunks absorbed in 38df6e7 referencing TASK_AGENT_COMPLETION_FORBIDDEN + ReceiptNudgePayload.fromName, whose definitions lived only in the sibling wave's uncommitted files. Resolved via verbatim 4-line adoption (commit e7febac, attributed, revertible via git revert). Sibling reconcile rule: keep theirs on landing. e7febac verified by orchestrator pristine-worktree tsc exit 0.

## 4. Known remainders (intentional, out of scope)

- Dead `doc-explorer.tsx` + `useDocsRegistry`/`useDocContent` hooks (unmounted since T10, left intentionally, deleting breaks tsc via imports).
- Dead `resolveDocsRoot` export in `docs-site.constants.ts`.
- Container `/app/docs-root` residue (zero writes post-T11).
- `t12qa-demo.tsx` volume seed must be re-copied after `down -v` (command in spec header).

## 5. Protocol docs note

Per the task brief, the protocol increments (12篇 §10 + 09篇 team row) were
landed directly by the orchestrator and reviewed there. This todo did not
create, modify, or re-verify those doc files beyond the READ-back in §6.
They remain uncommitted alongside this verification file per the T13 learnings
note ("保持 uncommitted，随 T13 完成时统一提交"); committing them is the
orchestrator's call, not this todo's (stage ONLY verification.md here).

## 6. Agent READ-back (3 protocol claims vs implementation)

Each claim below was checked against code read directly by the T13 executor
(not copied blindly from evidence). Citations are exact file:line in the
current checkout.

### Claim 1: category is orthogonal to type (nullable metadata, NULL means uncategorized)

- `server/src/artifacts/artifacts.constants.ts:6`: `ARTIFACT_TYPES` stays exactly
  three states (`text`, `doc`, `file`), untouched.
- `server/src/artifacts/artifacts.constants.ts:12`: comment states category is
  metadata orthogonal to `type`, uncategorized uses NULL, `其他` reserved for explicit choice.
- `server/src/artifacts/artifacts.constants.ts:16-24`: `ARTIFACT_CATEGORIES`
  is a separate const with the seven Chinese labels. Confirmed: two independent
  constants, no fourth type added, matches the protocol claim.

### Claim 2: single source is DB + uploads (prototypes read straight from DB rows)

- `server/src/docs-site/prototypes.service.ts:34-50`: `listPrototypes` queries
  `artifactVersion` rows constrained to `artifact.taskId` + `type: 'file'`,
  keeps only current-version rows, requires `/uploads/` prefix and
  `.tsx` / `.prototype.json` suffix.
- `server/src/docs-site/prototypes.service.ts:73-76, 102-104, 160-164, 177-181`:
  source bytes come from `FileStorageService.readUploadedFile(contentRef)` in
  every path; no disk mirror directory participates.
- `server/src/docs-site/prototypes.service.ts:10-16`: header documents the T11
  relocation from the retired mirror layer with identical method bodies.
  Confirmed: single source DB + uploads, matches the protocol claim.

### Claim 3: aggregation endpoint path `GET /teams/:id/artifacts`

- `server/src/artifacts/artifacts.controller.ts:57`:
  `@Get('teams/:id/artifacts')` on `findByTeam`.
- `server/src/artifacts/artifacts.controller.ts:58-59`: `PermissionGuard` plus
  `artifacts.view`, exactly as specified.
- `server/src/artifacts/artifacts.controller.ts:61-68`: handler runs
  `assertTeamMember` (404 unknown team, 403 non-member) then delegates to
  `findByTeam`. Confirmed: path, guards, and delegation match the protocol claim.

## 7. File-existence check (`ls`)

`ls .omo/evidence/docs-artifacts-merge/` in this checkout lists all of:
`task-1-category-migration.md`, `task-2-backfill.md`, `task-3-slug.md`,
`task-4-category-write.md`, `task-5-team-endpoint.md`, `task-6-proto-direct.md`,
`task-7-mcp-category.md`, `task-8-unified-page.md`, `task-8b-proto-tab.md`,
`task-9-render-matrix.md`, `task-10-routes.md`, `task-11-mirror-removal.md`,
`task-12-qa-sweep.md`, `task-14-proto-tab.md`, plus this `verification.md`
after write. Every evidence path cited in §1 exists on disk. Code locations in
§6 were opened with Read in this session (constants, controller,
prototypes service), not copied from evidence text.

No `verification.md` existed before this todo (grep for "verification" in the
evidence dir matched only passing mentions inside task-6 and task-12, no file).

## 8. QA caveats for future runs (from learnings)

- T8 `?doc=` / `?proto=` coexistence: both params are preserved in the URL;
  initial tab follows `?proto=` presence, afterwards last-clicked tab wins.
  Future e2e must assert this, not single-param behavior.
- T9 retired the `text-fallback` testid: text now renders via `text-md`.
  Never assert `text-fallback` in new specs; `file-card` / `inaccessible`
  remain valid on fallback paths.
- T10 chip-vs-URL rule: `type`/`category`/`accepted` filter chips do NOT read
  the URL (state defaults to all); only `teamId`/`taskId`/`doc` are URL-driven.
  Redirect tests should assert URL passthrough for filter params, not chip state.

## 9. Closeout checklist (plan Success criteria + Appendix D)

- [x] `/artifacts?teamId=` redirects to `/docs` with full param passthrough (T10).
- [x] `/docs?teamId=&taskId=&doc=` single page covers aggregation filter + md/prototype/version/delete (T8 + T14 + T9).
- [x] Old `/docs/:taskId?doc=` deep links zero 404 (T10 alias probe).
- [x] `text` renders as md; pdf sandboxed preview; docx/xls download card; txt/csv/json pre; unknown download fallback; XSS negative tests green (T9 + T12).
- [x] Seven categories + uncategorized filter work; `ARTIFACT_TYPES` three-state guard green; old `submit_artifact` calls without category pass (T4 + T7 + T12).
- [x] Mirror zero residue (server grep double 0 + zero `[docs-mirror]` boot log); N+1 loop zero residue; `server/docs-root` ignored and unwritten (T11 + T8).
- [x] Appendix D endpoint list: `GET /teams/:id/artifacts` (new), `GET /tasks/:id/artifacts` (+category), `GET /artifacts/:id`, `GET /artifacts/:id/versions/:version`, `POST /tasks/:id/artifacts` (+category), `POST /artifacts/:id/restore`, `DELETE /artifacts/:id` retained; `GET /docs-site/:taskId/prototypes` + `GET /docs-site/:taskId/prototypes/*` retained on DB implementation; `registry` + `prd/:file` deleted (404 verified on fresh image).
- [x] 14 evidence files + this verification file on disk; protocol increments landed by orchestrator.

## 10. Commit

Single file staged and committed as
`docs(artifacts): merge plan evidence and protocol notes`. No push.
Staging verified with `git status --short` + `git diff --cached --stat`
(single file) before commit. The tree holds ~29 pre-existing dirty files from
other live efforts; none were touched, staged, or included.
