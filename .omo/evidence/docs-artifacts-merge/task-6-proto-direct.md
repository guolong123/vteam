# T6 原型改直读 — evidence (task-6-proto-direct)

## 1. Changed files
- `server/src/docs-site/docs-mirror.service.ts` — rewrote ONLY `listPrototypes` + `readPrototype` (2 methods + 2 docstrings, 4 hunks). `doSyncTask`/`syncTask`/`rebuildAll`/`readMirrorDoc`/`buildRegistry`/`extractExt`/delegates (`toSlug`/`docIdFor`/private `prototypeSlug`/`prototypeFileName`) byte-identical — verified: `git diff ... | grep "^[-+].*(doSyncTask|...)"` hits only one docstring mention.
- `server/src/docs-site/docs-mirror.service.spec.ts` — replaced ONLY the `listPrototypes / readPrototype` describe (8 disk-scan cases → 13 DB-impl cases). All other describes untouched.
- `server/src/artifacts/artifact-slug.ts` — NOT modified. T3 exports `prototypeSlug`/`prototypeFileName` verified importable (service already imports them at lines 12-17; `tsc --noEmit` exit 0).

## 2. New behavior (parity notes)
- Query: `artifactVersion.findMany({ where: { artifact: { taskId, type: 'file' } } })`, keep rows with `version === artifact.currentVersion`, `contentRef` starts `/uploads/` and ends `.tsx` (case-insensitive) or `.prototype.json` (case-insensitive).
- Naming: `prototypeSlug(title, artifactId, contentRef)` → `id`, `file = <slug>/index.tsx`; `prototypeFileName(...)` → `file`, `id = file minus .json`. Same helpers `doSyncTask` uses for write path ⇒ disk-era names and DB-era names compute identically.
- Meta regex copied VERBATIM from old code: `/export\s+const\s+meta\s*=\s*(\{[^}]+\})/s` + `name`/`id` sub-regexes; JSON `name` trim-or-id fallback kept; sort `items.sort((a,b) => a.id.localeCompare(b.id))` kept; both whitelist regexes (`^[a-z0-9_-]+\/index\.tsx$`, `^[a-z0-9_-]+\.json$`) kept; traversal/missing → `null` kept; warn text `[docs-mirror] 原型 <file> 解析失败，跳过列表` kept (filename now the computed one).
- Intentional deviations (2):
  1. `artifactId` now comes from the DB row (exact) instead of contentRef-substring guessing loops (deleted). Old list could emit `artifactId: undefined`; new always sets it. Shape key set unchanged.
  2. TSX-row uploads-read failure: old code still listed the dir entry (fallback name); new code still lists the row (fallback slug) — same semantics, source is uploads instead of disk.
- Deleted spec setups (disk-scan-specific, no longer applicable): `fs.mkdirSync` prototypes dirs + direct `fs.writeFileSync` of `index.tsx`/`.json` fixtures (7 cases). Kept verbatim: traversal whitelist cases, missing-path null cases, TSX/JSON coexistence + sort, meta-name fallback. Added: metaId passthrough, stale-version/suffix filtering, JSON parse-failure skip, uploads-missing → null, TSX read-failure fallback.

## 3. Unit verification (foreground, host, server/)
- `npm test -- --runInBand src/docs-site` → **2 suites, 42 tests, all green** (mirror spec + controller spec; controller mocks mirror, unaffected).
- `npx tsc --noEmit -p tsconfig.json` → exit 0.

## 4. Live proof (real new code vs live DB+uploads, inside `aiagents-compose-server`)
Redeploy was deliberately NOT done (image builds from the working tree, which currently holds other wave todos' dirty files — baking them in would pollute the shared env). Instead the edited file was compiled verbatim on host (`npx tsc ... --module commonjs`), `docker cp`'d to `/tmp/t6raw/`, and executed in-container with `NODE_PATH=/app/node_modules` against the live MySQL + live `/app/uploads` volume:
- Seed (then cleaned): `/app/uploads/t6proof-login-page.tsx` (144 B, `export const meta = { id: "t6proof", name: "T6直读验证页" };...`) + `Artifact(t6proof_art1, task t_0000000001, type=file, title=T6直读验证页, currentVersion=1)` + `ArtifactVersion(t6proof_ver1, v1, /uploads/t6proof-login-page.tsx)`.
- (a) Shape: `jq -e '.items | length>0 and all(has("id") and has("name") and has("file") and has("artifactId"))' /tmp/t6-list.json` → `true`. Item: `{"id":"t6proof-login-page","metaId":"t6proof","name":"T6直读验证页","file":"t6proof-login-page/index.tsx","artifactId":"t6proof_art1"}`.
- (b) Byte identity: `diff /tmp/t6-via-service.txt /tmp/t6-direct.txt` → exit 0 (`readPrototype` output vs `FileStorageService.readUploadedFile` bytes, 144 B each).
- (c) Disk independence: `mv /app/docs-root /app/docs-root.T6HOLD` (whole mirror tree absent) → re-ran harness → identical list + `BYTE_EQUAL=true`, exit 0 → `mv` back, `ls` confirmed `t_0000000001 t_0000000002 t_0000000003` restored.
- Endpoint-level `curl` against the HTTP route was NOT run (container still serves pre-T6 code; see redeploy note above). The service-level proof runs the exact shipped method bodies, so list/shape/bytes/disk-independence assertions transfer 1:1; HTTP plumbing (routes, `assertMember`, whitelist) is untouched and covered by `docs-site.controller.spec.ts` (green).
- Pre-existing live rows `t2qa_08/t2qa_09` (`.tsx`/`.prototype.json` refs with missing uploads bytes) vanished from DB between two live queries — removed by parallel-wave activity, not by this todo (this todo only ever wrote/deleted `t6proof_*` ids).
- Pre-change field-for-field note: no disk `prototypes/` dir existed for any task, so old code returned `[]` here; parity is established structurally (same slug helpers as the write path, verbatim regex/whitelist/sort) rather than by old-vs-new output diff.

## 5. Cleanup receipts
- `node /tmp/t6-seed.js down` → `CLEAN_OK`; `/app/uploads/t6proof-login-page.tsx` removed (`ls` → No such file); `artifact WHERE id LIKE 't6proof%'` → `LEFTOVER_ROWS=0`; container `/tmp/t6*` + `/tmp/t6raw` removed (`ls /tmp | grep t6` → empty).
- Host `/tmp/t6-list.json` retained only as scratch (not committed).

## 6. Gate statement for T11
Prototype reads are proven disk-independent (list + source both serve with `docs-root` entirely absent). **T11 mirror deletion is UNBLOCKED from the T6 side.** Remaining T11 preconditions (T8 frontend cutover) are out of scope here.

## 7. Risks
- Two same-slug prototype artifacts would yield duplicate `id`s (write path would also have collided on disk). No dedup added — matches old behavior; flag for T11 if desired.
- `readPrototype` scans all file rows per call (same pattern as `buildRegistry`); fine at prototype cardinality.
