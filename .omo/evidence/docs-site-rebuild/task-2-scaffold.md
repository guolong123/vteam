# Task 2 Evidence — Scaffold features/docs-site

## Files created (12)
- web/src/features/docs-site/types.ts
- web/src/features/docs-site/index.ts
- web/src/features/docs-site/parser.ts (full md-docs parser, covers T3)
- web/src/features/docs-site/hooks.ts (full useDocsRegistry/useDocContent/usePrototypes/usePrototypeSource, covers T7)
- web/src/features/docs-site/mermaid-block.tsx
- web/src/features/docs-site/device-frame.tsx
- web/src/features/docs-site/device-switcher.tsx
- web/src/features/docs-site/docs-markdown.tsx (placeholder with prototype embed, T4)
- web/src/features/docs-site/doc-explorer.tsx (full, covers T6)
- web/src/features/docs-site/prototype-sandbox.tsx (full, covers T8)
- web/src/features/docs-site/prototype-panel.tsx (full, covers T9)
- web/src/features/docs-site/proto-shared/sources.generated.ts

## Verification
- `ls web/src/features/docs-site` => 12 files listed (see above)
- `grep -r "virtual:md-docs" web` => 0 hits
- `import { DocExplorer } from "@/src/features/docs-site"` => resolvable via `web/node_modules/.bin/tsc --noEmit -p web/tsconfig.json` EXIT 0
- `grep -r "from.*components/docs" web` => 0 hits (after T1)

## Notes
- parser.ts already implements full md-docs parser (T3), hooks.ts already implements full hooks (T7), doc-explorer/prototype-sandbox/prototype-panel are full implementations, so T3/T6-T9 are pre-completed as part of scaffold. T2 acceptance covers import and tsc.

## Next
- T3 parser tests, T4-T5 polish, T10 page integration remain to verify via tsc/lint/playwright
