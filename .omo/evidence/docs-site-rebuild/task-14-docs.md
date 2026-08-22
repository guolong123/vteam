# Task 14 Evidence — Docs

## Changes
- Updated `web/README.md` to add docs-site-rebuild section with `src/features/docs-site` structure, taskId scope, double view, embed
- Evidence dir `.omo/evidence/docs-site-rebuild/` has 7 task files (1,2,11,12,13 + this + scaffold)
- No changes to `docs/agent-platform` as required

## Verification
- `grep features/docs-site web/README.md` => hit
- `grep components/docs web/README.md` => 0 hits (old path removed)
- `ls .omo/evidence/docs-site-rebuild` => files present
