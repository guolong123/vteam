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
- Playwright temp config must also live inside `web/` (same module-resolution reason);
  the JSON report (`.nap.report.json`) must be trap-removed alongside the temp config.
- Bash health check needs `curl -w '%{http_code}'`; `-o /dev/null` alone prints nothing for grep.

## e2e regression (Todo 2, 2026-09-14, HEAD 37a1b0c)
- Method: `bash scripts/e2e-no-agent-picker.sh` — drives Playwright spec
  `web/e2e/no-agent-picker.spec.ts` (temp config, baseURL compose web :13001, channel=chrome).
- Web image rebuilt + force-recreated before the run (`docker compose build web &&
  docker compose up -d --force-recreate web`); build fully cached (removal already in image).
- Results (`.omo/evidence/no-agent-picker/e2e.txt`, all PASS):
  A1 selector gone (no `message-agent-select`, zero `<select>`); A2 `@` candidates
  incl 计划员-1, click inserts `@计划员-1 `; A3 mocked probe renders + input clears +
  0 console/page errors; A4 `37a1b0c^..37a1b0c -- server/ worker/` empty,
  `opencodeAgentName` in schema.prisma + policy-candidate-then-explicit
  (`policyCandidateAgent` → `opencodeAgentName`) intact in worker-dispatcher.ts:1735-1742;
  A5 team members contain `tmm_0000000006` 计划员-1 with `opencodeAgentName` key
  (`buildTeamMemberTrigger` resolves by (teamId, memberId), :1290) — no LLM executed;
  A6 real group channel `c_0000000001` has zero probe residue (POST was route-mocked).
- Raw removal stat: `.omo/evidence/no-agent-picker/removal-stat.txt`.
- `cd web && npx tsc --noEmit` → exit 0 (covers the new spec).
