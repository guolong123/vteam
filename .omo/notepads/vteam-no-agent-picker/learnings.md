# vteam-no-agent-picker learnings

## Baseline
- HEAD at start: `7d3bea2 docs(plan): mark plan-member F1-F4 complete`.

## Deletions
- `web/src/components/ui/message-input.tsx`: removed `InputAgentOption` interface (~L123-130), 4 props
  (`agentOptions`, `agentValue`, `onChangeAgent`, `agentSelectDisabled` ~L109-121 + destructuring), and the
  `{onChangeAgent && (...)}` select render block (~L457-501, `message-agent-select`). Mentions/attachments/send untouched.
- `web/app/(main)/teams/[id]/session/page.tsx`: removed `opencodeAgentsQuery` (GET /agents/opencode, ~L924-938),
  `instanceOpencodeAgentMutation` (PATCH member opencodeAgentName, ~L939-955), the 4 `<MessageInput>` props (~L1272-1282),
  and pruned `OpencodeAgentItem, isSelectableOpencodeAgent` from the L31 import (kept `TeamMembersPanel, roleOptionsOf, customAgentsOf, AgentItem`).
- Verified pre-delete: `InputAgentOption` referenced only inside message-input.tsx; `OpencodeAgentItem`/`isSelectableOpencodeAgent`
  used only at import + deleted blocks in session page.

## Residue proof
- Narrow grep (agentValue|onChangeAgent|agentSelectDisabled|InputAgentOption|opencodeAgentsQuery|instanceOpencodeAgentMutation|isSelectableOpencodeAgent|OpencodeAgentItem|message-agent-select) → zero matches in both files.
- Broad grep keeps exactly one `agentOptions` hit: session page L1073 `agentOptions={roleOptionsOf(...)}` — TeamMembersPanel's own
  role-options prop, explicitly in-scope to keep. See `.omo/evidence/no-agent-picker/grep.txt`.

## Verify
- `cd web && npx tsc --noEmit` → exit 0.
- `npx next lint` on both files → exit 0; only 2 `_drop` unused-var warnings at session page L775/L782, proven pre-existing
  via stash comparison (identical warnings on baseline HEAD).

## Playwright proof (2026-09-14, rebuilt web image redeployed, admin/admin123, seed team tm_0000000001)
- `message-agent-select` count 0; zero `<select>` on the whole session page.
- `@` mention flow works; candidates include 计划员-1.
- Probe message sent successfully and shows in chat; input cleared after send.
- 0 console/page errors. Screenshot: `.omo/evidence/no-agent-picker/removed.png`.

## Gotchas
- `git stash` path gotcha: from `web/` workdir use repo-relative-without-prefix paths (`src/...`, `app/...`), not `web/...`.
- Standalone node scripts under /tmp can't `require("playwright")`; copy the proof script into `web/` so node resolves
  `web/node_modules`, run, then delete. Screenshot path is cwd-relative — run from repo root or move the file after.
