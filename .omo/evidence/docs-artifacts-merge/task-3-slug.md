# T3 slug 去重 — evidence (`task-3-slug.md`)

## Changed files
- `server/src/artifacts/artifact-slug.ts` (new, canonical): `toSlug` / `docIdFor` /
  `prototypeSlug` / `prototypeFileName` — bodies moved verbatim from
  `docs-mirror.service.ts` (class methods → arrow consts; `this.toSlug` → `toSlug`;
  algorithm untouched). Header comment cross-links `web/src/lib/artifact-slug.ts`.
- `server/src/artifacts/artifact-slug.spec.ts` (new, jest, 13 tests).
- `web/src/lib/artifact-slug.ts` (new, canonical): `toDocSlug` / `docIdFor`
  byte-identical bodies moved from `task-detail-types.ts:137-177`.
- `server/src/docs-site/docs-mirror.service.ts` (import swap only): imports
  `slugToSlug/slugDocIdFor/slugPrototypeSlug/slugPrototypeFileName`; all 7 internal
  call sites switched; old methods kept as one-line delegates (spec compat, removed in T11).
- `web/src/components/tasks/task-detail-types.ts` (import swap only): definitions
  replaced by `export { docIdFor, toDocSlug } from "@/src/lib/artifact-slug"`.
  Kept as pure pass-through because exactly one external importer exists
  (`session/page.tsx:40` deep-link producer, untouched).
- Session deep-link producer `session/page.tsx:1321-1324`: READ ONLY, not modified.

## Test commands + results
- `npm test --prefix server -- --runInBand src/artifacts/artifact-slug.spec.ts
  src/docs-site/docs-mirror.service.spec.ts` → **2 suites, 35 tests, all green**
  (13 new slug tests: spaces / pure-Chinese / symbol-only / case / dup-dedupe /
  empty / 500-char long / numeric / underscore-dot / weak-word `doc` /
  prototypeSlug×2 / prototypeFileName).
- `npx tsc --noEmit -p tsconfig.json` in `server/` → exit 0; in `web/` → exit 0.
- `npx eslint` on all 5 touched files → clean (one prettier autofix in spec, re-verified green).
- Single-definition gates:
  - `grep -rn "function docIdFor\|function toSlug\|const toBase" server/src web/src
    --include="*.ts" --include="*.tsx" | wc -l` → **2**
    (both in `web/src/lib/artifact-slug.ts:26-27`; server uses arrow consts so
    contributes 0; wrappers/re-export contribute 0).
  - `grep -n "docIdFor" server/src/docs-site/docs-mirror.service.ts` →
    line 13 import + line 483 delegate method, no logic definition.

## Parity proof (web has no unit runner: `web/package.json` scripts =
dev/build/start/lint/test:e2e/sync:runtime — so per MUST DO, deviation from plan's
"两端各建 *.spec.ts": web side proved by runnable script instead)
- Temp script compiled both new modules with repo `tsc` (no new deps) and asserted
  `server.toSlug ≡ web.toDocSlug` and `server.docIdFor ≡ web.docIdFor(2-arg)` over
  25 titles × 5 ids. Output:
  `parity OK: 150 assertions, server toSlug≡web toDocSlug, server docIdFor≡web docIdFor(2-arg)`
  plus web 3-arg dedupe demo: `design-doc-00000002 / design-doc / doc-00000003`.
- Old-vs-new differential: baseline harness instantiated the **pre-change**
  `DocsMirrorService` (ts-node transpile-only) on 160 vectors (25 toSlug + 125
  docIdFor + 5 prototypeSlug + 5 prototypeFileName) → `old.json`; reran after the
  swap (now through delegate wrappers) → `new.json`; `diff old.json new.json` →
  **empty (byte-identical)**.

## Cleanup receipts
- Temp files lived ONLY outside the repo:
  `/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/slug-t3/`
  (`baseline.ts`, `parity.cjs`, `old.json`, `new.json`, `parity.log`, `out-*/`) —
  **entire directory deleted** after capturing the outputs above (`rm -rf`, verified
  `ls` empty). No temp files in repo; `git status` shows only the 5 listed files
  (+ this evidence file) as new/modified among T3 scope.

## Risks
- `docs-mirror.service.spec.ts` still calls `service.toSlug/service.docIdFor`
  (delegate wrappers) — intentional until T11 removes the mirror layer.
- Web `toDocSlug` vs server `toSlug` naming differs (kept verbatim per "move,
  don't rewrite"); parity enforced by the 150-assertion proof + jest spec.
- Gotcha fixed during work: initial spec vector
  `prototypeSlug('t','art_1','/uploads/.tsx')` wrongly expected `proto-art1`;
  actual (old + new) behavior is `'t'` (empty filename → strong title slug wins).
  Spec now locks `'t'`.
