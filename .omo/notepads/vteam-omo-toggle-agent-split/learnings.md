# vteam-omo-toggle-agent-split learnings

## Todo 2 — remove duplicated opencode native agent section from agents page (2026-09-14)
- Deleted from `web/app/(main)/agents/page.tsx` only (3 hunks, -225 lines total):
  - import line (old L39): `OpencodeAgentItem, isSelectableOpencodeAgent` from TeamMembersPanel — grep proved
    zero other references in the file, so the whole import line was removed (no other symbols on it to keep).
  - query block (old L2321-2337 + doc comment): `opencodeAgentsQuery` (`GET /agents/opencode`) and derived
    `opencodeAgents` filter line.
  - JSX block (old L2564-2769): entire `data-testid="opencode-agent-section"` div (header + degraded badge +
    hint + skeleton + empty state + agent map). Outer left-panel `</div>` kept.
- Grep proof of zero residue for `opencode-agent-section|opencodeAgentsQuery|opencodeAgents|OpencodeAgentItem|`
  `isSelectableOpencodeAgent|opencode-agent-item|/agents/opencode|opencode-agents` → no matches.
- Remaining `opencode` mentions in the file (permission-alignment comments, agentKey convention) are unrelated
  and untouched; no orphaned helpers left behind (`isPrimary`/`modeLabel` were inline in the deleted map).
- `TeamMembersPanel.tsx` NOT touched — shared `OpencodeAgentItem`/`isSelectableOpencodeAgent` exports still live
  there for the worker detail card (Todo 1).
- Verify: `cd web && npx tsc --noEmit` exit 0; `npx next lint --file 'app/(main)/agents/page.tsx'` clean except
  pre-existing `deleting` unused-var warning at 1059:187 (untouched code).
- Evidence: rebuilt web (`docker compose build web && docker compose up -d --force-recreate web`), Playwright
  (chrome channel) login admin/admin123 → `/agents`: `opencode-agent-section` count 0, heading absent, vteam
  list (5 template agents + detail panel) renders, 0 console errors.
  Screenshot: `.omo/evidence/omo-agent-split/agents-page.png`.
