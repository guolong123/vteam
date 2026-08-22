# Task 12 Evidence — Cleanup

## Verification
- `grep -r prototype-safelist web/src` => 0 hits (deleted with legacy docs)
- `grep -r "collectCss" web/src/features/docs-site` => hit in prototype-sandbox.tsx with try/catch de-dupe, correct
- `ls web/src/features/docs-site` => no safelist file, mermaid-block present
- `grep -r "components/docs" web/src` => 0 hits (after T1)
- check scripts: `check-md-docs.mjs` etc remain but no longer reference `components/docs` (verified via grep, no hits in web/src)

## Action
- Deleted legacy safelist via T1 rm -rf
- MermaidBlock retains `MERMAID_THEME_VARIABLES` base theme, strict
- collectCss has try/catch for cssRules cross-origin
