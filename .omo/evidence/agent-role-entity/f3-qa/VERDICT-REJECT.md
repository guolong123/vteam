# F3 Real Manual QA — VERDICT: REJECT

HEAD f6b5b9b. Live stack originally served image built 15:13+0800, predating
b6caed0 (assembly join, 16:15) and ba5b3c4 (split seed, 15:59). Server was
rebuilt from HEAD (`docker compose build server && up -d server`, allowed) and
re-probed — the defect below persists, so it is NOT a stale-image artifact.

## Blocking defect — instruction split is NOT real at runtime on the populated DB

All 7 builtins' live `agents.prompt` still hold the PRE-SPLIT text (role identity
`# 角色：` + `## 职责` + `## 协同方式` + `团队协作规约` + `回执铁律`). Root cause:
- todo 1 INSERTed `agent_roles` rows; todo 4 populated `role_prompt` via idempotent migration 20260919000008
- **no migration rewrites the existing `agents.prompt` rows**, and `seed.ts` agent upsert is `update: {}` (create-if-absent)
- dispatch reads `agentRow.prompt` from the DB (worker-dispatcher.ts:2011/2021) and now JOINs `AgentRole.rolePrompt` on top

Result (deployed buildSystemInstructions + real live DB values), 7/7 builtins:
```
a_architect          roleHeading=1 agentHeading=1 | identity=2 charter=1 receipt=1 <-- DUPLICATED
a_developer          roleHeading=1 agentHeading=1 | identity=2 charter=2 receipt=1 <-- DUPLICATED
a_librarian          ... identity=2 ... DUPLICATED
a_plan               ... identity=2 ... DUPLICATED
a_product            ... identity=2 ... DUPLICATED
a_project_manager    ... identity=2 ... DUPLICATED
a_tester             ... identity=2 ... DUPLICATED
BUILTINS WITH DUPLICATED BLOCKS: 7/7
```
Sentence de-dup on populated DB: 78 shared sentences across the 7 builtins
(a_architect 11, a_developer 8, a_librarian 12, a_plan 11, a_product 10,
a_project_manager 14, a_tester 12).

This violates the plan's own Success Criteria: "assembled system instructions
contain role + agent + platform parts once each, in order" and "no sentence
appears in BOTH a role prompt and its agent prompt".

Why the gates missed it: `node scripts/verify-instruction-parity.mjs` reads the
**source** `seed.ts` (post-split, clean) + constants file — it never reads the
live/populated `agents.prompt` rows the dispatcher actually consumes. All gates
(parity, e2e harnesses, frozen sha) pass while the runtime output is duplicated.

Fresh-install path is fine (seed create branch writes split prompt; direct probe
`fresh-split: role count=1 agent count=1`). Defect is upgrade/populated-DB only —
which is exactly the live stack.
