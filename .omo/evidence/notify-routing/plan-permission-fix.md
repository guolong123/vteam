# Evidence — vteam-plan prompt-vs-permission fix (plan allowlist + artifact filter + route-via-main note)

## 1. Allowlist additions (both mirror files, byte-identical plan block)
`server/src/common/constants/agent.constants.ts` (`vteam-plan` toolAllows) and
`server/prisma/seed.ts` (`vteam-plan` toolAllows) each gained exactly:
- `vteam_notify_agent: 'allow'`
- `vteam_memory_search: 'allow'`

Parity proof: `sed -n '487,513p' src/common/constants/agent.constants.ts` vs
`sed -n '325,351p' prisma/seed.ts` → `diff` empty → `PLAN_BLOCKS_IDENTICAL`.
(`vteam_submit_artifact` NOT granted; `vteam-librarian` untouched.)

## 2. Artifact-filter mechanism + byte-compat for non-plan
`server/src/chat/worker-dispatcher.ts` (`buildSystemInstructions`, was unconditional
`blocks.push(ARTIFACT_SUBMISSION_INSTRUCTION)`):
```ts
if (!isPlanRole(effectiveRole)) {
  blocks.push(ARTIFACT_SUBMISSION_INSTRUCTION);
}
```
Same mechanism as the MEMORY_INSTRUCTION plan-filter (`isPlanRole`, `:326`;
plan-filter `:469-474`); `effectiveRole` already computed. Non-plan path executes
the identical push statement → bytes unchanged (locked by `复读消除` + team-mode
byte-identity specs, all green).

## 3. NON_MAIN_AGENT_NOTE (new text, verbatim)
`【协作说明】状态流转/托管确认由主Agent操作，有事@主Agent（相关工具 vteam_task_transition / vteam_question_confirm 仅主实例可调，误调返回 403）。定向通知仅可直达主Agent，需触达其他成员时请主Agent中转，成员间直连调用将被拒绝。`
MAIN_AGENT_INSTRUCTION unchanged (already: main may notify any member via
`vteam_notify_agent` / `@`).

## 4. Specs updated (none weakened)
- `agent.constants.spec.ts`: plan exact toolAllows now includes the 2 new keys.
- `agent-policies.matrix.spec.ts`: +1 test locking plan has notify+memory_search,
  lacks submit_artifact; librarian still lacks notify_agent (anti-loop) + has
  memory_search.
- `worker-dispatcher.spec.ts`: plan-memory test + plan-dispatch test now assert
  artifact block ABSENT for plan; `产出物提交引导` test plan-aware (non-plan
  assertions kept, plan absence added via role + agentRole paths); NON_MAIN test
  asserts new route-via-main sentences.
- `agent-policies.custom-agents.spec.ts.snap`: `jest -u`; diff = only plan's
  `vteam_memory_search`/`vteam_notify_agent` deny→allow (denies removed, allows added).

## 5. Live proof (files in this dir)
- `agent-policies.json`: `GET /agent-policies` (admin JWT) after
  `docker compose up -d --build server` (+ init auto re-seed):
  plan tools include both new allows; layer-① permission carries no new deny;
  librarian unchanged.
- `prompt-proof.txt`: baked `dist/src/chat/worker-dispatcher.js`
  `buildSystemInstructions` outputs — plan: no artifact block / no `【公开与归档】` /
  no `vteam_submit_artifact` anywhere, no memory block, still taught
  `vteam_notify_agent`; non-plan: artifact + memory + route-via-main present.
- `roles.json`: worker `/data/vteam-worker/.vteam-role-guard/roles.json` AFTER
  `docker compose restart worker` (was stale 00:15, refreshed via startup
  `injectAll()` live pull) — plan tools include both new allows.
- Re-seed idempotency: `node dist/prisma/seed.js` re-run → `/agent-policies`
  bytes identical before/after.

## 6. jest + tsc
- `npx tsc --noEmit` exit 0 (before + after).
- Baseline (pre-edit): 123 suites / 2842 tests green.
- Final: 121/123 suites, 2831 passed / 17 failed / 2848 total — the 17 failures
  are all in the sibling's 2 in-flight suites (`receipt-nudge`, `plan-hash`:
  `this.prisma.team.findUnique` mock gap in their spec/service pair;
  files disjoint from this change — never touched).

## 7. Cleanup receipt
No DB probe rows created (all proofs read-only: GET + dist node -e + file reads).
No worktree artifacts besides intended source/spec/snap edits. No commit/stash.
